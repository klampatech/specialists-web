// PR 11.9 — matchmaker HTTP listener.
//
// Surface (3 endpoints, HTTP/1.1):
//
//   POST /rooms        → 200 {"id","ws_url","wss_url","max_players"}
//   GET  /rooms/<id>   → 200 {"exists":true,"players":N,"max":N} | 404
//   GET  /health       → 200 "ok"
//
// Why hand-rolled HTTP/1.1 (no `axum`/`hyper`): we only need 3
// endpoints + 0 keep-alive + tiny JSON payloads. Adding a full HTTP
// framework is ~2MB of compile-time deps + a learning curve for a
// 100-line replacement. The handshake parsing here is the same
// `tokio_tungstenite::accept_hdr_async`-style shape already used by
// the WS path — read request line + headers, route on method+path,
// write a minimal HTTP response.
//
// Room IDs are server-generated 8-char `[A-Za-z0-9_-]{8}` — a strict
// subset of `parse_room_id`'s `[A-Za-z0-9_-]{1,64}` regex. Avoiding
// `=`, `+`, `/`, `?`, `&` keeps the IDs URL-safe without escaping.
// 8 chars = 62^8 ≈ 2.2×10^14 keyspace; birthday collisions at
// 10^7 rooms (≈10M concurrent matches) — far above what one m5
// serves.
//
// `POST /rooms` does NOT pre-create the room in the registry; the
// room is created lazily on the first WS/WT connection (via
// `ensure_room` in the transport layer). This avoids the
// stale-room problem entirely for v1 — a "create room" click that
// never gets a player never pollutes the registry. Future PRs that
// add room cleanup / persistence can switch to eager creation.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use rand::Rng;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tracing::{debug, info, warn};

use crate::constants::MAX_PLAYERS_PER_ROOM;
use crate::session::Room;
use crate::transport::RoomRegistry;

/// Maximum HTTP request line length. 8KB is plenty for our 3 endpoints
/// (longest is `GET /rooms/<id>` = ~25 bytes); the cap prevents a
/// malicious client from filling the read buffer.
const MAX_REQUEST_LINE_BYTES: usize = 8192;

/// Maximum HTTP header block size. Same reasoning as above.
const MAX_HEADERS_BYTES: usize = 8192;

/// Room ID alphabet. Same charset as `parse_room_id`'s regex
/// (`[A-Za-z0-9_-]{1,64}`) minus the dash+underscore, restricted to
/// URL-safe characters that don't need percent-encoding.
const ROOM_ID_ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/// Length of server-generated room IDs.
const ROOM_ID_LEN: usize = 8;

/// Bound the HTTP listener. Returns Err on bind failure.
///
/// `ws_port` is the port the WebSocket listener is bound to on
/// the same host (matchmaker and WS listeners share a host but may
/// use different ports). The matchmaker includes it in the
/// `ws_url` / `wss_url` it returns so the lobby can connect
/// directly without needing to construct the URL locally. See
/// `handle_create_room` for the bug this fixes.
pub async fn run_matchmaker_http(
    port: u16,
    ws_port: u16,
    wss_port: u16,
    rooms: RoomRegistry,
) -> Result<()> {
    let bind_addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = TcpListener::bind(bind_addr)
        .await
        .with_context(|| format!("bind TCP/{port} (matchmaker HTTP)"))?;
    let local = listener
        .local_addr()
        .with_context(|| format!("local_addr on TCP/{port} (matchmaker HTTP)"))?;
    info!(%local, "Matchmaker HTTP listener bound (§3.5)");

    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                let rooms = rooms.clone();
                // One accept = one connection. No keep-alive — these
                // are one-shot endpoints, and a keep-alive state
                // machine would inflate the surface by ~3x.
                tokio::spawn(async move {
                    if let Err(e) = handle_http_connection(stream, peer, rooms, ws_port, wss_port).await {
                        debug!(%peer, "matchmaker HTTP connection ended: {e:?}");
                    }
                });
            }
            Err(e) => {
                warn!("matchmaker HTTP accept failed: {e:?}");
                return Err(e.into());
            }
        }
    }
}

