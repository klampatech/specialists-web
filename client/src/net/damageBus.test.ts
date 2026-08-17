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
});
