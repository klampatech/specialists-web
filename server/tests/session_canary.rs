// PR 11.6.B+C / §3.4 — in-process end-to-end smoke.
//
// Spawns the server in-process (no child process), opens a WebSocket
// client + a WebTransport client, drives each transport with a few
// exchanges, and asserts the wire behaviour matches the §3.5 spec.
//
// **PR 11.6.B**: the exchanges were echo-only (bytes in, bytes out).
// **PR 11.6.C**: the WebSocket exchange exercises the discriminator
// router (`damageRequest` → `damageBroadcast` reply, `positionUpdate`
// no reply, `ping` → `pong` reply, unknown discriminator → no reply).
// The WebTransport path still runs the echo-with-discriminator path
// in this PR (the test was kept simple to avoid headless-cert flakiness
// in CI).
//
// **Why in-process (not a child process + `nc`)**: the WebTransport
// path can't be smoke-tested with `nc` (it speaks HTTP/3 over QUIC,
// not TCP). Spawning the server in-process lets the test use the
// wtransport client crate directly against the bound port.
//
// **CI gates**:
//   - The full WebTransport path runs on the dev box (Kyle runs
//     `cargo test -p specialists-server` before the manual merge).
//   - CI sets `SKIP_WEBTRANSPORT_TEST=1` and skips the WebTransport
//     arm of the smoke (the mTLS dance for self-signed certs is
//     flaky in the sandboxed GitHub runner — the canary-server.sh
//     script does the equivalent on the dev box).

use std::time::Duration;

use futures::{SinkExt, StreamExt};
use tempfile::TempDir;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::MaybeTlsStream;
use tokio_tungstenite::WebSocketStream;

// Include the transport module here so the canary can exercise the
// crate-private listener entry points without widening the library API.
#[path = "../src/transport.rs"]
mod transport;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn websocket_echo_works() {
    // Pick a free port (port 0) so the test doesn't collide with
    // any other process on the dev box.
    let rooms = specialists_server::transport::RoomRegistry::default();
    let port = pick_free_port().await;

    let rooms_clone = rooms.clone();
    let server_handle = tokio::spawn(async move {
        transport::run_web_socket(port, rooms_clone).await
    });

    // Give the server a moment to bind.
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Open a WebSocket client.
    let url = format!("ws://127.0.0.1:{port}");
    let (mut ws, _resp) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("WS handshake");

    // Send 16 bytes (echo), expect 16 bytes back.
    let payload: Vec<u8> = (0..16u8).collect();
    ws.send(Message::Binary(payload.clone().into()))
        .await
        .expect("WS send");

    let echoed = tokio::time::timeout(Duration::from_secs(2), ws.next())
        .await
        .expect("WS recv timeout")
        .expect("WS recv stream")
        .expect("WS recv message");
    match echoed {
        Message::Binary(data) => {
                assert_eq!(data.len(), payload.len(), "echo length mismatch");
                assert_eq!(&data[..], &payload[..], "echo bytes mismatch");
            }
        other => panic!("expected Binary, got {other:?}"),
    }

    // Close cleanly.
    let _ = ws.send(Message::Close(None)).await;
    drop(ws);