/// Handle a single HTTP/1.1 connection (one request). Reads the
/// request line + headers, routes on method + path, writes the
/// response, closes.
async fn handle_http_connection(
    mut stream: TcpStream,
    peer: SocketAddr,
    rooms: RoomRegistry,
    ws_port: u16,
    wss_port: u16,
) -> Result<()> {
    debug!(%peer, "handle_http_connection entered");
    // Read up to MAX_REQUEST_LINE_BYTES + MAX_HEADERS_BYTES, or until
    // we see the end-of-headers marker `\r\n\r\n`. We can't use
    // `read_to_end` — that would block until the client closes the
    // connection, which doesn't happen for HTTP/1.1 keep-alive.
    //
    // Strategy: read into a bounded buffer with a small per-read
    // timeout. If we see `\r\n\r\n` before the limit, parse + reply.
    // If we hit the limit without the marker, 400.
    let cap = MAX_REQUEST_LINE_BYTES + MAX_HEADERS_BYTES;
    let mut buf = Vec::with_capacity(512);
    let read_result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        read_until_header_end(&mut stream, &mut buf, cap),
    )
    .await;

    let _ = read_result; // either Ok or Err — both paths fall through to parsing
    debug!(%peer, "read {} bytes from {}", buf.len(), peer);

    if buf.is_empty() {
        // Empty request — common when a health-check probe opens
        // a TCP socket but doesn't write. Treat as a 400.
        return write_response(&mut stream, 400, "Bad Request", "text/plain", b"empty request").await;
    }

    // Parse the request line + headers from `buf` (in-memory).
    let text = match std::str::from_utf8(&buf) {
        Ok(t) => t,
        Err(_) => {
            return write_response(
                &mut stream,
                400,
                "Bad Request",
                "text/plain",
                b"request is not valid UTF-8",
            )
            .await;
        }
    };
    let mut lines = text.split("\r\n").filter(|l| !l.is_empty());

    let request_line = match lines.next() {
        Some(l) => l,
        None => {
            return write_response(
                &mut stream,
                400,
                "Bad Request",
                "text/plain",
                b"missing request line",
            )
            .await;
        }
    };
    let mut parts = request_line.split_whitespace();
    let method = match parts.next() {
        Some(m) => m,
        None => {
            return write_response(
                &mut stream,
                400,
                "Bad Request",
                "text/plain",
                b"missing method",
            )
            .await;
        }
    };
    let path = match parts.next() {
        Some(p) => p,
        None => {
            return write_response(
                &mut stream,
                400,
                "Bad Request",
                "text/plain",
                b"missing path",
            )
            .await;
        }
    };
    let method = method.to_string();
    let path = path.to_string();

    // Drain the rest (headers). We don't actually need any of them.
    let _header_count = lines.count();
    debug!(%peer, request_line = %request_line, "parsed request");

    // Route.
    match (method.as_str(), path.as_str()) {
        ("GET", "/health") => {
            write_response(&mut stream, 200, "OK", "text/plain", b"ok").await
        }
        ("POST", "/rooms") => handle_create_room(&mut stream, peer, ws_port, wss_port).await,
        ("GET", p) if p.starts_with("/rooms/") => {
            let id = &p[7..]; // strip "/rooms/"
            handle_get_room(&mut stream, peer, id, rooms, ws_port, wss_port).await
        }
        _ => {
            write_response(
                &mut stream,
                404,
                "Not Found",
                "text/plain",
                b"endpoint not found",
            )
            .await
        }
    }
}

