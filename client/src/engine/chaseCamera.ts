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
  /** Toggle programmatically. PR 11.1.1: now cycles 3-mode viewMode. */
  toggle: () => void;
  /**
   * PR 11.1.1: current view mode (0=1st-locked, 1=3rd-locked, 2=chase).
   * Exposed so the smoke can assert V cycles correctly.
   */
  getViewMode: () => number;
  /**
   * PR 11.1.1: jump directly to a specific viewMode (mod viewModeCount).
   * Used by setPointerLock to enter mode 0 when the user clicks the canvas.
   */
  setViewMode: (mode: number) => void;
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

  // PR 11.1.1 viewMode state machine (replaces PR 3 firstPerson: boolean).
  //   0 = first-person-locked: camera at firstPersonOffset, rotated by yaw
  //   1 = third-person-locked: camera at thirdPersonLockedOffset, rotated by yaw
  //   2 = chase-unlocked: PR 3 lerped chase, no mouse control
  // V cycles 0 -> 1 -> 2 -> 0. Clicking the canvas to lock ALWAYS enters
  // mode 0 (first-person). Pressing ESC ALWAYS releases to mode 2 (chase).
  let viewMode = 2; // start in chase-unlocked (PR 3 default)
  // PR 11.1 state: pointer-lock engaged → render 1:1 with character at
  // the current viewMode's offset, ignore the lerp chase.
  let pointerLocked = false;
  // PR 11.1 state: local yaw accumulator. Mirrors character.yawRadians
  // (set via the controller's `setYaw` in scene.ts) so the camera can
  // render with the same orientation as the character on each frame.
  let yawRadians = 0;

  const tmpOffset = new Vector3();
  const tmpDesired = new Vector3();
  const tmpCurrent = camera.position.clone();
  const tmpCurrentLook = new Vector3(0, 0.9, 0);

  /**
   * Offset for a given viewMode (locked or unlocked).
   *   0 → firstPersonOffset
   *   1 → thirdPersonLockedOffset (or thirdPersonOffset when unlocked)
   *   2 → thirdPersonOffset (chase lerp)
   */
  const offsetForMode = (mode: number, locked: boolean): Vector3 => {
    if (mode === 0) return CAMERA.firstPersonOffset;
    if (mode === 1) return locked ? CAMERA.thirdPersonLockedOffset : CAMERA.thirdPersonOffset;
    return CAMERA.thirdPersonOffset; // mode 2 (and any future modes >= 2)
  };

  const update = (): void => {
    const cp = character.state.position;
    // PR 11.1.1: pointer-locked path (modes 0 and 1). Snap camera to
    // character + offset; render at the character's exact yaw (no lerp —
    // the locked view IS the character's view, not a follow-camera).
    // Yaw here is the value the scene.ts render loop pulled from the
    // controller's state (via `setYaw` driven by the decoded input
    // packet), so both clients see identical camera orientation on the
    // same frame.
    if (pointerLocked && (viewMode === 0 || viewMode === 1)) {
      const offset = offsetForMode(viewMode, true);
      camera.position.set(cp.x + offset.x, cp.y + offset.y, cp.z + offset.z);
      // Babylon: camera.rotation is a Vector3 in Euler angles. yaw =
      // rotation around world Y. Convert character.state.rotation (a
      // Quaternion) to Euler Y. The character only rotates around Y
      // (yaw only — pitch is camera-side and not in PR 11.1's scope),
      // so the Y component is authoritative.
      const q = character.state.rotation;
      const sinY = 2 * (q.w * q.y + q.z * q.x);
      const cosY = 1 - 2 * (q.y * q.y + q.x * q.x);
      const eulerY = Math.atan2(sinY, cosY);
      camera.rotation.set(0, eulerY, 0);
      return;
    }

    // PR 3 path: lerped chase (first-person-chase OR third-person-chase
    // depending on V-toggle). Unchanged from pre-PR-11.1 behavior.
    // viewMode 0 (unlocked): chase from firstPersonOffset (eye height).
    // viewMode 1 or 2 (unlocked): chase from thirdPersonOffset (behind+above).
    tmpOffset.copyFrom(offsetForMode(viewMode, false));

    // Anchor: world-space character position + offset.
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

    // Look at the chest-height target, also lerped.
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
    /** PR 3 API — returns true when in mode 0 (1st-person-ish). */
    isFirstPerson: () => viewMode === 0,
    /** PR 3 API — now cycles through the 3-mode state machine. */
    toggle: () => {
      viewMode = (viewMode + 1) % CAMERA.viewModeCount;
    },
    /**
     * PR 11.1.1: current view mode (0/1/2). Exposed for the smoke so it
     * can assert V cycles correctly.
     */
    getViewMode: () => viewMode,
    /**
     * PR 11.1.1: jump directly to a specific viewMode. Used by
     * setPointerLock to enter mode 0 when the user clicks the canvas.
     */
    setViewMode: (mode: number) => {
      viewMode = ((mode % CAMERA.viewModeCount) + CAMERA.viewModeCount) % CAMERA.viewModeCount;
    },
    reset: () => {
      viewMode = 2;
      pointerLocked = false;
      yawRadians = 0;
    },
    setPointerLock: (locked) => {
      pointerLocked = locked;
      // PR 11.1.1: clicking the canvas to lock ALWAYS enters mode 0
      // (first-person), regardless of the previous viewMode. ESC ALWAYS
      // releases to mode 2 (chase).
      if (locked) viewMode = 0;
      else viewMode = 2;
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
