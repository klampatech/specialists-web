// PR 11.6.D / §3.5 + §3.6 + §3.9 — typed wrappers over the wire codecs +
// outbound queue + **client-side damage prediction**.
//
// **PR 11.6.D scope (over PR 11.6.C)**:
//   - `pendingApplies` map (§3.9). Every fire event queues an
//     optimistic apply locally; when the server's broadcast arrives,
//     the map is consulted for confirm / revert.
//   - `applyBroadcast(bc, nowMs, resolveTarget?)` — the three-path
//     confirm / revert / apply-directly handler.
//   - `sendDamageRequest(t, req, targetController, nowMs)` — the new
//     unified entry point that sends + applies locally.
//   - `sendPositionUpdateThrottled(t, frame, playerId, x, y)` —
//     32Hz PositionUpdate sender (§3.10).
//
// **Why a queue + a pending map**: PR 11.6.C added the bounded
// `DamageRequestQueue` for outbound FIFO + retry tracking. PR 11.6.D
// adds the per-eventId pending map so the broadcast handler can
// confirm / revert the optimistic apply. Both are needed: the queue
// is about *what was sent*, the pending map is about *what was
// optimistically applied*.
//
// **DEV probe**: PR 11.6.C surfaces the typed wrappers on
// `window.__damageBus` so the headless smoke can call them without
// having to instantiate a `GameSession`. The probe is gated behind
// `import.meta.env.DEV` in `scene.ts` so production bundles strip it
// (verified by `grep '__damageBus' dist/assets/index-*.js` → ZERO
// matches post-build).

import {
  decodeDamageBroadcast,
  decodeDamageReject,
  decodePing,
  decodePong,
  decodePositionUpdate,
  encodeDamageBroadcast,
  encodeDamageRequest,
  encodeInputsServer,
  encodePing,
  encodePositionUpdate,
} from "../../../protocol/damage";
import type {
  DamageBroadcast,
  DamageReject,
  DamageRequest,
  InputsServer,
  Ping,
  Pong,
  PositionUpdate,
} from "../../../protocol/damage";
import type {ServerTransport} from "./serverTransport";
import { applyDamage } from "../game/health";
import type { CharacterController } from "../engine/characterController";

// Keep the codec surface available from the typed bus as well as from the
// protocol module. PR 11.6.C review fix B2: the TS encoders now
// prefix the discriminator, so the returned wire bytes are the full
// packet (disc + body). The body-only decoders (`decodeXxxBody` below)
// take the buffer after `handleInbound` has stripped the discriminator.
export {
  decodeDamageBroadcast,
  decodeDamageReject,
  decodePing,
  decodePong,
  decodePositionUpdate,
  encodeDamageBroadcast,
  encodeDamageRequest,
  encodeInputsServer,
  encodePing,
  encodePositionUpdate,
  DISCRIMINATOR_DAMAGE_BROADCAST,
  DISCRIMINATOR_DAMAGE_REJECT,
  DISCRIMINATOR_DAMAGE_REQUEST,
  DISCRIMINATOR_INPUTS,
  DISCRIMINATOR_INPUTS_SERVER,
  DISCRIMINATOR_PING,
  DISCRIMINATOR_PONG,
  DISCRIMINATOR_POSITION_UPDATE,
  DAMAGE_BROADCAST_WIRE_SIZE,
  DAMAGE_REJECT_WIRE_SIZE,
  DAMAGE_REQUEST_WIRE_SIZE,
  INPUTS_SERVER_WIRE_SIZE,
  PING_WIRE_SIZE,
  PONG_WIRE_SIZE,
  POSITION_UPDATE_WIRE_SIZE,
  REJECT_REASON_AMMO,
  REJECT_REASON_EVENT_ID,
  REJECT_REASON_FIRE_RATE,
  REJECT_REASON_LAG_MISS,
  REJECT_REASON_NO_HISTORY,
} from "../../../protocol/damage";

/** Maximum outbound damage requests queued before oldest are dropped. */
const MAX_QUEUED = 16;
/** Position-update throttle (§3.10). 32Hz = every other tick at 64Hz. */
const POSITION_UPDATE_SEND_EVERY_N_TICKS = 2;

// -- Pending optimistic applies map (§3.9) --------------------------------

