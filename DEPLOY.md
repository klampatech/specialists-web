# Deploy Strategy — specialists-web

> **Live prod host (as of 2026-09-08):** `m5` exposed via Tailscale Funnel at
> **`https://m5.tail1b3795.ts.net:14432/`** (static client) and
> **`https://m5.tail1b3795.ts.net:14433/`** (canary WebTransport). The
> previous Hetzner VPS at `65.108.87.1` is **historical** — see the
> [Hetzner historical deploy](#hetzner-historical-deploy) appendix at the
> bottom of this file. All new deploys go through the Funnel path.

## Where the game runs

- **m5 (LAN dev box, Tailscale IP `100.95.111.112`)** — **live prod + dev canary.** Bare background processes (canary + serve-static), launched by `tools/deploy-prod.sh`. Plain HTTP on `:14032` (loopback) terminated by Tailscale Funnel at `https://m5.tail1b3795.ts.net:14432`. Plain WS on `:14434` over the Tailscale mesh (no TLS, no Funnel — Tailscale is encrypted at the mesh layer). WebTransport on `:14433`, also exposed via Funnel. Matchmaker HTTP on `:8084` (loopback only).
- **CI runners (GitHub-hosted ephemeral)** — boot canary + vite on CI-locked ports (e.g. `24732`/`24733`/`24734`/`24735`/`24780` for the lobby-e2e job) to avoid collisions with each other and with on-host services. See `.github/workflows/ci.yml`.

## How to deploy to prod (Funnel / m5)

This is the **only** deploy procedure in active use as of 2026-09-08.

### One-time m5 setup (already done, included for reference)

```bash
# On m5
sudo apt-get install -y rsync build-essential
# Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
# Tailscale (assumed already set up on m5)
sudo tailscale set --accept-routes
# Enable Funnel on :14432 (static client) + :14433 (canary WT).
# The `--bg <target>` form binds the Funnel port to a specific loopback
# service. tools/deploy-prod.sh re-runs the equivalent bindings on every
# deploy, so you only need this once.
sudo /home/kyle/go/bin/tailscale funnel --https=14432 --bg http://127.0.0.1:14032
sudo /home/kyle/go/bin/tailscale funnel --https=14433 --bg http://127.0.0.1:14433
# Clone the repo to ~/Development/specialists-web
git clone https://github.com/klampatech/specialists-web.git ~/Development/specialists-web
cd ~/Development/specialists-web && git checkout main
```

### One-command deploy

```bash
# From anywhere with SSH to m5
ssh m5 'export PATH=/home/kyle/.cargo/bin:$PATH && cd ~/Development/specialists-web && bash tools/deploy-prod.sh'
```

The script (`tools/deploy-prod.sh`):

1. Verifies local HEAD matches `origin/main` (fast-forwards if behind).
2. Runs `cargo build --release` on the server binary (skip with `--no-rebuild`).
3. Kills any existing canary + serve-static.
4. Boots the canary via `tools/canary-server.sh` on `:14433` (WT) / `:14434` (WS) / `:14435` (WSS) + matchmaker HTTP on `:8084`.
5. Builds the client (`cd client && npm run build`).
6. rsyncs `client/dist/` to itself (same-host) and starts `tools/serve-static.mjs` on `127.0.0.1:14032`.
7. Wires Tailscale Funnel: `:14432` → `127.0.0.1:14032` (static), `:14433` → `localhost:14433` (canary WT).
8. Prints the public URLs and a play-test checklist.

### Public URLs (the actual game)

- **Static client:** `https://m5.tail1b3795.ts.net:14432/`
- **WebTransport:** `https://m5.tail1b3795.ts.net:14433/`
- **WSS fallback:** `https://m5.tail1b3795.ts.net:14435/`
- **Plain WS (Tailscale mesh only):** `ws://m5.tail1b3795.ts.net:14434/`

Tailscale Funnel gives us a real Let's Encrypt cert on `*.ts.net`, so browsers trust it without warnings. No port-fw, no domain-of-our-own, no self-signed cert dance.

### Tear-down

```bash
# On m5
kill "$(cat /tmp/canary-server.pid)" "$(cat /tmp/serve-static.pid)"
# Or just re-run the deploy — it kills + restarts.
```

### Logs

```bash
# Canary logs
tail -f /tmp/canary-deploy.log
# serve-static logs
tail -f /tmp/serve-static.log
```

## Smoke runs

### Against the live prod (Funnel)

```bash
# Local kyle box, with m5 SSH access — runs the smoke against the live URL
cd client/tools
PROD_BUNDLE_HOST=m5.tail1b3795.ts.net node lobby-e2e-smoke.mjs
```

This is the **load-bearing** smoke for prod. `lobby-e2e-smoke.mjs` defaults to `https://m5.tail1b3795.ts.net:14432/` (post-PR #166) — see its top-of-file comment for env-override syntax.

### Local dev canary (m5)

```bash
# On m5, run smokes against the local-loopback canary without going through Funnel
cd /home/kyle/Development/specialists-web/client/tools
PROD_BUNDLE_HOST=127.0.0.1 PROD_BUNDLE_PORT=14432 node lobby-e2e-smoke.mjs
node two-tab-smoke.mjs                  # connectivity, two tabs in same room
node damage-server-hp-convergence-smoke.mjs   # fire + HP decrement
```

These boot their own canary + vite dev server on `:5174` if not already running. They do **not** exercise the production bundle — that's what `lobby-e2e-smoke.mjs` and `fe-server-sync-matrix.mjs` are for.

### CI

`.github/workflows/ci.yml` runs the smoke matrix on every PR. The matrix smokes spin up canary + serve-static on **CI-locked ports** (per job, e.g. `24732`/`24733`/`24734`/`24735`/`24780` for the lobby-e2e job) to avoid collisions with each other and with on-host services; the lobby/matrix smokes use `localhost:<port>` for their prod-bundle-equivalent checks. See each job for exact port assignments.

## Known gaps / follow-ups

- **CI auto-deploy from main** (~2-3 hours). GitHub Action + secrets management to replace the manual `ssh m5 bash tools/deploy-prod.sh` flow. Useful once we want non-Kyle deploys.
- **Domain + Let's Encrypt for a user-owned DNS** (~1-2 hours). Currently the Funnel host (`m5.tail1b3795.ts.net`) is the Tailscale-provisioned LE cert. If you want `play.<your-domain>.com`, swap the funnel target and adjust `client/src/ui/Lobby.tsx:51`'s `PROD_MATCHMAKER_ORIGIN`.
- **No staging environment.** m5 hosts dev + prod on the same machine; canary + serve-static are bare processes (no systemd unit). Fine for now; risky if we add more deployers.

## Rollback

Each deploy is just a `git pull` + rebuild via the script above. To roll back to a specific commit:

```bash
ssh m5 'cd ~/Development/specialists-web && git fetch origin && git checkout <commit-sha> && bash tools/deploy-prod.sh'
```

This rebuilds the server binary + client bundle against the chosen SHA and restarts the canary + serve-static.

---

## Hetzner (historical deploy)

The Hetzner VPS at `65.108.87.1` was the prod host from roughly 2026-08-24 through 2026-09-04. It is **not currently deployed** and the public IP is no longer reachable. The deploy procedure below is preserved as historical reference only. If the Hetzner host comes back online, this section can be reactivated; otherwise delete it.

### Hetzner hosts / ports

| Port | Protocol | What |
|------|----------|------|
| `:14432` | HTTPS (self-signed) | Static client |
| `:14433` | HTTPS (WebTransport) | Canary wire server |
| `:14434` | WS (plain) | Canary fallback wire |
| `:14435` | WSS (TLS) | Canary fallback wire, encrypted |
| `:8084` | HTTP (loopback) | Matchmaker (proxied via serve-static) |

### One-time Hetzner bootstrap (historical)

```bash
# As root on the Hetzner box
DEBIAN_FRONTEND=noninteractive apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
  build-essential git curl ca-certificates \
  nodejs npm \
  rustc cargo \
  libssl-dev pkg-config \
  libnss3 libatk-bridge2.0-0t64 libxkbcommon0 libgtk-3-0t64 libgbm1 \
  libxrandr2 libxcomposite1 libxdamage1 libxfixes3 libpangocairo-1.0-0 libcairo2 \
  libasound2t64 gcc \
  ufw fail2ban

# Firewall
ufw allow 22/tcp
ufw allow 14432/tcp
ufw allow 14433/tcp
ufw allow 14434/tcp
ufw allow 14435/tcp
ufw allow 8084/tcp
ufw --force enable

# Clone + build
mkdir -p /root && cd /root
git clone https://github.com/klampatech/specialists-web.git
cd specialists-web
git checkout main
( cd server && cargo build --release )

# First-boot cert (self-signed, generated by canary-server on startup)
mkdir -p server/certs
```

### Hetzner systemd units (historical)

```ini
# /etc/systemd/system/specialists-server.service
[Service]
Environment=PATH=/root/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=CARGO_PROFILE=release
Environment=SANS=65.108.87.1,localhost,127.0.0.1
ExecStart=/root/specialists-web/server/target/release/specialists-server \
  --port-wt 14433 --port-ws 14434 --port-wss 14435 --port-http 8084 \
  --cert-source self-signed \
  --cert /root/specialists-web/server/certs/dev.pem \
  --key /root/specialists-web/server/certs/dev.key
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/specialists-static.service
[Service]
Environment=PORT=14432
Environment=HOST=0.0.0.0
Environment=ROOT=/root/specialists-web/client/dist
Environment=MATCHMAKER_URL=http://127.0.0.1:8084
Environment=TAILNET_IP=65.108.87.1
Environment=TLS_CERT=/root/specialists-web/server/certs/dev.pem
Environment=TLS_KEY=/root/specialists-web/server/certs/dev.key
ExecStart=/usr/bin/node /root/specialists-web/tools/serve-static.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### Hetzner regular deploy (historical)

```bash
# From any box with SSH access to Hetzner
ssh root@65.108.87.1 'cd /root/specialists-web && git pull origin main && bash tools/deploy-prod.sh && systemctl restart specialists-server specialists-static'
```

### Why Hetzner was deprecated

- **Manual scp + systemctl-restart deploy** was fragile (lost history of which SHA was actually live).
- **Self-signed cert** caused `ERR_CERT_AUTHORITY_INVALID` in non-trusting browsers; blocked sharing with friends on non-dev machines.
- **No domain** + **no LE cert automation** + **no staging** → every push was a coin flip on whether the live prod stayed up.
- The Funnel-based deploy on m5 keeps the same port shape (14432/14433/14434) but gets a real LE cert automatically and lives in the same repo as the dev canary (one source of truth).

### Migration notes

- All prod URLs are now `https://m5.tail1b3795.ts.net:{14432,14433,14435}`. The Hetzner URLs `https://65.108.87.1:{...}` no longer resolve.
- `tools/deploy-prod.sh` already targets m5; it ran against Hetzner before but the script is host-agnostic (just calls `cargo build` + `tools/canary-server.sh` + `tools/serve-static.mjs` locally + Funnel).
- Vite env at build time: `VITE_MATCHMAKER_ORIGIN` defaults to `https://m5.tail1b3795.ts.net:14432` (see `client/src/ui/Lobby.tsx:51`). Override with `--mode production --define` if you need a different origin.
- CI workflows still use `localhost:14432` / `localhost:14433`; no change needed there.