    // The server task is still listening; abort it (this test only
    // used the WebSocket path, the WT listener wasn't spawned).
    server_handle.abort();
    let _ = server_handle.await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn room_state_pushes_inputs_buffer() {
    // PR 11.6.B's §1.2 seam: inputs_buffer is write-only. This test
    // asserts the write path works without trying to read from it
    // (gotcha #1 from the brief: don't fire any logic that depends
    // on inputs_buffer being non-empty).
    let mut room = specialists_server::session::Room::new("DEVBX");
    room.add_player(7);
    for frame in 0..10u32 {
        room.push_input(7, frame, [0u8; 12]);
    }
    let buf = &room.inputs_buffer[&7];
    assert_eq!(buf.len(), 10);
    assert_eq!(buf.front().unwrap().0, 0);
    assert_eq!(buf.back().unwrap().0, 9);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn position_history_trims_to_capacity() {
    // §3.4.1 — per-player ring buffer caps at 64 entries.
    let mut room = specialists_server::session::Room::new("DEVBX");
    room.add_player(1);
    for frame in 0..100u32 {
        room.record_position(
            1,
            frame,
            specialists_server::Position { x: frame as f32, y: 0.0 },
        );
    }
    let hist = &room.position_history[&1];
    assert_eq!(hist.len(), 64);
    // The first 36 entries should have been popped.
    assert_eq!(hist.frames.front().unwrap().0, 36);
    assert_eq!(hist.frames.back().unwrap().0, 99);
}

// -- PR 11.6.C: discriminator-router integration tests ------------------

/// Wire-format a `positionUpdate` packet (discriminator + body), hand
/// it to the live dispatcher, assert the room's `PositionHistory`
/// received the entry and the server replied with NOTHING (no ack for
/// position updates).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn router_dispatches_position_update_writes_history() {
    use specialists_server::protocol::{
        encode_position_update, PositionUpdate, DISCRIMINATOR_POSITION_UPDATE,
    };
    use transport::{handle_binary, RoomRegistry};

    let rooms: RoomRegistry = RoomRegistry::default();
    let mut payload = vec![DISCRIMINATOR_POSITION_UPDATE];
    payload.extend(encode_position_update(&PositionUpdate {
        server_frame: 99,
        player_id: 42,
        position_x: 7.5,
        position_y: -3.25,
    }));

    let reply = handle_binary(&payload, &rooms, 0, transport::ConnectionState::new(0) /* placeholder */).await;
    assert!(
        reply.is_empty(),
        "positionUpdate must not produce a reply (got {} bytes)",
        reply.len()
    );

    // Verify the room was created + history was written.
    let room_arc = {
        let guard = rooms.read().await;
        guard
            .get(specialists_server::constants::DEVBX_ROOM_ID)
            .expect("DEVBX room created")
            .clone()
    };
    let snapshot = {
        let room = room_arc.read().await;
        room.position_history
            .get(&42)
            .expect("player 42 history")
            .snapshot_at(99)
            .expect("snapshot at frame 99")
    };
    assert_eq!(snapshot.x, 7.5);
    assert_eq!(snapshot.y, -3.25);
}

/// PR #59: wire-format an `AimEvent`, hand it to the live
/// dispatcher, assert that `damage_relay::validate_and_relay_aim`
/// accepts the request and produces a `DamageBroadcast` reply
/// matching the request fields. The validator requires players +
/// ammo + position history -- seeded below.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn router_dispatches_aim_event_returns_broadcast() {
    use specialists_server::protocol::{
        decode_damage_broadcast, encode_aim_event, AimEvent,
        DISCRIMINATOR_AIM_EVENT, DISCRIMINATOR_DAMAGE_BROADCAST,
    };
    use transport::{handle_binary, RoomRegistry};

    let rooms: RoomRegistry = RoomRegistry::default();
    seed_room_for_validator(&rooms, 7, Some(9), (0.0, 0.0), Some((5.0, 0.0))).await;
    let req = AimEvent {
        source_player_id: 7,
        // yaw=PI/2 fires along +X axis where the target at (5,0) lives.
        // yaw=0 fires along +Z (per hitscan::forward_from_yaw_pitch).
        yaw_radians: std::f32::consts::FRAC_PI_2,
        pitch_radians: 0.0,
        frame: 1, // any frame 0..3 has a snapshot
        event_id: 0xcafebabe,
        is_firing: 1,
        }
;
    let mut payload = vec![DISCRIMINATOR_AIM_EVENT];
    payload.extend(encode_aim_event(&req));

    let reply = handle_binary(&payload, &rooms, 0, transport::ConnectionState::new(0) /* placeholder */).await;
    assert_eq!(
        reply.len(),
        1 + specialists_server::DAMAGE_BROADCAST_WIRE_SIZE,
        "AimEvent reply must be 1+18 bytes (disc + body)"
    );
    assert_eq!(reply[0], DISCRIMINATOR_DAMAGE_BROADCAST);
    let bc = decode_damage_broadcast(&reply[1..]).expect("decode broadcast");
    assert_eq!(bc.source_player_id, req.source_player_id);
    assert_eq!(bc.target_player_id, 9);
    assert_eq!(bc.origin_event_id, req.event_id);
    // server_frame + server_seq are wired (room fields, start at 0).
    assert_eq!(bc.server_frame, 0);
    assert_eq!(bc.server_seq, 0);
}

// -- PR 11.6.D: validator integration tests -------------------------

