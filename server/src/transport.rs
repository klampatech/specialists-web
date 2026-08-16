// PR 11.6.C / §3.3 + §3.5 — transport layer + discriminator router.
//
// Two listeners:
//   - WebTransport (HTTP/3 over UDP) on `--port-wt`
//   - WebSocket (TCP) on `--port-ws`
//
// **Discriminator router**: every inbound binary payload is dispatched
// on its first byte (the discriminator — see `protocol.rs`). Each
// `0xXX` route does its own decode + side-effect + reply.
//
// Both transports share a `Arc<RwLock<HashMap<String, Room>>>`
// registry. For PR 11.6.C there's exactly one room (`"DEVBX"`) so
// every connection joins it. The rooms map exists so PR 11.9's
// matchmaker can drop in without re-plumbing.
//
// **What PR 11.6.C adds vs PR 11.6.B**:
//   - Replaces the echo with the discriminator router (8 routes).
//   - Keeps the individual listener entry points crate-private. The
//     integration canary includes this module directly and spawns them on
//     port 0; the normal binary uses the public `run_server` orchestration
//     seam.
//
// **What PR 11.6.C does NOT add** (out of scope, queued for 11.6.D):
//   - `validate_and_relay` (server-auth damage validation).
//   - Lag-comp rewind math (`PositionHistory::snapshot_at` + hit
//     re-cast at the rewound frame).
//   - Per-frame `DamageBroadcast` relay to ALL clients in the room.
//     For PR 11.6.C the router responds to the SENDER only; the
//     relay-to-others path lands in 11.6.D.

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

use specialists_server::cert::DEFAULT_SANS;
use specialists_server::constants::DEVBX_ROOM_ID;
use specialists_server::position_history::Position;
use specialists_server::protocol::{
    decode_damage_request, decode_inputs_server, decode_ping, decode_position_update,
    encode_damage_broadcast, encode_pong, DamageBroadcast, DISCRIMINATOR_DAMAGE_BROADCAST,
    DISCRIMINATOR_DAMAGE_REQUEST, DISCRIMINATOR_INPUTS, DISCRIMINATOR_INPUTS_SERVER,
    DISCRIMINATOR_PING, DISCRIMINATOR_PONG, DISCRIMINATOR_POSITION_UPDATE, Pong,
};
use specialists_server::session::{EncodedInput, PlayerId, Room, ServerFrame};

/// Shared state — the single-source-of-truth for all in-flight rooms.
/// `tokio::sync::RwLock` (async-friendly) instead of `std::sync::RwLock`
/// so the per-connection handlers don't block the executor.
pub type RoomRegistry = Arc<RwLock<HashMap<String, Arc<RwLock<Room>>>>>;

/// Spawned by `main`. Returns once the WebSocket listener stops
/// accepting (Ctrl-C / port-bind failure). This entry point is
/// crate-private and exercised by the in-process canary through a
/// `#[path]` include.
/// Run both transport listeners with one shared room registry. The binary
/// can select this seam while the integration canary keeps the individual
/// listener entry points crate-private by including this module directly.
///
/// The function owns both Tokio child tasks and returns when either listener
/// reports an error. Dropping the future from the binary's `select!` also
/// aborts both child tasks on Ctrl-C.
pub async fn run_server(
    port_wt: u16,
    port_ws: u16,
    cert_path: PathBuf,
    key_path: PathBuf,
    sans: Vec<String>,
    rooms: RoomRegistry,
) -> Result<()> {
    let wt_handle = tokio::spawn({
        let rooms = rooms.clone();
        let cert_path = cert_path.clone();
        let key_path = key_path.clone();
        let sans = sans.clone();
        async move {
            if let Err(e) = run_web_transport(port_wt, cert_path, key_path, sans, rooms).await {
                warn!("run_web_transport exited: {e:?}");
                Err(e)
            } else {
                Ok(())
            }
        }
    });

    let ws_handle = tokio::spawn({
        let rooms = rooms.clone();
        async move {
            if let Err(e) = run_web_socket(port_ws, rooms).await {
                warn!("run_web_socket exited: {e:?}");
                Err(e)
            } else {
                Ok(())
            }
        }
    });

    tokio::select! {
        result = wt_handle => {
            match result {
                Ok(Ok(())) => Ok(()),
                Ok(Err(e)) => Err(e),
                Err(e) => Err(anyhow::anyhow!("WebTransport task panicked: {e}").context("run_server")),
            }
        }
        result = ws_handle => {
            match result {
                Ok(Ok(())) => Ok(()),
                Ok(Err(e)) => Err(e),
                Err(e) => Err(anyhow::anyhow!("WebSocket task panicked: {e}").context("run_server")),
            }
        }
    }
}

