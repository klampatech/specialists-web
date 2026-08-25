// PR 11.7.E / §3.5 — TypeScript mirror of the server-side
// `ReloadRequest` wire format.
//
// **This file is the TS source of truth for the client-side
// ReloadRequest encoder/decoder.** The Rust definitions in
// `server/src/protocol.rs::ReloadRequest` + `encode_reload_request`
// + `decode_reload_request` are the canonical source of truth;
// this file MUST stay byte-for-byte in sync with them.
//
// **Wire convention** (same as `protocol/damage.ts`):
//   - Every TS encoder produces the full on-the-wire bytes
//     (disc + body).
//   - `*_BODY_SIZE` mirrors the Rust body-size constants;
//     `*_WIRE_SIZE = BODY_SIZE + 1`.
//
// **Wire layout** (7 bytes on the wire):
//   byte 0       discriminator 0x09
//   byte 1..2    source_player_id (u16 BE)
//   byte 3..6    event_id (u32 BE — monotonic per source)
//
// The server validates via `damage_relay::validate_and_relay_reload`
// and mutates `room.players[source].ammo = PLAYER_MAX_AMMO`. The
// next 20Hz Snapshot broadcast (0x07) carries the new ammo value to
// every connected tab — no private ack packet (PR 11.7.E locked
// decision #4).

// -- Discriminator (mirror of server/src/protocol.rs) -----------------

/** PR 11.7.E / §3.5 — client → server reload-request wire type.
 *  Validated server-side; on success the server's next 20Hz Snapshot
 *  fan-out carries the new `PLAYER_MAX_AMMO` to every connected tab. */
export const DISCRIMINATOR_RELOAD_REQUEST = 0x09;

// -- Body-size constants (mirror of server/src/protocol.rs) ---------

/** PR 11.7.E / §3.5 — wire size for the ReloadRequest BODY (without
 *  the discriminator). 2 (source_player_id u16 BE) + 4 (event_id u32
 *  BE) = 6 bytes. */
export const RELOAD_REQUEST_BODY_SIZE = 6;

/** PR 11.7.E / §3.5 — full on-the-wire packet (disc + body) = 7 bytes. */
export const RELOAD_REQUEST_WIRE_SIZE = RELOAD_REQUEST_BODY_SIZE + 1;

// -- Wire-format interface --------------------------------------------

/**
 * Tab → Server. "Reload my pistol magazine."
 *
 * Wire layout (7 bytes — `RELOAD_REQUEST_WIRE_SIZE`):
 *   byte 0       discriminator 0x09
 *   byte 1..2    sourcePlayerId (u16 BE)
 *   byte 3..6    eventId (u32 BE)
 */
export interface ReloadRequest {
  playerId: number;
  /** Monotonic per-source counter. Mirrors `DamageRequest.eventId`'s
   *  rationale in `protocol/damage.ts` — the server uses it for
   *  replay protection (reject stale eventIds within
   *  `RELOAD_EVENT_ID_WINDOW` of the last seen value). */
  eventId: number;
}

// -- Encoder / decoder pair -------------------------------------------

/** Concatenate Uint8Arrays into a single Uint8Array. Mirrors the
 *  same helper in `protocol/damage.ts` (kept local so this file
 *  has no cross-module dependency beyond the discriminator
 *  constants). */
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

/** Encode a `ReloadRequest` to a 7-byte wire-format `Uint8Array`
 *  (discriminator 0x09 + 6-byte body). Mirrors the Rust
 *  `encode_reload_request` body layout byte-for-byte. */
export function encodeReloadRequest(req: ReloadRequest): Uint8Array {
  const bytes = concatBytes([
    new Uint8Array([DISCRIMINATOR_RELOAD_REQUEST]), // disc
    u16BE(req.playerId),    // BE u16 source_player_id
    u32BE(req.eventId),     // BE u32 event_id
  ]);
  console.assert(
    bytes.length === RELOAD_REQUEST_WIRE_SIZE,
    `encodeReloadRequest: expected ${RELOAD_REQUEST_WIRE_SIZE} bytes, got ${bytes.length}`,
  );
  return bytes;
}

/** Decode a 6-byte body buffer (discriminator byte already stripped
 *  by the caller) to a `ReloadRequest`. Returns null on size
 *  mismatch. Mirrors the Rust `decode_reload_request` exactly.
 *
 *  The client transport (`serverTransport.ts`) does NOT receive
 *  ReloadRequests inbound (only the server decodes them) — this
 *  decoder exists for symmetry with `protocol/damage.ts` (where
 *  every wire type has both encode + decode for round-trip testing)
 *  and for the cross-language `cargo test` ↔ vitest round-trip
 *  guard (the smoke's wire-byte assertions use it indirectly). */
export function decodeReloadRequest(buf: Uint8Array): ReloadRequest | null {
  if (buf.length !== RELOAD_REQUEST_BODY_SIZE) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    playerId: dv.getUint16(0, false),
    eventId: dv.getUint32(2, false),
  };
}