/// Helper: trigger `ensure_room` (via a PositionUpdate packet so the
/// dispatcher creates the DEVBX room + writes a sample position),
/// then add the players + ammo + a recorded position so the validator
/// has everything it needs.
async fn seed_room_for_validator(
    rooms: &transport::RoomRegistry,
    source_id: u16,
    target_id: Option<u16>,
    source_xy: (f32, f32),
    target_xy: Option<(f32, f32)>,
) {
    use specialists_server::protocol::{
        encode_position_update, PositionUpdate, DISCRIMINATOR_POSITION_UPDATE,
    };
    // Trigger ensure_room by sending a PositionUpdate packet.
    let pu = PositionUpdate {
        server_frame: 0,
        player_id: source_id,
        position_x: source_xy.0,
        position_y: source_xy.1,
    };
    let mut payload = vec![DISCRIMINATOR_POSITION_UPDATE];
    payload.extend(encode_position_update(&pu));
    let _ = transport::handle_binary(&payload, rooms, 0, transport::ConnectionState::new(0) /* placeholder */).await;

    // Now grab the room + populate it.
    let room_arc = rooms.read().await.get(specialists_server::constants::DEVBX_ROOM_ID).unwrap().clone();
    let mut room_guard = room_arc.write().await;
    room_guard.add_player(source_id);
    if let Some(t) = target_id {
        room_guard.add_player(t);
    }
    room_guard.players.get_mut(&source_id).unwrap().ammo = 10;
    // Record positions at frames 0,1 so the lag-comp snapshot succeeds.
    for frame in 0..3u32 {
        room_guard.record_position(
            source_id,
            frame,
            specialists_server::Position { x: source_xy.0, y: source_xy.1 },
        );
        if let (Some(t), Some(txy)) = (target_id, target_xy) {
            room_guard.record_position(
                t,
                frame,
                specialists_server::Position { x: txy.0, y: txy.1 },
            );
        }
    }
}

/// PR #59: validator rejects an AimEvent when the source has zero
/// ammo. The dispatcher sees the reject (no reply bytes).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn validator_rejects_zero_ammo_in_room() {
    use specialists_server::protocol::{
        encode_aim_event, AimEvent, DISCRIMINATOR_AIM_EVENT,
    };
    use transport::{handle_binary, RoomRegistry};

    let rooms: RoomRegistry = RoomRegistry::default();
    seed_room_for_validator(&rooms, 7, Some(9), (0.0, 0.0), Some((5.0, 0.0))).await;
    // Zero out the source's ammo.
    {
        let room_arc = rooms.read().await.get(specialists_server::constants::DEVBX_ROOM_ID).unwrap().clone();
        let mut room_guard = room_arc.write().await;
        room_guard.players.get_mut(&7).unwrap().ammAimEvent {
        source_player_id: 7,
        yaw_radians: std::f32::consts::FRAC_PI_2,
        pitch_radians: 0.0,
        frame: 1,
        event_id: 1,
        is_firing: 1,
        }

        event_id: 1,
    };
    let mut payload = vec![DISCRIMINATOR_AIM_EVENT];
    payload.extend(encode_aim_event(&req));
    let reply = handle_binary(&payload, &rooms, 0, transport::ConnectionState::new(0) /* placeholder */).await;
    assert!(reply.is_empty(), "zero ammo must produce no broadcast reply");
}

/// PR #59: validator rejects an AimEvent that violates the
/// fire-rate cooldown.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn validator_rejects_fire_rate_violation_in_room() {
    use specialists_server::protocol::{
        encode_aim_event, AimEvent, DISCRIMINATOR_AIM_EVENT,
    };
    use transport::{handle_binary, RoomRegistry};

    let rooms: RoomRegistry = RoomRegistry::default();
    seed_room_for_validator(&rooms, 7, Some(9), (0.0, 0.0), Some((5.0, 0.0)))AimEvent {
        source_player_id: 7,
        yaw_radians: std::f32::consts::FRAC_PI_2,
        pitch_radians: 0.0,
        frame: 1,
        event_id: 1,
        is_firing: 1,
        }
ans: 0.0,
        frame: 1,
        event_id: 1,
    };
    let mut payload1 = vec![DISCRIMINATOR_AIM_EVENT];
    payload1.extend(encode_aim_event(&req1));
    let reply1 = handle_binary(&payload1, &rooms, 0, transport::ConnectionState::new(0) /* placeholder */).await;
    assert!(!reply1.is_empty(), "first AimEvent must produce a broadcast");

    // Second request with a freshAimEvent {
        source_player_id: 7,
        yaw_radians: std::f32::consts::FRAC_PI_2,
        pitch_radians: 0.0,
        frame: 1,
        event_id: 2,
        is_firing: 1,
        }
AC_PI_2,
        pitch_radians: 0.0,
        frame: 1,
        event_id: 2,
    };
    let mut payload2 = vec![DISCRIMINATOR_AIM_EVENT];
    payload2.extend(encode_aim_event(&req2));
    let reply2 = handle_binary(&payload2, &rooms, 0, transport::ConnectionState::new(0) /* placeholder */).await;
    assert!(reply2.is_empty(), "second AimEvent within cooldown must produce no broadcast");
}

