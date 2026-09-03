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
/** PR #59 / §3.5 -- server-authoritative hit detection. The
 *  client sends an `AimEvent` (its intent: yaw + pitch + frame +
 *  eventId) every LMB press; the server runs `dual_pistol_hit`
 *  against snapshot-known positions for every OTHER player in the
 *  room and emits `DamageBroadcast`(s) for hits. Replaces the
 *  client-raycast-verified `DamageRequest` (0x01) path -- PR #59
 *  drops the 0x01 path entirely. */
export const DISCRIMINATOR_AIM_EVENT = 0x0A;
// PR #107 — weapon-switch wire type. The brief locks
// `DISCRIMINATOR_SNAPSHOT = 0x07` and the plan §3.5 reserves
// 0x07-0x0B for PR 11.7 types (Snapshot/StateAck/InputSeq/
// ReloadRequest/StateResyncRequest). 0x0C is the next free slot
// after those reservations.
//
// **PR #107 reclaims the 0x0C slot from `DAMAGE_REJECT`** (see
// `DISCRIMINATOR_DAMAGE_REJECT` below). DamageReject was a
// vestigial type from PR 11.6.D — defined + encoder present but
// the transport router never had a matching dispatcher arm. The
// server-side tombstone (with `#[deprecated]`) keeps the encoder
// around for source compatibility; the client mirror follows the
// same pattern (see `DAMAGE_REJECT_BODY_SIZE` /
// `encodeDamageReject` / `decodeDamageReject`).
//
// **No client-side `0x0C → DamageReject` fallback decoder in PR
// #108** (per Kyle's call on the PR #107 carry-forward). The
// `next-deploy-is-all-clients-new` mitigation in
// `docs/PR-105-spec.md` §2.4 assumes all client tabs refresh
// within the deploy window — anyone with a cached JS bundle is
// broken anyway because PlayerState also changed shape (30→31).
// The `DAMAGE_REJECT` slot becomes `WeaponSwitch`, full stop.
export const DISCRIMINATOR_WEAPON_SWITCH = 0x0C;
// PR #107 — tombstone for the old DAMAGE_REJECT discriminator.
// The 0x0C slot was reclaimed by PR #107's `WeaponSwitch` wire;
// DAMAGE_REJECT was a vestigial type from PR 11.6.D (encoder
// present but never sent on the wire). The constant + the
// `encodeDamageReject` / `decodeDamageReject` pair are retained
// for source compatibility but are no longer dispatched by the
// transport router. Future cleanup PR can delete them.
export const DISCRIMINATOR_DAMAGE_REJECT = 0x0C;

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
/** PR 11.6.D FIX 4: body size of `DamageReject` (event_id u32 BE +
 *  reason u8 = 5 bytes). Wire-format stable — server `ca9f177`. */
export const DAMAGE_REJECT_BODY_SIZE = 5;
/** PR #59 / §3.5 + PR #107 — body size of `AimEvent`. Body = 2
 *  (source_player_id u16 BE) + 4 (yaw_radians f32 BE) + 4
 *  (pitch_radians f32 BE) + 4 (frame u32 BE) + 4 (event_id u32 BE)
 *  + 1 (is_firing u8 — PR #107) = 19 bytes. The `is_firing` byte
 *  drives the server-side burst state machine in
 *  `damage_relay::validate_and_relay_aim`: Semi/Burst require the
 *  trigger to release (`is_firing: 0`) before another pull
 *  re-engages; Auto doesn't. No `target_player_id` field on the
 *  wire — the server iterates all OTHER players in the room. */
export const AIM_EVENT_BODY_SIZE = 2 + 4 + 4 + 4 + 4 + 1;
/** PR 11.6.D FIX 4: reject reason codes. Wire-format stable —
 *  mirror of `server/src/protocol.rs::REJECT_REASON_*`. New codes
 *  may be added without breaking older clients (they just log
 *  "unknown reason" and proceed). */
export const REJECT_REASON_FIRE_RATE = 0;
export const REJECT_REASON_AMMO = 1;
export const REJECT_REASON_EVENT_ID = 2;
export const REJECT_REASON_LAG_MISS = 3;
export const REJECT_REASON_NO_HISTORY = 4;

