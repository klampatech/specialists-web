// PR #59 / §3.5 + PR #107 + PR #108 — `AimEvent` (0x0A) wire-format
// round-trip tests + `WeaponSwitch` (0x0C) wire-format round-trip
// tests.
//
// Mirrors the protocol_wire.rs round-trip pattern (the same shape
// as `reload.test.ts`'s ReloadRequest round-trip). The cross-
// language invariant: `decodeAimEvent(encodeAimEvent(req)
// .subarray(1))` round-trips to `req`. If the Rust encoder/decoder
// drifts from this TS pair, both `cargo test` and `vitest run` will
// catch it (same data, two layers of safety).
//
// PR #107 added the trailing `isFiring` byte to AimEvent (drives the
// server-side burst state machine). PR #108 adds the new
// `WeaponSwitch` (0x0C) wire type that reclaims the discriminator
// from the dead DAMAGE_REJECT slot.

import { describe, it, expect } from "vitest";

import {
  encodeAimEvent,
  decodeAimEvent,
  DISCRIMINATOR_AIM_EVENT,
  AIM_EVENT_BODY_SIZE,
  AIM_EVENT_WIRE_SIZE,
  encodeWeaponSwitch,
  decodeWeaponSwitch,
  DISCRIMINATOR_WEAPON_SWITCH,
  WEAPON_SWITCH_BODY_SIZE,
  WEAPON_SWITCH_WIRE_SIZE,
  encodeMeleeEvent,
  decodeMeleeEvent,
  DISCRIMINATOR_MELEE_EVENT,
  MELEE_EVENT_BODY_SIZE,
  MELEE_EVENT_WIRE_SIZE,
} from "./damage";

