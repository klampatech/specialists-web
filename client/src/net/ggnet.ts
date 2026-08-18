import {WebRTCPeer} from "./peer";

// =============================================================================
// PR 11.6.C / §3.6 — GameTransport interface + impls.
//
// **What this PR adds**: a unified interface (`GameTransport`) for the
// transport layer that the rest of the client (PR 11.6.D's damageBus,
// the future PR 11.7 snapshot consumer) talks to. Two implementations
// live side-by-side:
//
//   - `P2PGgnetTransport` — wraps the existing `GgnetTransport` (WebRTC
//     peer). The new interface methods (sendDamageRequest /
//     onDamageBroadcast / etc.) throw `"not implemented in Phase 0"`
//     for now — they're unused until 11.6.D swaps them in.
//
//   - `ServerGgnetTransport` — wraps the new `ServerTransport` (see
//     `./serverTransport.ts`). Full interface. Used by the dev-box
//     smoke (`tools/damage-server-smoke.mjs`) and by PR 11.6.D's
//     end-to-end path.
//
// **scene.ts** chooses which one to instantiate based on a NEW
// constructor arg `useServerTransport: boolean` (default `false` to
// preserve existing behavior). The smoke toggles it on via the
// `__forceServerTransport` DEV probe (gated behind
// `import.meta.env.DEV`).
// =============================================================================

import type {ServerTransport} from "./serverTransport";

// -- Legacy WebRTC transport (unchanged from PR 11.6.B) ------------------

export class GgnetTransport {
  constructor(private peer: WebRTCPeer) {}
  send(p: Uint8Array): void {
    this.peer.send("inputs", p);
  }
  onPacket(f: (p: Uint8Array) => void): void {
    this.peer.on("packet", f);
  }
}

/**
 * PR 11.6.B / §1.2 seam #4 — snapshot-model awareness.
 *
 * Snapshot message — discriminator 0x07, introduced in PR 11.7.B.
 * (NOTE: PR 11.7.B bumped DamageReject from 0x07 to 0x0C to free this slot.)
 * PR 11.7 replaces per-player PositionUpdate with a single
 * `Snapshot { frame, [Position × N] }` message. ServerTransport will
 * dispatch this; P2PGgnetTransport will NOT (lockstep substrate retires
 * in 11.7). This comment is a seam marker; the message type arrives in
 * PR 11.7. Do not implement here.
 */

// =============================================================================
// GameTransport — the unified interface that the rest of the client uses.
// PR 11.6.C: defined + 2 impls. PR 11.6.D wires the caller-side (gameSession.tick
// + damageBus).
// =============================================================================

/**
 * The transport contract for game packets. Implementations:
 *   - `P2PGgnetTransport` — WebRTC peer (existing path, lockstep substrate).
 *     Most methods throw `"not implemented in Phase 0"` until PR 11.6.D.
 *   - `ServerGgnetTransport` — WebTransport + WebSocket (new path).
 *     Implements the full interface.
 *
 * Design contract (from §3.6):
 *   - All `sendX` methods are fire-and-forget — the transport buffers
 *     internally and may coalesce.
 *   - All `onX` methods register a listener; multiple listeners are
 *     allowed (the implementation may fan-out internally).
 *   - `getStats()` returns a snapshot of the current connection state.
 *     RTT in milliseconds (>= 0). Other fields may be added later.
 *   - `onDisconnect(f)` registers a disconnect listener that fires
 *     exactly once when the transport transitions to a closed state.
 *     Subsequent disconnects are NOT re-fired (callers should re-subscribe
 *     on reconnect).
 */
export interface GameTransport {
  /** Send a server-routed input packet (DISCRIMINATOR_INPUTS_SERVER).
   *  PR 11.6.C: ServerGgnetTransport implements this; P2PGgnetTransport
   *  throws (lockstep substrate). */
  sendInputs(p: Uint8Array): void;
  /** Receive a server-broadcast input packet. PR 11.6.D consumer. */
  onInputs(f: (p: Uint8Array) => void): void;

  /** Send a DamageRequest (DISCRIMINATOR_DAMAGE_REQUEST). */
  sendDamageRequest(p: Uint8Array): void;
  /** Receive a DamageBroadcast (DISCRIMINATOR_DAMAGE_BROADCAST). */
  onDamageBroadcast(f: (p: Uint8Array) => void): void;

  /** Send a PositionUpdate (DISCRIMINATOR_POSITION_UPDATE). */
  sendPositionUpdate(p: Uint8Array): void;

  /** Send a Ping (DISCRIMINATOR_PING). */
  sendPing(p: Uint8Array): void;
  /** Receive a Pong (DISCRIMINATOR_PONG). */
  onPong(f: (p: Uint8Array) => void): void;

  /** Snapshot of connection state. */
  getStats(): {rttMs: number; transport?: "webtransport" | "websocket"};

