# Specialists Web

Browser-native, multiplayer remake of *The Specialists* (2002 Half-Life mod).

The vibe: **John Woo × Matrix × Hong Kong Blood Opera** — a spectacle shooter where movement is the game.

## Status

**Phase 0 — The feel test.** Proving that movement + bullet time + rollback netcode feel right before we invest in matchmaking infrastructure.

See `~/Obsidian/mem/projects/specialists-web.md` for the canonical living spec.

## Stack

- **Client**: TypeScript + Vite + React + Babylon.js (WebGPU) + Havok physics + ggrs (rollback netcode)
- **Server** (Phase 1+): Rust + Tokio + Rapier (deterministic)
- **Transport**: WebTransport (UDP), WebSocket fallback

## Quickstart

```bash
cd client
npm install
npm run dev
```

Then open two browser tabs to `http://localhost:5173` and roll back.

## Repo structure

```
client/      TypeScript + Vite + React + Babylon + Havok + ggrs (Phase 0 lives here)
server/      Rust (Phase 1)
protocol/    Shared types (Phase 1)
tools/       Build / asset pipeline scripts
```

## License

TBD at public launch.

## Credits

- *The Specialists* (2002) — Filippo "Morfeo" De Luca, Lorenzo "John_Matrix" Pasini, and the TS community. Built on the original Half-Life by Valve.
- This is a clean-room reimplementation, not a port. We're inspired by the original, not infringing on it.
