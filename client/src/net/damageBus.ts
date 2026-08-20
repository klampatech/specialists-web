// PR 11.7.D / §4.4 — Option B: drop optimistic-apply entirely.
//
// **PR 11.7.D scope (Option B — drop optimistic-apply)**:
//   - `sendDamageRequest(t, req, ...)` is now a PURE send. No local
//     optimistic apply, no pending-map tracking, no sweep. Clients send
//     a `DamageRequest` and WAIT for the server's `DamageBroadcast`
//     before any HP change is visible.
//   - `applyBroadcast(bc, nowMs, resolveTarget?)` is the single apply
//     path: if the target controller exists, apply the damage once. No
//     confirm/revert/ignored dedup — the server is authoritative.
//
// **Why this change**: the §4.4 12-HP post-spam divergence was a
// server-side broadcast drop (PR 11.7.B's 20Hz snapshot stream fills the
// per-connection `mpsc::channel(64)` faster than headless Chromium's WS
// outbound drains, causing `damage_relay::try_send` to fail and the
// broadcast to be silently discarded) that manifested as a persistent
// client-side divergence only because the optimistic-apply + sweep
// created a divergence window for the dropped broadcast's optimistic HP
// delta. Removing the optimistic-apply machinery eliminates the
// divergence window. Clients wait +1 RTT (60-150ms localhost,
// 50-200ms Tailscale) per fire for the broadcast; if a broadcast is
// dropped, no persistent gap accumulates — the next successful broadcast
// brings the client back in sync.
//
// **Out of scope** (separate work, NOT touched here):
//   - Server-side outbound channel overflow (PR 11.7.D's bandwidth work).
//   - Lockstep substrate retirement (`ggrsRuntime`, `peer`, P2P transport).
//   - 0x06 InputSeq trailer.
//   - Interpolator → remote-visual wiring.
//
// **Wire format**: byte-identical. `DamageRequest`, `DamageBroadcast`,
// `DamageReject`, `Snapshot` sizes + discriminators unchanged.
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

// -- Typed send wrappers --------------------------------------------------

/**
 * PR 11.7.D / §4.4 — Option B: pure send. No optimistic apply, no
 * pending-map tracking, no sweep. Clients send-and-wait for the server's
 * `DamageBroadcast`.
 *
 * The 4 trailing args are kept for call-site compat (gameSession.tick
 * + the smoke) but are no-ops after Option B. They used to drive the
 * optimistic apply (targetController + nowMs + source/targetPlayerId).
 * Now they are ignored — the server is authoritative, and the broadcast
 * handler in `scene.ts` does the actual `applyDamage` call when the
 * server's fan-out arrives.
 *
 * Returns the eventId for caller-side chaining (event-id accounting +
 * tracer HUD wiring).
 */
export function sendDamageRequest(
  _t: ServerTransport,
  req: DamageRequest,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _targetController: CharacterController | null,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _nowMs: number,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _sourcePlayerId: number,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _targetPlayerId: number,
): number {
  _t.sendDamageRequest(req);
  return req.eventId;
}

/** Send a typed `PositionUpdate` over the transport. */
export function sendPositionUpdate(t: ServerTransport, pu: PositionUpdate): void {
  t.sendPositionUpdate(pu);
}

/**
 * PR 11.7.D / §3.10 — 32Hz PositionUpdate sender. The caller invokes
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

// -- Broadcast handler (PR 11.7.D / §4.4 — single-apply path) --------------

export type BroadcastResult = "applied" | "ignored";

// PR 11.7.D / §4.4 — TracerFlashEvent, tracerFlashListeners, and
// emitTracerFlash are REMOVED. Pre-Option-B the optimistic-apply
// confirm/revert paths emitted tracer-flash events for the HUD
// (e.g., the "no damage" rejection flash). With optimistic-apply
// gone there's nothing to confirm or revert — the server's
// broadcast is the single apply path. The HUD tracer line visual
// (the orange line drawn between shooter and target on fire) is
// driven separately by gameSession.combatEvents + scene.ts's tracer
// rendering. We keep `onTracerFlash` + `getLastTracerFlash` exported
// for probe compatibility (the smoke may wire these in a future PR)
// but the implementation is now a no-op (no listeners + no events).
type TracerFlashListener = (_ev: never) => void;
export function onTracerFlash(_f: TracerFlashListener): void {
  // No-op after Option B. Kept exported for future use.
}
export function getLastTracerFlash(): null {
  // No-op after Option B. Kept exported for future use.
  return null;
}

/**
 * PR 11.7.D / §4.4 — Option B: single-apply broadcast handler. Invoked
 * by `ServerTransport.onDamageBroadcast` (wired in `scene.ts`).
 *
 * Contract: if `resolveTarget(bc.targetPlayerId)` returns a controller,
 * apply the damage once and return `"applied"`. Otherwise return
 * `"ignored"` (no controller available — the broadcast is dropped).
 *
 * There is no confirm/revert path because there is no local pending
 * state to confirm or revert: clients are send-and-wait (Option B). If
 * the server's broadcast is dropped (the §4.4 channel-overflow case),
 * the client's HP simply stays at the prior value for one more RTT; the
 * next successful broadcast brings the client back in sync. No persistent
 * divergence accumulates.
 *
 * NOTE: this function is intentionally idempotent on repeated calls
 * with the same broadcast — every broadcast decrements HP. The server
 * is the authoritative source of damage events; a re-delivered
 * WebSocket frame (retry, GC stall) does decrement again. The
 * authoritative dedup is the server-side `validate_and_relay`'s
 * monotonic-eventId gate, not the client.
 */
