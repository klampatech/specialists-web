// Phase 0 / PR 3+11.1 — chase camera with V-toggle + pointer-locked first-person.
//
// PR 3: a `UniversalCamera` follows the character with a fixed offset; V
// toggles between over-shoulder (third-person) and eye-level (first-person).
//
// PR 11.1: adds a pointer-locked first-person mouse-look path. When the
// browser has pointer-lock engaged on the canvas, the camera renders the
// character's eye view (1:1 with character position + character yaw) and
// `e.movementX` from the locked mousemove streams into the local yaw
// accumulator. When pointer-lock is released (ESC, or browser refuses
// the lock), the camera falls back to the existing chase-lerp behavior
// (third-person or first-person-chase depending on V-toggle state).
//
// Third-person offset:  (0, +1.5, -2.8)  — behind, above
// First-person offset:  (0, +1.6,  0.0)  — at the character's eye
// Look-at:              (0, +0.9,  0.0)  — chest height
//
// V toggles which offset is active. The toggle is edge-triggered — the
// caller forwards the `cameraTogglePressed` boolean from `InputState`.
// Pointer-lock engagement overrides V (the camera always renders 1:1
// when locked, regardless of the V state).

import {
  UniversalCamera,
  Vector3,
  type Scene,
} from "@babylonjs/core";

import { CAMERA } from "./characterConfig";
import type { CharacterController } from "./characterController";

/** Result of `createChaseCamera`. */
export interface ChaseCameraHandle {
  camera: UniversalCamera;
  /** Drives the camera each frame. Call from the render loop. */
  update: () => void;
  /** True when the camera is in first-person mode (chase fallback). */
  isFirstPerson: () => boolean;
  /** Toggle programmatically. PR 11.1.2: V cycles 0↔1, only while locked. */
  toggle: () => void;
  /**
   * PR 11.1.2: current locked view mode (0=1st, 1=over-shoulder).
   * Exposed so the smoke can assert V cycles correctly.
   */
  getViewMode: () => number;
  /**
   * PR 11.1.2: jump directly to a specific viewMode (mod 2 wrap).
   */
  setViewMode: (mode: number) => void;
  /**
   * PR 11.1.2: true when the camera is in menu orbit mode
   * (locked=false, everLocked=true). Exposed so the smoke + UI can
   * know the camera state.
   */
  isMenuOrbit: () => boolean;
  /**
   * PR 11.1.2: current menu orbit angle (radians). Exposed so the
   * smoke can assert the orbit advances over time.
   */
  getMenuAngle: () => number;
  /** Reset back to third-person. */
  reset: () => void;
  /**
   * PR 11.1: pointer-lock state changed. When `locked === true`, the
   * camera renders 1:1 with the character (first-person, no lerp) and
   * mousemove-deltas rotate the local yaw. When `locked === false`,
   * the camera falls back to the existing chase behavior (with V-toggle
   * deciding first-person-chase vs third-person-chase).
   */
  setPointerLock: (locked: boolean) => void;
  /**
   * PR 11.1: apply a yaw delta from a locked mousemove. Called from the
   * input listener's `onYawDelta` hook. Wraps the result mod 2π so the
   * accumulator doesn't drift at large values.
   */
  applyYawDelta: (deltaRadians: number) => void;
  /**
   * PR 11.1: current yaw (radians, 0..2π). The scene reads this each
   * frame to populate the input packet's bytes 2-3, so both clients
   * see the same yaw → same WASD world direction → lockstep determinism.
   */
  getYaw: () => number;
  /**
   * PR 11.1: current pointer-lock state (true when the browser has
   * the canvas locked). Exposed for the camera-render smoke so it
   * can assert the render path is honoring the lock state.
   */
  isPointerLocked: () => boolean;
  dispose: () => void;
}

const TWO_PI = 2 * Math.PI;

/**
 * Build a chase camera that follows the given character controller. The
 * camera is registered as `scene.activeCamera` so the render loop picks it
 * up automatically.
 */
