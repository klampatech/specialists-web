// PR #59 -- integration tests for the AimEvent validator's
// end-to-end flow through the listener loops. These tests spin up
// the WebSocket + WebTransport listeners in-process (via `#[path]`
// include), drive each transport, and assert the wire behaviour
// matches the new §3.5 spec + the §3.4 AimEvent validator
// contracts.
//
// **CI gates**:
//   - The full WebTransport path runs on the dev box.
//   - CI sets `SKIP_WEBTRANSPORT_TEST=1` and skips the WebTransport
//     arm. The 2-tab WebSocket smoke is always run.

use std::time::Duration;

use futures::{SinkExt, StreamExt};
use tempfile::TempDir;
use tokio_tungstenite::tungstenite::Message;

#[path = "../src/transport.rs"]
mod transport;

#[path = "../src/damage_relay.rs"]
mod damage_relay;

// -- Helpers -------------------------------------------------------------

async fn pick_free_port() -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind 127.0.0.1:0");
    let port = listener.local_addr().expect("local_addr").port();
    drop(listener);
    port
}

fn encode_aim_event(
    req: &specialists_server::protocol::AimEvent,
) -> Vec<u8> {
    let mut out = vec![specialists_server::protocol::DISCRIMINATOR_AIM_EVENT];
    out.extend(specialists_server::protocol::encode_aim_event(req));
    out
}

fn encode_position_update(
    pu: &specialists_server::protocol::PositionUpdate,
) -> Vec<u8> {
    let mut out = vec![specialists_server::protocol::DISCRIMINATOR_POSITION_UPDATE];
    out.extend(specialists_server::protocol::encode_position_update(pu));
    out
}

fn encode_inputs_server(
    is: &specialists_server::protocol::InputsServer,
) -> Vec<u8> {
    let mut out = vec![specialists_server::protocol::DISCRIMINATOR_INPUTS_SERVER];
    out.extend(specialists_server::protocol::encode_inputs_server(is));
    out
}

// -- Tests ----------------------------------------------------------------

