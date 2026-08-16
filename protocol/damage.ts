// PR 11.6.C / §3.5 — TypeScript mirror of the server-side wire format.
//
// **This file is the single source of truth for the wire format on the
// client side.** PR 11.6.B added the interface declarations + the 6
// wire-size constants. PR 11.6.C adds the encoder/decoder pair that
// `ServerTransport` (and the smoke tests) call into. PR 11.6.D wires
// the decoder results into the game state.
//
// **Wire convention (PR 11.6.C review fix B2 — every TS encoder
// prefixes the discriminator)**:
//   - Every TS encoder produces the full on-the-wire bytes (disc +
//     body). The discriminator byte is the first byte; the rest is
//     the per-type body (matches the server-side `handle_binary`
//     shape exactly — `payload[0]` is the disc, `payload[1..]` is the
//     body the decoders consume).
//   - `sendRaw` is therefore a pass-through — no heuristic to strip a
//     duplicate discriminator, no byte-order ambiguity. Every packet
//     that leaves the client is `disc + body` exactly as encoded.
//   - The on-the-wire constants below (`*_WIRE_SIZE`) are the full
//     packet sizes (disc + body). The body-only constants
//     (`*_BODY_SIZE`) mirror the Rust-side constants in
//     `server/src/protocol.rs`, where the Rust `encode_*` returns
//     body-only and the transport router prepends the discriminator.
//
// **Server source of truth**: the Rust definitions in
// `server/src/protocol.rs`. The Rust `DAMAGE_REQUEST_BODY_SIZE` (and
// the four siblings) are the body sizes (the encoder returns body
// only; the transport router prepends the discriminator to form the
// wire packet). The TS-side `DAMAGE_REQUEST_BODY_SIZE` constants
// MUST stay in lockstep with the Rust body-size constants. The
// on-the-wire TS constants are simply `BODY_SIZE + 1`.
//
// **Endianness**: BIG-endian for every wire format in this module
// (§3.5). The CLIENT's lockstep input packet
// (`client/src/net/inputBitmask.ts`) uses little-endian on bytes 2-5
// (yaw/pitch) — that's a different wire format on a different code
// path, not a contradiction. f32 BE matches `wasm-bindgen` / `ggrs`
// f32 wire format (also BE) so we don't need a separate decode step.

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

// -- Body-size constants (mirror of server/src/protocol.rs) ----------------
//
// These are the body-only sizes — what the Rust `encode_*` returns
// (the body, without the discriminator byte). The transport layer
// prepends the discriminator on the wire, so the actual on-the-wire
// packet is `1 + BODY_SIZE` bytes.
export const DAMAGE_REQUEST_BODY_SIZE = 14;
export const DAMAGE_BROADCAST_BODY_SIZE = 18;
export const POSITION_UPDATE_BODY_SIZE = 14;
export const PING_BODY_SIZE = 4;
export const PONG_BODY_SIZE = 8;

// -- Wire-size constants (disc + body — the full on-the-wire packet) ------
//
// PR 11.6.C review fix B2: every TS encoder returns the discriminator-
// prefixed packet, so the wire-size constants are `1 + BODY_SIZE`.
export const DAMAGE_REQUEST_WIRE_SIZE = DAMAGE_REQUEST_BODY_SIZE + 1;
export const DAMAGE_BROADCAST_WIRE_SIZE = DAMAGE_BROADCAST_BODY_SIZE + 1;
export const POSITION_UPDATE_WIRE_SIZE = POSITION_UPDATE_BODY_SIZE + 1;
export const PING_WIRE_SIZE = PING_BODY_SIZE + 1;
export const PONG_WIRE_SIZE = PONG_BODY_SIZE + 1;
/** `0x06` discriminator + u32 frame BE + 12-byte input blob = 17 bytes.
 *  `INPUT_SIZE = 12` comes from `client/src/net/inputBitmask.ts`. */
export const INPUTS_SERVER_WIRE_SIZE = 17;

