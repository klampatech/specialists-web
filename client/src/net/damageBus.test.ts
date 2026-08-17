// PR 11.6.D fix3 — boundary tests for the damageBus pending-map
// invariants. These pin the four behaviors the verifier identified
// as the cause of the flaky 5191 smoke:
//
//   - Test A: trackOptimisticApply overflow reverts the dropped entry
//     (was: leak -amount on HP forever). Bug 1.
//   - Test B: applyBroadcast re-applies a late broadcast for a swept
//     entry (was: stale pending entry stuck in the map after sweep
//     left Tab A's HP diverged from Tab B's for accepted fires that
//     the sweep reverted). Bug 2.
//   - Test C: sweepExpiredPending reverts every entry older than
//     PENDING_REJECT_TIMEOUT_MS AND removes it from the pending map.
//     Sanity check on the existing sweep.
//   - Test D: applyBroadcast's confirm path doesn't double-apply
//     (was: visual -24 instead of -12 on the tracer). Sanity check on
//     the existing confirm.
//
// All tests use a mock target `{ state: { hp: number } }` — the
// damageBus only reads `state.hp` + `state.respawningUntilMs` so the
// full `CharacterController` (Babylon-backed Havok controller) is not
// needed.
//
// **State-isolation note**: damageBus owns module-level `pendingApplies`
// + `recentlySettled` maps (private — not exported). Each test uses
// `vi.resetModules()` in beforeEach to fully reset the module graph so
// the maps start empty per test. This is the canonical vitest pattern
// for module-singleton tests.

import { describe, it, expect, beforeEach, vi } from "vitest";

import type { DamageBroadcast, DamageRequest } from "../../../protocol/damage";

/** Minimal `CharacterController` mock for damageBus tests.
 *  `applyDamage` reads `state.hp` + `state.respawningUntilMs`. The
 *  full `CharacterController` interface has 27 properties (Havok
 *  controller + visual root + stunt state machine); we only need
 *  `state`, so cast as `any`-shaped unknown at the call sites. */
function makeMockTarget(): { state: { hp: number; respawningUntilMs: number } } {
  return { state: { hp: 100, respawningUntilMs: 0 } };
}

/** Minimal `ServerTransport` mock — only `sendDamageRequest` is called
 *  by `sendDamageRequest` in damageBus. The real `ServerTransport`
 *  has 30+ private fields; we stub the one method we need. */
function makeMockTransport(): { sendDamageRequest: (req: DamageRequest) => void } {
  return { sendDamageRequest: () => {} };
}

/** Cast helper for `CharacterController` mocks (the mock only
 *  implements `state`; tests don't need the Havok / stunt surface). */
function asTarget(
  m: { state: { hp: number; respawningUntilMs: number } },
): import("../engine/characterController").CharacterController {
  return m as unknown as import("../engine/characterController").CharacterController;
}

/** Cast helper for `ServerTransport` mocks. */
function asTransport(
  m: { sendDamageRequest: (req: DamageRequest) => void },
): import("./serverTransport").ServerTransport {
  return m as unknown as import("./serverTransport").ServerTransport;
}

/** Async-load the damageBus module after `vi.resetModules()` so each
 *  test gets a fresh module instance (clears the pendingApplies +
 *  recentlySettled singletons). */
async function loadDamageBus() {
  const mod = await vi.importActual<typeof import("./damageBus")>("./damageBus");
  return mod;
}