interface PendingOptimisticApply {
  /** The source tab's PlayerId. Used with eventId to make the
   *  pending-map key unique across tabs (FIX 3). */
  sourcePlayerId: number;
  eventId: number;
  /** The target tab's PlayerId. Used by the tracer flash event
   *  (the controller itself doesn't carry a playerId). */
  targetPlayerId: number;
  targetController: CharacterController;
  source: "fire" | "melee";
  amount: number;
  appliedAtMs: number;
  /** How many HP the optimistic apply actually subtracted. Used by
   *  the revert path to undo the exact amount (the broadcast may
   *  arrive with a different amount if the server clamped it). */
  optimisticallyAppliedAmount: number;
  /** PR 11.6.D fix4 (Bug C — sweep over-revert): the actual HP
   *  delta the optimistic apply contributed, computed from
   *  `state.hp` before/after the apply. Differs from
   *  `optimisticallyAppliedAmount` when the target was already at
   *  HP=0 (clamped no-op) — `applyDamage` returns early without
   *  changing HP, so the actual delta is 0 even though the
   *  request asked for `optimisticallyAppliedAmount` damage.
   *
   *  The sweep's revert uses THIS field, not the requested
   *  amount: a 12-damage request that hit a dead target
   *  contributed 0 HP loss and should revert 0 HP, not 12. Without
   *  this, the sweep reverts push HP all the way back to maxHp
   *  (90+ phantom reverts clobbering the 7 actually-accepted
   *  broadcasts' optimistic applies), breaking the post-spam HP
   *  convergence assertion on the 5191 smoke. */
  actualAppliedDelta: number;
}

/** PR 11.6.D FIX 3: pending-map key is `${sourcePlayerId}:${eventId}`.
 *  Plain `eventId` would collide when two tabs both fire event #1
 *  (the server uses per-source monotonicity, so both fire events are
 *  legitimately accepted). With the composite key, Tab A's broadcast
 *  (source=1, event=1) and Tab B's broadcast (source=2, event=1) land
 *  in different map entries. */
type PendingKey = `${number}:${number}`;

function pendingKey(sourcePlayerId: number, eventId: number): PendingKey {
  return `${sourcePlayerId}:${eventId}` as PendingKey;
}

/** Per-(sourcePlayerId, eventId) map of optimistic applies awaiting
 *  broadcast confirmation (FIX 3). */
const pendingApplies = new Map<PendingKey, PendingOptimisticApply>();
const MAX_PENDING_APPLIES = 64;

// PR 11.6.D fix3: bounded `recentlySettled` map. When a pending entry
// is handled (confirmed via broadcast, reverted via mismatch,
// rejected via DamageReject, OR swept by the timeout sweep), we
// record the (sourcePlayerId, eventId) here for
// `RECENTLY_SETTLED_TTL_MS` so a late-arriving broadcast for the
// same key can be recognized as already-handled and ignored (don't
// double-apply). Without this map, `applyBroadcast`'s "no pending ->
// apply directly" branch would re-apply damage on re-delivered frames
// (WebSocket retries / GC stalls / late-arriving broadcasts after a
// timeout sweep).
//
// The SWEEP path marks settled because the sweep is the SAFETY-NET
// timeout fallback: if the server's broadcast or reject hasn't
// arrived within PENDING_REJECT_TIMEOUT_MS, the client has effectively
// given up on the server's view and reverted locally. Any broadcast
// arriving after the sweep is treated as "too late" — the entry
// is marked handled and the broadcast is ignored. This deterministic
// interpretation is what fixes the round-2 verifier's flaky smoke
// (FAIL-A / FAIL-B divergence from the sweep+re-apply interleaving).
//
// The queue-overflow DROP path does NOT mark settled. The drop evicts
// an entry that may have been ACCEPTED by the server but whose
// broadcast hasn't arrived yet — the broadcast arriving later MUST
// re-apply the damage so the client's HP converges with the server's
// view. Marking overflow-drops as settled would silently lose those
// accepted fires in the spam scenario.
const recentlySettled = new Map<PendingKey, number>();
/** TTL for the recentlySettled map: 2 * PENDING_REJECT_TIMEOUT_MS.
 *  Generous so a late broadcast (e.g., re-ordered WebSocket frame, GC
 *  stall) still gets ignored, but bounded so the map can't grow
 *  unboundedly. Pruned each `sweepExpiredPending` call (every 50ms
 *  in the smoke). */
const RECENTLY_SETTLED_TTL_MS = 1000;

function markSettled(key: PendingKey, nowMs: number): void {
  recentlySettled.set(key, nowMs);
}