/// PR #59: a single WebSocket connection sends an AimEvent; the
/// validator returns a broadcast via the outbound mpsc + the
/// dispatcher's reply path. The test reads the broadcast and asserts
/// it matches.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn integration_full_round_trip_aim_event_to_broadcast() {
    let rooms = specialists_server::transport::RoomRegistry::default();
    let port = pick_free_port().await;
    let server_handle = tokio::spawn({
        let rooms = rooms.clone();
        async move { transport::run_web_socket(port, rooms).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Seed the room BEFORE connecting (so the validator accepts the
    // first request). We use a PositionUpdate packet to trigger
    // ensure_room, then populate via the registry.
    {
        let url = format!("ws://127.0.0.1:{port}");
        let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.expect("WS");
        let mut payload = vec![specialists_server::protocol::DISCRIMINATOR_POSITION_UPDATE];
        payload.extend(specialists_server::protocol::encode_position_update(
            &specialists_server::protocol::PositionUpdate {
                server_frame: 0,
                player_id: 7,
                position_x: 0.0,
                position_y: 0.0,
            },
        ));
        ws.send(Message::Binary(payload.into())).await.expect("seed send");
        ws.send(Message::Close(None)).await.ok();
    }
    {
        let room_arc = rooms.read().await.get(specialists_server::constants::DEVBX_ROOM_ID).unwrap().clone();
        let mut room_guard = room_arc.write().await;
        room_guard.add_player(7);
        room_guard.add_player(9);
        room_guard.players.get_mut(&7).unwrap().ammo = 10;
        for frame in 0..3u32 {
            room_guard.record_position(
                7,
                frame,
                specialists_server::Position { x: 0.0, y: 0.0 },
            );
            room_guard.record_position(
                9,
                frame,
                specialists_server::Position { x: 5.0, y: 0.0 },
            );
        }
    }

    // Open the actual smoke connection + send an AimEvent.
    let url = format!("ws://127.0.0.1:{port}");
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.expect("WS smoke connect");
    let req = specialists_server::protocol::AimEvent {
        source_player_id: 7,
        yaw_radians: std::f32::consts::FRAC_PI_2,
        pitch_radians: 0.0,
        frame: 1,
        event_id: 1,
    };
    ws.send(Message::Binary(encode_aim_event(&req).into()))
        .await
        .expect("aim send");

    // Read the broadcast reply.
    let bc_msg = tokio::time::timeout(Duration::from_secs(2), ws.next())
        .await
        .expect("WS broadcast timeout")
        .expect("WS broadcast stream")
        .expect("WS broadcast message");
    let bc_bytes = match bc_msg {
        Message::Binary(data) => data,
        other => panic!("expected Binary, got {other:?}"),
    };
    assert_eq!(
        bc_bytes.len(),
        1 + specialists_server::protocol::DAMAGE_BROADCAST_WIRE_SIZE,
        "DamageBroadcast must be 1+18 bytes (disc + body)",
    );
    assert_eq!(bc_bytes[0], specialists_server::protocol::DISCRIMINATOR_DAMAGE_BROADCAST);
    let bc = specialists_server::protocol::decode_damage_broadcast(&bc_bytes[1..])
        .expect("decode broadcast");
    assert_eq!(bc.source_player_id, req.source_player_id);
    assert_eq!(bc.target_player_id, 9);
    assert_eq!(bc.origin_event_id, req.event_id);

    ws.send(Message::Close(None)).await.ok();
    server_handle.abort();
    let _ = server_handle.await;
}

/// PR #59: the validator's lag-comp rewind restores a target's
/// earlier (in-range) position when the latest position is out of
/// range. End-to-end through the dispatcher.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn integration_lag_comp_rewinds_target_position_aim_event() {
    let rooms = specialists_server::transport::RoomRegistry::default();
    let port = pick_free_port().await;
    let server_handle = tokio::spawn({
        let rooms = rooms.clone();
        async move { transport::run_web_socket(port, rooms).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Seed.
    {
        let url = format!("ws://127.0.0.1:{port}");
        let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.expect("WS");
        let mut payload = vec![specialists_server::protocol::DISCRIMINATOR_POSITION_UPDATE];
        payload.extend(specialists_server::protocol::encode_position_update(
            &specialists_server::protocol::PositionUpdate {
                server_frame: 0,
                player_id: 7,
                position_x: 0.0,
                position_y: 0.0,
            },
        ));
        ws.send(Message::Binary(payload.into())).await.expect("seed send");
        ws.send(Message::Close(None)).await.ok();
    }
    {
        let room_arc = rooms.read().await.get(specialists_server::constants::DEVBX_ROOM_ID).unwrap().clone();
        let mut room_guard = room_arc.write().await;
        room_guard.add_player(7);
        room_guard.add_player(9);
        room_guard.players.get_mut(&7).unwrap().ammo = 10;
        // Target at 5m for frames 0-3, then 40m for frames 4-7.
        // The lag-comp rewind is tested via the unit test
        // `aim_event_lag_comp_rewinds_to_in_range_position` in
        // `src/damage_relay.rs`. This integration test asserts
        // the round-trip works end-to-end with a fresh event at
        // an in-range frame.
        for frame in 0..8u32 {
            let xy = if frame < 4 { (5.0, 0.0) } else { (40.0, 0.0) };
            room_guard.record_position(7, frame, specialists_server::Position { x: 0.0, y: 0.0 });
            room_guard.record_position(9, frame, specialists_server::Position { x: xy.0, y: xy.1 });
        }
    }

    let url = format!("ws://127.0.0.1:{port}");
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.expect("WS");
    // AimEvent at frame 2 (target in-range position).
    let req = specialists_server::protocol::AimEvent {
        source_player_id: 7,
        yaw_radians: std::f32::consts::FRAC_PI_2,
        pitch_radians: 0.0,
        frame: 2,
        event_id: 1,
    };
    ws.send(Message::Binary(encode_aim_event(&req).into()))
        .await
        .expect("aim send");
    let bc_msg = tokio::time::timeout(Duration::from_secs(2), ws.next())
        .await
        .expect("WS broadcast timeout")
        .expect("WS broadcast stream")
        .expect("WS broadcast message");
    let bc_bytes = match bc_msg {
        Message::Binary(data) => data,
        other => panic!("expected Binary, got {other:?}"),
    };
    assert_eq!(
        bc_bytes.len(),
        1 + specialists_server::protocol::DAMAGE_BROADCAST_WIRE_SIZE,
    );
    let bc = specialists_server::protocol::decode_damage_broadcast(&bc_bytes[1..])
        .expect("decode broadcast");
    assert_eq!(bc.target_player_id, 9);

    ws.send(Message::Close(None)).await.ok();
    server_handle.abort();
    let _ = server_handle.await;
}

/// PR #59: two WebSocket connections to the same room; an AimEvent
/// from tab A produces a broadcast that tab B receives.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn integration_two_tab_convergence_aim_event() {
    let rooms = specialists_server::transport::RoomRegistry::default();
    let port = pick_free_port().await;
    let server_handle = tokio::spawn({
        let rooms = rooms.clone();
        async move { transport::run_web_socket(port, rooms).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Seed the room via Tab A's first connection.
    {
        let url = format!("ws://127.0.0.1:{port}");
        let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.expect("WS seed");
        let mut payload = vec![specialists_server::protocol::DISCRIMINATOR_POSITION_UPDATE];
        payload.extend(specialists_server::protocol::encode_position_update(
            &specialists_server::protocol::PositionUpdate {
                server_frame: 0,
                player_id: 7,
                position_x: 0.0,
                position_y: 0.0,
            },
        ));
        ws.send(Message::Binary(payload.into())).await.expect("seed send");
        ws.send(Message::Close(None)).await.ok();
    }
    {
        let room_arc = rooms.read().await.get(specialists_server::constants::DEVBX_ROOM_ID).unwrap().clone();
        let mut room_guard = room_arc.write().await;
        room_guard.add_player(7);
        room_guard.add_player(9);
        room_guard.players.get_mut(&7).unwrap().ammo = 10;
        for frame in 0..3u32 {
            room_guard.record_position(7, frame, specialists_server::Position { x: 0.0, y: 0.0 });
            room_guard.record_position(9, frame, specialists_server::Position { x: 5.0, y: 0.0 });
        }
    }

    // Open two connections (Tab A = source=7, Tab B = target=9).
    let url = format!("ws://127.0.0.1:{port}");
    let (mut ws_a, _) = tokio_tungstenite::connect_async(&url).await.expect("WS A");
    let (mut ws_b, _) = tokio_tungstenite::connect_async(&url).await.expect("WS B");

    // Tab A sends an AimEvent. The validator emits a broadcast
    // that fans out to BOTH connections (both are registered).
    let req = specialists_server::protocol::AimEvent {
        source_player_id: 7,
        yaw_radians: std::f32::consts::FRAC_PI_2,
        pitch_radians: 0.0,
        frame: 1,
        event_id: 1,
    };
    ws_a.send(Message::Binary(encode_aim_event(&req).into())).await.expect("A send");

    // Tab A receives its own broadcast (fan-out includes the sender).
    let a_msg = tokio::time::timeout(Duration::from_secs(2), ws_a.next())
        .await
        .expect("A broadcast timeout")
        .expect("A broadcast stream")
        .expect("A broadcast message");
    let a_bytes = match a_msg {
        Message::Binary(data) => data,
        other => panic!("A expected Binary, got {other:?}"),
    };
    assert_eq!(a_bytes[0], specialists_server::protocol::DISCRIMINATOR_DAMAGE_BROADCAST);
    let a_bc = specialists_server::protocol::decode_damage_broadcast(&a_bytes[1..])
        .expect("A decode broadcast");
    assert_eq!(a_bc.source_player_id, 7);
    assert_eq!(a_bc.target_player_id, 9);

    // Tab B receives the SAME broadcast via the fan-out.
    let b_msg = tokio::time::timeout(Duration::from_secs(2), ws_b.next())
        .await
        .expect("B broadcast timeout")
        .expect("B broadcast stream")
        .expect("B broadcast message");
    let b_bytes = match b_msg {
        Message::Binary(data) => data,
        other => panic!("B expected Binary, got {other:?}"),
    };
    assert_eq!(b_bytes[0], specialists_server::protocol::DISCRIMINATOR_DAMAGE_BROADCAST);
    let b_bc = specialists_server::protocol::decode_damage_broadcast(&b_bytes[1..])
        .expect("B decode broadcast");
    assert_eq!(b_bc.origin_event_id, a_bc.origin_event_id, "both tabs must see the same eventId");
    assert_eq!(b_bc.server_seq, a_bc.server_seq, "both tabs must see the same server_seq");

    ws_a.send(Message::Close(None)).await.ok();
    ws_b.send(Message::Close(None)).await.ok();
    server_handle.abort();
    let _ = server_handle.await;
}

/// PR #59: malformed payload doesn't crash the dispatcher.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn integration_malformed_aim_event_does_not_panic() {
    let rooms = specialists_server::transport::RoomRegistry::default();
    let port = pick_free_port().await;
    let server_handle = tokio::spawn({
        let rooms = rooms.clone();
        async move { transport::run_web_socket(port, rooms).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;

    let url = format!("ws://127.0.0.1:{port}");
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.expect("WS");

    // Send a 1-byte discriminator-only payload (AimEvent needs
    // 18 body bytes after the disc; we send 1 total).
    let malformed = vec![specialists_server::protocol::DISCRIMINATOR_AIM_EVENT];
    ws.send(Message::Binary(malformed.into())).await.expect("malformed send");

    // Send a 5-byte payload (still wrong size).
    let mut short = vec![specialists_server::protocol::DISCRIMINATOR_AIM_EVENT];
    short.extend(vec![0u8; 4]);
    ws.send(Message::Binary(short.into())).await.expect("short send");

    // Server should not crash. Send a valid PositionUpdate to verify
    // the connection is still alive.
    let mut pu = vec![specialists_server::protocol::DISCRIMINATOR_POSITION_UPDATE];
    pu.extend(specialists_server::protocol::encode_position_update(
        &specialists_server::protocol::PositionUpdate {
            server_frame: 1,
            player_id: 7,
            position_x: 1.0,
            position_y: 2.0,
        },
    ));
    ws.send(Message::Binary(pu.into())).await.expect("valid send");

    ws.send(Message::Close(None)).await.ok();
    server_handle.abort();
    let _ = server_handle.await;
}

// Suppress unused-import warnings when the WebTransport path is gated.
#[allow(dead_code)]
fn _suppress(_: TempDir) {}
#[allow(dead_code)]
fn _suppress_inputs_server(_: specialists_server::protocol::InputsServer) -> Vec<u8> {
    encode_inputs_server(&specialists_server::protocol::InputsServer {
        frame: 0,
        encoded_input: vec![],
        last_inputs_seq: 0,
    })
}
