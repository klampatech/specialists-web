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
# Matchmaker HTTP listener — PR 11.9. Default 8084 because m5's :8080
# is held by docker-proxy for the vaultwarden password manager and
# :8081 is held by llama-server (gbrain's local bge-reranker).
# The static server proxies /rooms* from the page origin to localhost:8084.
MATCHMAKER_PORT=8084
# Static port on the wire: clients connect to https://m5.tail1b3795.ts.net:$STATIC_PORT/.
# Static port on the host backend: serve-static.mjs binds here (loopback only)
# so tailscaled can own $STATIC_PORT externally for Funnel.
STATIC_PORT=14432
STATIC_PORT_BACKEND=14032

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
log "booting canary on ports $WT_PORT/$WS_PORT/$WSS_PORT + matchmaker HTTP/$MATCHMAKER_PORT"
# --port-http $MATCHMAKER_PORT (default 8081): the matchmaker HTTP listener
# is required for the lobby flow (PR 11.9 — POST /rooms + GET /rooms/<id>).
# We bind on 8081 because m5's :8080 is held by docker-proxy for the
# vaultwarden password manager (verified via `sudo ss -tlnp`).
#
# The static server (booted in step 6 below) proxies /rooms* requests
# from the page origin to localhost:$MATCHMAKER_PORT so the lobby client
# (which derives matchmaker origin from window.location.origin) doesn't
# need any cross-origin awareness.
nohup bash tools/canary-server.sh \
  --port-wt "$WT_PORT" \
  --port-ws "$WS_PORT" \
  --port-wss "$WSS_PORT" \
  --port-http "$MATCHMAKER_PORT" \
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

# 6. Build + boot the static client + Funnel it on $STATIC_PORT.
# The wire server doesn't serve the client JS bundle, so we need a separate
# process for `client/dist/`. Tailscale Funnel forwards :$STATIC_PORT →
# localhost:$STATIC_PORT_BACKEND (loopback, so tailscaled can own
# :$STATIC_PORT externally without EADDRINUSE).
log "building client (cd client && npm run build)"
(cd client && npm run build 2>&1 | tail -3) || fail "client build failed"

log "rsyncing client/dist/ to $REMOTE_HOST"
rsync -az --delete client/dist/ "$REMOTE_HOST:~/Development/specialists-web/client/dist/" \
  || fail "rsync of client/dist/ to $REMOTE_HOST failed"

log "booting static server on 127.0.0.1:$STATIC_PORT_BACKEND (tailscaled owns :$STATIC_PORT externally)"
# Bind the static server on a different port than $STATIC_PORT to avoid
# colliding with tailscaled's own listener on the Tailscale IP for
# :$STATIC_PORT (when Funnel is enabled, tailscaled needs to bind the
# Tailscale IP; binding our app on the same port = EADDRINUSE on
# tailscaled's bind). Funnel forwards :$STATIC_PORT → :$STATIC_PORT_BACKEND.
ssh "$REMOTE_HOST" "cd ~/Development/specialists-web && HOST=127.0.0.1 PORT=$STATIC_PORT_BACKEND MATCHMAKER_URL=http://127.0.0.1:$MATCHMAKER_PORT nohup node tools/serve-static.mjs > /tmp/serve-static.log 2>&1 & echo \$! > /tmp/serve-static.pid; sleep 2; tail -3 /tmp/serve-static.log" \
  || fail "could not start static server on $REMOTE_HOST"

log "configuring Tailscale Funnel on :$STATIC_PORT → http://127.0.0.1:$STATIC_PORT_BACKEND"
ssh "$REMOTE_HOST" "sudo /home/kyle/go/bin/tailscale funnel --https=$STATIC_PORT off 2>/dev/null; sudo /home/kyle/go/bin/tailscale funnel --https=$STATIC_PORT --bg http://127.0.0.1:$STATIC_PORT_BACKEND" \
  || fail "tailscale funnel setup failed on $REMOTE_HOST"

# 7. Print the Funnel URLs
cat <<EOF

[deploy][OK] Production canary live.

  Static URL : https://m5.tail1b3795.ts.net:$STATIC_PORT/  (open this in your browser — serves the game client)
  Wire URL   : https://m5.tail1b3795.ts.net:$WT_PORT/       (WebTransport; the client derives this from the static URL host)
  Local TCP  : $REMOTE_HOST:$WT_PORT (WebTransport/UDP)
  Local TCP  : $REMOTE_HOST:$WS_PORT (WebSocket)
  Local TCP  : $REMOTE_HOST:$WSS_PORT (WebSocket over TLS, Funnel fallback)

  Logs       : /tmp/canary-deploy.log (canary) + /tmp/serve-static.log (static server)
  PID files  : /tmp/canary-server.pid + /tmp/serve-static.pid

  Play-test checklist:
    - Open https://m5.tail1b3795.ts.net:$STATIC_PORT/ in your browser
    - Open the same URL in 2-3 friends' browsers
    - All tabs should auto-connect to the same room
    - Verify AimEvent (LMB → HP drops on hit), WeaponSwitch (1/2 keys
      → weapon change in HUD), ReloadRequest (R → ammo back up),
      MeleeEvent (RMB within 1.5m + 60° cone → 25 HP drop)

  Tear-down:
    kill \$(cat /tmp/canary-server.pid) \$(cat /tmp/serve-static.pid)
    or: bash tools/deploy-prod.sh (re-runs will kill + restart)
EOF
