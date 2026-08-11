// Phase 0 / PR 2 — first real Babylon scene.
//
// PR 2 scope (per docs/SPEC.md Milestone 1, rows 1-3):
//   - Engine + Scene + ArcRotateCamera (chase camera lands in PR 3)
//   - Skydome + HemisphericLight + DirectionalLight
//   - One static mesh (a procedurally placed sphere — no asset pipeline yet)
//   - Havok plugin registered, physics enabled, ground plane with a static body
//   - No character controller. That's PR 3.
//
// WebGPU vs WebGL2: target WebGPU per docs/SPEC.md, but PR 2 uses WebGL2
// (`new Engine(...)` defaults to WebGL2). WebGPU bootstrap adds a flag + adapter
// wait that complicates the headless smoke; tackle in PR 3 alongside the
// character controller. See HANDOFF.md "Decisions made" 2026-08-11.

import {
  ArcRotateCamera,
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  HavokPlugin,
  HemisphericLight,
  MeshBuilder,
  PhysicsAggregate,
  PhysicsBody,
  PhysicsMotionType,
  PhysicsShape,
  PhysicsShapeType,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import HavokPhysics from "@babylonjs/havok";

export interface SceneHandle {
  engine: Engine;
  scene: Scene;
  dispose: () => void;
}

/**
 * Build the PR 2 scene into a pre-mounted canvas element.
 *
 * Returns the Babylon engine + scene so the caller can drive the render loop
 * (Babylon starts one automatically when the engine is constructed, but we
 * expose the handles for the Playwright headless smoke + future PR 3 work).
 */
export async function createScene(canvas: HTMLCanvasElement): Promise<SceneHandle> {
  // WebGL2 for now. Swap to WebGPUEngine in PR 3 once the headless smoke
  // validates both paths.
  const engine = new Engine(canvas, true, {
    preserveDrawingBuffer: true, // needed for Playwright screenshot capture
    stencil: true,
    antialias: true,
  });

  const scene = new Scene(engine);
  // Slight blue-grey clear so the first frame isn't a white flash before the
  // skydome paints. The skydome paints over this except where it doesn't
  // (under the ground plane), so clearing to a sensible colour matters.
  scene.clearColor = new Color4(0.15, 0.18, 0.22, 1.0);
  scene.ambientColor = new Color3(0.2, 0.2, 0.2);

  // ---- Camera ---------------------------------------------------------------
  // ArcRotateCamera is the easy one to get on screen first. PR 3 swaps this
  // for a chase camera that follows the player rig.
  const camera = new ArcRotateCamera(
    "orbit",
    -Math.PI / 2,
    Math.PI / 3,
    12,
    new Vector3(0, 1, 0),
    scene,
  );
  camera.attachControl(canvas, true);
  camera.lowerRadiusLimit = 5;
  camera.upperRadiusLimit = 30;
  camera.wheelDeltaPercentage = 0.01;

  // ---- Lights + skydome -----------------------------------------------------
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

  // Skydome — a large inward-facing sphere with a vertical gradient. PR 2
  // uses a simple two-stop gradient; PR 3+ can swap in a real HDRI.
  const sky = MeshBuilder.CreateSphere(
    "sky",
    { diameter: 1000, segments: 16, sideOrientation: 1 /* BACKSIDE */ },
    scene,
  );
  sky.position.y = 0;
  sky.infiniteDistance = true;
  // Dynamic texture would be nicer but a solid gradient is enough for the
  // lit-scene acceptance test.
  const skyMat = new StandardMaterial("skyMat", scene);
  skyMat.disableLighting = true;
  skyMat.emissiveColor = new Color3(0.32, 0.45, 0.6);
  skyMat.specularColor = new Color3(0, 0, 0);
  sky.material = skyMat;
  sky.isPickable = false;

  // ---- Static mesh ----------------------------------------------------------
  // Procedural sphere — no asset pipeline yet. The acceptance test is "one
  // object visible on a static ground." A sphere is the cheapest mesh that
  // shows off the lighting.
  const sphere = MeshBuilder.CreateSphere(
    "specimen",
    { diameter: 1.5, segments: 32 },
    scene,
  );
  sphere.position.set(0, 0.75, 0);
  shadowGen.addShadowCaster(sphere);
  const sphereMat = new StandardMaterial("sphereMat", scene);
  sphereMat.diffuseColor = new Color3(0.85, 0.25, 0.25); // Specialists red
  sphereMat.specularColor = new Color3(0.4, 0.4, 0.4);
  sphere.material = sphereMat;

  // ---- Havok physics --------------------------------------------------------
  // PR 2 ships a static ground and a static sphere body. PR 3 swaps the
  // sphere for a kinematic character controller.
  const havokInstance = await HavokPhysics();
  const havokPlugin = new HavokPlugin(true, havokInstance);
  scene.enablePhysics(new Vector3(0, -9.81, 0), havokPlugin);

  // Ground plane
  const ground = MeshBuilder.CreateGround(
    "ground",
    { width: 30, height: 30, subdivisions: 1 },
    scene,
  );
  shadowGen.addShadowCaster(sphere);
  ground.receiveShadows = true;
  const groundMat = new StandardMaterial("groundMat", scene);
  groundMat.diffuseColor = new Color3(0.35, 0.38, 0.42);
  groundMat.specularColor = new Color3(0.1, 0.1, 0.1);
  ground.material = groundMat;

  // Static ground body — infinite mass, doesn't move.
  // We use the low-level PhysicsBody + PhysicsShape API to avoid the
  // convenience aggregate on a static mesh (PhysicsAggregate is fine too,
  // but the low-level API matches the docs more closely for PR 3).
  const groundShape = new PhysicsShape(
    { type: PhysicsShapeType.BOX, parameters: { extents: new Vector3(15, 0.01, 15) } },
    scene,
  );
  const groundBody = new PhysicsBody(
    ground,
    PhysicsMotionType.STATIC,
    false,
    scene,
  );
  groundBody.shape = groundShape;
  // Static bodies need explicit MotionType.STATIC (it's the default but
  // setting it makes the intent obvious).
  groundBody.setMotionType(PhysicsMotionType.STATIC);

  // Static sphere body — the specimen shouldn't fall through the ground.
  // We use PhysicsAggregate here for the static sphere so the
  // mass-properties are computed automatically. Mismatched between body
  // styles between the two meshes is fine — both end up static.
  new PhysicsAggregate(
    sphere,
    PhysicsShapeType.SPHERE,
    { mass: 0, restitution: 0.3, friction: 0.8 },
    scene,
  );

  // ---- Render loop ----------------------------------------------------------
  engine.runRenderLoop(() => scene.render());
  // Babylon's resize listener handles the canvas resize, but we expose a
  // dispose() so React StrictMode's double-mount unmount path doesn't leak
  // a render loop + handlers.
  const onResize = () => engine.resize();
  window.addEventListener("resize", onResize);

  return {
    engine,
    scene,
    dispose: () => {
      window.removeEventListener("resize", onResize);
      scene.dispose();
      engine.dispose();
    },
  };
}
