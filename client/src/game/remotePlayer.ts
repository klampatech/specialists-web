// Phase 0 / PR 4 — second character (remote player).
//
// The "remote player" is a Havok-backed character controller on each client
// that runs the *peer player's* input, so each client simulates both bodies.
// The mesh is a cyan-tinted copy of the local rig and has NO `PhysicsAggregate`
// on its own — only the Havok controller exists; the mesh follows the
// controller's state via the standard `visualRoot` plumbing.
//
// **Why no physics aggregate on the mesh**: the remote body already collides
// through its own Havok controller; the visible mesh is a render-only mirror.
// Adding a `PhysicsAggregate` to the mesh would (a) double the collision cost
// every frame (one body per mirrored rig per client) and (b) introduce visible
// jitter if the visual mesh and the controller body ever desync. The
// render-only mesh is correct here; Phase 1 / dedicated-server terrain only
// needs collision on whichever player the local tab is controlling.

import {
  Color3,
  MeshBuilder,
  StandardMaterial,
  TransformNode,
  type Scene,
  Vector3,
} from "@babylonjs/core";

import { CAPSULE } from "../engine/characterConfig";
import {
  createCharacterController,
  type CharacterController,
} from "../engine/characterController";

/** Cyan trim so the remote player is visually distinct from the local red rig. */
const REMOTE_TEAL = new Color3(0.18, 0.78, 0.82);
const REMOTE_TRIM = new Color3(0.18, 0.22, 0.24);

/** Result of `createRemotePlayer` — mesh rig + Havok controller. */
export interface RemotePlayer {
  /** The visual rig. The controller drives its root each frame. */
  model: {
    root: TransformNode;
    torso: import("@babylonjs/core").Mesh;
    head: import("@babylonjs/core").Mesh;
    leftArm: import("@babylonjs/core").Mesh;
    rightArm: import("@babylonjs/core").Mesh;
    leftLeg: import("@babylonjs/core").Mesh;
    rightLeg: import("@babylonjs/core").Mesh;
    dispose: () => void;
  };
  /** Havok controller — receives the *peer's* inputs every frame. */
  controller: CharacterController;
  /** Tear down the visual + the Havok controller. */
  dispose: () => void;
}

/**
 * Build the remote player's rig + Havok controller at `spawnPosition`.
 *
 * The rig mirrors the local procedural humanoid so two capsules stand side by
 * side in the scene. The capsule is teal instead of red so the player can tell
 * the two apart. No `PhysicsAggregate` is created — the controller alone is
 * the collision body; the mesh follows.
 *
 * PR 10.2: `spawnPosition` is the initial placement (offset for visual
 * clarity). `respawnPosition` defaults to `spawnPosition` when omitted.
 * The game session passes `respawnPosition = localSpawn` so the cyan rig
 * respawns to the same point as the red rig (i.e. where the actual remote
 * player's red rig will be, not where the cyan rig started).
 */
export function createRemotePlayer(
  scene: Scene,
  name: string,
  spawnPosition: Vector3,
  respawnPosition?: Vector3,
): RemotePlayer {
  const root = new TransformNode(`${name}_root`, scene);

  // ---- Torso: capsule sized to match the Havok collision shape -----------
  const torso = MeshBuilder.CreateCapsule(
    `${name}_torso`,
    { radius: CAPSULE.radius, height: CAPSULE.height, tessellation: 18 },
    scene,
  );
  const torsoMat = new StandardMaterial(`${name}_torsoMat`, scene);
  torsoMat.diffuseColor = REMOTE_TEAL;
  torsoMat.specularColor = new Color3(0.2, 0.2, 0.2);
  torso.material = torsoMat;
  torso.parent = root;
  torso.position.set(0, 0, 0);

  // ---- Head: small sphere above the torso --------------------------------
  const head = MeshBuilder.CreateSphere(
    `${name}_head`,
    { diameter: 0.55, segments: 18 },
    scene,
  );
  const headMat = new StandardMaterial(`${name}_headMat`, scene);
  headMat.diffuseColor = new Color3(0.86, 0.72, 0.6);
  headMat.specularColor = new Color3(0.2, 0.2, 0.2);
  head.material = headMat;
  head.parent = root;
  head.position.set(0, CAPSULE.height / 2 + 0.15, 0);

  // ---- Arms: thin cylinders hanging from the shoulders -------------------
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
  armMat.diffuseColor = REMOTE_TRIM;
  armMat.specularColor = new Color3(0.2, 0.2, 0.2);
  leftArm.material = armMat;
  rightArm.material = armMat;
  leftArm.parent = root;
  rightArm.parent = root;
  leftArm.position.set(-armOffsetX, armOffsetY - armHeight / 2, 0);
  rightArm.position.set(armOffsetX, armOffsetY - armHeight / 2, 0);

  // ---- Legs: short cylinders below the torso ------------------------------
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
  legMat.diffuseColor = REMOTE_TRIM;
  legMat.specularColor = new Color3(0.2, 0.2, 0.2);
  leftLeg.material = legMat;
  rightLeg.material = legMat;
  leftLeg.parent = root;
  leftLeg.position.set(-legOffsetX, legOffsetY, 0);
  rightLeg.parent = root;
  rightLeg.position.set(legOffsetX, legOffsetY, 0);

  const controller: CharacterController = createCharacterController(scene, {
    startPosition: spawnPosition.clone(),
    // PR 10.2: pass the optional respawnPosition through to the controller.
    // Defaults to startPosition when omitted (preserves existing behavior).
    respawnPosition: respawnPosition?.clone(),
    visualRoot: root,
  });

  return {
    model: {
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
    },
    controller,
    dispose: () => {
      // The Havok controller doesn't expose a public dispose path; the
      // engine tear-down via `scene.dispose()` covers its wasm handles.
      // Dispose the mesh rig eagerly so a manual rebuild (e.g. peer
      // disconnect → reconnect) doesn't leak geometries.
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
