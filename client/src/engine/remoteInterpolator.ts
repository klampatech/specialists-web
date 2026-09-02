// PR 11.7.C / §3.8 — remote-player interpolation buffer.
//
// **The CS2/Valorant shape (per docs/PR-11.6-plan.md §1.2 item 6)**:
// remote players are INTERPOLATED, not predicted. Each client keeps a
// 100-150ms buffer of remote-player snapshots and lerps between them
// for smooth visual. LOCAL player is predicted (see clientPredictor.ts);
// remotes are interpolated.
//
// **Constants source**: the numbers below are now IMPORTED from
// `protocol/constants.ts` (PR 11.7.D2 / §1.2). Before D2 the
// constants were a MIRROR of `server/src/constants.rs` (PR 11.7.B),
// inlined per-module. PR 11.7.D2.1 extracted the canonical
// `protocol/constants.ts`; this file dropped the inlined copies
// and imports from the canonical source. The server-side mirror is
// still `server/src/constants.rs`; the protocol round-trip test
// (server/tests/protocol_wire.rs) catches drift.
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

import type { Vector3 as Vector3Type } from "@babylonjs/core";
import { Vector3 } from "@babylonjs/core";
import type { Snapshot, PlayerState } from "../../../protocol/snapshot";
import {
  INTERPOLATION_DELAY_MS,
  MAX_SNAPSHOT_AGE_MS,
} from "../../../protocol/constants";

// -- Constants (canonical — sourced from protocol/constants.ts) ---
//
// PR 11.7.D2 / §1.2: SNAPSHOT_RATE_HZ / INTERPOLATION_DELAY_MS /
// MAX_SNAPSHOT_AGE_MS MOVED to `protocol/constants.ts` (the canonical
// source for both client + server; the TS module was extracted in
// PR 11.7.D2.1). The previous mirror-of-server/constants.rs inlined
// copies are gone — these names now come straight from the canonical
// import above. The re-export at the bottom of this file is also
// removed; importers should reach into `protocol/constants.ts`
// directly.

/** Ring buffer capacity per remote player. 8 snapshots = 400ms at
 *  20Hz — well over the 100ms interpolation delay + 500ms extrapolation
 *  age, so the buffer never starves in normal play. */
const RING_BUFFER_CAPACITY = 8;

/** Per-player snapshot entry stored in the ring buffer. */
/**
 * PR 11.7.D2 / §3.10 — the per-player state returned from
 * `Interpolator.tick(now)`. Mirrors the shape of
 * `protocol/snapshot.PlayerState` but with a Babylon `Vector3`
 * position (world-space, ready to feed into Havok setPosition)
 * + an optional rotation (undefined until PR 11.7.E adds
 * yaw/pitch to the snapshot wire).
 */
