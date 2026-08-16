import {WebRTCPeer} from "./peer";

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
 * Snapshot message — discriminator 0x07, introduces in PR 11.7.
 * PR 11.7 replaces per-player PositionUpdate with a single
 * `Snapshot { frame, [Position × N] }` message. ServerTransport will
 * dispatch this; P2PGgnetTransport will NOT (lockstep substrate retires
 * in 11.7). This comment is a seam marker; the message type arrives in
 * PR 11.7. Do not implement here.
 */
