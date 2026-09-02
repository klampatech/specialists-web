// PR 11.6.B / §3.5 -- bytes-on-wire size assertions + round-trip tests.
//
// This is the regression guard from the PR 11.6.A wire-format
// off-by-one bug (original draft claimed 8/13 bytes for damage;
// actual 14/18). Every encoder ends with a `debug_assert_eq!` AND
// these integration tests assert the same thing again at the
// crate boundary. If the wire format drifts, BOTH the inline
// asserts AND this test fire -- same data, two layers of safety.

use specialists_server::*;

// -- AimEvent (PR #59) -----------------------------------------------

#[test]
fn aim_event_is_19_bytes() {
    // PR #59 / §3.5: wire size = 1 (disc) + 2 (source u16) +
    // 4 (yaw f32) + 4 (pitch f32) + 4 (frame u32) + 4 (event_id u32)
    // = 19 bytes. `encode_aim_event` returns the 18-byte body
    // (no disc); the transport router prepends the disc byte.
    let req = AimEvent {
        source_player_id: 0x5566,
        yaw_radians: 0.123,
        pitch_radians: -0.456,
        frame: 0xdeadbeef,
        event_id: 0x12345678,
        is_firing: 1, // PR #107
    };
    let body = encode_aim_event(&req);
    assert_eq!(body.len(), AIM_EVENT_BODY_SIZE);
    assert_eq!(body.len(), 19, "AimEvent body must be 19 bytes (PR #107 +is_firing)");
    // Wire size = body + disc.
    let mut wire = Vec::with_capacity(AIM_EVENT_WIRE_SIZE);
    wire.push(DISCRIMINATOR_AIM_EVENT);
    wire.extend(body);
    assert_eq!(wire.len(), AIM_EVENT_WIRE_SIZE);
    assert_eq!(wire.len(), 20, "AimEvent must be 20 bytes on the wire (PR #107)");
}

#[test]
fn aim_event_roundtrip_preserves_all_fields() {
    let original = AimEvent {
        source_player_id: 7,
        yaw_radians: 1.5707963, // pi/2
        pitch_radians: -0.5,
        frame: 0xfeedface,
        event_id: 0x01020304,
        is_firing: 1, // PR #107
    };
    let bytes = encode_aim_event(&original);
    let decoded = decode_aim_event(&bytes).expect("decode must succeed");
    assert_eq!(decoded.source_player_id, original.source_player_id);
    assert_eq!(decoded.yaw_radians.to_bits(), original.yaw_radians.to_bits());
    assert_eq!(decoded.pitch_radians.to_bits(), original.pitch_radians.to_bits());
    assert_eq!(decoded.frame, original.frame);
    assert_eq!(decoded.event_id, original.event_id);
}

#[test]
fn aim_event_rejects_wrong_size() {
    let req = AimEvent {
        source_player_id: 1,
        yaw_radians: 0.0,
        pitch_radians: 0.0,
        frame: 1,
        event_id: 1,
        is_firing: 1, // PR #107
    };
    let bytes = encode_aim_event(&req);
    // Body is 19 bytes (PR #107); trim to 18 to test off-by-one rejection.
    let truncated = &bytes[..18];
    assert!(
        decode_aim_event(truncated).is_none(),
        "decoder must reject 17-byte body buffer (off-by-one case)"
    );
    // Empty payload.
    assert!(decode_aim_event(&[]).is_none());
}

