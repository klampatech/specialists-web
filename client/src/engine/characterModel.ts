// Phase 0 / PR 3 — character visual.
//
// **Mixamo decision (documented in docs/SPEC.md "Decisions — 2026-08-11 PR 3")**:
//   The real Mixamo glTF is not in this repo (no asset pipeline; no network
//   in CI). The placeholder PR-2 red sphere was unsatisfying for the
//   "Kyle sees a character that responds to WASD" acceptance test, so we
//   build a simple procedural humanoid instead:
//
//     - capsule torso (matches the Havok capsule height/radius)
//     - sphere head
//     - cylinder arms + legs as orientable visual cues
//
//   The whole rig parents to a `TransformNode` whose position + rotation are
//   driven by the Havok character controller every frame. When a real glTF
//   shows up in Phase 1, this module is the only file to swap.

import {
  Color3,
  Mesh,
  MeshBuilder,
  Quaternion,
  StandardMaterial,
  TransformNode,
  Vector3,
  type Scene,
} from "@babylonjs/core";

import { CAPSULE, STUNTS } from "./characterConfig";
import type { CharacterController } from "./characterController";

/** Result of `createCharacterModel` — the rig root + body parts for shadow casting. */
export interface CharacterModel {
  root: TransformNode;
  torso: Mesh;
  head: Mesh;
  leftArm: Mesh;
  rightArm: Mesh;
  leftLeg: Mesh;
  rightLeg: Mesh;
  /** Disposes the visual rig. */
  dispose: () => void;
}

const SPECIALISTS_RED = new Color3(0.78, 0.18, 0.18);
const SPECIALISTS_TRIM = new Color3(0.18, 0.18, 0.22);
const SPECIALISTS_SKIN = new Color3(0.86, 0.72, 0.6);

/**
 * Build a procedural humanoid rig parented to a `TransformNode`. The rig is
 * positioned at world origin; the caller is expected to drive the root's
 * `position` / `rotationQuaternion` from the controller each frame.
 */
export function createCharacterModel(
  scene: Scene,
  name = "character",
): CharacterModel {
  const root = new TransformNode(`${name}_root`, scene);

  // ---- Torso: capsule sized to match the Havok collision shape ----
  const torso = MeshBuilder.CreateCapsule(
    `${name}_torso`,
    {
      radius: CAPSULE.radius,
      height: CAPSULE.height,
      tessellation: 18,
    },
    scene,
  );
  const torsoMat = new StandardMaterial(`${name}_torsoMat`, scene);
  torsoMat.diffuseColor = SPECIALISTS_RED;
  torsoMat.specularColor = new Color3(0.25, 0.25, 0.25);
  torso.material = torsoMat;
  torso.parent = root;
  // The Havok capsule centre is at y = 0 of the controller position. Match that
  // so the visual capsule lines up with the collision shape.
  torso.position.set(0, 0, 0);

  // ---- Head: small sphere above the torso ----
  const head = MeshBuilder.CreateSphere(
    `${name}_head`,
    { diameter: 0.55, segments: 18 },
    scene,
  );
  const headMat = new StandardMaterial(`${name}_headMat`, scene);
  headMat.diffuseColor = SPECIALISTS_SKIN;
  headMat.specularColor = new Color3(0.2, 0.2, 0.2);
  head.material = headMat;
  head.parent = root;
  // Sits on top of the torso capsule.
  head.position.set(0, CAPSULE.height / 2 + 0.15, 0);

  // ---- Arms: thin cylinders hanging from the shoulders ----
  const armHeight = 0.7;
  const armRadius = 0.08;
  const armOffsetX = CAPSULE.radius + 0.05;
  const armOffsetY = CAPSULE.height / 2 - 0.1;
  const leftArm = MeshBuilder.CreateCylinder(
    `${name}_armL`,
    { height: armHeight, diameter: armRadius * 2, tessellation: 10 },
    scene,
  );
  const rightArm = MeshBuilder.CreateCylinder(
    `${name}_armR`,
    { height: armHeight, diameter: armRadius * 2, tessellation: 10 },
    scene,
  );
  const armMat = new StandardMaterial(`${name}_armMat`, scene);
  armMat.diffuseColor = SPECIALISTS_TRIM;
  armMat.specularColor = new Color3(0.2, 0.2, 0.2);
  leftArm.material = armMat;
  rightArm.material = armMat;
  leftArm.parent = root;
  rightArm.parent = root;
  leftArm.position.set(-armOffsetX, armOffsetY - armHeight / 2, 0);
  rightArm.position.set(armOffsetX, armOffsetY - armHeight / 2, 0);

  // ---- Legs: short cylinders below the torso (visible only as stubs in PR 3) ----
  const legHeight = 0.4;
  const legRadius = 0.1;
  const legOffsetX = CAPSULE.radius * 0.45;
  const legOffsetY = -CAPSULE.height / 2 + legHeight / 2;
  const leftLeg = MeshBuilder.CreateCylinder(
    `${name}_legL`,
    { height: legHeight, diameter: legRadius * 2, tessellation: 10 },
    scene,
  );
  const rightLeg = MeshBuilder.CreateCylinder(
    `${name}_legR`,
    { height: legHeight, diameter: legRadius * 2, tessellation: 10 },
    scene,
  );
  const legMat = new StandardMaterial(`${name}_legMat`, scene);
  legMat.diffuseColor = SPECIALISTS_TRIM;
  legMat.specularColor = new Color3(0.2, 0.2, 0.2);
  leftLeg.material = legMat;
  rightLeg.material = legMat;
  leftLeg.parent = root;
  rightLeg.parent = root;
  leftLeg.position.set(-legOffsetX, legOffsetY, 0);
  rightLeg.position.set(legOffsetX, legOffsetY, 0);

  return {
    root,
    torso,
    head,
    leftArm,
    rightArm,
    leftLeg,
    rightLeg,
    dispose: () => {
      torso.dispose();
      head.dispose();
      leftArm.dispose();
      rightArm.dispose();
      leftLeg.dispose();
      rightLeg.dispose();
      root.dispose();
    },
  };
}

