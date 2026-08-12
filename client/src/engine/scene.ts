// Phase 0 / PR 3 — first playable scene.
//
// PR 3 scope (per docs/SPEC.md Milestone 1, rows 3-10):
//   - Havok `PhysicsCharacterController` driving the player (WASD + stunts)
//   - Procedural humanoid character model parented to the controller
//   - Chase camera (UniversalCamera under our control) with V-toggle to first-person
//   - Static ground + a handful of crate props the character can walk into
//   - **WebGPU bootstrap with WebGL2 fallback** per the PR-2 decision log:
//       "WebGPU targeted for PR 3 alongside the character controller. Bootstrap
//        path is a one-line swap to `WebGPUEngine` in PR 3."
//
// What PR 3 *deliberately* doesn't do (deferred to Phase 1):
//   - ggrs netcode (Milestone 2)
//   - bullet time (Milestone 2)
//   - mouse-look in first-person (polish)
//   - stunt-as-physics (the dive/slide/wallrun change controller parameters +
//     visual pose; they don't bend the collision shape)
//
// **Havok contract reminder**: PhysicsCharacterController is the source of
// truth for the character transform. Babylon meshes read Havok's transform
// for sync; the engine does not run its own gameplay physics.

import {
  AbstractEngine,
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  HavokPlugin,
  HemisphericLight,
  MeshBuilder,
  PhysicsAggregate,
  PhysicsShapeType,
  Quaternion,
  ShadowGenerator,
  StandardMaterial,
  UniversalCamera,
  Vector3,
  WebGPUEngine,
  Scene,
} from "@babylonjs/core";
import HavokPhysics from "@babylonjs/havok";

import { attachPoseUpdater, createCharacterModel } from "./characterModel";
import { createChaseCamera, type ChaseCameraHandle } from "./chaseCamera";
import {
  createCharacterController,
  type CharacterController,
  type InputState,
} from "./characterController";
import { CAPSULE, WORLD_GRAVITY } from "./characterConfig";
import { createInputListener, type InputListener } from "./inputListener";

export interface SceneHandle {
  engine: AbstractEngine;
  scene: Scene;
  /** Disposes the engine, scene, render loop, and any listeners. */
  dispose: () => void;
  /** Snapshot of the live character transform — used by tests / HUD. */
  getCharacterTransform: () => { position: Vector3; rotation: Quaternion };
  /** True once the WebGPU/WebGL2 bootstrap finished successfully. */
  isWebGPU: () => boolean;
  /** True if the camera is currently in first-person mode. */
  isFirstPerson: () => boolean;
  /** Programmatic camera toggle — used by tests. */
  toggleCamera: () => void;
  /** Programmatic controller reset — used by tests. */
  resetCharacter: () => void;
}

