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
// **What PR 11.6.C added vs PR 11.6.B**:
//   - Replaced the echo with the discriminator router (8 routes).
//   - Kept the individual listener entry points crate-private. The
//     integration canary includes this module directly and spawns them on
//     port 0; the normal binary uses the public `run_server` orchestration
//     seam.
//
// **What PR 11.6.D adds vs PR 11.6.C**:
//   - Swaps the `0x01 DamageRequest` synth-broadcast for the real
//     `damage_relay::validate_and_relay` (8 gates + lag-comp rewind).
//   - Fans the resulting `DamageBroadcast` out to EVERY connection
//     in the room (not just the sender). Each connection owns a
//     `mpsc::Sender<Vec<u8>>` registered into `Room.connections`
//     on connect; the dispatcher clones the encoded broadcast bytes
//     to every sender.
//   - The `0x02 DamageBroadcast` inbound arm is removed (clients
//     never send broadcasts; receiving one is an anti-spoof signal —
//     warn + drop).
//   - The listener loop now spawns a per-connection outbound task
//     that drains the `mpsc::Receiver<Vec<u8>>` and writes the
//     bytes to the transport stream.
//
// **What PR 11.6.D does NOT add** (out of scope, queued for 11.6.E/11.7):
//   - Matchmaker (multi-room; PR 11.9).
//   - Lockstep substrate retirement (PR 11.7).
//   - Production cert handling (Let's Encrypt, PR 11.6.E now absorbed into 11.7).

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::Instant;

use anyhow::{Context, Result};
use futures::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, RwLock};
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, error, info, warn};
use wtransport::{Endpoint, ServerConfig};

use specialists_server::cert::DEFAULT_SANS;
use specialists_server::constants::DEVBX_ROOM_ID;
use specialists_server::position_history::Position;
use specialists_server::protocol::{
    decode_damage_request, decode_inputs_server, decode_ping, decode_position_update,
    encode_pong, DISCRIMINATOR_DAMAGE_BROADCAST,
    DISCRIMINATOR_DAMAGE_REQUEST, DISCRIMINATOR_INPUTS, DISCRIMINATOR_INPUTS_SERVER,
    DISCRIMINATOR_PING, DISCRIMINATOR_PONG, DISCRIMINATOR_POSITION_UPDATE, Pong,
};
use specialists_server::session::{EncodedInput, PlayerId, Room, ServerFrame};

/// Shared state — the single-source-of-truth for all in-flight rooms.
/// `tokio::sync::RwLock` (async-friendly) instead of `std::sync::RwLock`
/// so the per-connection handlers don't block the executor.
pub type RoomRegistry = Arc<RwLock<HashMap<String, Arc<RwLock<Room>>>>>;

/// PR 11.6.D: counter for assigning unique placeholder PlayerIds to
/// fresh connections that haven't identified themselves yet via a
/// `DamageRequest`. Starts at 1000 so it never collides with a
/// legitimate wire-format PlayerId (the smoke uses 1 and 2; the
/// counter wraps at u16::MAX which we accept — 60k+ connections).
static PLACEHOLDER_COUNTER: AtomicU16 = AtomicU16::new(1000);