// -- Wire-size constants (disc + body — the full on-the-wire packet) ------
//
// PR 11.6.C review fix B2: every TS encoder returns the discriminator-
// prefixed packet, so the wire-size constants are `1 + BODY_SIZE`.
export const DAMAGE_REQUEST_WIRE_SIZE = DAMAGE_REQUEST_BODY_SIZE + 1;
export const DAMAGE_BROADCAST_WIRE_SIZE = DAMAGE_BROADCAST_BODY_SIZE + 1;
export const POSITION_UPDATE_WIRE_SIZE = POSITION_UPDATE_BODY_SIZE + 1;
export const PING_WIRE_SIZE = PING_BODY_SIZE + 1;
export const PONG_WIRE_SIZE = PONG_BODY_SIZE + 1;
/** `0x06` discriminator + u32 frame BE + 12-byte input blob +
 *  u32 last_inputs_seq BE = 21 bytes.
 *  `INPUT_SIZE = 12` comes from `client/src/net/inputBitmask.ts`.
 *
 *  PR 11.7.D2 / §1.2 carry-forward: wire size bumped from 17 → 21
 *  to carry the per-source `last_inputs_seq` trailer (one u32 BE).
 *  The server's `validate_and_relay` uses this to drop stale
 *  inputs (replay protection) — the server's lag-comp math consumes
 *  the freshest input per frame; an out-of-order `inputs_seq` is a
 *  sign the client is dropping packets and the server should ignore
 *  rather than apply an old input as if it were current.
 *
 *  Brief originally specified 18 — that's a brief-level off-by-3
 *  math error (same class as the original PR 11.6.A DamageRequest
 *  8 → 14 mistake). Math wins: 1 (disc) + 4 (frame) + 12 (input) +
 *  4 (trailer) = 21.
 *
 *  Mirror of `server/src/protocol.rs::INPUTS_SERVER_WIRE_SIZE` and
 *  `WIRE_SIZE_INPUTS_SERVER_WITH_SEQ` in `protocol/constants.ts`.
 *  Encoder appends a u32 BE trailer; decoder reads the last 4 bytes
 *  as the trailer and verifies the disc byte at byte 0. */
export const INPUTS_SERVER_WIRE_SIZE = 21;
/** PR 11.7.D2 — body size (disc byte already stripped by the caller).
 *  Wire size 21 - 1 (disc) = 20 bytes body. Body layout: u32 frame
 *  (4) + 12-byte input + u32 last_inputs_seq (4) = 20. ✓ */
export const INPUTS_SERVER_BODY_SIZE = INPUTS_SERVER_WIRE_SIZE - 1;
/** PR 11.7.B: `0x0C` discriminator + u32 event_id BE + reason u8 = 6 bytes total.
 *  Bumped from 0x07 (PR 11.6.D) so 0x07 is free for Snapshot. */
export const DAMAGE_REJECT_WIRE_SIZE = DAMAGE_REJECT_BODY_SIZE + 1;
/** PR #59 / §3.5 — full on-the-wire packet (disc + body) = 19 bytes.
 *  `AIM_EVENT_BODY_SIZE + 1`. */
export const AIM_EVENT_WIRE_SIZE = AIM_EVENT_BODY_SIZE + 1;

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
 * PR 11.7.D2 / §1.2: appends the `lastInputsSeq` trailer (one u32
 * BE per packet — the sender's inputs_seq counter; the receiver
 * uses this for replay protection on the lag-comp rewind).
 *
 * Wire layout (21 bytes — see INPUTS_SERVER_WIRE_SIZE note above):
 *   byte 0       discriminator 0x06
 *   byte 1..4    frame (u32 BE)
 *   byte 5..16   encoded input (12 bytes — INPUT_SIZE from
 *                client/src/net/inputBitmask.ts)
 *   byte 17..20  lastInputsSeq (u32 BE) — sender's inputs_seq
 */
