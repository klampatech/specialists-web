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

use std::sync::Mutex;
use std::cell::Cell;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::Instant;

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
    decode_reload_request, encode_pong, DISCRIMINATOR_DAMAGE_BROADCAST,
    DISCRIMINATOR_DAMAGE_REQUEST, DISCRIMINATOR_INPUTS, DISCRIMINATOR_INPUTS_SERVER,
    DISCRIMINATOR_PING, DISCRIMINATOR_PONG, DISCRIMINATOR_POSITION_UPDATE,
    DISCRIMINATOR_RELOAD_REQUEST, DISCRIMINATOR_SNAPSHOT, Pong,
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

/// PR 11.6.D — per-connection state shared between the listener
/// loop and `handle_binary`. Used `Cell` for interior mutability
/// so the connection's `claimed_player_id` can be set on the first
/// `DamageRequest` (which establishes the connection's identity)
/// and checked on subsequent requests (FIX 8 anti-spoof).
#[derive(Debug, Default)]
pub(crate) struct ConnectionState {
    claimed_player_id: Cell<Option<PlayerId>>,
    /// PR 11.7.D2.1 / cleanup-track — the actual id under which this
    /// connection is registered in `room.connections`. Starts as the
    /// placeholder assigned at handshake; updated when the connection
    /// is promoted by a PositionUpdate or DamageRequest. The WS
    /// close-handler uses this to unregister from the room (the
    /// placeholder id may no longer be the key in
    /// `room.connections` after promotion — pre-fix, leaked
    /// connections under the promoted id when the placeholder was
    /// already removed).
    actual_player_id: Cell<PlayerId>,
}

impl ConnectionState {
    pub(crate) fn new(placeholder_player_id: PlayerId) -> Arc<Mutex<Self>> {
        Arc::new(Mutex::new(Self {
            claimed_player_id: Cell::new(None),
            actual_player_id: Cell::new(placeholder_player_id),
        }))
    }
    /// Check the connection's claimed identity against an incoming
    /// `DamageRequest`. Returns `Ok(claimed)` if the connection's
    /// identity is established (first claim or matching claim);
    /// `Err((claimed, requested))` if a different PlayerId is
    /// claimed on a subsequent request.
    fn check(&self, requested: PlayerId) -> Result<PlayerId, (PlayerId, PlayerId)> {
        match self.claimed_player_id.get() {
            None => Ok(requested),
            Some(existing) => {
                if existing == requested {
                    Ok(existing)
                } else {
                    Err((existing, requested))
                }
            }
        }
    }
    /// Stamp the connection's claimed PlayerId after the first
    /// `DamageRequest` succeeds. Idempotent.
    fn stamp(&self, id: PlayerId) {
        self.claimed_player_id.set(Some(id));
    }
    /// PR 11.7.D2.1 / cleanup-track — update the actual id this
    /// connection is registered under in `room.connections`. Called
    /// after a successful promotion (PositionUpdate or DamageRequest).
    /// Used by the WS close-handler to unregister correctly when the
    /// placeholder id no longer matches the connections map key.
    fn stamp_actual(&self, id: PlayerId) {
        self.actual_player_id.set(id);
    }
    /// PR 11.7.D2.1 / cleanup-track — read the current actual id.
    fn get_actual(&self) -> PlayerId {
        self.actual_player_id.get()
    }
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
    //
    // PR 11.7.B hardening: bump outbound mpsc from 64 → 256 slots.
    // PR 11.7.B's 20Hz snapshot stream (SNAPSHOT_RATE_HZ=20,
    // ~70B per snapshot ≈ 1.4 KB/s sustained outbound pressure)
    // shares this mpsc with damage broadcasts. The 64-slot buffer
    // was sized for damage-only traffic and intermittently saturated
    // under snapshot pressure in headless Chromium (the WS outbound
    // stalls under 2-tab playwright load), causing
    // `broadcast_snapshot::try_send` to log `channel full / closed`
    // warns. 256 slots gives ~12.8s of headroom at sustained
    // 1.4 KB/s pressure — enough margin for the WS outbound to
    // drain without dropping snapshots. Does NOT close the §4.4
    // HP-gap race (that's client-side; tracked in §4.4 carry-forward).
    //
    // PR 11.7.D2: switched from `mpsc::channel(512)` to a
    // `ConnectionOutbound` (bounded queue + Notify) so the
    // `broadcast_snapshot` back-pressure can implement drop-oldest.
    // See `server/src/connection_outbound.rs` for the rationale —
    // `mpsc::Sender` has no `try_recv`, so the producer can't drop
    // from the front of an mpsc queue. The custom type gives the
    // producer access to both ends.
    //
    // Capacity: 512 — matches the pre-D2 mpsc capacity. The brief
    // locks this: "DO NOT bump the mpsc capacity for the
    // CF-N1-persistent fix — the new back-pressure mechanism is
    // the right answer." The drop-oldest policy on the producer
    // side means saturation no longer translates to broadcast drops
    // visible to the smoke.
    let outbound = specialists_server::connection_outbound::ConnectionOutbound::new();
    let placeholder_id = next_placeholder_player_id();
    let conn_state = ConnectionState::new(placeholder_id);
    {
        let mut room_guard = room_arc.write().await;
        room_guard.register_connection(placeholder_id, outbound.clone());
    }