// -- Wire-format interfaces (mirror of server/src/protocol.rs) ------------

/**
 * Tab → Server. "I think this damage happened."
 *
 * Wire layout (15 bytes):
 *   byte 0       discriminator 0x01
 *   byte 1..4    frame (u32 BE)
 *   byte 5..6    sourcePlayerId (u16 BE)
 *   byte 7..8    targetPlayerId (u16 BE)
 *   byte 9       source (u8 — 0 fire / 1 melee)
 *   byte 10      amount (u8)
 *   byte 11..14  eventId (u32 BE)
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
 * Wire layout (19 bytes):
 *   byte 0       discriminator 0x02
 *   byte 1..4    serverFrame (u32 BE)
 *   byte 5..8    serverSeq (u32 BE)
 *   byte 9..10   sourcePlayerId (u16 BE)
 *   byte 11..12  targetPlayerId (u16 BE)
 *   byte 13      source (u8)
 *   byte 14      amount (u8)
 *   byte 15..18  originEventId (u32 BE)
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
 * NOTE: the wire format carries only x + y (15 bytes). z is constant
 * on the flat demo map and re-derived server-side from the player's
 * recorded height (see §3.5 note). If z becomes meaningful this grows
 * to 19 bytes; that's PR 11.7+ territory.
 *
 * Wire layout (15 bytes):
 *   byte 0       discriminator 0x03
 *   byte 1..4    serverFrame (u32 BE)
 *   byte 5..6    playerId (u16 BE)
 *   byte 7..10   positionX (f32 BE)
 *   byte 11..14  positionY (f32 BE)
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
 * Wire layout (5 bytes):
 *   byte 0       discriminator 0x04
 *   byte 1..4    clientTimestamp (u32 BE)
 */
export interface Ping {
  clientTimestamp: number;
}

/**
 * Server → Tab. Pong echoes the client's timestamp plus the server's
 * own clock so clients can also measure server-clock skew.
 *
 * Wire layout (9 bytes):
 *   byte 0       discriminator 0x05
 *   byte 1..4    clientTimestamp (u32 BE)
 *   byte 5..8    serverTimestamp (u32 BE)
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
 *   byte 0       discriminator 0x06
 *   byte 1..4    frame (u32 BE)
 *   byte 5..16   encoded input (12 bytes — INPUT_SIZE from
 *                client/src/net/inputBitmask.ts)
 */
export interface InputsServer {
  frame: number;
  /** 12-byte input blob. Matches `INPUT_SIZE` in
   *  `client/src/net/inputBitmask.ts`. */
  encodedInput: Uint8Array;
}

// -- Encoder / decoder pair ----------------------------------------------
//
// PR 11.6.C: every encoder asserts its wire size. This is the TS-side
// mirror of the Rust `debug_assert_eq!(buf.len(), N)` inside each
// encoder in `server/src/protocol.rs`. If the TS encoder drifts from
// the Rust encoder, the assertion fires at runtime in CI.
//
// PR 11.6.C review fix N2: the assertions are now REAL (not
// tautological) — we build the output buffer incrementally with
// `concatBytes`, so adding/removing a write changes the final length
// and the assertion fires.

/** Concatenate Uint8Arrays into a single Uint8Array. Used by the
 *  encoders to build wire bytes incrementally so the size assertion
 *  at the end catches drift (vs. allocating a fixed-length buffer
 *  up-front, where the assertion would be tautological). */
function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Write a single u32 BE to a fresh Uint8Array. */
function u32BE(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, value >>> 0, false);
  return buf;
}

/** Write a single u16 BE to a fresh Uint8Array. */
function u16BE(value: number): Uint8Array {
  const buf = new Uint8Array(2);
  const dv = new DataView(buf.buffer);
  dv.setUint16(0, value & 0xffff, false);
  return buf;
}

/** Write a single f32 BE to a fresh Uint8Array. */
function f32BE(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  const dv = new DataView(buf.buffer);
  dv.setFloat32(0, value, false);
  return buf;
}

