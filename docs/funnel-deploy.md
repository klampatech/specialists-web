# Production Tailscale Funnel Deploy (PR 11.6.E)

How to take a freshly-imaged dev box from "Funnel enabled in the
tailnet policy" to "the production server is responding at the Funnel
URL with a real Let's Encrypt cert."

This is the operator runbook for `tools/specialists-server.service`.
The systemd unit does most of the work; the steps below are the
one-time-per-host setup that has to happen before the unit can boot.

## Prerequisites

1. **Tailscale installed + signed in.**
   `tailscale status` should show this node's name.

2. **Tailscale Funnel enabled for this tailnet.**
   In the Tailscale admin console → DNS → "Funnel" → enable for the
   tailnet. Verify:
   ```
   tailscale set --auto-update
   ```
   (this is the gate that unlocks `tailscale funnel --https=...`).

3. **The specialists-web repo is at `/home/kyle/Development/specialists-web`.**
   The systemd unit hardcodes that path (it's a dev box, not a
   multi-tenant host). If your path differs, edit
   `tools/specialists-server.service` before installing.

4. **You can run `cargo build --release` on this box.**
   The unit invokes `canary-server.sh` which spawns `cargo run
   --release` of the server. First boot takes ~2 minutes while cargo
   compiles; subsequent boots are fast.

## One-time per host

### 1. Pull the repo + verify it builds

```sh
cd ~/Development/specialists-web
git pull origin main
cargo build --release --manifest-path server/Cargo.toml
```

### 2. Enable + start Funnel on :4433 (HTTPS) + :4435 (WSS)

```sh
sudo tailscale funnel --https=4433 on
sudo tailscale funnel --https=4435 on
```

These are idempotent — if Funnel is already on for a port, the command
is a no-op. Verify:
```sh
tailscale funnel status
# expect (post-11.6.E/Session-2):
#   https://m5.tail1b3795.ts.net:4433 (Funnel on)
#   |-- / proxy http://localhost:4433
#   https://m5.tail1b3795.ts.net:4435 (Funnel on)
#   |-- / proxy http://localhost:4435
```

NOTE: PR 11.6.E binds the server to `--port-wt 4433` (UDP, WebTransport),
`--port-ws 4434` (TCP, plain WS), and `--port-wss 4435` (TCP, TLS-wrapped
WS for HTTPS fallback). The systemd unit's ExecStartPre fails loud if
Funnel isn't configured on 4433, so you can't accidentally boot the server
on a port Funnel isn't proxying. The WSS listener reuses the same Let's
Encrypt cert as the WebTransport listener — `wss://` is a separate
listener on port 4435 because Funnel only forwards a single TCP port per
configured host:port, and the WS-port (4434) needs to stay plain for dev/CI
compatibility.

### 3. Install the systemd user unit

```sh
mkdir -p ~/.config/systemd/user
cp ~/Development/specialists-web/tools/specialists-server.service \
   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable specialists-server.service
```

Note: this is a **user** unit, not a system unit. It runs as your
user, with your cargo cache, against your checkout. That's the
right shape for a dev box — for production you would want a
dedicated `specialists` user + a system unit. That's out of scope
for this PR; we want the dev deploy working first.

### 4. Boot the server

```sh
systemctl --user start specialists-server.service
```

The unit's ExecStartPre gates on `tailscale funnel status | grep -q
"4433"`. If Funnel isn't on :4433, the unit refuses to boot (exit
1) with a clear message. If Funnel is on, ExecStartPost writes the
Let's Encrypt cert + key to `server/certs/lets-encrypt.{pem,key}`
and the server starts.

### 5. Verify

```sh
# Check the unit is healthy
systemctl --user status specialists-server.service

# Confirm both ports are listening
sudo ss -ltn | grep -E ':(4433|4434)'

