// Phase 0 / PR 4 — GameSession: the per-frame tick that turns local input +
// peer input into BOTH characters' Havok controllers in lockstep.
//
// **What this is**: the orchestrator that bridges the existing PR 3 stack
// (InputListener + CharacterController + procedural humanoid + chase camera)
// with the new PR 4 netcode substrate (LockstepRuntime over WebRTC). This is
// *not* a game-logic layer — combat, bullet time, scoring, etc. land in PR 5.
// The job here is just "read both inputs, step both physics, render both
// characters."
//
// **Determinism rule (SPEC §"Determinism rule")**: the tick receives
// `deltaSeconds` + `nowMs` from the engine's frame observer and never reads
// `Date.now()` / `performance.now()`. Both clients run the same physics step
// with the same two inputs, so Havok lands on identical results on both ends
// (modulo float-rounding quirks we accept for the feel test — documented in
// the PR body and the SPEC decisions block).
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

  /**
   * One tick: encode local input → submit → advance → apply decoded inputs to
   * both controllers → update rig poses (stunt visual lean/squash).
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

    // 3. Step both Havok controllers with their respective inputs.
    //    Same physics, same timestep, same inputs ⇒ same world, modulo the
    //    documented Havok float-rounding acknowledgements.
    localController.update(localDecoded, deltaSeconds, nowMs);
    remoteController.update(remoteDecoded, deltaSeconds, nowMs);

    // 4. Apply stunt pose (visual lean/squash) on each rig. The controllers
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
    dispose: () => {
      runtime.dispose();
      localModel.dispose();
      remote.dispose();
    },
  };
}
