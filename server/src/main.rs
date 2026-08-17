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
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

use specialists_server::transport::{run_server, RoomRegistry};
use specialists_server::cert::DEFAULT_SANS;

#[derive(Debug, Default)]
struct Args {
    port_wt: Option<u16>,
    port_ws: Option<u16>,
    cert_out: Option<PathBuf>,
    key_out: Option<PathBuf>,
    sans: Vec<String>,
    gen_cert: bool,
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
         specialists-server [--port-wt <u16>] [--port-ws <u16>] [--cert <path>] [--key <path>] [--sans <csv>]\n  \
         specialists-server --gen-cert --cert-out <path> --key-out <path> [--sans <csv>]\n\
         \n\
         FLAGS:\n  \
         --port-wt <u16>    UDP port for the WebTransport listener (default: 4433)\n  \
         --port-ws <u16>    TCP port for the WebSocket listener (default: 4434)\n  \
         --cert <path>      Path to the PEM cert (default: server/certs/dev.pem)\n  \
         --key <path>       Path to the PEM key (default: server/certs/dev.key)\n  \
         --sans <csv>       Comma-separated Subject Alternative Names for the self-signed cert\n  \
                            (defaults to localhost,127.0.0.1,::1). Add your Tailscale IP\n  \
                            here when running from a non-loopback host.\n  \
         --gen-cert         Generate the self-signed cert + key, then exit 0. Used by\n  \
                            tools/canary-server.sh on first boot.\n  \
         -h, --help         Print this help and exit.\n\
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

    // Cert paths. `ensure_dev_certs` is idempotent — if both files
    // already exist, it's a no-op.
    let cert_path = args
        .cert_out
        .clone()
        .unwrap_or_else(|| PathBuf::from("server/certs/dev.pem"));
    let key_path = args
        .key_out
        .clone()
        .unwrap_or_else(|| PathBuf::from("server/certs/dev.key"));

    // Merge user-provided SANs with the defaults. The cert helper
    // dedupes internally.
    let mut sans: Vec<String> = DEFAULT_SANS.iter().map(|s| s.to_string()).collect();
    for s in args.sans.clone() {
        if !sans.iter().any(|existing| existing == &s) {
            sans.push(s);
        }
    }

    if args.gen_cert {
        // Single-purpose CLI flag used by canary-server.sh. Generate
        // the cert (no-op if both files exist) and exit.
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

    let rooms: RoomRegistry = Arc::new(RwLock::new(HashMap::new()));

    info!(
        port_wt,
        port_ws, cert = %cert_path.display(), key = %key_path.display(),
        "starting specialists-server (PR 11.6.B scaffold)"
    );

    // `run_server` owns both listener tasks. The integration canary starts
    // the individual crate-private listeners by including the transport
    // module directly, so the normal library surface only exposes this
    // orchestration seam.
    let server = run_server(
        port_wt,
        port_ws,
        cert_path,
        key_path,
        sans,
        rooms.clone(),
    );

    // PR 11.6.D: 64Hz tick task that increments the global server
    // frame counter on every room. The server frame is the
    // `server_frame` field on `DamageBroadcast`. Currently there is
    // exactly one room (`DEVBX`); the matchmaker in PR 11.9 will
    // iterate over all rooms.
    let tick_handle = tokio::spawn({
        let rooms = rooms.clone();
        async move {
            let mut interval = tokio::time::interval(
                std::time::Duration::from_millis(16), // ~64Hz (1_000 / 64 ≈ 15.6ms)
            );
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                let room_arc = {
                    let guard = rooms.read().await;
                    guard.get(specialists_server::constants::DEVBX_ROOM_ID).cloned()
                };
                if let Some(room_arc) = room_arc {
                    let mut room_guard = room_arc.write().await;
                    room_guard.tick_server_frame();
                }
            }
        }
    });

    // Wait for Ctrl-C OR either listener to fail OR the tick task to
    // panic (it never returns Ok in normal operation).
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            info!("SIGINT received — shutting down");
        }
        res = server => match res {
            Ok(()) => info!("server transports returned cleanly"),
            Err(e) => warn!("server transports errored: {e:?}"),
        },
        _ = tick_handle => {
            warn!("server tick task exited unexpectedly");
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