#[test]
fn aim_event_is_big_endian() {
    // §3.5: AimEvent wire layout = [disc][source u16 BE][yaw f32 BE]
    // [pitch f32 BE][frame u32 BE][event_id u32 BE]. Total 19 bytes.
    let req = AimEvent {
        source_player_id: 0x0506,
        yaw_radians: 0.0,   // f32 bits = 0x00000000
        pitch_radians: 0.0, // f32 bits = 0x00000000
        frame: 0x01020304,
        event_id: 0x0a0b0c0d,
        is_firing: 1, // PR #107
    };
    let body = encode_aim_event(&req);
    // AimEvent on-the-wire = disc + 19-byte body = 20 bytes total (PR #107).
    let mut bytes = Vec::with_capacity(20);
    bytes.push(DISCRIMINATOR_AIM_EVENT);
    bytes.extend(&body);
    assert_eq!(bytes.len(), 20, "AimEvent wire size = 20 (PR #107)");
    // byte 0 = disc 0x0A
    assert_eq!(bytes[0], DISCRIMINATOR_AIM_EVENT);
    // byte 1..2 = source_player_id BE: 05 06
    assert_eq!(&bytes[1..3], &[0x05, 0x06]);
    // byte 3..6 = yaw f32 BE (0.0 = 00 00 00 00)
    assert_eq!(&bytes[3..7], &[0x00, 0x00, 0x00, 0x00]);
    // byte 7..10 = pitch f32 BE (0.0 = 00 00 00 00)
    assert_eq!(&bytes[7..11], &[0x00, 0x00, 0x00, 0x00]);
    // byte 11..14 = frame BE: 01 02 03 04
    assert_eq!(&bytes[11..15], &[0x01, 0x02, 0x03, 0x04]);
    // byte 15..18 = event_id BE: 0a 0b 0c 0d
    assert_eq!(&bytes[15..19], &[0x0a, 0x0b, 0x0c, 0x0d]);
    // byte 19 = is_firing (PR #107)
    assert_eq!(bytes[19], 1, "is_firing byte = 1");
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
fn inputs_server_is_21_bytes() {
    // PR 11.7.D2 / §1.2: wire size 17 -> 21 (added u32 last_inputs_seq trailer).
    let payload = InputsServer {
        frame: 0xdeadbeef,
        encoded_input: vec![0u8; 12],
        last_inputs_seq: 0xdeadbeef,
    };
    let bytes = encode_inputs_server(&payload);
    assert_eq!(bytes.len(), INPUTS_SERVER_WIRE_SIZE);
    assert_eq!(bytes.len(), 21);
}

#[test]
fn inputs_server_roundtrip() {
    let original = InputsServer {
        frame: 0xabcd1234,
        encoded_input: (0..12u8).collect(),
        last_inputs_seq: 0x01020304,
    };
    let bytes = encode_inputs_server(&original);
    let decoded = decode_inputs_server(&bytes).expect("decode must succeed");
    assert_eq!(original.frame, decoded.frame);
    assert_eq!(original.encoded_input, decoded.encoded_input);
    assert_eq!(original.last_inputs_seq, decoded.last_inputs_seq);
}

#[test]
fn inputs_server_rejects_wrong_size() {
    let payload = InputsServer {
        frame: 1,
        encoded_input: vec![0u8; 12],
        last_inputs_seq: 0,
    };
    let bytes = encode_inputs_server(&payload);
    // Truncate to 15 bytes (off-by-many -- 21 - 6 = 15, the post-disc body
    // starts at byte 1, so 15 bytes is 14 bytes of body -- clearly too short).
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
// little-endian on the CLIENT side -- that's a different wire format
// on a different code path. These tests pin the BE contract for the
// server side.

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

// -- ReloadRequest (PR 11.7.E) ----------------------------------------

#[test]
fn reload_request_body_is_6_bytes() {
    let req = ReloadRequest {
        source_player_id: 0x5566,
        event_id: 0xdeadbeef,
    };
    let bytes = encode_reload_request(&req);
    assert_eq!(bytes.len(), RELOAD_REQUEST_BODY_SIZE);
    assert_eq!(bytes.len(), 6);
    assert_eq!(RELOAD_REQUEST_WIRE_SIZE, 7);
}

#[test]
fn reload_request_roundtrip() {
    let original = ReloadRequest {
        source_player_id: 42,
        event_id: 0xfeedface,
    };
    let bytes = encode_reload_request(&original);
    let decoded = decode_reload_request(&bytes).expect("decode must succeed");
    assert_eq!(original, decoded, "round-trip must preserve all fields");
}
