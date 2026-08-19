// PR 11.7.B / §3.5 + §3.10.1 — TypeScript mirror of the server-side
// Snapshot wire format.
//
// **This file is the TS single source of truth for the
// client-side Snapshot decoder.** The Rust definitions in
// `server/src/protocol.rs` (PlayerState + Snapshot + encode/decode
// + DISCRIMINATOR_SNAPSHOT) are the canonical source of truth;
// this file MUST stay byte-for-byte in sync with them. The size
// assertion at the end of `encodeSnapshot` catches drift the
// same way the Rust `debug_assert_eq!` does.
//
// **Wire convention** (same as `protocol/damage.ts`):
//   - Every TS encoder produces the full on-the-wire bytes
//     (disc + body).
//   - `*_BODY_SIZE` mirrors the Rust body-size constants;
//     `*_WIRE_SIZE = BODY_SIZE + 1`.
//
// **2D convention**: positions are XZ (the wire carries `x` +
// `y` for the horizontal plane; the height is implicit on the
// Rapier capsule body and not broadcast this PR — see §3.5).

// -- Discriminator table (mirror of server/src/protocol.rs) -----

/** PR 11.7.B / §3.5 — server → client authoritative-state
 *  broadcast. Sent at `SNAPSHOT_RATE_HZ` (20Hz per the brief's
 *  locked decision Q2) to every connected tab in the room.
 *  PR 11.7.C consumes this in `predictor.ts` + `interpolator.ts`
 *  for local prediction + remote interpolation. */
export const DISCRIMINATOR_SNAPSHOT = 0x07;

/** PR 11.7.B / §3.5 — client → server snapshot-ack packet.
 *  Constant-only declaration this PR (no encoder/decoder
 *  shipped — the client doesn't send StateAck yet). PR 11.7.C
 *  wires the encoder + dispatcher. */
export const DISCRIMINATOR_STATE_ACK = 0x08;

// -- Body-size constants (mirror of server/src/protocol.rs) ----

/** PR 11.7.B / §3.5 — wire size for the Snapshot BODY (without
 *  the discriminator). 4 (serverFrame u32 BE) + 4
 *  (nextServerFrame u32 BE) + 1 (playerCount u8) = 9 bytes.
 *  Variable-length payload: total body = 9 + player_count *
 *  `PLAYER_STATE_BODY_SIZE`. */
export const SNAPSHOT_BODY_SIZE = 9;

/** PR 11.7.B / §3.5 — per-player payload size. 2 (playerId
 *  u16 BE) + 4 (positionX f32 BE) + 4 (positionY f32 BE) + 4
 *  (velocityX f32 BE) + 4 (velocityY f32 BE) + 4 (yaw f32 BE) +
 *  4 (pitch f32 BE) + 1 (hp u8) + 1 (ammo u8) + 1 (isFiring
 *  u8) = 29 bytes. */
export const PLAYER_STATE_BODY_SIZE = 29;

// -- Wire-size constants (disc + body — full packet) ------------

/** PR 11.7.B / §3.5 — `0x07` discriminator + 9-byte body =
 *  10 bytes minimum (when playerCount = 0). */
export const SNAPSHOT_WIRE_SIZE_MIN = SNAPSHOT_BODY_SIZE + 1;

/** PR 11.7.B / §3.5 — `0x07` discriminator + 9-byte body +
 *  player_count * 29-byte player payload. Variable-length. */
export function snapshotWireSize(playerCount: number): number {
  return SNAPSHOT_WIRE_SIZE_MIN + playerCount * PLAYER_STATE_BODY_SIZE;
}

// -- Wire-format interfaces (mirror of server/src/protocol.rs) -

/**
 * Per-player state inside a Snapshot. Mirrors
 * `server/src/protocol.rs::PlayerState`.
 *
 * Wire layout (29 bytes — `PLAYER_STATE_BODY_SIZE`):
 *   byte 0..1    playerId (u16 BE)
 *   byte 2..5    positionX (f32 BE)
 *   byte 6..9    positionY (f32 BE)
 *   byte 10..13  velocityX (f32 BE)
 *   byte 14..17  velocityY (f32 BE)
 *   byte 18..21  yaw (f32 BE — radians)
 *   byte 22..25  pitch (f32 BE — radians)
 *   byte 26      hp (u8)
 *   byte 27      ammo (u8)
 *   byte 28      isFiring (u8 — 0 or 1)
 */
export interface PlayerState {
  playerId: number;
  positionX: number;
  positionY: number;
  velocityX: number;
  velocityY: number;
  /** Radians — 0..2π on the client. */
  yaw: number;
  /** Radians — -π/2..+π/2 on the client. */
  pitch: number;
  hp: number;
  ammo: number;
  /** 0 or 1. Wire-compatible bool. */
  isFiring: number;
}

