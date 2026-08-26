// PR #59 / §3.5 — `AimEvent` (0x0A) wire-format round-trip tests.
//
// Mirrors the protocol_wire.rs round-trip pattern (the same shape
// as `reload.test.ts`'s ReloadRequest round-trip). The cross-
// language invariant: `decodeAimEvent(encodeAimEvent(req)
// .subarray(1))` round-trips to `req`. If the Rust encoder/decoder
// drifts from this TS pair, both `cargo test` and `vitest run` will
// catch it (same data, two layers of safety).

import { describe, it, expect } from "vitest";

import {
  encodeAimEvent,
  decodeAimEvent,
  DISCRIMINATOR_AIM_EVENT,
  AIM_EVENT_BODY_SIZE,
  AIM_EVENT_WIRE_SIZE,
} from "./damage";

describe("protocol PR #59 — AimEvent (0x0A) round-trip", () => {
  it("encodeAimEvent produces the documented wire size (19 bytes)", () => {
    // disc (1) + source u16 BE (2) + yaw f32 BE (4) + pitch f32 BE (4)
    // + frame u32 BE (4) + event_id u32 BE (4) = 19
    const wire = encodeAimEvent({
      sourcePlayerId: 1,
      yawRadians: 0.0,
      pitchRadians: 0.0,
      frame: 1,
      eventId: 1,
    });
    expect(wire.length).toBe(AIM_EVENT_WIRE_SIZE);
    expect(AIM_EVENT_WIRE_SIZE).toBe(19);
    expect(AIM_EVENT_BODY_SIZE).toBe(18);
    expect(wire[0]).toBe(DISCRIMINATOR_AIM_EVENT);
  });

  it("encodeAimEvent + decodeAimEvent round-trip is symmetric", () => {
    const cases: Array<{
      sourcePlayerId: number;
      yawRadians: number;
      pitchRadians: number;
      frame: number;
      eventId: number;
    }> = [
      // Canonical PI/2 yaw (fires along +X axis where the demo target lives).
      { sourcePlayerId: 1, yawRadians: Math.PI / 2, pitchRadians: 0.0, frame: 1, eventId: 1 },
      // 0 yaw (fires along +Z axis, Babylon left-handed Y-up convention).
      { sourcePlayerId: 0x5566, yawRadians: 0.0, pitchRadians: -0.25, frame: 0xdeadbeef, eventId: 0xcafef00d },
      // Negative yaw + positive pitch.
      { sourcePlayerId: 7, yawRadians: -1.5, pitchRadians: 0.4, frame: 100, eventId: 5 },
      // Max u16 sourcePlayerId + max u32 eventId.
      { sourcePlayerId: 0xffff, yawRadians: 3.14, pitchRadians: -1.5, frame: 0xffffffff, eventId: 0xffffffff },
    ];
    for (const c of cases) {
      const wire = encodeAimEvent(c);
      // Size assert (wire).
      expect(wire.length).toBe(AIM_EVENT_WIRE_SIZE);
      // Strip the discriminator (the decoder expects body-only).
      const body = wire.subarray(1);
      expect(body.length).toBe(AIM_EVENT_BODY_SIZE);
      const decoded = decodeAimEvent(body);
      expect(decoded).not.toBeNull();
      expect(decoded!.sourcePlayerId).toBe(c.sourcePlayerId);
      // f32 BE round-trip: Math.fround narrows the JS f64 to the
      // nearest f32 (the same narrowing the BE encoder performs).
      // decoded!.yawRadians comes back as the f32-precision value.
      expect(decoded!.yawRadians).toBe(Math.fround(c.yawRadians));
      expect(decoded!.pitchRadians).toBe(Math.fround(c.pitchRadians));
      expect(decoded!.frame).toBe(c.frame);
      expect(decoded!.eventId).toBe(c.eventId);
    }
  });

  it("decodeAimEvent returns null on body-size mismatch", () => {
    expect(decodeAimEvent(new Uint8Array(0))).toBeNull();
    expect(decodeAimEvent(new Uint8Array(AIM_EVENT_BODY_SIZE - 1))).toBeNull();
    expect(decodeAimEvent(new Uint8Array(AIM_EVENT_BODY_SIZE + 1))).toBeNull();
    expect(decodeAimEvent(new Uint8Array(64))).toBeNull();
  });

  it("encodeAimEvent is big-endian (matches server/src/protocol.rs)", () => {
    // Pin the byte order so a future encoder change to little-endian
    // trips this test (mirrors the Rust `aim_event_is_big_endian`
    // test in `protocol_wire.rs`).
    const wire = encodeAimEvent({
      sourcePlayerId: 0x0506,
      yawRadians: 0.0,    // f32 bits = 0x00000000
      pitchRadians: 0.0,  // f32 bits = 0x00000000
      frame: 0x01020304,
      eventId: 0x0a0b0c0d,
    });
    expect(wire[0]).toBe(DISCRIMINATOR_AIM_EVENT);
    // bytes 1..2 = source_player_id BE: 05 06
    expect(wire[1]).toBe(0x05);
    expect(wire[2]).toBe(0x06);
    // bytes 3..6 = yaw f32 BE (0.0 = 00 00 00 00)
    expect(wire[3]).toBe(0x00);
    expect(wire[4]).toBe(0x00);
    expect(wire[5]).toBe(0x00);
    expect(wire[6]).toBe(0x00);
    // bytes 7..10 = pitch f32 BE (0.0 = 00 00 00 00)
    expect(wire[7]).toBe(0x00);
    expect(wire[8]).toBe(0x00);
    expect(wire[9]).toBe(0x00);
    expect(wire[10]).toBe(0x00);
    // bytes 11..14 = frame BE: 01 02 03 04
    expect(wire[11]).toBe(0x01);
    expect(wire[12]).toBe(0x02);
    expect(wire[13]).toBe(0x03);
    expect(wire[14]).toBe(0x04);
    // bytes 15..18 = event_id BE: 0a 0b 0c 0d
    expect(wire[15]).toBe(0x0a);
    expect(wire[16]).toBe(0x0b);
    expect(wire[17]).toBe(0x0c);
    expect(wire[18]).toBe(0x0d);
  });
});