export interface InputsServer {
  frame: number;
  /** 12-byte input blob. Matches `INPUT_SIZE` in
   *  `client/src/net/inputBitmask.ts`. */
  encodedInput: Uint8Array;
  /** PR 11.7.D2 / §1.2: sender's monotonic inputs_seq counter.
   *  Server uses this for replay protection — drops the input if
   *  `lastInputsSeq` is older than the last seen seq for the source.
   *  Counter starts at 0 on connect and increments once per packet. */
  lastInputsSeq: number;
}

/**
 * PR 11.6.D FIX 4: Server → Source-tab. Private reject signal
 * (sent on the source tab's connection only — NOT broadcast to
 * peer tabs so they can't infer the source's rate-limit / ammo /
 * eventId / lag-miss state).
 *
 * Wire layout (6 bytes — see `DAMAGE_REJECT_WIRE_SIZE`):
 *   byte 0       discriminator 0x0C
 *   byte 1..4    event_id (u32 BE — matches the `eventId` field of
 *                the rejected `DamageRequest`)
 *   byte 5       reason (u8 — see `REJECT_REASON_*` constants)
 */
export interface DamageReject {
  eventId: number;
  /** 0 = fire-rate, 1 = ammo, 2 = eventId, 3 = lag-miss, 4 = no-history. */
  reason: number;
}

/**
 * PR #59 / §3.5 + PR #107 — Tab → Server. "I fired at this yaw +
 * pitch on this frame." Replaces `DamageRequest` (PR 11.6.D) — the
 * server is now the sole hit-detection authority.
 *
 * Wire layout (20 bytes — see `AIM_EVENT_WIRE_SIZE`, was 19 pre-PR
 * #107):
 *   byte 0        discriminator 0x0A
 *   byte 1..2     sourcePlayerId (u16 BE)
 *   byte 3..6     yawRadians (f32 BE)
 *   byte 7..10    pitchRadians (f32 BE)
 *   byte 11..14   frame (u32 BE)
 *   byte 15..18   eventId (u32 BE)
 *   byte 19       isFiring (u8 — PR #107; 0 or 1. Drives the server
 *                 burst state machine in
 *                 `damage_relay::validate_and_relay_aim`. Press
 *                 events send `1`; trigger-release events send
 *                 `0`. Pre-PR #107 clients send no byte here, so
 *                 pre-#107 servers read a stale byte and the burst
 *                 state machine never progresses. Post-PR #108 the
 *                 client always sends `isFiring` — see
 *                 `damageBus.ts` AimEvent emitter.)
 *
 * No `targetPlayerId` — the server iterates all OTHER players in
 * the room. Mirrors the Rust `AimEvent` in `server/src/protocol.rs`.
 */
export interface AimEvent {
  sourcePlayerId: number;
  /** Yaw (radians, [-PI, PI]) at the moment of the click. Server
   *  trusts this claim (anti-cheat is Phase 4 / PR 11.10). */
  yawRadians: number;
  /** Pitch (radians, [-PI/2, PI/2]) at the moment of the click. */
  pitchRadians: number;
  /** Server frame at the moment of the click. The server uses this
   *  for lag-comp rewind (`frame - rtt/2`). */
  frame: number;
  /** Monotonic per-tab counter (resets on tab reload; the server
   *  applies a bounded window of tolerance). */
  eventId: number;
  /** PR #107 — `1` on a trigger-press event, `0` on trigger release.
   *  The server's burst state machine requires `isFiring: 0` between
   *  burst pulls — see `validate_and_relay_aim` Semi/Burst arms. */
  isFiring: number;
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

/** Encode an `InputsServer` payload to a 21-byte wire-format
 *  `Uint8Array` (discriminator 0x06 + 4-byte frame BE + 12-byte
 *  input blob + 4-byte lastInputsSeq BE trailer). The input blob is
 *  preserved verbatim. The trailer carries the sender's monotonic
 *  inputs_seq counter for server-side replay protection. */
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
    u32BE(i.lastInputsSeq), // PR 11.7.D2 / §1.2 trailer
  ]);
  console.assert(
    bytes.length === INPUTS_SERVER_WIRE_SIZE,
    `encodeInputsServer: expected ${INPUTS_SERVER_WIRE_SIZE} bytes, got ${bytes.length}`,
  );
  return bytes;
}

