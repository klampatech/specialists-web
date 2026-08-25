// PR 11.6.B / §3.5 — wire-format codecs + discriminator table.
//
// Hand-rolled wire formats MUST have size assertions — see
// `server/tests/protocol_wire.rs`. Every encoder ends with a debug
// assert that the produced `Vec<u8>` is exactly the documented size;
// every test re-runs the assert via the public API. This catches the
// off-by-one class that bit PR 11.6.A's draft (claimed 8 / 13 bytes
// for damage; actual 14 / 18).
//
// PR 11.6.C review fix B2 — wire convention: the Rust `encode_*`
// functions return the BODY only (no discriminator); the transport
// router in `transport.rs` prepends the discriminator byte to form
// the on-the-wire packet. The TS encoders in `protocol/damage.ts`
// have been updated to match this convention on the wire — every TS
// encoder produces the full packet (disc + body), so the size
// constants are split: `*_WIRE_SIZE` is the on-the-wire packet
// (disc + body), and the Rust `pub const` here documents the body
// size. The TS `*_BODY_SIZE` constants mirror the Rust body sizes
// exactly; the TS `*_WIRE_SIZE` is `BODY_SIZE + 1`.
//
// Endianness: BIG-endian for every wire format in this module. The
// damage/position/rtt types are server-issued counters + RTT
// timestamps, all of which read more naturally in BE. The CLIENT's
// lockstep input packet (`client/src/net/inputBitmask.ts`) uses
// little-endian on bytes 2-5 (yaw/pitch) — that's a different wire
// format on a different code path, not a contradiction.

use bytes::{Buf, BufMut};

/// Discriminator table from §3.5. The transport's first byte selects
/// the wire type; everything past byte 0 is the per-type payload.
///
/// `0x00` is the legacy P2P lockstep input (INPUT_SIZE = 12 bytes,
/// forwarded by the server in PR 11.6.C). PR 11.6.B's canary
/// discards it (`_ => log` in the router) since the rest of the
/// damage pipeline isn't wired yet.
pub const DISCRIMINATOR_INPUTS: u8 = 0x00;
pub const DISCRIMINATOR_DAMAGE_REQUEST: u8 = 0x01;
pub const DISCRIMINATOR_DAMAGE_BROADCAST: u8 = 0x02;
pub const DISCRIMINATOR_POSITION_UPDATE: u8 = 0x03;
pub const DISCRIMINATOR_PING: u8 = 0x04;
pub const DISCRIMINATOR_PONG: u8 = 0x05;
/// NEW §1.2 — server-relayed inputs for PR 11.7 handoff. PR 11.6.B
/// buffers but does not process.
pub const DISCRIMINATOR_INPUTS_SERVER: u8 = 0x06;
/// PR 11.6.D FIX 4: server sends a DamageReject back to the source
/// tab only (NOT broadcast) when the validator rejects a
/// DamageRequest. The reject is privacy-scoped to the source's
/// connection so peer tabs don't learn about the rejection.
// PR 11.7.B: bumped from 0x07 to 0x0C. The brief locks
// `DISCRIMINATOR_SNAPSHOT = 0x07` and the plan §3.5 reserves
// 0x07-0x0B for PR 11.7 types (Snapshot/StateAck/InputSeq/
// ReloadRequest/StateResyncRequest). 0x0C is the next free slot
// after those reservations. This is a wire-format breaking change
// vs PR 11.6.D's 0x07; the client-side `protocol/damage.ts`
// constant moves in lockstep.
pub const DISCRIMINATOR_DAMAGE_REJECT: u8 = 0x0C;

/// Wire-size constants (from §3.5). PR 11.6.C: these are the BODY
/// sizes (what the Rust `encode_*` returns). The on-the-wire packet
/// is `1 + BODY_SIZE` bytes (discriminator + body); the TS mirror at
/// `protocol/damage.ts` exports both `DAMAGE_REQUEST_BODY_SIZE` (==
/// this constant) and `DAMAGE_REQUEST_WIRE_SIZE` (== this constant +
/// 1). The constants MUST stay in sync with the TS body sizes.
pub const DAMAGE_REQUEST_WIRE_SIZE: usize = 14;
pub const DAMAGE_BROADCAST_WIRE_SIZE: usize = 18;
pub const POSITION_UPDATE_WIRE_SIZE: usize = 14;
pub const PING_WIRE_SIZE: usize = 4;
pub const PONG_WIRE_SIZE: usize = 8;
/// `0x06` discriminator + u32 frame BE + 12-byte input blob +
/// u32 last_inputs_seq BE = 21 bytes total. INPUT_SIZE = 12 comes
/// from `client/src/net/inputBitmask.ts`.
///
/// PR 11.7.D2 / §1.2: wire size bumped 17 → 21 to carry the
/// per-source `last_inputs_seq` trailer (one u32 BE). The server's
/// `validate_and_relay` uses this for replay protection — the
/// server's lag-comp math consumes the freshest input per frame;
/// an out-of-order `inputs_seq` is a sign the client is dropping
/// packets and the server should ignore rather than apply an old
/// input as if it were current.
///
/// Brief originally specified 18 — off-by-3 math error in the
/// brief (same class as the original PR 11.6.A DamageRequest 8 → 14
/// mistake). Math wins: 1 (disc) + 4 (frame) + 12 (input) + 4
/// (trailer) = 21.
///
/// Mirror of `protocol/damage.ts::INPUTS_SERVER_WIRE_SIZE` and
/// `protocol/constants.ts::WIRE_SIZE_INPUTS_SERVER_WITH_SEQ`.
pub const INPUTS_SERVER_WIRE_SIZE: usize = 21;
/// PR 11.7.D2 — body size (disc byte already stripped by the caller).
/// 21 (wire) - 1 (disc) = 20 bytes. Body layout: u32 frame (4) +
/// 12-byte input + u32 last_inputs_seq (4) = 20. ✓
pub const INPUTS_SERVER_BODY_SIZE: usize = INPUTS_SERVER_WIRE_SIZE - 1;
/// PR 11.6.D FIX 4: body size of `DamageReject` (event_id u32 BE + reason u8 = 5).
pub const DAMAGE_REJECT_BODY_SIZE: usize = 5;