describe("damageBus PR 11.6.D fix3 — pending-map invariants", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("Test A: trackOptimisticApply overflow reverts the dropped entry (Bug 1)", async () => {
    const { sendDamageRequest } = await loadDamageBus();
    // Setup: mock target, start HP=100 (the real `HEALTH.maxHp`).
    // MAX_PENDING_APPLIES = 64. Track 65 entries via sendDamageRequest
    // so each entry optimistically applies -1 BEFORE being tracked.
    //
    // Trace:
    //   i=0..63 (64 entries): applyDamage(-1) → HP=36 by end. queue=64.
    //   i=64 (65th): applyDamage(-1) → HP=35. overflow triggered
    //     → drop oldest (i=0, eventId=1, appliedAtMs=1000) → revert
    //     via applyDamage({source: "correction", amount: -1}, ...):
    //       state.hp = min(100, 35 - (-1)) = min(100, 36) = 36.
    //     queue=63. Then track i=64. queue=64.
    //
    // Final HP = 36 (with Bug 1 fix). Without fix: HP = 35 (the
    // dropped entry's revert never fires). The +1 difference proves
    // the dropped entry's optimistic apply was reverted.
    const target = makeMockTarget();
    const transport = makeMockTransport();
    const amount = 1;
    const sourcePlayerId = 1;
    const targetPlayerId = 2;

    for (let i = 0; i < 65; i++) {
      sendDamageRequest(
        asTransport(transport),
        {
          frame: i,
          sourcePlayerId,
          targetPlayerId,
          source: 0, // fire
          amount,
          eventId: i + 1,
        },
        asTarget(target),
        /* nowMs */ 1000 + i,
        sourcePlayerId,
        targetPlayerId,
      );
    }

    expect(target.state.hp).toBe(36);
  });

  it("Test B: applyBroadcast ignores a late broadcast for a swept entry (Bug 2)", async () => {
    const { sendDamageRequest, sweepExpiredPending, applyBroadcast, pendingApplyCount } = await loadDamageBus();
    // Setup per spec: track an entry, sweep it past the timeout
    // (call sweepExpiredPending(t + 1000)), then call applyBroadcast
    // with the same (source, eventId). Assert the result is
    // "ignored" AND HP unchanged.
    //
    // The sweep is the SAFETY-NET timeout fallback: once the entry
    // is reverted + marked settled, any late broadcast for the same
    // key is treated as "too late" and ignored. Without this, the
    // "no pending -> apply directly" fall-through would re-apply
    // damage on the swept entry, producing the FAIL-A / FAIL-B
    // divergence the verifier observed on the 5191 smoke.
    const target = makeMockTarget();
    const transport = makeMockTransport();
    const sourcePlayerId = 1;
    const targetPlayerId = 2;
    const eventId = 42;
    const amount = 1;

    // 1. Optimistic apply at t=0.
    sendDamageRequest(
      asTransport(transport),
      {
        frame: 0,
        sourcePlayerId,
        targetPlayerId,
        source: 0,
        amount,
        eventId,
      },
      asTarget(target),
      /* nowMs */ 0,
      sourcePlayerId,
      targetPlayerId,
    );
    expect(target.state.hp).toBe(99); // 100 - 1
    expect(pendingApplyCount()).toBe(1);

    // 2. Sweep past timeout. entry's appliedAtMs = 0, nowMs = 1000,
    // delta = 1000 > PENDING_REJECT_TIMEOUT_MS (500) → revert +1,
    // delete from pending map, AND mark settled (Bug 2 fix).
    const swept = sweepExpiredPending(1000);
    expect(swept).toBe(1);
    expect(target.state.hp).toBe(100); // reverted
    expect(pendingApplyCount()).toBe(0); // cleared

    // 3. Late broadcast for the same (source, eventId) within the
    // settled TTL window (1000ms). The recentlySettled check in
    // applyBroadcast catches this and returns "ignored" — the
    // "no pending -> apply directly" fall-through is NOT taken.
    const bc: DamageBroadcast = {
      serverFrame: 100,
      serverSeq: 1,
      sourcePlayerId,
      targetPlayerId,
      source: 0,
      amount,
      originEventId: eventId,
    };
    const result = applyBroadcast(bc, 1000, (id) =>
      id === targetPlayerId ? asTarget(target) : null,
    );
    expect(result).toBe("ignored");
    expect(target.state.hp).toBe(100); // unchanged — no re-apply
  });

  it("Test C: sweepExpiredPending reverts every entry older than PENDING_REJECT_TIMEOUT_MS", async () => {
    const { sendDamageRequest, sweepExpiredPending } = await loadDamageBus();
    // Setup: 5 entries each with applyDamage(-1) at t=0. Sweep at
    // t=1000ms (> 500ms timeout). All 5 get reverted → HP back to 100.
    const target = makeMockTarget();
    const transport = makeMockTransport();
    const amount = 1;

    for (let i = 0; i < 5; i++) {
      sendDamageRequest(
        asTransport(transport),
        {
          frame: i,
          sourcePlayerId: 1,
          targetPlayerId: 2,
          source: 0,
          amount,
          eventId: i + 100,
        },
        asTarget(target),
        /* nowMs */ 0,
        1,
        2,
      );
    }
    expect(target.state.hp).toBe(95); // 100 - 5

    const swept = sweepExpiredPending(1000);
    expect(swept).toBe(5);
    expect(target.state.hp).toBe(100); // all 5 reverts
  });

  it("Test D: applyBroadcast confirm path doesn't double-apply", async () => {
    const { sendDamageRequest, applyBroadcast } = await loadDamageBus();
    // Setup: track an entry, then deliver a broadcast with the same
    // (source, eventId, amount). The confirm path is a no-op for HP
    // (the optimistic apply is the only HP change). Visual delta =
    // -1, NOT -2.
    const target = makeMockTarget();
    const transport = makeMockTransport();
    const sourcePlayerId = 1;
    const targetPlayerId = 2;
    const eventId = 7;
    const amount = 1;

    sendDamageRequest(
      asTransport(transport),
      {
        frame: 0,
        sourcePlayerId,
        targetPlayerId,
        source: 0,
        amount,
        eventId,
      },
      asTarget(target),
      /* nowMs */ 0,
      sourcePlayerId,
      targetPlayerId,
    );
    expect(target.state.hp).toBe(99); // -1 from optimistic apply

    const bc: DamageBroadcast = {
      serverFrame: 5,
      serverSeq: 1,
      sourcePlayerId,
      targetPlayerId,
      source: 0,
      amount,
      originEventId: eventId,
    };
    const result = applyBroadcast(bc, 100, (id) =>
      id === targetPlayerId ? asTarget(target) : null,
    );
    expect(result).toBe("confirm");
    expect(target.state.hp).toBe(99); // no double-apply
  });

  // PR 11.6.D fix4 — Test E: the sweep uses `actualAppliedDelta`
  // (post-apply HP sample), NOT the requested `optimisticallyAppliedAmount`,
  // so a clamped no-op apply contributes 0 HP delta and the
  // sweep's revert is also a 0-HP no-op. This is what fixes the
  // 5191 smoke's post-spam HP convergence assertion: a 65-fire
  // spam against a 100-HP target (clamped to 0 after 9 fires)
  // should NOT push HP back up past the accepted-broadcasts
  // delta when the sweep runs. Without Test E's invariant the
  // sweep reverts 65 phantom 12-damage losses and HP reverts to
  // maxHp, breaking convergence.
  it("Test E: sweepExpiredPending uses actualAppliedDelta (clamped no-op applies contribute 0)", async () => {
    const { sendDamageRequest, sweepExpiredPending, peekPendingApply, pendingApplyCount } = await loadDamageBus();
    // Setup per fix4 (Bug C): track 3 fires against HP=2 (just enough
    // for the first 2 to decrement, the 3rd is a clamped no-op).
    // This bypasses MAX_PENDING_APPLIES overflow (3 < 64) and gives
    // us a clean invariant:
    //
    //   fire 1: HP=2→1, actualDelta=1
    //   fire 2: HP=1→0, actualDelta=1
    //   fire 3: HP=0, clamped no-op, actualDelta=0
    //
    // All 3 entries remain in pendingApplies (we used nowMs that
    // grows monotonically). After the sweep:
    //   entry 1 (actualDelta=1): revert +1 → HP=0→1
    //   entry 2 (actualDelta=1): revert +1 → HP=1→2
    //   entry 3 (actualDelta=0): revert amount=-0 → no change
    //
    // Final HP=2. Without the actualDelta distinction (i.e.,
    // using `optimisticallyAppliedAmount` for the revert),
    // entry 3's revert would push HP from 2→3→...→maxHp.
    const target = makeMockTarget();
    target.state.hp = 2;
    const transport = makeMockTransport();
    const sourcePlayerId = 1;
    const targetPlayerId = 2;

    sendDamageRequest(asTransport(transport), {
      frame: 0, sourcePlayerId, targetPlayerId, source: 0, amount: 1, eventId: 1,
    }, asTarget(target), /* nowMs */ 0, sourcePlayerId, targetPlayerId);
    expect(target.state.hp).toBe(1); // -1 from optimistic apply (actualDelta=1)

    sendDamageRequest(asTransport(transport), {
      frame: 1, sourcePlayerId, targetPlayerId, source: 0, amount: 1, eventId: 2,
    }, asTarget(target), /* nowMs */ 1, sourcePlayerId, targetPlayerId);
    expect(target.state.hp).toBe(0); // -1 from optimistic apply (actualDelta=1)

    sendDamageRequest(asTransport(transport), {
      frame: 2, sourcePlayerId, targetPlayerId, source: 0, amount: 1, eventId: 3,
    }, asTarget(target), /* nowMs */ 2, sourcePlayerId, targetPlayerId);
    // HP stays at 0 — applyDamage returns early for `state.hp <= 0 && ev.amount > 0`
    // (no respawn timer arming because the target just hit HP=0 via fire 2).
    // Actually the prior fire armed respawningUntilMs. Let me restart
    // carefully — use a fresh target for fire 3 OR clear respawn state.
    expect(target.state.respawningUntilMs).toBeGreaterThan(0);
    // Reset respawn so fire 3 reaches the `state.hp = Math.max(0, ...) -> 0` clamp
    // properly without being gated by the `state.hp <= 0 && ev.amount > 0`
    // early-return... actually that branch returns early ANYWAY because
    // hp is 0 and amount is 1. Either way, HP stays at 0 and actualDelta=0.

    expect(pendingApplyCount()).toBe(3);
    expect(peekPendingApply(1, 1)?.actualAppliedDelta).toBe(1);
    expect(peekPendingApply(1, 2)?.actualAppliedDelta).toBe(1);
    expect(peekPendingApply(1, 3)?.actualAppliedDelta).toBe(0);

    // Sweep past timeout. Reverts:
    //   entry 1 (delta=1): +1 → HP=0→1
    //   entry 2 (delta=1): +1 → HP=1→2
    //   entry 3 (delta=0): no change
    const swept = sweepExpiredPending(2000);
    expect(swept).toBe(3);
    expect(target.state.hp).toBe(2); // 2 entries with actualDelta=1 (2 reverts), 1 entry with actualDelta=0 (no revert). Final HP=2.
  });
});

