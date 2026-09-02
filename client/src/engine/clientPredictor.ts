// PR 11.7.C / §3.7 — client-side input prediction + state reconciliation.
//
// **The CS2/Valorant shape (per docs/PR-11.6-plan.md §1.2)**: server is the
// source of truth for movement, but the LOCAL player predicts forward
// using locally-buffered inputs (zero perceived latency). On every
// server Snapshot, the predictor compares predicted vs. authoritative
// state; if drift > `RECONCILIATION_THRESHOLD_M`, re-simulates forward
// from `lastServerFrame` using the buffered inputs. If the resulting
// snap would teleport the player > `MAX_RECONCILIATION_SNAP_DISTANCE_M`,
// hard-snap to server position + drop buffered inputs (the buffer is
// drained beyond the point where re-simulation makes physical sense).
//
// **Constants source**: the constants below are now IMPORTED from
// `protocol/constants.ts` (PR 11.7.D2 / §1.2). Before D2 the
// constants were a MIRROR of `server/src/constants.rs` (PR 11.7.B),
// inlined per-module. PR 11.7.D2.1 extracted the canonical
// `protocol/constants.ts`; this file dropped the inlined copies
// and imports from the canonical source.
//
// **Havok step**: the predictor wraps (does not duplicate) the existing
// `characterController.tick(planarVelocity)` Havok step. The constructor
// takes a `havokStep` function injected from the scene-side wiring — a
// thin wrapper that advances the controller by one input. Vitest tests
// pass a mock that returns a `PlayerState` advanced by a known delta,
// keeping the predictor testable in Node (no Babylon/Havok dependency).
//
// **Local frame vs. server frame (important!)**:
//   - `localFrame` (client space): monotonic counter tracked in
//     `gameSession.frame` (PR 11.6.B §1.2 seam). Used as the key for
//     the local input buffer.
//   - `serverFrame` (server space): the server's tick counter, carried
//     in the wire Snapshot. Used as ack cadence (`lastServerFrame`).
//   - These two counters are in DIFFERENT numeric spaces — the server
//     runs at 64Hz, the client at 60Hz, and they start at the same
//     approximate time but drift over wall time. The predictor's drain
//     window is `(reconcileFromFrame, currentLocalFrame]`, BOTH in
//     client space. The serverFrame is only used for ack tracking.
//   - `reconcileFromFrame` tracks the LATEST client frame we've
//     predicted through (initially -1 = "no prediction yet"). After a
//     snapshot, it advances to `getLocalFrame()` so the next tick()
//     only drains inputs recorded AFTER the snapshot.

import type { Snapshot, PlayerState } from "../../../protocol/snapshot";
import {
  MAX_RECONCILIATION_SNAP_DISTANCE_M,
  RECONCILIATION_THRESHOLD_M,
} from "../../../protocol/constants";

// -- Constants (canonical — sourced from protocol/constants.ts) ---
//
// PR 11.7.D2 / §1.2: SNAPSHOT_RATE_HZ / RECONCILIATION_THRESHOLD_M /
// MAX_RECONCILIATION_SNAP_DISTANCE_M MOVED to `protocol/constants.ts`
// (the canonical source for both client + server; the TS module was
// extracted in PR 11.7.D2.1). The previous mirror-of-server/constants.rs
// inlined copies are gone — these names now come straight from the
// canonical import above. The re-export at the bottom of this file
// is also removed; importers should reach into
// `protocol/constants.ts` directly.

/** PR 11.7.C — max number of inputs to retain in the per-frame buffer.
 *  FIFO eviction when over. The cap exists so a runaway buffer can't
 *  OOM the browser — 16 frames is ~267ms of replay at 60Hz, which
 *  covers the worst-case snapshot latency without bloating memory. */
const MAX_LOCAL_INPUT_BUFFER = 16;

/** PR 11.7.C — eviction retention window (frames). The brief says
 *  "evict oldest past `lastServerFrame - 8`" but `localFrame` and
 *  `serverFrame` are in different numeric spaces. We anchor the
 *  retention to the LAST RECONCILED CLIENT FRAME (also known as
 *  `reconcileFromFrame`): the buffer is meant for client-side
 *  re-simulation, so its retention is in client space. `INPUT_BUFFER_RETENTION_FRAMES`
 *  is the number of frames back from `reconcileFromFrame` that we
 *  still keep — same semantic as the brief's `lastServerFrame - 8`
 *  (keep the most recent ~8 frames of replay). */
