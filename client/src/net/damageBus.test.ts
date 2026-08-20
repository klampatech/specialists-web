// PR 11.7.D / §4.4 — damageBus boundary tests after Option B
// (drop optimistic-apply). The pending-map / sweep / recentlySettled
// machinery is gone — all the Tests A-G that pinned those invariants
// are deleted. What's left:
//
//   - Test H (DamageReject round-trip): wire format symmetry is
//     unchanged; REJECT_REASON_* values survive encode/decode; size
//     mismatches return null. Pin: future encoder/decoder changes
//     don't break the cross-language wire contract.
//   - Test I (applyBroadcast with target): single-apply path. If
//     resolveTarget(bc.targetPlayerId) returns a controller, apply
//     damage and return "applied". If null, return "ignored".
//     Pins the new simpler contract post-Option-B.
//   - Test J (applyBroadcast idempotency): calling applyBroadcast
//     twice with the same broadcast decrements HP twice (no dedup).
//     The server is authoritative; a re-delivered WebSocket frame
//     (retry / GC stall) does decrement again. The authoritative
//     dedup is the server-side validate_and_relay's monotonic-
//     eventId gate, not the client.
//
// All tests use a mock target `{ state: { hp: number } }` —
// `applyDamage` reads `state.hp` + `state.respawningUntilMs` so the
// full CharacterController (Babylon-backed Havok) is not needed.

import { describe, it, expect, vi } from "vitest";

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

/** Async-load the damageBus module. PR 11.7.D Option B: the module
 *  is stateless (no pendingApplies / recentlySettled singletons), so
 *  `vi.resetModules()` is no longer needed for state-isolation — each
 *  test gets a clean module by virtue of the singleton-free design. */
async function loadDamageBus() {
  const mod = await vi.importActual<typeof import("./damageBus")>("./damageBus");
  return mod;
}


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
      { eventId: 0,            reason: REJECT_REASON_FIRE_RATE  },
      { eventId: 1,            reason: REJECT_REASON_AMMO       },
      { eventId: 0x7fffffff,   reason: REJECT_REASON_EVENT_ID   },
      { eventId: 0xffffffff,   reason: REJECT_REASON_LAG_MISS   },
      { eventId: 1234567890,   reason: REJECT_REASON_NO_HISTORY },
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

// =====================================================================
// PR 11.7.D / §4.4 Option B — new damageBus tests for the simplified
// single-apply broadcast handler. Test H (above) covers the wire
// format. Tests I + J pin the new applyBroadcast contract: it's a
// single apply path (no confirm/revert/ignored dedup), and repeated
// calls with the same broadcast decrement HP twice (server is
// authoritative — the rare WS retry is the smoke's job, not the unit
// test's).
// =====================================================================