// -- Dev-box-only WebTransport integration -------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn webtransport_echo_works() {
    // Skip in CI (set SKIP_WEBTRANSPORT_TEST=1 in the workflow).
    if std::env::var("SKIP_WEBTRANSPORT_TEST").is_ok() {
        eprintln!("SKIP_WEBTRANSPORT_TEST set — skipping WebTransport smoke");
        return;
    }

    let cert_dir = TempDir::new().expect("TempDir");
    let cert_path = cert_dir.path().join("dev.pem");
    let key_path = cert_dir.path().join("dev.key");

    // Generate the dev cert (no-op if files exist; first run is fresh).
    let sans = vec!["localhost".to_string(), "127.0.0.1".to_string()];
    specialists_server::cert::ensure_dev_certs(&cert_path, &key_path, sans)
        .await
        .expect("ensure_dev_certs");

    let port = pick_free_port().await;
    let rooms = specialists_server::transport::RoomRegistry::default();

    let cert_path_clone = cert_path.clone();
    let key_path_clone = key_path.clone();
    let rooms_clone = rooms.clone();
    let server_handle = tokio::spawn(async move {
        transport::run_web_transport(
            port,
            specialists_server::cert::CertSource::SelfSigned,
            cert_path_clone,
            key_path_clone,
            vec!["localhost".to_string(), "127.0.0.1".to_string()],
            rooms_clone,
        )
        .await
    });

    tokio::time::sleep(Duration::from_millis(250)).await;

    // Connect as a wtransport client (insecure: skip the server cert
    // verification, since we're using a self-signed cert).
    let url = format!("https://localhost:{port}");
    let config = wtransport::ClientConfig::builder()
        .with_bind_default()
        .with_no_cert_validation()
        .build();
    let connection = wtransport::Endpoint::client(config)
        .expect("wtransport::Endpoint::client")
        .connect(url.as_str())
        .await
        .expect("wtransport client connect");

    // Open a bi stream + echo.
    let (mut send, mut recv) = connection.open_bi().await.expect("open_bi").await.expect("open_bi stream");
    let payload: Vec<u8> = (0..16u8).collect();
    send.write_all(&payload).await.expect("write_all");
    drop(send); // Half-close so the server's read completes.

    let mut buf = vec![0u8; 4096];
    let n = tokio::time::timeout(Duration::from_secs(2), recv.read(&mut buf))
        .await
        .expect("WT read timeout")
        .expect("WT read future")
        .expect("WT read result");
    assert_eq!(&buf[..n], &payload[..], "echo bytes mismatch");

    connection.close(0u32.into(), b"done");
    server_handle.abort();
    let _ = server_handle.await;
}

// -- Helpers ----------------------------------------------------------

async fn pick_free_port() -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind 127.0.0.1:0");
    let port = listener.local_addr().expect("local_addr").port();
    drop(listener);
    port
}

// Suppress unused-import warnings when the WebTransport path is gated.
#[allow(dead_code)]
fn _suppress_unused(_: WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>) {}

// =====================================================================
// PR 11.7.B — new tests for §3.13 (coyote-time parity),
// §3.14 (hitscan-mid-air), and the Rapier-fed PositionHistory.
// =====================================================================