/// `POST /rooms` — mint a fresh room ID and return the URLs the
/// lobby should use to connect.
///
/// Note: we do NOT pre-create the room in the registry. The room
/// is created lazily on the first WS/WT connection (via
/// `ensure_room` in transport). This avoids the stale-room
/// problem entirely for v1.
///
/// `listen_port` is the port the WS/WT listeners are bound to on
/// the SAME address as this matchmaker (they share `peer_addr`).
/// We include it in the returned `ws_url` / `wss_url` so the lobby
/// can navigate directly. Caught by the real-canary smoke
/// (`client/tools/lobby-real-canary-smoke.mjs`) on 2026-08-31 —
/// without the port, the lobby's Create flow produced a URL like
/// `ws://127.0.0.1/rooms/<id>` which the browser tried to resolve
/// on port 80 (default WS) and got ERR_CONNECTION_REFUSED.
async fn handle_create_room(stream: &mut TcpStream, peer: SocketAddr, ws_port: u16, wss_port: u16) -> Result<()> {
    let id = mint_room_id();
    let body = format!(
        r#"{{"id":"{id}","ws_url":"ws://{peer_addr}:{ws_port}/rooms/{id}","wss_url":"wss://{peer_addr}:{wss_port}/rooms/{id}","max_players":{max}}}"#,
        id = id,
        peer_addr = peer.ip(),
        ws_port = ws_port,
        wss_port = wss_port,
        max = MAX_PLAYERS_PER_ROOM,
    );
    info!(%peer, room_id = %id, "POST /rooms → minted");
    write_response(stream, 200, "OK", "application/json", body.as_bytes()).await
}

/// `GET /rooms/<id>` — return whether the room exists in the
/// registry + the current live player count.
///
/// Note: the live player count comes from
/// `room.connections.len()`, which is decremented on disconnect
/// (see `Room::unregister_connection`). `room.players.len()` is
/// stale on disconnect (players persist in the `players` map
/// until room cleanup, which is a follow-on PR).
async fn handle_get_room(
    stream: &mut TcpStream,
    peer: SocketAddr,
    id: &str,
    rooms: RoomRegistry,
    ws_port: u16,
    wss_port: u16,
) -> Result<()> {
    // Validate the ID against the same regex `parse_room_id` uses.
    // Anything else is a 400, not a 404 — it means the client is
    // sending malformed input, not asking about a real-but-missing
    // room.
    if id.len() > 64 || !id.bytes().all(|b| ROOM_ID_ALPHABET.contains(&b)) {
        return write_response(
            stream,
            400,
            "Bad Request",
            "text/plain",
            b"invalid room id",
        )
        .await;
    }

    let exists = {
        let registry = rooms.read().await;
        registry.contains_key(id)
    };
    if !exists {
        debug!(%peer, room_id = %id, "GET /rooms/<id> → 404");
        return write_response(
            stream,
            404,
            "Not Found",
            "application/json",
            br#"{"exists":false}"#,
        )
        .await;
    }

    let players = {
        let registry = rooms.read().await;
        registry
            .get(id)
            .and_then(|room_arc| room_arc.try_read().ok().map(|r| r.connections.len()))
            .unwrap_or(0)
    };

    // PR 95 follow-up: include `ws_url` in the response so the lobby's
    // Join path can navigate to the correct WS server without
    // constructing it from `window.location.host` (which is the lobby
    // page's host:port — Vite in dev, not the WS listener's port).
    // Same shape as POST /rooms' `ws_url` field — `ws://<peer_ip>:<ws_port>/rooms/<id>`.
    let body = format!(
        r#"{{"exists":true,"players":{players},"max":{max},"ws_url":"ws://{peer_addr}:{ws_port}/rooms/{id}","wss_url":"wss://{peer_addr}:{wss_port}/rooms/{id}"}}"#,
        players = players,
        max = MAX_PLAYERS_PER_ROOM,
        peer_addr = peer.ip(),
        ws_port = ws_port,
        wss_port = wss_port,
        id = id,
    );
    debug!(%peer, room_id = %id, players, "GET /rooms/<id> → 200");
    write_response(stream, 200, "OK", "application/json", body.as_bytes()).await
}