/// PR 11.6.D FIX 4: reject reason codes. Wire-format-stable.
pub const REJECT_REASON_FIRE_RATE: u8 = 0;
pub const REJECT_REASON_AMMO: u8 = 1;
pub const REJECT_REASON_EVENT_ID: u8 = 2;
pub const REJECT_REASON_LAG_MISS: u8 = 3;
pub const REJECT_REASON_NO_HISTORY: u8 = 4;

// PR 11.7.B / §3.5 — new discriminator constants. PR 11.7.B
// introduces the `Snapshot` wire type (server → client). `StateAck` is
// declared as a constant in this PR but the encoder/decoder is
// deferred to PR 11.7.C (the client doesn't send StateAck yet, so
// only the discriminator reservation matters here).
pub const DISCRIMINATOR_SNAPSHOT: u8 = 0x07;
pub const DISCRIMINATOR_STATE_ACK: u8 = 0x08;
pub const DISCRIMINATOR_RELOAD_REQUEST: u8 = 0x09;


/// PR 11.7.B / §3.5 — wire-size constant for the Snapshot BODY
/// (the disc byte is prepended by the transport router, matching
/// the DamageBroadcast / DamageReject / etc. convention). Body = 4
/// (serverFrame u32 BE) + 4 (nextServerFrame u32 BE) + 1
/// (playerCount u8) = 9 bytes. Per-player payload is 29 bytes (see
/// `PLAYER_STATE_WIRE_SIZE`). Variable-length payload: total body =
/// 9 + player_count * 29 bytes. On-the-wire size (disc + body) =
/// 10 + player_count * 29 bytes. At 24p: 10 + 24*29 = 706 bytes; at
/// 20Hz: 14.1 KB/s/server outbound (vs 21.5 KB/s for PR 11.6.D's
/// per-player `PositionUpdate` at 32Hz — ·2x bandwidth reduction
/// per the plan §3.10.1 math).
pub const SNAPSHOT_WIRE_SIZE_MIN: usize = 4 + 4 + 1;

/// Per-player payload size in a `Snapshot`. 2 + 4 + 4 + 4 + 4 + 4 + 4
/// + 1 + 1 + 1 = 29 bytes:
///   2  playerId u16 BE
///   4  positionX f32 BE
///   4  positionY f32 BE
///   4  velocityX f32 BE
///   4  velocityY f32 BE
///   4  yaw f32 BE (radians; 0..2π on the client, signed f32 here)
///   4  pitch f32 BE (radians; -π/2..+π/2 on the client)
///   1  hp u8
///   1  ammo u8
///   1  isFiring u8 (0 or 1 — wire-compatible bool for forward-compat
///      with snapshot consumers that don't need a full bool)

// -- ReloadRequest (PR 11.7.E) ----------------------------------------------

/// PR 11.7.E / §3.5 - `ReloadRequest` body size. Layout (big-endian):
///   byte 0..1  source_player_id (u16 BE)
///   byte 2..5  event_id (u32 BE - monotonic per source, mirrors
///              DamageRequest::event_id for the same replay-protection
///              rationale in `damage_relay::validate_and_relay`)
/// = 6 bytes body. Wire packet = 7 bytes (disc + body).
pub const RELOAD_REQUEST_BODY_SIZE: usize = 2 + 4;
/// PR 11.7.E / §3.5 - full on-the-wire packet (disc + body) = 7 bytes.
pub const RELOAD_REQUEST_WIRE_SIZE: usize = RELOAD_REQUEST_BODY_SIZE + 1;

/// PR 11.7.E / §3.5 - tab -> server. "Reload my pistol magazine."
///
/// Server validates via `damage_relay::validate_and_relay_reload`
/// (8 gates paralleling `validate_and_relay`) and mutates
/// `room.players[source].ammo = PLAYER_MAX_AMMO`. No outgoing
/// packet - the next Snapshot fan-out carries the new ammo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReloadRequest {
    pub source_player_id: u16,
    pub event_id: u32,
}