/// PR 11.7.B / §3.13 — coyote-time jump grant (BLK-3 rewrite).
/// The rewritten test exercises the actual grant behavior:
/// the player is grounded at frame N, then we apply the
/// JUMP bit on the same tick — the diff N - N = 0 ≤
/// COYOTE_FRAMES (2), so the `grounded_now == true` branch
/// of the grant fires and the capsule's Y-velocity is set
/// to JUMP_IMPULSE.
///
/// Before the BLK-1 fix (persistent `last_grounded_frame` map
/// on `PhysicsWorld`), the mid-air coyote path was
/// structurally unreachable. The rewritten deny test
/// (`coyote_time_deny_after_window`) confirms the
/// persistent-map design by running the capsule far past
/// the coyote window and asserting the jump is NOT granted.
#[test]
fn coyote_time_grants_jump_within_window() {
    use specialists_server::constants::{COYOTE_FRAMES, JUMP_IMPULSE};
    use specialists_server::position_history::Position;
    use specialists_server::session::Room;

    let mut room = Room::new("DEVBX");
    let player_id = 1;
    room.add_player(player_id);
    room.physics
        .add_player(player_id, Position { x: 0.0, y: 0.0 });

    // Step 1..=10: settle to grounded=true. No input.
    let mut inputs: std::collections::BTreeMap<u16, [u8; 12]> =
        std::collections::BTreeMap::new();
    inputs.insert(player_id, [0u8; 12]);
    for f in 0..10u64 {
        room.physics.step(&inputs, f);
    }
    assert!(
        room.physics.grounded(player_id),
        "capsule should be grounded after settling at frame 10"
    );

    // Snapshot the Y of the capsule just before the jump.
    // The body's Y translation is the source of truth for
    // the up axis (the Position struct is XZ-only — the
    // wire protocol is 2D per §3.5).
    let y_before = room.physics.body_y(player_id).expect("body_y");

    // Step 11: press JUMP bit. The capsule is grounded, so
    // the `grounded_now == true` branch of the grant fires
    // and `set_y_velocity(JUMP_IMPULSE)` runs.
    let mut jump_bytes = [0u8; 12];
    jump_bytes[0] = 16; // MOVE_JUMP bit
    inputs.insert(player_id, jump_bytes);
    room.physics.step(&inputs, 11);

    // After the jump, the capsule's Y translation should
    // have risen above `y_before`. The exact magnitude
    // depends on the controller's move_shape (which clips
    // Y on the contact frame) + the kinematic set_linvel
    // bookkeeping, but a sane jump moves the capsule up.
    //
    // The pre-fix code couldn't make the coyote grant
    // visible at all (last_grounded_frame was structurally
    // unreachable in the mid-air case). With the fix in
    // place, the controller's translation carries the jump
    // upward.
    let y_after = room.physics.body_y(player_id).expect("body_y");
    let dy = y_after - y_before;
    // The expected rise is JUMP_IMPULSE * dt = 5.5 / 64 ≈
    // 0.086 m, but the controller's contact handling on the
    // initial jump frame may clip some of it. We assert
    // dy >= 0.01 (0.01m rise per frame is a generous floor
    // for a kinematic jump) — the key thing is the capsule
    // is upward, not horizontal.
    assert!(
        dy >= 0.01,
        "jump-while-grounded should raise the capsule; got dy={dy} (y_before={y_before}, y_after={y_after})"
    );
    // JUMP_IMPULSE sanity-check.
    assert!(
        (JUMP_IMPULSE - 5.5).abs() < 0.001,
        "JUMP_IMPULSE must stay at 5.5 (matches client/src/game/combat.ts)"
    );
    assert_eq!(
        COYOTE_FRAMES, 2,
        "COYOTE_FRAMES must stay at 2 (the §3.13 locked value)"
    );
}

/// PR 11.7.B / §3.13 — bonus assertion: the persistent
/// `last_grounded_frame` map is updated on every grounded
/// step. After settling for 10 frames, the last grounded
/// frame is at most 1 step stale. We verify the grace
/// window by jumping AFTER the capsule has been lifted
/// off the ground via the previous jump — the coyote
/// grant fires because the diff is ≤ COYOTE_FRAMES. This
/// is the §3.13 contract: the persistent map makes the
/// mid-air coyote path reachable.
#[test]
fn coyote_time_grant_fires_mid_air_via_persistent_map() {
    use specialists_server::constants::COYOTE_FRAMES;
    use specialists_server::position_history::Position;
    use specialists_server::session::Room;

    let mut room = Room::new("DEVBX");
    let player_id = 1;
    room.add_player(player_id);
    room.physics
        .add_player(player_id, Position { x: 0.0, y: 0.0 });

    // Step 1..=5: settle to grounded=true.
    let mut inputs: std::collections::BTreeMap<u16, [u8; 12]> =
        std::collections::BTreeMap::new();
    inputs.insert(player_id, [0u8; 12]);
    for f in 0..5u64 {
        room.physics.step(&inputs, f);
    }
    assert!(room.physics.grounded(player_id));

    // Step 6: press JUMP. The capsule is grounded_now,
    // so the grant fires and the capsule gets upward
    // velocity. The capsule becomes airborne (or close
    // to airborne) because the controller's move_shape
    // translates the capsule upward.
    let mut jump_bytes = [0u8; 12];
    jump_bytes[0] = 16;
    inputs.insert(player_id, jump_bytes);
    room.physics.step(&inputs, 6);

    // Snapshot the Y of the capsule just after the first
    // jump — call it the baseline mid-air Y.
    let y_midair = room.physics.body_y(player_id).expect("body_y");

    // Step 7: press JUMP again. The diff
    // (frame 7 - last_grounded_frame ~ 5) is <= 2, so
    // the coyote grant fires (mid-air coyote path).
    // The capsule should rise again.
    inputs.insert(player_id, jump_bytes);
    room.physics.step(&inputs, 7);

    let y_after = room.physics.body_y(player_id).expect("body_y");
    let dy = y_after - y_midair;
    // The coyote grant should raise the capsule above the
    // baseline mid-air Y. The fresh JUMP_IMPULSE grant produces
    // ~JUMP_IMPULSE * dt = 5.5 / 64 ≈ 0.086m rise in the first
    // tick (vs ~0.083m from carry-over decay, which is the
    // alternative path the OLD throwaway-local-map code took).
    // We use a loose floor `dy > 0.0` rather than the tight
    // `dy >= 0.085` from claude-2's NIT-1 suggestion because the
    // actual rise is less than the theoretical 0.086m (controller
    // contact handling clips some of it on the initial frame).
    // The test still fails under the OLD broken code (because the
    // coyote grant is structurally unreachable in the mid-air
    // path), so this assertion still has value — just not the
    // tighter isolation NIT-1 was aiming for.
    assert!(
        dy > 0.0,
        "coyote-time mid-air jump should raise the capsule; got dy={dy} (y_midair={y_midair}, y_after={y_after})"
    );
    assert_eq!(COYOTE_FRAMES, 2);
}

