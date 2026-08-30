# Specialists Web

Browser-native, multiplayer remake of *The Specialists* (2002 Half-Life mod).

The vibe: **John Woo × Matrix × Hong Kong Blood Opera** — a spectacle shooter where movement is the game.

## Status

**Phase 1 — Internet multiplayer: SHIPPED.** The Rust server runs, snapshots drive remote rigs across real machines, 24-player rooms are stress-tested, and CI is fully ungated (27/27 GREEN required checks). Phase 1 acceptance verified end-to-end on **2026-08-28** via the cross-machine live pilot (m5 headless Chrome + Kyle's MacBook real Chrome via Tailscale Funnel).

What's next is your call — see `HANDOFF.md` TL;DR for the current (a)/(b)/(c) options.

Canonical living spec: `docs/SPEC.md`. Session-to-session continuity: `HANDOFF.md`. Vault mirror: `~/Obsidian/mem/projects/specialists-web.md` (regenerate with `./tools/sync-spec-to-vault.sh` — never edit the vault copy directly).

## Stack

- **Client**: TypeScript + Vite + React + Babylon.js (WebGPU) + Havok physics. Snapshot-driven remote-rig interpolation (PR 11.7.D2 — `ggrs`/`peer`/`ggnet` retired from the runtime; P2P rollback substrate is gone).
- **Server**: Rust + Tokio + **Rapier** with the `enhanced-determinism` feature flag (load-bearing for the damage `PositionHistory` rewind contract — §2.4 in SPEC).
- **Transport**: WebSocket primary (per-room snapshot stream + 0x06 `InputsServer` + 0x0A `AimEvent` + 0x0B `MeleeEvent` future). WebTransport was the original target; WS proved the wire path first and WebTransport is staged for the matchmaker (PR 11.6.E).
- **Shared wire types**: `protocol/` (`constants.ts`, `snapshot.ts`, `damage.ts`) — TS-canonical, mirrored server-side in `server/src/transport.rs`.

## Quickstart

Two terminals. One for the server, one for the client.

```bash
# Terminal 1 — server (Rust)
./tools/canary-server.sh

# Terminal 2 — client
cd client
npm install
npm run dev
```

Open two browser tabs at `http://localhost:5173`. Tab A and Tab B will both connect to the local canary and see each other's rigs.

For cross-machine testing (m5 + MacBook over Tailscale Funnel), see `HANDOFF.md` — the live pilot recipe is in the 2026-08-28 entry.

## Repo structure

```
client/                  TypeScript + Vite + React + Babylon + Havok
  src/                   app source
  tools/                 smoke harness (~25 mjs scripts) + ammo/havok helpers
  test-data/             committed reference outputs for the regression smokes
server/                  Rust (Tokio + Rapier + enhanced-determinism)
  src/                   main, transport, snapshot, connection_outbound, …
  tests/                 cargo unit tests (108/108)
  certs/                 canary dev cert (CI pre-bakes this via actions/cache)
protocol/                shared wire types (TS-canonical, server-mirrored)
docs/SPEC.md             canonical living spec — phases, decisions, current status
HANDOFF.md               session-to-session continuity log
tools/
  canary-server.sh       local Rust server lifecycle (start/stop/log/tail)
  sync-spec-to-vault.sh  one-way mirror docs/SPEC.md → Obsidian vault
.github/workflows/ci.yml 27-job required-check matrix (zero opt-ins)
```

## CI

**27/27 GREEN required, zero `continue-on-error`.** Full damage-server + two-tab + Havok parity + 24-player stress + cross-machine matrices. Pre-PR smoke recipe in `HANDOFF.md` (the canary server harness + per-smoke primer deadlines).

CF-N1 (HP-convergence mpsc-saturation race) closed 2026-08-29 at the architectural root cause (per-room `SnapshotGenerator`). Diagnostic walk + lesson captured in `~/.hermes/skills/ci-smoke-flake-triage` Category 5.

## License

TBD at public launch.

## Credits

- *The Specialists* (2002) — Filippo "Morfeo" De Luca, Lorenzo "John_Matrix" Pasini, and the TS community. Built on the original Half-Life by Valve.
- This is a clean-room reimplementation, not a port. We're inspired by the original, not infringing on it.
