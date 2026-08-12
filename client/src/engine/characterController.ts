// Phase 0 / PR 3 — Havok-backed character controller.
//
// The Havok `PhysicsCharacterController` is the source of truth for player
// movement. This module wraps it: it reads `InputState`, calls `setVelocity`
// + `integrate`, and exposes the canonical world-space `position` / `rotation`
// for the visual model + the chase camera to follow each frame.
//
// Per-frame pattern (Babylon docs):
//
//   const ctrl = new PhysicsCharacterController(
//     new Vector3(0, 0.9, 0),                          // start position
//     { capsuleHeight: 1.8, capsuleRadius: 0.5 },     // shape options
//     scene,                                            // physics-enabled scene
//   );
//   ctrl.setVelocity(planarVelocity);
//   const info = ctrl.checkSupport(dt, gravityDir);
//   ctrl.integrate(dt, info, gravity);
//
// We avoid `moveWithCollisions` because it bakes the displacement from
// `scene.deltaTime`, which makes stunt velocity overrides (dive boost,
// wallrun ramp) harder to express on top of the engine's chosen step.

import {
  CharacterSupportedState,
  PhysicsCharacterController,
  Quaternion,
  TransformNode,
  Vector3,
  type Scene,
} from "@babylonjs/core";

import {
  CAPSULE,
  MOVEMENT,
  SLOPE_AND_STEP,
  STUNTS,
} from "./characterConfig";

/** Keyboard / stunt input state. The same shape the chase camera reads. */
export interface InputState {
  forward: number;   // -1 (S) .. +1 (W)
  right: number;     // -1 (A) .. +1 (D)
  jumpPressed: boolean;
  divePressed: boolean;
  slideHeld: boolean;
  wallrunPressed: boolean;
  cameraTogglePressed: boolean;
  fireHeld: boolean; meleePressed: boolean; bulletTimeHeld: boolean;
}

/** Snapshot the controller publishes each frame for the visual + camera. */
export interface CharacterState {
  position: Vector3;
  rotation: Quaternion; // yaw only; pitch is camera-side
  supported: boolean;
  sliding: boolean;
  stunt: "none" | "dive" | "slide" | "wallrun";
}

/** Options accepted by `createCharacterController`. */
export interface CharacterControllerOptions {
  startPosition?: Vector3;
  /** Visual root the controller drives — receives the same transform each frame. */
  visualRoot?: TransformNode;
}

/** Default gravity direction used by `checkSupport` (must match world gravity). */
const GRAVITY_DIRECTION = new Vector3(0, -1, 0);

/** Default friction values when no stunt is active. */
const BASE_STATIC_FRICTION = 0.0;
const BASE_DYNAMIC_FRICTION = 1.0;

/**
 * Build a Havok character controller and return a wrapper that can be ticked
 * from a render-loop observer. The wrapper owns the stunt state-machine and
 * caches the last-known position/rotation for the visual + chase camera.
 */
export function createCharacterController(
  scene: Scene,
  options: CharacterControllerOptions = {},
): CharacterController {
  const startPosition = options.startPosition ?? new Vector3(0, CAPSULE.height / 2, 0);

  const havok = new PhysicsCharacterController(
    startPosition.clone(),
    {
      capsuleHeight: CAPSULE.height,
      capsuleRadius: CAPSULE.radius,
    },
    scene,
  );

  // Slope + step: the controller exposes `maxSlopeCosine` (cos of the climb
  // angle) and `maxStepHeight` (m). Set both so 45° slopes and 0.3m ledges
  // are climbable, per spec.
  havok.maxSlopeCosine = Math.cos(SLOPE_AND_STEP.slopeLimit);
  havok.maxStepHeight = SLOPE_AND_STEP.maxStepHeight;

  // Reasonable feel defaults for an FPS-style character.
  havok.acceleration = MOVEMENT.walkAcceleration;
  havok.maxAcceleration = MOVEMENT.walkAcceleration * 4.0;
  havok.maxCharacterSpeedForSolver = 30.0;
  havok.staticFriction = BASE_STATIC_FRICTION;
  havok.dynamicFriction = BASE_DYNAMIC_FRICTION;
  havok.up = new Vector3(0, 1, 0);

  return new CharacterController(havok, options.visualRoot, startPosition);
}