/**
 * Server → all tabs. The 20Hz authoritative-state broadcast.
 * Mirrors `server/src/protocol.rs::Snapshot`.
 *
 * Wire layout (10 + player_count * 29 bytes — `snapshotWireSize`):
 *   byte 0       discriminator 0x07
 *   byte 1..4    serverFrame (u32 BE — the just-stepped authoritative frame)
 *   byte 5..8    nextServerFrame (u32 BE — what clients should predict to next)
 *   byte 9       playerCount (u8 — up to 255; well above MAX_PLAYERS_PER_ROOM = 24)
 *   byte 10..    PlayerState[playerCount] (each 29 bytes — `PlayerState` above)
 */
export interface Snapshot {
  serverFrame: number;
  nextServerFrame: number;
  players: PlayerState[];
}

// -- Encoder / decoder pair -------------------------------------

/** Concatenate Uint8Arrays into a single Uint8Array. Mirrors
 *  the same helper in `protocol/damage.ts`. Used by the
 *  encoder to build wire bytes incrementally so the size
 *  assertion at the end catches drift (vs. allocating a
 *  fixed-length buffer up-front, where the assertion would be
 *  tautological). */
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

/** Convert a JS number to a 4-byte big-endian f32 Uint8Array.
 *  Uses DataView.setFloat32 for IEEE 754 compliance. */
function f32BE(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  const dv = new DataView(buf.buffer);
  dv.setFloat32(0, value, false);
  return buf;
}

/** Convert a JS number to a 4-byte big-endian u32 Uint8Array. */
function u32BE(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, value >>> 0, false);
  return buf;
}

/** Convert a JS number to a 2-byte big-endian u16 Uint8Array. */
function u16BE(value: number): Uint8Array {
  const buf = new Uint8Array(2);
  const dv = new DataView(buf.buffer);
  dv.setUint16(0, value & 0xffff, false);
  return buf;
}

/**
 * PR 11.7.B / §3.5 — encode a `Snapshot` to wire bytes.
 * Mirror of the Rust `encode_snapshot`. Returns the full
 * on-the-wire packet (disc + body). The size assertion at the
 * end catches wire drift (vs. the Rust `debug_assert_eq!`).
 */
export function encodeSnapshot(snap: Snapshot): Uint8Array {
  // Header: disc + serverFrame + nextServerFrame + playerCount.
  const headerBytes = concatBytes([
    new Uint8Array([DISCRIMINATOR_SNAPSHOT]),
    u32BE(snap.serverFrame),
    u32BE(snap.nextServerFrame),
    new Uint8Array([snap.players.length & 0xff]),
  ]);
  // Per-player payload: 29 bytes each, concatBytes builds the
  // total incrementally so the size assertion below catches
  // drift.
  const playerBytes = snap.players.map((p) =>
    concatBytes([
      u16BE(p.playerId),
      f32BE(p.positionX),
      f32BE(p.positionY),
      f32BE(p.velocityX),
      f32BE(p.velocityY),
      f32BE(p.yaw),
      f32BE(p.pitch),
      new Uint8Array([p.hp & 0xff]),
      new Uint8Array([p.ammo & 0xff]),
      new Uint8Array([p.isFiring & 0xff]),
    ]),
  );
  const out = concatBytes([headerBytes, ...playerBytes]);
  // Size assertion — mirrors the Rust `debug_assert_eq!`.
  const expected = snapshotWireSize(snap.players.length);
  console.assert(
    out.length === expected,
    `encodeSnapshot: expected ${expected} bytes, got ${out.length}`,
  );
  return out;
}

/**
 * PR 11.7.B / §3.5 — decode a wire-format Snapshot. Returns
 * `null` on any size / discriminator mismatch. Mirror of the
 * Rust `decode_snapshot`.
 */
export function decodeSnapshot(buf: Uint8Array): Snapshot | null {
  // Minimum wire size: 1 disc + 4 serverFrame + 4 nextServerFrame + 1 playerCount = 10.
  if (buf.length < SNAPSHOT_WIRE_SIZE_MIN) return null;
  if (buf[0] !== DISCRIMINATOR_SNAPSHOT) return null;
  // Per-player payload size: 29 bytes each.
  const bodySize = buf.length - SNAPSHOT_WIRE_SIZE_MIN;
  if (bodySize % PLAYER_STATE_BODY_SIZE !== 0) return null;
  const nPlayers = bodySize / PLAYER_STATE_BODY_SIZE;
  if (nPlayers > 0xff) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const serverFrame = dv.getUint32(1, false);
  const nextServerFrame = dv.getUint32(5, false);
  const playerCount = dv.getUint8(9);
  if (playerCount !== nPlayers) return null;
  const players: PlayerState[] = [];
  for (let i = 0; i < playerCount; i++) {
    const off = 10 + i * PLAYER_STATE_BODY_SIZE;
    players.push({
      playerId: dv.getUint16(off + 0, false),
      positionX: dv.getFloat32(off + 2, false),
      positionY: dv.getFloat32(off + 6, false),
      velocityX: dv.getFloat32(off + 10, false),
      velocityY: dv.getFloat32(off + 14, false),
      yaw: dv.getFloat32(off + 18, false),
      pitch: dv.getFloat32(off + 22, false),
      hp: dv.getUint8(off + 26),
      ammo: dv.getUint8(off + 27),
      isFiring: dv.getUint8(off + 28),
    });
  }
  return { serverFrame, nextServerFrame, players };
}
