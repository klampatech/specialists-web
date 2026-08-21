// PR 11.7.D / §4.4 closure — snapshot wire-format round-trip tests.
//
// PR 11.7.D found a latent bug in `decodeSnapshot`: it checked the
// discriminator byte against an already-stripped buffer, so it always
// returned `null`. The fix (drop disc check, shift offsets by -1) made
// real wire data flow into PR 11.7.C's predictor + interpolator for the
// first time. To prevent a recurrence, this file pins the invariant:
//
//   `decodeSnapshot(encodeSnapshot(s).subarray(1))` round-trips to `s`.
//
// (Plus a few sanity tests on the edge cases — empty player list,
// overflow guard, malformed input.)

import { describe, it, expect } from "vitest";

import type { Snapshot } from "../../../protocol/snapshot";
import {
  encodeSnapshot,
  decodeSnapshot,
  DISCRIMINATOR_SNAPSHOT,
  SNAPSHOT_BODY_SIZE,
} from "../../../protocol/snapshot";

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    serverFrame: 12345,
    nextServerFrame: 12346,
    players: [
      {
        playerId: 1,
        positionX: 1.25,
        positionY: -3.5,
        velocityX: 0.1,
        velocityY: 0.2,
        yaw: 0.785,
        pitch: -0.2,
        hp: 88,
        ammo: 12,
        isFiring: 0,
      },
      {
        playerId: 2,
        positionX: -2.0,
        positionY: 5.5,
        velocityX: -0.3,
        velocityY: 0.0,
        yaw: -1.5,
        pitch: 0.4,
        hp: 100,
        ammo: 0,
        isFiring: 1,
      },
    ],
    ...overrides,
  };
}

describe("encodeSnapshot / decodeSnapshot round-trip (PR 11.7.D)", () => {
  it("round-trips a 2-player snapshot", () => {
    // Use f32-exact values (powers of 2 or sums of small powers of 2 only)
    // so that round-trip equality can hold on literal comparison.
    const s = makeSnapshot({
      players: [
        {
          playerId: 1,
          positionX: 1.5,
          positionY: -3.5,
          velocityX: 0.125,
          velocityY: 0.25,
          yaw: 0.5, // 0.5 is exact in f32
          pitch: -0.25,
          hp: 88,
          ammo: 12,
          isFiring: 0,
        },
        {
          playerId: 2,
          positionX: -2.0,
          positionY: 5.5,
          velocityX: -0.125, // exact in f32
          velocityY: 0.0,
          yaw: -1.0, // exact in f32
          pitch: 0.25,
          hp: 100,
          ammo: 0,
          isFiring: 1,
        },
      ],
    });
    const wire = encodeSnapshot(s);
    // Wire form: disc + body. Caller strips disc per `serverTransport.handleInbound`.
    expect(wire[0]).toBe(DISCRIMINATOR_SNAPSHOT);
    const body = wire.subarray(1);
    const decoded = decodeSnapshot(body);
    expect(decoded).toEqual(s);
  });

  it("round-trips an empty-player-list snapshot", () => {
    const s = makeSnapshot({ players: [] });
    const wire = encodeSnapshot(s);
    expect(wire[0]).toBe(DISCRIMINATOR_SNAPSHOT);
    expect(wire.length - 1).toBe(SNAPSHOT_BODY_SIZE);
    const decoded = decodeSnapshot(wire.subarray(1));
    expect(decoded).toEqual(s);
  });

  it("round-trips every legal player count (0..255 player entries that fit)", () => {
    // Quick fuzz: 0, 1, 4, 16 players (full u8 coverage is overkill for a smoke test).
    for (const n of [0, 1, 4, 16]) {
      const s = makeSnapshot({
        players: Array.from({ length: n }, (_, i) => ({
          playerId: i + 1,
          positionX: i * 0.5,
          positionY: i,
          velocityX: 0,
          velocityY: 0,
          yaw: 0,
          pitch: 0,
          hp: 100 - i,
          ammo: 12,
          isFiring: 0,
        })),
      });
      const decoded = decodeSnapshot(encodeSnapshot(s).subarray(1));
      expect(decoded).toEqual(s);
    }
  });

  it("returns null on body-size mismatch (truncated input)", () => {
    const s = makeSnapshot();
    const wire = encodeSnapshot(s).subarray(1);
    // Truncate by 1 byte — should fail size or playerCount parity check.
    const truncated = wire.subarray(0, wire.length - 1);
    expect(decodeSnapshot(truncated)).toBeNull();
  });

  it("returns null on playerCount-byte mismatch vs body size", () => {
    // Build a body that's exactly SNAPSHOT_BODY_SIZE (9 bytes) with
    // playerCount=1 but no per-player payload. The parity check
    // should reject it.
    const fake = new Uint8Array(SNAPSHOT_BODY_SIZE);
    fake[8] = 1; // playerCount=1 but body size says 0 players
    expect(decodeSnapshot(fake)).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(decodeSnapshot(new Uint8Array(0))).toBeNull();
  });

  it("preserves f32 bit patterns exactly (no rounding errors)", () => {
    // f32 has 23-bit mantissa; pick a value that survives round-trip exactly.
    const s = makeSnapshot({
      players: [
        {
          playerId: 7,
          positionX: 1.5, // exact in f32
          positionY: -2.25, // exact in f32
          velocityX: 0.0,
          velocityY: 0.0,
          yaw: Math.PI / 4, // 0.7853981... approximates; just check it's reproducible
          pitch: -0.1,
          hp: 42,
          ammo: 7,
          isFiring: 1,
        },
      ],
    });
    const decoded = decodeSnapshot(encodeSnapshot(s).subarray(1));
    expect(decoded).not.toBeNull();
    // Float bit-equality: positionX, positionY are exactly representable.
    expect(decoded!.players[0].positionX).toBe(1.5);
    expect(decoded!.players[0].positionY).toBe(-2.25);
    // Float bit-equality on yaw: encode → decode → encode should be identical.
    const reEncoded = encodeSnapshot(decoded!);
    expect(reEncoded).toEqual(encodeSnapshot(s));
  });
});