/** Public wrapper — owns the Havok controller + stunt state machine. */
export class CharacterController {
  readonly havok: PhysicsCharacterController;
  readonly state: CharacterState;
  private readonly visualRoot: TransformNode | undefined;
  private readonly startPosition: Vector3;
  private readonly up: Vector3 = new Vector3(0, 1, 0);
  private readonly baseDynamicFriction: number = BASE_DYNAMIC_FRICTION;
  private yawRadians: number = 0;
  private stunt: "none" | "dive" | "slide" | "wallrun" = "none";
  private stuntEndsAtMs: number = 0;
  /** True for the single update tick after a new stunt becomes active. */
  private stuntJustEntered: boolean = false;
  private lastPlanarSpeed: number = 0;
  // Scratch vectors to avoid per-frame allocations in the hot path.
  private readonly tmpDesired: Vector3 = new Vector3();
  private readonly tmpPlanar: Vector3 = new Vector3();

  constructor(
    havok: PhysicsCharacterController,
    visualRoot: TransformNode | undefined,
    startPosition: Vector3,
  ) {
    this.havok = havok;
    this.visualRoot = visualRoot;
    this.startPosition = startPosition.clone();
    this.state = {
      position: startPosition.clone(),
      rotation: Quaternion.Identity(),
      supported: true,
      sliding: false,
      stunt: "none",
    };
  }

  /** Reset the controller back to the spawn point. Used by tests / debug. */
  public reset(): void {
    this.havok.setPosition(this.startPosition.clone());
    this.havok.setVelocity(new Vector3(0, 0, 0));
    this.yawRadians = 0;
    this.stunt = "none";
    this.stuntEndsAtMs = 0;
    this.stuntJustEntered = false;
    this.lastPlanarSpeed = 0;
    this.state.position.copyFrom(this.startPosition);
    this.state.rotation.copyFromFloats(0, 0, 0, 1);
    this.state.supported = true;
    this.state.sliding = false;
    this.state.stunt = "none";
    this.havok.dynamicFriction = this.baseDynamicFriction;
    this.havok.staticFriction = 0;
  }

  /** Set the yaw the character should face (radians, 0 = +Z forward). */
  public setYaw(radians: number): void {
    this.yawRadians = radians;
    Quaternion.RotationAxisToRef(this.up, radians, this.state.rotation);
  }