/** PR 11.6.D fix3: track an optimistic apply. If the queue is at
 *  capacity, drop the OLDEST entry - but FIRST revert its optimistic
 *  apply (Bug 1) so its HP subtraction doesn't stay stuck forever.
 *  The revert uses the same `applyDamage(target, {source: "correction",
 *  amount: -pending.optimisticallyAppliedAmount}, nowMs)` pattern the
 *  sweep / applyReject paths use, plus a tracer flash for HUD
 *  visibility (the spam phase makes the tracer HUD useful for
 *  verification).
 *
 *  NOTE: we do NOT mark the dropped entry as recentlySettled. The
 *  broadcast handler must re-apply the damage if the server accepted
 *  the request before the local queue overflowed (Bug 2 - see commit
 *  body for the full discussion). Marking swept/dropped entries as
 *  settled caused accepted fires to be silently lost in the spam
 *  scenario, leaving Tab A's remote HP diverged from Tab B's local.
 */
function trackOptimisticApply(p: PendingOptimisticApply): PendingOptimisticApply | null {
  let dropped: PendingOptimisticApply | null = null;
  if (pendingApplies.size >= MAX_PENDING_APPLIES) {
    let oldestKey: PendingKey | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [k, v] of pendingApplies) {
      if (v.appliedAtMs < oldestAt) {
        oldestAt = v.appliedAtMs;
        oldestKey = k;
      }
    }
    if (oldestKey !== null) {
      dropped = pendingApplies.get(oldestKey) ?? null;
      if (dropped) {
        // Bug 1 fix: revert the dropped entry's optimistic apply BEFORE
        // removing from the map. Without this, the -amount stays
        // stuck on HP forever (the entry was dropped from the queue
        // but its HP decrement was already committed via
        // applyDamage at send time). On the spam path this leaks
        // ~N*amount HP per queue-overflow cycle.
        // PR 11.6.D fix4 (Bug C — actualDelta revert): revert
        // only the actual HP delta, not the requested amount.
        // When the optimistic apply was a clamped no-op (target
        // already at HP=0) the actual delta is 0 and the revert
        // is a +0 = no-op, preserving the post-spam HP convergence
        // invariant (without this the 65th fire at HP=0 would
        // still drop a queue entry that "lost 1 HP" and the
        // revert would silently un-clamp back to 1 HP under some
        // edge cases).
        applyDamage(
          dropped.targetController,
          {source: "correction", amount: -dropped.actualAppliedDelta},
          p.appliedAtMs,
        );
        emitTracerFlash({
          type: "rejection",
          targetPlayerId: dropped.targetPlayerId,
          sourcePlayerId: dropped.sourcePlayerId,
          eventId: dropped.eventId,
          appliedAmount: dropped.actualAppliedDelta,
          broadcastAmount: 0, // dropped - no broadcast amount
          atMs: p.appliedAtMs,
        });
        // PR 11.6.D fix4 (Bug B — re-apply on dropped entry):
        // mark the dropped entry as recentlySettled BEFORE deleting
        // it from the pending map. Without this, a broadcast for
        // the dropped (source, eventId) arriving after the drop
        // finds no pending entry via `forgetOptimisticApply`,
        // falls through to the "no pending -> apply directly"
        // branch in `applyBroadcast`, and re-applies the damage —
        // exactly what we just reverted. With the settled-mark,
        // the same late broadcast is treated as "already handled"
        // and returns "ignored" (RECENTLY_SETTLED_TTL_MS window).
        // This closes the round-2 verifier's Mode X regression
        // where the spam phase under-counted because dropped
        // entries were silently re-acknowledged by their own late
        // broadcast.
        markSettled(oldestKey, p.appliedAtMs);
        pendingApplies.delete(oldestKey);
      }
    }
  }
  pendingApplies.set(pendingKey(p.sourcePlayerId, p.eventId), p);
  return dropped;
}

function forgetOptimisticApply(
  sourcePlayerId: number,
  eventId: number,
): PendingOptimisticApply | null {
  const key = pendingKey(sourcePlayerId, eventId);
  const v = pendingApplies.get(key);
  if (v !== undefined) pendingApplies.delete(key);
  return v ?? null;
}

export function peekPendingApply(
  sourcePlayerId: number,
  eventId: number,
): PendingOptimisticApply | null {
  return pendingApplies.get(pendingKey(sourcePlayerId, eventId)) ?? null;
}

export function pendingApplyCount(): number {
  return pendingApplies.size;
}

// -- Typed send wrappers --------------------------------------------------

/**
 * PR 11.6.D / §3.9 — client-side damage prediction entry point.
 * Sends the request to the server AND applies the damage locally
 * optimistically, tracking the apply by `req.eventId` so the
 * upcoming broadcast can confirm or revert it.
 *
 * If the server's broadcast arrives with a DIFFERENT amount (e.g.
 * lag comp rewound and missed, or the fire was out of range, or the
 * server clamped the amount), `applyBroadcast` will revert with the
 * negative-amount correction path (see `health.ts`).
 *
 * Returns the eventId for caller-side chaining.
 */