/**
 * Wire the rig's per-frame visual pose to the controller's stunt state.
 * Must be called after the controller is constructed. The returned function
 * is the rig's per-frame pose applier; call it from the render loop after
 * `controller.update()`.
 */
export function attachPoseUpdater(
  model: CharacterModel,
  controller: CharacterController,
): () => void {
  const baseHeadY = model.head.position.y;
  const baseLeftArmY = model.leftArm.position.y;
  const baseRightArmY = model.rightArm.position.y;
  // Reusable scratch quaternion to avoid per-frame allocations in the hot path.
  const tmpQuat = new Quaternion();
  const diveAxis = new Vector3(1, 0, 0); // tilt around X
  const slideAxis = new Vector3(0, 0, 1); // squash along Z

  return () => {
    const stunt = controller.state.stunt;

    // Reset to base pose each frame, then layer on the active stunt.
    model.head.position.y = baseHeadY;
    model.leftArm.position.y = baseLeftArmY;
    model.rightArm.position.y = baseRightArmY;
    model.torso.rotationQuaternion = Quaternion.Identity();

    if (stunt === "dive") {
      // Forward lean around X axis.
      const leanRad = (STUNTS.dive.leanDegrees * Math.PI) / 180;
      Quaternion.RotationAxisToRef(diveAxis, leanRad, tmpQuat);
      model.torso.rotationQuaternion = tmpQuat;
    } else if (stunt === "slide") {
      // Lower the torso + head + arms by STUNTS.slide.centerDrop.
      const drop = STUNTS.slide.centerDrop;
      model.head.position.y = baseHeadY - drop;
      model.leftArm.position.y = baseLeftArmY - drop;
      model.rightArm.position.y = baseRightArmY - drop;
      // Slight forward pitch to sell the slide.
      Quaternion.RotationAxisToRef(slideAxis, -0.1, tmpQuat);
      model.torso.rotationQuaternion = tmpQuat;
    } else if (stunt === "wallrun") {
      // Sideways tilt: 0.35 rad ≈ 20° around Z so the character looks
      // "stuck to" the wall.
      Quaternion.RotationAxisToRef(slideAxis, 0.35, tmpQuat);
      model.torso.rotationQuaternion = tmpQuat;
    }
  };
}