/** Try WebGPU first; fall back to WebGL2 if anything throws during init. */
async function createEngine(
  canvas: HTMLCanvasElement,
): Promise<{ engine: AbstractEngine; webgpu: boolean }> {
  const baseOptions = {
    preserveDrawingBuffer: true, // needed for Playwright screenshot capture
    stencil: true,
    antialias: true,
  };
  // WebGPUEngine import + `initAsync` is the bootstrap path. We catch both
  // the constructor (some 9.x sub-bundles don't export it) and the
  // initAsync rejection (no adapter in headless Chromium).
  try {
    const webgpuEngine = new WebGPUEngine(canvas, baseOptions);
    await webgpuEngine.initAsync();
    return { engine: webgpuEngine as unknown as AbstractEngine, webgpu: true };
  } catch (e) {
    // WebGPU unavailable — fall through to WebGL2. We don't log loudly here
    // because the headless smoke path triggers this every run; the boot
    // banner on the page tells Kyle which path won.
    if (typeof console !== "undefined" && typeof console.info === "function") {
      console.info(
        "[scene] WebGPU bootstrap failed, falling back to WebGL2:",
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  const glEngine = new Engine(canvas, true, baseOptions);
  return { engine: glEngine, webgpu: false };
}

/**
 * Build the PR 3 scene into a pre-mounted canvas element.
 *
 * Returns the engine + scene so the caller can drive the render loop. Babylon
 * starts one automatically when the engine is constructed, but we expose the
 * handles for the Playwright headless smoke + future PR 4+ work.
 */
export async function createScene(canvas: HTMLCanvasElement): Promise<SceneHandle> {
  const { engine, webgpu } = await createEngine(canvas);

  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.15, 0.18, 0.22, 1.0);
  scene.ambientColor = new Color3(0.2, 0.2, 0.2);
  // We want physics to step on the Babylon render loop. The default
  // `_advancePhysicsEngineStep` is fine; we just need physics enabled.

  // ---- Camera (placeholder) ------------------------------------------------
  // We create a real UniversalCamera up front so the scene has an active
  // camera before the chase camera is constructed below. The chase camera
  // will overwrite `scene.activeCamera` with its own.
  const placeholderCam = new UniversalCamera("placeholder", new Vector3(0, 1.5, -2.8), scene);
  placeholderCam.minZ = 0.1;
  placeholderCam.maxZ = 200;
  scene.activeCamera = placeholderCam;

  // ---- Lights + skydome ----------------------------------------------------
  const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.6;
  hemi.groundColor = new Color3(0.2, 0.22, 0.25);

  const sun = new DirectionalLight("sun", new Vector3(-0.5, -1, -0.4), scene);
  sun.intensity = 1.0;
  sun.position = new Vector3(10, 20, 10);
  sun.diffuse = new Color3(1.0, 0.95, 0.85);

  const shadowGen = new ShadowGenerator(1024, sun);
  shadowGen.useExponentialShadowMap = true;
  shadowGen.usePoissonSampling = true;

  const sky = MeshBuilder.CreateSphere(
    "sky",
    { diameter: 1000, segments: 16, sideOrientation: 1 /* BACKSIDE */ },
    scene,
  );
  sky.position.y = 0;
  sky.infiniteDistance = true;
  const skyMat = new StandardMaterial("skyMat", scene);
  skyMat.disableLighting = true;
  skyMat.emissiveColor = new Color3(0.32, 0.45, 0.6);
  skyMat.specularColor = new Color3(0, 0, 0);
  sky.material = skyMat;
  sky.isPickable = false;

  // ---- Havok physics --------------------------------------------------------
  const havokInstance = await HavokPhysics();
  const havokPlugin = new HavokPlugin(true, havokInstance);
  scene.enablePhysics(WORLD_GRAVITY, havokPlugin);

  // ---- Ground plane --------------------------------------------------------
  const ground = MeshBuilder.CreateGround(
    "ground",
    { width: 40, height: 40, subdivisions: 1 },
    scene,
  );
  ground.receiveShadows = true;
  const groundMat = new StandardMaterial("groundMat", scene);
  groundMat.diffuseColor = new Color3(0.35, 0.38, 0.42);
  groundMat.specularColor = new Color3(0.1, 0.1, 0.1);
  ground.material = groundMat;
  // Static ground body so the character has something to collide with.
  new PhysicsAggregate(
    ground,
    PhysicsShapeType.BOX,
    { mass: 0, restitution: 0.1, friction: 0.9 },
    scene,
  );

  // ---- Crate props ----------------------------------------------------------
  // Two static boxes for the character to walk into + around. PR 3's
  // wallrun stunt doesn't actually raycast for a wall in PR 3 (it's a
  // state-machine effect), but the boxes still serve as visible reference
  // geometry and they exercise the static-collision path of the Havok
  // controller.
  const cratePositions: Array<{ pos: Vector3; size: [number, number, number] }> = [
    { pos: new Vector3(4, 1, 0), size: [2, 2, 2] },
    { pos: new Vector3(-3, 0.5, 3), size: [1, 1, 1] },
    { pos: new Vector3(-5, 1.25, -2), size: [2.5, 2.5, 2.5] },
  ];
  for (const crate of cratePositions) {
    const [w, h, d] = crate.size;
    const box = MeshBuilder.CreateBox(
      `crate_${crate.pos.x}_${crate.pos.z}`,
      { width: w, height: h, depth: d },
      scene,
    );
    box.position.copyFrom(crate.pos);
    shadowGen.addShadowCaster(box);
    const mat = new StandardMaterial(`crateMat_${crate.pos.x}_${crate.pos.z}`, scene);
    mat.diffuseColor = new Color3(0.55, 0.42, 0.27);
    mat.specularColor = new Color3(0.15, 0.15, 0.15);
    box.material = mat;
    new PhysicsAggregate(
      box,
      PhysicsShapeType.BOX,
      { mass: 0, restitution: 0.1, friction: 0.8 },
      scene,
    );
  }

  // ---- Character visual + controller ---------------------------------------
  const characterModel = createCharacterModel(scene);
  const character: CharacterController = createCharacterController(scene, {
    startPosition: new Vector3(0, CAPSULE.height / 2, 0),
    visualRoot: characterModel.root,
  });
  shadowGen.addShadowCaster(characterModel.torso, true);
  shadowGen.addShadowCaster(characterModel.head, true);
  // Arms + legs are stubs in PR 3 but they still cast shadows for parity.
  shadowGen.addShadowCaster(characterModel.leftArm, true);
  shadowGen.addShadowCaster(characterModel.rightArm, true);
  shadowGen.addShadowCaster(characterModel.leftLeg, true);
  shadowGen.addShadowCaster(characterModel.rightLeg, true);
  const applyPose = attachPoseUpdater(characterModel, character);

  // ---- Chase camera --------------------------------------------------------
  const chase: ChaseCameraHandle = createChaseCamera(scene, character, canvas);

  // ---- Input listener ------------------------------------------------------
  const input: InputListener = createInputListener({
    onFrame: (_state) => {
      // The character controller reads input via `read()`; this hook is
      // available for future per-frame UI updates.
    },
    onCameraToggle: () => chase.toggle(),
  });

  // ---- Render loop ---------------------------------------------------------
  let lastTimestamp = performance.now();
  scene.onBeforeRenderObservable.add(() => {
    const now = performance.now();
    const deltaSeconds = Math.max(0.0001, Math.min(0.1, (now - lastTimestamp) / 1000));
    lastTimestamp = now;
    const state: InputState = input.read();
    character.update(state, deltaSeconds, now);
    applyPose();
    chase.update();
  });

  engine.runRenderLoop(() => scene.render());
  const onResize = () => engine.resize();
  window.addEventListener("resize", onResize);

  return {
    engine,
    scene,
    dispose: () => {
      window.removeEventListener("resize", onResize);
      input.dispose();
      chase.dispose();
      characterModel.dispose();
      scene.dispose();
      engine.dispose();
    },
    getCharacterTransform: () => ({
      position: character.state.position.clone(),
      rotation: character.state.rotation.clone(),
    }),
    isWebGPU: () => webgpu,
    isFirstPerson: () => chase.isFirstPerson(),
    toggleCamera: () => chase.toggle(),
    resetCharacter: () => character.reset(),
  };
}
