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
import { createSpectatorCamera, type SpectatorCameraHandle } from "./spectatorCamera";
import {
  createCharacterController,
  type CharacterController,
  type InputState,
} from "./characterController";
import { CAPSULE, HEALTH, WORLD_GRAVITY } from "./characterConfig";
import { createInputListener, type InputListener } from "./inputListener";
import { createGameSession, type GameSession } from "../game/gameSession";
import { renderTracer } from "../game/combat";
// PR 11.7.D2 / §3.10 — ggrsRuntime + ggnet DELETED. The peer WebRTC
// lockstep substrate is gone; gameSession now owns a LockstepState stub
// (no peer concept). The scene-level types just need a flag to opt
// into the multiplayer scene-mode (we still build a remote rig +
// snapshot interpolator), not the legacy WebRTC transport.
import { decodeInput } from "../net/inputBitmask";

/** Optional multiplayer kick — when present, createScene also runs a
 *  second character (remote rig) + wires the snapshot interpolator
 *  for remote-visual position. There is NO transport parameter in
 *  PR 11.7.D2 / §3.10 (the P2P WebRTC + GGRS lockstep substrate was
 *  retired — see `engine/lockstepState.ts`).
 *
 *  Two ways to enable multiplayer:
 *    1. Programmatic: pass `multiplayer: { useServerTransport: true }`
 *       to `createScene()`.
 *    2. URL-flag: `?server=ws://...` / `?server=https://...` sets
 *       `window.__forceServerTransport` before the scene module
 *       loads (PeerOverlay.tsx reads the URL on module load).
 *
 *  Either path wires the ServerTransport + snapshot interpolator +
 *  remote Havok controller. The smoke uses the URL-flag path.
 */
export interface MultiplayerOptions {
  /** Programmatic override equivalent to setting
   *  `window.__forceServerTransport` before page load. The
   *  `?server=` URL flag is the canonical trigger; this field
   *  exists for future programmatic callers. */
  useServerTransport?: boolean;
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
    /** PR 11.3: current pitch (radians, [-π/2, +π/2]). Currently
     *  not displayed in the HUD; exposed for forward-compat if the
     *  pause menu or HUD ever wants to show a pitch indicator. */
    pitchRadians: number;
  };
  /** PR 11.2: programmatic Resume action — re-locks the pointer. Same
   *  effect as a real `requestPointerLock()` (well, almost — the user
   *  gesture requirement is bypassed here, so this only works inside a
   *  user-initiated event handler or the smoke; the browser will refuse
   *  in random places). The chase camera handles viewMode restoration. */
  setPointerLock?: (locked: boolean) => void;
  /** PR 11.7.D2 / §3.10 — ServerTransport accessor for the
   *  PauseMenu's "Disconnect Server" button + any future UI that
   *  needs to drive the transport lifecycle (close / reconnect).
   *  Returns `null` when no transport is wired (single-player
   *  mode). */
  getServerTransport?: () => import("../net/serverTransport").ServerTransport | null;
}

/**
 * PR 11.6.D / §3.9 — decode an inbound DamageBroadcast body and route
 * it through `damageBus.applyBroadcast`. The default controller
 * resolver maps `targetPlayerId` 2 → local controller (we're player
 * `localPlayerId`, peer is player 2 — see smoke flow).
 */
/**
 * PR 11.6.D / §3.9 — broadcast handler installed in the DEV probe.
 * The handler closure captures `localPlayerId` (set by the page init
 * script) + a getter pair for the controllers (set once `gameSession`
 * is created — see the late-binding call inside the DEV probe IIFE).
 */
type ControllerResolver = () => {
  local: CharacterController;
  remote: CharacterController;
};
/**
 * PR 11.6.D — broadcast handler. The probe (created once, in the
 * DEV probe block below) is passed in explicitly so the broadcast
 * handler + the optimistic-apply paths share one `pendingApplies`
 * map. Vite deduplicates modules in dev, but an explicit dependency
 * is cleaner than relying on the bundler's cache behavior.
 */