pub fn encode_reload_request(req: &ReloadRequest) -> Vec<u8> {
    let mut buf = Vec::with_capacity(RELOAD_REQUEST_BODY_SIZE);
    buf.put_u16(req.source_player_id);
    buf.put_u32(req.event_id);
    debug_assert_eq!(buf.len(), RELOAD_REQUEST_BODY_SIZE);
    buf
}

pub fn decode_reload_request(buf: &[u8]) -> Option<ReloadRequest> {
    if buf.len() != RELOAD_REQUEST_BODY_SIZE {
        return None;
    }
    let mut b = buf;
    Some(ReloadRequest {
        source_player_id: b.get_u16(),
        event_id: b.get_u32(),
    })
}
pub const PLAYER_STATE_WIRE_SIZE: usize = 29;

// -- DamageRequest --------------------------------------------------------

/// Tab → Server. "I think this damage happened."
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DamageRequest {
    pub frame: u32,
    pub source_player_id: u16,
    pub target_player_id: u16,
    /// `0` = fire, `1` = melee (per §3.5).
    pub source: u8,
    pub amount: u8,
    pub event_id: u32,
}

pub fn encode_damage_request(req: &DamageRequest) -> Vec<u8> {
    let mut buf = Vec::with_capacity(DAMAGE_REQUEST_WIRE_SIZE);
    buf.put_u32(req.frame);
    buf.put_u16(req.source_player_id);
    buf.put_u16(req.target_player_id);
    buf.put_u8(req.source);
    buf.put_u8(req.amount);
    buf.put_u32(req.event_id);
    debug_assert_eq!(buf.len(), DAMAGE_REQUEST_WIRE_SIZE);
    buf
}

pub fn decode_damage_request(buf: &[u8]) -> Option<DamageRequest> {
    if buf.len() != DAMAGE_REQUEST_WIRE_SIZE {
        return None;
    }
    let mut b = buf;
    Some(DamageRequest {
        frame: b.get_u32(),
        source_player_id: b.get_u16(),
        target_player_id: b.get_u16(),
        source: b.get_u8(),
        amount: b.get_u8(),
        event_id: b.get_u32(),
    })
}

// -- DamageBroadcast ------------------------------------------------------

/// Server → all tabs in the room. "This damage is canonical."
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DamageBroadcast {
    pub server_frame: u32,
    pub server_seq: u32,
    pub source_player_id: u16,
    pub target_player_id: u16,
    pub source: u8,
    pub amount: u8,
    pub origin_event_id: u32,
}

pub fn encode_damage_broadcast(bc: &DamageBroadcast) -> Vec<u8> {
    let mut buf = Vec::with_capacity(DAMAGE_BROADCAST_WIRE_SIZE);
    buf.put_u32(bc.server_frame);
    buf.put_u32(bc.server_seq);
    buf.put_u16(bc.source_player_id);
    buf.put_u16(bc.target_player_id);
    buf.put_u8(bc.source);
    buf.put_u8(bc.amount);
    buf.put_u32(bc.origin_event_id);
    debug_assert_eq!(buf.len(), DAMAGE_BROADCAST_WIRE_SIZE);
    buf
}

pub fn decode_damage_broadcast(buf: &[u8]) -> Option<DamageBroadcast> {
    if buf.len() != DAMAGE_BROADCAST_WIRE_SIZE {
        return None;
    }
    let mut b = buf;
    Some(DamageBroadcast {
        server_frame: b.get_u32(),
        server_seq: b.get_u32(),
        source_player_id: b.get_u16(),
        target_player_id: b.get_u16(),
        source: b.get_u8(),
        amount: b.get_u8(),
        origin_event_id: b.get_u32(),
    })
}

// -- DamageReject ----------------------------------------------------------

/// PR 11.6.D FIX 4: Server → Source-tab. Private reject signal.
/// Sent when the validator rejects a `DamageRequest` (fire-rate,
/// ammo, eventId, lag-miss, no-history). The source tab uses this
/// to revert the optimistic apply it made locally.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DamageReject {
    pub event_id: u32,
    /// 0 = fire-rate, 1 = ammo, 2 = eventId, 3 = lag-miss, 4 = no-history.
    pub reason: u8,
}

pub fn encode_damage_reject(r: &DamageReject) -> Vec<u8> {
    let mut buf = Vec::with_capacity(DAMAGE_REJECT_BODY_SIZE);
    buf.put_u32(r.event_id);
    buf.put_u8(r.reason);
    debug_assert_eq!(
        buf.len(),
        DAMAGE_REJECT_BODY_SIZE,
        "encode_damage_reject: produced {} bytes, expected {}",
        buf.len(),
        DAMAGE_REJECT_BODY_SIZE,
    );
    buf
}

