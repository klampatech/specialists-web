// Phase 0 / PR 4+7 — GameSession: per-frame tick that turns local + peer
// inputs into BOTH characters' Havok controllers in lockstep, plus the
// PR 7 combat semantics layer on top.
//
// **What this is**: the orchestrator that bridges the existing PR 3 stack
// (InputListener + CharacterController + procedural humanoid + chase camera)
// with the new PR 4 netcode substrate (LockstepRuntime over WebRTC) and the
// PR 7 combat layer (dual-pistol raycast + melee cone hit + per-client
// bullet-time scaling).
//
// **Determinism rule (SPEC §"Determinism rule")**: the tick receives
// `deltaSeconds` + `nowMs` from the engine's frame observer and never reads
// `Date.now()` / `performance.now()`. Both clients run the same physics step
// with the same two inputs, so Havok lands on identical results on both ends
// (modulo float-rounding quirks we accept for the feel test — documented in
// the PR body and the SPEC decisions block).
//
// **Combat semantics (PR 7)**:
//   - On the rising edge of `fireHeld` (false→true), cast a ray from the
//     local chest height along yaw-forward. The result becomes a
//     `CombatEvent` with `kind: 'fire_hit' | 'fire_miss'` and tracer
//     endpoints. The scene's render observer then calls `renderTracer`
//     for each event.
//   - On the rising edge of `meleePressed`, do the cone-vs-position check
//     using `meleeSwing`. Only emit a `CombatEvent` on a hit (a miss is
//     silent — no animation, no event).
//   - Bullet time is per-client LOCAL: when `input.bulletTimeHeld` is true,
//     the LOCAL controller receives a scaled dt (`* COMBAT.bulletTime.scale
//     = 0.25`). The REMOTE controller always receives the unscaled dt —
//     bullet time is not on the wire.
//
// **Combat events**: kept in a module-scoped array on the GameSession so
// the HUD chip and the scene's tracer render can poll without touching
// the tick's hot path. `getCombatEvents()` returns the full history (HUD
// counts `length`); `consumeUnrenderedCombatEvents()` returns the slice
// since the last consume and advances the internal cursor (the scene
// render observer calls this each frame to know which new tracers to
// draw).
//
// **Rising-edge correctness**: `wasFiring` / `wasMelee` track the
// previously-seen input. Each tick sets them to the *current* input value
// (not just on the rising edge), so a release-then-press pair registers
// correctly. `meleePressed` is cleared by the inputListener on read()
// so it's true for exactly one frame per RMB press.
//
// **Health & respawn (PR 10)**: damage application lives in
// `game/health.ts`. On each rising-edge combat event we call
// `applyDamage(opponent, ...)`; both controllers' respawn timers are
// ticked every frame via `tickRespawn`. `wasRemoteFiring` /
// `wasRemoteMelee` mirror the local trackers so the same damage flow
// runs for the peer player's input. Both clients compute identical
// damage events from identical inputs (lockstep), apply them to the
// opponent locally, and teleport to spawn at the same `nowMs`.
//
// **Two-character scene**: we have *one* Havok controller per rig. Each tab
// runs both controllers — local receives the tab's own encoded input, remote
// receives whatever the peer's `LockstepRuntime` has for that frame. Both
// characters are visible from frame 0; the remote stays at its spawn until
// the peer actually sends inputs.
//
// **PR 11.5 — pause-and-wait gate**: when the `LockstepRuntime` cap fires
// (local frame more than `MAX_PREDICTION_FRAMES` ahead of the peer), the
// runtime returns a sentinel `{paused: true, ...}` frame. We short-circuit
// out of the tick before updating either controller, running combat, or
// ticking respawn timers. The wire encoder already ran (submitLocalInput
// fires before advanceFrame), so the peer keeps receiving our packets and
// will eventually catch up. Once the runtime unpauses, both clients
// resume from the same frame on the same tick — guaranteed-deterministic
// resume. See `docs/SPEC.md` PR 11.5 decisions log for the full rationale.

import { type Scene, Vector3 } from "@babylonjs/core";

import { CAPSULE } from "../engine/characterConfig";
import { createCharacterController, type CharacterController, type InputState } from "../engine/characterController";
import { attachPoseUpdater, createCharacterModel } from "../engine/characterModel";
import { decodeInput, encodeInput } from "../net/inputBitmask";
import { LockstepRuntime } from "../net/ggrsRuntime";
import type { GgnetTransport } from "../net/ggnet";
import { createRemotePlayer } from "./remotePlayer";
import {
  bulletTimeScale,
  dualPistolShoot,
  meleeSwing,
  type DualPistolResult,
  type MeleeResult,
} from "./combat";
import { applyDamage, tickRespawn, type HealthSnapshot } from "./health";

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
  readonly runtime: LockstepRuntime;
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
  /** All combat events ever generated this session (HUD reads `length`). */
  getCombatEvents(): CombatEvent[];
  /** Drain the combat events since the last call; the tracer render uses
   *  this so each event triggers exactly one tracer line. */
  consumeUnrenderedCombatEvents(): CombatEvent[];
  /** PR 10: snapshot of both controllers' HP + respawn timer for the HUD. */
  getHealthSnapshot(): HealthSnapshot;
  /**
   * PR 11.4: scene.ts calls this on F2 toggle. When `active === true`,
   * BOTH controllers' per-tick `update()` is skipped (the spectator
   * camera has absorbed the WASD keys; the character shouldn't move).
   * Combat events are gated the same way — no F2-during-spectator fire.
   * DEV-only in practice (production bundles omit this method entirely).
   */
  setSpectatorActive?: (active: boolean) => void;
  /** Tear down both rigs + the runtime. */
  dispose(): void;
}

