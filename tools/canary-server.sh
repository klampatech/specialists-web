#!/usr/bin/env bash
# PR 11.6.B / §3.3 — canary launch script for the server scaffold.
#
# Boots the specialists-server in the foreground. Generates the
# self-signed cert on the first run (no-op if both files already exist).
# Designed to be launched via `herdr` or `terminal(background=true)` so
# the orchestrator can read its stdout / stderr.
#
# Usage:
#   tools/canary-server.sh [--port-wt <u16>] [--port-ws <u16>] [--cert-dir <dir>] [--sans <csv>]
#
# Env-var equivalents (consumed by the script as defaults):
#   PORT_WT    (default 4433)
#   PORT_WS    (default 4434)
#   CERT_DIR   (default <repo>/server/certs)
#
# The CI workflow (`.github/workflows/ci.yml` → `server-build`) runs
# `cargo test` directly with `SKIP_WEBTRANSPORT_TEST=1`, so this
# script is dev-box-only. The WebTransport integration smoke in
# `server/tests/session_canary.rs` is gated on `SKIP_WEBTRANSPORT_TEST`
# not being set; the script documents this in its `--help` block.
#
# Self-signed cert SANs: localhost + 127.0.0.1 + ::1 by default. Add
# the Tailscale dev-box IP (100.x.x.x) via `--sans 100.x.x.x` when
# booting from a non-loopback host.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

PORT_WT="${PORT_WT:-4433}"
PORT_WS="${PORT_WS:-4434}"
CERT_DIR="${CERT_DIR:-$REPO_ROOT/server/certs}"
SANS="${SANS:-localhost,127.0.0.1,::1}"
CARGO_PROFILE="${CARGO_PROFILE:-release}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port-wt)
      PORT_WT="$2"; shift 2 ;;
    --port-ws)
      PORT_WS="$2"; shift 2 ;;
    --cert-dir)
      CERT_DIR="$2"; shift 2 ;;
    --sans)
      SANS="$2"; shift 2 ;;
    --debug)
      CARGO_PROFILE="debug"; shift ;;
    -h|--help)
      sed -n '2,28p' "$0"
      exit 0 ;;
    *)
      echo "canary-server.sh: unknown flag: $1" >&2
      exit 2 ;;
  esac
done

CERT_PATH="$CERT_DIR/dev.pem"
KEY_PATH="$CERT_DIR/dev.key"

mkdir -p "$CERT_DIR"

cd "$REPO_ROOT"

# Self-signed cert bootstrap (idempotent). We invoke the server binary
# with `--gen-cert` so the actual cargo + rcgen path runs in the
# server's own build context. The binary writes PEM + key to the
# configured paths and exits 0.
if [[ ! -f "$CERT_PATH" ]] || [[ ! -f "$KEY_PATH" ]]; then
  echo "[canary] generating self-signed cert in $CERT_DIR..."
  mkdir -p "$CERT_DIR"
  cargo run --manifest-path server/Cargo.toml --quiet --$CARGO_PROFILE -- \
    --gen-cert \
    --cert-out "$CERT_PATH" \
    --key-out "$KEY_PATH" \
    --sans "$SANS"
fi

echo "[canary] booting specialists-server (WebTransport UDP/$PORT_WT, WebSocket TCP/$PORT_WS)"
echo "[canary] cert: $CERT_PATH"
echo "[canary] key:  $KEY_PATH"
echo "[canary] sans: $SANS"

# Hand off to the server. exec so signals (SIGINT) reach it directly.
exec cargo run --manifest-path server/Cargo.toml --quiet --$CARGO_PROFILE -- \
  --port-wt "$PORT_WT" \
  --port-ws "$PORT_WS" \
  --cert "$CERT_PATH" \
  --key "$KEY_PATH" \
  --sans "$SANS"