pub fn decode_damage_reject(buf: &[u8]) -> Option<DamageReject> {
    if buf.len() != DAMAGE_REJECT_BODY_SIZE {
        return None;
    }
    let mut cursor = std::io::Cursor::new(buf);
    use std::io::Read;
    let mut eid_bytes = [0u8; 4];
    cursor.read_exact(&mut eid_bytes).ok()?;
    let event_id = u32::from_be_bytes(eid_bytes);
    let mut reason_byte = [0u8; 1];
    cursor.read_exact(&mut reason_byte).ok()?;
    Some(DamageReject {
        event_id,
        reason: reason_byte[0],
    })
}

// -- PositionUpdate -------------------------------------------------------

/// Tab → Server. "Here is my current pose." Sent every tick (or
/// throttled to 32Hz per §3.10). Powers `PositionHistory` on the
/// server (§3.4.1) for lag compensation.
///
/// NOTE: the wire format carries only x + y (14 bytes). z is constant
/// on the flat demo map and re-derived server-side from the player's
/// recorded height (see §3.5 note). If z becomes meaningful this grows
/// to 18 bytes; that's PR 11.7+ territory.
#[derive(Debug, Clone, PartialEq)]
pub struct PositionUpdate {
    pub server_frame: u32,
    pub player_id: u16,
    pub position_x: f32,
    pub position_y: f32,
}

pub fn encode_position_update(pu: &PositionUpdate) -> Vec<u8> {
    let mut buf = Vec::with_capacity(POSITION_UPDATE_WIRE_SIZE);
    buf.put_u32(pu.server_frame);
    buf.put_u16(pu.player_id);
    buf.put_f32(pu.position_x);
    buf.put_f32(pu.position_y);
    debug_assert_eq!(buf.len(), POSITION_UPDATE_WIRE_SIZE);
    buf
}

pub fn decode_position_update(buf: &[u8]) -> Option<PositionUpdate> {
    if buf.len() != POSITION_UPDATE_WIRE_SIZE {
        return None;
    }
    let mut b = buf;
    Some(PositionUpdate {
        server_frame: b.get_u32(),
        player_id: b.get_u16(),
        position_x: b.get_f32(),
        position_y: b.get_f32(),
    })
}

// -- Ping -----------------------------------------------------------------

/// Tab → Server. "What's my RTT?" Server responds with `Pong`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ping {
    pub client_timestamp: u32,
}

pub fn encode_ping(p: &Ping) -> Vec<u8> {
    let mut buf = Vec::with_capacity(PING_WIRE_SIZE);
    buf.put_u32(p.client_timestamp);
    debug_assert_eq!(buf.len(), PING_WIRE_SIZE);
    buf
}

pub fn decode_ping(buf: &[u8]) -> Option<Ping> {
    if buf.len() != PING_WIRE_SIZE {
        return None;
    }
    let mut b = buf;
    Some(Ping {
        client_timestamp: b.get_u32(),
    })
}

// -- Pong -----------------------------------------------------------------

/// Server → Tab. Pong echoes the client's timestamp plus the server's
/// own clock so clients can also measure server-clock skew.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pong {
    pub client_timestamp: u32,
    pub server_timestamp: u32,
}

pub fn encode_pong(p: &Pong) -> Vec<u8> {
    let mut buf = Vec::with_capacity(PONG_WIRE_SIZE);
    buf.put_u32(p.client_timestamp);
    buf.put_u32(p.server_timestamp);
    debug_assert_eq!(buf.len(), PONG_WIRE_SIZE);
    buf
}

pub fn decode_pong(buf: &[u8]) -> Option<Pong> {
    if buf.len() != PONG_WIRE_SIZE {
        return None;
    }
    let mut b = buf;
    Some(Pong {
        client_timestamp: b.get_u32(),
        server_timestamp: b.get_u32(),
    })
}

// -- InputsServer (NEW §1.2) ---------------------------------------------

/// NEW §1.2 — Tab → Server. "Here is my encoded input at this frame."
/// PR 11.6.BUFFERS the message onto `Room.inputs_buffer`; PR 11.7
/// consumes it for snapshot generation + lag-comp math.
///
/// PR 11.7.D2 / §1.2: appends `last_inputs_seq` (one u32 BE) for
/// replay protection. Server drops inputs whose `last_inputs_seq`
/// is older than the last seen seq for the source.
///
/// Wire layout:
///   byte 0       discriminator 0x06
///   byte 1..4    frame (u32 BE)
///   byte 5..16   encoded input (12 bytes — INPUT_SIZE from
///                `client/src/net/inputBitmask.ts`)
///   byte 17..20  last_inputs_seq (u32 BE)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputsServer {
    pub frame: u32,
    /// 12-byte input blob. We store it as `Vec<u8>` rather than `[u8; 12]`
    /// because the discriminator + frame prefix is sometimes stripped by
    /// the transport layer before this struct is constructed (see
    /// `transport::handle_inputs_server_payload`).
    pub encoded_input: Vec<u8>,
    /// PR 11.7.D2 / §1.2: sender's monotonic inputs_seq counter.
    /// Server uses this for replay protection — drops the input if
    /// `last_inputs_seq` is older than the last seen seq for the source.
    pub last_inputs_seq: u32,
}