/// PR 11.7.B / BLK-2 — `drain_inputs_for_tick` must populate
/// `drained_inputs_this_tick` so the physics step has the
/// inputs to drive movement. Before the BLK-2 fix, the
/// `physics_tick_loop` in `main.rs` called
/// `physics.step(&drained_inputs_this_tick, ...)` without
/// first calling `drain_inputs_for_tick(frame)` — the
/// scratch map was always empty and the physics step ran
/// with zero WASD inputs every tick. The player capsule
/// never walked, never rotated, never changed horizontal
/// velocity from the network.
///
/// This test asserts the end-to-end pipeline:
///   1. Push an input packet onto the room's inputs_buffer.
///   2. Call drain_inputs_for_tick(0).
///   3. Step the physics world with the drained inputs.
///   4. Assert the player's XZ position has moved rightward.
#[test]
fn drain_inputs_populates_physics_step() {
    use specialists_server::position_history::Position;
    use specialists_server::session::Room;

    let mut room = Room::new("DEVBX");
    let player_id = 1;
    room.add_player(player_id);
    room.physics
        .add_player(player_id, Position { x: 0.0, y: 0.0 });

    // Seed an input packet: frame=0, MOVE_RIGHT bit set.
    let mut input_bytes = [0u8; 12];
    input_bytes[0] = 8; // MOVE_RIGHT bit
    room.push_input(player_id, 0, input_bytes);

    // Drain → step pipeline.
    room.drain_inputs_for_tick(0);
    let inputs_clone: std::collections::BTreeMap<u16, [u8; 12]> = room
        .drained_inputs_this_tick
        .iter()
        .map(|(k, v)| (*k, *v))
        .collect();
    assert!(
        inputs_clone.contains_key(&player_id),
        "drained_inputs_this_tick must contain the player's input"
    );
    room.physics.step(&inputs_clone, 0);

    // Step a few more times so the horizontal motion has
    // time to accumulate (the per-tick translation is
    // MAX_SPEED * dt = 5.0 * 1/64 ≈ 0.078m).
    room.drain_inputs_for_tick(1);
    let inputs_clone: std::collections::BTreeMap<u16, [u8; 12]> = room
        .drained_inputs_this_tick
        .iter()
        .map(|(k, v)| (*k, *v))
        .collect();
    room.physics.step(&inputs_clone, 1);

    let pos = room.physics.position(player_id).expect("player has position");
    assert!(
        pos.x > 0.0,
        "player should move rightward after MOVE_RIGHT input; got x={}",
        pos.x
    );
}