/** Decode a 21-byte wire-format buffer (discriminator-prefixed) to an
 *  `InputsServer`. Returns null on size mismatch or wrong
 *  discriminator.
 *
 *  PR 11.7.D2 / §1.2: reads the `lastInputsSeq` trailer (last 4
 *  bytes) and returns it as a field. Server uses it for replay
 *  protection on the lag-comp rewind path.
 *
 *  Mirrors the Rust `decode_inputs_server` exactly. */
export function decodeInputsServer(buf: Uint8Array): InputsServer | null {
  if (buf.length !== INPUTS_SERVER_WIRE_SIZE) return null;
  if (buf[0] !== DISCRIMINATOR_INPUTS_SERVER) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const frame = dv.getUint32(1, false);
  const input = new Uint8Array(12);
  input.set(buf.subarray(5, 17));
  const lastInputsSeq = dv.getUint32(17, false);
  return { frame, encodedInput: input, lastInputsSeq };
}


/**
 * PR 11.6.D FIX 4: encode a `DamageReject` payload to a 6-byte
 * wire-format `Uint8Array` (discriminator 0x0C + 4-byte event_id
 * BE + 1-byte reason). The reverse direction (server → client) is
 * the only one in active use — the client doesn't send rejects.
 * Symmetric encoder kept for protocol-test symmetry with the Rust
 * `encode_damage_reject`.
 */
export function encodeDamageReject(r: DamageReject): Uint8Array {
  const eventIdBytes = u32BE(r.eventId);
  const out = concatBytes([
    new Uint8Array([DISCRIMINATOR_DAMAGE_REJECT]),
    eventIdBytes,
    new Uint8Array([r.reason & 0xff]),
  ]);
  console.assert(
    out.length === DAMAGE_REJECT_WIRE_SIZE,
    `encodeDamageReject: expected ${DAMAGE_REJECT_WIRE_SIZE} bytes, got ${out.length}`,
  );
  return out;
}

/**
 * PR 11.6.D FIX 4: decode a 5-byte body buffer (discriminator
 * already stripped) to a `DamageReject`. Returns null on size
 * mismatch. Mirrors the Rust `decode_damage_reject` exactly.
 */
export function decodeDamageReject(buf: Uint8Array): DamageReject | null {
  if (buf.length !== DAMAGE_REJECT_BODY_SIZE) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    eventId: dv.getUint32(0, false),
    reason: dv.getUint8(4),
  };
}

/** Encode an `AimEvent` to a 20-byte wire-format `Uint8Array`
 *  (discriminator 0x0A + 19-byte body). Mirrors the Rust
 *  `encode_aim_event` body layout byte-for-byte.
 *
 *  Layout (matches the wire-format table in the JSDoc above):
 *    [disc 1B][source u16 BE 2B][yaw f32 BE 4B][pitch f32 BE 4B]
 *    [frame u32 BE 4B][event_id u32 BE 4B][is_firing u8 1B] =
 *    20 bytes total. PR #107 added the trailing `is_firing` byte. */
export function encodeAimEvent(req: AimEvent): Uint8Array {
  const bytes = concatBytes([
    new Uint8Array([DISCRIMINATOR_AIM_EVENT]), // disc 0x0A
    u16BE(req.sourcePlayerId),                  // BE u16 sourcePlayerId
    f32BE(req.yawRadians),                      // BE f32 yawRadians
    f32BE(req.pitchRadians),                    // BE f32 pitchRadians
    u32BE(req.frame),                           // BE u32 frame
    u32BE(req.eventId),                         // BE u32 eventId
    // PR #107 — `is_firing` byte drives the burst state machine.
    // Press event: `1`; trigger-release event: `0`.
    new Uint8Array([req.isFiring & 0xff]),
  ]);
  console.assert(
    bytes.length === AIM_EVENT_WIRE_SIZE,
    `encodeAimEvent: expected ${AIM_EVENT_WIRE_SIZE} bytes, got ${bytes.length}`,
  );
  return bytes;
}

/** Decode a 19-byte body buffer (discriminator already stripped)
 *  to an `AimEvent`. Returns null on size mismatch. Mirrors the
 *  Rust `decode_aim_event` exactly. */