export function sendDamageRequest(
  t: ServerTransport,
  req: DamageRequest,
  targetController: CharacterController,
  nowMs: number,
  sourcePlayerId: number,
  targetPlayerId: number,
): number {
  const sourceKind: "fire" | "melee" = req.source === 0 ? "fire" : "melee";
  // 1. Apply locally first (the optimistic apply).
  // PR 11.6.D fix4 (Bug C — actualDelta capture): sample the
  // target's HP before/after the apply so the sweep's revert
  // path knows the TRUE HP delta. If the target was already at
  // HP=0 (clamped no-op) the actual delta is 0 even though
  // `optimisticallyAppliedAmount` is the full request amount;
  // without this distinction the sweep reverts phantom losses
  // and the post-spam HP converges to maxHp instead of the
  // server's broadcast-bounded value.
  const hpBefore = targetController.state.hp;
  applyDamage(targetController, {source: sourceKind, amount: req.amount}, nowMs);
  const hpAfter = targetController.state.hp;
  const actualAppliedDelta = hpBefore - hpAfter;
  trackOptimisticApply({
    sourcePlayerId,
    eventId: req.eventId,
    targetPlayerId,
    targetController,
    source: sourceKind,
    amount: req.amount,
    appliedAtMs: nowMs,
    optimisticallyAppliedAmount: req.amount,
    actualAppliedDelta,
  });
  // 2. Send the wire packet to the server.
  t.sendDamageRequest(req);
  return req.eventId;
}

/** Send a typed `PositionUpdate` over the transport. */
export function sendPositionUpdate(t: ServerTransport, pu: PositionUpdate): void {
  t.sendPositionUpdate(pu);
}

/**
 * PR 11.6.D / §3.10 — 32Hz PositionUpdate sender. The caller invokes
 * this every tick; the helper throttles to every other tick at 64Hz.
 * Returns `true` if the packet was sent.
 */
export function sendPositionUpdateThrottled(
  t: ServerTransport,
  frameCounter: number,
  playerId: number,
  positionX: number,
  positionY: number,
): boolean {
  if (frameCounter % POSITION_UPDATE_SEND_EVERY_N_TICKS !== 0) return false;
  t.sendPositionUpdate({
    serverFrame: frameCounter,
    playerId,
    positionX,
    positionY,
  });
  return true;
}

/** Send a typed `Ping` over the transport. */
export function sendPing(t: ServerTransport, p: Ping): void {
  t.sendPing(p);
}

/** Send an `InputsServer` packet (PR 11.7 consumer; smoke drives this
 *  directly in PR 11.6.C). */
export function sendInputsServer(t: ServerTransport, i: InputsServer): void {
  t.sendInputs(i);
}

// -- Broadcast handler (§3.9) --------------------------------------------

export type BroadcastResult = "confirm" | "revert" | "applied" | "ignored";

interface TracerFlashEvent {
  type: "rejection" | "confirm";
  targetPlayerId: number;
  sourcePlayerId: number;
  eventId: number;
  appliedAmount: number;
  broadcastAmount: number;
  atMs: number;
}
type TracerFlashListener = (ev: TracerFlashEvent) => void;
const tracerFlashListeners: TracerFlashListener[] = [];
let lastTracerFlash: TracerFlashEvent | null = null;
export function onTracerFlash(f: TracerFlashListener): void {
  tracerFlashListeners.push(f);
}
export function getLastTracerFlash(): TracerFlashEvent | null {
  return lastTracerFlash;
}
function emitTracerFlash(ev: TracerFlashEvent): void {
  lastTracerFlash = ev;
  for (const f of tracerFlashListeners) f(ev);
}

/**
 * PR 11.6.D / §3.9 — invoked by `ServerTransport.onDamageBroadcast`
 * (wired in `scene.ts`'s DEV probe block). Implements three paths:
 *   1. Optimistic match (broadcast amount === applied amount) → confirm.
 *   2. Optimistic mismatch (broadcast amount differs) → REVERT + emit
 *      HUD tracer flash event.
 *   3. No matching pending apply → apply directly (someone else's fire).
 */
