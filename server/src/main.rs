// PR 11.6.B — server binary entry point.
//
// Thin CLI wrapper around `specialists_server::run()`. Parses flags,
// generates the dev cert on first run (no-op if `server/certs/dev.pem`
// already exists), spawns the WebTransport + WebSocket listeners, and
// waits for either to error or for Ctrl-C.
//
// Usage:
//   specialists-server --port-wt 4433 --port-ws 4434
//   specialists-server --gen-cert --cert-out server/certs/dev.pem --key-out server/certs/dev.key
//
// Environment:
//   RUST_LOG=info,specialists_server=debug  — standard tracing-subscriber env filter.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use anyhow::{Context, Result};
use tokio::sync::RwLock;
use tracing::{debug, info, warn};
use tracing_subscriber::EnvFilter;
use specialists_server::transport::{run_server, RoomRegistry};
use specialists_server::cert::{CertSource, DEFAULT_SANS, LETS_ENCRYPT_CERT, LETS_ENCRYPT_KEY};
use specialists_server::connection_outbound::global_drop_oldest_count;
use specialists_server::session::Room;

#[derive(Debug, Default)]
struct Args {
    port_wt: Option<u16>,
    port_ws: Option<u16>,
    cert_out: Option<PathBuf>,
    key_out: Option<PathBuf>,
    sans: Vec<String>,
    gen_cert: bool,
    /// TLS cert source — `self-signed` (default, dev/CI) or
    /// `letsencrypt` (production / cloud deploy via Tailscale Funnel).
    /// PR 11.6.E adds the production path so the server can serve a
    /// real Let's Encrypt cert at the Funnel URL with no dev-cert
    /// browser warning.
    cert_source: Option<CertSource>,
    /// PR 11.6.E / Session 2 — TLS-wrapped WebSocket port. Set to
    /// `port_ws` (default 4434) if you don't want WSS bound (dev).
    /// Set to a separate port (e.g. 4435) for production behind
    /// Tailscale Funnel. `0` disables WSS entirely.
    port_wss: Option<u16>,
    /// PR 11.9 — matchmaker HTTP listener port. Hosts
    /// `POST /rooms`, `GET /rooms/<id>`, `GET /health`. Set to
    /// `0` to disable (default in `release` builds for prod where
    /// the systemd unit binds a separate matchmaker; `8080` for
    /// dev canary).
    port_http: Option<u16>,
    print_help: bool,
}

fn parse_args() -> Result<Args> {
    let mut args = Args::default();
    let mut iter = std::env::args().skip(1);
    while let Some(flag) = iter.next() {
        match flag.as_str() {
            "--port-wt" => {
                args.port_wt = Some(
                    iter.next()
                        .context("--port-wt requires a value")?
                        .parse()
                        .context("--port-wt must be u16")?,
                );
            }
            "--port-ws" => {
                args.port_ws = Some(
                    iter.next()
                        .context("--port-ws requires a value")?
                        .parse()
                        .context("--port-ws must be u16")?,
                );
            }
            "--port-wss" => {
                args.port_wss = Some(
                    iter.next()
                        .context("--port-wss requires a value")?
                        .parse()
                        .context("--port-wss must be u16")?,
                );
            }
            "--port-http" => {
                args.port_http = Some(
                    iter.next()
                        .context("--port-http requires a value")?
                        .parse()
                        .context("--port-http must be u16")?,
                );
            }
            "--cert" | "--cert-out" => {
                args.cert_out = Some(PathBuf::from(
                    iter.next().context("--cert requires a value")?,
                ));
            }
            "--key" | "--key-out" => {
                args.key_out = Some(PathBuf::from(
                    iter.next().context("--key requires a value")?,
                ));
            }
            "--sans" => {
                // Comma-separated list, e.g. `--sans localhost,127.0.0.1,100.95.111.112`.
                let list = iter.next().context("--sans requires a value")?;
                args.sans.extend(list.split(',').map(|s| s.trim().to_string()));
            }
            "--gen-cert" => {
                args.gen_cert = true;
            }
            "--cert-source" => {
                let raw = iter
                    .next()
                    .context("--cert-source requires a value")?;
                args.cert_source = Some(
                    CertSource::from_str(&raw)
                        .with_context(|| format!("invalid --cert-source {raw:?}"))?,
                );
            }
            "-h" | "--help" => {
                args.print_help = true;
            }
            other => {
                anyhow::bail!("unknown flag: {other}");
            }
        }
    }
    Ok(args)
}