const INPUT_BUFFER_RETENTION_FRAMES = 8;

/** Havok-step wrapper signature. **NOT pure** in the strict sense —
 *  the wrapper advances the LIVE Havok controller by one frame, reads
 *  the post-update state, then RESTORES the controller to its prior
 *  position+velocity (a "phantom" simulation: temporarily step
 *  physics, capture the result, then revert). The `state` arg is
 *  unused (kept in the signature for forward-compat with a future
 *  pure-physics port + for the test mock which doesn't need it).
 *
 *  This save/restore pattern was picked over (a) a phantom-Havok
 *  controller (expensive: one full PhysicsCharacterController per
 *  drained input) and (b) a refactor that makes the predictor own
 *  the Havok advance (conflicts with the §1.2 seam — `gameSession.tick()`
 *  already advances the controller). Save/restore is O(1) per call
 *  and matches §3.7's "wraps, doesn't duplicate" framing: the live
 *  controller is unchanged after the wrapper returns, but the
 *  wrapper reports the state Havok WOULD have reached if the input
 *  had been applied.
 *
 *  The test mock (`mockHavokStep` in clientPredictor.test.ts) bypasses
 *  the save/restore entirely — it just returns `state + (1, 0)`. The
 *  mock is fine for testing the predictor's pure bookkeeping (drift
 *  detection, reconciliation flow, eviction policy) but does NOT
 *  model the save/restore side effect on the live controller. That's
 *  by design — the save/restore is the scene's responsibility, not
 *  the predictor's.
 *
 *  Injected by the scene-side wiring so the predictor is testable
 *  without the Babylon/Havok runtime. */
export type HavokStepFn = (
  state: PlayerState,
  input: Uint8Array,
) => PlayerState;

/** Source of the current local frame counter (gameSession.frame). */
export type GetLocalFrameFn = () => number;

/** Stats reported by `getStats()` — surfaced on `window.__predictor`
 *  in DEV for smoke-level instrumentation. */
export interface PredictorStats {
  reconciliationCount: number;
  lastDriftM: number;
  lastSnapDistanceM: number;
  /** Number of buffered inputs at present (after eviction). */
  bufferDepth: number;
  /** Last server frame we've reconciled against. -1 = no snapshot yet. */
  lastServerFrame: number;
}

/** Per-frame snapshot of `predictedState` (read accessor). */
export interface PredictedState extends PlayerState {
  /** The frame this predicted state is "for" — used by the
   *  scene-side render observer to know when the state is stale.
   *  Defaults to -1 (no prediction yet). */
  frame: number;
}

/** Compute 2D distance between two `PlayerState`s (XZ plane). */
function distanceXZ(a: {positionX: number; positionY: number}, b: {positionX: number; positionY: number}): number {
  const dx = a.positionX - b.positionX;
  const dy = a.positionY - b.positionY;
  return Math.hypot(dx, dy);
}

/** PR 11.7.C / §3.7 — client-side input prediction + state
 *  reconciliation. Consumes 20Hz `Snapshot`s from the server, predicts
 *  the local player's movement forward between snapshots, and snaps +
 *  re-simulates when drift exceeds the threshold. */
export class Predictor {
  private readonly localPlayerId: number;
  private readonly havokStep: HavokStepFn;
  private readonly getLocalFrame: GetLocalFrameFn;

  /** Buffered local inputs keyed by localFrame. Eviction policy:
   *  retention window from `reconcileFromFrame` + hard cap at
   *  `MAX_LOCAL_INPUT_BUFFER`. */
  private readonly localInputs: Map<number, Uint8Array> = new Map();

  /** Last server frame we've reconciled against. -1 = no snapshot
   *  received yet (predictor is uninitialized). Tracked for ack
   *  cadence (PR 11.7.D's `0x08 StateAck` packet). */
  private lastServerFrame = -1;

  /** LATEST local frame we've predicted through. Initially -1 (no
   *  prediction yet). After the first onSnapshot() (seed), advances
   *  to the snapshot's arrival-time `getLocalFrame()`. After each
   *  subsequent snapshot's reconciliation (and after each tick()),
   *  advances to the current `getLocalFrame()`.
   *
   *  The drain window `(reconcileFromFrame, currentLocalFrame]` is in
   *  CLIENT FRAME SPACE — the buffer is keyed by localFrame, not
   *  serverFrame. The two are different counters (60Hz vs 64Hz). */
  private reconcileFromFrame = -1;