pub(crate) async fn run_web_socket(
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

    // Every connection joins the hard-coded "DEVBX" room (per §6 Q2).
    let _room = ensure_room(&rooms, DEVBX_ROOM_ID).await;

    let (mut sink, mut stream) = ws.split();
    while let Some(msg) = stream.next().await {
        let msg = msg?;
        match msg {
            Message::Binary(bytes) => {
                let reply = handle_binary(&bytes, &rooms).await;
                if !reply.is_empty() {
                    debug!(%peer, bytes_len = bytes.len(), reply_len = reply.len(), "WS dispatch -> reply");
                    sink.send(Message::Binary(reply.into())).await?;
                } else {
                    debug!(%peer, bytes_len = bytes.len(), "WS dispatch -> no reply");
                }
            }
            Message::Text(text) => {
                // Text frames are not on the PR 11.6 wire. Log + drop.
                debug!(%peer, bytes_len = text.len(), "WS recv text (ignored)");
                // No reply — text is not a valid discriminator.
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

    info!(%peer, "WebSocket connection closed");
    Ok(())
}

/// Spawned by `main`. Loads (or generates) the cert at the given
/// paths, builds the `wtransport::Endpoint`, and dispatches incoming
/// sessions. Returns on `Endpoint::accept()` error or shutdown.
pub(crate) async fn run_web_transport(
    port: u16,
    cert_path: PathBuf,
    key_path: PathBuf,
    sans: Vec<String>,
    rooms: RoomRegistry,
) -> Result<()> {
    specialists_server::cert::ensure_dev_certs(&cert_path, &key_path, sans_with_defaults(sans))
        .await
        .context("ensure_dev_certs")?;
    let identity = specialists_server::cert::load_identity(&cert_path, &key_path)
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

    let _room = ensure_room(&rooms, DEVBX_ROOM_ID).await;

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
                let reply = handle_binary(payload, &rooms).await;
                if !reply.is_empty() {
                    send.write_all(&reply).await?;
                }
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
                let payload = &buf[..n];
                let reply = handle_binary(payload, &rooms).await;
                if !reply.is_empty() {
                    // Echo back on a new uni stream (server-originated).
                    let mut send_stream = connection.open_uni().await?.await?;
                    send_stream.write_all(&reply).await?;
                    let _ = send_stream.finish().await;
                }
            }
            datagram = connection.receive_datagram() => {
                let dgram = datagram?;
                let payload = dgram.payload();
                let reply = handle_binary(payload.as_ref(), &rooms).await;
                if !reply.is_empty() {
                    connection.send_datagram(reply.as_slice())?;
                }
            }
        }
    }
}