fn print_help() {
    eprintln!(
        "specialists-server — PR 11.6.B server scaffold\n\
         \n\
         USAGE:\n  \
         specialists-server [--port-wt <u16>] [--port-ws <u16>] [--cert <path>] [--key <path>] [--sans <csv>] [--cert-source <self-signed|letsencrypt>]\n  \
         specialists-server --gen-cert --cert-out <path> --key-out <path> [--sans <csv>]\n\
         \n\
         FLAGS:\n  \
         --port-wt <u16>             UDP port for the WebTransport listener (default: 4433)\n  \
         --port-ws <u16>             TCP port for the WebSocket listener (default: 4434)\n  \
         --port-wss <u16>            TCP port for the TLS-wrapped WebSocket listener (default: same as --port-ws).\n                                   Set to a separate port in production to avoid mixed-content with plain WS.\n                                   0 disables WSS entirely.\n  \
         --port-http <u16>           TCP port for the matchmaker HTTP listener (default: 8080).\n                                   Hosts POST /rooms, GET /rooms/<id>, GET /health. 0 disables.\n  \
         --cert <path>               Path to the PEM cert (default: server/certs/dev.pem for self-signed,\n  \
                                    server/certs/lets-encrypt.pem for letsencrypt)\n  \
         --key <path>                Path to the PEM key (default: server/certs/dev.key for self-signed,\n  \
                                    server/certs/lets-encrypt.key for letsencrypt)\n  \
         --sans <csv>                Comma-separated Subject Alternative Names for the self-signed cert\n  \
                                    (defaults to localhost,127.0.0.1,::1). Add your Tailscale IP\n  \
                                    here when running from a non-loopback host. Ignored in letsencrypt\n  \
                                    mode — SANs come from the cert itself.\n  \
         --cert-source <mode>        Cert source: 'self-signed' (default, dev/CI) or 'letsencrypt'\n  \
                                    (production / Tailscale Funnel). Selects which cert files\n  \
                                    are loaded and whether the server generates a self-signed\n  \
                                    cert on first boot.\n  \
         --gen-cert                  Generate the self-signed cert + key, then exit 0. Used by\n  \
                                    tools/canary-server.sh on first boot. Self-signed only.\n  \
         -h, --help                  Print this help and exit.\n\
         \n\
         ENVIRONMENT:\n  \
         RUST_LOG                       Standard tracing-subscriber env filter. Default: info.\n  \
         SKIP_WEBTRANSPORT_TEST         (tests only) Skip the in-process WebTransport smoke.\n"
    );
}