pub fn encode_inputs_server(payload: &InputsServer) -> Vec<u8> {
    let mut buf = Vec::with_capacity(INPUTS_SERVER_WIRE_SIZE);
    buf.put_u8(DISCRIMINATOR_INPUTS_SERVER);
    buf.put_u32(payload.frame);
    if payload.encoded_input.len() != 12 {
        panic!(
            "encode_inputs_server: encoded_input must be 12 bytes (INPUT_SIZE), got {}",
            payload.encoded_input.len()
        );
    }
    buf.extend_from_slice(&payload.encoded_input);
    // PR 11.7.D2 / §1.2: append the last_inputs_seq trailer (u32 BE).
    buf.put_u32(payload.last_inputs_seq);
    debug_assert_eq!(buf.len(), INPUTS_SERVER_WIRE_SIZE);
    buf
}

pub fn decode_inputs_server(buf: &[u8]) -> Option<InputsServer> {
    if buf.len() != INPUTS_SERVER_WIRE_SIZE {
        return None;
    }
    if buf[0] != DISCRIMINATOR_INPUTS_SERVER {
        return None;
    }
    let mut b = &buf[1..];
    let frame = b.get_u32();
    let mut encoded_input = [0u8; 12];
    encoded_input.copy_from_slice(&b[..12]);
    // Advance past the 12-byte input blob (b is already past the disc
    // byte and the 4-byte frame header at this point; consume 12 bytes
    // of input + 4 bytes of last_inputs_seq trailer).
    let mut last_inputs_seq_bytes = [0u8; 4];
    // b has 12 input bytes + 4 trailer bytes remaining (16 bytes total).
    // Skip the 12 input bytes, then read 4 trailer bytes.
    let input_slice = &b[..12];
    // We've already consumed the 12 bytes into encoded_input; advance b.
    let _ = input_slice; // suppress unused warning
    b = &b[12..];
    last_inputs_seq_bytes.copy_from_slice(&b[..4]);
    let last_inputs_seq = u32::from_be_bytes(last_inputs_seq_bytes);
    Some(InputsServer {
        frame,
        encoded_input: encoded_input.to_vec(),
        last_inputs_seq,
    })
}

// -- Snapshot (NEW §3.5) -----------------------------------------------

/// PR 11.7.B / §3.5 — server-to-client authoritative-state
/// broadcast. Sent at `SNAPSHOT_RATE_HZ` (20Hz, per the plan Q2 +
/// §3.4 + §3.10.1) to every connected tab in the room. The client
/// uses the snapshot's local-player state to reconcile its Havok
/// prediction (`predictor.ts` in PR 11.7.C) and the snapshot's
/// remote-player states to advance its interpolation buffer
/// (`interpolator.ts`).
///
/// **2D convention**: `position_x` + `position_y` are the XZ-plane
/// coordinates. `z` (height) is the server's authoritative capsule
/// y (carried implicitly as the position's `y` field). On the wire
/// these are 2D floats (matches the PR 11.6.B/C/D `Position` type).
/// PR 11.7.B keeps the same 2D wire shape — the server-side Rapier
/// state IS 3D (XZ + Y for height) but only the XZ pair is broadcast
/// per the existing wire convention. The receiver's
/// `predictor.ts` (PR 11.7.C) maps XZ back to world coordinates using
/// the local scene's coordinate system.
///
/// **Byte-endian**: every multi-byte field is BIG-endian (matches
/// the existing wire convention; see the module-level note).
#[derive(Debug, Clone, PartialEq)]
pub struct PlayerState {
    pub player_id: PlayerIdT,
    pub position_x: f32,
    pub position_y: f32,
    pub velocity_x: f32,
    pub velocity_y: f32,
    pub yaw: f32,
    pub pitch: f32,
    pub hp: u8,
    pub ammo: u8,
    /// 0 = not firing, 1 = firing. Wire-compatible bool.
    pub is_firing: u8,
}

/// `PlayerId` is a `u16` on the wire. Mirrored as `PlayerIdT` to
/// avoid the dep on `session.rs` in this module (the encoder/decoder
/// only need the numeric type).
pub type PlayerIdT = u16;

/// `ServerFrame` matches `session::ServerFrame = u32`.
pub type ServerFrameT = u32;

#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub server_frame: ServerFrameT,
    /// The frame clients should predict to NEXT. Server-frame-1 is
    /// the just-stepped authoritative frame; next_server_frame is the
    /// frame in progress (so the client knows what to advance to
    /// before the next snapshot arrives).
    pub next_server_frame: ServerFrameT,
    pub players: Vec<PlayerState>,
}

