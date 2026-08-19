// PR 11.7.C / §3.8 — remote-player interpolation buffer.
//
// **The CS2/Valorant shape (per docs/PR-11.6-plan.md §1.2 item 6)**:
// remote players are INTERPOLATED, not predicted. Each client keeps a
// 100-150ms buffer of remote-player snapshots and lerps between them
// for smooth visual. LOCAL player is predicted (see clientPredictor.ts);
// remotes are interpolated.
//
// **Constants source**: the numbers below are a MIRROR of
// `server/src/constants.rs` (PR 11.7.B). The PR 11.7.C brief locks the
// decision to NOT extract a `protocol/constants.ts` file in this PR;
// each new module inlines the constants with a `MIRROR of
// server/src/constants.rs` comment. Carry-forward to a later PR.
//
// **Lookback**: `INTERPOLATION_DELAY_MS = 100`. At 20Hz snapshot rate
// that's 2 snapshots of latency — the interpolator renders the
// `targetTime = renderTimestampMs - 100ms` snapshot for each remote
// player. Matches the Valorant default.
//
// **Extrapolation**: when the buffer has < 2 entries (just-connected
// or starved), extrapolate from the latest position + velocity for up
// to `MAX_SNAPSHOT_AGE_MS = 500ms`. Beyond that, the client is too far
// behind and re-syncing the whole state is cheaper than lerping
// through a 500ms gap (the `0x0B StateResyncRequest` wire type is
// PR 11.7.D scope).
//
// **Yaw/pitch on the wire are zero** in PR 11.7.B (per
// `server/src/snapshot.rs` line 111-112: `yaw: 0.0, pitch: 0.0`).
// The interpolator renders yaw/pitch from local Havok state on the
// remote player until PR 11.7.E wires the fire bit + remote
// yaw/pitch. Documented as a known shape gap in the lerpPlayerState
// helper.
//
// **Snapshot vs. bracketing**: each snapshot carries a `serverFrame`
// (NOT a timestamp) — the snapshot wire doesn't carry `serverTimestampMs`
// in PR 11.7.B (per `protocol/snapshot.ts::Snapshot`). The interpolator
// uses `serverFrame` as a monotonic counter and derives the elapsed
// time via `nowMs - latestSnapshotArrivedAtMs` (the wall-clock arrival
// time of the latest snapshot). This keeps the wire format unchanged
// while still supporting extrapolation age tracking.

import type { Snapshot, PlayerState } from "../../../protocol/snapshot";

// -- Constants (MIRROR of server/src/constants.rs) ----------------

/** PR 11.7.B / §3.10 — snapshot broadcast cadence (Hz). */
const SNAPSHOT_RATE_HZ = 20;

/** PR 11.7.B / §3.9 — remote-player interpolation delay (ms). The
 *  client renders remote-player positions from this many ms ago. 100ms
 *  = 2 snapshots at 20Hz. Matches the Valorant default. */
const INTERPOLATION_DELAY_MS = 100;

/** PR 11.7.B / §2.4 — max age of a snapshot the client will accept
 *  without requesting a full-state resync (ms). Beyond this the client
 *  is too far behind and re-syncing is cheaper than lerping through
 *  the gap. */
const MAX_SNAPSHOT_AGE_MS = 500;

/** Ring buffer capacity per remote player. 8 snapshots = 400ms at
 *  20Hz — well over the 100ms interpolation delay + 500ms extrapolation
 *  age, so the buffer never starves in normal play. */
const RING_BUFFER_CAPACITY = 8;

/** Per-player snapshot entry stored in the ring buffer. */
interface BufferedSnapshot {
  /** Snapshot arrival wall-clock (performance.now()). Used to derive
   *  "elapsed time since this snapshot" for extrapolation age checks
   *  and lerp t-value. */
  arrivedAtMs: number;
  /** The Snapshot payload (player entries are 29 bytes each). */
  snapshot: Snapshot;
  /** Per-player entry from this snapshot (precomputed lookup). */
  player: PlayerState;
}

/** Stats reported by `getStats()` — surfaced on `window.__interpolator`
 *  in DEV for smoke-level instrumentation. */
export interface InterpolatorStats {
  /** Per-player buffer depth. */
  perPlayerBufferDepth: Map<number, number>;
  /** Cumulative count of "buffer < 2" extrapolation events. */
  starvationCount: number;
  /** Cumulative count of "snapshot age > MAX_SNAPSHOT_AGE_MS"
   *  extrapolation events (when the latest snapshot is too old to
   *  trust extrapolation). */
  extrapolationCount: number;
}

/** Fixed-capacity ring buffer. Push drops oldest when full. */
class RingBuffer<T> {
  private readonly buf: (T | undefined)[];
  private head = 0;
  private tail = 0;
  private count = 0;

  constructor(capacity: number) {
    this.buf = new Array(capacity);
  }

  push(item: T): void {
    if (this.count === this.buf.length) {
      // Drop oldest.
      this.head = (this.head + 1) % this.buf.length;
      this.count -= 1;
    }
    this.buf[this.tail] = item;
    this.tail = (this.tail + 1) % this.buf.length;
    this.count += 1;
  }