  /** Fires once when the transport disconnects. */
  onDisconnect(f: () => void): void;
}

// -- P2PGgnetTransport: wraps the existing WebRTC transport --------------

/**
 * WebRTC-backed `GameTransport` impl. Used by the existing 14 smokes +
 * scene.ts (the default path). The new interface methods throw
 * `"not implemented in Phase 0"` because the WebRTC peer doesn't speak
 * the server-side wire format — it carries the legacy 12-byte lockstep
 * input packet + a separate unreliable state channel.
 *
 * PR 11.6.D will keep `GgnetTransport` (the legacy class) for the
 * lockstep path + retire the new methods on `P2PGgnetTransport` (they
 * were never wired up). The throw keeps a wrong call loud rather than
 * silent.
 */
export class P2PGgnetTransport implements GameTransport {
  // The legacy GgnetTransport is accepted for API symmetry with
  // ServerGgnetTransport(constructor: ServerTransport) but never
  // touched — every method throws "not implemented in Phase 0" because
  // the WebRTC peer doesn't speak the server-side wire format. The
  // parameter is intentionally unused; the underscore prefix silences
  // the unused-parameter lint.
  constructor(_ggnet: GgnetTransport) {}

  /** Server-routed input packets are intentionally rejected here. Existing
   * P2P smokes continue to call the legacy `GgnetTransport` directly; this
   * wrapper is only the `GameTransport` compatibility adapter. */
  sendInputs(p: Uint8Array): void {
    void p;
    throw new Error("P2PGgnetTransport.sendInputs: not implemented in Phase 0");
  }
  onInputs(f: (p: Uint8Array) => void): void {
    void f;
    throw new Error("P2PGgnetTransport.onInputs: not implemented in Phase 0");
  }

  sendDamageRequest(_p: Uint8Array): void {
    throw new Error("P2PGgnetTransport.sendDamageRequest: not implemented in Phase 0");
  }
  onDamageBroadcast(_f: (p: Uint8Array) => void): void {
    throw new Error("P2PGgnetTransport.onDamageBroadcast: not implemented in Phase 0");
  }
  sendPositionUpdate(_p: Uint8Array): void {
    throw new Error("P2PGgnetTransport.sendPositionUpdate: not implemented in Phase 0");
  }
  sendPing(_p: Uint8Array): void {
    throw new Error("P2PGgnetTransport.sendPing: not implemented in Phase 0");
  }
  onPong(_f: (p: Uint8Array) => void): void {
    throw new Error("P2PGgnetTransport.onPong: not implemented in Phase 0");
  }
  getStats(): {rttMs: number; transport?: "webtransport" | "websocket"} {
    // P2P substrate doesn't expose RTT in PR 11.6.C. Return 0 — a
    // "no measurement yet" sentinel. PR 11.6.D may wire this through
    // the ggrs stats if useful.
    return {rttMs: 0};
  }
  onDisconnect(_f: () => void): void {
    // The existing GgnetTransport's WebRTC peer already exposes a
    // 'disconnect' event; we don't re-export it here because the
    // scene.ts peer-creation flow owns the lifecycle. PR 11.6.D may
    // plumb this through if the new caller-side (damageBus) needs it.
  }
}

// -- ServerGgnetTransport: wraps the new ServerTransport -----------------

/**
 * Server-backed `GameTransport` impl. Wraps `ServerTransport` (the
 * WebTransport-primary / WebSocket-fallback client). Implements the
 * full interface; PR 11.6.D's `damageBus` consumers wire here.
 *
 * Usage:
 *   const server = new ServerTransport(urlBase, "DEVBX");
 *   await server.connect();
 *   const gt: GameTransport = new ServerGgnetTransport(server);
 *   gt.onDamageBroadcast(b => { ... });
 *   gt.sendDamageRequest(encodeDamageRequest(req));
 */
export class ServerGgnetTransport implements GameTransport {
  constructor(private readonly server: ServerTransport) {}

  sendInputs(p: Uint8Array): void {
    this.server.sendInputs(p);
  }
  onInputs(f: (p: Uint8Array) => void): void {
    this.server.onInputs(f);
  }

  sendDamageRequest(p: Uint8Array): void {
    this.server.sendDamageRequest(p);
  }
  onDamageBroadcast(f: (p: Uint8Array) => void): void {
    this.server.onDamageBroadcast(f);
  }

  sendPositionUpdate(p: Uint8Array): void {
    this.server.sendPositionUpdate(p);
  }

  sendPing(p: Uint8Array): void {
    this.server.sendPing(p);
  }
  onPong(f: (p: Uint8Array) => void): void {
    this.server.onPong(f);
  }

  getStats(): {rttMs: number; transport?: "webtransport" | "websocket"} {
    return this.server.getStats();
  }

  onDisconnect(f: () => void): void {
    this.server.onDisconnect(f);
  }
}