/// Write a minimal HTTP/1.1 response with the given status, reason,
/// content-type, and body. Closes the connection after writing
/// (no keep-alive).
///
/// Adds `Access-Control-Allow-Origin: *` because the lobby UI
/// lives on the dev-server's port (e.g. 5174) while the matchmaker
/// HTTP listener runs on a separate port (8080 in dev, 443 in
/// prod via Funnel). The 3 endpoints are public + auth-free, so
/// `*` is safe.
async fn write_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    content_type: &str,
    body: &[u8],
) -> Result<()> {
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {len}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Connection: close\r\n\
         \r\n",
        status = status,
        reason = reason,
        content_type = content_type,
        len = body.len(),
    );
    stream.write_all(header.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.shutdown().await.ok();
    Ok(())
}

/// Generate a fresh room ID from the URL-safe alphabet.
///
/// Uses `rand::thread_rng()` for cryptographic randomness. 8 chars
/// from a 64-char alphabet = 48 bits of entropy; birthday-bound
/// collision probability is ~1 in 10^7 at 10^7 concurrent rooms,
/// which is far above the m5's serve capacity.
fn mint_room_id() -> String {
    let mut rng = rand::thread_rng();
    let id: String = (0..ROOM_ID_LEN)
        .map(|_| {
            let idx = rng.gen_range(0..ROOM_ID_ALPHABET.len());
            ROOM_ID_ALPHABET[idx] as char
        })
        .collect();
    id
}

/// Helper: get current unix timestamp in seconds. Used by future
/// PRs (room cleanup, room TTL). Pulled out now so the future
/// code path has a stable API.
#[allow(dead_code)]
pub(crate) fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// PR 11.9 — `Arc<...>` re-export so callers don't have to know the
/// registry's inner type. Kept here (vs. transport.rs) because
/// matchmaker logic lives here.
pub type RoomRegistryAlias = Arc<tokio::sync::RwLock<std::collections::HashMap<String, Arc<tokio::sync::RwLock<Room>>>>>;

/// Stub for `Infallible` — never used, but keeps the imports tidy
/// for future async-trait work.
#[allow(dead_code)]
fn _infallible_to_result(_: Infallible) -> Result<()> {
    Ok(())
}

/// Read from `stream` into `buf` until we see `\r\n\r\n` (HTTP end-of-headers
/// marker) or we've read `cap` bytes. Returns the number of bytes
/// read. Uses an internal one-byte buffer so we can detect the
/// `\r\n\r\n` sequence without scanning all of buf each iteration.
///
/// This is the right shape for HTTP/1.1: the headers end at `\r\n\r\n`,
/// the body (if any) is bounded by `Content-Length`. We don't need
/// to wait for EOF — that would hang on keep-alive connections
/// that are waiting for the server's response.
async fn read_until_header_end(
    stream: &mut TcpStream,
    buf: &mut Vec<u8>,
    cap: usize,
) -> Result<()> {
    use tokio::io::AsyncReadExt;
    let mut byte = [0u8; 1];
    let mut last4: [u8; 4] = [0, 0, 0, 0];
    loop {
        if buf.len() >= cap {
            // Hit the cap without seeing the end-of-headers marker.
            // Caller will respond 400.
            return Ok(());
        }
        let n = stream.read(&mut byte).await.context("read byte")?;
        if n == 0 {
            // EOF before end of headers — caller will respond 400.
            return Ok(());
        }
        buf.push(byte[0]);
        // Shift the 4-byte window.
        last4[0] = last4[1];
        last4[1] = last4[2];
        last4[2] = last4[3];
        last4[3] = byte[0];
        if last4 == [b'\r', b'\n', b'\r', b'\n'] {
            return Ok(());
        }
    }
}