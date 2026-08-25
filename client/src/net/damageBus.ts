// PR 11.7.D / §4.4 closure — typed wrappers over the wire codecs +
// outbound queue. **Optimistic-apply machinery removed** (was PR 11.6.D's
// `pendingApplies` map + `sweepExpiredPending` + `recentlySettled`).
//
// Why drop optimistic-apply: the §4.4 HP-gap race lives entirely in
// the client-side optimistic-apply → sweep → revert window. The race
// is order-dependent: the sweep reverts an optimistic apply whose
// broadcast has already arrived (and confirmed) but the broadcast's
// apply path runs BEFORE the sweep's revert. Without optimistic-
// apply there is no client-side HP that can diverge from the
// server's authoritative view. The client sends; the server is the
// sole source of truth; broadcasts arrive and apply.
//
// Wire format is UNCHANGED. `sendDamageRequest` still encodes the
// same `DamageRequest` bytes. The only difference is that it no
// longer applies the damage locally before sending — it just sends.
// The server's `DamageBroadcast` arrives and `applyBroadcast` applies
// the damage (single path: "if target resolver returns a controller,
// apply; otherwise ignore").
//
// `DamageReject` is still decoded + dispatched (the server uses it
// for fire-rate / ammo / eventId rejections), but `applyReject`
// has no client-side pending state to clean up — it just logs.

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
// PR 11.7.E / §3.5 — ReloadRequest encoder/decoder. Mirror of the
// Rust `encode_reload_request` / `decode_reload_request`. The
// client only sends ReloadRequests (no inbound 0x09 dispatch —
// the server is the sole producer of the post-reload Snapshot
// that carries the new ammo value).
// PR 11.7.E / §3.5 — only the encoder + type are needed in this
// file (the typed sendReloadRequest helper). The decoder + size
// constants live in protocol/reload.ts for symmetry with the
// server-side decode_reload_request; they're not used here.
import type { ReloadRequest } from "../../../protocol/reload";
import type { ServerTransport } from "./serverTransport";
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
 * PR 11.7.D / §4.4 closure — pure-send DamageRequest. The server is
 * the SOLE source of truth for damage; this just encodes + sends.
 * No local optimistic apply (that path was the §4.4 race).
 *
 * The `targetController`, `nowMs`, `sourcePlayerId`, `targetPlayerId`
 * parameters are KEPT in the signature for now (PR 11.7.D / B2 will
 * remove them once `gameSession.ts`'s 4 fire/melee call sites drop
 * the optimistic-apply args). This lets B1 land + tsc-clean while
 * B2 cleans up the call sites in a separate commit.
 *
 * Returns the eventId for caller-side chaining.
 */