export function applyBroadcast(
  bc: DamageBroadcast,
  nowMs: number,
  resolveTarget?: (playerId: number) => CharacterController | null,
): BroadcastResult {
  // FIX 3: use (sourcePlayerId, eventId) for the lookup — NOT
  // eventId alone. Tab A's own fire (source=1, event=1) and Tab B's
  // fire (source=2, event=1) are DIFFERENT pending entries.
  const bcKey = pendingKey(bc.sourcePlayerId, bc.originEventId);
  // PR 11.6.D fix3 (Bug 2): check `recentlySettled` BEFORE the
  // `forgetOptimisticApply` lookup. If this (source, eventId) was
  // already handled (confirm, revert, OR sweep within the last
  // RECENTLY_SETTLED_TTL_MS), the broadcast is a late arrival for
  // an already-settled entry — return "ignored" so the "no pending
  // -> apply directly" branch below doesn't re-apply damage. This
  // is the root cause of the round-2 verifier's flaky smoke.
  const settledAt = recentlySettled.get(bcKey);
  if (settledAt !== undefined && nowMs - settledAt < RECENTLY_SETTLED_TTL_MS) {
    return "ignored";
  }
  const pending = forgetOptimisticApply(bc.sourcePlayerId, bc.originEventId);
  if (pending) {
    if (bc.amount === pending.optimisticallyAppliedAmount) {
      // PR 11.6.D fix4 (Bug C — clamped confirm convergence):
      // if the optimistic apply was clamped at HP=0 (actualDelta
      // < bc.amount), the source tab's local HP didn't decrement
      // for this fire. The target tab (which receives the same
      // broadcast via the "no pending -> apply" path below)
      // DOES decrement by bc.amount, leaving the source 12 HP
      // too high per affected fire. Close the gap by applying
      // the remaining damage now so the source's HP converges
      // with the target's. Without this, the post-spam
      // convergence assertion fails (Tab A remote=16 vs Tab B
      // local=4 — the 12 HP difference is exactly one clamped
      // accepted fire that didn't propagate).
      //
      // NOTE: applyDamage clamps at HP=0, so this fix only
      // helps when the source's HP is still > 0 at the time
      // the broadcast arrives (the spam scenario in the 5191
      // smoke has HP oscillating due to interleaved reverts, so
      // this is generally true for the LAST accepted fire).
      if (pending.actualAppliedDelta < bc.amount) {
        const remainingDamage = bc.amount - pending.actualAppliedDelta;
        const sourceKind: "fire" | "melee" = bc.source === 0 ? "fire" : "melee";
        applyDamage(
          pending.targetController,
          {source: sourceKind, amount: remainingDamage},
          nowMs,
        );
        emitTracerFlash({
          type: "confirm",
          targetPlayerId: bc.targetPlayerId,
          sourcePlayerId: bc.sourcePlayerId,
          eventId: bc.originEventId,
          appliedAmount: pending.actualAppliedDelta + remainingDamage,
          broadcastAmount: bc.amount,
          atMs: nowMs,
        });
      } else {
        emitTracerFlash({
          type: "confirm",
          targetPlayerId: bc.targetPlayerId,
          sourcePlayerId: bc.sourcePlayerId,
          eventId: bc.originEventId,
          appliedAmount: pending.optimisticallyAppliedAmount,
          broadcastAmount: bc.amount,
          atMs: nowMs,
        });
      }

      // re-delivered broadcast (e.g., WebSocket retry, broadcast
      // arriving after a successful sweep) doesn't double-apply.
      markSettled(bcKey, nowMs);
      return "confirm";
    }
    // Mismatch → revert the optimistic apply. PR 11.6.D fix4
    // (Bug C — actualDelta): use the actual HP delta not the
    // requested amount (a clamped no-op apply contributes 0
    // and should revert 0).
    applyDamage(
      pending.targetController,
      {source: "correction", amount: -pending.actualAppliedDelta},
      nowMs,
    );
    emitTracerFlash({
      type: "rejection",
      targetPlayerId: bc.targetPlayerId,
      sourcePlayerId: bc.sourcePlayerId,
      eventId: bc.originEventId,
      appliedAmount: pending.actualAppliedDelta,
      broadcastAmount: bc.amount,
      atMs: nowMs,
    });
    // Bug 2 fix: record this (source, eventId) as settled.
    markSettled(bcKey, nowMs);
    return "revert";
  }
  const target = resolveTarget?.(bc.targetPlayerId) ?? null;
  if (!target) {
    return "ignored";
  }
  const sourceKind: "fire" | "melee" = bc.source === 0 ? "fire" : "melee";
  applyDamage(target, {source: sourceKind, amount: bc.amount}, nowMs);
  return "applied";
}

// -- Reject + sweep handlers (FIX 4) -------------------------------------