export function decodeAimEvent(buf: Uint8Array): AimEvent | null {
  if (buf.length !== AIM_EVENT_BODY_SIZE) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    sourcePlayerId: dv.getUint16(0, false),
    yawRadians: dv.getFloat32(2, false),
    pitchRadians: dv.getFloat32(6, false),
    frame: dv.getUint32(10, false),
    eventId: dv.getUint32(14, false),
    // PR #107 — burst state machine input.
    isFiring: dv.getUint8(18),
  };
}

// =====================================================================
// PR #107 / PR #108 — `WeaponSwitch` (0x0C) wire type.
//
// Tab → Server. "I want to switch to weapon N, fire mode M."
//
// Closes the open question from PR #102 §3.9 / PR #105 §2.1. The
// server validates via `damage_relay::validate_and_relay_weapon_switch`
// (5 gates paralleling `validate_and_relay_reload`):
//   1. source-in-room
//   2. anti-spoof (source_player_id matches the tab's claimed id)
//   3. rate-limit (`WEAPON_SWITCH_RATE_LIMIT_MS` = 1 Hz per player)
//   4. weapon-id-known (`weaponId` ∈ `WeaponId`)
//   5. fire-mode-index-in-range
//      (`fire_mode_index < WEAPONS_TABLE[weaponId].fire_modes.length`)
//
// On success, the server mutates
// `room.players[source].{weapon_id, current_fire_mode}` and the
// next 20Hz Snapshot fan-out (0x07) carries the new state to every
// connected tab. No private ack packet (PR #107 locked decision
// #4 — mirrors ReloadRequest).
//
// **No client-side `0x0C → DamageReject` fallback decoder** — see
// the discriminator-table note above.
// =====================================================================

/** PR #107 / PR #108 — body size for `WeaponSwitch` BODY
 *  (without the discriminator). Layout (big-endian):
 *    byte 0..1   source_player_id (u16 BE)
 *    byte 2      weapon_id (u8 — see `WeaponId` enum in
 *                `protocol/constants.ts`)
 *    byte 3      fire_mode_index (u8 — index into
 *                `WEAPONS_TABLE[weapon_id].fire_modes[]`; 0 = first
 *                mode)
 *  Math: 2 + 1 + 1 = 4 bytes. */
export const WEAPON_SWITCH_BODY_SIZE = 4;

/** PR #107 / PR #108 — full on-the-wire packet (disc + body) = 5
 *  bytes. */
export const WEAPON_SWITCH_WIRE_SIZE = WEAPON_SWITCH_BODY_SIZE + 1;

/**
 * Tab → Server. "Switch my weapon to N, fire mode to M."
 *
 * Wire layout (5 bytes — `WEAPON_SWITCH_WIRE_SIZE`):
 *   byte 0       discriminator 0x0C
 *   byte 1..2    sourcePlayerId (u16 BE)
 *   byte 3       weaponId (u8 — `WeaponId` enum)
 *   byte 4       fireModeIndex (u8 — index into
 *                `WEAPONS_TABLE[weaponId].fire_modes[]`; 0 = first
 *                mode)
 *
 * The server's `validate_and_relay_weapon_switch` runs 5 gates
 * (see file-level doc above); on success it mutates the player's
 * state and the next Snapshot carries the new values to all
 * connected tabs.
 */
export interface WeaponSwitch {
  sourcePlayerId: number;
  /** 0 = DualPistol, 1 = Shotgun, 2 = Sniper. See `WeaponId`
   *  enum in `protocol/constants.ts`. */
  weaponId: number;
  /** Index into `WEAPONS_TABLE[weaponId].fire_modes[]`. 0 = first
   *  mode (e.g. Semi on DualPistol); 1 = second mode (e.g. Burst3
   *  on DualPistol). Server-side gate #5 rejects out-of-range
   *  values silently. */
  fireModeIndex: number;
}

/** Encode a `WeaponSwitch` to a 5-byte wire-format `Uint8Array`
 *  (discriminator 0x0C + 4-byte body). Mirrors the Rust
 *  `encode_weapon_switch` body layout byte-for-byte.
 *
 *  **Caller responsibility**: the client is responsible for
 *  rate-limiting weapon switches to
 *  `WEAPON_SWITCH_RATE_LIMIT_MS` (1 Hz per player) so it doesn't
 *  burn the server-side rate-limit gate. The server gate is
 *  authoritative; the local gate just avoids wasted packets. */