export function createChaseCamera(
  scene: Scene,
  character: CharacterController,
  canvas?: HTMLCanvasElement,
): ChaseCameraHandle {
  const camera = new UniversalCamera(
    "chase",
    new Vector3(0, 1.5, -2.8),
    scene,
  );
  camera.fov = (CAMERA.fovDegrees * Math.PI) / 180;
  camera.minZ = 0.1;
  camera.maxZ = 200;
  camera.inertia = 0.4;
  // Detach mouse + keyboard inputs — the chase camera drives the transform
  // directly. WASD is consumed by the character controller, not the camera.
  camera.inputs.clear();
  if (canvas) {
    camera.attachControl(canvas, true);
    camera.inputs.clear();
  }
  scene.activeCamera = camera;

  // PR 11.1.2 viewMode state machine (simplified per Kyle's spec).
  //   0 = first-person-locked: camera at firstPersonOffset, rotated by yaw
  //   1 = over-shoulder-locked: camera at overShoulderOffset, rotated by yaw
  // The user-visible mode set is {0, 1} only. There is NO chase-lerp
  // "playing mode" — the chase lerp exists only as a dev-box fallback
  // when pointer-lock has never been acquired (initial load, fresh page).
  //
  // V cycles 0 <-> 1 while pointer-locked. V does nothing while unlocked
  // (the user is interacting with a menu, not playing).
  //
  // ESC (pointerLock=false) switches to the menu orbit camera (a slow
  // auto-rotation around the character) — NOT a chase lerp, NOT a
  // user-controlled view. When the user clicks the canvas again to
  // re-engage, pointerLock=true resets the menu camera and re-enters
  // mode 0 (1st-person).
  let viewMode = 0;
  // PR 11.1 state: pointer-lock engaged → render 1:1 with character at
  // the current viewMode's offset, ignore the lerp chase.
  let pointerLocked = false;
  // PR 11.1 state: local yaw accumulator. Mirrors character.yawRadians
  // (set via the controller's `setYaw` in scene.ts) so the camera can
  // render with the same orientation as the character on each frame.
  let yawRadians = 0;
  // PR 11.1.2: menu orbit state. When pointerLocked is false AND the
  // user has previously locked at least once, the camera enters the
  // orbit mode — a slow auto-rotation around the character. `menuAngle`
  // accumulates per-frame, `menuAngularSpeed` is rad/sec.
  let menuAngle = 0;
  let everLocked = false; // distinguishes "fresh page" from "user ESC'd"

  const tmpOffset = new Vector3();
  const tmpDesired = new Vector3();
  const tmpCurrent = camera.position.clone();
  const tmpCurrentLook = new Vector3(0, 0.9, 0);

  /**
   * Offset for a given locked viewMode.
   *   0 → firstPersonOffset (eye height, no back-off)
   *   1 → overShoulderOffset (close-behind + slightly above)
   */
  const offsetForMode = (mode: number): Vector3 => {
    if (mode === 0) return CAMERA.firstPersonOffset;
    return CAMERA.overShoulderOffset;
  };

  const update = (): void => {
    const cp = character.state.position;
    if (pointerLocked && viewMode === 0) {
      // PR 11.1.2: 1st-person-locked. Snap camera to character + eye
      // offset; render at the character's exact yaw. No lerp — the
      // locked view IS the character's view.
      const offset = offsetForMode(0);
      camera.position.set(cp.x + offset.x, cp.y + offset.y, cp.z + offset.z);
      const q = character.state.rotation;
      const sinY = 2 * (q.w * q.y + q.z * q.x);
      const cosY = 1 - 2 * (q.y * q.y + q.x * q.x);
      const eulerY = Math.atan2(sinY, cosY);
      camera.rotation.set(0, eulerY, 0);
      return;
    }
    if (pointerLocked && viewMode === 1) {
      // PR 11.1.3: over-shoulder-locked. Camera position is the
      // over-shoulder offset rotated by the CHARACTER's yaw so the
      // camera stays behind the character relative to facing direction.
      // Camera ROTATION is NOT set to character yaw — instead the
      // camera looks at the character's chest height (a fixed world
      // point). This way, when the mouse rotates the character, the
      // model visually rotates IN PLACE in front of the camera (you
      // see the character's back turn left/right as you mouse around).
      // Matches Kyle's spec: "moves the model just like first person,
      // just the view is over the shoulder."
      const q = character.state.rotation;
      const sinY = 2 * (q.w * q.y + q.z * q.x);
      const cosY = 1 - 2 * (q.y * q.y + q.x * q.x);
      const charYaw = Math.atan2(sinY, cosY);
      // Rotate the over-shoulder offset (character-local space) into
      // world space. With offset = (0, 1.7, -1.6) at yaw=0, the camera
      // sits at character + (-(-1.6)*sin(yaw), 1.7, (-1.6)*cos(yaw))
      // = character + (1.6*sin(yaw), 1.7, -1.6*cos(yaw)) — wait let me
      // re-derive. A point (0, 0, -1.6) rotated by yaw around the Y
      // axis is (-(-1.6)*sin(yaw), 0, (-1.6)*cos(yaw)) — actually
      // the Y-rotation matrix is:
      //   [ cos  0  sin ]
      //   [  0   1   0  ]
      //   [-sin  0  cos ]
      // so (0, y, -1.6) -> (sin(yaw)*-1.6, y, cos(yaw)*-1.6)
      //                  = (-1.6*sin(yaw), y, -1.6*cos(yaw))
      const off = CAMERA.overShoulderOffset; // character-local
      const worldOffX = -off.z * Math.sin(charYaw);
      const worldOffZ = -off.z * Math.cos(charYaw);
      camera.position.set(cp.x + worldOffX, cp.y + off.y, cp.z + worldOffZ);
      // Camera looks at the character's chest height (world-space target,
      // independent of yaw). This is the key difference from 1st-person:
      // the camera's forward vector is NOT the character's yaw, so the
      // model rotates in the camera's view.
      camera.setTarget(new Vector3(
        cp.x + CAMERA.lookAtOffset.x,
        cp.y + CAMERA.lookAtOffset.y,
        cp.z + CAMERA.lookAtOffset.z,
      ));
      return;
    }

    // PR 11.1.2: unlocked path.
    //   - Fresh page (never locked): use the existing PR 3 chase lerp
    //     at thirdPersonOffset. This is the dev-box viewing mode — the
    //     user hasn't engaged with the game yet, so the chase is the
    //     sensible default.
    //   - User previously locked and ESC'd: use the menu orbit camera.
    //     Slow auto-rotation around the character. No mouse control
    //     (the cursor is over a menu, not the canvas).
    if (everLocked) {
      // Menu orbit. Auto-rotate around the character at
      // CAMERA.menuOrbit.{radius, height, angularSpeed}.
      menuAngle += CAMERA.menuOrbit.angularSpeed * (1 / 60);
      // Keep menuAngle in [0, 2π) so it doesn't drift at large values.
      if (menuAngle >= 2 * Math.PI) menuAngle -= 2 * Math.PI;
      const radius = CAMERA.menuOrbit.radius;
      const height = CAMERA.menuOrbit.height;
      camera.position.set(
        cp.x + Math.sin(menuAngle) * radius,
        cp.y + height,
        cp.z + Math.cos(menuAngle) * radius,
      );
      // Always look at the character's chest height.
      camera.setTarget(new Vector3(
        cp.x + CAMERA.lookAtOffset.x,
        cp.y + CAMERA.lookAtOffset.y,
        cp.z + CAMERA.lookAtOffset.z,
      ));
      return;
    }

    // Fresh-page fallback: PR 3 chase lerp at thirdPersonOffset. This
    // is the only path where the camera follows the character via
    // lerp. Once the user clicks to lock, everLocked flips to true
    // and this path is never taken again.
    tmpOffset.copyFrom(CAMERA.thirdPersonOffset);
    tmpDesired.set(
      cp.x + tmpOffset.x,
      cp.y + tmpOffset.y,
      cp.z + tmpOffset.z,
    );
    tmpCurrent.set(
      tmpCurrent.x + (tmpDesired.x - tmpCurrent.x) * CAMERA.followLerp,
      tmpCurrent.y + (tmpDesired.y - tmpCurrent.y) * CAMERA.followLerp,
      tmpCurrent.z + (tmpDesired.z - tmpCurrent.z) * CAMERA.followLerp,
    );
    camera.position.copyFrom(tmpCurrent);

    const lookDesired = new Vector3(
      cp.x + CAMERA.lookAtOffset.x,
      cp.y + CAMERA.lookAtOffset.y,
      cp.z + CAMERA.lookAtOffset.z,
    );
    tmpCurrentLook.set(
      tmpCurrentLook.x + (lookDesired.x - tmpCurrentLook.x) * CAMERA.lookLerp,
      tmpCurrentLook.y + (lookDesired.y - tmpCurrentLook.y) * CAMERA.lookLerp,
      tmpCurrentLook.z + (lookDesired.z - tmpCurrentLook.z) * CAMERA.lookLerp,
    );
    camera.setTarget(tmpCurrentLook);
  };

  return {
    camera,
    update,
    /** PR 3 API — returns true when in mode 0 (1st-person). */
    isFirstPerson: () => viewMode === 0,
    /**
     * PR 11.1.2: V cycles 0 <-> 1, but ONLY while pointer-locked. When
     * unlocked, V is a no-op (the user is in a menu, not playing).
     */
    toggle: () => {
      if (!pointerLocked) return;
      viewMode = viewMode === 0 ? 1 : 0;
    },
    /**
     * PR 11.1.2: current locked view mode (0 or 1). Exposed for the smoke.
     */
    getViewMode: () => viewMode,
    /**
     * PR 11.1.2: jump directly to a specific viewMode (only valid for 0/1).
     * Mod-2 wrap so out-of-range values clamp safely.
     */
    setViewMode: (mode: number) => {
      viewMode = ((mode % 2) + 2) % 2;
    },
    /**
     * PR 11.1.2: true when the camera is in menu orbit mode (locked=false,
     * everLocked=true). Exposed for the smoke + UI to know the camera
     * state.
     */
    isMenuOrbit: () => !pointerLocked && everLocked,
    /**
     * PR 11.1.2: current menu orbit angle (radians). Exposed for the
     * smoke so it can assert the orbit is happening (angle advances
     * over time).
     */
    getMenuAngle: () => menuAngle,
    reset: () => {
      viewMode = 0;
      pointerLocked = false;
      yawRadians = 0;
      menuAngle = 0;
      everLocked = false;
    },
    setPointerLock: (locked) => {
      pointerLocked = locked;
      if (locked) {
        // Click to lock: always enter mode 0 (1st-person). Reset menu
        // orbit so the next ESC starts fresh.
        viewMode = 0;
        menuAngle = 0;
        everLocked = true;
      }
      // When unlocking, leave viewMode alone (preserve user's preference
      // for the next lock); menuAngle starts advancing from 0 (or
      // wherever it was).
    },
    applyYawDelta: (deltaRadians) => {
      // Wrap mod 2π so the accumulator doesn't drift at large values
      // (a user could spin the mouse enough to push yaw past 2π
      // in a single play session).
      yawRadians = ((yawRadians + deltaRadians) % TWO_PI + TWO_PI) % TWO_PI;
    },
    getYaw: () => yawRadians,
    isPointerLocked: () => pointerLocked,
    dispose: () => {
      camera.dispose();
    },
  };
}