/**
 * PR 11.6.D FIX 4: private reject from the server. When the
 * validator rejects a `DamageRequest` (fire-rate, ammo, eventId,
 * lag-miss, no-history), the server sends a `DamageReject` back to
 * the source tab only. The source uses this to revert its
 * optimistic apply via the same `applyDamage(target, {source:
 * "correction", amount: -appliedAmount}, nowMs)` path.
 */
export function applyReject(
  sourcePlayerId: number,
  eventId: number,
  nowMs: number,
): BroadcastResult {
  const pending = forgetOptimisticApply(sourcePlayerId, eventId);
  if (!pending) {
    return "ignored";
  }
  // Revert via the negative-amount correction path. PR 11.6.D
  // fix4 (Bug C — actualDelta): use the actual HP delta so the
  // revert is a no-op when the original optimistic apply was
  // clamped (HP already at 0).
  applyDamage(
    pending.targetController,
    {source: "correction", amount: -pending.actualAppliedDelta},
    nowMs,
  );
  emitTracerFlash({
    type: "rejection",
    targetPlayerId: pending.targetPlayerId,
    sourcePlayerId,
    eventId,
    appliedAmount: pending.actualAppliedDelta,
    broadcastAmount: 0, // rejected — no broadcast amount
    atMs: nowMs,
  });
  // Bug 2 fix: record this (source, eventId) as settled so a
  // late broadcast for the same key returns "ignored".
  markSettled(pendingKey(sourcePlayerId, eventId), nowMs);
  return "revert";
}

/** PR 11.6.D FIX 4: timeout fallback. The server's `DamageReject` may
 *  be dropped (channel full, network blip). If a pending apply
 *  hasn't seen a broadcast or reject within `PENDING_REJECT_TIMEOUT_MS`,
 *  revert it. This is the safety net for the spam-phase scenario
 *  where the server rejects faster than it can fan out rejects. */
export const PENDING_REJECT_TIMEOUT_MS = 500;

/** Sweep pending applies older than `PENDING_REJECT_TIMEOUT_MS`. Call
 *  periodically (e.g., every tick). Returns the number of pending
 *  applies reverted. */
export function sweepExpiredPending(nowMs: number): number {
  let swept = 0;
  for (const [key, pending] of pendingApplies) {
    if (nowMs - pending.appliedAtMs > PENDING_REJECT_TIMEOUT_MS) {
      // Revert the optimistic apply. PR 11.6.D fix4 (Bug C —
      // actualDelta revert): use the actual HP delta, not the
      // requested amount. A 12-damage request that hit an already-
      // dead target (applyDamage clamped no-op) should revert 0
      // HP, not 12. This prevents the post-spam sweep from
      // undoing HP damage that was never actually applied
      // (phantom reverts that would otherwise push HP all the
      // way back to maxHp, breaking the post-spam convergence
      // assertion on the 5191 smoke).
      applyDamage(
        pending.targetController,
        {source: "correction", amount: -pending.actualAppliedDelta},
        nowMs,
      );
      emitTracerFlash({
        type: "rejection",
        targetPlayerId: pending.targetPlayerId,
        sourcePlayerId: pending.sourcePlayerId,
        eventId: pending.eventId,
        appliedAmount: pending.actualAppliedDelta,
        broadcastAmount: 0,
        atMs: nowMs,
      });
      // Remove the entry from the pending map. Without this, the
      // entry stays in the map forever, so a late broadcast for the
      // same key finds it via forgetOptimisticApply, hits the
      // "confirm" path (since we did revert + mark settled would
      // catch the next one), and HP stays stuck at the reverted
      // value. This is the canonical round-2 verifier FAIL-A
      // symptom: Tab A's HP = 100 (everything reverted, nothing
      // re-applied), Tab B's HP = 4 (7 accepted broadcasts applied).
      pendingApplies.delete(key);
      // PR 11.6.D fix3 (Bug 2 — sweep marks settled): record this
      // (source, eventId) as settled so a late broadcast for the
      // same key returns "ignored" via the recentlySettled TTL
      // check in applyBroadcast. The sweep is the SAFETY-NET
      // timeout fallback — once the entry is reverted by the sweep,
      // the client has committed to that view and any subsequent
      // broadcast is treated as "too late" (no double-apply).
      markSettled(key, nowMs);
      swept++;
    }
  }
  // PR 11.6.D fix3 (Bug 2 maintenance): prune recentlySettled entries
  // older than TTL. Runs every 50ms in the smoke so the map can't
  // grow unboundedly even with sustained damage traffic.
  if (recentlySettled.size > 0) {
    for (const [k, ts] of recentlySettled) {
      if (nowMs - ts >= RECENTLY_SETTLED_TTL_MS) {
        recentlySettled.delete(k);
      }
    }
  }
  return swept;
}

