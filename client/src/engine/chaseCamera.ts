// Phase 0 / PR 3 — chase camera with V-toggle to first-person.
//
// Built from a `UniversalCamera` (so we get the input manager + the FOV
// helpers for free). Each frame we read the character's world position from
// the `CharacterController` and snap the camera to the chosen offset, then
// look at the chest height.
//
// Third-person offset:  (0, +1.5, -2.8)  — behind, above
// First-person offset:  (0, +1.6,  0.0)  — at the character's eye
// Look-at:              (0, +0.9,  0.0)  — chest height
//
// V toggles which offset is active. The toggle is edge-triggered — the
// caller forwards the `cameraTogglePressed` boolean from `InputState`.

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
  /** True when the camera is in first-person mode. */
  isFirstPerson: () => boolean;
  /** Toggle programmatically. */
  toggle: () => void;
  /** Reset back to third-person. */
  reset: () => void;
  dispose: () => void;
}

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

  let firstPerson = false;
  const tmpOffset = new Vector3();
  const tmpDesired = new Vector3();
  const tmpCurrent = camera.position.clone();
  const tmpCurrentLook = new Vector3(0, 0.9, 0);

  // Suppress the unused-parameter warning: `character` is held by closure so
  // callers can call `getCharacterTransform` from the same handle, and so the
  // parameter contract stays explicit when we add mouse-look in Phase 1.
  void character;

  const update = (): void => {
    tmpOffset.copyFrom(firstPerson ? CAMERA.firstPersonOffset : CAMERA.thirdPersonOffset);

    // Anchor: world-space character position + offset.
    const cp = character.state.position;
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
    isFirstPerson: () => firstPerson,
    toggle: () => {
      firstPerson = !firstPerson;
    },
    reset: () => {
      firstPerson = false;
    },
    dispose: () => {
      camera.dispose();
    },
  };
}