#[tokio::main]
async fn main() -> ExitCode {
    init_tracing();
    let args = match parse_args() {
        Ok(args) => args,
        Err(e) => {
            eprintln!("error: {e:?}\n");
            print_help();
            return ExitCode::from(2);
        }
    };
    if args.print_help {
        print_help();
        return ExitCode::SUCCESS;
    }

    // Resolve cert source. Defaults to SelfSigned — keeps existing
    // dev/CI behavior unchanged. LetsEncrypt is opt-in via the
    // --cert-source flag and is paired with the systemd unit's
    // ExecStartPost that writes the Funnel-provisioned cert.
    let cert_source = args.cert_source.unwrap_or(CertSource::SelfSigned);

    // Cert paths. Defaults depend on cert_source:
    //   SelfSigned   -> server/certs/dev.{pem,key}
    //   LetsEncrypt  -> server/certs/lets-encrypt.{pem,key}
    // The `--cert` / `--key` flags override either default. The
    // `ensure_certs` dispatcher picks the right loader based on
    // `cert_source` and the resolved paths.
    let default_cert = match cert_source {
        CertSource::SelfSigned => "server/certs/dev.pem",
        CertSource::LetsEncrypt => LETS_ENCRYPT_CERT,
    };
    let default_key = match cert_source {
        CertSource::SelfSigned => "server/certs/dev.key",
        CertSource::LetsEncrypt => LETS_ENCRYPT_KEY,
    };
    let cert_path = args
        .cert_out
        .clone()
        .unwrap_or_else(|| PathBuf::from(default_cert));
    let key_path = args
        .key_out
        .clone()
        .unwrap_or_else(|| PathBuf::from(default_key));

    // Merge user-provided SANs with the defaults. The cert helper
    // dedupes internally. SANs are only consumed in self-signed mode
    // — in letsencrypt mode they come from the cert itself.
    let mut sans: Vec<String> = DEFAULT_SANS.iter().map(|s| s.to_string()).collect();
    for s in args.sans.clone() {
        if !sans.iter().any(|existing| existing == &s) {
            sans.push(s);
        }
    }

    if args.gen_cert {
        // Single-purpose CLI flag used by canary-server.sh. Generate
        // the cert (no-op if both files exist) and exit. Self-signed
        // only — calling --gen-cert with --cert-source=letsencrypt
        // is a user error; fail loud.
        if cert_source != CertSource::SelfSigned {
            eprintln!(
                "error: --gen-cert only makes sense with --cert-source=self-signed\n\
                 (letsencrypt certs are provisioned by Tailscale Funnel, not generated)\n"
            );
            return ExitCode::from(2);
        }
        match specialists_server::cert::ensure_dev_certs(&cert_path, &key_path, sans).await {
            Ok(()) => {
                println!("wrote {} and {}", cert_path.display(), key_path.display());
                return ExitCode::SUCCESS;
            }
            Err(e) => {
                eprintln!("gen-cert failed: {e:?}");
                return ExitCode::from(1);
            }
        }
    }

    let port_wt = args.port_wt.unwrap_or(4433);
    let port_ws = args.port_ws.unwrap_or(4434);
    // PR 11.6.E / Session 2 — default WSS port equals plain WS port
    // so dev canary (single binary, single port) doesn't bind WSS by
    // accident. Production (systemd unit, --cert-source=letsencrypt)
    // passes `--port-wss 4435` explicitly to bind a separate TLS
    // port. `--port-wss 0` disables WSS entirely.
    let port_wss = args.port_wss.unwrap_or(port_ws);
    // PR 11.9 — matchmaker HTTP listener. Default 8080 (dev / dev-box
    // canary). Production passes `--port-http 0` to disable if the
    // operator wants the matchmaker as a separate service.
    let port_http = args.port_http.unwrap_or(8080);

    let rooms: RoomRegistry = Arc::new(RwLock::new(HashMap::new()));

    info!(
        port_wt,
        port_ws,
        port_http,
        cert_source = ?cert_source,
        cert = %cert_path.display(),
        key = %key_path.display(),
        "starting specialists-server (PR 11.6.B + 11.9 matchmaker; cert provisioning via PR 11.6.E)"
    );

    // `run_server` owns both listener tasks. The integration canary starts
    // the individual crate-private listeners by including the transport
    // module directly, so the normal library surface only exposes this
    // orchestration seam.
    let server = run_server(
        port_wt,
        port_ws,
        port_wss,
        port_http,
        cert_source,
        cert_path,
        key_path,
        sans,
        rooms.clone(),
    );

    // PR 11.7.B / §3.10 — physics_tick_loop at 64Hz. This is the
    // canonical tick loop now; it folds in the PR 11.6.D
    // `tick_server_frame` increment AND drives the Rapier
    // physics step AND records `PositionHistory` from the
    // physics world (replacing the client-driven
    // `PositionUpdate` feed source).
    //
    // Two separate per-room tasks: one physics tick (64Hz) and
    // one snapshot generator (20Hz). The snapshot reads the
    // same `room.next_server_frame` counter that the physics
    // tick increments.
    let physics_tick_handle = tokio::spawn({
        let rooms = rooms.clone();
        async move {
            // 64Hz = 15_625 microseconds per tick. Using
            // microseconds (not millis) so the tick rate is
            // exact — 16ms would give 62.5Hz, drifting from the
            // PR 11.6.D + 11.7.B brief lock of 64Hz.
            let mut interval = tokio::time::interval(
                std::time::Duration::from_micros(15_625),
            );
            interval.set_missed_tick_behavior(
                tokio::time::MissedTickBehavior::Skip,
            );
            loop {
                interval.tick().await;
                // PR 65 — the physics tick loop must iterate EVERY active
                // room, not just DEVBX. Pre-PR-#64 it was hardcoded to
                // DEVBX_ROOM_ID because every connection was unconditionally
                // routed there. Post-PR-#64 connections are routed to the
                // URL-derived room id (see `parse_room_id`), so non-DEVBX
                // rooms need their own `next_server_frame` increment +
                // physics step. Without this fix, every AimEvent in a
                // non-DEVBX room is rejected by the lag-comp gate with
                // "frame too far in the future" because `next_server_frame`
                // stays at 0 (the client advances its local frame counter
                // ~64Hz but the server never ticks the room).
                let active_rooms: Vec<(String, Arc<RwLock<Room>>)> = {
                    let guard = rooms.read().await;
                    guard
                        .iter()
                        .map(|(id, room_arc)| (id.clone(), room_arc.clone()))
                        .collect()
                };
                for (_room_id, room_arc) in active_rooms {
                    let mut room_guard = room_arc.write().await;
                    // 1. Increment the server frame counter.
                    let frame = room_guard.tick_server_frame();
                    // 2. PR 11.7.B BLK-2 — drain the latest input
                    //    per player. Without this call, the
                    //    `drained_inputs_this_tick` scratch map is
                    //    always empty and the physics step runs
                    //    with zero WASD inputs every tick — the
                    //    player capsule never walks, never rotates,
                    //    never changes horizontal velocity from
                    //    the network.
                    room_guard.drain_inputs_for_tick(frame);
                    // 3. Step the Rapier physics world (moves
                    //    capsules + applies coyote-time jumps +
                    //    runs the integration step). The
                    //    `PhysicsWorld::step` API needs only an
                    //    immutable borrow of the inputs map, but
                    //    we hold the room write guard — so we
                    //    clone the inputs map first, drop the
                    //    reference to `room_guard`, and pass the
                    //    clone to `physics.step`. PR 11.7.C can
                    //    refactor this into a non-locking pattern
                    //    if it becomes a hot path.
                    // Convert from `Room.drained_inputs_this_tick` (HashMap)
                    // to the BTreeMap that `PhysicsWorld::step` expects.
                    // The conversion is O(n log n) — fine for 24 players
                    // per tick at 64Hz.
                    let inputs_clone: std::collections::BTreeMap<u16, [u8; 12]> =
                        room_guard.drained_inputs_this_tick
                            .iter()
                            .map(|(k, v)| (*k, *v))
                            .collect();
                    room_guard.physics.step(
                        &inputs_clone,
                        frame as u64,
                    );
                    // 4. Record PositionHistory from the physics
                    //    world (every other tick = 32Hz storage).
                    if specialists_server::position_history::should_store_frame(frame)
                    {
                        // Snapshot the connected players' positions.
                        let player_ids: Vec<u16> = room_guard
                            .connections
                            .keys()
                            .copied()
                            .collect();
                        for pid in player_ids {
                            if let Some(pos) =
                                room_guard.physics.position(pid)
                            {
                                room_guard.record_position(
                                    pid, frame, pos,
                                );
                            }
                        }
                    }
                }
            }
        }
    });

    // PR 11.7.B / §3.4 + §3.10.1 — snapshot_generator_loop at
    // 20Hz. Encodes + broadcasts a `Snapshot` to every
    // connection in the room. The generator itself is in
    // `snapshot::SnapshotGenerator`; this task just drives
    // its `maybe_emit` cadence.
    let snapshot_gen_handle = tokio::spawn({
        let rooms = rooms.clone();
        async move {
            // PR 83 / CF-N1 follow-up — per-room SnapshotGenerator.
            // The single `gen` instance pre-PR-83 meant the
            // `last_emit_ms` time check was shared across all rooms.
            // With the rooms HashMap iterating in arbitrary order
            // each tick, the FIRST room in iteration consumed the
            // 20Hz budget and updated `last_emit_ms = now_ms`, so
            // every OTHER room in the same tick got `None` from
            // `maybe_emit` (because `now_ms - last_emit_ms < 50ms`).
            // Under sustained multi-room load (e.g. several smoke
            // runs in a single canary session), one stale room would
            // "win" every tick and starve every other room — the
            // HP-convergence smoke then fires AimEvents with
            // `frame: 0` (because `__latestSnap()` never returns
            // non-null for the starving room), and the server
            // rejects them with "frame too far in the past".
            //
            // The PR 11.7.B / `snapshot::SnapshotGenerator` docstring
            // at line 30-33 already calls out "one instance per room"
            // as the design intent — this PR makes the implementation
            // match. Old rooms are GC'd when the connection closes
            // (see transport.rs WS close handler); the loop prunes
            // them on every tick.
            let mut gens: HashMap<String, specialists_server::snapshot::SnapshotGenerator> =
                HashMap::new();
            let start = std::time::Instant::now();
            let mut interval = tokio::time::interval(
                std::time::Duration::from_millis(50), // 1000/50 = 20Hz
            );
            interval.set_missed_tick_behavior(
                tokio::time::MissedTickBehavior::Skip,
            );
            // PR 80 — read the snapshot rate-limit threshold from
            // the env once at startup. Default 25% (= 256 entries
            // deep against the 1024 cap). Set to 100 to disable the
            // gate entirely; set to 0 to gate every emit (useful for
            // stress testing). Mirrors the existing
            // `CANARY_STATS_INTERVAL_MS` env var pattern.
            let rate_limit_pct: u8 = std::env::var(
                "SNAPSHOT_RATE_LIMIT_PCT",
            ).ok().and_then(|s| s.parse().ok()).unwrap_or(25);
            // PR 11.7.D3.3 — log the global drop-oldest counter every
            // 5 seconds so the 24-player stress smoke can grep for
            // `[stress-stats]` lines and assert no drops occurred.
            // (Avoids the cost of a dedicated HTTP endpoint while
            // keeping the data path identical to what the smoke cares
            // about.) Set CANARY_STATS_INTERVAL_MS=0 to disable.
            let stats_interval_ms: u64 = std::env::var(
                "CANARY_STATS_INTERVAL_MS",
            ).ok().and_then(|s| s.parse().ok()).unwrap_or(5_000);
            let mut last_stats = std::time::Instant::now();
            let mut last_drops: u64 = 0;
            // PR 80 — rate-limited counter deltas (paired with
            // `last_drops` for the existing drop-counter stats line).
            let mut last_rate_limited: u64 = 0;
            loop {
                interval.tick().await;
                let now_ms = start.elapsed().as_millis() as u64;
                // PR-fix-0x06 — the snapshot generator must iterate
                // every active room, not just DEVBX. Pre-fix this
                // hardcoded `DEVBX_ROOM_ID` because every connection
                // was unconditionally routed there regardless of the
                // URL path. Post-fix the URL-derived room id is
                // used (see `parse_room_id`), so the generator must
                // walk the full `rooms` map and broadcast a snapshot
                // to each room's connections.
                let active_rooms: Vec<(String, Arc<RwLock<Room>>)> = {
                    let guard = rooms.read().await;
                    guard
                        .iter()
                        .map(|(id, room_arc)| (id.clone(), room_arc.clone()))
                        .collect()
                };
                for (room_id, room_arc) in active_rooms {
                    // PR 80 — rate-limit gate. Skip the whole
                    // emit-and-broadcast for this room if ANY
                    // connection's queue is saturated (> rate_limit_pct
                    // % of cap). State is preserved (the next emit at
                    // the next tick has the latest positions); we
                    // just give the consumer room to drain. Bumps the
                    // global counter so the periodic stats line
                    // reports it.
                    let rate_limited = {
                        let room_guard = room_arc.read().await;
                        specialists_server::snapshot::should_rate_limit(
                            &*room_guard, rate_limit_pct,
                        ).await
                    };
                    if rate_limited {
                        specialists_server::connection_outbound::global_rate_limited_count_inc();
                        debug!(
                            target: "cf_n1",
                            room_id = %room_id,
                            threshold_pct = rate_limit_pct,
                            "cf-n1-rate-limited: skipping snapshot emit (consumer queue saturated)",
                        );
                        continue;
                    }
                    // PR 83 — per-room `SnapshotGenerator` so each
                    // room gets its own 20Hz budget. Pre-PR-83
                    // shared a single `gen` across all rooms and
                    // the first-in-iteration room would consume the
                    // tick. Now `gens.entry(room_id).or_default()`
                    // gives every room its own `last_emit_ms`.
                    let snap_opt = {
                        let room_guard = room_arc.read().await;
                        let gen = gens
                            .entry(room_id.clone())
                            .or_insert_with(specialists_server::snapshot::SnapshotGenerator::new);
                        gen.maybe_emit(&*room_guard, now_ms)
                    };
                    // If the room didn't emit, no `last_emit_ms`
                    // update — but its entry in `gens` stays so the
                    // next tick can use it. Old rooms are pruned
                    // below.
                    if snap_opt.is_none() {
                        continue;
                    }
                    if let Some(snap) = snap_opt {
                        let mut wire = Vec::with_capacity(
                            1 + specialists_server::protocol::SNAPSHOT_WIRE_SIZE_MIN
                                + snap.players.len()
                                * specialists_server::protocol::PLAYER_STATE_WIRE_SIZE,
                        );
                        wire.push(
                            specialists_server::protocol::DISCRIMINATOR_SNAPSHOT,
                        );
                        let body = specialists_server::protocol::encode_snapshot(&snap);
                        wire.extend(body);
                        // Tag the broadcast with the room id for log
                        // clarity (helps debugging multi-room setups).
                        let snap_len = wire.len();
                        debug!(room_id = %room_id, "snapshot enqueued for room");
                        specialists_server::transport::broadcast_snapshot(
                            room_arc.clone(),
                            wire,
                        ).await;
                        let _ = snap_len; // suppress unused warning if debug! is filtered
                    }
                }
                // PR 83 — prune `gens` entries for rooms that have
                // been removed from the registry. Without this the
                // map would grow unboundedly across the canary's
                // lifetime (a long-running canary with 1000+ room
                // creates + closes would carry 1000 dead generators).
                // The active_rooms snapshot above tells us which
                // rooms are still live; everything else is stale.
                let active_room_ids: std::collections::HashSet<String> = {
                    let guard = rooms.read().await;
                    guard.keys().cloned().collect()
                };
                gens.retain(|room_id, _| active_room_ids.contains(room_id));
                // Periodic stats line — single info!() call per interval
                // so the canary log doesn't get spammed.
                if stats_interval_ms > 0
                    && last_stats.elapsed().as_millis() as u64 >= stats_interval_ms
                {
                    let drops = global_drop_oldest_count();
                    let delta = drops.saturating_sub(last_drops);
                    // PR 80 — also log the rate-limited counter so
                    // operators can correlate `[cf-n1-rate-limited]`
                    // (debug) with the delta totals (info).
                    let rate_limited = specialists_server::connection_outbound::global_rate_limited_count();
                    let rl_delta = rate_limited.saturating_sub(last_rate_limited);
                    info!(
                        target: "stress_stats",
                        drops_total = drops,
                        drops_since_last = delta,
                        rate_limited_total = rate_limited,
                        rate_limited_since_last = rl_delta,
                        interval_ms = stats_interval_ms,
                        "[stress-stats] snapshot counters"
                    );
                    last_drops = drops;
                    last_rate_limited = rate_limited;
                    last_stats = std::time::Instant::now();
                }
            }
        }
    });

    // Wait for Ctrl-C OR either listener to fail OR either tick
    // task to panic (they never return Ok in normal operation).
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            info!("SIGINT received — shutting down");
        }
        res = server => match res {
            Ok(()) => info!("server transports returned cleanly"),
            Err(e) => warn!("server transports errored: {e:?}"),
        },
        _ = physics_tick_handle => {
            warn!("physics_tick_loop exited unexpectedly");
        }
        _ = snapshot_gen_handle => {
            warn!("snapshot_generator_loop exited unexpectedly");
        }
    }

    info!("server exiting");
    ExitCode::SUCCESS
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(true)
        .try_init();
}