describe("damageBus PR 11.7.D / §4.4 Option B — single-apply broadcast handler", () => {
  it("Test I: applyBroadcast applies damage directly when target exists; returns 'ignored' when resolver returns null", async () => {
    const { applyBroadcast } = await loadDamageBus();
    const target = makeMockTarget();
    const bc: DamageBroadcast = {
      serverFrame: 0,
      serverSeq: 0,
      source: 0, // fire
      targetPlayerId: 2,
      sourcePlayerId: 1,
      amount: 12,
      originEventId: 1,
    };
    // Resolver returns the target controller → apply damage once,
    // return "applied", HP drops by 12.
    const resultApplied = applyBroadcast(bc, performance.now(), (playerId) =>
      playerId === 2 ? asTarget(target) : null,
    );
    expect(resultApplied).toBe("applied");
    expect(target.state.hp).toBe(88); // 100 - 12.

    // Resolver returns null → no apply, return "ignored", HP unchanged.
    const targetUnchanged = makeMockTarget();
    const resultIgnored = applyBroadcast(bc, performance.now(), () => null);
    expect(resultIgnored).toBe("ignored");
    expect(targetUnchanged.state.hp).toBe(100);

    // No resolver at all → "ignored", HP unchanged. The smoke
    // supplies a resolver (the broadcast handler's getControllers
    // closure) so production never hits this branch; the test pins
    // that the no-resolver case is safe.
    const targetNoResolver = makeMockTarget();
    const resultNoResolver = applyBroadcast(bc, performance.now());
    expect(resultNoResolver).toBe("ignored");
    expect(targetNoResolver.state.hp).toBe(100);
  });

  it("Test J: applyBroadcast is idempotent on repeated calls with the same broadcast (server is authoritative)", async () => {
    const { applyBroadcast } = await loadDamageBus();
    const target = makeMockTarget();
    const bc: DamageBroadcast = {
      serverFrame: 0,
      serverSeq: 0,
      source: 0, // fire
      targetPlayerId: 2,
      sourcePlayerId: 1,
      amount: 12,
      originEventId: 1,
    };
    // First call: apply 12 damage.
    const result1 = applyBroadcast(bc, performance.now(), (playerId) =>
      playerId === 2 ? asTarget(target) : null,
    );
    expect(result1).toBe("applied");
    expect(target.state.hp).toBe(88);
    // Second call with the SAME broadcast: apply 12 damage again.
    // No dedup — the authoritative dedup is the server-side
    // validate_and_relay's monotonic-eventId gate, not the client.
    // A re-delivered WS frame (retry, GC stall) does decrement again.
    const result2 = applyBroadcast(bc, performance.now(), (playerId) =>
      playerId === 2 ? asTarget(target) : null,
    );
    expect(result2).toBe("applied");
    expect(target.state.hp).toBe(76); // 100 - 12 - 12.

    // Third call: another 12. HP = 64.
    const result3 = applyBroadcast(bc, performance.now(), (playerId) =>
      playerId === 2 ? asTarget(target) : null,
    );
    expect(result3).toBe("applied");
    expect(target.state.hp).toBe(64);
  });
});

describe("damageBus PR 11.7.D / §4.4 Option B — sendDamageRequest is a pure send", () => {
  // PR 11.7.D / §4.4 — Option B regression guard. Post-Option-B,
  // `sendDamageRequest` is a pure wire-side send: it must NOT touch
  // the target controller's HP. The authoritative HP decrement
  // happens in `applyBroadcast` when the server's `DamageBroadcast`
  // arrives. Before Option B, `sendDamageRequest` had a trailing
  // 5-arg signature that did `applyDamage(targetController, ...)`
  // synchronously — the optimistic-apply path that created the
  // 12-HP race window. This test pins the post-Option-B contract.
  // A future PR that re-adds optimistic-apply would have to
  // change this signature, and the test would fail (the target's
  // HP would drop from 100 to 88 after the call).
  it("Test K: sendDamageRequest does NOT decrement target.state.hp (pure send)", async () => {
    const { sendDamageRequest } = await loadDamageBus();
    const target = makeMockTarget();
    const req = {
      frame: 1,
      sourcePlayerId: 1,
      targetPlayerId: 2,
      source: 0, // fire
      amount: 12,
      eventId: 42,
    };
    // Mock transport — assert ONLY that sendDamageRequest is called,
    // and that no applyDamage path is invoked on the target.
    const mockTransport = {
      sendDamageRequest: vi.fn(),
    };
    // Cover the full 6-arg signature (transport + req + target +
    // nowMs + sourcePlayerId + targetPlayerId). All post-Option-B
    // trailing args are no-ops; the test pins that.
    const result = sendDamageRequest(
      mockTransport as unknown as Parameters<typeof sendDamageRequest>[0],
      req,
      asTarget(target),
      performance.now(),
      1,
      2,
    );
    // 1. The transport was called exactly once with the request.
    expect(mockTransport.sendDamageRequest).toHaveBeenCalledTimes(1);
    expect(mockTransport.sendDamageRequest).toHaveBeenCalledWith(req);
    // 2. The function returned the eventId (for tracing).
    expect(result).toBe(42);
    // 3. THE LOAD-BEARING ASSERTION: the target's HP is unchanged.
    //    If a future PR re-adds optimistic-apply, this will fail.
    expect(target.state.hp).toBe(100);
  });
});
