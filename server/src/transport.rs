// PR 11.6.B / §3.3 + §3.4 — transport layer.
//
// Two listeners:
//   - WebTransport (HTTP/3 over UDP) on `--port-wt`
//   - WebSocket (TCP) on `--port-ws`
//
// PR 11.6.B's behavior is `echo` — every byte received on either
// transport is sent back. PR 11.6.C replaces the echo with the
// discriminator router (§3.5), PR 11.6.D adds `validate_and_relay`.
//
// Both transports share a `Arc<RwLock<HashMap<String, Room>>>`
// registry. For PR 11.6.B there's exactly one room (`"DEVBX"`) so
// every connection joins it. The rooms map exists so PR 11.9's
// matchmaker can drop in without re-plumbing.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use futures::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::RwLock;
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, error, info, warn};
use wtransport::{Endpoint, ServerConfig};

use crate::cert::DEFAULT_SANS;
use crate::constants::DEVBX_ROOM_ID;
use crate::protocol;
use crate::session::Room;

/// Shared state — the single-source-of-truth for all in-flight rooms.
/// `tokio::sync::RwLock` (async-friendly) instead of `std::sync::RwLock`
/// so the per-connection handlers don't block the executor.
pub type RoomRegistry = Arc<RwLock<HashMap<String, Arc<RwLock<Room>>>>>;

/// Spawned by `main`. Returns once the WebSocket listener stops
/// accepting (Ctrl-C / port-bind failure).
pub async fn run_web_socket(
    port: u16,
    rooms: RoomRegistry,
) -> Result<()> {
    let bind_addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = TcpListener::bind(bind_addr)
        .await
        .with_context(|| format!("bind TCP/{port}"))?;
    let local = listener
        .local_addr()
        .with_context(|| format!("local_addr on TCP/{port}"))?;
    info!(%local, "WebSocket listener bound (fallback transport, §3.3)");

    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                let rooms = rooms.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_websocket_connection(stream, peer, rooms).await {
                        warn!(%peer, "websocket connection ended with error: {e:?}");
                    }
                });
            }
            Err(e) => {
                error!("TCP accept failed: {e:?}");
                return Err(e.into());
            }
        }
    }
}

async fn handle_websocket_connection(
    stream: TcpStream,
    peer: SocketAddr,
    rooms: RoomRegistry,
) -> Result<()> {
    let ws = tokio_tungstenite::accept_async(stream)
        .await
        .with_context(|| format!("websocket handshake from {peer}"))?;
    info!(%peer, "WebSocket handshake accepted");

    // PR 11.6.B: every connection joins the hard-coded "DEVBX" room
    // (per §6 Q2). Matchmaker is PR 11.9.
    let _room = ensure_room(&rooms, DEVBX_ROOM_ID).await;

    let (mut sink, mut stream) = ws.split();
    let mut echo_count: u64 = 0;
    while let Some(msg) = stream.next().await {
        match msg? {
            Message::Binary(bytes) => {
                echo_count += 1;
                debug!(%peer, echo_count, bytes_len = bytes.len(), "WS recv binary");
                // Echo semantics for PR 11.6.B. PR 11.6.C dispatches on
                // the first byte (discriminator) instead.
                sink.send(Message::Binary(bytes)).await?;
            }
            Message::Text(text) => {
                echo_count += 1;
                debug!(%peer, echo_count, bytes_len = text.len(), "WS recv text");
                sink.send(Message::Text(text)).await?;
            }
            Message::Close(frame) => {
                info!(%peer, ?frame, "WebSocket close frame received");
                let _ = sink.send(Message::Close(frame)).await;
                break;
            }
            Message::Ping(payload) => {
                sink.send(Message::Pong(payload)).await?;
            }
            Message::Pong(_) => {
                // No RTT tracking yet — PR 11.6.D wires it up via the
                // dedicated Ping/Pong wire types (see protocol.rs).
            }
            Message::Frame(_) => {
                // Per tungstenite docs: never returned by read.
            }
        }
    }

    // Drop the player's room membership on disconnect. PR 11.9+
    // will replace with reconnection-aware logic; for now the room is
    // immortal so the WS handler skips room writes entirely. The
    // `let _ = room;` and outer `rooms.write().await` lock acquisitions
    // are intentionally omitted — issuing them here is a no-op that
    // would block the executor for no benefit (per PR 11.6.B's
    // cross-vendor review on this code path).
    info!(%peer, echo_count, "WebSocket connection closed");
    Ok(())
}

