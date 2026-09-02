// PR 11.7.C / §3.8 — vitest tests for remote-player interpolation
// buffer. Four tests cover:
//
//   G: lerp midpoint between two bracketing snapshots is the average
//   H: local player is excluded from the output
//   I: extrapolation fires when buffer has < 2 entries for a player
//   J: extrapolation clamps at MAX_SNAPSHOT_AGE_MS = 500ms elapsed
//
// The interpolator's `onSnapshot` takes an explicit `nowMs` (wall-clock
// arrival time, normally `performance.now()`). Tests pass synthetic
// `nowMs` values to control buffer ordering + interpolation timing
// without faking timers — the math is deterministic given the inputs.
//
// **Yaw/pitch on the wire are zero** in PR 11.7.B (per
// `server/src/snapshot.rs:111-112`). The lerp test does NOT assert
// yaw/pitch values — those are always 0 on the wire today and the
// lerp math is well-tested via the position path.

import { describe, it, expect, beforeEach } from "vitest";

import type { Snapshot, PlayerState } from "../../../protocol/snapshot";
import { Interpolator } from "./remoteInterpolator";

/** Build a minimal `Snapshot` with the given players + serverFrame. */
function makeSnapshot(serverFrame: number, players: PlayerState[]): Snapshot {
  return { serverFrame, nextServerFrame: serverFrame + 1, players };
}

/** Build a PlayerState at a given position. */
function makePlayer(
  playerId: number,
  x: number,
  y: number = 0,
  velocityX: number = 0,
  velocityY: number = 0,
): PlayerState {
  return {
    playerId,
    positionX: x,
    positionY: y,
    velocityX,
    velocityY,
    yaw: 0,
    pitch: 0,
    hp: 100,
    ammo: 0,
    isFiring: 0,
    weaponId: 0,
    currentFireMode: 0,
      };
}