describe("protocol PR #59 + PR #107 — AimEvent (0x0A) round-trip", () => {
  it("encodeAimEvent produces the documented wire size (20 bytes post-PR-#107)", () => {
    // disc (1) + source u16 BE (2) + yaw f32 BE (4) + pitch f32 BE (4)
    // + frame u32 BE (4) + event_id u32 BE (4) + is_firing u8 (1) = 20
    // (was 19 pre-PR #107; the +1 byte is `isFiring`.)
    const wire = encodeAimEvent({
      sourcePlayerId: 1,
      yawRadians: 0.0,
      pitchRadians: 0.0,
      frame: 1,
      eventId: 1,
      isFiring: 1,
    });
    expect(wire.length).toBe(AIM_EVENT_WIRE_SIZE);
    expect(AIM_EVENT_WIRE_SIZE).toBe(20);
    expect(AIM_EVENT_BODY_SIZE).toBe(19);
    expect(wire[0]).toBe(DISCRIMINATOR_AIM_EVENT);
  });

  it("encodeAimEvent + decodeAimEvent round-trip is symmetric (with isFiring)", () => {
    const cases: Array<{
      sourcePlayerId: number;
      yawRadians: number;
      pitchRadians: number;
      frame: number;
      eventId: number;
      isFiring: number;
    }> = [
      // Press event with PI/2 yaw (fires along +X axis where the demo target lives).
      { sourcePlayerId: 1, yawRadians: Math.PI / 2, pitchRadians: 0.0, frame: 1, eventId: 1, isFiring: 1 },
      // Release event with 0 yaw (fires along +Z axis, Babylon left-handed Y-up convention).
      { sourcePlayerId: 0x5566, yawRadians: 0.0, pitchRadians: -0.25, frame: 0xdeadbeef, eventId: 0xcafef00d, isFiring: 0 },
      // Press event with negative yaw + positive pitch.
      { sourcePlayerId: 7, yawRadians: -1.5, pitchRadians: 0.4, frame: 100, eventId: 5, isFiring: 1 },
      // Max u16 sourcePlayerId + max u32 eventId + release.
      { sourcePlayerId: 0xffff, yawRadians: 3.14, pitchRadians: -1.5, frame: 0xffffffff, eventId: 0xffffffff, isFiring: 0 },
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
      // PR #107 — burst state machine input.
      expect(decoded!.isFiring).toBe(c.isFiring);
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
      isFiring: 0x01,
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
    // byte 19 = is_firing: 0x01 (PR #107)
    expect(wire[19]).toBe(0x01);
  });
});

describe("protocol PR #107 + PR #108 — WeaponSwitch (0x0C) round-trip", () => {
  it("encodeWeaponSwitch produces the documented wire size (5 bytes)", () => {
    // disc (1) + source u16 BE (2) + weapon_id u8 (1) +
    // fire_mode_index u8 (1) = 5
    const wire = encodeWeaponSwitch({
      sourcePlayerId: 1,
      weaponId: 0, // DualPistol
      fireModeIndex: 0, // Semi
    });
    expect(wire.length).toBe(WEAPON_SWITCH_WIRE_SIZE);
    expect(WEAPON_SWITCH_WIRE_SIZE).toBe(5);
    expect(WEAPON_SWITCH_BODY_SIZE).toBe(4);
    expect(wire[0]).toBe(DISCRIMINATOR_WEAPON_SWITCH);
  });

  it("encodeWeaponSwitch + decodeWeaponSwitch round-trip is symmetric", () => {
    const cases: Array<{
      sourcePlayerId: number;
      weaponId: number;
      fireModeIndex: number;
    }> = [
      // DualPistol + Semi (default).
      { sourcePlayerId: 1, weaponId: 0, fireModeIndex: 0 },
      // DualPistol + Burst3.
      { sourcePlayerId: 2, weaponId: 0, fireModeIndex: 1 },
      // Shotgun + Semi.
      { sourcePlayerId: 3, weaponId: 1, fireModeIndex: 0 },
      // Sniper + Semi.
      { sourcePlayerId: 0x5566, weaponId: 2, fireModeIndex: 0 },
      // Max u16 sourcePlayerId + max u8 weapon/fire-mode.
      { sourcePlayerId: 0xffff, weaponId: 0xff, fireModeIndex: 0xff },
    ];
    for (const c of cases) {
      const wire = encodeWeaponSwitch(c);
      // Size assert (wire).
      expect(wire.length).toBe(WEAPON_SWITCH_WIRE_SIZE);
      // Strip the discriminator (the decoder expects body-only).
      const body = wire.subarray(1);
      expect(body.length).toBe(WEAPON_SWITCH_BODY_SIZE);
      const decoded = decodeWeaponSwitch(body);
      expect(decoded).not.toBeNull();
      expect(decoded!.sourcePlayerId).toBe(c.sourcePlayerId);
      expect(decoded!.weaponId).toBe(c.weaponId);
      expect(decoded!.fireModeIndex).toBe(c.fireModeIndex);
    }
  });

  it("decodeWeaponSwitch returns null on body-size mismatch", () => {
    expect(decodeWeaponSwitch(new Uint8Array(0))).toBeNull();
    expect(decodeWeaponSwitch(new Uint8Array(WEAPON_SWITCH_BODY_SIZE - 1))).toBeNull();
    expect(decodeWeaponSwitch(new Uint8Array(WEAPON_SWITCH_BODY_SIZE + 1))).toBeNull();
    expect(decodeWeaponSwitch(new Uint8Array(64))).toBeNull();
  });

  it("encodeWeaponSwitch is big-endian (matches server/src/protocol.rs)", () => {
    // Pin the byte order so a future encoder change to little-endian
    // trips this test.
    const wire = encodeWeaponSwitch({
      sourcePlayerId: 0x0506,
      weaponId: 0x07,
      fireModeIndex: 0x09,
    });
    expect(wire[0]).toBe(DISCRIMINATOR_WEAPON_SWITCH);
    // bytes 1..2 = source_player_id BE: 05 06
    expect(wire[1]).toBe(0x05);
    expect(wire[2]).toBe(0x06);
    // byte 3 = weapon_id
    expect(wire[3]).toBe(0x07);
    // byte 4 = fire_mode_index
    expect(wire[4]).toBe(0x09);
  });
});

describe("protocol PR #114 — MeleeEvent (0x0B) round-trip", () => {
  it("encodeMeleeEvent produces the documented wire size (19 bytes)", () => {
    expect(MELEE_EVENT_WIRE_SIZE).toBe(19);
    expect(MELEE_EVENT_BODY_SIZE).toBe(18);
    const wire = encodeMeleeEvent({
      sourcePlayerId: 1,
      yawRadians: 0.0,
      pitchRadians: 0.0,
      frame: 0,
      eventId: 1,
    });
    expect(wire.length).toBe(MELEE_EVENT_WIRE_SIZE);
    expect(wire.length).toBe(19);
  });

  it("encodeMeleeEvent + decodeMeleeEvent round-trip is symmetric", () => {
    const cases = [
      // Boundary: zero yaw + pitch.
      { sourcePlayerId: 1, yawRadians: 0.0, pitchRadians: 0.0, frame: 0, eventId: 1 },
      // Normal: forward + slightly up.
      { sourcePlayerId: 7, yawRadians: 1.57, pitchRadians: 0.2, frame: 1234, eventId: 56 },
      // Boundary: max u16 / u32 values.
      { sourcePlayerId: 0xffff, yawRadians: -3.14, pitchRadians: 1.5, frame: 0xffffffff, eventId: 0xffffffff },
      // Negative pitch (looking down).
      { sourcePlayerId: 100, yawRadians: -1.5, pitchRadians: -0.4, frame: 999, eventId: 7 },
    ];
    for (const c of cases) {
      const wire = encodeMeleeEvent(c);
      // Size assert (wire).
      expect(wire.length).toBe(MELEE_EVENT_WIRE_SIZE);
      // Strip the discriminator (the decoder expects body-only).
      const body = wire.subarray(1);
      expect(body.length).toBe(MELEE_EVENT_BODY_SIZE);
      const decoded = decodeMeleeEvent(body);
      expect(decoded).not.toBeNull();
      expect(decoded!.sourcePlayerId).toBe(c.sourcePlayerId);
      // f32 BE round-trip: Math.fround narrows the JS f64 to the
      // nearest f32 (the same narrowing the BE encoder performs).
      expect(decoded!.yawRadians).toBe(Math.fround(c.yawRadians));
      expect(decoded!.pitchRadians).toBe(Math.fround(c.pitchRadians));
      expect(decoded!.frame).toBe(c.frame);
      expect(decoded!.eventId).toBe(c.eventId);
    }
  });

  it("decodeMeleeEvent returns null on body-size mismatch", () => {
    expect(decodeMeleeEvent(new Uint8Array(0))).toBeNull();
    expect(decodeMeleeEvent(new Uint8Array(MELEE_EVENT_BODY_SIZE - 1))).toBeNull();
    expect(decodeMeleeEvent(new Uint8Array(MELEE_EVENT_BODY_SIZE + 1))).toBeNull();
    expect(decodeMeleeEvent(new Uint8Array(64))).toBeNull();
  });

  it("encodeMeleeEvent is big-endian (matches server/src/protocol.rs)", () => {
    // Pin the byte order so a future encoder change to little-endian
    // trips this test. The first byte is the discriminator (0x0B
    // for MeleeEvent); subsequent bytes are big-endian u16/u32/f32.
    const wire = encodeMeleeEvent({
      sourcePlayerId: 0x0506,
      yawRadians: 0.0, // (f32 bits = 0x00000000)
      pitchRadians: 0.0,
      frame: 0x0a0b0c0d,
      eventId: 0x01020304,
    });
    expect(wire[0]).toBe(DISCRIMINATOR_MELEE_EVENT);
    expect(DISCRIMINATOR_MELEE_EVENT).toBe(0x0b);
    // bytes 1..2 = source_player_id BE: 05 06
    expect(wire[1]).toBe(0x05);
    expect(wire[2]).toBe(0x06);
    // bytes 3..6 = yaw_radians BE (f32 0.0 = 0x00000000)
    expect(wire[3]).toBe(0x00);
    expect(wire[4]).toBe(0x00);
    expect(wire[5]).toBe(0x00);
    expect(wire[6]).toBe(0x00);
    // bytes 7..10 = pitch_radians BE (f32 0.0 = 0x00000000)
    expect(wire[7]).toBe(0x00);
    expect(wire[8]).toBe(0x00);
    expect(wire[9]).toBe(0x00);
    expect(wire[10]).toBe(0x00);
    // bytes 11..14 = frame BE: 0a 0b 0c 0d
    expect(wire[11]).toBe(0x0a);
    expect(wire[12]).toBe(0x0b);
    expect(wire[13]).toBe(0x0c);
    expect(wire[14]).toBe(0x0d);
    // bytes 15..18 = event_id BE: 01 02 03 04
    expect(wire[15]).toBe(0x01);
    expect(wire[16]).toBe(0x02);
    expect(wire[17]).toBe(0x03);
    expect(wire[18]).toBe(0x04);
  });

  it("DISCRIMINATOR_MELEE_EVENT is 0x0B (reclaimed from StateResyncRequest)", () => {
    // Per PR #114's reclaim pattern: 0x0B was reserved for
    // StateResyncRequest in the brief but never exercised; PR
    // #114 reclaims the slot for MeleeEvent (same pattern as
    // PR #107's DAMAGE_REJECT → WeaponSwitch reclaim of 0x0C).
    expect(DISCRIMINATOR_MELEE_EVENT).toBe(0x0b);
  });

  it("MeleeEvent and AimEvent have the same wire size (19 bytes)", () => {
    // The MeleeEvent wire format mirrors AimEvent but drops the
    // `is_firing` byte (melee is single-tap, not held). Pre-PR-#107
    // AimEvent was 19 bytes (no isFiring byte); post-PR-#107 it's
    // 20 bytes. MeleeEvent stays at 19 bytes (no isFiring).
    expect(MELEE_EVENT_WIRE_SIZE).toBe(19);
    expect(AIM_EVENT_WIRE_SIZE).toBe(20);
  });
});