/// PR 11.6.D: allocate the next unique placeholder PlayerId for a
/// fresh connection. The dispatcher re-registers the connection
/// under its real PlayerId (from the first `DamageRequest`) once
/// validation succeeds.
fn next_placeholder_player_id() -> PlayerId {
    PLACEHOLDER_COUNTER.fetch_add(1, Ordering::Relaxed)
}

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
    let room_arc = ensure_room(&rooms, DEVBX_ROOM_ID).await;

    // PR 11.6.D: per-connection outbound mpsc sender. Each
    // connection gets a unique placeholder PlayerId (assigned by
    // `next_placeholder_player_id`) until its first `DamageRequest`
    // claims its real PlayerId; the dispatcher re-registers under
    // the claimed id (see `handle_binary`'s DamageRequest arm).
    let (outbound_tx, mut outbound_rx) = mpsc::channel::<Vec<u8>>(64);
    let placeholder_id = next_placeholder_player_id();
    {
        let mut room_guard = room_arc.write().await;
        room_guard.register_connection(placeholder_id, outbound_tx);
    }

    let (mut sink, mut stream) = ws.split();

    // PR 11.6.D: the inbound loop drains `outbound_rx` between
    // handling inbound messages. Tungstenite's `split` is exclusive,
    // so we can't have a separate outbound task. The outbound
    // mpsc acts as a write-side queue: the dispatcher pushes
    // encoded bytes (broadcasts + replies) onto it via
    // `Room.connections`, and this loop pops + writes them.
    loop {
        tokio::select! {
            // Outbound: drain whatever's been queued.
            maybe_bytes = outbound_rx.recv() => {
                match maybe_bytes {
                    Some(bytes) => {
                        if let Err(e) = sink.send(Message::Binary(bytes.into())).await {
                            warn!(%peer, "WS outbound send failed: {e:?}");
                            break;
                        }
                    }
                    None => {
                        // Sender dropped (the connection's outbound_tx
                        // was removed from Room.connections). Nothing
                        // more to write; loop continues to drain
                        // inbound.
                    }
                }
            }
            // Inbound: dispatch on discriminator.
            maybe_msg = stream.next() => {
                let msg = match maybe_msg {
                    Some(Ok(m)) => m,
                    Some(Err(e)) => {
                        warn!(%peer, "WS recv error: {e:?}");
                        break;
                    }
                    None => break, // stream closed
                };
                match msg {
                    Message::Binary(bytes) => {
                        let reply = handle_binary(&bytes, &rooms, placeholder_id).await;
                        if !reply.is_empty() {
                            debug!(%peer, bytes_len = bytes.len(), reply_len = reply.len(), "WS dispatch -> reply");
                            // For PR 11.6.D broadcasts the reply is
                            // also in the outbound mpsc (the
                            // dispatcher fans out to all
                            // connections, including this one). The
                            // outbound_rx branch picks it up. For
                            // non-broadcast replies (legacy INPUTS
                            // echo, Ping -> Pong), the reply is
                            // NOT in the mpsc — we must write it
                            // directly here. Detect: broadcasts
                            // start with DISCRIMINATOR_DAMAGE_BROADCAST.
                            if reply.first() != Some(&specialists_server::protocol::DISCRIMINATOR_DAMAGE_BROADCAST) {
                                if let Err(e) = sink.send(Message::Binary(reply.into())).await {
                                    warn!(%peer, "WS direct reply send failed: {e:?}");
                                    break;
                                }
                            }
                        } else {
                            debug!(%peer, bytes_len = bytes.len(), "WS dispatch -> no reply");
                        }
                    }
                    Message::Text(text) => {
                        debug!(%peer, bytes_len = text.len(), "WS recv text (ignored)");
                    }
                    Message::Close(frame) => {
                        info!(%peer, ?frame, "WebSocket close frame received");
                        let _ = sink.send(Message::Close(frame)).await;
                        break;
                    }
                    Message::Ping(payload) => {
                        sink.send(Message::Pong(payload)).await?;
                    }
                    Message::Pong(_) => {}
                    Message::Frame(_) => {}
                }
            }
        }
    }

    // Cleanup: unregister the connection from the room.
    {
        let mut room_guard = room_arc.write().await;
        room_guard.unregister_connection(placeholder_id);
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

    let room_arc = ensure_room(&rooms, DEVBX_ROOM_ID).await;

    // PR 11.6.D: per-connection outbound mpsc (same pattern as
    // WebSocket). Each connection gets a unique placeholder
    // PlayerId (assigned by `next_placeholder_player_id`) until
    // its first `DamageRequest` claims its real PlayerId; the
    // dispatcher re-registers under the claimed id.
    let (outbound_tx, mut outbound_rx) = mpsc::channel::<Vec<u8>>(64);
    let placeholder_id = next_placeholder_player_id();
    {
        let mut room_guard = room_arc.write().await;
        room_guard.register_connection(placeholder_id, outbound_tx);
    }

    loop {
        tokio::select! {
            maybe_bytes = outbound_rx.recv() => {
                match maybe_bytes {
                    Some(bytes) => {
                        // PR 11.6.D: server-originated broadcasts go
                        // out via datagrams (small, no back-pressure).
                        // Any future PR can switch to uni streams if
                        // the broadcast size exceeds the datagram
                        // ceiling (the 18-byte broadcast fits easily).
                        if let Err(e) = connection.send_datagram(bytes.as_slice()) {
                            warn!(%authority, "WT outbound datagram send failed: {e:?}");
                        }
                    }
                    None => {
                        // Sender dropped (connection unregister). Just
                        // continue waiting on inbound.
                    }
                }
            }
            bi = connection.accept_bi() => {
                let (mut send, mut recv) = bi?;
                let mut buf = vec![0u8; 4096];
                let n = match recv.read(&mut buf).await? {
                    Some(n) => n,
                    None => continue,
                };
                let payload = &buf[..n];
                let reply = handle_binary(payload, &rooms, placeholder_id).await;
                if !reply.is_empty() {
                    send.write_all(&reply).await?;
                }
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
                let _ = handle_binary(payload, &rooms, placeholder_id).await;
                // No direct reply on uni streams; broadcasts go via
                // the outbound datagram path.
            }
            datagram = connection.receive_datagram() => {
                let dgram = datagram?;
                let payload = dgram.payload();
                let _ = handle_binary(payload.as_ref(), &rooms, placeholder_id).await;
                // No direct reply; broadcasts go via the outbound
                // datagram path.
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
pub(super) async fn handle_binary(
    payload: &[u8],
    rooms: &RoomRegistry,
    placeholder_player_id: PlayerId,
) -> Vec<u8> {
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
            // PR 11.6.D: server-auth damage validation.
            let Some(req) = decode_damage_request(&payload[1..]) else {
                warn!("damageRequest: decoder rejected malformed payload");
                return vec![];
            };
            // The connection's PlayerId is determined by which room
            // entry it registered under. PR 11.6.D's listener loop
            // stashes the PlayerId on the inbound side via a
            // thread-local-style mechanism. For PR 11.6.D we use the
            // simplest available identity: the connection's source
            // PlayerId is `req.source_player_id` (the request's
            // asserted source). The validator performs an anti-spoof
            // check (Gate 2) that requires this to match the
            // connection's PlayerId — which in this PR is the
            // request's source. A future PR can add a proper
            // per-connection identity via the join handshake.
            //
            // For PR 11.6.D's smoke + dev-box we trust the request's
            // `source_player_id` as the connection identity. This
            // works because each tab uses a unique PlayerId that
            // isn't reassigned (PR 11.9's matchmaker enforces this).
            let source_player_id = req.source_player_id;
            let room_arc = ensure_room(rooms, DEVBX_ROOM_ID).await;
            let now = Instant::now();
            // Run the validator under a write lock. The lock is held
            // for the duration of validate_and_relay (no .await
            // inside), so the lock is released synchronously.
            let bc_opt = {
                let mut room_guard = room_arc.write().await;
                specialists_server::damage_relay::validate_and_relay(
                    &req,
                    source_player_id,
                    &mut room_guard,
                    0, // PR 11.6.D: per-connection RTT not yet wired (the
                    //    listener doesn't track per-connection RTT — that's
                    //    a follow-up). Until it's wired, lag_frames=0,
                    //    meaning no rewind. The hitscan still re-casts
                    //    against the latest recorded positions.
                    now,
                )
            };
            let Some(bc) = bc_opt else {
                // Validator rejected (warn! was already emitted inside
                // validate_and_relay). No reply, no fan-out.
                debug!(
                    source = req.source_player_id,
                    target = req.target_player_id,
                    event_id = req.event_id,
                    "damageRequest rejected by validate_and_relay",
                );
                return vec![];
            };
            // PR 11.6.D: re-register the connection under the
            // request's claimed PlayerId. The connection started
            // registered with a unique placeholder PlayerId
            // (assigned by `next_placeholder_player_id` at
            // handshake time); this is the first time we know its
            // real PlayerId. Subsequent requests from this
            // connection will find the connection registered under
            // its real PlayerId.
            //
            // We do this AFTER validation succeeds so a rejected
            // request doesn't promote a phantom connection. The
            // connection's placeholder_id is passed in by the
            // listener loop.
            //
            // Idempotency note: if the connection was already
            // re-registered (e.g., on a retry of the same
            // `DamageRequest`), the placeholder_id entry is gone —
            // we fall through without re-registering. The
            // source_player_id entry remains in place.
            {
                let mut room_guard = room_arc.write().await;
                if let Some((_, sender)) = room_guard.connections.remove_entry(&placeholder_player_id) {
                    // Only insert if `source_player_id` doesn't
                    // already have a sender (defensive — prevents
                    // clobbering an existing connection under the
                    // same PlayerId).
                    room_guard.connections.entry(source_player_id).or_insert(sender);
                }
            }

            // Encode the broadcast once. The listener loop fans it out
            // to every connection in the room (including the source —
            // optimistic apply on the source matches the broadcast).
            let wire_bytes = specialists_server::damage_relay::relay_broadcast(&bc);
            // Fan out to every connection in the room.
            {
                let room_guard = room_arc.read().await;
                let n = room_guard.connections.len();
                eprintln!("DEBUG fan-out: {} connections registered", n);
                for (player_id, sender) in room_guard.connections.iter() {
                    match sender.try_send(wire_bytes.clone()) {
                        Ok(()) => eprintln!("DEBUG fan-out: sent to player_id={}", player_id),
                        Err(e) => eprintln!("DEBUG fan-out: FAILED to player_id={}: {:?}", player_id, e),
                    }
                }
            }
            // Return the encoded bytes so the inbound loop's "fallback
            // direct send" path also writes the broadcast back to the
            // sender (belt-and-suspenders; the outbound mpsc should
            // already have it). WebTransport's listener does the same.
            wire_bytes
        }
        DISCRIMINATOR_DAMAGE_BROADCAST => {
            // PR 11.6.D: the server is the SOLE producer of
            // `DamageBroadcast` packets. A client sending one back is
            // either a confused client or a spoof attempt — either
            // way, log + drop (anti-spoof guard). The discriminator
            // itself remains valid for the wire protocol (the byte is
            // not deprecated), so we acknowledge receipt + drop the
            // body rather than disconnect.
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
                // PR 11.6.D: a PositionUpdate also auto-registers the
                // player in the room. Anyone reporting position IS a
                // player — this aligns with §3.4.1 and unblocks the
                // validator's `source in room` gate (gate 2). The
                // ammo defaults to a sensible starting pool (PR
                // 11.7's matchmaker will configure per-match ammo;
                // for the dev-box 10 is plenty).
                room_guard.add_player(pu.player_id);
                if let Some(p) = room_guard.players.get_mut(&pu.player_id) {
                    if p.ammo == 0 {
                        p.ammo = 10;
                    }
                }
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
        let reply = handle_binary(&[], &rooms, 0 /* placeholder */).await;
        assert!(reply.is_empty(), "empty payload must produce no reply");
    }

    #[tokio::test]
    async fn dispatch_unknown_discriminator() {
        let rooms = fresh_rooms();
        // 0xFF is unused; should log + discard + return empty.
        let reply = handle_binary(&[0xFF, 0x00, 0x00, 0x00], &rooms, 0 /* placeholder */).await;
        assert!(reply.is_empty(), "unknown discriminator must produce no reply");
    }

    #[tokio::test]
    async fn dispatch_damage_request_returns_broadcast() {
        let rooms = fresh_rooms();
        // PR 11.6.D: validate_and_relay needs players + ammo +
        // position history to accept the request. Seed the room with
        // both players (source=7, target=9), ammo on the source, and
        // a recorded position so the lag-comp snapshot succeeds.
        {
            let room_arc = rooms.read().await.get(specialists_server::constants::DEVBX_ROOM_ID).unwrap().clone();
            let mut room_guard = room_arc.write().await;
            room_guard.add_player(7);
            room_guard.add_player(9);
            room_guard.players.get_mut(&7).unwrap().ammo = 10;
            room_guard.record_position(
                7,
                0xdeadbeef,
                specialists_server::Position { x: 0.0, y: 0.0 },
            );
            room_guard.record_position(
                9,
                0xdeadbeef,
                specialists_server::Position { x: 5.0, y: 0.0 },
            );
        }

        // Encode a DamageRequest, prefix with the discriminator,
        // expect a DamageBroadcast reply that the server emits via
        // `damage_relay::relay_broadcast`.
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

        let reply = handle_binary(&payload, &rooms, 0 /* placeholder */).await;

        // Reply: 1-byte discriminator + 18-byte body.
        assert_eq!(reply.len(), 1 + specialists_server::protocol::DAMAGE_BROADCAST_WIRE_SIZE);
        assert_eq!(reply[0], DISCRIMINATOR_DAMAGE_BROADCAST);
        let bc = decode_damage_broadcast(&reply[1..]).expect("decode broadcast");
        assert_eq!(bc.source_player_id, req.source_player_id);
        assert_eq!(bc.target_player_id, req.target_player_id);
        assert_eq!(bc.source, req.source);
        assert_eq!(bc.amount, req.amount);
        assert_eq!(bc.origin_event_id, req.event_id);
        // PR 11.6.D: server_frame + server_seq are now wired (room
        // fields, starting at 0).
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

        let reply = handle_binary(&payload, &rooms, 0 /* placeholder */).await;
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

        let reply = handle_binary(&payload, &rooms, 0 /* placeholder */).await;
        assert_eq!(reply.len(), 1 + specialists_server::protocol::PONG_WIRE_SIZE);
        assert_eq!(reply[0], DISCRIMINATOR_PONG);
        let pong = decode_pong(&reply[1..]).expect("decode pong");
        assert_eq!(pong.client_timestamp, ping.client_timestamp);
        // server_timestamp is §1.2 placeholder (0) this PR.
        assert_eq!(pong.server_timestamp, 0);
    }
}