export interface RemotePlayerState {
  playerId: number;
  position: Vector3Type;
  rotation: undefined; // reserved for PR 11.7.E
}

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
    // PR #102 — discrete weapon id (no interpolation).
    weaponId: newer.weaponId,
    // PR #107 — discrete fire-mode index (no interpolation).
    currentFireMode: newer.currentFireMode,
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
      // PR 11.7.D2.1 / FIX — skip placeholder ids (>= 1000).
      // Pre-fix, brief windows where a peer connection had just
      // arrived but hadn't yet been promoted via PositionUpdate
      // would leave the snapshot including the placeholder id
      // (e.g., 1001). The interpolator buffered it; `tick()`
      // returned it as `states[0]`; the scene-side setPosition
      // pinned the remote Havok body to the placeholder's last
      // known position (always Position::ZERO since no physics
      // body had been created yet) — so the remote rig froze at
      // the world origin until promotion landed. Skipping
      // placeholders at the buffer-write stage avoids the freeze
      // entirely (the player's "real" id is buffered as soon as
      // the next snapshot arrives post-promotion).
      if (player.playerId >= 1000) continue;
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

  /**
   * PR 11.7.D2 / §3.10 — per-frame sample. Returns the
   * interpolated (or extrapolated, or fallback) state for every
   * remote player at `renderTimestampMs`. The local player is
   * excluded. Returns an empty array when no remote has been
   * seen yet (very-first frames).
   *
   * This is the canonical consumer surface post-substrate-retirement:
   *   - `scene.ts` render observer calls `interpolator.tick(now)`
   *     each frame, reads the returned positions, and applies them
   *     to `remoteController.havok.setPosition(...)` (the Havok
   *     body is now a write-target only).
   *   - Rewritten smokes call `interpolator.tick(now)` to query
   *     the visual position vs the predicted position vs the
   *     snapshot's authoritative position.
   *
   * For 2-player smokes there\'s exactly one remote player; for
   * future multi-player the caller iterates the returned array.
   *
   * **Position convention**: Babylon\'s `(x, y, z)` with y = up.
   * The snapshot wire uses `(positionX, positionY)` where X is the
   * horizontal (server\'s Rapier x) and Y is the depth (server\'s
   * Rapier y). The decoder maps them — see
   * `protocol/snapshot.ts::PlayerState`. The interpolator returns
   * the interpolated `(positionX, positionY, 0)` mapped to a
   * Babylon `Vector3(x, z, 0)` — same as the existing
   * `getInterpolatedStates` returns for the `positionX`/`positionY`
   * fields.
   *
   * **Why not just expose `getInterpolatedStates`**: that method
   * takes the latest `Snapshot` as a parameter (the caller must
   * hold it). The new `tick()` reads the latest snapshot from
   * its own per-player buffer\'s tail — the buffer\'s latest
   * entry IS the most-recent snapshot, no external closure
   * needed. This is what makes the scene-side wiring a one-liner.
   */
  tick(renderTimestampMs: number): RemotePlayerState[] {
    const targetTime = renderTimestampMs - INTERPOLATION_DELAY_MS;
    const nowMs = renderTimestampMs;
    const out: RemotePlayerState[] = [];
    for (const [playerId, buffer] of this.buffers) {
      // Local player is never in this map (onSnapshot skips it),
      // but be defensive.
      if (playerId === this.localPlayerId) continue;
      // PR 11.7.D2.1 / defense-in-depth — skip placeholder ids that
      // somehow made it into the buffer (e.g., a stale placeholder
      // from before this fix shipped). See `onSnapshot` comment.
      if (playerId >= 1000) continue;
      const latestArrived = this.latestArrivedAtMs.get(playerId);
      const bufArr = buffer.toArray();
      // Decide: lerp, extrapolate, or fallback.
      let playerState: PlayerState;
      if (bufArr.length < 2 || latestArrived === undefined) {
        // Buffer starved. Extrapolate from the latest snapshot\'s
        // position + velocity.
        const lastSnap = bufArr.length > 0 ? bufArr[bufArr.length - 1] : null;
        const anchor = lastSnap ? lastSnap.player : null;
        if (anchor) {
          const extrap = this.extrapolate(anchor, nowMs, latestArrived ?? nowMs);
          if (extrap !== null) {
            playerState = extrap;
            this._starvationCount += 1;
          } else if (lastSnap) {
            playerState = lastSnap.player;
          } else {
            continue;
          }
        } else {
          continue;
        }
      } else {
        // Check snapshot age.
        const ageMs = nowMs - latestArrived;
        const lastSnap = bufArr[bufArr.length - 1];
        if (ageMs > MAX_SNAPSHOT_AGE_MS) {
          // Latest snapshot is too old to trust extrapolation.
          // Return the snapshot verbatim.
          this._extrapolationCount += 1;
          playerState = lastSnap.player;
        } else {
          // Find bracketing pair.
          const pair = findBracketing(bufArr, targetTime);
          if (pair === null) {
            playerState = lastSnap.player;
          } else {
            const [older, newer] = pair;
            const dt = newer.arrivedAtMs - older.arrivedAtMs;
            const t = dt > 0
              ? Math.max(0, Math.min(1, (targetTime - older.arrivedAtMs) / dt))
              : 0;
            playerState = lerpPlayerState(older.player, newer.player, t);
          }
        }
      }
      // Convert from server (X, Y) horizontal-only to Babylon
      // (x, y, z) world-space. Y = ground-up (CAPSULE.height / 2
      // for the controller\'s spawn); the snapshot wire
      // \'s positionY is depth (Z in Babylon).
      // The Babylon Vector3 here is what Havok\'s setPosition
      // expects (a world-space point).
      const position = new Vector3(
        playerState.positionX,
        // Y is fixed at character capsule half-height; the
        // snapshot\'s `positionY` is depth (server y axis),
        // not vertical. The server\'s snapshot.rs defines
        // the (x, y) → (Babylon x, Babylon z) mapping.
        1.0,
        playerState.positionY,
      );
      out.push({
        playerId,
        position,
        // Rotation (yaw / pitch) on the wire is zero in
        // PR 11.7.B (per server/src/snapshot.rs line 111-112:
        // `yaw: 0.0, pitch: 0.0`). The interpolator returns
        // undefined for rotation; the scene applies Havok\'s
        // default rotation. PR 11.7.E wires yaw/pitch on the
        // wire; the interpolated rotation will be added here.
        rotation: undefined,
      });
    }
    return out;
  }
}

