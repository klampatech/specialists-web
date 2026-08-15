// Phase 0 / PR 3+4 — first playable scene (with optional multiplayer).
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
// PR 4 additions (Milestone 2, rows 1-4 substrate):
//   - Optional `multiplayer` parameter on `createScene` — if present, builds
//     a SECOND character (cyan rig from `game/remotePlayer.ts`) and a
//     `GameSession` from `game/gameSession.ts` that drives BOTH controllers
//     in lockstep from the `LockstepRuntime` over the supplied transport.
//   - The chase camera continues to follow the LOCAL controller only — the
//     remote rig renders next to the local one in the same scene.
//
// What this PR *deliberately* doesn't do (deferred to PR 5):
//   - combat semantics (fire / melee / bullet-time behavior)
//   - state-channel usage (the "state" data channel is opened by the peer
//     but the lockstep runs entirely on the reliable ordered "inputs" channel)
//   - any rollback / spec-correct prediction (the lockstep has no rollback by
//     design — see the module header in `net/ggrsRuntime.ts`)
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
import { createGameSession, type GameSession } from "../game/gameSession";
import { renderTracer } from "../game/combat";
import type { GgnetTransport } from "../net/ggnet";

/** Optional multiplayer kick — when present, createScene also runs a second
 *  controller and a lockstep session across the supplied transport. */
export interface MultiplayerOptions {
  transport: GgnetTransport;
}