/// PR 11.7.B / §3.5 — encode a `Snapshot` to wire bytes. Header
/// + variable-length player list. Discriminator is NOT prefixed; the
/// transport router adds the `DISCRIMINATOR_SNAPSHOT` byte (same
/// pattern as the existing `DamageBroadcast` and other outbound
/// wire types — see the module-level note on body vs wire sizes).
///
/// `debug_assert_eq!` on the produced length catches the
/// `PLAYER_STATE_WIRE_SIZE` constant drift if the `PlayerState`
/// fields ever change.
pub fn encode_snapshot(snap: &Snapshot) -> Vec<u8> {
    let mut buf = Vec::with_capacity(
        SNAPSHOT_WIRE_SIZE_MIN + snap.players.len() * PLAYER_STATE_WIRE_SIZE,
    );
    buf.put_u32(snap.server_frame);
    buf.put_u32(snap.next_server_frame);
    // playerCount: u8 (max 255; well above MAX_PLAYERS_PER_ROOM = 24).
    // If a future PR raises the room ceiling past 255, this becomes
    // a u16 + SNAPSHOT_WIRE_SIZE_MIN becomes 11.
    debug_assert!(
        snap.players.len() <= u8::MAX as usize,
        "encode_snapshot: player count {} exceeds u8::MAX",
        snap.players.len(),
    );
    buf.put_u8(snap.players.len() as u8);
    for p in &snap.players {
        buf.put_u16(p.player_id);
        buf.put_f32(p.position_x);
        buf.put_f32(p.position_y);
        buf.put_f32(p.velocity_x);
        buf.put_f32(p.velocity_y);
        buf.put_f32(p.yaw);
        buf.put_f32(p.pitch);
        buf.put_u8(p.hp);
        buf.put_u8(p.ammo);
        buf.put_u8(p.is_firing);
    }
    debug_assert_eq!(
        buf.len(),
        SNAPSHOT_WIRE_SIZE_MIN + snap.players.len() * PLAYER_STATE_WIRE_SIZE,
        "encode_snapshot: produced {} bytes, expected {} (header {} + {} players * {})",
        buf.len(),
        SNAPSHOT_WIRE_SIZE_MIN + snap.players.len() * PLAYER_STATE_WIRE_SIZE,
        SNAPSHOT_WIRE_SIZE_MIN,
        snap.players.len(),
        PLAYER_STATE_WIRE_SIZE,
    );
    buf
}

/// Decode a wire-format Snapshot. Returns `None` on any size / format
/// drift (matches the existing decoder pattern).
///
/// **Discriminator stripping**: the body passed to this function is
/// the post-disc bytes (the discriminator byte is stripped by the
/// transport router). The body length must be exactly
/// `SNAPSHOT_WIRE_SIZE_MIN + n * PLAYER_STATE_WIRE_SIZE` for some
/// `n in 0..=u8::MAX`; otherwise decode returns `None`.
pub fn decode_snapshot(buf: &[u8]) -> Option<Snapshot> {
    if buf.len() < SNAPSHOT_WIRE_SIZE_MIN {
        return None;
    }
    let header_size = SNAPSHOT_WIRE_SIZE_MIN;
    let body_size = buf.len() - header_size;
    if body_size % PLAYER_STATE_WIRE_SIZE != 0 {
        return None;
    }
    let n_players = body_size / PLAYER_STATE_WIRE_SIZE;
    if n_players > u8::MAX as usize {
        return None;
    }
    let mut b = buf;
    let server_frame = b.get_u32();
    let next_server_frame = b.get_u32();
    let player_count = b.get_u8() as usize;
    if player_count != n_players {
        return None;
    }
    let mut players = Vec::with_capacity(player_count);
    for _ in 0..player_count {
        players.push(PlayerState {
            player_id: b.get_u16(),
            position_x: b.get_f32(),
            position_y: b.get_f32(),
            velocity_x: b.get_f32(),
            velocity_y: b.get_f32(),
            yaw: b.get_f32(),
            pitch: b.get_f32(),
            hp: b.get_u8(),
            ammo: b.get_u8(),
            is_firing: b.get_u8(),
        });
    }
    Some(Snapshot {
        server_frame,
        next_server_frame,
        players,
    })
}

#[cfg(test)]
mod tests {
    //! Unit-level size assertions (the integration suite in
    //! `tests/protocol_wire.rs` does the same plus round-trips). Kept
    //! here so the wire format's invariants are testable from `cargo
    //! test -p specialists-server` without crossing the crate boundary.

    use super::*;

    #[test]
    fn damage_request_is_14_bytes() {
        let req = DamageRequest {
            frame: 0x11223344,
            source_player_id: 0x5566,
            target_player_id: 0x7788,
            source: 0,
            amount: 25,
            event_id: 0xdeadbeef,
        };
        let bytes = encode_damage_request(&req);
        assert_eq!(bytes.len(), DAMAGE_REQUEST_WIRE_SIZE);
        assert_eq!(bytes.len(), 14);
    }

    #[test]
    fn damage_broadcast_is_18_bytes() {
        let bc = DamageBroadcast {
            server_frame: 0x01020304,
            server_seq: 0x05060708,
            source_player_id: 9,
            target_player_id: 10,
            source: 1,
            amount: 100,
            origin_event_id: 0xdeadbeef,
        };
        let bytes = encode_damage_broadcast(&bc);
        assert_eq!(bytes.len(), DAMAGE_BROADCAST_WIRE_SIZE);
        assert_eq!(bytes.len(), 18);
    }

