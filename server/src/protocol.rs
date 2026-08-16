// PR 11.6.B / §3.5 — wire-format codecs + discriminator table.
//
// Hand-rolled wire formats MUST have size assertions — see
// `server/tests/protocol_wire.rs`. Every encoder ends with a debug
// assert that the produced `Vec<u8>` is exactly the documented size;
// every test re-runs the assert via the public API. This catches the
// off-by-one class that bit PR 11.6.A's draft (claimed 8 / 13 bytes
// for damage; actual 14 / 18).
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

/// Wire-size constants (from §3.5). These are the same numbers that
/// the TypeScript mirror at `protocol/damage.ts` exports — they MUST
/// stay in sync.
pub const DAMAGE_REQUEST_WIRE_SIZE: usize = 14;
pub const DAMAGE_BROADCAST_WIRE_SIZE: usize = 18;
pub const POSITION_UPDATE_WIRE_SIZE: usize = 14;
pub const PING_WIRE_SIZE: usize = 4;
pub const PONG_WIRE_SIZE: usize = 8;
/// `0x06` discriminator + u32 frame BE + 12-byte input blob = 17
/// bytes total. INPUT_SIZE = 12 comes from
/// `client/src/net/inputBitmask.ts`. NOTE: the brief header says
/// "16 bytes" - that's the same class of off-by-one as the original
/// PR 11.6.A DamageRequest 8 -> 14. The math wins; carry-forward into
/// PR 11.6.C's TS encoder.
pub const INPUTS_SERVER_WIRE_SIZE: usize = 17;  // see §3.5 - brief header says 16 but the math is 1+4+12=17 (PR 11.6.A off-by-one class)

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
/// Wire layout:
///   byte 0      discriminator 0x06
///   byte 1..4   frame (u32 BE)
///   byte 5..16  encoded input (12 bytes — INPUT_SIZE from
///               `client/src/net/inputBitmask.ts`)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputsServer {
    pub frame: u32,
    /// 12-byte input blob. We store it as `Vec<u8>` rather than `[u8; 12]`
    /// because the discriminator + frame prefix is sometimes stripped by
    /// the transport layer before this struct is constructed (see
    /// `transport::handle_inputs_server_payload`).
    pub encoded_input: Vec<u8>,
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
    Some(InputsServer {
        frame,
        encoded_input: encoded_input.to_vec(),
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
        assert_eq!(bytes.len(), 8);
    }

    #[test]
    fn inputs_server_is_17_bytes() {
        let payload = InputsServer {
            frame: 0xdeadbeef,
            encoded_input: vec![0u8; 12],
        };
        let bytes = encode_inputs_server(&payload);
        assert_eq!(bytes.len(), INPUTS_SERVER_WIRE_SIZE);
        assert_eq!(bytes.len(), 17);
    }
}
