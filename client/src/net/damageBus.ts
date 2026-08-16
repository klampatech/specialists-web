// PR 11.6.C / §3.5 + §3.6 — typed wrappers over the wire codecs +
// outbound queue for damage requests.
//
// **PR 11.6.C scope**: this file defines the typed wrappers
// (`sendDamageRequest`, `sendPositionUpdate`, `sendPing`) and re-exports
// the decoders. It does NOT wire into `gameSession.tick()` (that's PR
// 11.6.D's caller-side swap). PR 11.6.C's smoke drives these directly
// via `window.__damageBus` (DEV probe set up by `scene.ts`).
//
// **Why a queue**: PR 11.6.D adds client-side damage prediction (§3.9).
// Outbound damage requests queue up so the predictor can see the
// request that just fired AND any retries that arrive within the same
// frame. The queue is FIFO and bounded (capacity = 16 — far more than
// any per-frame firing rate could produce).
//
// **DEV probe**: PR 11.6.C surfaces the typed wrappers on
// `window.__damageBus` so the headless smoke can call them without
// having to instantiate a `GameSession`. The probe is gated behind
// `import.meta.env.DEV` in `scene.ts` so production bundles strip it
// (verified by `grep '__damageBus' dist/assets/index-*.js` → ZERO
// matches post-build).

import {
  decodeDamageBroadcast,
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
  DamageRequest,
  InputsServer,
  Ping,
  Pong,
  PositionUpdate,
} from "../../../protocol/damage";
import type {ServerTransport} from "./serverTransport";

// Keep the codec surface available from the typed bus as well as from the
// protocol module. PR 11.6.C review fix B2: the TS encoders now
// prefix the discriminator, so the returned wire bytes are the full
// packet (disc + body). The body-only decoders (`decodeXxxBody` below)
// take the buffer after `handleInbound` has stripped the discriminator.
export {
  decodeDamageBroadcast,
  decodePing,
  decodePong,
  decodePositionUpdate,
  encodeDamageBroadcast,
  encodeDamageRequest,
  encodeInputsServer,
  encodePing,
  encodePositionUpdate,
  DISCRIMINATOR_DAMAGE_BROADCAST,
  DISCRIMINATOR_DAMAGE_REQUEST,
  DISCRIMINATOR_INPUTS,
  DISCRIMINATOR_INPUTS_SERVER,
  DISCRIMINATOR_PING,
  DISCRIMINATOR_PONG,
  DISCRIMINATOR_POSITION_UPDATE,
  DAMAGE_BROADCAST_WIRE_SIZE,
  DAMAGE_REQUEST_WIRE_SIZE,
  INPUTS_SERVER_WIRE_SIZE,
  PING_WIRE_SIZE,
  PONG_WIRE_SIZE,
  POSITION_UPDATE_WIRE_SIZE,
} from "../../../protocol/damage";

/** Maximum outbound damage requests queued before oldest are dropped. */
const MAX_QUEUED = 16;

// -- Typed send wrappers --------------------------------------------------

/** Send a typed `DamageRequest` over the transport. */
export function sendDamageRequest(t: ServerTransport, req: DamageRequest): void {
  t.sendDamageRequest(req);
}

/** Send a typed `PositionUpdate` over the transport. */
export function sendPositionUpdate(t: ServerTransport, pu: PositionUpdate): void {
  t.sendPositionUpdate(pu);
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
  /** Send a typed `DamageRequest` through the live transport. */
  sendDamageRequest: (req: DamageRequest) => void;
  /** Send a typed `PositionUpdate` through the live transport. */
  sendPositionUpdate: (pu: PositionUpdate) => void;
  /** Send a typed `Ping` through the live transport. */
  sendPing: (p: Ping) => void;
  /** Register an inbound `DamageBroadcast` listener. */
  onDamageBroadcast: (f: (bc: DamageBroadcast) => void) => void;
  /** Register an inbound `Pong` listener. */
  onPong: (f: (p: Pong) => void) => void;
  /** Get a snapshot of the live transport stats. */
  getStats: () => {rttMs: number; transport?: string; connected: boolean};
  /** Get (or create) the outbound damage request queue. */
  getQueue: () => DamageRequestQueue;
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
    sendDamageRequest: (req) => {
      queue.push(req);
      sendDamageRequest(t, req);
    },
    sendPositionUpdate: (pu) => sendPositionUpdate(t, pu),
    sendPing: (p) => sendPing(t, p),
    onDamageBroadcast: (f) => {
      t.onDamageBroadcast((body) => {
        const bc = decodeDamageBroadcast(body);
        if (bc) f(bc);
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