/** Where the remote capsule spawns. Offset from the local spawn so both are
 *  visible from frame 0 — to the right of the local rig. */
const REMOTE_SPAWN_OFFSET = new Vector3(2.5, 0, 0);

/**
 * Build a 2-player GameSession for the given scene + transport.
 *
 * The local rig spawns at the standard spawn point (`CAPSULE.height/2` above
 * origin). The remote rig spawns 2.5m to the right (local +X). Both controllers
 * tick every frame regardless of connection state — disconnected-peer inputs
 * repeat the last known remote input, by design (see the lockstep module
 * header for the honest-limitations note).
 */
export function createGameSession(
  scene: Scene,
  transport: GgnetTransport,
): GameSession {
  const localSpawn = new Vector3(0, CAPSULE.height / 2, 0);
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
  const runtime = new LockstepRuntime(transport);

  // ---- PR 7: combat event buffer + rising-edge trackers ----------------------
  /** All combat events emitted by this session. The HUD reads `length`. */
  const combatEvents: CombatEvent[] = [];
  /** Cursor: index in `combatEvents` already consumed by the tracer render. */
  let lastRenderedIdx = 0;
  /** Previous `input.fireHeld` value — tracks rising edges. */
  let wasFiring = false;
  /** Previous `input.meleePressed` value — tracks rising edges. */
  let wasMelee = false;
  /** PR 10: same trackers for the REMOTE input — symmetric damage flow. */
  let wasRemoteFiring = false;
  let wasRemoteMelee = false;
  /** PR 10: cached `nowMs` from the last tick — used to compute the
   *  remaining respawn countdown for the HUD snapshot. Updated every
   *  tick; read by `getHealthSnapshot()`. */
  let lastNowMs = 0;
  /**
   * PR 11.4: when true, BOTH controllers skip their per-tick
   * `update()` call (the spectator camera has absorbed the WASD keys,
   * so neither character should move). Set by `setSpectatorActive` from
   * scene.ts on F2 toggle. Default false (no spectator effect).
   */
  let spectatorActive = false;

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
    const encodedLocal = encodeInput(gameInput);
    runtime.submitLocalInput(encodedLocal);
    const advanced = runtime.advanceFrame();

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
    // PR 11.4: gate both controller updates on `!spectatorActive`. When
    // the spectator is free-flying, the character controller shouldn't
    // see any movement (WASD absorbed by the spectator, no character
    // velocity). Combat events also gated — no F2-during-spectator fire.
    if (!spectatorActive) {
      localController.update(localDecoded, scaledDt, nowMs);
      remoteController.update(remoteDecoded, deltaSeconds, nowMs);
    }

    // 5. PR 7: rising-edge combat semantics on the local input.
    // PR 11.4.1: use `gameInput` (sanitized copy) instead of raw `input`
    // — when spectator is active, `fireHeld` / `meleePressed` are forced
    // to false, suppressing both the local tracer fire and the wire
    // payload that would have told the peer you fired.
    const frameCombatEvents: CombatEvent[] = [];
    if (gameInput.fireHeld && !wasFiring) {
      const result: DualPistolResult = dualPistolShoot(
        gameInput,
        localController,
        remoteController,
        scene,
      );
      frameCombatEvents.push({
        frame: advanced.frame,
        kind: result.hit ? "fire_hit" : "fire_miss",
        tracerFrom: result.tracerFrom,
        tracerTo: result.tracerTo,
        damage: result.damage,
      });
      // PR 10: local fired → remote takes the damage (lockstep
      // guarantees identical events on both clients).
      if (result.hit) {
        applyDamage(remoteController, { source: "fire", amount: result.damage }, nowMs);
      }
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
        // PR 10: melee hit also applies damage to the remote rig.
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
    if (remoteDecoded.fireHeld && !wasRemoteFiring) {
      const result: DualPistolResult = dualPistolShoot(
        remoteDecoded,
        remoteController,
        localController,
        scene,
      );
      if (result.hit) {
        applyDamage(localController, { source: "fire", amount: result.damage }, nowMs);
      }
    }
    if (remoteDecoded.meleePressed && !wasRemoteMelee) {
      const result: MeleeResult = meleeSwing(
        remoteDecoded,
        remoteController,
        localController,
      );
      if (result.hit) {
        applyDamage(localController, { source: "melee", amount: result.damage }, nowMs);
      }
    }
    wasRemoteFiring = remoteDecoded.fireHeld;
    wasRemoteMelee = remoteDecoded.meleePressed;

    // PR 10: tick the respawn timer for both controllers every frame.
    // The teleport fires on the first frame where `nowMs >=
    // respawningUntilMs`, which both clients reach on the same frame
    // because their `nowMs` values are both engine-driven.
    tickRespawn(localController, nowMs);
    tickRespawn(remoteController, nowMs);

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
    dispose: () => {
      runtime.dispose();
      localModel.dispose();
      remote.dispose();
    },
  };
}
