// PR 11.6.B / §3.5 — bytes-on-wire size assertions + round-trip tests.
//
// This is the regression guard from the PR 11.6.A wire-format
// off-by-one bug (original draft claimed 8/13 bytes for damage;
// actual 14/18). Every encoder ends with a `debug_assert_eq!` AND
// these integration tests assert the same thing again at the
// crate boundary. If the wire format drifts, BOTH the inline
// asserts AND this test fire — same data, two layers of safety.

use specialists_server::*;

// -- DamageRequest -----------------------------------------------------

#[test]
fn damage_request_is_14_bytes() {
    let req = DamageRequest {
        frame: 0x11223344,
        source_player_id: 0x5566,
        target_player_id: 0x7788,
        source: 0, // fire
        amount: 25,
        event_id: 0xdeadbeef,
    };
    let bytes = encode_damage_request(&req);
    assert_eq!(bytes.len(), DAMAGE_REQUEST_WIRE_SIZE);
    assert_eq!(bytes.len(), 14, "DamageRequest must be 14 bytes on the wire");
}

#[test]
fn damage_request_roundtrip() {
    let original = DamageRequest {
        frame: 0x12345678,
        source_player_id: 7,
        target_player_id: 9,
        source: 1, // melee
        amount: 100,
        event_id: 0xfeedface,
    };
    let bytes = encode_damage_request(&original);
    let decoded = decode_damage_request(&bytes).expect("decode must succeed");
    assert_eq!(original, decoded, "round-trip must preserve all fields");
}

#[test]
fn damage_request_rejects_wrong_size() {
    let req = DamageRequest {
        frame: 1,
        source_player_id: 1,
        target_player_id: 2,
        source: 0,
        amount: 10,
        event_id: 3,
    };
    let bytes = encode_damage_request(&req);
    // Trim to 13 bytes (the off-by-one case).
    let truncated = &bytes[..13];
    assert!(
        decode_damage_request(truncated).is_none(),
        "decoder must reject 13-byte buffer (PR 11.6.A's off-by-one case)"
    );
}

// -- DamageBroadcast -------------------------------------------------

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
    assert_eq!(bytes.len(), 18, "DamageBroadcast must be 18 bytes on the wire");
}

#[test]
fn damage_broadcast_roundtrip() {
    let original = DamageBroadcast {
        server_frame: 0xaabbccdd,
        server_seq: 0xeeff0011,
        source_player_id: 12,
        target_player_id: 13,
        source: 0,
        amount: 80,
        origin_event_id: 0xcafef00d,
    };
    let bytes = encode_damage_broadcast(&original);
    let decoded = decode_damage_broadcast(&bytes).expect("decode must succeed");
    assert_eq!(original, decoded);
}

// -- PositionUpdate --------------------------------------------------

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
    assert_eq!(bytes.len(), 14, "PositionUpdate must be 14 bytes on the wire");
}

#[test]
fn position_update_roundtrip_preserves_float_bits() {
    let original = PositionUpdate {
        server_frame: 1,
        player_id: 42,
        position_x: 3.14159,
        position_y: -2.71828,
    };
    let bytes = encode_position_update(&original);
    let decoded = decode_position_update(&bytes).expect("decode must succeed");
    assert_eq!(original.server_frame, decoded.server_frame);
    assert_eq!(original.player_id, decoded.player_id);
    assert_eq!(original.position_x.to_bits(), decoded.position_x.to_bits());
    assert_eq!(original.position_y.to_bits(), decoded.position_y.to_bits());
}

// -- Ping ------------------------------------------------------------

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
fn ping_roundtrip() {
    let original = Ping {
        client_timestamp: 0xfeedface,
    };
    let bytes = encode_ping(&original);
    let decoded = decode_ping(&bytes).expect("decode must succeed");
    assert_eq!(original, decoded);
}

// -- Pong ------------------------------------------------------------

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
fn pong_roundtrip() {
    let original = Pong {
        client_timestamp: 0xfeedface,
        server_timestamp: 0xdeadbeef,
    };
    let bytes = encode_pong(&original);
    let decoded = decode_pong(&bytes).expect("decode must succeed");
    assert_eq!(original, decoded);
}

// -- InputsServer (NEW §1.2) -----------------------------------------

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

#[test]
fn inputs_server_roundtrip() {
    let original = InputsServer {
        frame: 0xabcd1234,
        encoded_input: (0..12u8).collect(),
    };
    let bytes = encode_inputs_server(&original);
    let decoded = decode_inputs_server(&bytes).expect("decode must succeed");
    assert_eq!(original.frame, decoded.frame);
    assert_eq!(original.encoded_input, decoded.encoded_input);
}

#[test]
fn inputs_server_rejects_wrong_size() {
    let payload = InputsServer {
        frame: 1,
        encoded_input: vec![0u8; 12],
    };
    let bytes = encode_inputs_server(&payload);
    // Truncate to 15 bytes (off-by-one).
    assert!(decode_inputs_server(&bytes[..15]).is_none());
    // Wrong discriminator.
    let mut bad = bytes.clone();
    bad[0] = 0xFF;
    assert!(decode_inputs_server(&bad).is_none());
}

// -- Big-endian sanity check ----------------------------------------
//
// §3.5 of the plan is unambiguous: damage/position/rtt wire formats
// are big-endian. Lockstep input bytes 2-5 (yaw/pitch) are
// little-endian on the CLIENT side — that's a different wire format
// on a different code path. These tests pin the BE contract for the
// server side.

#[test]
fn damage_request_is_big_endian() {
    let req = DamageRequest {
        frame: 0x01020304,
        source_player_id: 0x0506,
        target_player_id: 0x0708,
        source: 0,
        amount: 0,
        event_id: 0,
    };
    let bytes = encode_damage_request(&req);
    // byte 0..3 = frame BE: 01 02 03 04
    assert_eq!(&bytes[0..4], &[0x01, 0x02, 0x03, 0x04]);
    // byte 4..5 = source_player_id BE: 05 06
    assert_eq!(&bytes[4..6], &[0x05, 0x06]);
    // byte 6..7 = target_player_id BE: 07 08
    assert_eq!(&bytes[6..8], &[0x07, 0x08]);
}

#[test]
fn pong_is_big_endian() {
    let p = Pong {
        client_timestamp: 0x01020304,
        server_timestamp: 0x05060708,
    };
    let bytes = encode_pong(&p);
    assert_eq!(&bytes[0..4], &[0x01, 0x02, 0x03, 0x04]);
    assert_eq!(&bytes[4..8], &[0x05, 0x06, 0x07, 0x08]);
}