/** Encode a `DamageRequest` to a 15-byte wire-format `Uint8Array`
 *  (discriminator 0x01 + 14-byte body). Mirrors the Rust
 *  `encode_damage_request` body layout byte-for-byte. */
export function encodeDamageRequest(req: DamageRequest): Uint8Array {
  const bytes = concatBytes([
    new Uint8Array([DISCRIMINATOR_DAMAGE_REQUEST]), // disc
    u32BE(req.frame),                // BE u32 frame
    u16BE(req.sourcePlayerId),       // BE u16 sourcePlayerId
    u16BE(req.targetPlayerId),       // BE u16 targetPlayerId
    new Uint8Array([req.source & 0xff]), // u8 source
    new Uint8Array([req.amount & 0xff]),  // u8 amount
    u32BE(req.eventId),              // BE u32 eventId
  ]);
  console.assert(
    bytes.length === DAMAGE_REQUEST_WIRE_SIZE,
    `encodeDamageRequest: expected ${DAMAGE_REQUEST_WIRE_SIZE} bytes, got ${bytes.length}`,
  );
  return bytes;
}

/** Decode a 14-byte body buffer to a `DamageRequest`. The body is
 *  what follows the discriminator byte — the caller strips the
 *  discriminator before calling this. */
export function decodeDamageRequest(buf: Uint8Array): DamageRequest | null {
  if (buf.length !== DAMAGE_REQUEST_BODY_SIZE) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    frame: dv.getUint32(0, false),
    sourcePlayerId: dv.getUint16(4, false),
    targetPlayerId: dv.getUint16(6, false),
    source: buf[8],
    amount: buf[9],
    eventId: dv.getUint32(10, false),
  };
}

/** Encode a `DamageBroadcast` to a 19-byte wire-format `Uint8Array`
 *  (discriminator 0x02 + 18-byte body). */
export function encodeDamageBroadcast(bc: DamageBroadcast): Uint8Array {
  const bytes = concatBytes([
    new Uint8Array([DISCRIMINATOR_DAMAGE_BROADCAST]), // disc
    u32BE(bc.serverFrame),            // BE u32 serverFrame
    u32BE(bc.serverSeq),              // BE u32 serverSeq
    u16BE(bc.sourcePlayerId),         // BE u16 sourcePlayerId
    u16BE(bc.targetPlayerId),         // BE u16 targetPlayerId
    new Uint8Array([bc.source & 0xff]),
    new Uint8Array([bc.amount & 0xff]),
    u32BE(bc.originEventId),          // BE u32 originEventId
  ]);
  console.assert(
    bytes.length === DAMAGE_BROADCAST_WIRE_SIZE,
    `encodeDamageBroadcast: expected ${DAMAGE_BROADCAST_WIRE_SIZE} bytes, got ${bytes.length}`,
  );
  return bytes;
}

/** Decode an 18-byte body buffer to a `DamageBroadcast`. */
export function decodeDamageBroadcast(buf: Uint8Array): DamageBroadcast | null {
  if (buf.length !== DAMAGE_BROADCAST_BODY_SIZE) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    serverFrame: dv.getUint32(0, false),
    serverSeq: dv.getUint32(4, false),
    sourcePlayerId: dv.getUint16(8, false),
    targetPlayerId: dv.getUint16(10, false),
    source: buf[12],
    amount: buf[13],
    originEventId: dv.getUint32(14, false),
  };
}

/** Encode a `PositionUpdate` to a 15-byte wire-format `Uint8Array`
 *  (discriminator 0x03 + 14-byte body). */
export function encodePositionUpdate(pu: PositionUpdate): Uint8Array {
  const bytes = concatBytes([
    new Uint8Array([DISCRIMINATOR_POSITION_UPDATE]), // disc
    u32BE(pu.serverFrame),            // BE u32 serverFrame
    u16BE(pu.playerId),               // BE u16 playerId
    f32BE(pu.positionX),              // BE f32 positionX
    f32BE(pu.positionY),              // BE f32 positionY
  ]);
  console.assert(
    bytes.length === POSITION_UPDATE_WIRE_SIZE,
    `encodePositionUpdate: expected ${POSITION_UPDATE_WIRE_SIZE} bytes, got ${bytes.length}`,
  );
  return bytes;
}