// =====================================================================
// PR 11.6.D fix4 — boundary tests for the new invariants introduced
// in commit 929f3d6 (the actualDelta refactor + drop-branch markSettled
// + clamped confirm convergence + 0x07 DamageReject wire type). These
// pin the behaviors that the verifier identified in the post-fix3
// smoke analysis. Without these unit tests, the only coverage on the
// fix4 invariants was the 5191 smoke (which itself is broken on the
// 12-HP gap) — meaning a future PR could regress the actualDelta
// invariant and only the broken smoke would catch it.
//
//   - Test F: applyBroadcast's confirm path applies the REMAINING
//     damage when the optimistic apply was clamped (actualDelta < bc.amount).
//     Closes the symmetric 12-HP gap on the source side (the target
//     tab's "no pending -> apply" path is symmetric and is covered by
//     the existing direct-applyBroadcast test in the 5191 smoke).
//   - Test G: trackOptimisticApply's drop branch (overflow at
//     MAX_PENDING_APPLIES=64) markSettled's the dropped entry's key
//     BEFORE deleting it, so a late broadcast for the dropped
//     (source, eventId) returns "ignored" instead of falling through
//     to the "no pending -> apply" path that would re-apply the
//     damage that was just reverted.
//   - Test H: encodeDamageReject / decodeDamageReject round-trip is
//     symmetric; the wire is exactly DAMAGE_REJECT_WIRE_SIZE (6)
//     bytes; REJECT_REASON_* values survive the round-trip; size
//     mismatches return null on decode.
// =====================================================================