  /** Returns items in insertion order (oldest first). */
  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.count; i++) {
      out.push(this.buf[(this.head + i) % this.buf.length] as T);
    }
    return out;
  }

  size(): number {
    return this.count;
  }

  clear(): void {
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }
}

/** Find the two bracketing snapshots (older, newer) for `targetTime`
 *  (ms since some epoch) in a sorted-by-arrivalTime buffer. Returns
 *  null when the buffer has < 2 entries.
 *
 *  `targetTime` here is a wall-clock arrival time (the time the
 *  interpolator wants the snapshot to be "from"). Returns the two
 *  snapshots whose `arrivedAtMs` straddle `targetTime`.
 *
 *  PR 11.7.C: snapshots don't carry wire timestamps; we use the
 *  wall-clock arrival time (captured by onSnapshot()) as a proxy.
 *  This is good enough for 20Hz broadcast + ~16ms one-way LAN latency;
 *  PR 11.7.E adds wire timestamps if needed. */
function findBracketing(
  buffer: BufferedSnapshot[],
  targetTime: number,
): [BufferedSnapshot, BufferedSnapshot] | null {
  if (buffer.length < 2) return null;
  // Buffer is sorted by arrivedAtMs (insertion order = arrival order).
  // Find the first index where arrivedAtMs > targetTime.
  for (let i = 0; i < buffer.length - 1; i++) {
    if (buffer[i].arrivedAtMs <= targetTime && buffer[i + 1].arrivedAtMs > targetTime) {
      return [buffer[i], buffer[i + 1]];
    }
  }
  // targetTime past the latest snapshot (very fresh render) — use the
  // last two entries as the bracketing pair. Lerp t is clamped >= 1.
  return [buffer[buffer.length - 2], buffer[buffer.length - 1]];
}

/** Lerp a `PlayerState` between two bracketing snapshots by t in [0, 1].
 *  Positions and velocities lerp linearly; yaw/pitch use shortest-arc
 *  lerp (modulo 2π) so a 359° → 1° transition goes through 0° not
 *  358° (the visual would be a snap otherwise).
 *
 *  PR 11.7.B shape gap: yaw/pitch are 0 on the wire in PR 11.7.B. The
 *  yaw/pitch lerp is still mathematically correct when those values
 *  become non-zero in PR 11.7.E; for now it always returns 0. */
function lerpPlayerState(
  older: PlayerState,
  newer: PlayerState,
  t: number,
): PlayerState {
  const lerp = (a: number, b: number) => a + (b - a) * t;
  // Shortest-arc lerp for angles. Wrap diff into [-π, π].
  const TWO_PI = Math.PI * 2;
  let dyaw = newer.yaw - older.yaw;
  if (dyaw > Math.PI) dyaw -= TWO_PI;
  if (dyaw < -Math.PI) dyaw += TWO_PI;
  let dpitch = newer.pitch - older.pitch;
  // Pitch is bounded to [-π/2, +π/2] — no wrap-around possible.
  return {
    playerId: newer.playerId,
    positionX: lerp(older.positionX, newer.positionX),
    positionY: lerp(older.positionY, newer.positionY),
    velocityX: lerp(older.velocityX, newer.velocityX),
    velocityY: lerp(older.velocityY, newer.velocityY),
    yaw: older.yaw + dyaw * t,
    pitch: older.pitch + dpitch * t,
    // Discrete fields: take the NEWER value (HP/ammo/isFiring change
    // at discrete events; interpolating them would be misleading).
    hp: newer.hp,
    ammo: newer.ammo,
    isFiring: newer.isFiring,
  };
}

/** PR 11.7.C / §3.8 — remote-player interpolation buffer. Per-player
 *  ring buffer + render-time lerp + extrapolation fallback. */
export class Interpolator {
  private readonly localPlayerId: number;
  private readonly buffers: Map<number, RingBuffer<BufferedSnapshot>> = new Map();

  /** Per-frame stats counters. Cumulative across the session. */
  private _starvationCount = 0;
  private _extrapolationCount = 0;

  /** PR 11.7.C — wall-clock arrival time of the most recent snapshot,
   *  per remote player. Used for extrapolation age checks. */
  private latestArrivedAtMs: Map<number, number> = new Map();

  /**
   * @param localPlayerId The local player's server-assigned ID. The
   *   local player is excluded from interpolation output (the local
   *   player is predicted, not interpolated).
   */
  constructor(localPlayerId: number) {
    this.localPlayerId = localPlayerId;
  }

