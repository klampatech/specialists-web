// PR 11.7.E / §3.5 — `ReloadRequest` (0x09) wire-format round-trip tests.
//
// Mirrors the protocol_wire.rs round-trip pattern (the same shape
// as `damageBus.test.ts`'s DamageReject round-trip). The cross-
// language invariant: `decodeReloadRequest(encodeReloadRequest(req)
// .subarray(1))` round-trips to `req`. If the Rust encoder/decoder
// drifts from this TS pair, both `cargo test` and `vitest run` will
// catch it (same data, two layers of safety).

import { describe, it, expect } from "vitest";

import {
  encodeReloadRequest,
  decodeReloadRequest,
  DISCRIMINATOR_RELOAD_REQUEST,
  RELOAD_REQUEST_BODY_SIZE,
  RELOAD_REQUEST_WIRE_SIZE,
} from "./reload";

describe("protocol PR 11.7.E — ReloadRequest (0x09) round-trip", () => {
  it("encodeReloadRequest produces the documented wire size (7 bytes)", () => {
    // disc (1) + source_player_id u16 BE (2) + event_id u32 BE (4) = 7
    const wire = encodeReloadRequest({ playerId: 1, eventId: 1 });
    expect(wire.length).toBe(RELOAD_REQUEST_WIRE_SIZE);
    expect(RELOAD_REQUEST_WIRE_SIZE).toBe(7);
    expect(wire[0]).toBe(DISCRIMINATOR_RELOAD_REQUEST);
  });

  it("encodeReloadRequest + decodeReloadRequest round-trip is symmetric", () => {
    const cases = [
      { playerId: 1, eventId: 1 },
      { playerId: 0x5566, eventId: 0xdeadbeef },
      { playerId: 42, eventId: 0xffffffff },
      { playerId: 7, eventId: 0 },
      { playerId: 99, eventId: 1234567890 },
    ];
    for (const c of cases) {
      const wire = encodeReloadRequest(c);
      // Size assert (wire)
      expect(wire.length).toBe(RELOAD_REQUEST_WIRE_SIZE);
      // Strip the discriminator (the decoder expects body-only).
      const body = wire.subarray(1);
      expect(body.length).toBe(RELOAD_REQUEST_BODY_SIZE);
      const decoded = decodeReloadRequest(body);
      expect(decoded).not.toBeNull();
      expect(decoded!.playerId).toBe(c.playerId);
      expect(decoded!.eventId).toBe(c.eventId);
    }
  });

  it("decodeReloadRequest returns null on body-size mismatch", () => {
    expect(decodeReloadRequest(new Uint8Array(0))).toBeNull();
    expect(decodeReloadRequest(new Uint8Array(RELOAD_REQUEST_BODY_SIZE - 1))).toBeNull();
    expect(decodeReloadRequest(new Uint8Array(RELOAD_REQUEST_BODY_SIZE + 1))).toBeNull();
    expect(decodeReloadRequest(new Uint8Array(64))).toBeNull();
  });

  it("encodeReloadRequest is big-endian (matches server/src/protocol.rs)", () => {
    // Pin the byte order so a future encoder change to little-endian
    // trips this test (mirrors the Rust `damage_request_is_big_endian`
    // test in `protocol_wire.rs`).
    const wire = encodeReloadRequest({ playerId: 0x0102, eventId: 0x03040506 });
    expect(wire[0]).toBe(DISCRIMINATOR_RELOAD_REQUEST);
    // bytes 1..2 = source_player_id BE: 01 02
    expect(wire[1]).toBe(0x01);
    expect(wire[2]).toBe(0x02);
    // bytes 3..6 = event_id BE: 03 04 05 06
    expect(wire[3]).toBe(0x03);
    expect(wire[4]).toBe(0x04);
    expect(wire[5]).toBe(0x05);
    expect(wire[6]).toBe(0x06);
  });
});