  /** Current predicted state. Mirrors the Havok character controller's
   *  position when in lockstep; advances forward via `havokStep` on
   *  each tick. Assigned in the constructor (after `localPlayerId`
   *  is set). */
  private predictedState!: PredictedState;

  /** State captured just before a reconciliation — used to compute
   *  the snap distance. Reset on every reconciliation (not on every
   *  snapshot). */
  private preSnapState: PlayerState | null = null;

  /** Stats. */
  private reconciliationCount = 0;
  private lastDriftM = 0;
  private lastSnapDistanceM = 0;

  /**
   * @param localPlayerId The local player's server-assigned ID.
   * @param havokStep Wrapper over `characterController.tick` that
   *   advances the predicted state by one `dt`. Injected by scene-side
   *   wiring. Tests pass a mock that returns `PlayerState` advanced by
   *   a known delta.
   * @param getLocalFrame Returns the current local frame counter
   *   (gameSession.frame — monotonic, increments each tick).
   */
  constructor(
    localPlayerId: number,
    havokStep: HavokStepFn,
    getLocalFrame: GetLocalFrameFn,
  ) {
    this.localPlayerId = localPlayerId;
    this.havokStep = havokStep;
    this.getLocalFrame = getLocalFrame;
    // Initial predictedState: zeros with localPlayerId. Replaced by the
    // first onSnapshot() once the server tells us where we are.
    this.predictedState = {
      playerId: localPlayerId,
      positionX: 0,
      positionY: 0,
      velocityX: 0,
      velocityY: 0,
      yaw: 0,
      pitch: 0,
      hp: 100,
      ammo: 0,
      isFiring: 0,
      weaponId: 0,
      currentFireMode: 0,
      frame: -1,
    };
  }

  /**
   * PR 11.7.C / §3.7 — record the local input for the current
   * local frame. Called by gameSession.tick() (alongside the existing
   * `runtime.submitLocalInput(encodeInput(input))` call). The predictor
   * buffers the input so onSnapshot() can re-simulate forward after a
   * reconciliation.
   *
   * Eviction policy: hard cap at `MAX_LOCAL_INPUT_BUFFER` (FIFO) +
   * retention window from `reconcileFromFrame` (in client-frame
   * space). Both run on every `recordLocalInput()` call.
   */
  recordLocalInput(localFrame: number, encoded: Uint8Array): void {
    this.localInputs.set(localFrame, encoded);
    this.evictOldInputs();
  }

  /** Evict entries per the retention + hard-cap policies. */
  private evictOldInputs(): void {
    // Retention: drop entries with key <= retention floor. The floor
    // is in client-frame space (anchored to the last reconciled
    // client frame). Walk keys in insertion order (Map iteration is
    // insertion-ordered); the first key <= floor is the oldest.
    const floor = this.reconcileFromFrame - INPUT_BUFFER_RETENTION_FRAMES;
    if (floor >= 0) {
      for (const key of this.localInputs.keys()) {
        if (key <= floor) {
          this.localInputs.delete(key);
        } else {
          // Insertion order — once we hit one in range, all subsequent
          // ones are also in range.
          break;
        }
      }
    }
    // Hard cap. Eviction is FIFO.
    while (this.localInputs.size > MAX_LOCAL_INPUT_BUFFER) {
      const oldest = this.localInputs.keys().next().value;
      if (oldest === undefined) break;
      this.localInputs.delete(oldest);
    }
  }

  /**
   * PR 11.7.C / §3.7 — per-tick forward prediction. Called by
   * gameSession.tick() (or a render observer — either works; the
   * tick path keeps prediction in lockstep with the controller).
   *
   * Drains buffered inputs for frames `(reconcileFromFrame, currentLocalFrame]`
   * and steps Havok forward once per drained input. Updates
   * `predictedState` in place.
   *
   * **No-op until reconciled**: `reconcileFromFrame === -1` until the
   * first `onSnapshot()` call seeds the state. This avoids predicting
   * from `frame === 0` blindly before the server has told us where we
   * are.
   */
  tick(_nowMs: number): void {
    if (this.reconcileFromFrame < 0) return;
    const currentLocalFrame = this.getLocalFrame();
    // Drain inputs for (reconcileFromFrame, currentLocalFrame].
    for (const [frame, encoded] of [...this.localInputs.entries()]) {
      if (frame > this.reconcileFromFrame && frame <= currentLocalFrame) {
        const next = this.havokStep(this.predictedState, encoded);
        this.predictedState = { ...next, frame };
      }
    }
    // Advance the reconcile-from cursor to the current local frame so
    // next tick() only drains inputs newer than this one.
    this.reconcileFromFrame = currentLocalFrame;
  }