export function encodeWeaponSwitch(req: WeaponSwitch): Uint8Array {
  const bytes = concatBytes([
    new Uint8Array([DISCRIMINATOR_WEAPON_SWITCH]), // disc 0x0C
    u16BE(req.sourcePlayerId),                     // BE u16 source_player_id
    new Uint8Array([req.weaponId & 0xff]),         // u8 weapon_id
    new Uint8Array([req.fireModeIndex & 0xff]),    // u8 fire_mode_index
  ]);
  console.assert(
    bytes.length === WEAPON_SWITCH_WIRE_SIZE,
    `encodeWeaponSwitch: expected ${WEAPON_SWITCH_WIRE_SIZE} bytes, got ${bytes.length}`,
  );
  return bytes;
}

/** Decode a 4-byte body buffer (discriminator already stripped)
 *  to a `WeaponSwitch`. Returns null on size mismatch. Mirrors
 *  the Rust `decode_weapon_switch` exactly.
 *
 *  The client transport (`serverTransport.ts`) does NOT receive
 *  WeaponSwitch inbound (only the server decodes them) — this
 *  decoder exists for symmetry with `decodeDamageBroadcast` /
 *  `decodeDamageReject` and for the cross-language `cargo test` ↔
 *  vitest round-trip guard (the smoke's wire-byte assertions use
 *  it indirectly). */
export function decodeWeaponSwitch(buf: Uint8Array): WeaponSwitch | null {
  if (buf.length !== WEAPON_SWITCH_BODY_SIZE) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    sourcePlayerId: dv.getUint16(0, false),
    weaponId: dv.getUint8(2),
    fireModeIndex: dv.getUint8(3),
  };
}

// =====================================================================
// PR #114 — MeleeEvent wire type (Phase 2 melee).
// =====================================================================
//
// Server-authoritative melee hit detection, mirrors the AimEvent
// (0x0A) shape but without the `is_firing` byte (melee is a
// single-tap, not a held state). Server runs a 60° proximity-cone
// check at 1.5m range against snapshot-known positions for every
// OTHER player in the room, emitting `DamageBroadcast`(s) for hits
// (using `MELEE_DAMAGE = 25`).
//
// **Discriminator slot**: 0x0B was reserved for `StateResyncRequest`
// per the brief's 0x07-0x0B reservation; the server-side
// `validate_and_relay_aim` docstring explicitly anticipated
// "Phase 2 melee work can add a `0x0B Melee` discriminator if
// needed." Reclaim pattern matches PR #107's `DAMAGE_REJECT →
// WeaponSwitch` (0x0C).
//
// **Wire-break**: PR #114 stacks onto the existing
// `next-deploy-is-all-clients-new` from PR #107+#108+#110. Pre-#114
// clients don't send MeleeEvents; the server's 0x0B dispatcher arm
// doesn't exist pre-#114. The unknown-discriminator fallback in
// `handle_binary` silently drops the packet pre-#114.

/** PR #114 — body size for `MeleeEvent` BODY (without the
 *  discriminator). Layout (big-endian):
 *    byte 0..1   source_player_id (u16 BE) — who swung
 *    byte 2..5   yaw_radians (f32 BE) — direction of swing
 *    byte 6..9   pitch_radians (f32 BE) — vertical aim
 *    byte 10..13 frame (u32 BE) — server frame for lag-comp
 *    byte 14..17 event_id (u32 BE) — monotonic per-tab counter
 *  Math: 2 + 4 + 4 + 4 + 4 = 18 bytes. */
export const MELEE_EVENT_BODY_SIZE = 2 + 4 + 4 + 4 + 4;

/** PR #114 — full on-the-wire packet (disc + body) = 19 bytes.
 *  Same wire size as AimEvent (`AIM_EVENT_WIRE_SIZE = 19`). */
export const MELEE_EVENT_WIRE_SIZE = MELEE_EVENT_BODY_SIZE + 1;

/** PR #114 — discriminator 0x0B for MeleeEvent. */
export const DISCRIMINATOR_MELEE_EVENT = 0x0B;