    let (mut sink, mut stream) = ws.split();

    // PR 11.6.D: the inbound loop drains the outbound queue
    // between handling inbound messages. Tungstenite's `split` is
    // exclusive, so we can't have a separate outbound task. The
    // outbound queue acts as a write-side buffer: the dispatcher
    // pushes encoded bytes (broadcasts + replies) onto it via
    // `Room.connections`, and this loop pops + writes them.
    loop {
        tokio::select! {
            // Outbound: drain whatever's been queued.
            maybe_bytes = outbound.recv() => {
                match maybe_bytes {
                    Some(bytes) => {
                        if let Err(e) = sink.send(Message::Binary(bytes.into())).await {
                            warn!(%peer, "WS outbound send failed: {e:?}");
                            break;
                        }
                    }
                    None => {
                        // Outbound closed (the connection's sender
                        // was removed from Room.connections via
                        // `close()`). Nothing more to write; loop
                        // continues to drain inbound.
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
                        let reply = handle_binary(&bytes, &rooms, placeholder_id, conn_state.clone()).await;
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

    // Cleanup: close + unregister the connection from the room.
    // PR 11.7.D2.1 — use the connection's actual id (may differ from
    // the placeholder if the connection was promoted via PositionUpdate
    // or DamageRequest). Pre-fix the unregister targeted the
    // placeholder, which silently no-op'd for promoted connections
    // and leaked their slot in `room.connections` until the room was
    // dropped (causing subsequent snapshot broadcasts to fan out to a
    // dead sender and stall the outbound stream).
    {
        let actual = conn_state.lock().unwrap().get_actual();
        let mut room_guard = room_arc.write().await;
        room_guard.unregister_connection(actual);
    }
    outbound.close();
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
    //
    // PR 11.7.B hardening: matches the WebSocket listener's
    // 256-slot outbound mpsc (above). The size MUST be identical
    // across both listeners — Room.connections stores one Sender
    // per transport and the dispatcher pushes to all of them, so
    // a size mismatch would silently starve whichever transport
    // got the smaller queue.
    //
    // PR 11.7.D2: switched from `mpsc::channel(512)` to a
    // `ConnectionOutbound` (bounded queue + Notify) so
    // `broadcast_snapshot` can implement drop-oldest back-pressure.
    // See the WS listener comment above + the
    // `server/src/connection_outbound.rs` module doc for the
    // rationale. Capacity matches the WS listener's capacity (512)
    // — the brief locks this as identical across both listeners.
    let outbound = specialists_server::connection_outbound::ConnectionOutbound::new();
    let placeholder_id = next_placeholder_player_id();
    let conn_state = ConnectionState::new(placeholder_id);
    {
        let mut room_guard = room_arc.write().await;
        room_guard.register_connection(placeholder_id, outbound.clone());
    }

    loop {
        tokio::select! {
            maybe_bytes = outbound.recv() => {
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
                        // Outbound closed (connection unregister). Just
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
                let reply = handle_binary(payload, &rooms, placeholder_id, conn_state.clone()).await;
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
                let _ = handle_binary(payload, &rooms, placeholder_id, conn_state.clone()).await;
                // No direct reply on uni streams; broadcasts go via
                // the outbound datagram path.
            }
            datagram = connection.receive_datagram() => {
                let dgram = datagram?;
                let payload = dgram.payload();
                let _ = handle_binary(payload.as_ref(), &rooms, placeholder_id, conn_state.clone()).await;
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
    connection_state: Arc<Mutex<ConnectionState>>,
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
            // FIX 8: anti-spoof — the connection's REAL PlayerId is
            // the value stashed in `connection_state`.claimed_player_id
            // by the first successful DamageRequest on this
            // connection. Subsequent requests MUST claim the same
            // PlayerId or the validator rejects (the inner gate 2).
            // Before the first successful request, we trust the
            // request's claimed source_player_id as the connection's
            // identity (the validator stamps it on success).
            // FIX 8: extract the connection's claimed identity
            // BEFORE the await (the borrow is !Send — we drop it
            // before touching the room registry).
            let claimed_player_id = {
                let conn = connection_state.lock().unwrap();
                match conn.check(req.source_player_id) {
                    Ok(id) => id,
                    Err((claimed, requested)) => {
                        warn!(
                            claimed_player_id = claimed,
                            requested_player_id = requested,
                            "damageRequest: rejected — connection identity mismatch",
                        );
                        return vec![];
                    }
                }
            };
            let room_arc = ensure_room(rooms, DEVBX_ROOM_ID).await;
            let now = Instant::now();
            // FIX 1: per-connection RTT proxy. Look up the source
            // Player's `last_ping_received_at`; compute the wall-clock
            // gap since then, double it (the pong hasn't arrived yet
            // — the next ping from the client will have carried the
            // round-trip — but until then, the gap is our best
            // estimate of the half-RTT). Add a 16ms floor (the
            // server tick) so we never advance backwards in time.
            let client_rtt_ms = {
                let room_guard = room_arc.read().await;
                if let Some(player) = room_guard.players.get(&claimed_player_id) {
                    if let Some(last_ping) = player.last_ping_received_at {
                        let gap = now.duration_since(last_ping);
                        // 2x the half-trip approximates the full
                        // round-trip. The gap is capped at MAX_RTT_MS
                        // (500ms) so a stale ping doesn't cause
                        // pathological rewind into the distant past.
                        let rtt_ms = (gap.as_millis() as u32).saturating_mul(2);
                        rtt_ms.min(specialists_server::damage_relay::MAX_RTT_MS)
                    } else {
                        0
                    }
                } else {
                    0
                }
            };
            // Run the validator under a write lock. The lock is held
            // for the duration of validate_and_relay (no .await
            // inside), so the lock is released synchronously.
            let bc_opt = {
                let mut room_guard = room_arc.write().await;
                specialists_server::damage_relay::validate_and_relay(
                    &req,
                    claimed_player_id,
                    &mut room_guard,
                    client_rtt_ms,
                    now,
                )
            };
            let Some(bc) = bc_opt else {
                // FIX 4: validator rejected. Emit a `DamageReject` back
                // to the SOURCE tab only (NOT broadcast) so the
                // source can revert its optimistic apply. The reject
                // reason is 0 (fire-rate) — the most common cause in
                // production. Granular reasons can be wired by
                // changing `validate_and_relay` to return an enum;
                // PR 11.6.D keeps the simpler Option-returning API.
                debug!(
                    source = req.source_player_id,
                    target = req.target_player_id,
                    event_id = req.event_id,
                    "damageRequest rejected by validate_and_relay",
                );
                // For the reject, send it to the source's
                // connection. We need to find the sender for
                // `claimed_player_id` (which may be the
                // placeholder_id if the connection hasn't been
                // promoted yet).
                let reject_bytes = specialists_server::damage_relay::relay_reject(
                    req.event_id,
                    specialists_server::protocol::REJECT_REASON_FIRE_RATE,
                );
                let room_guard = room_arc.read().await;
                let outbound = room_guard.connections
                    .get(&claimed_player_id)
                    .or_else(|| room_guard.connections.get(&placeholder_player_id));
                if let Some(outbound) = outbound {
                    let _ = outbound.try_send(reject_bytes).await;
                }
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
            // FIX 8: also stamp the connection's claimed identity
            // (if not already set). The next request from this
            // connection will be checked against this identity.
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
                    room_guard.connections.entry(claimed_player_id).or_insert(sender);
                }
                connection_state.lock().unwrap().stamp_actual(claimed_player_id);
            }
            // FIX 8: stamp the connection's claimed identity so
            // subsequent requests from this connection can be
            // checked against it. Idempotent — `check` already
            // matched, so this is just a record.
            connection_state.lock().unwrap().stamp(claimed_player_id);

            // Encode the broadcast once. The listener loop fans it out
            // to every connection in the room (including the source —
            // optimistic apply on the source matches the broadcast).
            let wire_bytes = specialists_server::damage_relay::relay_broadcast(&bc);
            // Fan out to every connection in the room. PR 11.7.D2:
            // uses the `ConnectionOutbound::try_send` drop-oldest path
            // (same as broadcast_snapshot) so damage broadcasts
            // receive the same back-pressure treatment as snapshots.
            // Pre-D2, this was the same "channel full / closed" warn
            // surface that CF-N1 was tracking; drop-oldest closes
            // the underlying saturation.
            {
                let room_guard = room_arc.read().await;
                let n_conns = room_guard.connections.len();
                for (player_id, outbound) in room_guard.connections.iter() {
                    if let Err(()) = outbound.try_send(wire_bytes.clone()).await {
                        warn!(
                            target_player_id = *player_id,
                            "damageBroadcast fan-out: outbound closed (connection dying)",
                        );
                        continue;
                    }
                    debug!(
                        target_player_id = *player_id,
                        n_conns = n_conns,
                        "damageBroadcast enqueued",
                    );
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
            // PR 11.7.B / §3.6 — PositionUpdate is DEPRECATED. The
            // server-side `PositionHistory` is now fed by Rapier's
            // physics tick (64Hz) — `Room.physics` writes to it
            // inside `physics_tick_loop`. Per-player PositionUpdate
            // packets from the client are still accepted for
            // backward compatibility (the existing 5191 smoke
            // depends on them for HP-convergence lag-comp math).
            // PR 11.7.D removes this handler entirely.
            //
            // The deprecation is the gradual cutover plan from
            // §3.6 — clients keep sending their old per-player
            // PositionUpdate packets (Havok WASM still drives
            // their pose prediction); the server logs a warn so
            // the cutover timeline is observable in dev-box logs.
            warn!(
                "PositionUpdate (0x03) is deprecated, will be removed in 11.7.D;                  using client-driven position for PositionHistory"
            );
            let Some(pu) = decode_position_update(&payload[1..]) else {
                warn!("positionUpdate: decoder rejected malformed payload");
                return vec![];
            };
            // Push onto the room's PositionHistory. §1.2 seam: WRITE-ONLY.
            let room_arc = ensure_room(rooms, DEVBX_ROOM_ID).await;
            {
                let mut room_guard = room_arc.write().await;
                // PR 11.7.D2.1 / FIX — promote the connection from its
                // placeholder id to the claimed `pu.player_id` on the
                // FIRST PositionUpdate, mirroring the DamageRequest
                // promotion path. Pre-fix: connections stayed under
                // their placeholder ids (1000+) until the first
                // DamageRequest. The snapshot iterates `room.connections`,
                // so the wire-form player ids were 1009/1010 instead of
                // the client's claim — both the per-tab interpolator
                // (which buffers by player id) and the validator's Gate3
                // (`target NOT IN room.players`) failed in different ways
                // — Gate3 was the visible break (damage broadcasts never
                // reached Tab B's HP). The smoke's manual
                // `sendPositionUpdate({playerId: 2})` workaround
                // (smoke lines 372-394) side-stepped this only because
                // it ALSO promoted via the subsequent DamageRequest.
                //
                // **Idempotency**: if a connection with `pu.player_id`
                // already exists (the integration test's "seed" pattern —
                // a throwaway connection sends PositionUpdate first to
                // register the player, then the real connection opens
                // and sends DamageRequest claiming the same id), we MUST
                // NOT clobber the existing sender. The existing sender
                // is the seed's; if we replace it, the seed's later
                // snapshot/damage broadcasts go to the test's real
                // connection (which then times out waiting). Promotion
                // only happens if the target slot is empty.
                //
                // Anti-spoof: the placeholder has not yet sent a
                // successful DamageRequest (placeholder id != claimed id
                // means Gate2 anti-spoof would reject). We promote
                // BEFORE add_player so the snapshot's player id matches
                // the client's claim — but only if the slot is empty.
                if placeholder_player_id != pu.player_id
                    && !room_guard.connections.contains_key(&pu.player_id)
                {
                    if let Some((_, sender)) = room_guard.connections.remove_entry(&placeholder_player_id) {
                        room_guard.connections.insert(pu.player_id, sender);
                        connection_state.lock().unwrap().stamp_actual(pu.player_id);
                    }
                }
                // PR 11.6.D: a PositionUpdate also auto-registers the
                // player in the room. Anyone reporting position IS a
                // player — this aligns with §3.4.1 and unblocks the
                // validator's `source in room` gate (gate 2). The
                // ammo defaults to a sensible starting pool — PR 11.7.E
                // locked the dual-pistol magazine to `PLAYER_MAX_AMMO`
                // (6 rounds). The 10-round default from pre-PR-11.7.E
                // matched an earlier prototype; the 5191 reload smoke
                // asserts the snapshot's ammo reads `PLAYER_MAX_AMMO`
                // after a fresh reload, so the default must match.
                room_guard.add_player(pu.player_id);
                if let Some(p) = room_guard.players.get_mut(&pu.player_id) {
                    if p.ammo == 0 {
                        p.ammo = specialists_server::constants::PLAYER_MAX_AMMO;
                    }
                }
                // PR 11.7.D2.1 / FIX — also register a physics body
                // for this player. Pre-fix, PositionUpdate only added
                // the player to `room.players` (HP/ammo/history) but
                // never created a Rapier RigidBody. The snapshot's
                // `room.physics.position(player_id)` then returned
                // `Position::ZERO` for every player — the wire-form
                // positions were all (0, 0), so Tab B's interpolator
                // buffered Player 1 at the origin and Tab B's remote
                // rig never reflected Tab A's walk. By creating the
                // physics body once and updating its translation
                // every PositionUpdate, the snapshot reflects the
                // player's actual reported position.
                room_guard.physics.add_player(
                    pu.player_id,
                    Position { x: pu.position_x, y: pu.position_y },
                );
                // PR 11.7.D2.1 / FIX — snap the kinematic body to the
                // client's reported translation on every PositionUpdate.
                // Pre-fix, the body was only created on the first
                // PositionUpdate and never moved thereafter (the
                // server's `physics.step` simulates movement from
                // inputs, but the client Havok is authoritative after
                // the substrate retirement — so the server's
                // simulation was drifting from the client's truth and
                // the snapshot's `physics.position(id)` returned the
                // stale first-PositionUpdate position forever).
                room_guard.physics.set_position(
                    pu.player_id,
                    Position { x: pu.position_x, y: pu.position_y },
                );
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
            // FIX 1: stamp the connection's last_ping_received_at on
            // the connection's claimed PlayerId. The validator's
            // lag-comp rewind uses this to compute RTT for the
            // "favor the shooter" behavior. If the connection hasn't
            // established a claimed identity yet (no successful
            // DamageRequest), we don't have a PlayerId to attribute
            // the ping to — the timing is recorded against the
            // placeholder, but the placeholder doesn't have a slot
            // in `room.players`, so the lag-comp falls back to
            // RTT=0 (no rewind). The first DamageRequest will
            // establish the identity and the next ping will be
            // recorded properly.
            //
            // Extract the claimed PlayerId BEFORE the await (the
            // borrow is !Send).
            let claimed_player_id_for_ping = {
                let conn = connection_state.lock().unwrap();
                conn.claimed_player_id.get()
            };
            if let Some(player_id) = claimed_player_id_for_ping {
                let room_arc = ensure_room(rooms, DEVBX_ROOM_ID).await;
                let mut room_guard = room_arc.write().await;
                if let Some(player) = room_guard.players.get_mut(&player_id) {
                    player.last_ping_received_at = Some(Instant::now());
                }
            }
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
            //
            // PR 11.7.D2 / §1.2: the wire format now carries a
            // `last_inputs_seq` trailer (one u32 BE) for replay
            // protection. Stale inputs (older `last_inputs_seq` than
            // the last seen seq for the source) are dropped.
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
                // PR 11.7.D2 / §1.2: replay protection on the
                // inputs_seq trailer. Reject if the incoming seq is
                // older than the last seen seq for this source.
                let prev_seq = room_guard
                    .last_inputs_seq_per_source
                    .get(&player_id)
                    .copied()
                    .unwrap_or(0);
                if inputs.last_inputs_seq < prev_seq {
                    warn!(
                        player_id,
                        last_inputs_seq = inputs.last_inputs_seq,
                        prev_seq,
                        "inputsServer: rejected — stale last_inputs_seq (replay)",
                    );
                    return vec![];
                }
                // Saturating stamp — same shape as the
                // last_event_id_for_source gate above. Never wrap.
                let stamped = std::cmp::max(inputs.last_inputs_seq, prev_seq);
                room_guard
                    .last_inputs_seq_per_source
                    .insert(player_id, stamped);
                room_guard.push_input(player_id, frame, input_bytes);
            }
            debug!(
                player_id,
                frame,
                last_inputs_seq = inputs.last_inputs_seq,
                "inputsServer buffered onto Room.inputs_buffer"
            );
            vec![]
        }
        DISCRIMINATOR_SNAPSHOT => {
            // PR 11.7.B / §1.3 + §3.5 — clients do NOT send
            // Snapshots. Snapshot is a server-originated broadcast
            // only. Receiving one from a client is either a
            // confused client (testing the wire) or a spoof
            // attempt; either way log + drop (same anti-spoof
            // pattern as DamageBroadcast). The discriminator
            // itself is registered so the inbound arm rejects
            // cleanly with the "unknown inbound discriminator"
            // warn rather than the catch-all `other` arm.
            warn!("client sent Snapshot — discarded (server-only wire type)");
            vec![]
        }
        DISCRIMINATOR_RELOAD_REQUEST => {
            // PR 11.7.E / §3.5 — ReloadRequest (client → server).
            // Decode the body, validate via `validate_and_relay_reload`
            // (8 gates paralleling `validate_and_relay`), and on
            // success mutate `room.players[source].ammo =
            // PLAYER_MAX_AMMO`. The next 20Hz Snapshot broadcast
            // (discriminator 0x07) carries the new ammo value to
            // every connected tab — no private ack packet (PR
            // 11.7.E locked decision #4). The validate function
            // also stamps `last_reload_at` for the rate-limit gate
            // (1/sec per player) and the `last_event_id_for_source`
            // monotonicity map for replay protection.
            let Some(req) = decode_reload_request(&payload[1..]) else {
                warn!("reloadRequest: decoder rejected malformed payload");
                return vec![];
            };
            // Anti-spoof: the connection's REAL PlayerId is the value
            // stashed in `connection_state.claimed_player_id` by the
            // first successful DamageRequest on this connection. If
            // the request's `source_player_id` doesn't match, the
            // validator rejects (the inner gate 2). Pre-first-DR, we
            // trust the request's claimed source as the connection's
            // identity (mirrors the DamageRequest promotion path).
            let claimed_player_id = {
                let conn = connection_state.lock().unwrap();
                conn.claimed_player_id.get()
            };
            let connection_player_id = match claimed_player_id {
                Some(id) => id,
                None => req.source_player_id,
            };
            let room_arc = ensure_room(rooms, DEVBX_ROOM_ID).await;
            let mut room_guard = room_arc.write().await;
            // Ensure the source is registered (mirrors the
            // PositionUpdate auto-register path — a tab that hasn't
            // sent any other packet yet should still be able to
            // request a reload). The validator's gate 1 will reject
            // if the player isn't in the room, so we add them here
            // to match the DamageRequest path.
            room_guard.add_player(connection_player_id);
            let now = Instant::now();
            // The validate function returns `Some(())` on success
            // (the reload happened; the snapshot will fan out the
            // new ammo) or `None` on rejection (silently — the
            // validator logs the reason via `warn!`). We don't need
            // the result; the side-effect is the ammo mutation +
            // last_reload_at stamp.
            specialists_server::damage_relay::validate_and_relay_reload(
                &req,
                connection_player_id,
                &mut *room_guard,
                now,
            );
            debug!(
                source = req.source_player_id,
                event_id = req.event_id,
                "reloadRequest processed"
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

/// PR 11.7.B / §3.4 + §3.10.1 — fan out a `Snapshot` (already
/// encoded by `protocol::encode_snapshot` with the discriminator
/// PREPENDED — the caller is the `snapshot_generator_loop` task
/// in `main.rs`) to every connection in the room.
///
/// Mirrors the `damage_relay::relay_broadcast` fan-out pattern
/// (each connection owns a `ConnectionOutbound` registered in
/// `Room.connections`; we clone the encoded bytes and push onto
/// every outbound). The outbound queue is drained by the per-
/// connection listener loops (both WebSocket and WebTransport),
/// which write to the transport stream.
///
/// **PR 11.7.D2 back-pressure (CF-N1-persistent closer)**: the
/// outbound queue's `try_send` is drop-oldest by construction
/// (see `server/src/connection_outbound.rs::ConnectionOutbound::try_send`).
/// When the queue is full, the OLDEST queued snapshot is dropped
/// to make room. Older snapshots are useless once newer ones
/// arrive — the consumer (interpolator) only needs the latest
/// within its 100ms interpolation window. The drop-oldest policy
/// matches the consumer's actual data needs.
///
/// This is the right direction (NOT another capacity bump). Per
/// the brief's gotcha #5: "per-connection mpsc capacity is 512
/// (was 256, was 64). Both WS + WT listeners MUST stay identical.
/// **DO NOT bump the mpsc capacity** for the CF-N1-persistent fix
/// — the new back-pressure mechanism is the right answer."
pub async fn broadcast_snapshot(
    room: Arc<RwLock<Room>>,
    snap_bytes: Vec<u8>,
) {
    // Read-lock the room to enumerate senders; the snapshot body
    // is read-only on the room.
    let room_guard = room.read().await;
    let n_conns = room_guard.connections.len();
    for (player_id, outbound) in room_guard.connections.iter() {
        // The drop-oldest semantics live inside
        // ConnectionOutbound::try_send — we just call it. A `Ok(())`
        // means either it pushed normally (queue not full) OR it
        // dropped the oldest to make room and pushed. There's no
        // separate "full" return — saturation is the expected case
        // under sustained load and is handled transparently.
        if let Err(()) = outbound.try_send(snap_bytes.clone()).await {
            // Closed — connection was unregistered but the room
            // entry hasn't been cleaned up yet. The listener loop
            // will see `recv() == None` and exit; this snapshot
            // was lost (acceptable — the connection is dying).
            warn!(
                target_player_id = *player_id,
                "snapshot broadcast: outbound closed (connection dying)",
            );
            continue;
        }
        debug!(
            target_player_id = *player_id,
            n_conns = n_conns,
            "snapshot enqueued",
        );
    }
}

// -- Unit tests for the dispatcher ---------------------------------------
//
// The dispatcher is `async` (it needs to acquire room locks). Each
// test builds a fresh `RoomRegistry` with the default DEVBX room so
// the `ensure_room` call inside the dispatcher is a no-op.

#[cfg(test)]
mod tests {
    use super::*;
    use specialists_server::connection_outbound::ConnectionOutbound;
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
        let reply = handle_binary(&[], &rooms, 0, ConnectionState::new(0) /* placeholder */).await;
        assert!(reply.is_empty(), "empty payload must produce no reply");
    }

    #[tokio::test]
    async fn dispatch_unknown_discriminator() {
        let rooms = fresh_rooms();
        // 0xFF is unused; should log + discard + return empty.
        let reply = handle_binary(&[0xFF, 0x00, 0x00, 0x00], &rooms, 0, ConnectionState::new(0) /* placeholder */).await;
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

        let reply = handle_binary(&payload, &rooms, 0, ConnectionState::new(0) /* placeholder */).await;

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

        let reply = handle_binary(&payload, &rooms, 0, ConnectionState::new(0) /* placeholder */).await;
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
    async fn dispatch_position_update_promotes_connection_from_placeholder() {
        // PR 11.7.D2.1 / regression test — the first PositionUpdate
        // from a connection must promote it from its placeholder id
        // to the claimed `player_id` (mirroring the DamageRequest
        // promotion path). Pre-fix: connections stayed under
        // placeholder ids (1000+) until the first DamageRequest. The
        // snapshot iterates `room.connections`, so wire-form player
        // ids were 1000+ instead of the client's claim — both the
        // interpolator's player-id-keyed buffer and Gate3's
        // connection is re-registered under its real PlayerId.
        let rooms = fresh_rooms();
        // Simulate the handshake: register the connection under
        // placeholder 1009.
        {
            let room_arc = rooms.read().await.get(DEVBX_ROOM_ID).unwrap().clone();
            let mut room_guard = room_arc.write().await;
            room_guard.register_connection(1009, ConnectionOutbound::new());
        }
        // First PositionUpdate claims player_id=2 (e.g., a tab with
        // `?localId=2`). Pre-fix this would leave the connection
        // under placeholder 1009 and `room.players` would still lack
        // entry 2 (the snapshot would carry [1009] only).
        let pu = PositionUpdate {
            server_frame: 100,
            player_id: 2,
            position_x: 5.0,
            position_y: 0.0,
        };
        let mut payload = vec![DISCRIMINATOR_POSITION_UPDATE];
        payload.extend(encode_position_update(&pu));
        let reply = handle_binary(&payload, &rooms, 1009, ConnectionState::new(1009)).await;
        assert!(reply.is_empty(), "positionUpdate must not produce a reply");
        // Verify the connection was promoted: `room.connections`
        // now has key `2`, not `1009`.
        let room_arc = rooms.read().await.get(DEVBX_ROOM_ID).unwrap().clone();
        let room_guard = room_arc.read().await;
        assert!(
            room_guard.connections.contains_key(&2),
            "connection should be re-registered under claimed player_id=2 after first PositionUpdate, but was still under placeholder: {:?}",
            room_guard.connections.keys().collect::<Vec<_>>()
        );
        assert!(
            !room_guard.connections.contains_key(&1009),
            "placeholder 1009 should have been removed during promotion"
        );
        assert!(
            room_guard.players.contains_key(&2),
            "room.players should include player_id=2 after the first PositionUpdate"
        );
    }

    #[tokio::test]
    async fn dispatch_ping_returns_pong() {
        let rooms = fresh_rooms();
        let mut payload = vec![DISCRIMINATOR_PING];
        let ping = specialists_server::protocol::Ping { client_timestamp: 0xfeedface };
        payload.extend(encode_ping(&ping));

        let reply = handle_binary(&payload, &rooms, 0, ConnectionState::new(0) /* placeholder */).await;
        assert_eq!(reply.len(), 1 + specialists_server::protocol::PONG_WIRE_SIZE);
        assert_eq!(reply[0], DISCRIMINATOR_PONG);
        let pong = decode_pong(&reply[1..]).expect("decode pong");
        assert_eq!(pong.client_timestamp, ping.client_timestamp);
        // server_timestamp is §1.2 placeholder (0) this PR.
        assert_eq!(pong.server_timestamp, 0);
    }
}