    #[test]
    fn position_update_is_14_bytes() {
        let pu = PositionUpdate {
            server_frame: 0xcafebabe,
            player_id: 7,
            position_x: 1.5,
            position_y: -2.25,
        };
        let bytes = encode_position_update(&pu);
        assert_eq!(bytes.len(), POSITION_UPDATE_WIRE_SIZE);
        assert_eq!(bytes.len(), 14);
    }

    #[test]
    fn ping_is_4_bytes() {
        let p = Ping {
            client_timestamp: 0x12345678,
        };
        let bytes = encode_ping(&p);
        assert_eq!(bytes.len(), PING_WIRE_SIZE);
        assert_eq!(bytes.len(), 4);
    }

    #[test]
    fn pong_is_8_bytes() {
        let p = Pong {
            client_timestamp: 0x12345678,
            server_timestamp: 0x9abcdef0,
        };
        let bytes = encode_pong(&p);
        assert_eq!(bytes.len(), PONG_WIRE_SIZE);

    }

    #[test]
    fn damage_reject_is_5_bytes_roundtrip() {
        // FIX 4: DamageReject body is event_id u32 BE + reason u8 = 5.
        let r = DamageReject { event_id: 0xdeadbeef, reason: REJECT_REASON_FIRE_RATE };
        let bytes = encode_damage_reject(&r);
        assert_eq!(bytes.len(), DAMAGE_REJECT_BODY_SIZE);
        assert_eq!(bytes.len(), 5, "DamageReject body is event_id u32 + reason u8");
        let dr = decode_damage_reject(&bytes).expect("decode damage reject");
        assert_eq!(dr, r);

        // Wrong size -> None.
        let too_short = vec![0u8; DAMAGE_REJECT_BODY_SIZE - 1];
        assert!(decode_damage_reject(&too_short).is_none());
        let too_long = vec![0u8; DAMAGE_REJECT_BODY_SIZE + 1];
        assert!(decode_damage_reject(&too_long).is_none());
    }

    #[test]
    fn inputs_server_is_21_bytes() {
        let payload = InputsServer {
            frame: 0xdeadbeef,
            encoded_input: vec![0u8; 12],
            last_inputs_seq: 0xcafef00d,
        };
        let bytes = encode_inputs_server(&payload);
        assert_eq!(bytes.len(), INPUTS_SERVER_WIRE_SIZE);
        assert_eq!(bytes.len(), 21);
    }

    #[test]
    fn inputs_server_roundtrip_with_seq() {
        // PR 11.7.D2 / §1.2: round-trip with the last_inputs_seq trailer.
        let original = InputsServer {
            frame: 0xdeadbeef,
            encoded_input: vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
            last_inputs_seq: 0xcafef00d,
        };
        let bytes = encode_inputs_server(&original);
        let decoded = decode_inputs_server(&bytes).expect("decode must succeed");
        assert_eq!(decoded, original);
    }


    // -- Snapshot wire type (PR 11.7.B) ---------------------------------

    #[test]
    fn snapshot_minimum_size_when_empty() {
        let snap = Snapshot {
            server_frame: 0x01020304,
            next_server_frame: 0x05060708,
            players: vec![],
        };
        let bytes = encode_snapshot(&snap);
        assert_eq!(bytes.len(), SNAPSHOT_WIRE_SIZE_MIN);
        assert_eq!(bytes.len(), 9, "Snapshot with 0 players is the header only: 4+4+1 = 9 bytes");
    }

    // -- ReloadRequest wire type (PR 11.7.E) -----------------------------

    #[test]
    fn reload_request_body_is_6_bytes() {
        let req = ReloadRequest {
            source_player_id: 0x5566,
            event_id: 0xdeadbeef,
        };
        let bytes = encode_reload_request(&req);
        assert_eq!(bytes.len(), RELOAD_REQUEST_BODY_SIZE);
        assert_eq!(
            bytes.len(),
            6,
            "ReloadRequest body is source_player_id u16 BE (2) + event_id u32 BE (4) = 6 bytes",
        );
        assert_eq!(
            RELOAD_REQUEST_WIRE_SIZE,
            RELOAD_REQUEST_BODY_SIZE + 1,
            "wire size = body size + 1 discriminator byte",
        );
        assert_eq!(RELOAD_REQUEST_WIRE_SIZE, 7);
    }

    #[test]
    fn reload_request_roundtrip_preserves_all_fields() {
        let original = ReloadRequest {
            source_player_id: 7,
            event_id: 0xfeedface,
        };
        let bytes = encode_reload_request(&original);
        let decoded = decode_reload_request(&bytes).expect("decode must succeed");
        assert_eq!(decoded, original);
    }

    #[test]
    fn reload_request_rejects_wrong_size() {
        let req = ReloadRequest {
            source_player_id: 1,
            event_id: 1,
        };
        let bytes = encode_reload_request(&req);
        // 1-byte short
        let truncated = &bytes[..5];
        assert!(
            decode_reload_request(truncated).is_none(),
            "decoder must reject 5-byte buffer (PR 11.7.E off-by-one)",
        );
        // 1-byte long
        let mut padded = bytes.clone();
        padded.push(0);
        assert!(decode_reload_request(&padded).is_none());
        // Empty buffer
        assert!(decode_reload_request(&[]).is_none());
    }