export function sendDamageRequest(
  t: ServerTransport,
  req: DamageRequest,
  // The next 4 args are kept temporarily for the B1→B2 migration.
  // They were used by the optimistic-apply path (PR 11.6.D); the path
  // is gone in PR 11.7.D, so these args are now ignored. Marked with
  // `_` prefix in the type signature so callers can drop them in
  // B2 without changing the call-site shape.
  _targetController?: CharacterController,
  _nowMs?: number,
  _sourcePlayerId?: number,
  _targetPlayerId?: number,
): number {
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

/**
 * PR 11.7.E / §3.5 — send a typed `ReloadRequest` over the transport.
 *
 * The server validates the request (`damage_relay::validate_and_relay_reload`,
 * 8 gates paralleling `validate_and_relay`) and on success mutates
 * `room.players[source].ammo = PLAYER_MAX_AMMO`. The next 20Hz Snapshot
 * broadcast (discriminator 0x07) carries the new ammo value to every
 * connected tab — no private ack packet (PR 11.7.E locked decision #4).
 *
 * The caller is responsible for the `eventId` monotonicity (the
 * `nextReloadEventId` helper below is the canonical counter). The
 * server's bounded-window gate (`RELOAD_EVENT_ID_WINDOW = 64`) allows
 * tab reloads to recover without invalidating subsequent requests.
 */
export function sendReloadRequest(
  t: ServerTransport,
  req: ReloadRequest,
): number {
  t.sendReloadRequest(req);
  return req.eventId;
}

/** Monotonic per-local-player counter for ReloadRequest eventIds.
 *  Mirrors the `nextEventId` counter in `gameSession.ts` (used for
 *  DamageRequest). The smoke drives this via `__reloadBus` to assert
 *  the server's bounded-window gate accepts the next reload. */
let _nextReloadEventId = 1;
export function nextReloadEventId(): number {
  return _nextReloadEventId++;
}
/** DEV-only: reset the counter. Tests / smokes reset between scenarios
 *  so the bounded-window math doesn't accidentally accumulate across
 *  runs. NOT exposed via the production probe — it's a side-effect of
 *  the vitest boundary tests, not a runtime API. */
export function _resetReloadEventIdForTests(next: number = 1): void {
  _nextReloadEventId = next;
}

// -- Broadcast handler ----------------------------------------------------

export type BroadcastResult = "applied" | "ignored";

/**
 * PR 11.7.D / §4.4 closure — invoked by `ServerTransport.onDamageBroadcast`
 * (wired in `scene.ts`'s DEV probe block). Single path: if the
 * resolver returns a controller for `bc.targetPlayerId`, apply the
 * damage; otherwise ignore.
 *
 * No optimistic-apply → confirm/revert path. The client doesn't try
 * to predict the server's broadcast outcome — it just waits for the
 * broadcast and applies it.
 */
export function applyBroadcast(
  bc: DamageBroadcast,
  nowMs: number,
  resolveTarget?: (playerId: number) => CharacterController | null,
): BroadcastResult {
  const target = resolveTarget?.(bc.targetPlayerId) ?? null;
  if (!target) {
    return "ignored";
  }
  const sourceKind: "fire" | "melee" = bc.source === 0 ? "fire" : "melee";
  applyDamage(target, { source: sourceKind, amount: bc.amount }, nowMs);
  return "applied";
}

// -- DamageReject handler -------------------------------------------------

/**
 * PR 11.7.D / §4.4 closure — DamageReject from the server. After
 * dropping optimistic-apply, there's no client-side pending state
 * to clean up: the request was never locally applied, so a reject
 * just means "server didn't accept it." Logged for dev visibility.
 *
 * The decoder is still wired (server emits DamageReject for fire-
 * rate / ammo / eventId violations) so the probe's `onDamageReject`
 * listener can observe them, but no HP revert is needed.
 */
export function applyReject(
  sourcePlayerId: number,
  eventId: number,
  _reason: number,
): BroadcastResult {
  console.debug(
    `[damageBus] DamageReject source=${sourcePlayerId} eventId=${eventId} reason=${_reason} (no client-side state to revert; optimistic-apply was removed in PR 11.7.D)`,
  );
  return "ignored";
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
 * Bounded FIFO queue of outbound `DamageRequest`s. Preserved from
 * PR 11.6.C for outbound FIFO + retry tracking; the optimistic-apply
 * removal in PR 11.7.D does NOT affect this queue (it's about *what
 * was sent*, not about *what was optimistically applied*).
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

// -- Smoke-facing DEV probe ----------------------------------------------

/**
 * DEV-only surface that the smoke drives directly. Wired by
 * `scene.ts` (gated behind `import.meta.env.DEV`). NOT consumed by
 * production code; verified by `grep '__damageBus' dist/assets/index-*.js`
 * returning ZERO matches in `npm run build`.
 *
 * After the PR 11.7.D / §4.4 closure the probe surface shrinks:
 *   - No `pendingApplyCount` / `applyReject` (no client state to manage)
 *   - No `sweepExpiredPending` / `getPendingApplyEntries` (no pending map)
 *   - No `onTracerFlash` / `getLastTracerFlash` (no HUD tracer flash for
 *     confirm/revert events; pure send-and-wait has no such events)
 *   - `applyBroadcast` now returns only `"applied" | "ignored"` (was
 *     `"confirm" | "revert" | "applied" | "ignored"`)
 */
export interface DamageBusProbe {
  /** PR 11.7.D: pure-send DamageRequest. No local apply. */
  sendDamageRequest: (req: DamageRequest) => number;
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
   *  probe wraps the server transport's listener to decode the
   *  body and pass a typed DamageReject to the callback. */
  onDamageReject: (f: (r: DamageReject) => void) => void;
  /** Register an inbound `Pong` listener. */
  onPong: (f: (p: Pong) => void) => void;
  /** Get a snapshot of the live transport stats. */
  getStats: () => { rttMs: number; transport?: string; connected: boolean };
  /** Get (or create) the outbound damage request queue. */
  getQueue: () => DamageRequestQueue;
  /** Invoke `applyBroadcast` directly with a custom controller resolver
   *  (smoke / debug — production wires the default resolver). */
  applyBroadcast: (
    bc: DamageBroadcast,
    nowMs: number,
    resolveTarget?: (playerId: number) => CharacterController | null,
  ) => BroadcastResult;
  /** PR 11.7.D / §4.4 closure: pending-apply count is always 0
   *  (no client-side pending map). Kept on the probe surface as a
   *  no-op so the 5191 smoke's diagnostic log lines (which call
   *  `__damageBus.pendingApplyCount()`) don't throw `pageerror`.
   *  Removed in PR B3 alongside `__broadcastHandlerCount` /
   *  `__broadcastTimestamps` instrumentation. */
  pendingApplyCount: () => number;
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
    sendDamageRequest: (req: DamageRequest) => {
      queue.push(req);
      return sendDamageRequest(t, req);
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
    applyBroadcast,
    pendingApplyCount: () => 0, // PR 11.7.D: no pending map. Removed in B3.
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