export interface SceneHandle {
  engine: AbstractEngine;
  scene: Scene;
  /** Disposes the engine, scene, render loop, and any listeners. */
  dispose: () => void;
  /** Snapshot of the live LOCAL character transform — used by tests / HUD.
   *  If multiplayer is on, this is the local rig; the remote rig has its
   *  own controller accessible via `getGameSession()`. */
  getCharacterTransform: () => { position: Vector3; rotation: Quaternion };
  /** Snapshot of the live REMOTE character transform — only present when
   *  multiplayer was enabled. Returns null in single-player mode. */
  getRemoteTransform?: () => { position: Vector3; rotation: Quaternion } | null;
  /** True once the WebGPU/WebGL2 bootstrap finished successfully. */
  isWebGPU: () => boolean;
  /** True if the camera is currently in first-person mode. */
  isFirstPerson: () => boolean;
  /** Programmatic camera toggle — used by tests. */
  toggleCamera: () => void;
  /** Programmatic controller reset — used by tests. */
  resetCharacter: () => void;
  /** The GameSession, if multiplayer was enabled. */
  getGameSession?: () => GameSession | null;
  /** Snapshot of the most recent LOCAL InputState — used by the HUD bullet-time chip. */
  getInputState?: () => InputState | null;
  /** PR 11.2: chase camera state — pointer lock + menu-orbit. Used by
   *  the React HUD + pause-menu layer to know when to show the menu.
   *  Single source of truth: the chase camera's internal flags. */
  getChaseState?: () => {
    isPointerLocked: boolean;
    isMenuOrbit: boolean;
    /** True once the user has locked at least once. Drives the
     *  everLocked gate on the pause-menu visibility. */
    everLocked: boolean;
    /** Current locked viewMode (0 first-person, 1 over-shoulder). */
    viewMode: number;
  };
  /** PR 11.2: programmatic Resume action — re-locks the pointer. Same
   *  effect as a real `requestPointerLock()` (well, almost — the user
   *  gesture requirement is bypassed here, so this only works inside a
   *  user-initiated event handler or the smoke; the browser will refuse
   *  in random places). The chase camera handles viewMode restoration. */
  setPointerLock?: (locked: boolean) => void;
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
 * Add the meshes of a procedural humanoid rig to the shadow caster list.
 * Pulled out so the single-player path and the multiplayer path share the
 * exact same shadow setup (matches the rig returned by characterModel.ts
 * and by game/remotePlayer.ts).
 */
function castRigShadows(
  shadowGen: ShadowGenerator,
  rig: { torso: import("@babylonjs/core").Mesh; head: import("@babylonjs/core").Mesh; leftArm: import("@babylonjs/core").Mesh; rightArm: import("@babylonjs/core").Mesh; leftLeg: import("@babylonjs/core").Mesh; rightLeg: import("@babylonjs/core").Mesh },
): void {
  shadowGen.addShadowCaster(rig.torso, true);
  shadowGen.addShadowCaster(rig.head, true);
  shadowGen.addShadowCaster(rig.leftArm, true);
  shadowGen.addShadowCaster(rig.rightArm, true);
  shadowGen.addShadowCaster(rig.leftLeg, true);
  shadowGen.addShadowCaster(rig.rightLeg, true);
}

/**
 * Build the PR 3 scene into a pre-mounted canvas element, optionally with a
 * multiplayer GameSession driving a second character.
 *
 * Returns the engine + scene so the caller can drive the render loop. Babylon
 * starts one automatically when the engine is constructed, but we expose the
 * handles for the Playwright headless smoke + future PR 4+ work.
 */
export async function createScene(
  canvas: HTMLCanvasElement,
  multiplayer?: MultiplayerOptions,
): Promise<SceneHandle> {
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

  // ---- GameSession (multiplayer) or single character ----------------------
  // Single-player path: build the local rig + controller directly (PR 3).
  // Multiplayer path: the GameSession owns BOTH rigs + both controllers +
  // the LockstepRuntime; the render loop just calls `gameSession.tick()`.
  const gameSession = multiplayer ? createGameSession(scene, multiplayer.transport) : null;

  let character: CharacterController;
  let applyPose: () => void = () => {};

  if (gameSession) {
    // Multiplayer branch: GameSession owns the rigs. Use the local rig for
    // shadow casting and as the chase-camera target (camera follows LOCAL
    // player, remote renders alongside).
    character = gameSession.localController;
    castRigShadows(shadowGen, gameSession.localModel);
    castRigShadows(shadowGen, gameSession.remoteModel);
  } else {
    // Single-player branch (unchanged from PR 3).
    const characterModel = createCharacterModel(scene);
    character = createCharacterController(scene, {
      startPosition: new Vector3(0, CAPSULE.height / 2, 0),
      visualRoot: characterModel.root,
    });
    castRigShadows(shadowGen, characterModel);
    applyPose = attachPoseUpdater(characterModel, character);
  }

  // ---- Chase camera --------------------------------------------------------
  // Follows the LOCAL controller regardless of mode.
  const chase: ChaseCameraHandle = createChaseCamera(scene, character, canvas);

  // ---- Input listener ------------------------------------------------------
  // PR 7: keep a closure ref to the most recent InputState so the HUD's
  // bullet-time chip can poll `input.bulletTimeHeld` via the SceneHandle.
  let latestInput: InputState | null = null;
  const input: InputListener = createInputListener({
    onFrame: (_state) => {
      // The character controller reads input via `read()`; this hook is
      // available for future per-frame UI updates.
    },
    onCameraToggle: () => chase.toggle(),
    // PR 11.1: pointer-lock + mouse-look hooks. The input listener does
    // the browser-API plumbing (requestPointerLock on click, mousemove
    // while locked); the chase camera owns the yaw accumulator and the
    // camera render path. `applyYawDelta` is called per mousemove
    // (movementX * sensitivity); `setPointerLock(true|false)` toggles
    // between the first-person 1:1 render path and the chase fallback.
    onPointerLockChange: (locked) => chase.setPointerLock(locked),
    onYawDelta: (delta) => chase.applyYawDelta(delta),
  }, canvas);  // PR 7.3: bind mouse handlers directly to the canvas so clicks
               // always reach the listener regardless of Babylon's attachControl
               // pointer-capture behavior.

  // ---- Render loop ---------------------------------------------------------
  let lastTimestamp = performance.now();
  scene.onBeforeRenderObservable.add(() => {
    const now = performance.now();
    const deltaSeconds = Math.max(0.0001, Math.min(0.1, (now - lastTimestamp) / 1000));
    lastTimestamp = now;
    const state: InputState = input.read();
    latestInput = state;
    // PR 11.1: populate the per-frame yaw from the chase camera before
    // the session encodes the input packet. Both clients compute their
    // own yaw from their own mousemove (and pull the peer's yaw off the
    // wire via decodeInput → controller.setYaw on the next frame), so
    // the wire packet here carries THIS client's yaw to the peer. The
    // session's tick() will read this yaw via `state.yawRadians`.
    state.yawRadians = chase.getYaw();
    if (gameSession) {
      // Multiplayer path: the session drives both controllers, applies the
      // stunt pose, and pushes the visual transforms into each rig's root.
      gameSession.tick(state, deltaSeconds, now);
      // PR 7: render tracers for any fire_hit / fire_miss events that were
      // generated since the last frame. consumeUnrenderedCombatEvents()
      // advances the internal cursor so we never draw a tracer twice.
      const newCombatEvents = gameSession.consumeUnrenderedCombatEvents();
      for (const ev of newCombatEvents) {
        if (ev.kind === "fire_hit" || ev.kind === "fire_miss") {
          renderTracer(scene, ev.tracerFrom, ev.tracerTo);
        }
        // melee_hit is a HUD-only event for PR 7; no tracer, no mesh.
      }
    } else {
      // Single-player path (PR 3 behaviour).
      character.update(state, deltaSeconds, now);
      applyPose();
    }
    chase.update();
  });

  engine.runRenderLoop(() => scene.render());
  const onResize = () => engine.resize();
  window.addEventListener("resize", onResize);

  // PR 8: expose a jump-regression probe so the headless smoke can sample
  // the local controller's Y position every frame. This is purely an
  // instrumentation hook — no behavioural effect on the game. The
  // `jump-regression-smoke.mjs` script reads `window.__jumpProbe()` once
  // per poll to assert that holding Space does not fly the character up
  // indefinitely. Kept gated behind `import.meta.env.DEV` (Vite-only,
  // stripped in production) so the production bundle is unchanged.
  if (import.meta.env.DEV && typeof window !== "undefined") {
    (window as unknown as { __jumpProbe?: () => number }).__jumpProbe = () =>
      character.state.position.y;
    // PR 11.1: smoke-only accessor for the mouse-look smoke. Returns
    // the local yaw in radians (0..2π) so the smoke can dispatch a
    // synthetic mousemove (via window.__applyYawDelta) and assert the
    // yaw changed. Headless Chromium doesn't always honor
    // requestPointerLock; the smoke uses a manual yaw-delta path so
    // the test exercises the yaw-rotation code WITHOUT depending on
    // pointer-lock being granted. Same DEV-only gate as __jumpProbe /
    // __teleportRemote — stripped from production by Vite.
    (window as unknown as { __applyYawDelta?: (deltaRadians: number) => void }).__applyYawDelta =
      (deltaRadians: number) => chase.applyYawDelta(deltaRadians);
    (window as unknown as { __mouseLookProbe?: () => number }).__mouseLookProbe = () =>
      chase.getYaw();
    // PR 11.1: pointer-lock toggle probe. Calls chase.setPointerLock
    // directly so the camera-render smoke can test the locked path
    // without depending on headless Chromium honoring
    // requestPointerLock. Same DEV-only gate as __mouseLookProbe.
    (window as unknown as { __pointerLockToggle?: (locked: boolean) => void }).__pointerLockToggle =
      (locked: boolean) => chase.setPointerLock(locked);
    // PR 11.1.1: chase-camera toggle probe. Calls chase.toggle() so the
    // smoke can advance the viewMode state machine without dispatching
    // a synthetic V key event. Same DEV-only gate.
    (window as unknown as { __chaseCameraToggle?: () => void }).__chaseCameraToggle =
      () => chase.toggle();
    // PR 11.1: set-character-yaw probe. Calls character.setYaw(radians)
    // so the camera-render smoke can verify camera.rotation.y updates
    // when the character yaw changes. The chase camera reads
    // character.state.rotation (a Quaternion) in its update() loop
    // when pointerLocked — without this probe, the smoke can only
    // observe the initial state where charYaw = 0. DEV-only.
    (window as unknown as { __setCharacterYaw?: (radians: number) => void }).__setCharacterYaw =
      (radians: number) => character.setYaw(radians);
    // PR 11.1: pointer-lock camera probe. Exposes the chase camera's
    // internal state so the pointer-lock-camera smoke can assert:
    //   - When pointerLocked, camera.position === character.position + firstPersonOffset
    //   - camera.rotation.y matches the character yaw
    //   - When pointerLocked is false, the camera lerps back to the
    //     chase offset (i.e., position drifts away from firstPersonOffset)
    // DEV-only (stripped from production by Vite). Same shape as
    // __mouseLookProbe / __applyYawDelta above.
    (window as unknown as { __chaseCameraProbe?: () => {
      isPointerLocked: boolean;
      viewMode: number;
      isMenuOrbit: boolean;
      menuAngle: number;
      cameraPosition: { x: number; y: number; z: number };
      cameraRotationY: number;
      characterPosition: { x: number; y: number; z: number };
      characterYaw: number;
    } }).__chaseCameraProbe = () => ({
      isPointerLocked: chase.isPointerLocked(),
      viewMode: chase.getViewMode(),
      isMenuOrbit: chase.isMenuOrbit(),
      menuAngle: chase.getMenuAngle(),
      cameraPosition: {
        x: chase.camera.position.x,
        y: chase.camera.position.y,
        z: chase.camera.position.z,
      },
      cameraRotationY: chase.camera.rotation.y,
      characterPosition: {
        x: character.state.position.x,
        y: character.state.position.y,
        z: character.state.position.z,
      },
      characterYaw: (() => {
        const q = character.state.rotation;
        const sinY = 2 * (q.w * q.y + q.z * q.x);
        const cosY = 1 - 2 * (q.y * q.y + q.x * q.x);
        return Math.atan2(sinY, cosY);
      })(),
    });
    // PR 10: smoke-only accessor for the health-regression test. Teleports
    // the REMOTE rig onto a known position so every shot in the smoke
    // is a guaranteed hit. Gated behind `import.meta.env.DEV` (same as
    // `__jumpProbe`); stripped from production bundles by Vite.
    if (gameSession) {
      (window as unknown as { __teleportRemote?: (x: number, z: number) => void }).__teleportRemote =
        (x: number, z: number) => {
          gameSession.remoteController.havok.setPosition(new Vector3(x, 1, z));
        };
    }
  }

  const handle: SceneHandle = {
    engine,
    scene,
    dispose: () => {
      window.removeEventListener("resize", onResize);
      input.dispose();
      chase.dispose();
      gameSession?.dispose();
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
    // PR 11.2: chase state snapshot for the React HUD + pause menu. The
    // chase camera is the single source of truth for pointer-lock + menu
    // orbit state; the React layer polls this at ~10Hz (same cadence as
    // the rest of the HUD) and renders accordingly. `everLocked` is
    // exposed so the React layer can implement the `everLocked === true`
    // gate that prevents the menu from flashing on a fresh page.
    getChaseState: () => ({
      isPointerLocked: chase.isPointerLocked(),
      isMenuOrbit: chase.isMenuOrbit(),
      // `everLocked` is internal to chaseCamera — we surface it via the
      // `isMenuOrbit` shape (`isMenuOrbit === true` implies `everLocked`)
      // plus `chase.isPointerLocked()` (true when locked, regardless of
      // everLocked). The React layer derives `everLocked` as
      // `isPointerLocked || isMenuOrbit`. This avoids adding a new
      // accessor to the chase camera for the same logic.
      everLocked: chase.isPointerLocked() || chase.isMenuOrbit(),
      viewMode: chase.getViewMode(),
    }),
    // PR 11.2.1 fix (Kyle playtest 2026-08-14): programmatic Resume action —
    // re-locks the pointer. Routes through the BROWSER's `requestPointerLock`
    // / `exitPointerLock` APIs (not just flipping the internal flag).
    // The browser fires `pointerlockchange` either way; the existing
    // `onPointerLockChange` listener forwards to `chase.setPointerLock`,
    // which is the single source of truth. Works inside button onClick
    // handlers (user-activation present). May silently fail outside user-
    // activation (e.g., setTimeout) — that's correct browser behavior.
    // We wrap in try-catch because some browsers throw on document.exitPointerLock
    // when not in pointer-lock (the user may have already exited via ESC).
    setPointerLock: (locked: boolean) => {
      // PR 11.2.3 DEBUG: log every browser-API call (requestPointerLock /
      // exitPointerLock) with timestamp + direction. Filter on
      // "[PR-11.2.3-DEBUG]" in DevTools.
      if (typeof console !== "undefined") {
        console.log(
          `[PR-11.2.3-DEBUG] scene.setPointerLock(${locked}) t=${(performance.now() / 1000).toFixed(3)}s → calling ${locked ? "canvas.requestPointerLock()" : "document.exitPointerLock()"}`,
        );
      }
      try {
        if (locked) {
          canvas.requestPointerLock();
        } else {
          document.exitPointerLock();
        }
      } catch (e) {
        // Silently ignore — the browser is the source of truth for
        // pointer-lock state. If the call fails, the existing
        // pointerlockchange listener will reflect the actual state.
        if (typeof console !== "undefined") {
          console.warn(`[PR 11.2.1] pointerlock API call failed (${locked ? "lock" : "unlock"}):`, e);
        }
      }
    },
  };

  if (gameSession) {
    handle.getGameSession = () => gameSession;
    handle.getRemoteTransform = () => {
      const ctrl = gameSession.remoteController;
      return {
        position: ctrl.state.position.clone(),
        rotation: ctrl.state.rotation.clone(),
      };
    };
    handle.getInputState = () => latestInput;
  } else {
    handle.getInputState = () => latestInput;
  }

  return handle;
}