function makeBroadcastHandler(
  localPlayerId: number,
  getControllers: ControllerResolver,
  probe: ReturnType<typeof import("../net/damageBus").createDamageBusProbe>,
): (body: Uint8Array) => void {
  return (body: Uint8Array) => {
    if (typeof window !== "undefined") {
      const w = window as unknown as {__broadcastHandlerCount?: number};
      w.__broadcastHandlerCount = (w.__broadcastHandlerCount ?? 0) + 1;
      (window as unknown as {__lastBroadcastHandlerAt?: number}).__lastBroadcastHandlerAt = performance.now();
    }
    // The probe's applyBroadcast handles decoding + the resolver
    // closure. No async needed.
    const bc = probe.decodeDamageBroadcast(body);
    if (!bc) return;
    const { local, remote } = getControllers();
    // PR 11.7.D2 / §3.10 fix — broadcast target is the player being
    // HIT, not the player attacking. The previous resolver
    // (`playerId === localPlayerId ? local : remote`) was wrong for
    // symmetric two-tab play: Tab A shoots Tab B (targetPlayerId=2).
    // Tab B receives the broadcast and saw `targetPlayerId === localPlayerId`
    // (since Tab B IS Player 2), so it applied 12 dmg to itself
    // instead of to its remote. Correct semantic: if the broadcast
    // target is ME, apply to local (self-damage, defensive — the
    // server's dead-target gate prevents this in normal flow); if the
    // target is the OTHER player, apply to remote.
    const result = probe.applyBroadcast(bc, performance.now(), (playerId) =>
      playerId === localPlayerId ? local : remote,
    );
    if (typeof window !== "undefined") {
      const w = window as unknown as {__lastBroadcastResult?: string; __broadcastResultCounts?: Record<string, number>; __broadcastTimestamps?: Array<{at: number, result: string, pendingCountAfter: number, hpRemote?: number, hpLocal?: number}>};
      w.__lastBroadcastResult = result;
      w.__broadcastResultCounts = w.__broadcastResultCounts ?? {};
      w.__broadcastResultCounts[result] = (w.__broadcastResultCounts[result] ?? 0) + 1;
      w.__broadcastTimestamps = w.__broadcastTimestamps ?? [];
      const session = (window as any).__gameSession;
      const hpR = session?.remoteController?.state?.hp;
      const hpL = session?.localController?.state?.hp;
      w.__broadcastTimestamps.push({at: performance.now(), result, pendingCountAfter: (window as any).__damageBus?.pendingApplyCount() ?? -1, hpRemote: hpR, hpLocal: hpL});
    }
  };
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
  // PR 11.6.D FIX 2: pass localPlayerId + peerPlayerId from
  // window flags (set by the smoke init script). Defaults to 1
  // and 2 for the legacy 2-player demo.
  const initLocalPlayerId =
    (window as unknown as { __localPlayerId?: number }).__localPlayerId ?? 1;
  const initPeerPlayerId =
    (window as unknown as { __peerPlayerId?: number }).__peerPlayerId ?? 2;
  // PR 11.7.D2 / §3.10 — createGameSession no longer takes a
  // transport arg (no peer wire to plug in). The gameSession owns a
  // LockstepState stub for HUD compat. The remote visual is driven
  // by the snapshot interpolator wired below (interpolatorTickHook).
  //
  // PR 11.7.D2 / fixes #49-verify: derive `effectiveMultiplayer` from
  // either the `multiplayer` arg OR the `__forceServerTransport` window
  // flag. App.tsx's createScene(canvas) call no longer passes
  // `multiplayer` after D2.2 — the URL-routed `?server=` flag sets
  // `__forceServerTransport` via PeerOverlay's URL reader + the smoke
  // sets it via `page.addInitScript`. Either path should now create
  // a gameSession + ServerTransport wiring (matching PR 11.6.D's
  // pre-D2.2 behavior).
  const effectiveMultiplayer: MultiplayerOptions | undefined =
    multiplayer ??
    ((typeof window !== "undefined" &&
      (window as unknown as { __forceServerTransport?: boolean }).__forceServerTransport === true)
      ? { useServerTransport: true }
      : undefined);
  const gameSession = effectiveMultiplayer
    ? createGameSession(scene, {
        localPlayerId: initLocalPlayerId,
        peerPlayerId: initPeerPlayerId,
      })
    : null;

  let character: CharacterController;
  let applyPose: () => void = () => {};
  // PR 11.7.C / §3.7 — per-frame predictor forward-prediction hook.
  // Set by the DEV-probe IIFE once the ServerTransport + Predictor
  // are wired. The render observer (around line 484) calls this
  // BEFORE gameSession.tick() so the predictor's mirror state is
  // current when a server snapshot arrives. The hook is `null` in
  // the single-player path + production (the IIFE is gated by
  // `import.meta.env.DEV` and the snapshot transport requires
  // `__forceServerTransport`).
  let predictorTickHook: ((nowMs: number) => void) | null = null;
  // PR 11.7.D2 / §3.10 — interpolator tick hook. Fires before
  // gameSession.tick() so the interpolated remote position is
  // fresh at the moment the Havok write-target `setPosition()`
  // runs (in the body of `interpolatorTickHook`, see below). The
  // interpolated position is what drives the remote visual root
  // — the Havok controller is a write-target only after D2.2.
  let interpolatorTickHook: ((nowMs: number) => void) | null = null;
  // PR 11.7.D2 / §3.10 — ServerTransport ref for the PauseMenu
  // disconnect button + future server-lifecycle UI.
  let serverRef: import("../net/serverTransport").ServerTransport | null = null;

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

  // ---- Spectator camera (PR 11.4, dev-only) -------------------------------
  // Lazy-allocated UniversalCamera. Instantiated UNCONDITIONALLY in DEV
  // (the constructor is cheap — one UniversalCamera + 4 window listeners
  // that no-op while inactive). The `import.meta.env.DEV` gate below
  // strips this entire block from production builds via Vite's static
  // removal. Production bundles contain zero spectator code.
  // PR 11.4: dev-box spectator camera (DEV-only). Constructed inside
  // the existing DEV block below; declared at this scope so the render
  // loop can pump WASD via the optional handle. `null` in production.
  let spectator: SpectatorCameraHandle | null = null;

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
    // PR 11.4: F2 toggles the dev-box spectator camera. The handler
    // also tells the GameSession (if any) to gate the character
    // controller's per-tick update — WASD absorbed by the spectator
    // means the character shouldn't move. The chase camera continues
    // running so re-attaching on F2-off is seamless.
    // PR 11.4: F2 fires this hook. ONLY attached in DEV — in
    // production the property is omitted entirely, so the production
    // bundle has zero reference to "onSpectatorToggle" (Vite strips
    // the entire spread). The input listener's F2 dispatch is also
    // gated by `import.meta.env.DEV` (see inputListener.ts), so this
    // is double-belt-and-suspenders: even if a stray F2 fires, the
    // hook doesn't exist to receive it.
    ...(import.meta.env.DEV
      ? {
        onSpectatorToggle: () => {
          spectator?.toggle(chase.getCameraPosition());
          gameSession?.setSpectatorActive?.(spectator?.isActive() ?? false);
        },
      }
      : {}),
    // PR 11.1: pointer-lock + mouse-look hooks. The input listener does
    // the browser-API plumbing (requestPointerLock on click, mousemove
    // while locked); the chase camera owns the yaw accumulator and the
    // camera render path. `applyYawDelta` is called per mousemove
    // (movementX * sensitivity); `setPointerLock(true|false)` toggles
    // between the first-person 1:1 render path and the chase fallback.
    onPointerLockChange: (locked) => chase.setPointerLock(locked),
    onYawDelta: (delta) => chase.applyYawDelta(delta),
    // PR 11.3: pitch delta from locked mousemove (movementY). Same
    // sensitivity as yaw. The chase camera clamps the result to
    // [-π/2, +π/2] so users see hard limits at the physical pitch
    // boundary (every FPS behavior).
    onPitchDelta: (delta) => chase.applyPitchDelta(delta),
    // PR 11.7.E / §3.5 — R fires reload. Delegates to
    // gameSession.tryStartReload() which gates on pointer-locked,
    // alive, ammo<max, not-already-reloading, then sends the
    // ReloadRequest and starts the client-local progress timer.
    onReload: () => {
      gameSession?.tryStartReload?.();
    },
    // PR #108 — weapon-switch keys (1/2/3) + fire-mode cycle (B).
    // Delegates to `gameSession.tryStartWeaponSwitch()` which
    // resolves the cycle sentinel (fireModeIndex === -1) to the
    // next valid index in `WEAPONS_TABLE[weaponId].fire_modes[]`,
    // then calls `sendWeaponSwitch` + updates the optimistic
    // local state.
    onWeaponSwitch: (weaponId, fireModeIndex) => {
      gameSession?.tryStartWeaponSwitch?.(weaponId, fireModeIndex);
    },
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
    // PR 11.3: same lockstep argument as yaw (PR 11.1). Pitch lives on
    // bytes 4-5 of the wire packet; populating from chase.getPitch() each
    // frame means the peer decodes the same value on the same frame
    // → identical look directions → determinism preserved. The
    // controller's setPitch() applies the decoded pitch to the local
    // controller on frame-N+1 (consistent with how yaw is applied).
    state.pitchRadians = chase.getPitch();
    if (gameSession) {
      // Multiplayer path: the session drives the local controller,
      // applies the stunt pose, and pushes the visual transforms
      // into each rig's root. The REMOTE rig's position comes from
      // the snapshot interpolator (interpolatorTickHook below).
      //
      // PR 11.7.D2 / §3.10 — render observer ordering:
      //   1. predictorTickHook (predictor per-frame drain)
      //   2. interpolatorTickHook (interpolator per-frame sample
      //      → applies position to remoteController.havok via
      //      setPosition)
      //   3. gameSession.tick (drives localController; remote
      //      controller's Havok is now at the interpolated position
      //      and the controller's pose applier runs from that base)
      //
      // PR 11.7.C / §3.7 — predictor per-frame forward-prediction fires
      // BEFORE gameSession.tick() so the predictor's mirror state is
      // current at snapshot arrival. The predictor uses save/restore
      // (see the havokStep wrapper in the DEV-probe IIFE) so this
      // doesn't double-advance Havok — the live controller is
      // unchanged after predictorTickHook returns, then gameSession.tick
      // advances it from the same starting state.
      predictorTickHook?.(now);
      // PR 11.7.D2 / §3.10 — interpolator per-frame sample. The
      // hook's body reads the latest snapshot + applies the
      // interpolated position to remoteController.havok. Runs
      // BEFORE gameSession.tick() so the remote's pose applier
      // (applyRemotePose inside gameSession.tick) reads the
      // current Havok position.
      // PR 11.7.D2.1 / FIX — read the LIVE interpolatorTickHook from
      // the window slot (if it was set by an earlier createScene
      // call that won the StrictMode race). Without this, the
      // current createScene's render observer reads its OWN local
      // closure variable, which is null because the sync-claim
      // guard (line ~877) bailed out this createScene's IIFE early.
      // The earlier createScene's IIFE won the slot, set its own
      // hook in its own scope, then disposed — leaving the LATER
      // createScene's observer with no hook. Storing the hook on
      // window lets the live observer call the live hook.
      const liveHook = (typeof window !== "undefined")
        ? (window as unknown as {
            __liveInterpolatorTickHook?: ((nowMs: number) => void) | null;
          }).__liveInterpolatorTickHook ?? null
        : null;
      if (liveHook) {
        liveHook(now);
      } else {
        interpolatorTickHook?.(now);
      }
      gameSession.tick(state, deltaSeconds, now);
      // PR 11.7.E / §3.5 — reload-bar timer expiry. The snapshot confirms
      // the server has refilled ammo (typically within ~50ms of the
      // ReloadRequest), but the HUD bar tracks the client-local 1500ms
      // visual timer. Clearing on snapshot arrival made the bar disappear
      // in ≤50ms (claude review B-2). Clear the timer here when the
      // visual deadline expires — only if a reload is in flight.
      try {
        const reloadingUntilMs = (gameSession as unknown as {
          getReloadingUntilMs?: () => number | null;
        }).getReloadingUntilMs?.();
        if (reloadingUntilMs !== null && reloadingUntilMs !== undefined && now >= reloadingUntilMs) {
          (gameSession as unknown as {
            _clearReloadingUntilMs?: () => void;
          })._clearReloadingUntilMs?.();
        }
      } catch {
        // gameSession may not expose the hook in production bundles; ignore.
      }
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
      // PR 11.4: gate the local controller on `!spectator.active`. The
      // multiplayer path gates the same thing inside `gameSession.tick()`
      // (both controllers gated together). The single-player path has no
      // game session, so we gate here. Input listener still fires (it
      // only reads key state) — the gate is on whether we ACT on it.
      if (spectator === null || !spectator.isActive()) {
        character.update(state, deltaSeconds, now);
        applyPose();
      }
    }
    chase.update();
    // PR 11.4: spectator WASD pump. Only does work while the spectator
    // is active (early-out inside pumpWASD); the gate here is a tiny
    // micro-optimisation so we don't read the input state struct for
    // the spectator branch on every frame in production (the spectator
    // branch is stripped in production, so this whole line is a no-op).
    // PR 11.4: spectator WASD pump. The whole block is DEV-only —
    // Vite strips it from production because `import.meta.env.DEV` is
    // statically replaced with `false` there.
    if (import.meta.env.DEV && spectator !== null && spectator.isActive()) {
      // PR 11.4.1: pass frame delta in seconds so pumpWASD can scale
      // speed (m/s) by dt instead of treating it as m/frame.
      spectator.pumpWASD(
        { forward: state.forward, right: state.right },
        engine.getDeltaTime() / 1000,
      );
    }
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
    // PR 11.4: dev-box free-fly spectator camera — construct it inside
    // the DEV block so Vite strips it from production. The construction
    // is cheap (one UniversalCamera + 4 no-op-while-inactive window
    // listeners), but we still don't want the listener registrations
    // in production bundles — the F2 keydown check in inputListener.ts
    // also gates this same way, so neither side fires in production.
    spectator = createSpectatorCamera(scene, chase.camera);
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
    // PR 11.3: smoke-only accessor for the mouse-pitch smoke. Returns
    // the local pitch in radians ([-π/2, +π/2]) so the smoke can
    // dispatch a synthetic pitch-delta (via window.__applyPitchDelta)
    // and assert the pitch changed + that the camera rotated. Same
    // DEV-only gate as __applyYawDelta / __mouseLookProbe.
    (window as unknown as { __applyPitchDelta?: (deltaRadians: number) => void }).__applyPitchDelta =
      (deltaRadians: number) => chase.applyPitchDelta(deltaRadians);
    (window as unknown as { __pitchLookProbe?: () => number }).__pitchLookProbe = () =>
      chase.getPitch();
    // PR 11.1: pointer-lock toggle probe. Calls chase.setPointerLock
    // directly so the camera-render smoke can test the locked path
    // without depending on headless Chromium honoring
    // requestPointerLock. Same DEV-only gate as __mouseLookProbe.
    // PR 11.2.3: use setPointerLockImmediate (bypass-debounce variant)
    // so rapid smoke lock-flips don't get suppressed by the production
    // lock-then-unlock debounce window.
    (window as unknown as { __pointerLockToggle?: (locked: boolean) => void }).__pointerLockToggle =
      (locked: boolean) => chase.setPointerLockImmediate(locked);
    // PR 11.6.D: smoke-only gameSession probe. Exposes the live
    // GameSession (and via it the local/remote controllers) so the
    // damage-server-hp-convergence smoke can drive fire events and
    // read HP values directly. DEV-only — stripped in production.
    if (gameSession) {
      (window as unknown as {__gameSession?: GameSession}).__gameSession = gameSession;
    }
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
      cameraRotationX: number;
      characterPosition: { x: number; y: number; z: number };
      characterYaw: number;
      pitchRadians: number;
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
      // PR 11.3: expose camera.rotation.x so smokes can assert the
      // pitch tilt is being applied in the locked render branches.
      cameraRotationX: chase.camera.rotation.x,
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
      // PR 11.3: current pitch from the chase camera. Asserts in the
      // pointer-lock-camera smoke verify this matches the
      // __pitchLookProbe() reading + that cameraRotationX is its
      // negation (Babylon sign convention).
      pitchRadians: chase.getPitch(),
    });
    // PR 10: smoke-only accessor for the health-regression test.
    // Teleports the REMOTE rig onto a known position so every
    // shot in the smoke is a guaranteed hit. Gated behind
    // `import.meta.env.DEV` (same as `__jumpProbe`); stripped
    // from production bundles by Vite.
    //
    // PR 11.7.D2 / §3.10 — two-step teleport:
    //   1. setPosition on remoteController.havok (immediate
    //      visual move; covers the same-frame read).
    //   2. Push a synthetic snapshot at the teleport position
    //      into the interpolator\'s per-player buffer. Without
    //      this, the next tick() would overwrite the setPosition
    //      with the snapshot\'s last known position (likely the
    //      spawn or wherever the remote was last seen). The
    //      synthetic entry guarantees the teleport sticks for
    //      the next several frames (until a real server
    //      snapshot supersedes it).
    if (gameSession) {
      (window as unknown as { __teleportRemote?: (x: number, z: number) => void }).__teleportRemote =
        (x: number, z: number) => {
          const pos = new Vector3(x, 1, z);
          gameSession.remoteController.havok.setPosition(pos);
          // Find the interpolator (closure-captured via
          // the predictorTickHook setup above; exposed on
          // window via __interpolator for the smoke). We
          // push a synthetic snapshot entry into the
          // buffer for the remote player (non-local).
          const interp = (window as unknown as {__interpolator?: {
            buffers: Map<number, {push: (e: {arrivedAtMs: number; snapshot: unknown; player: {playerId: number; positionX: number; positionY: number; velocityX: number; velocityY: number; yaw: number; pitch: number; hp: number; ammo: number; isFiring: number}}) => void}>;
          }}).__interpolator;
          if (interp) {
            const now = performance.now();
            for (const [pid, buffer] of interp.buffers) {
              // Skip the local player; push a synthetic entry
              // at the teleport position for each remote.
              const syntheticSnap = {
                players: [{
                  playerId: pid,
                  positionX: x,
                  positionY: z,
                  velocityX: 0,
                  velocityY: 0,
                  yaw: 0,
                  pitch: 0,
                  hp: 100,
                  ammo: 0,
                  isFiring: 0,
                  weaponId: 0,
      }],
              };
              buffer.push({
                arrivedAtMs: now,
                snapshot: syntheticSnap,
                player: syntheticSnap.players[0],
              });
            }
          }
        };
    }
    // PR 11.4: dev-box free-fly spectator camera DEV probes. The
    // spectator is constructed unconditionally (the constructor is
    // cheap), but every probe here + the whole spectator code path
    // is wrapped in `import.meta.env.DEV` so Vite strips it from
    // production. The smoke relies on these probes to drive the
    // spectator headlessly.
    // Non-null assertion: spectator is assigned at the top of this DEV
    // block (just below `if (import.meta.env.DEV && typeof window...)`).
    (window as unknown as { __spectatorToggle?: () => void }).__spectatorToggle = () => {
      // Inline DEV-gate — the surrounding block is already inside the
      // `import.meta.env.DEV` check above, but this nested lambda
      // runs at probe-call time so we gate the body for safety.
      if (import.meta.env.DEV) {
        spectator!.toggle(chase.getCameraPosition());
        gameSession?.setSpectatorActive?.(spectator!.isActive());
      }
    };
    (window as unknown as { __spectatorProbe?: () => {
      active: boolean;
      yaw: number;
      pitch: number;
      cameraPos: { x: number; y: number; z: number };
    } }).__spectatorProbe = () => ({
      active: spectator!.isActive(),
      yaw: spectator!.getYaw(),
      pitch: spectator!.getPitch(),
      cameraPos: {
        x: spectator!.camera.position.x,
        y: spectator!.camera.position.y,
        z: spectator!.camera.position.z,
      },
    });
    (window as unknown as { __spectatorMoveDelta?: (dx: number, dy: number, dz: number) => void }).__spectatorMoveDelta =
      (dx: number, dy: number, dz: number) => spectator!.moveDelta(dx, dy, dz);
    (window as unknown as { __spectatorYawDelta?: (deltaRadians: number) => void }).__spectatorYawDelta =
      (deltaRadians: number) => spectator!.applyYawDelta(deltaRadians);
    (window as unknown as { __spectatorPitchDelta?: (deltaRadians: number) => void }).__spectatorPitchDelta =
      (deltaRadians: number) => spectator!.applyPitchDelta(deltaRadians);
    // PR 11.7.D2 / §3.10 — __lockstepProbe REMOVED. The
    // lockstep substrate (ggrsRuntime + peer + ggnet) is gone;
    // the lockstep-rollback smoke is rewritten to test snapshot
    // interpolation (post-D2.2 architectural shift). No probe
    // for the deleted runtime.

    // PR 11.6.C: server-transport DEV probe. The smoke sets
    // `window.__forceServerTransport = true` via `page.addInitScript`
    // BEFORE this scene module loads. When the flag is set, we
    // instantiate a `ServerTransport`, connect it, and expose it (plus
    // the typed `damageBus` wrappers) on `window.__serverTransport`
    // and `window.__damageBus`. The smoke drives the transport
    // directly via these probes — no gameSession wiring (that lands in
    // PR 11.6.D's caller-side swap).
    //
    // The probe is gated behind `import.meta.env.DEV` so Vite strips
    // it from production builds. The `__forceServerTransport` symbol
    // and the `ServerTransport` class itself appear nowhere in
    // production bundles. Verified by:
    //   grep '__forceServerTransport' dist/assets/index-*.js
    //   grep '__serverTransport' dist/assets/index-*.js
    // Both return ZERO matches post- build.
    // PR 11.6.C review fix N1: the DEV probe now honors either the
    // window probe (`__forceServerTransport` — set by the smoke via
    // `page.addInitScript`) OR the programmatic override passed via
    // `MultiplayerOptions.useServerTransport` (planned for PR 11.6.D's
    // URL-routed `?server=` flag). Either is sufficient to enable the
    // server-transport instantiation.
    const useServerTransportFromOpts = effectiveMultiplayer?.useServerTransport === true;
    const useServerTransportFromWindow = (
      typeof window !== "undefined" &&
      (window as unknown as { __forceServerTransport?: boolean }).__forceServerTransport === true
    );
    if (
      import.meta.env.DEV &&
      (useServerTransportFromOpts || useServerTransportFromWindow) &&
      // PR 11.6.D fix4 (Bug A — race-safe sync guard): the check
      // must be both read AND written SYNCHRONOUSLY (no awaits in
      // between). StrictMode fires `createScene` twice in dev; both
      // mounts entered the outer guard before either assigned
      // `window.__serverTransport` (the original assignment lived
      // inside the async IIFE, AFTER `await server.connect()` —
      // too late, the second mount's sync check still saw
      // `undefined`). We now claim the slot synchronously here, so
      // the second mount's sync check bails out before spinning up
      // a duplicate ServerTransport + WS + broadcast handler. The
      // async body rechecks the slot once the connect resolves and
      // closes its own transport if a sibling won the race (defense
      // in depth — the outer sync guard usually catches it, but a
      // microtask-ordered double-tap could still leak).
      ((): boolean => {
        if (typeof window === "undefined") return false;
        const w = window as unknown as {__serverTransport?: unknown};
        if (w.__serverTransport !== undefined) return false;
        w.__serverTransport = "INIT_INFLIGHT";
        return true;
      })()
    ) {
      // Lazy-import to keep the production bundle clean (Vite strips
      // dead branches even when the import statement is at module
      // top-level, but a dynamic import is the documented pattern for
      // DEV-only modules).
      void (async () => {
        // Local alias for the typed window slot. Captured at IIFE
        // start so every re-read inside the async body sees the
        // same target object (a subsequent scene() call writes to
        // the same `window`).
        const winSlot = window as unknown as {
          __serverTransport?: unknown;
          __damageBus?: unknown;
          __broadcastHandlerRegistered?: boolean;
          /** PR 11.7.C / §3.7 — predictor instance for smoke instrumentation. */
          __predictor?: unknown;
          /** PR 11.7.C / §3.8 — interpolator instance for smoke instrumentation. */
          __interpolator?: unknown;
          /** PR 11.7.C / §3.7 — getter for the most recent decoded Snapshot.
           *  Returns `null` if no snapshot has arrived yet. Used by the
           *  future snapshot-driven smoke (5190/5191 don't read this
           *  yet — see PR 11.7.D). */
          __latestSnap?: () => import("../../../protocol/snapshot").Snapshot | null;
        };
        try {
        const { ServerTransport } = await import("../net/serverTransport");
        const { createDamageBusProbe, applyReject: dbApplyReject } = await import("../net/damageBus");
        // Default: point at localhost:5190 (the vite dev server). The
        // smoke can override the transport ports via
        // `window.__damageServerPorts = { wt: 14433, ws: 14434 }`
        // (the canary server's --port-wt / --port-ws flags).
        const urlBase = (window as unknown as { __damageServerUrl?: string }).__damageServerUrl
          ?? `${window.location.protocol}//${window.location.host}`;
        const roomId = (window as unknown as { __damageServerRoomId?: string }).__damageServerRoomId;
        if (!roomId) {
          // PR 11.6.D / DEVBX-hardcode-cleanup (2026-08-30): the
          // silent `?? "DEVBX"` fallback masked URL-vs-client
          // mismatches in smoke harnesses (any smoke that didn't
          // inject __damageServerRoomId silently joined DEVBX,
          // masking whether the server-side parse_room_id() was
          // actually returning the right room). Throwing surfaces
          // the missing-injection at smoke-fail time, where the bug
          // matters. Server-side parse_room_id() already does the
          // correct thing (URL → room with DEVBX_ROOM_ID only as
          // back-compat for malformed paths); this is the matching
          // client-side guard.
          throw new Error(
            "[scene] __damageServerRoomId not set — smoke harness must inject window.__damageServerRoomId before scene boots. " +
            "The room id should be derived from the URL path /rooms/<id> via parseRoomFromUrl(). " +
            "Server-side parse_room_id() already handles malformed URLs by falling back to DEVBX_ROOM_ID, " +
            "but the client should never silently substitute a default."
          );
        }
        // PR 11.6.D — read the local player ID from the page init
        // script (smoke sets this via `window.__localPlayerId`). Defaults
        // to 1 (matches the smoke's first tab; the smoke uses 2 for tab B).
        const localPlayerId = (window as unknown as { __localPlayerId?: number }).__localPlayerId ?? 1;
        const server = new ServerTransport(urlBase, roomId);
        await server.connect();
        // PR 11.6.D fix4 (Bug A — race resolution): after the
        // connect resolves, check whether a sibling mount already
        // wrote a real (non-sentinel) ServerTransport into the slot.
        // If so, this mount lost the race — discard the freshly-
        // connected transport (close to release the WS) and bail.
        // The outer sync guard normally prevents this branch from
        // firing, but GC / microtask reordering can still race two
        // in-flight `connect()` calls; close() prevents a leaked
        // socket + a duplicate broadcast handler.
        if (winSlot.__serverTransport !== "INIT_INFLIGHT" &&
            winSlot.__serverTransport !== undefined) {
          try {
            server.close();
          } catch {
            // ignore — best-effort cleanup
          }
          return;
        }
        // PR 11.6.D / §3.9 — register the broadcast handler. The
        // controller getter is late-binding: gameSession is created
        // AFTER `await connect()` resolves in real browser flow but
        // BEFORE in the smoke (since the smoke awaits the probe
        // BEFORE running its assertions). Either way the getter
        // returns the live controllers on every broadcast.
        // PR 11.6.D — create the damage-bus probe. The probe owns
        // the `pendingApplies` map; both the broadcast handler
        // (registered below) and the gameSession's outbound send
        // path share this single probe so optimistic applies and
        // broadcast confirmations resolve to the same map entry.
        // Vite deduplicates module instances in dev, but threading
        // the probe through explicitly makes the dependency clear.
        const probe = createDamageBusProbe(server);
        // PR 11.6.D fix4 (Bug A — latest-gameSession resolver):
        // the broadcast handler closure would otherwise capture
        // this scene() call's `gameSession` reference, which under
        // React StrictMode is the FIRST call's session — but
        // `window.__gameSession` ends up holding the SECOND
        // call's session (the assignment runs on every scene()
        // — see line ~581) and the smoke reads the LATEST session.
        // Resolving via the window slot ensures the handler
        // applies damage to the live GameSession, not the
        // disposed one from the first mount.
        const broadcastHandler = makeBroadcastHandler(
          localPlayerId,
          () => {
            const liveSession: GameSession | null = (
              typeof window !== "undefined"
                ? (window as unknown as { __gameSession?: GameSession }).__gameSession ?? null
                : null
            );
            const target = liveSession ?? gameSession;
            return target
              ? {local: target.localController, remote: target.remoteController}
              : {local: character, remote: character};
          },
          probe,
        );
        server.onDamageBroadcast(broadcastHandler);
        if (typeof window !== "undefined") {
          const w = window as unknown as {__broadcastHandlerRegistered?: boolean; __broadcastHandlerRegisteredAt?: number};
          w.__broadcastHandlerRegistered = true;
          w.__broadcastHandlerRegisteredAt = performance.now();
        }
        // PR 11.6.D FIX 4: wire the server-private DamageReject
        // listener so the source tab reverts each rejected
        // `DamageRequest` IMMEDIATELY rather than waiting for the
        // 500ms timeout sweep. Without this wiring, the sweep is
        // the only revert path on the source tab and the spam
        // phase over-reverts (each pending entry actualDelta gets
        // re-added, clamped at maxHp — see fix4 commit body for
        // the convergence failure mode). Wire-format stable since
        // PR 11.6.D server `ca9f177` (discriminator 0x07; PR 11.7.B bumped to 0x0C);
        // pre-fix4 the client treated it as an unknown discriminator.
        probe.onDamageReject((r) => {
          if (typeof window !== "undefined") {
            const w = window as unknown as {__rejectHandlerCount?: number; __rejectHandlerResultCounts?: Record<string, number>; __rejectTimestamps?: Array<{at: number, eventId: number, result: string, hpRemote?: number, hpLocal?: number}>};
            w.__rejectHandlerCount = (w.__rejectHandlerCount ?? 0) + 1;
          }
          // PR 11.7.D / §4.4 closure: applyReject no longer takes
          // nowMs (no client-side pending state to clean up after
          // optimistic-apply removal). Just record the rejection for
          // dev observability. Imported directly from damageBus —
          // not on the probe surface anymore (B2 may consolidate).
          const result = dbApplyReject(localPlayerId, r.eventId, r.reason);
          if (typeof window !== "undefined") {
            const w = window as unknown as {__lastRejectResult?: string; __rejectHandlerResultCounts?: Record<string, number>; __rejectTimestamps?: Array<{at: number, eventId: number, result: string, hpRemote?: number, hpLocal?: number}>};
            w.__lastRejectResult = result;
            w.__rejectHandlerResultCounts = w.__rejectHandlerResultCounts ?? {};
            w.__rejectHandlerResultCounts[result] = (w.__rejectHandlerResultCounts[result] ?? 0) + 1;
            w.__rejectTimestamps = w.__rejectTimestamps ?? [];
            const session = (window as any).__gameSession;
            const hpR = session?.remoteController?.state?.hp;
            const hpL = session?.localController?.state?.hp;
            w.__rejectTimestamps.push({at: performance.now(), eventId: r.eventId, result, hpRemote: hpR, hpLocal: hpL});
          }
        });
        if (typeof window !== "undefined") {
          (window as unknown as {__rejectHandlerRegistered?: boolean}).__rejectHandlerRegistered = true;
        }
        // PR 11.6.D fix4 (Bug A — handler-publish race): before
        // replacing the sentinel with the real ServerTransport,
        // re-check the slot. If a sibling mount somehow sneaked a
        // real ServerTransport into the slot between connect()
        // resolving and here, that sibling is the authority — drop
        // ours (close + return) to avoid duplicate broadcast
        // handlers / probe maps.
        if (winSlot.__serverTransport !== "INIT_INFLIGHT") {
          try {
            server.close();
          } catch {
            // ignore — best-effort cleanup
          }
          return;
        }
        winSlot.__serverTransport = server;
        winSlot.__damageBus = probe;
        // PR 11.7.D2.1 / FIX — late-bind the server transport onto the
        // LIVE GameSession (resolved via window.__gameSession, NOT the
        // closure's `gameSession` variable). Pre-fix: the closure
        // captures the local `gameSession`, which under React
        // StrictMode is the FIRST createScene() call's session — but
        // `window.__gameSession` holds the SECOND (live) session. The
        // first call's session gets disposed when React unmounts it,
        // so its `setServerTransport` updates a dead reference. The
        // live session's `serverTransport` closure stayed null, so
        // `gameSession.tick()` never sent PositionUpdate or
        // DamageRequest via the wire — manual tests saw `positionSends: 0`
        // + damage requests rejected at the server's Gate3.
        //
        // Resolution: read the LIVE gameSession from the window slot,
        // not from the closure. This mirrors the pattern already used
        // in `makeBroadcastHandler` (line ~957-974: "PR 11.6.D fix4"
        // comment) for the same StrictMode race.
        if (typeof window !== "undefined") {
          const liveSession = (window as unknown as { __gameSession?: GameSession }).__gameSession;
          liveSession?.setServerTransport?.(server);
        }
        // PR 11.7.D2 / §3.10 — stash the server on the SceneHandle
        // (closure capture) so the PauseMenu\'s "Disconnect Server"
        // button can close it via `handle.getServerTransport()?.close()`.
        serverRef = server;
        // PR 11.7.C / §3.7 + §3.8 — wire the client-side predictor +
        // remote interpolator onto the ServerTransport's onSnapshot
        // stream. Both consume the same 20Hz Snapshot stream
        // (discriminator 0x07) — see `protocol/snapshot.ts::DISCRIMINATOR_SNAPSHOT`
        // and `server/src/snapshot.rs` for the wire spec. The
        // predictor's `latestSnap` closure + the `predictorTickHook`
        // let the render observer (line 484) call `predictor.tick(now)`
        // per-frame; the interpolator accumulates state for the
        // future PR 11.7.D visual switchover.
        //
        // **Late-binding the predictor**: the predictor is created
        // AFTER `gameSession` is in scope but inside the same async
        // IIFE so the closure capture sees the live `gameSession`.
        // The GameSession's tick() forwards the encoded input to
        // `predictor.recordLocalInput` via a late-bound setter (set
        // below) — the predictor's havokStep wrapper closes over
        // `gameSession.localController` so we capture the live ref.
        if (gameSession) {
          const { Predictor } = await import("./clientPredictor");
          const { Interpolator } = await import("./remoteInterpolator");
          const { decodeSnapshot } = await import("../../../protocol/snapshot");
          const localCtrl = gameSession.localController;
          // Havok-step wrapper (PR 11.7.C / §3.7) — advances the LIVE
          // Havok controller by one frame, reads the post-update state,
          // then RESTORES the controller to its prior position+velocity
          // (a "phantom" simulation: temporarily step physics, capture
          // the result, then revert). The live controller is unchanged
          // after the wrapper returns, but the wrapper reports the
          // state Havok WOULD have reached if the input had been
          // applied. This is the predictor's source of forward-predicted
          // positions for the snapshot-driven drift check.
          //
          // **Why save/restore, not just step**: `gameSession.tick()`
          // (called from the render observer at line 484) already
          // advances the live controller per-frame. A naive step would
          // double-advance (latent bug, fixed in PR 11.7.C's claude
          // review round 1). Save/restore is O(1) per call and lets
          // the predictor drain buffered inputs forward WITHOUT
          // perturbing the live physics.
          //
          // **Note**: CharacterState in PR 11.7.B doesn't carry
          // `velocity` or `isFiring` (velocity is on the Havok
          // controller via `getVelocity()`; isFiring is in the input
          // bitmask, not the controller state). For the predictor's
          // reconciliation we only need position (drift check) + hp
          // — the rest is left at sensible defaults. PR 11.7.E will
          // extend this wrapper when the wire carries more fields.
          const havokStep = (_state: import("../../../protocol/snapshot").PlayerState, encoded: Uint8Array): import("../../../protocol/snapshot").PlayerState => {
            const decoded = decodeInput(encoded);
            // Save the live controller's pos+vel. The wrapper will
            // restore them after the phantom step. We use
            // `havok.setPosition` / `setVelocity` (the same API the
            // existing respawn path uses) — see characterController.ts
            // line 208-210 and line 247-249 for the canonical pattern.
            const savedPos = localCtrl.havok.getPosition().clone();
            const savedVel = localCtrl.havok.getVelocity().clone();
            // Phantom step: advance Havok with the encoded input.
            // `performance.now()` for `nowMs` matches what
            // gameSession.tick() passes (the wall-clock render frame).
            localCtrl.update(decoded, 1 / 60, performance.now());
            // Capture the post-step state for the predictor.
            const postPos = localCtrl.havok.getPosition();
            const postVel = localCtrl.havok.getVelocity();
            const result: import("../../../protocol/snapshot").PlayerState = {
              playerId: localPlayerId,
              positionX: postPos.x,
              positionY: postPos.z,
              velocityX: postVel.x,
              velocityY: postVel.z,
              yaw: 0, // PR 11.7.B wire doesn't carry yaw/pitch
              pitch: 0,
              hp: localCtrl.state.hp,
              ammo: 0,
              isFiring: decoded.fireHeld ? 1 : 0,
              // PR #102 — default to DualPistol (the pre-#102 behavior).
              // PR #103 will populate this from the server snapshot.
              weaponId: 0,
              // PR #107 — default to Semi (the pre-#107 behavior).
              // PR #108 will populate this from the server snapshot.
              currentFireMode: 0,
            };
            // Restore the live controller so the next gameSession.tick()
            // (which advances from the saved pos+vel) sees a clean
            // state. The visual root's position is also restored via
            // the same `setPosition` call.
            localCtrl.havok.setPosition(savedPos);
            localCtrl.havok.setVelocity(savedVel);
            return result;
          };
          const predictor = new Predictor(
            localPlayerId,
            havokStep,
            () => gameSession.frame,
          );
          const interpolator = new Interpolator(localPlayerId);
          // PR 11.7.D2 / §3.10 — interpolatorTickHook body. The hook is called
          // per-frame from the render observer (BEFORE gameSession.tick).
          // It samples the 100ms-lookback interpolated state for the REMOTE
          // player (playerId !== localPlayerId) and applies the position
          // to remoteController.havok via setPosition.
          //
          // The remote Havok body becomes a write-target — its
          // own physics integration (if any) is bypassed by
          // setPosition + the fact that gameSession.tick() no
          // longer calls remoteController.update().
          //
          // **No snapshot → no remote**: when no snapshot has
          // arrived yet (very-first frames), the interpolator
          // returns null and we skip the setPosition (the remote
          // rig stays at its initial spawn). This matches the
          // pre-D2.2 behavior on first-connect.
          //
          // PR 11.7.D3.2 / DEAD CODE — the closure-bound hook body
          // was removed because the LIVE observer (window-published
          // `__liveInterpolatorTickHook` set below at the end of
          // this IIFE) supersedes it under React StrictMode. The
          // closure-bound path would call `setPosition` on a
          // disposed `remoteController.havok` (scene.dispose →
          // gameSession.dispose → remoteController.havok disposed)
          // and silently no-op. The LIVE observer resolves the
          // controller via `window.__gameSession?.remoteController`
          // so it always sees the live (post-StrictMode-re-mount)
          // controller. The render observer's `if (liveHook) ...
          // else interpolatorTickHook?.(now)` fallback at line ~582
          // is now always liveHook and the closure-bound path is
          // dead. We retain the `interpolatorTickHook` variable +
          // the `?.(now)` call for readability (it documents the
          // architectural intent even though the path is never
          // taken).
          interpolatorTickHook = null;
          // PR 11.7.D2.1 / FIX — publish the LIVE remote-controller +
          // the interpolation tick body to the window slot. This
          // decouples the render observer from the createScene()
          // closure that originally set the hook. Under React
          // StrictMode the first createScene wins the sync-claim
          // guard, then gets disposed; the second createScene's
          // observer must then drive the hook against the LIVE
          // (window-resolved) remote controller. Without this, the
          // observer calls a closure-bound hook whose remoteCtrl is
          // disposed (scene.dispose → gameSession.dispose →
          // remoteController.havok disposed) and setPosition
          // silently no-ops.
          if (typeof window !== "undefined") {
            const liveHook = (nowMs: number) => {
              const liveSession = (window as unknown as {
                __gameSession?: GameSession;
              }).__gameSession;
              const liveRemoteCtrl = liveSession?.remoteController;
              if (!liveRemoteCtrl) return;
              const liveInterpolator = (window as unknown as {
                __interpolator?: InstanceType<typeof Interpolator>;
              }).__interpolator;
              if (!liveInterpolator) return;
              const liveStates = liveInterpolator.tick(nowMs);
              if (liveStates.length === 0) return;
              const liveState = liveStates[0];
              // PR 11.7.D3.2 / post-merge hardening — skip position
              // writes during the respawn grace period (3s after
              // `respawn()` fires). The server doesn't auto-respawn, so
              // its snapshot keeps reporting the player's death position
              // until they actually move. Without this skip, the LIVE
              // observer would clobber the respawn teleport within
              // ~16ms and the visual rig would snap back to the death
              // position. The snapshot's buffer continues filling with
              // new authoritative data; we just don't WRITE to the
              // controller until the grace expires.
              if (liveRemoteCtrl.isInRespawnGrace(nowMs)) {
                return;
              }
              liveRemoteCtrl.havok.setPosition(liveState.position);
              // PR 11.7.D3 / walk-mirror visual fix — the LIVE hook is
              // what actually runs under React StrictMode (the
              // closure-bound hook's remoteCtrl is disposed). Mirror
              // the snapshot position onto the visualRoot
              // TransformNode AND state.position so the rig visually
              // tracks the snapshot, not just the Havok body. Without
              // these two calls (which the closure-bound hook above
              // DOES have), the visual mesh stays at world origin.
              liveRemoteCtrl.setVisualPosition(liveState.position);
              liveRemoteCtrl.state.position.copyFrom(liveState.position);
              // Debug hooks so the smoke's __lastInterpolatorTick +
              // __lastInterpolatorSetPosition stay populated when
              // the render observer is in a different scope from
              // the original closure.
              const w = window as unknown as {
                __lastInterpolatorTick?: { ts: number; statesCount: number };
                __lastInterpolatorSetPosition?: { x: number; z: number; ts: number; playerId: number };
              };
              w.__lastInterpolatorTick = { ts: performance.now(), statesCount: liveStates.length };
              w.__lastInterpolatorSetPosition = {
                x: liveState.position.x,
                z: liveState.position.z,
                ts: performance.now(),
                playerId: liveState.playerId,
              };
            };
            (window as unknown as {
              __liveInterpolatorTickHook?: ((nowMs: number) => void) | null;
            }).__liveInterpolatorTickHook = liveHook;
          }
          // PR 11.7.C / §3.7 + §3.8 — closure variable for the latest
          // decoded snapshot. The render observer (line 484) reads
          // this so the interpolator can be queried per-frame for
          // its 100ms-lookback state. (Note: as of PR 11.7.C the
          // remote visual is still driven by the lockstep
          // remoteController's Havok advance — the interpolator's
          // output is consumed by the predictor's reconciliation
          // path only. PR 11.7.D retires the lockstep substrate and
          // drives the remote visual from the interpolator at that
          // point.)
          let latestSnap: import("../../../protocol/snapshot").Snapshot | null = null;
          // PR 11.7.D3.1 / respawn-snap — HP edge detector for the
          // snapshot-driven remote rig. PR 11.7.D2 retired the
          // lockstep P2P substrate which had a discrete `peer.on("respawn")`
          // event that re-keyed + re-positioned the remote rig atomically.
          // Post-#50, respawn is signaled only via
          // `Snapshot.players[i].hp` going `0 → 100` on the 20Hz
          // server-authoritative stream. The LIVE observer reacts to
          // position changes but does NOT react to HP transitions, so
          // when a remote player respawns: (a) the Havok body stays at
          // the death position, (b) the visualRoot stays where it last
          // was drawn, and (c) the interpolator's per-frame setPosition
          // re-clamps it to the stale pre-respawn snapshot position.
          //
          // The fix is a `Map<PlayerId, previousHp>` updated each tick;
          // on `prevHp <= 0 && currentHp === 100`, fire `respawn()` on the
          // remote controller which teleports Havok + visualRoot to the
          // controller's `respawnPosition` (already canonical per
          // PR 10.2's start-vs-respawn split).
          const prevHpByPlayerId = new Map<number, number>();
          server.onSnapshot((body) => {
            const snap = decodeSnapshot(body);
            if (!snap) return;
            const now = performance.now();
            latestSnap = snap;
            // HP edge detection — must run BEFORE the interpolator so
            // the respawn teleport takes effect this frame and the
            // interpolator's tick can latch onto the new position.
            const liveGameSession = (window as unknown as {__gameSession?: GameSession}).__gameSession;
            const liveRemoteCtrl = liveGameSession?.remoteController;
                      // PR 11.7.E / §3.5 — reload completion detection moved to the
            // client-local timer (see gameSession.tryStartReload's tick
            // observer in scene.ts). The snapshot confirms the server
            // side completed, but the HUD bar tracks the client-local
            // 1500ms visual timer (which is what the player perceives as
            // "reloading"). Clearing on every snapshot where ammo>=6 made
            // the bar vanish in ≤50ms instead of the intended 1500ms.
            for (const p of snap.players) {
              // Skip placeholder ids (1000+) — those are un-promoted
              // connections waiting for their first DamageRequest.
              if (p.playerId >= 1000) continue;
              const prevHp = prevHpByPlayerId.get(p.playerId) ?? HEALTH.maxHp;
              if (prevHp <= 0 && p.hp === HEALTH.maxHp) {
                // Respawn edge. Teleport the remote rig to its canonical
                // respawn position (CharacterController.respawn() does
                // Havok + state.position + visualRoot + resets HP, stunt,
                // yaw, pitch, friction). Pass `now` so the HUD's
                // respawn countdown timer syncs.
                if (liveRemoteCtrl) {
                  liveRemoteCtrl.respawn(now);
                  // Refresh the interpolator's per-frame buffer so the
                  // visual tracking starts clean at the respawn position
                  // (otherwise the next interpolator tick could re-clobber
                  // the respawn with a stale pre-respawn snapshot value).
                  if (typeof window !== "undefined") {
                    const w = window as unknown as {
                      __lastInterpolatorSetPosition?: {x: number; z: number; ts: number; playerId: number};
                    };
                    w.__lastInterpolatorSetPosition = {
                      x: liveRemoteCtrl.respawnPosition.x,
                      z: liveRemoteCtrl.respawnPosition.z,
                      ts: now,
                      playerId: p.playerId,
                    };
                  }
                }
              }
              prevHpByPlayerId.set(p.playerId, p.hp);
            }
            // PR #108 — pull the LOCAL player's authoritative
            // weapon state from the snapshot. The snapshot's
            // `weaponId` / `currentFireMode` are the source of
            // truth; the optimistic local state set by
            // `tryStartWeaponSwitch` is overwritten here so a
            // dropped packet (server's rate-limit gate) doesn't
            // leave the HUD desynced.
            const localSnap = snap.players.find((p) => p.playerId === localPlayerId);
            if (localSnap) {
              gameSession?._setLocalWeaponStateFromSnapshot?.(localSnap.weaponId, localSnap.currentFireMode);
            }
            predictor.onSnapshot(snap, now);
            interpolator.onSnapshot(snap, now);
          });
          // PR 11.7.C / §3.7 — per-frame predictor forward-prediction
          // (60Hz, in lockstep with the game loop). The predictor
          // drains buffered inputs forward using save/restore (no
          // double-advance). The render observer calls this BEFORE
          // `gameSession.tick()` so the predictor's state is current
          // at snapshot arrival time (the snapshot's `serverFrame` is
          // the post-gameSession-tick frame; predictor.tick advances
          // the mirror state to match).
          //
          // The per-frame tick is what makes the drift check actually
          // work — without it the predictor's `predictedState` only
          // updates on snapshot arrivals (every 50ms), and the drift
          // would be ~3 frames of Havok advance off by the time the
          // snapshot arrives. The brief's `tick()` API was wired for
          // this reason; this PR completes the wiring that 11.7.B
          // set up.
          //
          // **Visual consumption (deferred to 11.7.D)**: the
          // `predictor.getPredictedState()` is NOT used to drive the
          // local visual root — Havok still drives the visual at
          // 60Hz via `localController.state.position` (updated inside
          // characterController.ts's `update()` at line 402). The
          // predictor's role is reconciliation bookkeeping: track the
          // predicted position in a separate mirror, compare against
          // the server snapshot on arrival, re-simulate or hard-snap
          // on drift. PR 11.7.D wires the interpolator's output into
          // the remote visual (alongside lockstep retirement).
          predictorTickHook = (nowMs: number) => {
            predictor.tick(nowMs);
          };
          // Late-bind the predictor onto the GameSession so tick()
          // can call predictor.recordLocalInput alongside the
          // existing runtime.submitLocalInput.
          gameSession.setPredictor?.(predictor);
          // DEV probes — forward-looking instrumentation for the
          // future snapshot-driven smoke (5190/5191 don't exercise
          // these yet — the snapshot path is verified via the
          // §4.4 HP-convergence assertion in the 5191 smoke).
          winSlot.__predictor = predictor;
          winSlot.__interpolator = interpolator;
          winSlot.__latestSnap = () => latestSnap;
        }
        // PR 11.7.D / §4.4 closure — periodic sweep of expired pending
        // applies REMOVED. The sweep existed to revert optimistic
        // applies whose broadcast/reject never arrived (the §4.4 race
        // window). With optimistic-apply gone, there's no client-side
        // pending state to sweep — the client just sends and waits
        // for the broadcast. If the broadcast never arrives, HP
        // simply doesn't decrement (no optimistic apply was made), so
        // there's nothing to revert. The sweep setInterval + the
        // __pendingSweepInterval window probe are gone too (the
        // probe symbol is no longer needed).
        } catch (e) {
          // PR 11.6.D fix4 (Bug A — failure cleanup): if any step
          // in the async body throws (dynamic import failed, WS
          // connect failed, etc.), reset the sentinel so a future
          // scene() mount can retry. Without this, a thrown init
          // would leave `window.__serverTransport = "INIT_INFLIGHT"`
          // and permanently disable the DEV probe.
          try {
            const w = window as unknown as {__serverTransport?: unknown};
            if (w.__serverTransport === "INIT_INFLIGHT") {
              w.__serverTransport = undefined;
            }
          } catch {
            // ignore — nothing useful to do on a cleanup failure
          }
          throw e;
        }
      })();
    }
  }

  const handle: SceneHandle = {
    engine,
    scene,
    dispose: () => {
      window.removeEventListener("resize", onResize);
      // PR 11.7.D / §4.4 closure: __pendingSweepInterval dispose
      // cleanup REMOVED. The sweep setInterval was deleted (see the
      // optimistic-apply removal note above); there's no interval to
      // clear on dispose.
      input.dispose();
      chase.dispose();
      spectator?.dispose();
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
      // PR 11.3: expose pitch alongside viewMode. The pause menu
      // doesn't render pitch today, but the React layer can read it
      // via the existing 10Hz HUD poll if needed (e.g., a future
      // pitch indicator chip).
      pitchRadians: chase.getPitch(),
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
          // PR 11.2.3 (Kyle playtest 2026-08-14 evening — debug log
          // trace): Chrome auto-releases pointer-lock after ~1.5s of
          // mouse inactivity (the user's tab is foreground, the user
          // just clicked Resume, but they may not move the mouse for a
          // second while orienting). The browser then fires
          // `pointerlockchange(false)` and the menu re-shows. Dispatch
          // a zero-delta mousemove synchronously after the lock request
          // succeeds to refresh Chrome's "is the user still engaged"
          // counter. movementX/Y = 0 so this does NOT rotate the camera.
          // The mouse-move handler `onMouseMoveLocked` early-returns on
          // movementX === 0, so this is a no-op for yaw.
          canvas.dispatchEvent(
            new MouseEvent("mousemove", {
              bubbles: true,
              cancelable: true,
              movementX: 0,
              movementY: 0,
            }),
          );
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
    // PR 11.7.D2 / §3.10 — ServerTransport accessor for the
    // PauseMenu disconnect button + future UI.
    handle.getServerTransport = () => serverRef;
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
// HMR_TRIGGER_1787584071
