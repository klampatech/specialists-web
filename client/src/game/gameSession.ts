// Phase 0 / PR 4+7 — GameSession: per-frame tick that turns local + peer
// inputs into BOTH characters' Havok controllers in lockstep, plus the
// PR 7 combat semantics layer on top.
//
// **What this is**: the orchestrator that bridges the existing PR 3 stack
// (InputListener + CharacterController + procedural humanoid + chase camera)
// with the post-D2.2 architecture: local input → local Havok controller +
// local combat; remote → snapshot stream → interpolator → remote Havok
// controller (write-target only). The lockstep surface is preserved as a
// no-op `LockstepState` stub for call-site compatibility.
//
// **Determinism rule (SPEC §"Determinism rule")**: the tick receives
// `deltaSeconds` + `nowMs` from the engine's frame observer and never reads
// `Date.now()` / `performance.now()`. With the lockstep substrate retired,
// the local controller is the only Havok body driven by the local input —
// the remote controller is repositioned from the snapshot each frame.
//
// **Combat semantics (PR 7)**:
//   - On the rising edge of `fireHeld` (false→true), cast a ray from the
//     local chest height along yaw-forward. The result becomes a
//     `CombatEvent` with `kind: 'fire_hit' | 'fire_miss'` and tracer
//     endpoints. The scene's render observer then calls `renderTracer`
//     for each event.
//   - On the rising edge of `meleePressed`, do the cone-vs-position check
//     using `meleeSwing`. Only emit a `CombatEvent` on a hit.
//   - Bullet time is per-client LOCAL: when `input.bulletTimeHeld` is true,
//     the LOCAL controller receives a scaled dt (`* COMBAT.bulletTime.scale
//     = 0.25`).
//
// **Remote-fire / remote-melee REMOVED (PR 11.7.D2)**: the lockstep
// substrate no longer ships the peer's encoded input to us, so the
// `remoteDecoded` from the stub is always zero (no remote input). The
// remote player's fire / melee damage arrives via the server's
// DamageRequest flow: the other tab sends the request via
// `damageBus.sendDamageRequest`, the server validates + applies HP,
// and the snapshot fan-out carries the new HP to both tabs at 20Hz.
// The `wasRemoteFiring` / `wasRemoteMelee` rising-edge trackers are
// gone (no input to track).
//
// **Two-character scene**: we still construct one Havok controller per
// rig (for visual + hitscan queries against the remote body), but the
// remote controller's POSITION is now driven by
// `remoteInterpolator.tick(now).position` applied via Havok
// `setPosition()` (wired in `scene.ts`). The local controller is the
// only Havok body that's integrated from inputs per-tick.
//
// **PR 11.5 pause-and-wait gate — REMOVED**: the cap was a lockstep-only
// feature. With the substrate gone there's no peer to "fall behind" —
// the stub's `advanceFrame()` always returns `paused: false`. The
// `if (advanced.paused) return makeEmptyFrame(...)` short-circuit in
// the tick is retained as a defensive guard (it never fires) so the
// call-site shape is unchanged.

import { type Scene, Vector3 } from "@babylonjs/core";

import { CAPSULE, PLAYER_MAX_AMMO } from "../engine/characterConfig";
import { createCharacterController, type CharacterController, type InputState } from "../engine/characterController";
import { attachPoseUpdater, createCharacterModel } from "../engine/characterModel";
import { decodeInput, encodeInput } from "../net/inputBitmask";
// PR 11.7.D2 / §3.10 — lockstep substrate replaced by a stub.
// The P2P WebRTC + GGRS lockstep runtime (ggrsRuntime.ts) is gone;
// the new `LockstepState` is a no-op replacement that preserves the
// `submitLocalInput` / `advanceFrame` / getters surface for
// gameSession compat. See `engine/lockstepState.ts` for the design.
import { LockstepState } from "../engine/lockstepState";

import { createRemotePlayer } from "./remotePlayer";
import {
  bulletTimeScale,
  COMBAT,
  dualPistolShoot,
  meleeSwing,
  type DualPistolResult,
  type MeleeResult,
} from "./combat";
import { applyDamage, tickRespawn, type HealthSnapshot } from "./health";
import {
  sendAimEvent as dbSendAimEvent,
  sendInputsServer as dbSendInputsServer,
  sendPositionUpdateThrottled as dbSendPositionUpdateThrottled,
  sendReloadRequest as dbSendReloadRequest,
  nextReloadEventId as dbNextReloadEventId,
} from "../net/damageBus";
import type { AimEvent } from "../../../protocol/damage";
import type { ServerTransport } from "../net/serverTransport";

/** One combat event the HUD / tracer render can react to. */
export type CombatEvent =
  | {
      frame: number;
      kind: "fire_hit" | "fire_miss";
      tracerFrom: Vector3;
      tracerTo: Vector3;
      damage: number;
    }
  | {
      frame: number;
      kind: "melee_hit";
      damage: number;
    };

/** What one tick returned — useful for tests + HUD. */
export interface SessionFrame {
  /** Frame index that was just stepped. */
  frame: number;
  /** Decoded local input (the controller saw this). */
  localInput: InputState;
  /** Decoded remote input (the remote controller saw this). */
  remoteInput: InputState;
  /** True when the remote input came off the wire; false when repeated. */
  remoteConfirmed: boolean;
  /** Combat events generated THIS frame (the tracer render consumes these). */
  combatEvents: CombatEvent[];
}

/**
 * PR 11.5: a zeroed `InputState`. Used to build the empty `SessionFrame`
 * returned on a paused tick — the controllers DON'T see this input (the
 * tick early-returns), but the returned SessionFrame needs the fields
 * to satisfy the type contract. `decodeInput` of a zeroed `Uint8Array`
 * would also work; this is just more explicit.
 */
function makeEmptyInputState(): InputState {
  return {
    forward: 0,
    right: 0,
    jumpPressed: false,
    divePressed: false,
    slideHeld: false,
    wallrunPressed: false,
    cameraTogglePressed: false,
    fireHeld: false,
    meleePressed: false,
    bulletTimeHeld: false,
    yawRadians: 0,
    pitchRadians: 0,
  };
}