/**
 * Tab → Server. "I swung a melee at this yaw + pitch; tell me
 * who I hit." Server runs `melee_cone_hit` (proximity-cone check
 * against snapshot-known positions) for every OTHER player in
 * the room and emits `DamageBroadcast`(s) for hits.
 *
 * Wire layout (19 bytes — `MELEE_EVENT_WIRE_SIZE`):
 *   byte 0       discriminator 0x0B
 *   byte 1..2    sourcePlayerId (u16 BE)
 *   byte 3..6    yawRadians (f32 BE) — direction of swing
 *   byte 7..10   pitchRadians (f32 BE) — vertical aim
 *   byte 11..14  frame (u32 BE) — server frame for lag-comp
 *   byte 15..18  eventId (u32 BE) — monotonic per-tab counter
 *
 * No `targetPlayerId` (server iterates all OTHER players; same
 * pattern as AimEvent). No `is_firing` byte (melee is single-tap).
 *
 * **RMB keybind**: see `client/src/ui/App.tsx:499` —
 * `<Key>RMB</Key> melee (1.5m cone)` — the RMB keypress path
 * generates one MeleeEvent per RMB-down event.
 */
export interface MeleeEvent {
  sourcePlayerId: number;
  /** Yaw (radians, [-PI, PI]) at the moment of the swing. Server
   *  trusts this claim (anti-cheat is Phase 4 / PR 11.10). */
  yawRadians: number;
  /** Pitch (radians, [-PI/2, PI/2]) at the moment of the swing. */
  pitchRadians: number;
  /** Server frame at the moment of the swing. */
  frame: number;
  /** Monotonic per-tab counter (resets on tab reload; the server
   *  applies a bounded window of tolerance). */
  eventId: number;
}

/** Encode a `MeleeEvent` to a 19-byte wire-format `Uint8Array`
 *  (discriminator 0x0B + 18-byte body). Mirrors the Rust
 *  `encode_melee_event` body layout byte-for-byte.
 *
 *  **Caller responsibility**: the client is responsible for
 *  rate-limiting melee swings to `MELEE_COOLDOWN_MS` (220ms, the
 *  client's `COMBAT.melee.swingDurationMs`) so it doesn't burn
 *  the server-side rate-limit gate. The server gate is
 *  authoritative; the local gate just avoids wasted packets. */
export function encodeMeleeEvent(req: MeleeEvent): Uint8Array {
  const bytes = concatBytes([
    new Uint8Array([DISCRIMINATOR_MELEE_EVENT]), // disc 0x0B
    u16BE(req.sourcePlayerId),                   // BE u16 source_player_id
    f32BE(req.yawRadians),                      // BE f32 yaw_radians
    f32BE(req.pitchRadians),                    // BE f32 pitch_radians
    u32BE(req.frame),                           // BE u32 frame
    u32BE(req.eventId),                         // BE u32 event_id
  ]);
  console.assert(
    bytes.length === MELEE_EVENT_WIRE_SIZE,
    `encodeMeleeEvent: expected ${MELEE_EVENT_WIRE_SIZE} bytes, got ${bytes.length}`,
  );
  return bytes;
}

/** Decode an 18-byte body buffer (discriminator already stripped)
 *  to a `MeleeEvent`. Returns null on size mismatch. Mirrors the
 *  Rust `decode_melee_event` exactly.
 *
 *  The client transport does NOT receive MeleeEvent inbound (only
 *  the server decodes them) — this decoder exists for symmetry
 *  with `decodeAimEvent` / `decodeWeaponSwitch` and for the
 *  cross-language `cargo test` ↔ vitest round-trip guard (the
 *  smoke's wire-byte assertions use it indirectly). */
export function decodeMeleeEvent(buf: Uint8Array): MeleeEvent | null {
  if (buf.length !== MELEE_EVENT_BODY_SIZE) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    sourcePlayerId: dv.getUint16(0, false),
    yawRadians: dv.getFloat32(2, false),
    pitchRadians: dv.getFloat32(6, false),
    frame: dv.getUint32(10, false),
    eventId: dv.getUint32(14, false),
  };
}