/// Spawned by `main`. Loads (or generates) the cert at the given
/// paths, builds the `wtransport::Endpoint`, and dispatches incoming
/// sessions. Returns on `Endpoint::accept()` error or shutdown.
pub async fn run_web_transport(
    port: u16,
    cert_path: PathBuf,
    key_path: PathBuf,
    sans: Vec<String>,
    rooms: RoomRegistry,
) -> Result<()> {
    crate::cert::ensure_dev_certs(&cert_path, &key_path, sans_with_defaults(sans))
        .await
        .context("ensure_dev_certs")?;
    let identity = crate::cert::load_identity(&cert_path, &key_path)
        .await
        .context("load_identity")?;

    let config = ServerConfig::builder()
        .with_bind_default(port)
        .with_identity(identity)
        .build();

    let server = Endpoint::server(config).with_context(|| {
        format!("wtransport Endpoint::server on UDP/{port} — port in use?")
    })?;
    let local = server.local_addr().context("wtransport local_addr")?;
    info!(%local, "WebTransport listener bound (primary transport, §3.3)");

    loop {
        let incoming = server.accept().await;
        let rooms = rooms.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_webtransport_session(incoming, rooms).await {
                warn!("webtransport session ended with error: {e:?}");
            }
        });
    }
}

async fn handle_webtransport_session(
    incoming: wtransport::endpoint::IncomingSession,
    rooms: RoomRegistry,
) -> Result<()> {
    let session_request = incoming.await?;
    let authority = session_request.authority().to_string();
    let path = session_request.path().to_string();
    debug!(%authority, %path, "WebTransport session request");

    let connection = session_request.accept().await?;
    info!(%authority, %path, "WebTransport session accepted");

    // Same hard-coded room routing as the WS path.
    let _room = ensure_room(&rooms, DEVBX_ROOM_ID).await;

    let mut echo_count: u64 = 0;
    loop {
        tokio::select! {
            bi = connection.accept_bi() => {
                let (mut send, mut recv) = bi?;
                let mut buf = vec![0u8; 4096];
                let n = match recv.read(&mut buf).await? {
                    Some(n) => n,
                    None => continue,
                };
                let payload = &buf[..n];
                echo_count += 1;
                debug!(bytes_len = n, echo_count, "WT recv bi stream");
                send.write_all(payload).await?;
                // Closing the send half gracefully ends the stream;
                // the client can `accept_bi` again for the next packet.
                let _ = send.finish().await;
            }
            uni = connection.accept_uni() => {
                let mut recv = uni?;
                let mut buf = vec![0u8; 4096];
                let n = match recv.read(&mut buf).await? {
                    Some(n) => n,
                    None => continue,
                };
                echo_count += 1;
                debug!(bytes_len = n, echo_count, "WT recv uni stream");
                // Echo back on a new uni stream (server-originated).
                let mut send_stream = connection.open_uni().await?.await?;
                send_stream.write_all(&buf[..n]).await?;
                let _ = send_stream.finish().await;
            }
            datagram = connection.receive_datagram() => {
                let dgram = datagram?;
                let payload = dgram.payload();
                echo_count += 1;
                debug!(bytes_len = payload.len(), echo_count, "WT recv datagram");
                connection.send_datagram(payload.as_ref())?;
            }
        }
    }
}

/// Look up (or create) the room with the given id. Helper shared by
/// both transports — keeps the lazy-init semantics in one place.
pub async fn ensure_room(rooms: &RoomRegistry, id: &str) -> Arc<RwLock<Room>> {
    // Fast path: read lock.
    {
        let guard = rooms.read().await;
        if let Some(room) = guard.get(id) {
            return room.clone();
        }
    }
    // Slow path: take write lock, double-check, insert.
    let mut guard = rooms.write().await;
    if let Some(room) = guard.get(id) {
        return room.clone();
    }
    let room = Arc::new(RwLock::new(Room::new(id)));
    guard.insert(id.to_string(), room.clone());
    info!(room_id = id, "created new room");
    room
}

/// Combine caller-supplied SANs (e.g., a Tailscale IP) with the
/// defaults (`localhost`, `127.0.0.1`, `::1`). Dedupes while
/// preserving the defaults-first order.
fn sans_with_defaults(extra: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = DEFAULT_SANS.iter().map(|s| s.to_string()).collect();
    for s in extra {
        if !out.iter().any(|existing| existing == &s) {
            out.push(s);
        }
    }
    out
}

// -- Forward-declared helpers used by `main.rs` -----------------------------

/// Helper used by the future PR 11.6.C discriminator router. For
/// PR 11.6.B this is unused — the transport layer echoes raw bytes
/// without inspecting the discriminator. We re-export the wire
/// constants via `protocol::*` so PR 11.6.C's import statement is a
/// one-liner.
pub use protocol::DISCRIMINATOR_INPUTS_SERVER;

/// Helper for the §1.2 seam. PR 11.6.C wires this into the bi-stream
/// read path; PR 11.6.B does nothing with it (input bytes are echoed
/// back unchanged).
#[allow(dead_code)]
pub fn handle_inputs_server_payload(_payload: &[u8]) -> Option<protocol::InputsServer> {
    protocol::decode_inputs_server(_payload)
}