/** PR 11.6.D FIX 4: also expose applyReject + sweep on the probe. */
export function getPendingApplyEntries(): PendingOptimisticApply[] {
  return Array.from(pendingApplies.values());
}

// -- Typed decode helpers -------------------------------------------------
//
// These accept the body-only buffer (the discriminator byte already
// stripped) so callers can dispatch on the discriminator first and
// then decode the body without re-counting bytes.

/** Decode a `DamageBroadcast` body. Returns null on size mismatch. */
export function decodeDamageBroadcastBody(buf: Uint8Array): DamageBroadcast | null {
  return decodeDamageBroadcast(buf);
}

/** Decode a `PositionUpdate` body. */
export function decodePositionUpdateBody(buf: Uint8Array): PositionUpdate | null {
  return decodePositionUpdate(buf);
}

/** Decode a `Ping` body. */
export function decodePingBody(buf: Uint8Array): Ping | null {
  return decodePing(buf);
}

/** Decode a `Pong` body. */
export function decodePongBody(buf: Uint8Array): Pong | null {
  return decodePong(buf);
}

// -- Outbound damage-request queue ---------------------------------------

/**
 * Bounded FIFO queue of outbound `DamageRequest`s. Used by PR 11.6.D's
 * client-side damage prediction (§3.9) so the predictor can see the
 * request that just fired AND any retries in the same frame.
 *
 * PR 11.6.C: defined + tested via the smoke. Not wired into
 * `gameSession.tick()` (PR 11.6.D's caller-side swap).
 */
export class DamageRequestQueue {
  private queue: DamageRequest[] = [];

  /** Append a request. If the queue overflows, the oldest request is
   *  dropped (returns the dropped request). */
  push(req: DamageRequest): DamageRequest | null {
    let dropped: DamageRequest | null = null;
    if (this.queue.length >= MAX_QUEUED) {
      dropped = this.queue.shift() ?? null;
    }
    this.queue.push(req);
    return dropped;
  }

  /** Peek the oldest request without removing it. */
  peek(): DamageRequest | null {
    return this.queue[0] ?? null;
  }

  /** Remove + return the oldest request. */
  pop(): DamageRequest | null {
    return this.queue.shift() ?? null;
  }

  /** Current depth. */
  size(): number {
    return this.queue.length;
  }

  /** Drop all entries. */
  clear(): void {
    this.queue = [];
  }
}

// -- Smoke-facing DEV probe -----------------------------------------------

/**
 * DEV-only surface that the smoke drives directly. Wired by
 * `scene.ts` (gated behind `import.meta.env.DEV`). NOT consumed by
 * production code; verified by `grep '__damageBus' dist/assets/index-*.js`
 * returning ZERO matches in `npm run build`.
 *
 * The probe exposes the typed send wrappers + a `DamageRequestQueue`
 * + the inbound `DamageBroadcast` listener hook (so the smoke can
 * assert the server's synthetic broadcast reply). Production code
 * should use the typed wrappers directly via the transport.
 */
