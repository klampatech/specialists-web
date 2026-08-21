// PR 11.7.D / §4.4 closure — damageBus boundary tests.
//
// The PR 11.6.D optimistic-apply machinery (pendingApplies map, sweep,
// settled map, markSettled, optimistic apply at send time, confirm/
// revert at broadcast time, TracerFlash events) is GONE. The tests
// that pinned those invariants (Tests A-E from fix3, Tests F-G from
// fix4) are all deleted — the code they tested no longer exists.
//
// What remains:
//   - Protocol round-trip test for `DamageReject` (0x0C) wire type.
//     The server still emits DamageReject for fire-rate / ammo /
//     eventId violations; the client still decodes + dispatches it.
//     Wire format is unchanged from PR 11.7.B.
//   - New Test I: broadcast-with-no-pending just applies the damage
//     directly. Pins the §4.4 closure invariant: the client doesn't
//     try to predict the server's broadcast outcome.

import { describe, it, expect } from "vitest";

import type { DamageBroadcast } from "../../../protocol/damage";

/** Minimal `CharacterController` mock for damageBus tests.
 *  `applyDamage` reads `state.hp` + `state.respawningUntilMs`. The
 *  full `CharacterController` interface has 27 properties (Havok
 *  controller + visual root + stunt state machine); we only need
 *  `state`, so cast as `any`-shaped unknown at the call sites. */
function makeMockTarget(): { state: { hp: number; respawningUntilMs: number } } {
  return { state: { hp: 100, respawningUntilMs: 0 } };
}

/** Cast helper for `CharacterController` mocks (the mock only
 *  implements `state`; tests don't need the Havok / stunt surface). */
function asTarget(
  m: { state: { hp: number; respawningUntilMs: number } },
): import("../engine/characterController").CharacterController {
  return m as unknown as import("../engine/characterController").CharacterController;
}

// =====================================================================
// PR 11.7.D / §4.4 closure — `applyBroadcast` no longer has confirm/
// revert branches (no client-side pending state). The single path
// is: if the resolver returns a controller, apply; otherwise ignore.
// =====================================================================

describe("damageBus PR 11.7.D / §4.4 closure — applyBroadcast", () => {
  it("Test I: broadcast-with-no-pending applies damage directly", async () => {
    // No `sendDamageRequest` call before this broadcast — there is no
    // pending entry to confirm or revert. The broadcast's `amount`
    // is applied straight to the target's HP via `applyDamage`.
    const { applyBroadcast } = await import("./damageBus");
    const target = makeMockTarget();
    const sourcePlayerId = 1;
    const targetPlayerId = 2;

    const bc: DamageBroadcast = {
      serverFrame: 100,
      serverSeq: 1,
      sourcePlayerId,
      targetPlayerId,
      source: 0, // fire
      amount: 12,
      originEventId: 42,
    };
    const result = applyBroadcast(
      bc,
      /* nowMs */ 0,
      (id) => (id === targetPlayerId ? asTarget(target) : null),
    );
    expect(result).toBe("applied");
    expect(target.state.hp).toBe(88); // 100 - 12
  });

  it("applyBroadcast returns 'ignored' when target resolver returns null", async () => {
    // Edge case from PR 11.6.D: if the resolver returns null (the
    // target PlayerId isn't in our controllers map — e.g., a 3rd
    // player we don't render), we ignore. After the optimistic-
    // apply removal, this is the ONLY way a broadcast becomes
    // "ignored" — there's no "revert" or "ignore-due-to-settled"
    // branches anymore.
    const { applyBroadcast } = await import("./damageBus");
    const target = makeMockTarget();
    const bc: DamageBroadcast = {
      serverFrame: 100,
      serverSeq: 1,
      sourcePlayerId: 1,
      targetPlayerId: 2,
      source: 0,
      amount: 12,
      originEventId: 42,
    };
    const result = applyBroadcast(
      bc,
      /* nowMs */ 0,
      () => null, // resolver says "no controller"
    );
    expect(result).toBe("ignored");
    expect(target.state.hp).toBe(100); // unchanged
  });
});