    #[test]
    fn reload_request_is_big_endian() {
        let req = ReloadRequest {
            source_player_id: 0x0102,
            event_id: 0x03040506,
        };
        let bytes = encode_reload_request(&req);
        // byte 0..1 = source_player_id BE: 01 02
        assert_eq!(&bytes[0..2], &[0x01, 0x02]);
        // byte 2..5 = event_id BE: 03 04 05 06
        assert_eq!(&bytes[2..6], &[0x03, 0x04, 0x05, 0x06]);
    }

    #[test]
    fn snapshot_per_player_size_is_29() {
        let snap = Snapshot {
            server_frame: 1,
            next_server_frame: 2,
            players: vec![PlayerState {
                player_id: 7,
                position_x: 1.0,
                position_y: 2.0,
                velocity_x: 0.5,
                velocity_y: -0.5,
                yaw: 0.0,
                pitch: 0.0,
                hp: 88,
                ammo: 6,
                is_firing: 1,
            }],
        };
        let bytes = encode_snapshot(&snap);
        assert_eq!(bytes.len(), SNAPSHOT_WIRE_SIZE_MIN + PLAYER_STATE_WIRE_SIZE);
        assert_eq!(bytes.len(), 9 + 29);
        assert_eq!(bytes.len(), 38);
    }

    #[test]
    fn snapshot_at_24_players_is_706_bytes() {
        // PR 11.7.B plan §3.5: 24p * 29 = 696 + 9 header = 705... wait,
        // the brief says 706. Let me recompute: 4 (server_frame) + 4
        // (next_server_frame) + 1 (player_count) = 9 bytes header;
        // 24 * 29 = 696 bytes players; total = 705 bytes. The plan
        // reference uses a different per-player size (22 bytes per
        // player, 8-byte header); the brief locks the 29-byte size.
        // This test pins the brief math: 9 + 24*29 = 705.
        let snap = Snapshot {
            server_frame: 0,
            next_server_frame: 0,
            players: (1..=24u16)
                .map(|id| PlayerState {
                    player_id: id,
                    position_x: 0.0,
                    position_y: 0.0,
                    velocity_x: 0.0,
                    velocity_y: 0.0,
                    yaw: 0.0,
                    pitch: 0.0,
                    hp: 100,
                    ammo: 0,
                    is_firing: 0,
                })
                .collect(),
        };
        let bytes = encode_snapshot(&snap);
        assert_eq!(bytes.len(), 705, "24p snapshot is 9 header + 24*29 players = 705 bytes");
        // And the on-the-wire size is one more (the discriminator).
        assert_eq!(bytes.len() + 1, 706);
    }

    #[test]
    fn snapshot_roundtrip_preserves_all_fields() {
        let snap = Snapshot {
            server_frame: 0xdeadbeef,
            next_server_frame: 0xfeedface,
            players: vec![
                PlayerState {
                    player_id: 1,
                    position_x: 1.5,
                    position_y: -2.25,
                    velocity_x: 0.1,
                    velocity_y: 0.2,
                    yaw: 1.57,
                    pitch: -0.5,
                    hp: 88,
                    ammo: 6,
                    is_firing: 1,
                },
                PlayerState {
                    player_id: 2,
                    position_x: -3.0,
                    position_y: 4.5,
                    velocity_x: -0.7,
                    velocity_y: 0.0,
                    yaw: 0.0,
                    pitch: 0.5,
                    hp: 100,
                    ammo: 12,
                    is_firing: 0,
                },
            ],
        };
        let bytes = encode_snapshot(&snap);
        let decoded = decode_snapshot(&bytes).expect("decode must succeed");
        assert_eq!(decoded, snap);
    }

    #[test]
    fn snapshot_decoder_rejects_wrong_size() {
        let snap = Snapshot {
            server_frame: 1,
            next_server_frame: 2,
            players: vec![PlayerState {
                player_id: 7,
                position_x: 0.0,
                position_y: 0.0,
                velocity_x: 0.0,
                velocity_y: 0.0,
                yaw: 0.0,
                pitch: 0.0,
                hp: 100,
                ammo: 0,
                is_firing: 0,
            }],
        };
        let bytes = encode_snapshot(&snap);
        // Truncate 1 byte — the player_count claims 1 but the
        // player payload is short.
        let mut too_short = bytes.clone();
        too_short.truncate(bytes.len() - 1);
        assert!(decode_snapshot(&too_short).is_none());
        // Pad 1 byte — size doesn't match `SNAPSHOT_WIRE_SIZE_MIN + n*29`.
        let mut too_long = bytes.clone();
        too_long.push(0x00);
        assert!(decode_snapshot(&too_long).is_none());
        // Empty buffer — too short.
        assert!(decode_snapshot(&[]).is_none());
    }
}