/**
 * PR 11.5: an empty `SessionFrame` for a paused tick. `remoteConfirmed`
 * is `true` because we explicitly paused (no prediction). `combatEvents`
 * is empty because rising-edge combat checks are skipped.
 */
function makeEmptyFrame(frame: number): SessionFrame {
  return {
    frame,
    localInput: makeEmptyInputState(),
    remoteInput: makeEmptyInputState(),
    remoteConfirmed: true,
    combatEvents: [],
  };
}

/** Handle returned by `createGameSession`. */
export interface GameSession {
  /** The Havok controller driving the local player's capsule. */
  readonly localController: CharacterController;
  /** The Havok controller driving the remote player's capsule. */
  readonly remoteController: CharacterController;
  /** Local player visual rig (capsule torso + sphere head + cylinder limbs). */
  readonly localModel: import("../engine/characterModel").CharacterModel;
  /** Remote player visual rig (cyan trim variant). */
  readonly remoteModel: import("./remotePlayer").RemotePlayer["model"];
  /** Underlying lockstep runtime — exposed for the HUD + tests. */
  /** PR 11.7.D2 / §3.10 — lockstep substrate replacement stub.
   *  The P2P WebRTC + GGRS runtime is gone; see `engine/lockstepState.ts`.
   *  Surface preserved for HUD compat — all P2P-derived getters
   *  return zero. */
  readonly runtime: LockstepState;
  /** Local frame number (the next frame to be advanced). */
  readonly frame: number;
  /** Last frame the runtime confirmed from the peer. -1 if none yet. */
  readonly latestConfirmedFrame: number;
  /** Frames we had to repeat (informational; surfaces in the HUD). */
  readonly repeatedFrameCount: number;
  /**
   * PR 11.5: consecutive-tick paused-frame counter. Resets to 0 the
   * moment we successfully advance. Surfaced for the future
   * `paused-frames` HUD chip and the smoke catch-up assertions.
   * Out of scope for this PR's HUD wiring — exposed here so the
   * chip can be added as a follow-up without touching the runtime.
   */
  readonly pausedFrames: number;
  /**
   * PR 11.5: total paused-frame count across the session. Monotonic —
   * never decreases. Surfaces for the future HUD's "paused N frames
   * total" diagnostic.
   */
  readonly totalPausedFrameCount: number;
  /** Per-frame tick. Call from `scene.onBeforeRenderObservable`. */
  tick(input: InputState, deltaSeconds: number, nowMs: number): SessionFrame;
  /**
   * PR 11.6.B / §1.2 seam — submit the local input for the next frame.
   * Wraps `runtime.submitLocalInput(encodeInput(input))` in a method so
   * PR 11.7 can swap the destination from `ggrsRuntime` (current P2P
   * lockstep substrate) to `serverTransport` (server-auth) WITHOUT
   * rewriting the call sites in `tick()` — the only changes PR 11.7
   * needs are inside this method. No behavior change in PR 11.6.B:
   * still goes through the lockstep substrate.
   */
  submitLocalInput(input: InputState): void;
  /**
   * PR 11.7.C / §3.7 — late-bind the client-side predictor. scene.ts
   * creates the predictor asynchronously (await server.connect + dynamic
   * import of clientPredictor) AFTER `createGameSession` returns. Tick()
   * calls `predictor.recordLocalInput(advanced.frame, encodedInput)`
   * alongside the existing runtime.submitLocalInput — the predictor
   * uses the buffer for re-simulation after server snapshot
   * reconciliation. Setting to `null` disables prediction (legacy
   * lockstep-only path; used by smokes that don't exercise the
   * snapshot stream).
   *
   * Optional — DEV-only in practice (production bundles omit this
   * method entirely via Vite's tree-shake on the `import.meta.env.DEV`
   * gates in scene.ts).
   */
  setPredictor?: (p: import("../engine/clientPredictor").Predictor | null) => void;
  /**
   * PR 11.6.D FIX 2 — this tab's local player ID. Used as
   * `sourcePlayerId` on outbound DamageRequests. Defaults to 1.
   * The smoke drives this via `window.__localPlayerId` and asserts
   * it via `__gameSession.localPlayerId`.
   */
  readonly localPlayerId: number;
  /**
   * PR 11.6.D FIX 2 — the peer's player ID. Used as `targetPlayerId`
   * on outbound DamageRequests. Defaults to 2. The smoke drives this
   * via `window.__peerPlayerId`.
   */
  readonly peerPlayerId: number;
  /** All combat events ever generated this session (HUD reads `length`). */
  getCombatEvents(): CombatEvent[];
  /** Drain the combat events since the last call; the tracer render uses
   *  this so each event triggers exactly one tracer line. */
  consumeUnrenderedCombatEvents(): CombatEvent[];
  /** PR 10: snapshot of both controllers' HP + respawn timer for the HUD. */
  getHealthSnapshot(): HealthSnapshot;
  /**
   * PR 11.7.E / §3.5 — start a reload on R-press. The scene wires
   * `inputListener.onReload` to this method. Gates:
   *   - pointer-locked (no reload when the cursor is on the page)
   *   - local HP > 0 (no reload while dead — the snapshot's HP is
   *     the source of truth, but for the local controller the
   *     controller's state.hp mirrors it within one tick)
   *   - local ammo < PLAYER_MAX_AMMO (no reload on full mag)
   *   - not already reloading (`reloadingUntilMs === null`)
   *   - server transport connected (no-op in single-player)
   * On success: stamps `reloadingUntilMs = performance.now() +
   * COMBAT.dualPistol.reloadMs`, increments the per-local-player
   * `reloadEventId`, and sends the ReloadRequest over the wire. The
   * HUD's reload-progress bar reads `reloadingUntilMs`; the
   * `__latestSnap` listener clears it when the snapshot's
   * `ammo === PLAYER_MAX_AMMO` (the reload completed server-side).
   */
  tryStartReload?: () => void;
  /**
   * PR 11.7.E / §3.5 — read the current reload-progress timestamp
   * (ms; `performance.now()`-relative) or `null` when idle. The
   * HUD's reload bar polls this every render frame. The
   * `__latestSnap` listener inside `createGameSession` clears it
   * to `null` once the snapshot reports `ammo === PLAYER_MAX_AMMO`.
   */
  getReloadingUntilMs?: () => number | null;
  /**
   * PR 11.7.E / §3.5 — send a ReloadRequest via the bus. DEV-only
   * (production bundles strip the probe entirely). Smoke drives
   * this via `__reloadBus.sendReloadRequest(...)`.
   */
  sendReloadRequest?: (playerId: number, eventId: number) => number;
  /**
   * PR 11.4: scene.ts calls this on F2 toggle. When `active === true`,
   * BOTH controllers' per-tick `update()` is skipped (the spectator
   * camera has absorbed the WASD keys; the character shouldn't move).
   * Combat events are gated the same way — no F2-during-spectator fire.
   * DEV-only in practice (production bundles omit this method entirely).
   */
  setSpectatorActive?: (active: boolean) => void;
  /**
   * PR 11.6.D — late-bind the server-auth damage transport. scene.ts
   * creates the `ServerTransport` asynchronously (await connect) AFTER
   * `createGameSession` returns, so we expose a setter the scene can
   * call once the transport is connected. Setting to `null` reverts
   * to the local-compute path (P2P smokes).
   */
  setServerTransport?: (t: ServerTransport | null) => void;
  /** Tear down both rigs + the runtime. */
  dispose(): void;
}