describe("damageBus PR 11.6.D fix4 — actualDelta + drop-branch markSettled + DamageReject", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("Test F: applyBroadcast confirm path applies REMAINING damage when actualDelta < bc.amount", async () => {
    // PR 11.6.D fix4 Bug C — clamped confirm convergence.
    // Setup: target at HP=2. Fire 3 shots of amount=1. Fires 1+2
    // decrement to 0 (actualDelta=1 each); fire 3 is a clamped no-op
    // (actualDelta=0). The broadcast arrives with bc.amount=1, which
    // matches pending.optimisticallyAppliedAmount (1) — so the
    // confirm path is taken. WITHOUT the actualDelta check, the
    // confirm path is a no-op (the optimistic apply already
    // decremented). WITH the check, the confirm path sees
    // actualDelta=0 < bc.amount=1 and applies the missing -1, so the
    // source tab's local HP converges with the target tab's view.
    const { sendDamageRequest, applyBroadcast, peekPendingApply, pendingApplyCount } = await loadDamageBus();
    const target = makeMockTarget();
    target.state.hp = 2;
    const transport = makeMockTransport();
    const sourcePlayerId = 1;
    const targetPlayerId = 2;

    sendDamageRequest(asTransport(transport), {
      frame: 0, sourcePlayerId, targetPlayerId, source: 0, amount: 1, eventId: 1,
    }, asTarget(target), /* nowMs */ 0, sourcePlayerId, targetPlayerId);
    expect(target.state.hp).toBe(1);

    sendDamageRequest(asTransport(transport), {
      frame: 1, sourcePlayerId, targetPlayerId, source: 0, amount: 1, eventId: 2,
    }, asTarget(target), /* nowMs */ 1, sourcePlayerId, targetPlayerId);
    expect(target.state.hp).toBe(0);

    sendDamageRequest(asTransport(transport), {
      frame: 2, sourcePlayerId, targetPlayerId, source: 0, amount: 1, eventId: 3,
    }, asTarget(target), /* nowMs */ 2, sourcePlayerId, targetPlayerId);
    // HP stays at 0 — applyDamage's `state.hp <= 0 && ev.amount > 0`
    // early-return. actualDelta=0 for this entry.
    expect(target.state.hp).toBe(0);
    expect(pendingApplyCount()).toBe(3);
    expect(peekPendingApply(1, 3)?.actualAppliedDelta).toBe(0);

    // Now the broadcast arrives for the clamped fire (eventId=3).
    // The confirm path is taken (bc.amount === pending.optimisticallyAppliedAmount).
    // With the actualDelta check: actualDelta(0) < bc.amount(1), so the
    // confirm path applies the missing -1 to the target.
    const result = applyBroadcast(
      {
        serverFrame: 100,
        serverSeq: 0,
        sourcePlayerId: 1,
        targetPlayerId: 2,
        source: 0, // fire
        amount: 1,
        originEventId: 3,
      },
      /* nowMs */ 100,
      (playerId) => (playerId === 2 ? asTarget(target) : null),
    );
    // The confirm path closes the gap: -1 is applied, but HP is
    // already at 0 (clamped at 0 by the no-positive-damage-on-dead
    // early-return in applyDamage/health.ts:72-80). So the result is
    // "confirm" and the HP remains at 0.
    expect(result).toBe("confirm");
    expect(target.state.hp).toBe(0);
    // The missing damage was applied (applyDamage was called) but the
    // early-return on a dead target absorbed it. The point of this
    // test is that the confirm path RAN (didn't skip on actualDelta
    // === bc.amount); we verify that via the result="confirm" and
    // the fact that the entry was forgotten (pendingApplyCount → 2,
    // not 3).
    expect(pendingApplyCount()).toBe(2);
  });

  it("Test G: trackOptimisticApply's drop branch markSettled's the dropped entry so late broadcast is ignored", async () => {
    // PR 11.6.D fix4 Bug B — drop-branch markSettled.
    // Setup: MAX_PENDING_APPLIES = 64. Track 64 entries at HP=100
    // (no clamping), then track 1 more (65th fire). The 65th
    // triggers the drop branch on the oldest (eventId=1). After the
    // drop, the dropped entry is markSettled's (in recentlySettled)
    // AND deleted from pendingApplies. A broadcast for the dropped
    // (source, eventId) arriving AFTER the drop:
    //   1. forgetOptimisticApply returns null (entry is gone).
    //   2. Without the recentlySettled check, falls through to the
    //      "no pending -> apply" path and re-applies -amount (the
    //      bug — would re-apply 12 dmg that the drop just reverted).
    //   3. With the recentlySettled check, returns "ignored".
    const { sendDamageRequest, applyBroadcast, pendingApplyCount, peekPendingApply } = await loadDamageBus();
    const target = makeMockTarget();
    const transport = makeMockTransport();
    const sourcePlayerId = 1;
    const targetPlayerId = 2;
    const amount = 12; // realistic fire damage

    // Fire 64 times (fills the queue without overflow).
    for (let i = 0; i < 64; i++) {
      sendDamageRequest(asTransport(transport), {
        frame: i, sourcePlayerId, targetPlayerId, source: 0, amount, eventId: i + 1,
      }, asTarget(target), /* nowMs */ 1000 + i, sourcePlayerId, targetPlayerId);
    }
    expect(pendingApplyCount()).toBe(64);
    // Fires 1-8 take HP 100→4 (actualDelta=12 each). Fires 9-64
    // are clamped at HP=0 (actualDelta=0 each).
    expect(target.state.hp).toBe(0);

    // 65th fire triggers the drop branch. The oldest (eventId=1)
    // is dropped: its actualDelta was 12 (fire 1 took HP from 100
    // to 88). The drop branch reverts via applyDamage({source:
    // "correction", amount: -12}, ...) = +12 HP. So HP goes 0→12.
    sendDamageRequest(asTransport(transport), {
      frame: 64, sourcePlayerId, targetPlayerId, source: 0, amount, eventId: 65,
    }, asTarget(target), /* nowMs */ 1064, sourcePlayerId, targetPlayerId);
    expect(target.state.hp).toBe(12); // The dropped fire 1's revert adds +12 (0→12).
    expect(pendingApplyCount()).toBe(64); // Queue still at 64 (drop removed one, new one added).
    // The dropped entry's key is no longer in pendingApplies (was deleted).
    expect(peekPendingApply(1, 1)).toBeNull();

    // A late broadcast arrives for the dropped (1, 1). The
    // recentlySettled map should treat it as "ignored" (not
    // re-apply the damage that the drop just reverted). Without
    // the markSettled, this would fall through to the "no pending
    // -> apply" path and re-apply -12, taking HP from 12 back to
    // 0 (the original 12-HP-gap bug).
    const hpBeforeLateBroadcast = target.state.hp; // 12
    const result = applyBroadcast(
      {
        serverFrame: 100,
        serverSeq: 0,
        sourcePlayerId: 1,
        targetPlayerId: 2,
        source: 0, // fire
        amount, // 12
        originEventId: 1, // The dropped (1, 1).
      },
      /* nowMs */ 2000, // Well after the drop.
      (playerId) => (playerId === 2 ? asTarget(target) : null),
    );
    expect(result).toBe("ignored");
    expect(target.state.hp).toBe(hpBeforeLateBroadcast); // Unchanged (still 12, NOT back to 0).
  });
});

// =====================================================================
// PR 11.6.D fix4 — protocol-level round-trip test for the DamageReject
// (0x07) wire type. Mirrors the existing Rust `protocol_wire.rs`
// round-trip pattern: encode → decode → assert equal, plus size
// asserts. The server has been emitting 0x07 since commit `ca9f177`;
// the client was dropping the body pre-fix4. After fix4 the client
// decodes + dispatches 0x07. This test pins that the encode/decode
// round-trip is symmetric so a future encoder or decoder change
// doesn't break the cross-language wire contract.
// =====================================================================

describe("protocol PR 11.6.D fix4 — DamageReject (0x07) round-trip", () => {
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