/// Dispatcher — the discriminator router. Returns the reply payload
/// (discriminator-prefixed), or an empty `Vec` for "no reply" (which
/// is the case for `PositionUpdate`, `InputsServer`, and any unknown
/// discriminator).
///
/// **§1.2 stay-alive**: even when there's nothing to reply with, the
/// transport layer logs the dispatch so the dev can see the wire
/// activity in the logs. The `0x00` legacy lockstep inputs path logs
/// + echoes (PR 11.6.B's behavior) so the existing PR 11.6.B-style
/// lockstep smoke continues to work; PR 11.7 retires that path.
///
/// **Locking discipline**: read locks are fine across `.await`
/// (async-friendly). Write locks are NOT — we drop the guard before
/// the await point. In practice, the dispatcher does its
/// `room.read()` / `room.write()` in tight critical sections and
/// never holds a write guard across an `.await`.
pub(super) async fn handle_binary(payload: &[u8], rooms: &RoomRegistry) -> Vec<u8> {
    if payload.is_empty() {
        return vec![];
    }
    match payload[0] {
        DISCRIMINATOR_INPUTS => {
            // PR 11.6.B §1.2 stay-alive: the legacy lockstep inputs
            // (P2P substrate, 12 bytes — INPUT_SIZE from inputBitmask.ts)
            // are echoed back unchanged. PR 11.7 retires this path.
            debug!(
                len = payload.len(),
                "inputs (legacy lockstep) — echoed (PR 11.7 retires)"
            );
            payload.to_vec()
        }
        DISCRIMINATOR_DAMAGE_REQUEST => {
            // §1.2 seam: decode + log + synthesize a broadcast. PR 11.6.D
            // replaces the synth with the real validation/relay.
            let Some(req) = decode_damage_request(&payload[1..]) else {
                warn!("damageRequest: decoder rejected malformed payload");
                return vec![];
            };
            info!(
                ?req,
                "damageRequest received (PR 11.6.C — synthetic broadcast)"
            );
            let bc = DamageBroadcast {
                server_frame: 0, // §1.2: PR 11.6.D wires the real server frame
                server_seq: 0,   // §1.2: PR 11.6.D wires room.next_seq()
                source_player_id: req.source_player_id,
                target_player_id: req.target_player_id,
                source: req.source,
                amount: req.amount,
                origin_event_id: req.event_id,
            };
            let body = encode_damage_broadcast(&bc);
            let mut reply = Vec::with_capacity(1 + body.len());
            reply.push(DISCRIMINATOR_DAMAGE_BROADCAST);
            reply.extend(body);
            reply
        }
        DISCRIMINATOR_DAMAGE_BROADCAST => {
            // §1.2: server-originated broadcasts flow TO clients, not FROM.
            // A client sending one back is either a confused client or
            // a spoof attempt. Log and discard (anti-spoof guard).
            warn!("client sent damageBroadcast — discarded (anti-spoof guard)");
            vec![]
        }
        DISCRIMINATOR_POSITION_UPDATE => {
            let Some(pu) = decode_position_update(&payload[1..]) else {
                warn!("positionUpdate: decoder rejected malformed payload");
                return vec![];
            };
            // Push onto the room's PositionHistory. §1.2 seam: WRITE-ONLY.
            let room_arc = ensure_room(rooms, DEVBX_ROOM_ID).await;
            {
                let mut room_guard = room_arc.write().await;
                room_guard.record_position(
                    pu.player_id,
                    pu.server_frame,
                    Position { x: pu.position_x, y: pu.position_y },
                );
            }
            debug!(
                player_id = pu.player_id,
                server_frame = pu.server_frame,
                "positionUpdate recorded"
            );
            vec![] // no reply — server doesn't ack position updates
        }
        DISCRIMINATOR_PING => {
            let Some(ping) = decode_ping(&payload[1..]) else {
                warn!("ping: decoder rejected malformed payload");
                return vec![];
            };
            let pong = Pong {
                client_timestamp: ping.client_timestamp,
                server_timestamp: 0, // §1.2: PR 11.6.D wires real monotonic clock
            };
            let body = encode_pong(&pong);
            let mut reply = Vec::with_capacity(1 + body.len());
            reply.push(DISCRIMINATOR_PONG);
            reply.extend(body);
            reply
        }
        DISCRIMINATOR_PONG => {
            // Clients don't send pongs; discard if they do.
            debug!("client sent pong — discarded");
            vec![]
        }
        DISCRIMINATOR_INPUTS_SERVER => {
            // §1.2: server-routed inputs for PR 11.7. PR 11.6.C
            // buffers onto `inputs_buffer` (WRITE-ONLY this PR).
            // PR 11.7 reads them for snapshot generation.
            let Some(inputs) = decode_inputs_server(payload) else {
                warn!("inputsServer: decoder rejected malformed payload");
                return vec![];
            };
            let room_arc = ensure_room(rooms, DEVBX_ROOM_ID).await;
            // Convert Vec<u8> to [u8; 12] (EncodedInput). The decoder
            // already enforces length, so the conversion is infallible
            // modulo `try_into` for safety.
            let frame: ServerFrame = inputs.frame;
            let mut input_bytes: EncodedInput = [0u8; 12];
            let copy_len = inputs.encoded_input.len().min(12);
            input_bytes[..copy_len].copy_from_slice(&inputs.encoded_input[..copy_len]);
            // Best-effort player_id resolution: in PR 11.6.C there's no
            // join handshake, so we use the first byte of the input
            // blob as a placeholder. PR 11.6.D replaces this with a
            // proper player-id assignment when the room broadcasts
            // back. For now, just key the buffer on byte 0.
            let player_id: PlayerId = input_bytes[0] as PlayerId;
            {
                let mut room_guard = room_arc.write().await;
                room_guard.push_input(player_id, frame, input_bytes);
            }
            debug!(
                player_id,
                frame,
                "inputsServer buffered onto Room.inputs_buffer"
            );
            vec![]
        }
        other => {
            warn!(
                discriminator = other,
                "unknown discriminator — discarded"
            );
            vec![]
        }
    }
}