export function applyBroadcast(
  bc: DamageBroadcast,
  _nowMs: number,
  resolveTarget?: (playerId: number) => CharacterController | null,
): BroadcastResult {
  const target = resolveTarget?.(bc.targetPlayerId) ?? null;
  if (!target) {
    return "ignored";
  }
  const sourceKind: "fire" | "melee" = bc.source === 0 ? "fire" : "melee";
  applyDamage(target, {source: sourceKind, amount: bc.amount}, performance.now());
  return "applied";
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
 * Bounded FIFO queue of outbound `DamageRequest`s. Used by the smoke
 * (and any future caller-side batching) so the predictor can see the
 * request that just fired AND any retries in the same frame.
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
 * + the inbound `DamageBroadcast` / `DamageReject` listener hooks
 * (so the smoke can observe the server's fan-out). Production code
 * should use the typed wrappers directly via the transport.
 *
 * **PR 11.7.D / §4.4 Option B**: the probe shape shrunk — the
 * optimistic-apply / pending-map / sweep methods are gone (they had no
 * clients after the machinery was removed). The probe's `sendDamageRequest`
 * still accepts the 5-arg form for call-site compat with the smoke +
 * `gameSession.tick`; the trailing args are no-ops now.
 */
export interface DamageBusProbe {
  /** PR 11.7.D / §4.4: send a damage request. Pure send — no
   *  optimistic apply. The 4 trailing args are unused but kept for
   *  call-site compat (smoke + gameSession.tick signature). */
  sendDamageRequest: (
    req: DamageRequest,
    targetController: CharacterController | null,
    nowMs: number,
    sourcePlayerId: number,
    targetPlayerId: number,
  ) => number;
  /** Send a typed `PositionUpdate` through the live transport. */
  sendPositionUpdate: (pu: PositionUpdate) => void;
  /** PR 11.7.D / §3.10: throttled PositionUpdate sender. */
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
  /** Register an inbound `DamageReject` listener. The server still
   *  emits `DamageReject` for fire-rate / ammo / event-id violations;
   *  after PR 11.7.D Option B the client has no local pending state to
   *  revert, so the reject is informational only (logged via the
   *  probe's listener + the smoke's `__rejectHandlerCount` counter). */
  onDamageReject: (f: (r: DamageReject) => void) => void;
  /** Register an inbound `Pong` listener. */
  onPong: (f: (p: Pong) => void) => void;
  /** Get a snapshot of the live transport stats. */
  getStats: () => {rttMs: number; transport?: string; connected: boolean};
  /** Get (or create) the outbound damage request queue. */
  getQueue: () => DamageRequestQueue;
  /** Register a tracer-flash listener. PR 11.7.D / §4.4 Option B:
   *  the emit path is gone (no confirm/revert events). Kept exported
   *  for future use / probe compat. */
  onTracerFlash: (f: (ev: never) => void) => void;
  /** Get the most recent tracer-flash event. Returns null — no
   *  events are emitted after Option B. Kept exported for future use. */
  getLastTracerFlash: () => null;
  /** Invoke `applyBroadcast` directly with a custom controller resolver
   *  (smoke / debug — production wires the default resolver). */
  applyBroadcast: (
    bc: DamageBroadcast,
    nowMs: number,
    resolveTarget?: (playerId: number) => CharacterController | null,
  ) => BroadcastResult;
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
    sendDamageRequest: (
      req: DamageRequest,
      targetController: CharacterController | null,
      nowMs: number,
      sourcePlayerId: number,
      targetPlayerId: number,
    ): number => {
      queue.push(req);
      // PR 11.7.D / §4.4 Option B: pure send. The 4 trailing args are
      // unused (kept for call-site compat with the smoke +
      // gameSession.tick signature). The server is authoritative; the
      // broadcast handler in scene.ts does the actual applyDamage when
      // the server's fan-out arrives.
      return sendDamageRequest(t, req, targetController, nowMs, sourcePlayerId, targetPlayerId);
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
    applyBroadcast,
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