export interface DamageBusProbe {
  /** PR 11.6.D / §3.9: send a damage request AND apply locally optimistically. */
  sendDamageRequest: (
    req: DamageRequest,
    targetController: CharacterController,
    nowMs: number,
  ) => number;
  /** Send a typed `PositionUpdate` through the live transport. */
  sendPositionUpdate: (pu: PositionUpdate) => void;
  /** PR 11.6.D / §3.10: throttled PositionUpdate sender. */
  sendPositionUpdateThrottled: (
    frameCounter: number,
    playerId: number,
    positionX: number,
    positionY: number,
  ) => boolean;
  /** Send a typed `Ping` through the live transport. */
  sendPing: (p: Ping) => void;
  /** Register an inbound `DamageBroadcast` listener. */
  onDamageBroadcast: (f: (bc: DamageBroadcast) => void) => void;
  /** PR 11.6.D FIX 4: register a DamageReject listener. The
   *  probe wraps the server transports listener to decode the
   *  body and pass a typed DamageReject to the callback.
   *  Typically wired to applyReject(localPlayerId, r.eventId, now). */
  onDamageReject: (f: (r: DamageReject) => void) => void;
  /** Register an inbound `Pong` listener. */
  onPong: (f: (p: Pong) => void) => void;
  /** Get a snapshot of the live transport stats. */
  getStats: () => {rttMs: number; transport?: string; connected: boolean};
  /** Get (or create) the outbound damage request queue. */
  getQueue: () => DamageRequestQueue;
  /** Register a tracer-flash listener (PR 11.6.D HUD integration). */
  onTracerFlash: (f: (ev: TracerFlashEvent) => void) => void;
  /** Get the most recent tracer-flash event (smoke / debug). */
  getLastTracerFlash: () => TracerFlashEvent | null;
  /** Snapshot the pending optimistic apply count (smoke / debug). */
  pendingApplyCount: () => number;
  /** Invoke `applyBroadcast` directly with a custom controller resolver
   *  (smoke / debug — production wires the default resolver). */
  applyBroadcast: (
    bc: DamageBroadcast,
    nowMs: number,
    resolveTarget?: (playerId: number) => CharacterController | null,
  ) => BroadcastResult;
  /** PR 11.6.D FIX 4: invoke `applyReject` (smoke / debug). */
  applyReject: (sourcePlayerId: number, eventId: number, nowMs: number) => BroadcastResult;
  /** PR 11.6.D FIX 4: sweep expired pending applies (smoke / debug). */
  sweepExpiredPending: (nowMs: number) => number;
  /** PR 11.6.D FIX 4: get all pending apply entries as an array. */
  getPendingApplyEntries: () => unknown[];
  /** Re-export the typed encoder/decoder functions so the smoke can
   *  inspect wire bytes without re-importing `protocol/damage`. */
  encodeDamageRequest: typeof encodeDamageRequest;
  encodePositionUpdate: typeof encodePositionUpdate;
  encodePing: typeof encodePing;
  encodeDamageBroadcast: typeof encodeDamageBroadcast;
  encodeInputsServer: typeof encodeInputsServer;
  decodeDamageBroadcast: typeof decodeDamageBroadcast;
  decodePositionUpdate: typeof decodePositionUpdate;
  decodePing: typeof decodePing;
  decodePong: typeof decodePong;
}

export function createDamageBusProbe(t: ServerTransport): DamageBusProbe {
  const queue = new DamageRequestQueue();
  return {
    sendDamageRequest: ((
      req: DamageRequest,
      targetController?: CharacterController,
      nowMs?: number,
      sourcePlayerId?: number,
      targetPlayerId?: number,
    ) => {
      queue.push(req);
      // PR 11.6.D / §3.9 — when `targetController`, `nowMs`,
      // `sourcePlayerId`, AND `targetPlayerId` are supplied, apply
      // optimistically + track in pendingApplies (the new PR 11.6.D
      // flow). Otherwise, just send the wire packet (PR 11.6.C smoke
      // path — no optimistic apply, no pending tracking).
      if (
        targetController !== undefined &&
        nowMs !== undefined &&
        sourcePlayerId !== undefined &&
        targetPlayerId !== undefined
      ) {
        return sendDamageRequest(t, req, targetController, nowMs, sourcePlayerId, targetPlayerId);
      }
      t.sendDamageRequest(req);
      return req.eventId;
    }) as {
      // PR 11.6.D overload (with optimistic apply + composite key)
      (
        req: DamageRequest,
        targetController: CharacterController,
        nowMs: number,
        sourcePlayerId: number,
        targetPlayerId: number,
      ): number;
      // PR 11.6.C overload (send only — used by the 5190 smoke)
      (req: DamageRequest): number;
    },
    sendPositionUpdate: (pu) => sendPositionUpdate(t, pu),
    sendPositionUpdateThrottled: (frameCounter, playerId, positionX, positionY) =>
      sendPositionUpdateThrottled(t, frameCounter, playerId, positionX, positionY),
    sendPing: (p) => sendPing(t, p),
    onDamageBroadcast: (f) => {
      t.onDamageBroadcast((body) => {
        const bc = decodeDamageBroadcast(body);
        if (bc) f(bc);
      });
    },
    onDamageReject: (f) => {
      t.onDamageReject((body) => {
        const r = decodeDamageReject(body);
        if (r) f(r);
      });
    },
    onPong: (f) => {
      t.onPong((body) => {
        const p = decodePong(body);
        if (p) f(p);
      });
    },
    getStats: () => t.getStats(),
    getQueue: () => queue,
    onTracerFlash,
    getLastTracerFlash,
    pendingApplyCount,
    applyBroadcast,
    applyReject,
    sweepExpiredPending,
    getPendingApplyEntries,
    encodeDamageRequest,
    encodePositionUpdate,
    encodePing,
    encodeDamageBroadcast,
    encodeInputsServer,
    decodeDamageBroadcast,
    decodePositionUpdate,
    decodePing,
    decodePong,
  };
}