describe("remoteInterpolator PR 11.7.C — interpolation + extrapolation", () => {
  beforeEach(() => {
    // No module-level state to reset — the Interpolator class is a
    // pure instance. Each test creates a fresh instance in `it()`.
  });

  it("Test G: lerp midpoint between two bracketing snapshots is the average", () => {
    const interp = new Interpolator(/* localPlayerId */ 1);
    // Two snapshots for the remote player (id=2) 50ms apart in arrival
    // time. Snapshot A at (0, 0), snapshot B at (10, 0).
    const snapA = makeSnapshot(100, [makePlayer(2, 0, 0)]);
    const snapB = makeSnapshot(105, [makePlayer(2, 10, 0)]);
    interp.onSnapshot(snapA, /* nowMs */ 1000);
    interp.onSnapshot(snapB, /* nowMs */ 1050);
    // Render at 1075ms → targetTime = 1075 - 100 (delay) = 975. That's
    // BEFORE the first snapshot's arrival (1000). Need to look at the
    // rendering logic more carefully:
    //
    // - buffer entries arrived at [1000, 1050] (both older than
    //   targetTime = 975). findBracketing scans for first idx where
    //   arrivedAtMs > targetTime. 1000 > 975, so the loop exits
    //   without finding a pair. We fall through to the "use last two"
    //   branch, which returns [1000, 1050].
    // - t = (975 - 1000) / (1050 - 1000) = -25/50 = -0.5, clamped to 0.
    //   → Result is the older snapshot's position (0, 0). Not the
    //   midpoint.
    //
    // For a true midpoint, targetTime must be BETWEEN the two arrival
    // times. Use targetTime = 1025 (midpoint between 1000 and 1050).
    // That means renderTimestampMs = 1125.
    const result = interp.getInterpolatedStates(
      /* renderTimestampMs */ 1125,
      /* latestSnap */ snapB,
    );
    // Result must include player 2 (the remote), and the position
    // must be the midpoint (5, 0).
    expect(result.length).toBe(1);
    expect(result[0].playerId).toBe(2);
    expect(result[0].positionX).toBeCloseTo(5.0, 5);
    expect(result[0].positionY).toBeCloseTo(0.0, 5);
  });

  it("Test H: local player is excluded from the output", () => {
    const localPlayerId = 1;
    const interp = new Interpolator(localPlayerId);
    // Snapshot includes BOTH the local player and the remote.
    const snap = makeSnapshot(100, [
      makePlayer(localPlayerId, 0, 0),
      makePlayer(2, 5, 0),
    ]);
    interp.onSnapshot(snap, 1000);
    const result = interp.getInterpolatedStates(
      /* renderTimestampMs */ 1100,
      /* latestSnap */ snap,
    );
    // Only the remote player should be in the output — the local
    // player is predicted, not interpolated.
    expect(result.length).toBe(1);
    expect(result[0].playerId).toBe(2);
    // No entry for the local player.
    expect(result.find((p) => p.playerId === localPlayerId)).toBeUndefined();
  });

  it("Test I: extrapolation fires when buffer has < 2 entries for a player", () => {
    const interp = new Interpolator(/* localPlayerId */ 1);
    // Only ONE snapshot for the remote player. Buffer has < 2 entries.
    // The interpolator should extrapolate from the latest position +
    // velocity.
    const snap = makeSnapshot(100, [
      makePlayer(2, /* x */ 0, /* y */ 0, /* vx */ 1.0, /* vy */ 0),
    ]);
    interp.onSnapshot(snap, /* nowMs */ 1000);
    // Render at 1050ms → 50ms elapsed since the only snapshot.
    // Extrapolation: x = 0 + 1.0 * (50/1000) = 0.05.
    const result = interp.getInterpolatedStates(
      /* renderTimestampMs */ 1050,
      /* latestSnap */ snap,
    );
    expect(result.length).toBe(1);
    expect(result[0].playerId).toBe(2);
    expect(result[0].positionX).toBeCloseTo(0.05, 5);
    // Stats must reflect the starvation event.
    expect(interp.getStats().starvationCount).toBe(1);
  });

  it("Test J: extrapolation clamps at MAX_SNAPSHOT_AGE_MS = 500ms elapsed", () => {
    const interp = new Interpolator(/* localPlayerId */ 1);
    // Only ONE snapshot for the remote player, with non-zero velocity.
    const snap = makeSnapshot(100, [
      makePlayer(2, /* x */ 0, /* y */ 0, /* vx */ 1.0, /* vy */ 0),
    ]);
    interp.onSnapshot(snap, /* nowMs */ 1000);
    // Render at 2500ms → 1500ms elapsed. Beyond MAX_SNAPSHOT_AGE_MS.
    // Per the interpolator's design, the snapshot is too old to trust
    // extrapolation, so the snapshot is returned verbatim (no
    // extrapolation — see `getInterpolatedStates` "Check snapshot
    // age" branch). The snapshot's x = 0 → result x = 0.
    //
    // But the brief says: "extrapolation clamps at MAX_SNAPSHOT_AGE_MS
    // = 500ms elapsed" — the clamp is on the ELAPSED SECONDS used in
    // the extrapolation formula, not on whether extrapolation fires
    // at all. The interpolator's `extrapolate()` helper clamps
    // `elapsedSec = min(rawElapsed, MAX_SNAPSHOT_AGE_MS) / 1000`.
    // That helper is only called from the buffer-starvation branch,
    // not from the snapshot-age branch.
    //
    // So to test the clamp, we need: buffer has 1 entry (starvation
    // path) AND elapsed > 500ms. The snapshot-age branch fires only
    // when buffer has >= 2 entries.
    //
    // → Setup: 1 snapshot at 1000ms. Render at 1600ms (600ms elapsed,
    //   > 500ms clamp). The starvation path fires; clamp limits the
    //   extrapolation to 500ms → x = 0 + 1.0 * 0.5 = 0.5.
    const result = interp.getInterpolatedStates(
      /* renderTimestampMs */ 1600,
      /* latestSnap */ snap,
    );
    expect(result.length).toBe(1);
    expect(result[0].playerId).toBe(2);
    // Position must be CLAMPED at 500ms × 1.0 m/s = 0.5m — NOT the
    // raw 600ms × 1.0 m/s = 0.6m.
    expect(result[0].positionX).toBeCloseTo(0.5, 5);
  });

  // PR 11.7.D2 / §3.10 — Test K: the new `tick(nowMs)` method
  // returns a single RemotePlayerState per remote player with a
  // Babylon Vector3 position. The local player is excluded.
  // The interpolation math is the same as `getInterpolatedStates`
  // but tick() reads the latest snapshot from its own buffer
  // (no external latestSnap parameter needed). This is the
  // canonical consumer surface post-substrate-retirement.
  it("Test K: tick(now) returns a Babylon Vector3 per remote player (local excluded)", () => {
    const interp = new Interpolator(/* localPlayerId */ 1);
    const snap1: Snapshot = {
      serverFrame: 100,
      nextServerFrame: 105,
      players: [
        { playerId: 1, positionX: 0, positionY: 0, velocityX: 0, velocityY: 0, yaw: 0, pitch: 0, hp: 100, ammo: 0, isFiring: 0, weaponId: 0, currentFireMode: 0 },
        { playerId: 2, positionX: 5, positionY: 0, velocityX: 0, velocityY: 0, yaw: 0, pitch: 0, hp: 100, ammo: 0, isFiring: 0, weaponId: 0, currentFireMode: 0 },
      ],
    };
    const snap2: Snapshot = {
      serverFrame: 105,
      nextServerFrame: 110,
      players: [
        { playerId: 1, positionX: 0, positionY: 0, velocityX: 0, velocityY: 0, yaw: 0, pitch: 0, hp: 100, ammo: 0, isFiring: 0, weaponId: 0, currentFireMode: 0 },
        { playerId: 2, positionX: 7, positionY: 0, velocityX: 0, velocityY: 0, yaw: 0, pitch: 0, hp: 100, ammo: 0, isFiring: 0, weaponId: 0, currentFireMode: 0 },
      ],
    };
    interp.onSnapshot(snap1, /* arrivedAtMs */ 1000);
    interp.onSnapshot(snap2, /* arrivedAtMs */ 1050);

    // Render at 1025ms → targetTime = 925ms (before snap1's arrival).
    // Buffer has 2 entries; the lerp t = 0 (target is before both
    // entries), so the result should be snap1's position (x=5).
    const states = interp.tick(/* renderTimestampMs */ 1025);
    expect(states.length).toBe(1);
    expect(states[0].playerId).toBe(2);
    // Position is a Babylon Vector3 (X, Y=1 capsule-half, Z=Y-of-wire)
    // We can't import Vector3 in the test directly (vitest is in
    // Node, no Babylon), but the shape has x/y/z numeric fields.
    expect(states[0].position.x).toBeCloseTo(5, 5);
    expect(states[0].position.y).toBe(1);
    expect(states[0].position.z).toBeCloseTo(0, 5);
  });

  // PR 11.7.D2 — Test L: tick() returns an empty array when no
  // remote has been seen yet (very-first frames, before the first
  // snapshot arrives). The visual wiring skips setPosition on
  // empty result (remote rig stays at spawn).
  it("Test L: tick(now) returns [] when no snapshot has arrived yet", () => {
    const interp = new Interpolator(/* localPlayerId */ 1);
    const states = interp.tick(/* renderTimestampMs */ 1000);
    expect(states).toEqual([]);
  });
});