/** Where the remote capsule spawns. Offset from the local spawn so both are
 *  visible from frame 0 — to the right of the local rig. */
const REMOTE_SPAWN_OFFSET = new Vector3(2.5, 0, 0);
/** PR 11.7.D2.1 / FIX — per-player local spawn offset. The default
 *  PR 10 spawn `(0, CAPSULE.height/2, 0)` was used for BOTH tabs, so
 *  Player 1's local rig and Player 2's local rig started at the
 *  same world position. Pre-fix: both tabs sent `state.position =
 *  (0, 0)` and the snapshot showed Player 1 and Player 2 overlaid
 *  — visually indistinguishable as one rig. Stacking also made
 *  the remote rig invisible until the user walked one tab away.
 *  Player-id-derived X offset keeps both rigs visible from frame 0
 *  (matches the smoke's manual `sendPositionUpdate({positionX: 5})`
 *  workaround). */
const PLAYER_SPAWN_X_OFFSET = (localId: number) =>
  ((localId - 1) % 5 - 2) * 4; // player 1 → -8, 2 → -4, 3 → 0, 4 → +4, 5 → +8
/** PR 11.7.D2.1 / spawn-from-state — server's snapshot already has
 *  the player's reported position (or the placeholder (0,0) before
 *  their first PositionUpdate). When we open Tab B and the server's
 *  room already has Tab A connected, we want the remote rig to
 *  render where Tab A actually is — not at our local spawn. The
 *  `interpolator.onSnapshot(snap, now)` call below happens before
 *  the first `interpolatorTickHook?.(nowMs)` runs, so the buffer
 *  starts populated with whichever player entries arrived in the
 *  first snapshot. Tick() then returns those positions at frame 0. */

/**
 * Build a 2-player GameSession for the given scene + transport.
 *
 * The local rig spawns at the standard spawn point (`CAPSULE.height/2` above
 * origin). The remote rig spawns 2.5m to the right (local +X). Both controllers
 * tick every frame regardless of connection state — disconnected-peer inputs
 * repeat the last known remote input, by design (see the lockstep module
 * header for the honest-limitations note).
 */
export interface CreateGameSessionOpts {
  /** PR 11.6.D: optional server-auth damage transport. When set,
   *  the 4 `applyDamage` call sites in `tick()` route through the
   *  server-broadcast-driven path (send + optimistic apply on
   *  local-fire, no-op on remote-fire — the broadcast handler
   *  applies to the local target). When null (default — all P2P
   *  smokes + PR 11.6.C smoke on 5190), the existing local-compute
   *  path is preserved. */
  serverTransport?: ServerTransport | null;
  /** PR 11.6.D: this tab's local player ID. Used as `sourcePlayerId`
   *  on outgoing DamageRequests. The server assigns IDs to
   *  connections; the smoke drives this directly via the page
   *  init script (window.__localPlayerId). */
  localPlayerId?: number;
  /** PR 11.6.D FIX 2 — the peer's player ID. Used as `targetPlayerId`
   *  on outgoing DamageRequests. Defaults to 2 for the legacy 2-player
   *  demo. The 5191 smoke drives this via `window.__peerPlayerId`. */
  peerPlayerId?: number;
}