/// Look up (or create) the room with the given id. Helper shared by
/// both transports — keeps the lazy-init semantics in one place.
pub(super) async fn ensure_room(rooms: &RoomRegistry, id: &str) -> Arc<RwLock<Room>> {
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

// -- Unit tests for the dispatcher ---------------------------------------
//
// The dispatcher is `async` (it needs to acquire room locks). Each
// test builds a fresh `RoomRegistry` with the default DEVBX room so
// the `ensure_room` call inside the dispatcher is a no-op.

#[cfg(test)]
mod tests {
    use super::*;
    use specialists_server::protocol::{
        decode_damage_broadcast, decode_pong, encode_damage_request, encode_ping,
        encode_position_update, PositionUpdate,
    };

    fn fresh_rooms() -> RoomRegistry {
        // Pre-populate so the dispatcher's `ensure_room` is a no-op.
        let mut m = HashMap::new();
        m.insert(
            DEVBX_ROOM_ID.to_string(),
            Arc::new(RwLock::new(Room::new(DEVBX_ROOM_ID))),
        );
        Arc::new(RwLock::new(m))
    }

    #[tokio::test]
    async fn dispatch_empty_payload() {
        let rooms = fresh_rooms();
        let reply = handle_binary(&[], &rooms).await;
        assert!(reply.is_empty(), "empty payload must produce no reply");
    }

    #[tokio::test]
    async fn dispatch_unknown_discriminator() {
        let rooms = fresh_rooms();
        // 0xFF is unused; should log + discard + return empty.
        let reply = handle_binary(&[0xFF, 0x00, 0x00, 0x00], &rooms).await;
        assert!(reply.is_empty(), "unknown discriminator must produce no reply");
    }

    #[tokio::test]
    async fn dispatch_damage_request_returns_broadcast() {
        let rooms = fresh_rooms();
        // Encode a DamageRequest, prefix with the discriminator,
        // expect a DamageBroadcast reply that echoes the fields.
        let req = specialists_server::protocol::DamageRequest {
            frame: 0xdeadbeef,
            source_player_id: 7,
            target_player_id: 9,
            source: 0, // fire
            amount: 12,
            event_id: 0xcafebabe,
        };
        let mut payload = vec![DISCRIMINATOR_DAMAGE_REQUEST];
        payload.extend(encode_damage_request(&req));

        let reply = handle_binary(&payload, &rooms).await;

        // Reply: 1-byte discriminator + 18-byte body.
        assert_eq!(reply.len(), 1 + specialists_server::protocol::DAMAGE_BROADCAST_WIRE_SIZE);
        assert_eq!(reply[0], DISCRIMINATOR_DAMAGE_BROADCAST);
        let bc = decode_damage_broadcast(&reply[1..]).expect("decode broadcast");
        assert_eq!(bc.source_player_id, req.source_player_id);
        assert_eq!(bc.target_player_id, req.target_player_id);
        assert_eq!(bc.source, req.source);
        assert_eq!(bc.amount, req.amount);
        assert_eq!(bc.origin_event_id, req.event_id);
        // server_frame + server_seq are §1.2 placeholders (0) this PR.
        assert_eq!(bc.server_frame, 0);
        assert_eq!(bc.server_seq, 0);
    }

    #[tokio::test]
    async fn dispatch_position_update_no_reply() {
        let rooms = fresh_rooms();
        let pu = PositionUpdate {
            server_frame: 42,
            player_id: 7,
            position_x: 1.5,
            position_y: -2.25,
        };
        let mut payload = vec![DISCRIMINATOR_POSITION_UPDATE];
        payload.extend(encode_position_update(&pu));

        let reply = handle_binary(&payload, &rooms).await;
        assert!(reply.is_empty(), "positionUpdate must not produce a reply");

        // Verify the PositionHistory actually received the entry.
        let room_arc = rooms.read().await.get(DEVBX_ROOM_ID).unwrap().clone();
        let hist = room_arc.read().await;
        let entry = hist
            .position_history
            .get(&7)
            .expect("player 7 history")
            .snapshot_at(42)
            .expect("snapshot at frame 42");
        assert_eq!(entry.x, 1.5);
        assert_eq!(entry.y, -2.25);
    }

    #[tokio::test]
    async fn dispatch_ping_returns_pong() {
        let rooms = fresh_rooms();
        let mut payload = vec![DISCRIMINATOR_PING];
        let ping = specialists_server::protocol::Ping { client_timestamp: 0xfeedface };
        payload.extend(encode_ping(&ping));

        let reply = handle_binary(&payload, &rooms).await;
        assert_eq!(reply.len(), 1 + specialists_server::protocol::PONG_WIRE_SIZE);
        assert_eq!(reply[0], DISCRIMINATOR_PONG);
        let pong = decode_pong(&reply[1..]).expect("decode pong");
        assert_eq!(pong.client_timestamp, ping.client_timestamp);
        // server_timestamp is §1.2 placeholder (0) this PR.
        assert_eq!(pong.server_timestamp, 0);
    }
}
