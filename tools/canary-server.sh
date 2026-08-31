#!/usr/bin/env bash
# PR 11.6.B / §3.3 + PR 11.6.E — canary launch script for the server scaffold.
#
# Boots the specialists-server in the foreground. Supports two cert
# modes (PR 11.6.E):
#
#   - `--cert-source self-signed` (default): generates a self-signed
#     cert on the first run (no-op if both files already exist).
#     SANs default to localhost + 127.0.0.1 + ::1; extend with
#     `--sans 100.x.x.x` when booting from a non-loopback host.
#
#   - `--cert-source letsencrypt` (production / Tailscale Funnel):
#     loads `server/certs/lets-encrypt.{pem,key}` from disk, written
#     by the systemd unit's `ExecStartPost` step. Fails loud if the
#     files are missing — we never silently fall back to a self-signed
#     cert in production mode.
#
# Designed to be launched via `herdr` or `terminal(background=true)` so
# the orchestrator can read its stdout / stderr.
#
# Usage:
#   tools/canary-server.sh [--port-wt <u16>] [--port-ws <u16>] [--cert-dir <dir>] [--sans <csv>] [--cert-source <mode>]
#
# Env-var equivalents (consumed by the script as defaults):
#   PORT_WT      (default 4433)
#   PORT_WS      (default 4434)
#   CERT_DIR     (default <repo>/server/certs)
#   CERT_SOURCE  (default "self-signed")
#
# The CI workflow (`.github/workflows/ci.yml` → `server-build`) runs
# `cargo test` directly with `SKIP_WEBTRANSPORT_TEST=1`, so this
# script is dev-box-only. The WebTransport integration smoke in
# `server/tests/session_canary.rs` is gated on `SKIP_WEBTRANSPORT_TEST`
# not being set; the script documents this in its `--help` block.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

PORT_WT="${PORT_WT:-4433}"
PORT_WS="${PORT_WS:-4434}"
PORT_WSS="${PORT_WSS:-$PORT_WS}"
CERT_DIR="${CERT_DIR:-$REPO_ROOT/server/certs}"
SANS="${SANS:-localhost,127.0.0.1,::1}"
CERT_SOURCE="${CERT_SOURCE:-self-signed}"
CARGO_PROFILE="${CARGO_PROFILE:-release}"
# Build the cargo profile flag. "debug" is the default and doesn't
# take a flag, so we omit --$CARGO_PROFILE when CARGO_PROFILE=debug
# (cargo run --debug is a syntax error). For release, we pass --release.
if [[ "$CARGO_PROFILE" == "debug" ]]; then
  CARGO_PROFILE_FLAG=""
else
  CARGO_PROFILE_FLAG="--$CARGO_PROFILE"
fi

print_help() {
  sed -n '2,46p' "$0"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port-wt)
      PORT_WT="$2"; shift 2 ;;
    --port-ws)
      PORT_WS="$2"; shift 2 ;;
    --port-wss)
      # PR 11.6.E / Session 2 — TLS-wrapped WS port. Production
      # binds a separate port for wss:// (Funnel HTTPS fallback).
      # Dev canary leaves this at PORT_WS so only one listener binds.
      PORT_WSS="$2"; shift 2 ;;
    --cert-dir)
      CERT_DIR="$2"; shift 2 ;;
    --sans)
      SANS="$2"; shift 2 ;;
    --cert-source)
      CERT_SOURCE="$2"; shift 2 ;;
    --debug)
      CARGO_PROFILE="debug"; shift ;;
    -h|--help)
      print_help
      exit 0 ;;
    *)
      echo "canary-server.sh: unknown flag: $1" >&2
      exit 2 ;;
  esac
done

# Resolve cert paths based on the cert source. PR 11.6.E split the
# dev / prod cert layout:
#   self-signed   -> $CERT_DIR/dev.pem        + dev.key
#   letsencrypt   -> $CERT_DIR/lets-encrypt.pem + lets-encrypt.key
#
# Both files live in the same directory so operators can swap modes
# without moving anything.
case "$CERT_SOURCE" in
  self-signed)
    CERT_PATH="$CERT_DIR/dev.pem"
    KEY_PATH="$CERT_DIR/dev.key"
    ;;
  letsencrypt|lets-encrypt|lets_encrypt)
    CERT_PATH="$CERT_DIR/lets-encrypt.pem"
    KEY_PATH="$CERT_DIR/lets-encrypt.key"
    ;;
  *)
    echo "canary-server.sh: unknown --cert-source value: $CERT_SOURCE" >&2
    echo "  expected 'self-signed' or 'letsencrypt'" >&2
    exit 2 ;;
esac

mkdir -p "$CERT_DIR"

cd "$REPO_ROOT"

# Self-signed cert bootstrap (idempotent). We invoke the server binary
# with `--gen-cert` so the actual cargo + rcgen path runs in the
# server's own build context. The binary writes PEM + key to the
# configured paths and exits 0.
#
# PR 11.6.E: --gen-cert is self-signed only. LetsEncrypt certs are
# provisioned by Tailscale Funnel + the systemd unit's ExecStartPost
# step; this script must NOT generate anything in that mode.
if [[ "$CERT_SOURCE" == "self-signed" ]]; then
  if [[ ! -f "$CERT_PATH" ]] || [[ ! -f "$KEY_PATH" ]]; then
    echo "[canary] generating self-signed cert in $CERT_DIR..."
    cargo run --manifest-path server/Cargo.toml --quiet $CARGO_PROFILE_FLAG -- \
      --gen-cert \
      --cert-out "$CERT_PATH" \
      --key-out "$KEY_PATH" \
      --sans "$SANS"
  fi
else
  # letsencrypt mode — fail loud if the cert files aren't on disk.
  # This is the production fail-loud that the cert module's
  # `ensure_letsencrypt_certs` enforces at the Rust layer; we surface
  # it here too so operators get the message at boot time, not just
  # in the server log.
  if [[ ! -f "$CERT_PATH" ]] || [[ ! -f "$KEY_PATH" ]]; then
    echo "[canary] ERROR: --cert-source=letsencrypt but cert files missing:" >&2
    echo "  cert: $CERT_PATH (exists: $([[ -f "$CERT_PATH" ]] && echo yes || echo no))" >&2
    echo "  key:  $KEY_PATH (exists: $([[ -f "$KEY_PATH" ]] && echo yes || echo no))" >&2
    echo "  run: sudo tailscale funnel --https=4433 on" >&2
    echo "  and verify the systemd unit's ExecStartPost wrote the cert." >&2
    exit 1
  fi
fi

echo "[canary] booting specialists-server (WebTransport UDP/$PORT_WT, WebSocket TCP/$PORT_WS)"
echo "[canary] cert source: $CERT_SOURCE"
echo "[canary] cert: $CERT_PATH"
echo "[canary] key:  $KEY_PATH"
[[ "$CERT_SOURCE" == "self-signed" ]] && echo "[canary] sans: $SANS"

# Hand off to the server. exec so signals (SIGINT) reach it directly.
exec cargo run --manifest-path server/Cargo.toml --quiet $CARGO_PROFILE_FLAG -- \
  --port-wt "$PORT_WT" \
  --port-ws "$PORT_WS" \
  --port-wss "$PORT_WSS" \
  --cert-source "$CERT_SOURCE" \
  --cert "$CERT_PATH" \
  --key "$KEY_PATH" \
  --sans "$SANS"