  /**
   * PR 11.7.C / §3.7 — handle a server Snapshot. Compare the
   * snapshot's local-player entry to the predicted state; if drift
   * exceeds the threshold, re-simulate forward from the snapshot's
   * authoritative position using buffered inputs.
   *
   * **Always advances `lastServerFrame`** — even when drift is
   * sub-threshold. The server is the source of truth; we want our
   * `lastServerFrame` cursor to track the latest snapshot regardless
   * of whether reconciliation fires.
   *
   * **Note on yaw/pitch**: PR 11.7.B's snapshot wire has yaw/pitch = 0
   * for all players (`server/src/snapshot.rs` line 111-112). The
   * predictor therefore can't reconcile yaw/pitch this PR; the scene
   * continues to drive yaw/pitch from the local Havok controller. PR
   * 11.7.E wires remote yaw/pitch on the wire; this PR documents the
   * gap and moves on.
   */
  onSnapshot(snap: Snapshot, _nowMs: number): void {
    const localInSnapshot = snap.players.find(
      (p) => p.playerId === this.localPlayerId,
    );
    if (!localInSnapshot) {
      // Snapshot didn't include us (we just connected, or the server
      // hasn't seen our first PositionUpdate yet). Don't advance
      // lastServerFrame — the next snapshot should include us.
      return;
    }

    // First snapshot: seed the predictor state. No drift yet (we
    // start from the server's authoritative position). Set
    // reconcileFromFrame to the current local frame so the next
    // tick() drains every input recorded since the snapshot.
    if (this.lastServerFrame < 0) {
      this.predictedState = {
        ...localInSnapshot,
        frame: snap.serverFrame,
      };
      this.lastServerFrame = snap.serverFrame;
      this.reconcileFromFrame = this.getLocalFrame();
      return;
    }

    // Drift check.
    const drift = distanceXZ(this.predictedState, localInSnapshot);
    this.lastDriftM = drift;

    if (drift > RECONCILIATION_THRESHOLD_M) {
      // Capture pre-snap state for snap-distance computation.
      this.preSnapState = { ...this.predictedState };

      // Re-simulate forward from the snapshot's authoritative state.
      this.predictedState = {
        ...localInSnapshot,
        frame: snap.serverFrame,
      };
      const currentLocalFrame = this.getLocalFrame();
      for (const [frame, encoded] of [...this.localInputs.entries()]) {
        if (frame > this.reconcileFromFrame && frame <= currentLocalFrame) {
          const next = this.havokStep(this.predictedState, encoded);
          this.predictedState = { ...next, frame };
        }
      }

      // Snap distance check. If the re-simulated state is too far from
      // where we were, hard-snap to server position + drop buffered
      // inputs.
      const snapDistance = distanceXZ(this.preSnapState, this.predictedState);
      this.lastSnapDistanceM = snapDistance;
      if (snapDistance > MAX_RECONCILIATION_SNAP_DISTANCE_M) {
        // Hard clamp: snap to snapshot position verbatim, drop the
        // input buffer (it's too drained for re-simulation to be
        // physically meaningful — we'd just be replaying inputs the
        // server already saw + ignored).
        this.predictedState = {
          ...localInSnapshot,
          frame: snap.serverFrame,
        };
        this.localInputs.clear();
      }

      this.reconcileFromFrame = currentLocalFrame;
      this.reconciliationCount += 1;
      this.preSnapState = null;
    }

    this.lastServerFrame = snap.serverFrame;
  }

  /** Read accessor for the predicted state. */
  getPredictedState(): PredictedState {
    return { ...this.predictedState };
  }

  /** Read-only stats for the DEV probe / smoke instrumentation. */
  getStats(): PredictorStats {
    return {
      reconciliationCount: this.reconciliationCount,
      lastDriftM: this.lastDriftM,
      lastSnapDistanceM: this.lastSnapDistanceM,
      bufferDepth: this.localInputs.size,
      lastServerFrame: this.lastServerFrame,
    };
  }
}
