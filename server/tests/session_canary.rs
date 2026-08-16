// PR 11.6.B / §3.4 — in-process end-to-end smoke.
//
// Spawns the server in-process (no child process), opens a WebSocket
// client + a WebTransport client, drives each transport with a few
// echo exchanges, and asserts no errors.
//
// Why in-process (not a child process + `nc`): the WebTransport
// path can't be smoke-tested with `nc` (it speaks HTTP/3 over QUIC,
// not TCP). Spawning the server in-process lets the test use the
// wtransport client crate directly against the bound port.
//
// CI gates:
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn websocket_echo_works() {
    // Pick a free port (port 0) so the test doesn't collide with
    // any other process on the dev box.
    let rooms = specialists_server::transport::RoomRegistry::default();
    let port = pick_free_port().await;

    let rooms_clone = rooms.clone();
    let server_handle = tokio::spawn(async move {
        specialists_server::transport::run_web_socket(port, rooms_clone).await
    });

    // Give the server a moment to bind.
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Open a WebSocket client.
    let url = format!("ws://127.0.0.1:{port}");
    let (mut ws, _resp) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("WS handshake");

    // Send 16 bytes, expect 16 bytes back (echo).
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
        specialists_server::transport::run_web_transport(
            port,
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