/** Decode a 14-byte body buffer to a `PositionUpdate`. */
export function decodePositionUpdate(buf: Uint8Array): PositionUpdate | null {
  if (buf.length !== POSITION_UPDATE_BODY_SIZE) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    serverFrame: dv.getUint32(0, false),
    playerId: dv.getUint16(4, false),
    positionX: dv.getFloat32(6, false),
    positionY: dv.getFloat32(10, false),
  };
}

/** Encode a `Ping` to a 5-byte wire-format `Uint8Array`
 *  (discriminator 0x04 + 4-byte body). */
export function encodePing(p: Ping): Uint8Array {
  const bytes = concatBytes([
    new Uint8Array([DISCRIMINATOR_PING]), // disc
    u32BE(p.clientTimestamp),
  ]);
  console.assert(
    bytes.length === PING_WIRE_SIZE,
    `encodePing: expected ${PING_WIRE_SIZE} bytes, got ${bytes.length}`,
  );
  return bytes;
}

/** Decode a 4-byte body buffer to a `Ping`. */
export function decodePing(buf: Uint8Array): Ping | null {
  if (buf.length !== PING_BODY_SIZE) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { clientTimestamp: dv.getUint32(0, false) };
}

/** Encode a `Pong` to a 9-byte wire-format `Uint8Array`
 *  (discriminator 0x05 + 8-byte body). */
export function encodePong(p: Pong): Uint8Array {
  const bytes = concatBytes([
    new Uint8Array([DISCRIMINATOR_PONG]), // disc
    u32BE(p.clientTimestamp),
    u32BE(p.serverTimestamp),
  ]);
  console.assert(
    bytes.length === PONG_WIRE_SIZE,
    `encodePong: expected ${PONG_WIRE_SIZE} bytes, got ${bytes.length}`,
  );
  return bytes;
}

/** Decode an 8-byte body buffer to a `Pong`. */
export function decodePong(buf: Uint8Array): Pong | null {
  if (buf.length !== PONG_BODY_SIZE) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    clientTimestamp: dv.getUint32(0, false),
    serverTimestamp: dv.getUint32(4, false),
  };
}

/** Encode an `InputsServer` payload to a 17-byte wire-format
 *  `Uint8Array` (discriminator 0x06 + 4-byte frame BE + 12-byte
 *  input blob). The input blob is preserved verbatim. */
export function encodeInputsServer(i: InputsServer): Uint8Array {
  if (i.encodedInput.length !== 12) {
    throw new Error(
      `encodeInputsServer: encodedInput must be 12 bytes (INPUT_SIZE), got ${i.encodedInput.length}`,
    );
  }
  const bytes = concatBytes([
    new Uint8Array([DISCRIMINATOR_INPUTS_SERVER]), // disc
    u32BE(i.frame),
    i.encodedInput,
  ]);
  console.assert(
    bytes.length === INPUTS_SERVER_WIRE_SIZE,
    `encodeInputsServer: expected ${INPUTS_SERVER_WIRE_SIZE} bytes, got ${bytes.length}`,
  );
  return bytes;
}

/** Decode a 17-byte wire-format buffer (discriminator-prefixed) to an
 *  `InputsServer`. Returns null on size mismatch or wrong
 *  discriminator.
 *
 *  Mirrors the Rust `decode_inputs_server` exactly. */
export function decodeInputsServer(buf: Uint8Array): InputsServer | null {
  if (buf.length !== INPUTS_SERVER_WIRE_SIZE) return null;
  if (buf[0] !== DISCRIMINATOR_INPUTS_SERVER) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const frame = dv.getUint32(1, false);
  const input = new Uint8Array(12);
  input.set(buf.subarray(5, 17));
  return { frame, encodedInput: input };
}
