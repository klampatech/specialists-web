#!/usr/bin/env bash
# PR #107+#108+#110+#114 — coordinated wire-break deploy.
#
# Boots the specialists-server on `m5` (the dev box) via Tailscale
# Funnel with all four wire-breaks stacked. Single command deploy;
# the operator doesn't need to think about which worktree or which
# port — the script pulls main, builds, and runs the canary.
#
# Pre-flight:
#   - m5 must be on Tailscale (`tailscale status` shows it)
#   - Funnel must be enabled on :14433 on m5
#   - This repo must be at ~/Development/specialists-web on m5
#
# After running, share the Funnel URL with friends:
#   https://m5.tail1b3795.ts.net:14433/
#
# Usage:
#   tools/deploy-prod.sh           # default: rebuild + restart on m5
#   tools/deploy-prod.sh --no-rebuild  # skip cargo build (use existing binary)
#   tools/deploy-prod.sh --local   # run locally on this box, no SSH

set -euo pipefail

REPO="${HOME}/Development/specialists-web"
REMOTE_HOST="m5"
WT_PORT=14433
WS_PORT=14434
WSS_PORT=14435

REBUILD=1
LOCAL=0

for arg in "$@"; do
  case "$arg" in
    --no-rebuild) REBUILD=0 ;;
    --local) LOCAL=1 ;;
    --help|-h)
      grep '^#' "$0" | head -25
      exit 0
      ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '[deploy] %s\n' "$*"; }
fail() { printf '[deploy][FAIL] %s\n' "$*" >&2; exit 1; }

# 1. Verify we're on the right branch + tree
cd "$REPO" || fail "could not cd to $REPO"

CURRENT_HEAD=$(git rev-parse --short HEAD)
log "local HEAD: $CURRENT_HEAD"
git fetch origin main --quiet 2>&1 || log "fetch failed (network?) — continuing with local"
REMOTE_MAIN=$(git rev-parse --short origin/main 2>/dev/null || echo "unknown")
log "origin/main: $REMOTE_MAIN"

if [[ "$CURRENT_HEAD" != "$REMOTE_MAIN" && "$REBUILD" == "1" ]]; then
  log "local HEAD differs from origin/main — fast-forwarding"
  git pull --ff-only origin main || fail "pull failed; resolve locally first"
fi

# 2. Cargo build (if requested)
if [[ "$REBUILD" == "1" ]]; then
  log "rebuilding server (cargo build --release, may take ~2min cold)"
  cargo build --release --manifest-path server/Cargo.toml 2>&1 | tail -3
fi

# 3. Kill any existing canary
log "killing any existing canary/vite"
pkill -f canary-server.sh 2>/dev/null || true
pkill -f specialists-server 2>/dev/null || true
if [[ -f /tmp/canary-server.pid ]]; then
  kill "$(cat /tmp/canary-server.pid)" 2>/dev/null || true
  rm -f /tmp/canary-server.pid
fi
sleep 1

# 4. Boot the canary in background
log "booting canary on ports $WT_PORT/$WS_PORT/$WSS_PORT"
nohup bash tools/canary-server.sh \
  --port-wt "$WT_PORT" \
  --port-ws "$WS_PORT" \
  --port-wss "$WSS_PORT" \
  > /tmp/canary-deploy.log 2>&1 &
echo $! > /tmp/canary-server.pid
sleep 2

# 5. Health check
log "health check — waiting for :$WT_PORT to bind"
for i in 1 2 3 4 5 6 7 8 9 10; do
  if ss -tln 2>/dev/null | grep -q ":$WT_PORT"; then
    log "canary bound on :$WT_PORT"
    break
  fi
  sleep 2
done

if ! ss -tln 2>/dev/null | grep -q ":$WT_PORT"; then
  fail "canary did not bind :$WT_PORT within 20s — check /tmp/canary-deploy.log"
fi

# 6. Print the Funnel URL
cat <<EOF

[deploy][OK] Production canary live.

  Funnel URL : https://m5.tail1b3795.ts.net:$WT_PORT/
  Local TCP  : $REMOTE_HOST:$WT_PORT (WebTransport/UDP)
  Local TCP  : $REMOTE_HOST:$WS_PORT (WebSocket)
  Local TCP  : $REMOTE_HOST:$WSS_PORT (WebSocket over TLS, Funnel fallback)

  Logs       : /tmp/canary-deploy.log (tail -f to follow)
  PID file   : /tmp/canary-server.pid

  Play-test checklist:
    - Open https://m5.tail1b3795.ts.net:$WT_PORT/ in your browser
    - Open the same URL in 2-3 friends' browsers
    - All tabs should auto-connect to the same room
    - Verify AimEvent (LMB → HP drops on hit), WeaponSwitch (1/2 keys
      → weapon change in HUD), ReloadRequest (R → ammo back up),
      MeleeEvent (RMB within 1.5m + 60° cone → 25 HP drop)

  Tear-down:
    kill \$(cat /tmp/canary-server.pid)
    or: bash tools/deploy-prod.sh (re-runs will kill + restart)
EOF