# Hit the Funnel URL — expect the Let's Encrypt cert, NOT the
# self-signed dev cert
curl -v https://m5.tail1b3795.ts.net:4433/health 2>&1 | head -20
# expect: "subject: CN=m5.tail1b3795.ts.net" (or similar; whatever
# Tailscale issues), "issuer: CN=R10" or "CN=R11" (Let's Encrypt
# intermediate, NOT a self-signed dev cert).
```

Open `https://m5.tail1b3795.ts.net:4433/` in a browser (any browser,
any machine on any network — Funnel exposes it to the public
internet). The browser should show NO "Your connection is not
private" warning AND NO "self-signed certificate" warning. That's
the PR 11.6.E acceptance test.

## Operational notes

### Cert rotation

Tailscale rotates Let's Encrypt certs automatically every ~60-90
days. When the cert rotates:
1. Tailscale writes the new cert to its state dir.
2. Our systemd unit doesn't currently know to re-pull it.

For PR 11.6.E's scope, the operator's only recourse after a cert
rotation is `systemctl --user restart specialists-server.service`,
which re-runs ExecStartPost and rewrites the cert files.

A future PR (not in this scope) should add a `tailscaled`-driven
cert-rotation watcher — likely a `path-exists` systemd path unit
that watches the cert file in `/var/lib/tailscale/files/` and
triggers `ExecReload`. Filed as carry-forward.

> **Pre-cloud-cleanup status (2026-09-01)**: this is **formally
> deferred** as of the pre-cloud-cleanup PR (PR #98). The
> `systemctl --user restart` workaround is operator-bearable
> because Funnel certs rotate on a ~60-90 day cadence, not a
> continuous rate. The watcher PR will be opened when there's a
> real operational symptom (e.g. cert expires during a playtest
> and the operator wasn't watching). Until then, the workaround
> is documented here and in HANDOFF.md §Deferred.

### Funnel policy gate

If the tailnet admin disables Funnel (e.g., for an audit), the next
`systemctl --user start` or auto-restart will fail ExecStartPre with
"Tailscale Funnel on :4433 not configured." That's the right
behavior — the operator should notice the failure (visible in
`journalctl --user -u specialists-server.service`).

### Local dev mode

The dev path (`--cert-source self-signed`, default) is unaffected
by this unit. To run locally without going through Funnel:
```sh
bash tools/canary-server.sh                    # self-signed, ports 4433/4434
bash tools/canary-server.sh --cert-dir /tmp/x  # custom cert dir
```

The systemd unit only activates in `--cert-source letsencrypt`
mode. Self-signed boots still work via the same `canary-server.sh`
wrapper, just with the default cert source.

## What's NOT in PR 11.6.E (Session 2 + future PRs)

These are explicitly out of scope for this PR and live as
follow-ups in HANDOFF:

- **`client-tools-funnel-smoke` CI job**: spins up the canary in
  letsencrypt mode with a pre-baked cert (via `actions/cache`),
  probes `https://localhost:4433/health` + verifies WebTransport
  connection over HTTPS with no dev-cert warning. **Deferred** —
  requires self-hosted runner with `tailscale` installed +
  `[self-hosted, lampak-m5]` label infrastructure that doesn't
  exist yet. Filed as carry-forward. **Manual end-to-end
  verification path**: open `https://m5.tail1b3795.ts.net:4433/`
  in a browser (any network — Funnel exposes it to the public
  internet), verify no "Your connection is not private" warning
  AND no "self-signed certificate" warning. The browser's
  DevTools → Network → WS filter should show
  `wss://m5.tail1b3795.ts.net:4435/rooms/...` after a WebTransport
  failure fallback.
- **Matchmaker** — separate, opens up multi-room + lobby UI.
- **Cloud smoke** — once A is up, a real end-to-end cross-Tailnet
  test (you on the MacBook, me on m5, both hitting the Funnel URL).
- **Cert rotation watcher** — see "Cert rotation" above.
- **Dedicated `specialists` user + system unit** — for production
  multi-tenant deploys, not dev boxes.
- **Outbound mpsc + back-pressure review** — separate defensive PR.