export function createGameSession(
  scene: Scene,
  opts: CreateGameSessionOpts = {},
): GameSession {
  // PR 11.7.D2.1 / FIX — per-player local spawn offset. Player 1
  // spawns at x=-8, Player 2 at x=-4, etc. so the local rigs
  // don't overlap in 2-tab manual tests. The smoke uses explicit
  // `sendPositionUpdate({positionX: 5})` for the same reason.
  const localSpawnOffsetX = PLAYER_SPAWN_X_OFFSET(opts.localPlayerId ?? 1);
  const localSpawn = new Vector3(
    localSpawnOffsetX,
    CAPSULE.height / 2,
    0,
  );
  // The remote rig never needs a unique spawn (it's driven by the
  // interpolator from the first snapshot — `tick()` returns the
  // server-authoritative positions). Keep the visual-only spawn
  // offset so the rig is visible before the first snapshot lands.
  const remoteSpawn = localSpawn.add(REMOTE_SPAWN_OFFSET);

  // ---- Local rig + controller -------------------------------------------------
  const localModel = createCharacterModel(scene, "local");
  const localController: CharacterController = createCharacterController(scene, {
    startPosition: localSpawn,
    visualRoot: localModel.root,
  });
  const applyLocalPose = attachPoseUpdater(localModel, localController);

  // ---- Remote rig + controller ------------------------------------------------
  // PR 10.2: the remote rig spawns at an offset (visual clarity when no peer
  // is connected yet), but respawns to `localSpawn` (so the cyan rig mirrors
  // the actual remote player's red rig, not the offset initial position).
  const remote = createRemotePlayer(scene, "remote", remoteSpawn, localSpawn);
  const remoteController = remote.controller;
  const applyRemotePose = attachPoseUpdater(remote.model, remoteController);

  // ---- Lockstep runtime -------------------------------------------------------
  // PR 11.7.D2 / §3.10 — LockstepState stub replaces the old
  // LockstepRuntime. No transport needed (no peer wire).
  const runtime = new LockstepState();

  // ---- PR 7: combat event buffer + rising-edge trackers ----------------------
  /** All combat events emitted by this session. The HUD reads `length`. */
  const combatEvents: CombatEvent[] = [];
  /** Cursor: index in `combatEvents` already consumed by the tracer render. */
  let lastRenderedIdx = 0;
  /** Previous `input.fireHeld` value — tracks rising edges. */
  let wasFiring = false;
  /** Previous `input.meleePressed` value — tracks rising edges. */
   let wasMelee = false;
   // PR 65 — track the snapshot's serverFrame when we last read it,
   // so the AimEvent's `frame` field can be expressed relative to
   // the server's authoritative clock (not the local runtime's
   // counter, which drifts unboundedly).
   let lastSnapshotFrameSeen = 0;
  // PR 11.7.D2 / §3.10 — wasRemoteFiring / wasRemoteMelee REMOVED.
  // The P2P lockstep substrate is gone; there is no longer a
  // "remote input" in the lockstep sense. The remote player's
  // fire / melee damage arrives via the server's snapshot HP
  // decrement (the other tab sent the DamageRequest via
  // damageBus.sendDamageRequest, the server applied it, and the
  // resulting Snapshot is broadcast to both tabs at 20Hz).
  /** PR 10: cached `nowMs` from the last tick — used to compute the
   *  remaining respawn countdown for the HUD snapshot. Updated every
   *  tick; read by `getHealthSnapshot()`. */
  let lastNowMs = 0;
  /**
   * PR 11.6.D — server-auth damage transport (optional). When set,
   * the 4 `applyDamage` call sites route through the new path; when
   * null, the existing local-compute path is preserved (the 14 P2P
   * smokes + PR 11.6.C smoke on 5190 keep working unchanged).
   */
  let serverTransport: ServerTransport | null = opts.serverTransport ?? null;
  /** PR 11.6.D — this tab's local player ID. Used as `sourcePlayerId`
   *  on outgoing DamageRequests. Defaults to 1 (the smoke drives this
   *  via `window.__localPlayerId` and the page init script — see
   *  `tools/damage-server-hp-convergence-smoke.mjs`). */
  const localPlayerId: number = opts.localPlayerId ?? 1;
  /** PR 11.6.D FIX 2 — the peer's player ID. Used as `targetPlayerId`
   *  on outgoing DamageRequests. Defaults to 2 (the demo's 2-player
   *  layout). The smoke drives this via `window.__peerPlayerId` so
   *  Tab A targets player 2 and Tab B targets player 1. */
  const peerPlayerId: number = opts.peerPlayerId ?? 2;
  /** PR 11.6.D — monotonic eventId counter for outbound DamageRequests.
   *  The server rejects stale eventIds (PR 11.6.D §3.4.1 gate 6).
   *  Start at 1 (0 is a sentinel — never used on the wire). */
  // PR #59: monotonic per-local-player counter for AimEvent
  // eventIds. Reset on tab reload; the server's EVENT_ID_WINDOW
  // gate tolerates the reset. (Replaces the pre-PR-#59
  // `nextEventId` counter which was for DamageRequest; that
  // path is REMOVED in PR #59.)
  let nextAimEventIdLocal = 1;
  // PR #59: client-side fire-rate cooldown stamp + ammo counter
  // for the AimEvent pre-check (avoid spamming the wire when
  // the server would reject). Both are cosmetic — the server is
  // the source of truth and the snapshot stream carries the
  // authoritative values. Initial ammo = PLAYER_MAX_AMMO (matches
  // `server/src/constants.rs::PLAYER_MAX_AMMO` — the server is canonical;
  // see `client/src/engine/characterConfig.ts` for the client mirror).
  let lastFireMsLocal = 0;
  let ammoCountLocal = PLAYER_MAX_AMMO;
  /**
   * PR 11.4: when true, BOTH controllers skip their per-tick
   * `update()` call (the spectator camera has absorbed the WASD keys,
   * so neither character should move). Set by `setSpectatorActive` from
   * scene.ts on F2 toggle. Default false (no spectator effect).
   */
  let spectatorActive = false;
  /**
   * PR 11.7.E / §3.5 — reload-progress timestamp (ms; relative to
   * `performance.now()`). Set on R-press via `tryStartReload()` to
   * `now + COMBAT.dualPistol.reloadMs`. The HUD's reload-progress
   * bar reads `reloadingUntilMs` per render frame and renders the
   * fill ratio. Cleared to `null` when the snapshot reports
   * `local ammo === PLAYER_MAX_AMMO` (the server confirmed the
   * reload). Default `null` = idle.
   */
  let reloadingUntilMs: number | null = null;
  // (lastSentReloadEventId tracking removed — the bus's module-level
  //  nextReloadEventId is the canonical counter; nothing on this side
  //  needs to mirror it for the smoke's assertions.)

  /**
   * One tick: encode local input → submit → advance → apply decoded inputs to
   * both controllers → run combat semantics on the local input → update rig
   * poses (stunt visual lean/squash).
   *
   * PR 11.5: when `advanceFrame()` returns `{paused: true, ...}` (the
   * rollback cap fired), we short-circuit BEFORE updating either
   * controller / running combat / ticking respawn. Wire encode + submit
   * still happens (submitLocalInput runs before advanceFrame), so the
   * peer can catch up. Returns a minimal `makeEmptyFrame` so the
   * caller's `SessionFrame` contract is preserved.
   */
  const tick: GameSession["tick"] = (
    input: InputState,
    deltaSeconds: number,
    nowMs: number,
  ): SessionFrame => {
    // PR 10: cache `nowMs` so `getHealthSnapshot()` can compute the
    // remaining respawn countdown without re-reading the wall clock.
    lastNowMs = nowMs;
    // PR 11.4.1 fix: when the spectator is active, the local player
    // (a) shouldn't have any combat events fire (we'd otherwise see
    //     tracers from the spectator's detached view; observed by Kyle
    //     2026-08-15 dev-box playtest), and
    // (b) shouldn't have combat bits encoded on the wire (the peer would
    //     otherwise see a bullet coming from your detached position —
    //     non-deterministic in lockstep terms).
    // Build a sanitized `gameInput` by zeroing combat bits when the
    // spectator is active. Movement bits are also zeroed defensively
    // (the controller update is already gated, but this guarantees the
    // wire packet never contains spurious bits).
    const gameInput: InputState = spectatorActive
      ? {
          ...input,
          forward: 0,
          right: 0,
          fireHeld: false,
          meleePressed: false,
        }
      : input;
    // 1. Encode + submit local input + advance one frame. The runtime uses
    //    the on-wire remote input if it's already arrived, or repeats the
    //    last-known input otherwise.
    //
    //    PR 11.6.B / §1.2 seam: the encode + submit is now wrapped in
    //    `submitLocalInput(input)` below so PR 11.7 can swap the
    //    destination (ggrsRuntime → serverTransport) without touching
    //    this call site.
    // 1. Encode + submit local input + advance one frame. The runtime uses
    //    the on-wire remote input if it's already arrived, or repeats the
    //    last-known input otherwise.
    //
    //    PR 11.6.B / §1.2 seam: the encode + submit is now wrapped in
    //    `submitLocalInput(input)` below so PR 11.7 can swap the
    //    destination (ggrsRuntime → serverTransport) without touching
    //    this call site.
    //
    //    PR 11.7.C / §3.7: encode the input ONCE so the SAME bytes feed
    //    both the runtime submit AND the predictor's recordLocalInput.
    //    Computing encodeInput() twice could diverge (e.g., a future
    //    patch that adds non-deterministic state to the encoder).
    const encodedInput = encodeInput(gameInput);
    submitLocalInput(gameInput);
    const advanced = runtime.advanceFrame();
    // PR 65 — flush the queued InputsServer with the post-advance
    // frame number so the server's inputs_buffer is keyed by the
    // same frame the lockstep substrate just stepped.
    flushInputsServer(advanced.frame);

    // PR 11.7.C / §3.7 — record the input in the predictor's local
    // input buffer (keyed by advanced.frame, the frame just processed).
    // The predictor uses this buffer for re-simulation after a server
    // snapshot reconciliation. No-op when `predictor === null` (no
    // snapshot transport connected — P2P smokes).
    predictor?.recordLocalInput(advanced.frame, encodedInput);

    // PR 11.5: rollback-cap early-return. When the cap fires we return
    // a minimal SessionFrame WITHOUT stepping either controller, running
    // combat, or ticking respawn. The wire packet is already on the wire
    // (submitLocalInput ran above), so the peer can keep catching up.
    // The `wasFiring` / `wasMelee` / etc. rising-edge trackers are NOT
    // updated on a paused tick — the next non-paused tick will see the
    // same input state we already saw, so the rising-edge semantics
    // remain correct (a key pressed before pause and held through it
    // still hits the rising edge on the first non-paused tick).
    if (advanced.paused) {
      return makeEmptyFrame(advanced.frame);
    }

    // 2. Decode both inputs for the controllers.
    const localDecoded: InputState = decodeInput(advanced.local);
    const remoteDecoded: InputState = decodeInput(advanced.remote);

    // 3. PR 7: bullet-time scaling. Applied to LOCAL only — the remote
    //    controller always steps at full speed. Wire carries no dt; both
    //    clients sample dt independently and apply bullet-time independently.
    const scaledDt = bulletTimeScale(localDecoded, deltaSeconds);

    // 4. Step both Havok controllers with their respective inputs.
    //    Same physics, same timestep, same inputs ⇒ same world, modulo the
    //    documented Havok float-rounding acknowledgements.
    // PR 11.4: gate the LOCAL controller update on `!spectatorActive`.
    // When the spectator is free-flying, the character controller shouldn't
    // see any movement (WASD absorbed by the spectator, no character
    // velocity). Combat events also gated — no F2-during-spectator fire.
    //
    // PR 11.7.D2 / §3.10 — `remoteController.update(remoteDecoded, ...)`
    // REMOVED. The remote visual is now driven by the snapshot stream
    // via `remoteInterpolator.tick(now)` + `remoteController.havok.setPosition()`
    // (wiring lives in `scene.ts`). The remote controller stays as a
    // write-target only — its Havok body is repositioned each frame from
    // the interpolator's output. Hitscan combat (`dualPistolShoot`,
    // `meleeSwing`) still reads the remote controller's Havok position
    // because the interpolator's setPosition() keeps that in sync.
    if (!spectatorActive) {
      localController.update(localDecoded, scaledDt, nowMs);
      // Remote controller update is delegated to the snapshot
      // interpolator (see scene.ts render observer + the new
      // interpolatorTickHook). The Havok body stays at the
      // interpolated position; combat hitscan reads Havok's
      // position which is now authoritative-from-server.
    }

    // 5. PR 7: rising-edge combat semantics on the local input.
    // PR 11.4.1: use `gameInput` (sanitized copy) instead of raw `input`
    // — when spectator is active, `fireHeld` / `meleePressed` are forced
    // to false, suppressing both the local tracer fire and the wire
    // payload that would have told the peer you fired.
    const frameCombatEvents: CombatEvent[] = [];
    if (gameInput.fireHeld && !wasFiring) {
      // PR #59 / §3.5 — server-authoritative hit detection.
      //
      // Pre-PR-#59 the local raycast (`dualPistolShoot`) gated
      // whether a `DamageRequest` was sent. That path was
      // vulnerable to the rig being at a position the local
      // Havok query didn't know about (the snapshot stream
      // carries Havok positions; the local physics world only
      // knows `local_*` bodies). The raycast missed → no
      // `DamageRequest` → HP didn't drop.
      //
      // PR #59 sends an `AimEvent` UNCONDITIONALLY on the rising
      // edge of `fireHeld`. The server runs `dual_pistol_hit`
      // against snapshot-known positions for every OTHER
      // player in the room and emits `DamageBroadcast`(s) for
      // hits. The local raycast is still used for the visual
      // tracer (below) — the only client-side decision left
      // is "show the tracer", not "did I hit".
      //
      // Fire-rate cooldown is enforced client-side to avoid
      // spamming the wire; ammo is checked client-side too
      // (purely cosmetic — the server is the source of truth).
      const now = nowMs;
      const cooldownOk =
        now - lastFireMsLocal >= COMBAT.dualPistol.fireCooldownMs;
      const ammoOk = ammoCountLocal > 0;
      if (cooldownOk && ammoOk && serverTransport) {
        // PR 65 — use the snapshot's `serverFrame` (most recent
        // authoritative server frame) plus the per-tick offset
        // relative to when the snapshot arrived. Pre-fix this used
        // `advanced.frame` (the local runtime's frame counter) which
        // can drift FAR behind the server's clock if the canary
        // started before this tab connected. The server's frame gate
        // rejects AimEvents with `frame` more than
        // `POSITION_HISTORY_RETENTION_FRAMES` (64 = ~1s @ 64Hz) behind
        // the server's `current_frame` — the local frame counter
        // drifts unboundedly so it routinely blows this gate after a
        // few seconds of gameplay.
        const snap = (window as Window & { __latestSnap?: () => unknown }).__latestSnap?.() as { serverFrame?: number } | null;
        const snapFrame = snap?.serverFrame ?? 0;
        // The snapshot was emitted at the server's frame `snapFrame`;
        // since then the local runtime has advanced `advanced.frame`
        // by some delta. The server has also been ticking, so the
        // current server frame is roughly `snapFrame + (runtimeDelta
        // / 2)` (half of our local delta passed server-side by now).
        // Use `snapFrame + localDelta - maxRewindBuffer` to keep the
        // request safely within the rewind window.
        const localDelta = advanced.frame - lastSnapshotFrameSeen;
        const reqFrame = Math.max(snapFrame, snapFrame + localDelta - 16);
        const req: AimEvent = {
          sourcePlayerId: localPlayerId,
          yawRadians: gameInput.yawRadians ?? 0,
          pitchRadians: gameInput.pitchRadians ?? 0,
          frame: reqFrame,
          eventId: nextAimEventIdLocal++,
        };
        lastSnapshotFrameSeen = snapFrame;
        dbSendAimEvent(serverTransport, req);
        // Stamp the local fire timestamp + decrement local ammo
        // (snapshot stream carries the authoritative ammo on the
        // next 20Hz tick; this is for immediate HUD feedback).
        lastFireMsLocal = now;
        ammoCountLocal = Math.max(0, ammoCountLocal - 1);
      }
      // Run the local raycast for the VISUAL tracer (and the
      // HUD combat-event label: fire_hit vs fire_miss). The
      // raycast verdict no longer gates whether damage is sent
      // — the tracer draws regardless of hit/miss.
      const result: DualPistolResult = dualPistolShoot(
        gameInput,
        localController,
        remoteController,
        scene,
      );
      frameCombatEvents.push({
        frame: advanced.frame,
        // PR 11.7.D2 / §3.10 fix: combat event kind reflects whether
        // the raycast actually hit the peer (`fire_hit`) vs a prop
        // (`fire_miss` — includes crate hits, which used to register
        // as `fire_hit` but did 0 damage). The visual tracer still
        // draws for any hit (the kind affects HUD combat-event labels).
        kind: result.hitTarget === "remote" ? "fire_hit" : "fire_miss",
        tracerFrom: result.tracerFrom,
        tracerTo: result.tracerTo,
        damage: result.damage,
      });
    }
    if (gameInput.meleePressed && !wasMelee) {
      const result: MeleeResult = meleeSwing(
        gameInput,
        localController,
        remoteController,
      );
      if (result.hit) {
        frameCombatEvents.push({
          frame: advanced.frame,
          kind: "melee_hit",
          damage: result.damage,
        });
        // PR #59 / §3.5: PR is FIRE-ONLY. The 0x01 DamageRequest
        // wire type is REMOVED in PR #59; melee has no AimEvent
        // equivalent yet (Phase 2 melee work adds a 0x0B
        // MeleeEvent discriminator if needed). When the server-auth
        // transport is wired, melee damage falls back to local-
        // compute (applyDamage on the remote controller). The
        // brief explicitly says melee is out of scope; this is
        // the best-effort backward-compat path for the PR #59
        // window.
        applyDamage(remoteController, { source: "melee", amount: result.damage }, nowMs);
      }
    }
    wasFiring = gameInput.fireHeld;
    wasMelee = input.meleePressed;

    // PR 10: symmetric damage flow on the REMOTE input. Both clients run
    // the same lockstep, so this runs identically on both ends — the
    // local controller's HP drops by the same amount on the same frame
    // on both clients (no out-of-sync). The remote-fired raycast/melee
    // uses the same `dualPistolShoot` / `meleeSwing` helpers — the
    // helpers take the *firing* controller as the source and the *other*
    // as the target, which lines up exactly with what we want here.
    // PR 11.7.D2 / §3.10 — remote-fire / remote-melee BLOCK REMOVED.
    // Pre-D2.2 the lockstep peer's input flowed through
    // `remoteDecoded`; if `remoteDecoded.fireHeld` (rising-edge
    // tracked via `wasRemoteFiring`) we raycast from the remote
    // rig at the local rig and apply damage locally. Post-D2.2
    // there is no remote input in the lockstep sense (the stub
    // returns zeros); the remote fire / melee damage arrives via
    // the server DamageRequest flow (the other tab sent the
    // request, the server validated + applied HP, and the snapshot
    // fan-out carries the new HP to both tabs at 20Hz). The
    // `wasRemoteFiring` / `wasRemoteMelee` trackers are gone.


    // PR 10: tick the respawn timer for both controllers every frame.
    // The teleport fires on the first frame where `nowMs >=
    // respawningUntilMs`, which both clients reach on the same frame
    // because their `nowMs` values are both engine-driven.
    tickRespawn(localController, nowMs);
    tickRespawn(remoteController, nowMs);

    // PR 11.6.D / §3.10 — 32Hz PositionUpdate sender. Only fires when
    // the server-auth transport is wired (P2P smokes don't speak the
    // server wire format). The throttled helper gates on
    // `advanced.frame % 2 === 0` internally, so the actual wire rate
    // is ~32Hz at the engine's ~64Hz tick rate.
    if (serverTransport) {
      const pos = localController.state.position;
      dbSendPositionUpdateThrottled(
        serverTransport,
        advanced.frame,
        localPlayerId,
        pos.x,
        pos.z,
      );
      // PR 11.7.D2.1 / debug — count actual PositionUpdate sends.
      if (typeof window !== "undefined") {
        (window as unknown as { __positionUpdateSends?: number }).__positionUpdateSends =
          ((window as unknown as { __positionUpdateSends?: number }).__positionUpdateSends ?? 0) + 1;
      }
    } else if (typeof window !== "undefined") {
      (window as unknown as { __positionUpdateSkips?: number }).__positionUpdateSkips =
        ((window as unknown as { __positionUpdateSkips?: number }).__positionUpdateSkips ?? 0) + 1;
    }

    // Push the per-frame events onto the session-level buffer so the HUD
    // and tracer render can read them.
    for (const ev of frameCombatEvents) combatEvents.push(ev);

    // 6. Apply stunt pose (visual lean/squash) on each rig. The controllers
    //    already push their world-space transform into the visualRoots
    //    (`visualRoot.position.copyFrom(pos)` and `rotationQuaternion = state.rotation`
    //    inside CharacterController.update), so no extra transform sync needed.
    applyLocalPose();
    applyRemotePose();

    return {
      frame: advanced.frame,
      localInput: localDecoded,
      remoteInput: remoteDecoded,
      remoteConfirmed: advanced.remoteConfirmed,
      combatEvents: frameCombatEvents,
    };
  };

  // PR 11.6.B / §1.2 seam — see the interface comment for the rationale.
  // Today this goes through the lockstep substrate (`ggrsRuntime`).
  // PR 11.7 retires lockstep and routes the same encoded input to
  // `serverTransport` instead; only this method changes.
  //
  // PR 65 — §1.2 seam is now LIVE. `submitLocalInput(input)` encodes
  // the input ONCE (`encodedInput`), then routes it to BOTH the
  // lockstep substrate (so peer / smoke can read it via
  // `runtime.lastSubmittedInput`) AND the serverTransport via a
  // typed `InputsServer` packet. The server feeds the encoded bits
  // into the per-room `inputs_buffer` keyed by `frame`, and applies
  // the snapshot's yaw/pitch + position fields from the latest
  // InputsServer (this is what populates `room.players[id].yaw_radians`
  // and `.pitch_radians` so the snapshot fan-out carries live values).
  //
  // The `lastInputsSeq` counter increments once per packet; server
  // uses it for replay protection (drops packets whose seq is
  // older than the last-seen seq for the source).
  //
  // This is a no-op when `serverTransport === null` (no snapshot
  // stream connected — legacy lockstep-only path).
  let lastInputsSeqLocal = 0;
  let inputsSeqSendPending: { encodedInput: Uint8Array; frame: number } | null = null;
  const submitLocalInput = (input: InputState): void => {
    const encoded = encodeInput(input);
    runtime.submitLocalInput(encoded);
    // Queue the InputsServer send — we need the `advanced.frame` to
    // match, which we don't have until after `advanceFrame()` below.
    // We stash the encoded bytes + the post-advance frame here; the
    // actual `dbSendInputsServer(...)` call runs at the end of tick()
    // once we know the frame number.
    inputsSeqSendPending = { encodedInput: encoded, frame: 0 };
  };
  // PR 65 — flush the pending InputsServer after `runtime.advanceFrame`
  // returns the just-stepped frame. Called from `tick()` once we have
  // `advanced.frame`.
  const flushInputsServer = (advancedFrame: number): void => {
    if (inputsSeqSendPending && serverTransport) {
      const pending = inputsSeqSendPending;
      inputsSeqSendPending = null;
      lastInputsSeqLocal = (lastInputsSeqLocal + 1) >>> 0;  // wrap to u32
      // PR 65 — also align the InputsServer's `frame` with the
      // server's authoritative clock (see AimEvent patch above).
      // Without this, the replay-protection map rejects packets
      // because the seq advances but the frame doesn't match what
      // the snapshot expected.
      const snap = (window as Window & { __latestSnap?: () => unknown }).__latestSnap?.() as { serverFrame?: number } | null;
      const snapFrame = snap?.serverFrame ?? 0;
      const localDelta = advancedFrame - lastSnapshotFrameSeen;
      const alignedFrame = Math.max(snapFrame, snapFrame + localDelta - 16);
      lastSnapshotFrameSeen = snapFrame;
      dbSendInputsServer(serverTransport, {
        frame: alignedFrame,
        encodedInput: pending.encodedInput,
        lastInputsSeq: lastInputsSeqLocal,
      });
    } else {
      inputsSeqSendPending = null;
    }
  };
  // PR 11.7.C / §3.7 — late-bound predictor reference. `null` by
  // default; scene.ts sets it once the snapshot transport is connected.
  let predictor: import("../engine/clientPredictor").Predictor | null = null;

  return {
    localController,
    remoteController,
    localModel,
    remoteModel: remote.model,
    runtime,
    get frame() { return runtime.frame; },
    get latestConfirmedFrame() { return runtime.latestConfirmedFrame; },
    get repeatedFrameCount() { return runtime.repeatedFrameCount; },
    // PR 11.5: pass-through the runtime's pause counters. The HUD chip
    // wiring is a follow-up PR — exposed here so the chip can be added
    // without touching the runtime or the session handle shape.
    get pausedFrames() { return runtime.pausedFrames; },
    get totalPausedFrameCount() { return runtime.totalPausedFrameCount; },
    tick,
    submitLocalInput,
    // PR 11.6.D FIX 2: expose the local + peer player ids on the
    // returned handle. The smoke uses these to assert the right tab
    // is sending fire events to the right target. Both are
    // immutable for the session's lifetime.
    localPlayerId,
    peerPlayerId,
    // PR 11.6.D: late-bind server-auth transport. Defaults to the
    // constructor option (may be `null` for P2P smokes).
    setServerTransport: (t) => {
      serverTransport = t;
    },
    // PR 11.7.C / §3.7 — late-bind the predictor. Called by scene.ts
    // once the snapshot transport is connected. See the interface
    // comment above for rationale.
    setPredictor: (p) => {
      predictor = p;
    },
    getCombatEvents: () => combatEvents.slice(),
    consumeUnrenderedCombatEvents: () => {
      const drain = combatEvents.slice(lastRenderedIdx);
      lastRenderedIdx = combatEvents.length;
      return drain;
    },
    getHealthSnapshot: (): HealthSnapshot => ({
      local: {
        hp: localController.state.hp,
        // Convert the absolute respawning-until timestamp to a remaining
        // countdown for the HUD. Clamped at 0 — past-deadline renders 0
        // (teleport fires this frame). `lastNowMs` was captured inside
        // the last `tick()`; same value the tick uses to fire the teleport.
        respawningMs:
          localController.state.respawningUntilMs > 0
            ? Math.max(0, localController.state.respawningUntilMs - lastNowMs)
            : 0,
      },
      remote: {
        hp: remoteController.state.hp,
        respawningMs:
          remoteController.state.respawningUntilMs > 0
            ? Math.max(0, remoteController.state.respawningUntilMs - lastNowMs)
            : 0,
      },
    }),
    /**
     * PR 11.4: scene.ts calls this on F2 toggle. Skips both
     * `controller.update()` calls + combat semantics while active.
     * The chase camera still runs its `update()` (so reattaching
     * after F2-off is seamless), but the characters freeze in place.
     */
    // PR 11.4: dev-only spectator gate on both controllers. Attached
    // to the returned handle ONLY in DEV — in production the spread
    // resolves to `{}` and the property is omitted entirely. The
    // `spectatorActive` flag stays false in production (default),
    // so `if (!spectatorActive)` always passes and the controllers
    // update normally.
    ...(import.meta.env.DEV
      ? {
        setSpectatorActive: (active: boolean) => {
          spectatorActive = active;
        },
      }
      : {}),
    // PR 11.7.E / §3.5 — start a reload on R-press. Gates on
    // alive + ammo<max + not-already-reloading + server-transport-connected.
    // No pointer-lock check here — the inputListener already gates
    // on that (the editable-target + !repeat + key event already
    // arrives only when the canvas has focus, which is implied
    // by pointer-locked-on-canvas).
    tryStartReload: (): void => {
      if (!serverTransport) return;
      // Already reloading? Ignore (the keypress guard).
      if (reloadingUntilMs !== null) return;
      // Dead? The snapshot's HP is the source of truth, but the
      // local controller's state.hp mirrors it within one tick —
      // if the server's last snapshot had hp=0 for us, the
      // local controller shows hp=0 too. Use the local controller
      // for the gate to avoid an extra snapshot lookup per R-press.
      if (localController.state.hp <= 0) return;
      // Magazine full? Check via the controller's mirrored ammo
      // (the local controller doesn't carry ammo — only the
      // snapshot does). Read the latest snapshot via __latestSnap
      // when available; fall back to "allow reload" when no
      // snapshot has arrived yet (the first reload after connect).
      const snap = typeof window !== "undefined"
        ? (window as unknown as {__latestSnap?: () => { players: Array<{ playerId: number; ammo: number }> } | null}).__latestSnap?.() ?? null
        : null;
      const localSnapPlayer = snap?.players.find((p) => p.playerId === localPlayerId);
            // No-op if the local player's magazine is already full. The
      // server enforces the same gate authoritatively (gate 4 in
      // validate_and_relay_reload: ammo<max). Uses PLAYER_MAX_AMMO
      // from `client/src/engine/characterConfig.ts` (the client mirror
      // of `server/src/constants.rs::PLAYER_MAX_AMMO`).
      if (localSnapPlayer && localSnapPlayer.ammo >= PLAYER_MAX_AMMO) return;
      const eventId = dbNextReloadEventId();
      const now = performance.now();
      reloadingUntilMs = now + COMBAT.dualPistol.reloadMs;
      dbSendReloadRequest(serverTransport, { playerId: localPlayerId, eventId });
    },
    getReloadingUntilMs: (): number | null => reloadingUntilMs,
    /**
     * DEV-only — scene.ts's `onSnapshot` listener calls this when
     * the snapshot reports `local ammo === PLAYER_MAX_AMMO`. Clears
     * `reloadingUntilMs` so the HUD's reload bar disappears.
     * Not on the public probe surface; it's an internal hook.
     */
    ...(import.meta.env.DEV
      ? {
        _clearReloadingUntilMs: () => {
          reloadingUntilMs = null;
        },
      }
      : {}),
    /**
     * PR 11.7.E / §3.5 — DEV probe: send a ReloadRequest directly
     * (smoke-only — production bundles omit this via the
     * `import.meta.env.DEV` gate).
     */
    ...(import.meta.env.DEV
      ? {
        sendReloadRequest: (playerId: number, eventId: number): number => {
          if (!serverTransport) return -1;
          dbSendReloadRequest(serverTransport, { playerId, eventId });
          return eventId;
        },
      }
      : {}),
    dispose: () => {
      runtime.dispose();
      localModel.dispose();
      remote.dispose();
    },
  };
}