  /**
   * PR 11.7.C / §3.8 — handle a server Snapshot. Pushes the snapshot
   * into each remote player's ring buffer. The local player is
   * skipped.
   *
   * `nowMs` is the wall-clock arrival time (typically
   * `performance.now()`). Used for buffer timekeeping — the snapshot
   * wire doesn't carry timestamps in PR 11.7.B.
   */
  onSnapshot(snap: Snapshot, nowMs: number): void {
    for (const player of snap.players) {
      if (player.playerId === this.localPlayerId) continue;
      let buffer = this.buffers.get(player.playerId);
      if (!buffer) {
        buffer = new RingBuffer<BufferedSnapshot>(RING_BUFFER_CAPACITY);
        this.buffers.set(player.playerId, buffer);
      }
      buffer.push({arrivedAtMs: nowMs, snapshot: snap, player});
      this.latestArrivedAtMs.set(player.playerId, nowMs);
    }
  }

  /**
   * PR 11.7.C / §3.8 — return the interpolated state for every remote
   * player at the given render timestamp. The local player is
   * excluded. Each remote's state is either:
   *
   *   (a) Lerped between two bracketing snapshots at
   *       `targetTime = renderTimestampMs - INTERPOLATION_DELAY_MS`.
   *   (b) Extrapolated from the latest snapshot's position + velocity
   *       when the buffer has < 2 entries OR the latest snapshot's
   *       age exceeds `MAX_SNAPSHOT_AGE_MS`.
   *
   * Extrapolation is clamped at `min(elapsed, MAX_SNAPSHOT_AGE_MS) =
   * 500ms` — beyond that we stop extrapolating and return the latest
   * snapshot as-is. The visual will snap but the alternative is
   * drifting into infinity.
   */
  getInterpolatedStates(renderTimestampMs: number, latestSnap: Snapshot): PlayerState[] {
    const targetTime = renderTimestampMs - INTERPOLATION_DELAY_MS;
    const result: PlayerState[] = [];
    const nowMs = renderTimestampMs;
    for (const player of latestSnap.players) {
      if (player.playerId === this.localPlayerId) continue;
      const buffer = this.buffers.get(player.playerId);
      const latestArrived = this.latestArrivedAtMs.get(player.playerId);
      const bufArr = buffer ? buffer.toArray() : [];
      // Decide: lerp, extrapolate, or fallback.
      if (bufArr.length < 2 || latestArrived === undefined) {
        // Buffer starved. Extrapolate from the latest snapshot's
        // position + velocity.
        const extrap = this.extrapolate(player, nowMs, latestArrived ?? nowMs);
        if (extrap !== null) {
          result.push(extrap);
          this._starvationCount += 1;
        } else {
          result.push(player);
        }
        continue;
      }
      // Check snapshot age.
      const ageMs = nowMs - latestArrived;
      if (ageMs > MAX_SNAPSHOT_AGE_MS) {
        // Latest snapshot is too old to trust extrapolation. Return
        // the snapshot verbatim (the client is starved; a future
        // StateResyncRequest would fix it but that's PR 11.7.D).
        this._extrapolationCount += 1;
        result.push(player);
        continue;
      }
      // Find bracketing pair.
      const pair = findBracketing(bufArr, targetTime);
      if (pair === null) {
        // Shouldn't happen — buffer.length >= 2 — but be defensive.
        result.push(player);
        continue;
      }
      const [older, newer] = pair;
      // Compute t in [0, 1]. If older.arrivedAtMs === newer.arrivedAtMs
      // (zero-interval snapshots — shouldn't happen at 20Hz but
      // possible if two arrive in the same tick), clamp t = 0.
      const dt = newer.arrivedAtMs - older.arrivedAtMs;
      const t = dt > 0
        ? Math.max(0, Math.min(1, (targetTime - older.arrivedAtMs) / dt))
        : 0;
      result.push(lerpPlayerState(older.player, newer.player, t));
    }
    return result;
  }

  /** Extrapolate from the latest snapshot's position + velocity.
   *  `elapsedMs = nowMs - latestArrivedAtMs`, clamped to
   *  `MAX_SNAPSHOT_AGE_MS = 500ms`. Returns `null` if `elapsedMs` is
   *  negative (clock skew between the latest snapshot's arrival and
   *  the current render time). */
  private extrapolate(
    player: PlayerState,
    nowMs: number,
    latestArrivedAtMs: number,
  ): PlayerState | null {
    const rawElapsed = nowMs - latestArrivedAtMs;
    if (rawElapsed < 0) return null;
    const elapsedSec = Math.min(rawElapsed, MAX_SNAPSHOT_AGE_MS) / 1000;
    return {
      ...player,
      positionX: player.positionX + player.velocityX * elapsedSec,
      positionY: player.positionY + player.velocityY * elapsedSec,
    };
  }

  /** Read-only stats for the DEV probe / smoke instrumentation. */
  getStats(): InterpolatorStats {
    const perPlayerBufferDepth = new Map<number, number>();
    for (const [pid, buffer] of this.buffers) {
      perPlayerBufferDepth.set(pid, buffer.size());
    }
    return {
      perPlayerBufferDepth,
      starvationCount: this._starvationCount,
      extrapolationCount: this._extrapolationCount,
    };
  }
}

// Re-export for tests that want to mock the wire-side helpers without
// importing the full protocol module.
export { SNAPSHOT_RATE_HZ, INTERPOLATION_DELAY_MS, MAX_SNAPSHOT_AGE_MS };