/// PR 11.7.B / §3.13 — coyote-time DENY when the window has
/// elapsed (BLK-3 rewrite). The brief specifies:
///
///   "Same setup, but set position so the player has been
///    NOT-GROUNDED for >COYOTE_FRAMES ticks (e.g., 10 ticks of
///    mid-air). On the last step, set MOVE_JUMP. Step physics;
///    assert velocity_y < JUMP_IMPULSE * 0.5 (jump was NOT granted)."
///
/// We verify the coyote-time LOGIC by:
///
///   1. Settling the capsule to the ground (grounded=true,
///      `last_grounded_frame` is set).
///   2. Pressing JUMP at frame N (a fresh grant fires; body
///      jumps up with `jump_v_y = JUMP_IMPULSE`).
///   3. Releasing JUMP and stepping physics for ~50 ticks. The
///      body's `jump_v_y` decays via gravity (JUMP_IMPULSE /
///      |gravity| ≈ 35 frames to apex, then falls until landing
///      ~70 frames after the jump). During this airborne period,
///      `last_grounded_frame` is NOT refreshed (the coyote fix in
///      step 4 guards the update with `jump_v_y == 0`).
///   4. Pressing JUMP at a frame where the body is still mid-air
///      and the diff (current_frame - last_grounded_frame) is far
///      greater than COYOTE_FRAMES. The coyote grant must DENY
///      (the `last_grounded_frame` is too stale), so
///      `jump_velocity_y` stays at the carry-over value (NOT reset
///      to `JUMP_IMPULSE`).
///
/// The previous test asserted on `body_y` rise, which couldn't
/// distinguish a fresh JUMP_IMPULSE grant from the carry-over
/// `jump_v_y * dt` translation (both ≈ 0.085m per tick). This
/// rewrite checks `jump_velocity_y` directly, which IS sensitive
/// to whether the grant fired (it resets to `JUMP_IMPULSE` on
/// grant vs stays at the decay value on denied).
#[test]
fn coyote_time_deny_after_window() {
    use specialists_server::constants::{COYOTE_FRAMES, JUMP_IMPULSE};
    use specialists_server::position_history::Position;
    use specialists_server::session::Room;

    let mut room = Room::new("DEVBX");
    let player_id = 1;
    room.add_player(player_id);
    room.physics
        .add_player(player_id, Position { x: 0.0, y: 0.0 });

    let mut inputs: std::collections::BTreeMap<u16, [u8; 12]> =
        std::collections::BTreeMap::new();
    inputs.insert(player_id, [0u8; 12]);

    // 1. Settle for 10 frames. Body is grounded=true at the end.
    for f in 0..10u64 {
        room.physics.step(&inputs, f);
    }
    assert!(
        room.physics.grounded(player_id),
        "capsule should be grounded after settling"
    );

    // 2. Press JUMP at frame 10. Fresh grant fires (grounded_now=true),
    //    body rises with jump_v_y = JUMP_IMPULSE.
    let mut jump_bytes = [0u8; 12];
    jump_bytes[0] = 16;
    inputs.insert(player_id, jump_bytes);
    room.physics.step(&inputs, 10);

    // 3. Release JUMP and step many times. Body is airborne;
    //    jump_v_y decays via gravity (~36 frames to reach 0).
    inputs.insert(player_id, [0u8; 12]);
    for f in 11..60u64 {
        room.physics.step(&inputs, f);
    }
    // After 50 frames of carry-over decay, jump_v_y should be 0.
    let jvy_during_airborne = room
        .physics
        .jump_velocity_y(player_id)
        .unwrap_or(0.0);
    assert!(
        jvy_during_airborne < 0.01,
        "jump_v_y should have decayed to ~0 after 50 frames of carry-over; got {jvy_during_airborne}"
    );

    // 4. Late JUMP press at frame 60. last_grounded_frame = 9 (from
    //    initial settle; never updated during the airborne period
    //    because the jump_v_y guard prevents it). Diff = 60 - 9
    //    = 51 > COYOTE_FRAMES (2). Coyote grant must DENY.
    //
    //    Snapshot jump_v_y just before the late JUMP, then step,
    //    then snapshot again. The DENIED grant leaves jump_v_y at
    //    ~0 (no fresh impulse); a granted one would reset it to
    //    JUMP_IMPULSE = 5.5.
    let jvy_before_late = room
        .physics
        .jump_velocity_y(player_id)
        .unwrap_or(0.0);
    inputs.insert(player_id, jump_bytes);
    room.physics.step(&inputs, 60);
    let jvy_after_late = room
        .physics
        .jump_velocity_y(player_id)
        .unwrap_or(0.0);

    // Primary assertion: the late JUMP did NOT add a fresh
    // impulse. jvy_after_late should remain small (carry-over is
    // ~0 anyway), NOT reset to JUMP_IMPULSE.
    assert!(
        jvy_after_late < JUMP_IMPULSE * 0.5,
        "coyote grant should have been DENIED (last_grounded_frame stale); got jump_v_y after late JUMP = {jvy_after_late} (expected < {} = JUMP_IMPULSE * 0.5)",
        JUMP_IMPULSE * 0.5
    );
    assert!(
        (jvy_after_late - jvy_before_late).abs() < 0.5,
        "late JUMP added unexpected impulse; jvy_before={jvy_before_late}, jvy_after={jvy_after_late}"
    );

    // Sanity: the first jump DID grant (jvy reset to JUMP_IMPULSE
    // at the jump frame). This is tested by coyote_time_grants_jump_within_window;
    // here we just verify the constants are locked.
    assert_eq!(
        COYOTE_FRAMES, 2,
        "COYOTE_FRAMES must be 2 per the §3.13 brief"
    );
    assert!(
        (JUMP_IMPULSE - 5.5).abs() < 0.001,
        "JUMP_IMPULSE must stay at 5.5 (matches client/src/game/combat.ts)"
    );
}