  /** Drive one frame of controller state. */
  public update(input: InputState, deltaSeconds: number, nowMs: number): void {
    // 1. Stunt state machine: enter on input, exit on timer / release.
    this.refreshStuntState(input, nowMs);

    // 2. Compute the desired planar velocity in world space from the
    //    character-relative input rotated by the current yaw.
    const sinYaw = Math.sin(this.yawRadians);
    const cosYaw = Math.cos(this.yawRadians);
    // Local (character-relative) input projected into world space:
    //   worldForward = ( sinYaw, 0,  cosYaw )
    //   worldRight   = ( cosYaw, 0, -sinYaw )
    let wx = cosYaw * input.right + sinYaw * input.forward;
    let wz = -sinYaw * input.right + cosYaw * input.forward;
    const planarLen = Math.hypot(wx, wz);
    if (planarLen > 1) {
      wx /= planarLen;
      wz /= planarLen;
    }
    const baseSpeed =
      MOVEMENT.walkSpeed * (this.stunt === "slide" ? STUNTS.slide.speedMultiplier : 1);
    wx *= baseSpeed;
    wz *= baseSpeed;

    // 3. Build the full velocity vector. Start from current vertical so
    //    gravity keeps applying, then layer jump / stunts.
    const currentVel = this.havok.getVelocity();
    let vy = currentVel.y;

    if (input.jumpPressed && this.state.supported) {
      vy = MOVEMENT.jumpZ;
    }

    if (this.stunt === "wallrun") {
      // Hold an upward + along-wall velocity for the duration.
      vy = STUNTS.wallrun.upwardVelocity;
      wx = sinYaw * STUNTS.wallrun.forwardVelocity;
      wz = cosYaw * STUNTS.wallrun.forwardVelocity;
    }

    if (this.stunt === "dive" && this.stuntJustEntered) {
      // Forward boost on the entry frame only.
      wx += sinYaw * STUNTS.dive.forwardBoost;
      wz += cosYaw * STUNTS.dive.forwardBoost;
    }

    this.tmpDesired.set(wx, vy, wz);

    // 4. Apply stunt-specific friction.
    this.applyStuntFriction();

    // 5. Step Havok.
    this.havok.setVelocity(this.tmpDesired);
    const surfaceInfo = this.havok.checkSupport(deltaSeconds, GRAVITY_DIRECTION);
    this.state.supported = surfaceInfo.supportedState === CharacterSupportedState.SUPPORTED;
    this.state.sliding = surfaceInfo.supportedState === CharacterSupportedState.SLIDING;
    this.havok.integrate(deltaSeconds, surfaceInfo, MOVEMENT.gravity);

    // 6. Publish world-space transform.
    const pos = this.havok.getPosition();
    this.state.position.copyFrom(pos);
    if (this.visualRoot) {
      this.visualRoot.position.copyFrom(pos);
      // Use rotationQuaternion exclusively so we don't fight with `rotation` Vector3.
      this.visualRoot.rotationQuaternion = this.state.rotation;
    }

    // 7. Cache planar speed for camera FX (Phase 1 FOV bumps etc.).
    this.tmpPlanar.set(currentVel.x, 0, currentVel.z);
    this.lastPlanarSpeed = this.tmpPlanar.length();
    this.stuntJustEntered = false;
  }

  /** Recompute which stunt is active based on input + timers. */
  private refreshStuntState(input: InputState, nowMs: number): void {
    // Wallrun: tap Q mid-air to attach for 1s. Takes priority over dive.
    if (input.wallrunPressed && !this.state.supported) {
      this.enterStunt("wallrun", nowMs + STUNTS.wallrun.durationMs);
      return;
    }
    // Dive: tap Shift while moving forward.
    if (
      input.divePressed &&
      Math.abs(input.forward) > 0.1 &&
      this.state.supported &&
      this.stunt !== "dive"
    ) {
      this.enterStunt("dive", nowMs + STUNTS.dive.durationMs);
      return;
    }
    // Slide: hold C with horizontal motion.
    if (input.slideHeld && Math.hypot(input.right, input.forward) > 0.1) {
      if (this.stunt !== "slide") this.enterStunt("slide", Number.POSITIVE_INFINITY);
      return;
    }
    // Time-based exits for non-held stunts.
    if (this.stunt !== "none" && this.stunt !== "slide" && nowMs >= this.stuntEndsAtMs) {
      this.exitStunt();
    }
    // Released slide exits immediately.
    if (this.stunt === "slide" && !input.slideHeld) {
      this.exitStunt();
    }
  }

  private enterStunt(kind: "dive" | "slide" | "wallrun", endsAtMs: number): void {
    if (this.stunt === kind) return;
    this.exitStunt();
    this.stunt = kind;
    this.stuntEndsAtMs = endsAtMs;
    this.stuntJustEntered = true;
    this.state.stunt = kind;
  }

  private exitStunt(): void {
    this.stunt = "none";
    this.stuntEndsAtMs = 0;
    this.state.stunt = "none";
    this.havok.dynamicFriction = this.baseDynamicFriction;
    this.havok.staticFriction = 0;
  }

  private applyStuntFriction(): void {
    if (this.stunt === "dive") {
      this.havok.dynamicFriction = this.baseDynamicFriction * STUNTS.dive.frictionMultiplier;
    } else if (this.stunt === "slide") {
      this.havok.dynamicFriction = this.baseDynamicFriction * STUNTS.slide.frictionMultiplier;
    } else {
      this.havok.dynamicFriction = this.baseDynamicFriction;
    }
  }

  /** Last computed planar speed (m/s) — informational. */
  public getPlanarSpeed(): number {
    return this.lastPlanarSpeed;
  }
}
