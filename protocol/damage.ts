// PR 11.6.B / §3.5 — TypeScript mirror of the server-side wire format.
//
// **This file is interface-only in PR 11.6.B.** PR 11.6.C adds the
// encoder/decoder pair that wires these types into the `ServerTransport`
// client module. Until then, the only consumer of this file is the
// compile-time size constants (used in `assert_eq!(bytes.len(), N)`
// tests once the encoder lands).
//
// **Source of truth**: the Rust definitions in `server/src/protocol.rs`
// and the size constants in `server/src/constants.rs`. The numbers in
// this file MUST stay in lockstep with those. If you change one, change
// both in the same commit — the `server/tests/protocol_wire.rs` size
// assertions will catch wire-format drift but the constants here drift
// independently of the wire format.
//
// **Endianness**: BIG-endian for every field in this module (§3.5).
// The CLIENT's lockstep input packet (`client/src/net/inputBitmask.ts`)
// uses little-endian on bytes 2-5 (yaw/pitch) — that's a different
// wire format on a different code path, not a contradiction.

// -- Discriminator table (mirror of server/src/protocol.rs) ---------------

/** DEPRECATED for 24p; stays for P2P compatibility. Forwarded by the
 *  server in PR 11.6.C. */
export const DISCRIMINATOR_INPUTS = 0x00;
export const DISCRIMINATOR_DAMAGE_REQUEST = 0x01;
export const DISCRIMINATOR_DAMAGE_BROADCAST = 0x02;
export const DISCRIMINATOR_POSITION_UPDATE = 0x03;
export const DISCRIMINATOR_PING = 0x04;
export const DISCRIMINATOR_PONG = 0x05;
/** NEW §1.2 — server-routed inputs for PR 11.7 handoff. PR 11.6.B
 *  buffers but does not process. */
export const DISCRIMINATOR_INPUTS_SERVER = 0x06;

// -- Wire-size constants (mirror of server/src/protocol.rs) ----------------

export const DAMAGE_REQUEST_WIRE_SIZE = 14;
export const DAMAGE_BROADCAST_WIRE_SIZE = 18;
export const POSITION_UPDATE_WIRE_SIZE = 14;
export const PING_WIRE_SIZE = 4;
export const PONG_WIRE_SIZE = 8;

/**
 * `0x06` discriminator + u32 frame BE + 12-byte input blob = 17 bytes.
 * `INPUT_SIZE = 12` comes from `client/src/net/inputBitmask.ts`.
 *
 * NOTE: the upstream PR 11.6 plan header says "16 bytes" — that's the
 * same class of off-by-one as the original PR 11.6.A DamageRequest
 * 8→14. The math wins (1 + 4 + 12 = 17). Carry-forward into PR 11.6.C's
 * TS encoder: assert `bytes.length === 17` at the wire level.
 */
export const INPUTS_SERVER_WIRE_SIZE = 17;

// -- Wire-format interfaces (mirror of server/src/protocol.rs) ------------

/**
 * Tab → Server. "I think this damage happened."
 *
 * Wire layout (14 bytes):
 *   byte 0..3   frame (u32 BE)
 *   byte 4..5   sourcePlayerId (u16 BE)
 *   byte 6..7   targetPlayerId (u16 BE)
 *   byte 8      source (u8 — 0 fire / 1 melee)
 *   byte 9      amount (u8)
 *   byte 10..13 eventId (u32 BE)
 */
export interface DamageRequest {
  frame: number;
  sourcePlayerId: number;
  targetPlayerId: number;
  /** 0 = fire, 1 = melee. */
  source: number;
  amount: number;
  eventId: number;
}

/**
 * Server → all tabs in the room. "This damage is canonical."
 *
 * Wire layout (18 bytes):
 *   byte 0..3   serverFrame (u32 BE)
 *   byte 4..7   serverSeq (u32 BE)
 *   byte 8..9   sourcePlayerId (u16 BE)
 *   byte 10..11 targetPlayerId (u16 BE)
 *   byte 12     source (u8)
 *   byte 13     amount (u8)
 *   byte 14..17 originEventId (u32 BE)
 */
export interface DamageBroadcast {
  serverFrame: number;
  serverSeq: number;
  sourcePlayerId: number;
  targetPlayerId: number;
  source: number;
  amount: number;
  originEventId: number;
}

/**
 * Tab → Server. "Here is my current pose." Sent every tick (or
 * throttled to 32Hz per §3.10). Powers `PositionHistory` on the
 * server (§3.4.1) for lag compensation.
 *
 * NOTE: the wire format carries only x + y (14 bytes). z is constant
 * on the flat demo map and re-derived server-side from the player's
 * recorded height (see §3.5 note). If z becomes meaningful this grows
 * to 18 bytes; that's PR 11.7+ territory.
 *
 * Wire layout (14 bytes):
 *   byte 0..3   serverFrame (u32 BE)
 *   byte 4..5   playerId (u16 BE)
 *   byte 6..9   positionX (f32 BE)
 *   byte 10..13 positionY (f32 BE)
 */
export interface PositionUpdate {
  serverFrame: number;
  playerId: number;
  positionX: number;
  positionY: number;
}

/**
 * Tab → Server. "What's my RTT?" Server responds with `Pong`.
 *
 * Wire layout (4 bytes):
 *   byte 0..3   clientTimestamp (u32 BE)
 */
export interface Ping {
  clientTimestamp: number;
}

/**
 * Server → Tab. Pong echoes the client's timestamp plus the server's
 * own clock so clients can also measure server-clock skew.
 *
 * Wire layout (8 bytes):
 *   byte 0..3   clientTimestamp (u32 BE)
 *   byte 4..7   serverTimestamp (u32 BE)
 */
export interface Pong {
  clientTimestamp: number;
  serverTimestamp: number;
}

/**
 * NEW §1.2 — Tab → Server. "Here is my encoded input at this frame."
 * PR 11.6.B does not transmit this; PR 11.6.C wires the encoder +
 * router. PR 11.7 consumes it for snapshot generation + lag-comp math.
 *
 * Wire layout (17 bytes — see INPUTS_SERVER_WIRE_SIZE note above):
 *   byte 0      discriminator 0x06
 *   byte 1..4   frame (u32 BE)
 *   byte 5..16  encoded input (12 bytes — INPUT_SIZE from
 *               client/src/net/inputBitmask.ts)
 */
export interface InputsServer {
  frame: number;
  /** 12-byte input blob. Matches `INPUT_SIZE` in
   *  `client/src/net/inputBitmask.ts`. */
  encodedInput: Uint8Array;
}