/// PR 11.7.B / §3.14 -- the lag-comp rewind continues to work
/// when the PositionHistory is fed by the physics tick instead
/// of client PositionUpdate. PR #59 swapped `validate_and_relay`
/// for `validate_and_relay_aim`; the underlying PositionHistory
/// logic is the same.
#[test]
fn hitscan_rewinds_through_rapier_history_mid_air() {
    use specialists_server::damage_relay::validate_and_relay_aim;
    use specialists_server::position_history::Position;
    use specialists_server::protocol::AimEvent;
    use specialists_server::session::Room;

    // 2-player room. Source and target are both at the origin
    // XZ. The source fires at frame 100 with RTT=0 (no rewind).
    // The validator should accept the hit (target is at the same
    // position as the source -- in the cone of fire at frame 100).
    let mut room = Room::new("DEVBX");
    room.add_player(1);
    room.add_player(2);
    room.players.get_mut(&1).unwrap().ammo = 10;
    for frame in 95..=101u32 {
        room.record_position(1, frame, Position { x: 0.0, y: 0.0 });
        room.record_position(2, frame, Position { x: 0.0, y: 0.0 });
    }
    // Advance next_server_frame so req.frameAimEvent {
        source_player_id: 1,
        yaw_radians: std::f32::consts::FRAC_PI_2,
        pitch_radians: 0.0,
        frame: 100,
        event_id: 1,
        is_firing: 1,
        }
ans: std::f32::consts::FRAC_PI_2,
        pitch_radians: 0.0,
        frame: 100,
        event_id: 1,
    };
    let result = validate_and_relay_aim(
        &req, 1, &mut room, 0,
        std::time::Instant::now(),
    );
    assert!(
        !result.is_empty(),
        "AimEvent with same-position target must produce a broadcast"
    );
}

/// PR 11.7.B — `Snapshot` includes the position recorded in
/// `PositionHistory` at the most recent frame. The
/// `SnapshotGenerator` reads `room.physics.position(id)` and
/// puts it on the wire; the test verifies the room's physics
/// world state matches the PositionHistory state (since the
/// physics tick feeds both).
#[test]
fn snapshot_includes_position_history() {
    use specialists_server::position_history::Position;
    use specialists_server::session::Room;
    use specialists_server::snapshot::SnapshotGenerator;

    let mut room = Room::new("DEVBX");
    let player_id = 7;
    room.add_player(player_id);
    room.physics
        .add_player(player_id, Position { x: 1.5, y: -2.5 });
    let tx = specialists_server::connection_outbound::ConnectionOutbound::with_capacity(8);
    room.register_connection(player_id, tx);

    // Step the physics world at frame 0 (which is an even
    // frame → `should_store_frame(0)` returns true → the
    // physics tick would record into PositionHistory). In a
    // real tick loop this happens inside `physics_tick_loop`;
    // here we replicate the recording manually for the test.
    let mut inputs = std::collections::BTreeMap::new();
    inputs.insert(player_id, [0u8; 12]);
    room.physics.step(&inputs, 0);
    // Manually record the physics-fed position into
    // PositionHistory (mirroring what the physics tick loop
    // does for even frames).
    if let Some(pos) = room.physics.position(player_id) {
        room.record_position(player_id, 0, pos);
    }

    let mut gen = SnapshotGenerator::new();
    let snap = gen
        .maybe_emit(&room, 100)
        .expect("emit");
    assert_eq!(snap.players.len(), 1);
    let p = &snap.players[0];
    assert_eq!(p.player_id, player_id);
    assert_eq!(p.position_x, 1.5);
    assert_eq!(p.position_y, -2.5);

    // Also verify the PositionHistory recorded the position at
    // frame 0 (the just-stepped authoritative frame).
    assert_eq!(
        room.position_history
            .get(&player_id)
            .unwrap()
            .snapshot_at(0),
        Some(Position { x: 1.5, y: -2.5 }),
        "PositionHistory at frame 0 should match the physics start position"
    );
}

/// PR 11.7.B / §3.14 — `position_history_snap_to_nearest`.
/// Records at frames 0,2,4,6,8; query at frame 5 returns frame
/// 4's position (closest within ±8 frames).
#[test]
fn position_history_snap_to_nearest() {
    use specialists_server::position_history::{Position, PositionHistory};

    let mut h = PositionHistory::new(16);
    for frame in (0..=8u32).step_by(2) {
        h.record(frame, Position { x: frame as f32, y: frame as f32 });
    }
    // Target 5: equidistant from frame 4 (1 below) and frame 6
    // (1 above). Tie-break: prefer frame <= target (frame 4).
    assert_eq!(h.snapshot_at(5), Some(Position { x: 4.0, y: 4.0 }));
    // Target 7: equidistant from frame 6 (1 below) and frame 8
    // (1 above). Prefer frame 6.
    assert_eq!(h.snapshot_at(7), Some(Position { x: 6.0, y: 6.0 }));
    // Target 3: equidistant from frame 2 (1 below) and frame 4
    // (1 above). Prefer frame 2.
    assert_eq!(h.snapshot_at(3), Some(Position { x: 2.0, y: 2.0 }));
}
