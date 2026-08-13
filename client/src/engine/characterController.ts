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
  HEALTH,
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
  /** PR 10: current health points. Decremented by `applyDamage` from
   *  `game/health.ts`; reset to `HEALTH.maxHp` on respawn / `reset()`. */
  hp: number;
  /** PR 10: timestamp (ms) at which the respawn teleport should fire.
   *  Set to `nowMs + HEALTH.respawnDelayMs` when HP drops to 0; cleared
   *  when the teleport fires. 0 means "not currently respawning". */
  respawningUntilMs: number;
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
  /** PR 10: spawn point the controller teleports back to on respawn. */
  public readonly startPosition: Vector3;
  private readonly up: Vector3 = new Vector3(0, 1, 0);
  private readonly baseDynamicFriction: number = BASE_DYNAMIC_FRICTION;
  private yawRadians: number = 0;
  private stunt: "none" | "dive" | "slide" | "wallrun" = "none";
  private stuntEndsAtMs: number = 0;
  /** True for the single update tick after a new stunt becomes active. */
  private stuntJustEntered: boolean = false;
  // PR 8.1: previous-frame snapshot of `input.wallrunPressed`. Used to
  // detect the rising edge so wallrun doesn't re-enter every time the
  // 1000ms timer expires while Q is still being held or auto-repeating.
  private wasWallrunPressedLast: boolean = false;
  // PR 8.1: timestamp of the last wallrun exit. Combined with the
  // wallrun duration, defines the cooldown window during which a new
  // wallrun entry is ignored (closes the auto-repeat re-entry loophole).
  private lastWallrunEndedAtMs: number = 0;
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
      hp: HEALTH.maxHp,
      respawningUntilMs: 0,
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
    // PR 8.1: clear the wallrun rising-edge tracker + cooldown too.
    this.wasWallrunPressedLast = false;
    this.lastWallrunEndedAtMs = 0;
    // PR 10: reset health pool + any in-flight respawn timer.
    this.state.hp = HEALTH.maxHp;
    this.state.respawningUntilMs = 0;
  }

  /**
   * PR 10: teleport the controller back to its spawn point and restore
   * a clean state. Called from `tickRespawn` in `game/health.ts` once
   * the respawn timer expires. Encapsulates the reset path so callers
   * don't need to know the underlying `havok.setPosition` /
   * `havok.setVelocity` sequence.
   *
   * Resets position, velocity, health, respawn timer, stunts, and the
   * wallrun cooldown. Does NOT mutate the input-driven state machine
   * (the next `update()` call will re-derive stunt state from input).
   */
  public respawn(_nowMs: number): void {
    this.havok.setPosition(this.startPosition.clone());
    this.havok.setVelocity(Vector3.Zero());
    this.state.position.copyFrom(this.startPosition);
    this.state.hp = HEALTH.maxHp;
    this.state.respawningUntilMs = 0;
    this.stunt = "none";
    this.stuntEndsAtMs = 0;
    this.stuntJustEntered = false;
    this.state.stunt = "none";
    this.wasWallrunPressedLast = false;
    this.lastWallrunEndedAtMs = 0;
    this.yawRadians = 0;
    this.state.rotation.copyFromFloats(0, 0, 0, 1);
    this.havok.dynamicFriction = this.baseDynamicFriction;
    this.havok.staticFriction = 0;
    this.lastPlanarSpeed = 0;
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

    // PR 8: Havok's PhysicsCharacterController is kinematic (ANIMATED body)
    // and only applies the `gravity` parameter inside `_resolveContacts`,
    // which only fires when there's a contact in the manifold. Mid-air the
    // velocity we hand to `setVelocity` is preserved verbatim — there is no
    // gravity accumulation. The previous code relied on Havok applying
    // gravity for us; it didn't, so holding Space made the character fly up
    // forever (jump impulse 5.2 m/s applied on the rising edge → vy stays
    // 5.2 forever → capsule ascends at 5.2 m/s indefinitely).
    //
    // Fix: accumulate gravity ourselves whenever the controller is not
    // SUPPORTED. This matches the standard kinematic character-controller
    // pattern (gravity = a * dt, applied to vy before setVelocity).
    if (!this.state.supported) {
      vy += MOVEMENT.gravity.y * deltaSeconds;
    }

    // PR 8: tighten the jump condition. Previously we accepted ANY rising
    // edge while `state.supported` was true. That had two failure modes:
    //   (a) `state.supported` was true for one frame while the capsule was
    //       still moving up from the previous jump's residual velocity,
    //       letting a second Space press add another impulse on top.
    //   (b) the contact manifold flipped supported=true in between frames
    //       during the descent, firing a "second" jump impulse.
    // We now require vy ≤ 0 (no upward residual) so the jump can only fire
    // from a true grounded state.
    if (input.jumpPressed && this.state.supported && vy <= 0) {
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
    // PR 8: pass Zero for gravity — we now accumulate it ourselves above.
    // Passing a non-zero gravity here would double-apply it on frames where
    // the contact manifold has a ground entry (Havok resolves it via
    // `_resolveContacts` which adds gravity into the contact impulse).
    this.havok.integrate(deltaSeconds, surfaceInfo, Vector3.ZeroReadOnly);

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
    // PR 8.1: gate wallrun entry on a cooldown after the previous
    // wallrun exited. Without this, an input source that fires
    // `wallrunPressed=true` more frequently than the 1000ms wallrun
    // duration (real-browser auto-repeat, synthetic keydown loops, or
    // a stuck input bit) re-enters wallrun the moment the timer
    // expires — creating an indefinite upward cycle.
    //
    // Cooldown = STUNTS.wallrun.durationMs + 200ms grace. During the
    // cooldown, rising-edge signals are ignored. Wallrun can only
    // re-enter after the cooldown AND wallrunPressed has been false
    // for at least one frame (rising edge of next press).
    const wallrunOnCooldown = this.stunt === "none" &&
      this.lastWallrunEndedAtMs > 0 &&
      nowMs < this.lastWallrunEndedAtMs + STUNTS.wallrun.durationMs + 200;

    // Wallrun: rising edge of Q while mid-air to attach for 1s. Takes
    // priority over dive. Gated by cooldown to prevent auto-repeat
    // re-entry (Kyle dev-box playtest, Discord 1537454310470717492).
    const wallrunRisingEdge = input.wallrunPressed && !this.wasWallrunPressedLast;
    this.wasWallrunPressedLast = input.wallrunPressed;

    if (wallrunRisingEdge && !this.state.supported && !wallrunOnCooldown) {
      this.enterStunt("wallrun", nowMs + STUNTS.wallrun.durationMs);
      this.lastWallrunEndedAtMs = 0; // clear on entry
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
      // PR 8.1: record the exit time so the wallrun cooldown can gate
      // the next entry. Without this the auto-repeat loophole lets a
      // continuous wallrunPressed re-enter wallrun the moment the timer
      // expires.
      const exitingStunt = this.stunt;
      this.exitStunt();
      if (exitingStunt === "wallrun") this.lastWallrunEndedAtMs = nowMs;
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
