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
// **Two-character scene**: we have *one* Havok controller per rig. Each tab
// runs both controllers — local receives the tab's own encoded input, remote
// receives whatever the peer's `LockstepRuntime` has for that frame. Both
// characters are visible from frame 0; the remote stays at its spawn until
// the peer actually sends inputs.

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
  /** Per-frame tick. Call from `scene.onBeforeRenderObservable`. */
  tick(input: InputState, deltaSeconds: number, nowMs: number): SessionFrame;
  /** All combat events ever generated this session (HUD reads `length`). */
  getCombatEvents(): CombatEvent[];
  /** Drain the combat events since the last call; the tracer render uses
   *  this so each event triggers exactly one tracer line. */
  consumeUnrenderedCombatEvents(): CombatEvent[];
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
  const remote = createRemotePlayer(scene, "remote", remoteSpawn);
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

  /**
   * One tick: encode local input → submit → advance → apply decoded inputs to
   * both controllers → run combat semantics on the local input → update rig
   * poses (stunt visual lean/squash).
   */
  const tick: GameSession["tick"] = (
    input: InputState,
    deltaSeconds: number,
    nowMs: number,
  ): SessionFrame => {
    // 1. Encode + submit local input + advance one frame. The runtime uses
    //    the on-wire remote input if it's already arrived, or repeats the
    //    last-known input otherwise.
    const encodedLocal = encodeInput(input);
    runtime.submitLocalInput(encodedLocal);
    const advanced = runtime.advanceFrame();

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
    localController.update(localDecoded, scaledDt, nowMs);
    remoteController.update(remoteDecoded, deltaSeconds, nowMs);

    // 5. PR 7: rising-edge combat semantics on the local input.
    const frameCombatEvents: CombatEvent[] = [];
    if (input.fireHeld && !wasFiring) {
      const result: DualPistolResult = dualPistolShoot(
        input,
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
    }
    if (input.meleePressed && !wasMelee) {
      const result: MeleeResult = meleeSwing(
        input,
        localController,
        remoteController,
      );
      if (result.hit) {
        frameCombatEvents.push({
          frame: advanced.frame,
          kind: "melee_hit",
          damage: result.damage,
        });
      }
    }
    wasFiring = input.fireHeld;
    wasMelee = input.meleePressed;
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
    tick,
    getCombatEvents: () => combatEvents.slice(),
    consumeUnrenderedCombatEvents: () => {
      const drain = combatEvents.slice(lastRenderedIdx);
      lastRenderedIdx = combatEvents.length;
      return drain;
    },
    dispose: () => {
      runtime.dispose();
      localModel.dispose();
      remote.dispose();
    },
  };
}