// =====================================================================
// PR 11.6.D fix4 — protocol-level round-trip test for the DamageReject
// (0x0C) wire type. Mirrors the existing Rust `protocol_wire.rs`
// round-trip pattern: encode → decode → assert equal, plus size
// asserts. The server has been emitting 0x0C since PR 11.7.B (was
// 0x07 in PR 11.6.D since commit `ca9f177`); the client decodes +
// dispatches 0x0C. PR 11.7.D / §4.4 closure removed the
// applyReject revert path but the wire encoder/decoder is still
// used by `applyReject(sourcePlayerId, eventId, reason)` (which now
// just logs after the optimistic-apply removal) and by the probe's
// `onDamageReject` listener. This test pins the wire contract so a
// future encoder or decoder change doesn't break the cross-language
// round-trip.
// =====================================================================

describe("protocol PR 11.6.D fix4 — DamageReject (0x0C) round-trip (was 0x07 before PR 11.7.B)", () => {
  it("encodeDamageReject + decodeDamageReject round-trip is symmetric for every REJECT_REASON_*", async () => {
    const {
      encodeDamageReject,
      decodeDamageReject,
      DAMAGE_REJECT_WIRE_SIZE,
      DAMAGE_REJECT_BODY_SIZE,
      REJECT_REASON_FIRE_RATE,
      REJECT_REASON_AMMO,
      REJECT_REASON_EVENT_ID,
      REJECT_REASON_LAG_MISS,
      REJECT_REASON_NO_HISTORY,
    } = await import("../../../protocol/damage");

    // One round-trip per REJECT_REASON. 5 cases.
    const cases = [
      { eventId: 0,          reason: REJECT_REASON_FIRE_RATE },
      { eventId: 1,          reason: REJECT_REASON_AMMO      },
      { eventId: 0x7fffffff, reason: REJECT_REASON_EVENT_ID  },
      { eventId: 0xffffffff, reason: REJECT_REASON_LAG_MISS  },
      { eventId: 1234567890, reason: REJECT_REASON_NO_HISTORY},
    ];
    for (const c of cases) {
      const wire = encodeDamageReject(c);
      // Size assert: full wire = 1-byte discriminator + 4-byte eventId
      // + 1-byte reason = 6 bytes.
      expect(wire.length).toBe(DAMAGE_REJECT_WIRE_SIZE);
      // Strip the discriminator (the decoder expects body-only) and
      // round-trip the body.
      const body = wire.subarray(1);
      expect(body.length).toBe(DAMAGE_REJECT_BODY_SIZE);
      const decoded = decodeDamageReject(body);
      expect(decoded).not.toBeNull();
      expect(decoded!.eventId).toBe(c.eventId);
      expect(decoded!.reason).toBe(c.reason);
    }
  });

  it("decodeDamageReject returns null on body-size mismatch", async () => {
    const { decodeDamageReject, DAMAGE_REJECT_BODY_SIZE } = await import("../../../protocol/damage");
    // 0-byte body
    expect(decodeDamageReject(new Uint8Array(0))).toBeNull();
    // 1-byte short
    expect(decodeDamageReject(new Uint8Array(DAMAGE_REJECT_BODY_SIZE - 1))).toBeNull();
    // 1-byte long
    expect(decodeDamageReject(new Uint8Array(DAMAGE_REJECT_BODY_SIZE + 1))).toBeNull();
    // Way too long
    expect(decodeDamageReject(new Uint8Array(64))).toBeNull();
  });

  it("encodeDamageReject size-asserts at runtime (DAMAGE_REJECT_WIRE_SIZE = 6)", async () => {
    const { encodeDamageReject, DAMAGE_REJECT_WIRE_SIZE } = await import("../../../protocol/damage");
    // Mirrors the existing `encodeDamageRequest` size-assert pattern.
    // The body is 5 bytes (eventId u32 BE + reason u8) + 1 byte
    // discriminator = 6 bytes wire. If the wire size constant is
    // wrong, the encoder's console.assert will fire (or in vitest,
    // the assertion is silent — the test below is the size-assert
    // gate).
    const wire = encodeDamageReject({ eventId: 0, reason: 0 });
    expect(wire.length).toBe(DAMAGE_REJECT_WIRE_SIZE);
    expect(DAMAGE_REJECT_WIRE_SIZE).toBe(6); // Pinned constant.
  });
});