# Specialists Web — Living Spec

> **Canonical source of truth: this file.** `~/Obsidian/mem/projects/specialists-web.md` is a one-way mirror used for Obsidian's graph and offline reading — see `tools/sync-spec-to-vault.sh`. Never edit the vault copy; edits there get overwritten on the next sync. Edit here, on a branch, in a PR.

**Editing rule**: branch + PR. No direct pushes to `main`. Decisions, operating principles, and acceptance criteria are all version-controlled here. The vault entry is a stub pointer that gets regenerated.

## Operating Principles

### Playtest everything. Handing Kyle a broken game is unacceptable.

This is the single highest-priority discipline for this project. Every milestone, every feature, every Friday — there must be a real, playable thing in Kyle's hands.

**What this means in practice:**

- **Every milestone ends with a playable build.** Not "the code compiles." Not "the tests pass." A person can run it and experience the thing.
- **Every feature must be testable in isolation.** Don't bury a feature behind five other features. Build it, expose it, run it, see it.
- **"Done" means tested by a human, not just compiles.** A feature that compiles but doesn't work is not done. A feature that works on the developer's machine but not Kyle's is not done.
- **Broken/missing functionality = blocker, not "polish."** If something is broken in a build, it blocks the milestone. We don't push broken to "later."
- **Show, don't tell.** Rather than say "the character controller works," record a video, write a test report, or share a URL Kyle can hit. A description is not evidence.
- **Surface regressions explicitly.** If something that worked before stopped working, that's a regression. Surface it immediately, don't fast-path past it.
- **If you can't playtest it, you can't ship it.** If a build is unbuildable, unrunnable, or unverifiable, stop and fix the build before continuing.

**How this shows up in this spec:**
- Phase milestones have a "Definition of done" — each must include a playable acceptance test.
- HANDOFF.md sessions end with a "Playtest status" check-in.
- Decisions in the decision log reference what was tested, not just what was decided.

---

# Specialists Web

A browser-native, multiplayer-first remake of *The Specialists* (2002 Half-Life mod).
The vibe: **John Woo × Matrix × Hong Kong Blood Opera** — a spectacle shooter where movement is the game, not a side feature.

> **Working title: "Specialists Web"**. Final name TBD at public launch.

---

## Why this game

The Specialists was the first multiplayer game ever with bullet time. The feel came from:
- Player-triggered slow-mo with full air control — you could curve a shot mid-dive
- Stunt system: dive, slide, roll, flip, wallrun
- Kung fu / hand-to-hand combat with melee weapons
- Dual-wield + third-person camera toggle mid-fight
- 30+ customizable firearms
- Gamemodes: DM, TDM, **The One** (king-of-the-hill with superpowers), LMS, CTB

The reason people came back: **moments**. A slow-mo dual-pistol dive into a kung-fu combo is the marketing. Every mechanic should ladder to that.

---

## The stack (frozen for Phase 0)

**Client** (in-browser)
- **TypeScript** + **Vite** + **React** (UI shell)
- **Babylon.js** on **WebGPU** (rendering)
- **Havok** physics via wasm (character controller, world physics)
- **ggrs** (Rust GGPO-style rollback netcode, talks to TS via wasm)
- **WebTransport** (UDP over HTTP/3) for game traffic; **WebSocket** fallback for restricted networks

**Server** (Rust)
- **Tokio** + **Rapier** (deterministic mode) for the game server
- **WebTransport** server (currently `wtransport` crate)
- **Postgres** for accounts/state, **Redis** for ephemeral session state
- **Hetzner** hosting (already have muscle from world-factory)

**Why this stack:**
- Babylon.js is the strongest rendering story for browser FPS in 2026 — better PBR, better batching, first-class Havok integration, ships with a real game engine (loaders, GUI, animation state machine), not just a renderer
- Havok is the physics engine behind Half-Life 2, Halo, etc. — recently ported to wasm, free for web. Best off-the-shelf character controller for browser games
- ggrs/snapshot interpolation is the only sane way to do per-player bullet-time — each client runs the full sim at full speed and renders at variable speed. Server is just a relay + arbiter
- TypeScript everywhere — matches existing infra, no context-switch

**Rejected alternatives:**
- *Unity WebGPU export* — 50-100MB payload, slow cold start. Defeats "go to a URL, play in 5 seconds"
- *Three.js raw* — too much hand-rolled for an FPS (movement controller, animation blending, hit detection, bullet physics all from scratch)
- *Bevy → wasm* — matches world-factory stack but smaller community, fewer browser FPS examples, would burn weeks on tooling

---

## The phased MVP plan

Six phases. Each is a shippable thing. Don't build N+1 until N is solid.

### **Phase 0 — The feel test** (~2 weeks)
**Goal**: prove the hard parts (movement + bullet time + netcode) feel right before sinking months into matchmaking infra.

- One map (corridor + rooftop, hand-built in Blender)
- Two browser tabs, peer-to-peer via WebRTC (no dedicated server)
- Character controller: run, jump, dive, slide, wallrun, third-person toggle
- Bullet time with air control
- One gun (dual pistols), melee, no HUD complexity
- ggrs rollback netcode between two tabs
- Basic Babylon scene: skydome, lighting, two test character models (Mixamo)

**Out of scope**: dedicated server, accounts, matchmaking, multiple game modes, asset pipeline polish.

**Definition of done**: a person who plays it goes "this feels like The Specialists." Demonstrated via a playable build Kyle can hit (URL or local run) within the 2-week window.

### **Phase 1 — The real server** (~3 weeks)
- Dedicated Rust game server (Rapier deterministic)
- Matchmaker-free direct-connect (share a URL → join a friend)
- 2v2 / 4-player free-for-all
- 5 weapons, 2 maps
- Health, ammo, basic HUD
- WebSocket fallback for WebTransport-restricted networks

**Out of scope**: matchmaking, accounts, leaderboards.

### **Phase 2 — Lobbies & accounts** (~2 weeks)
- Discord OAuth (zero-friction)
- Web lobby: create room, join room, ready-up
- Simple MMR-based matchmaking (Glicko-2)
- Server browser by region
- Game mode selector: DM, TDM, The One

**Out of scope**: anti-cheat, voice chat, replays.

### **Phase 3 — Performance & content** (~3 weeks)
- 2 more maps, 5 more weapons, kung-fu combo system
- Asset pipeline: Draco + KTX2 + meshopt compression, CDN delivery
- Performance pass: BatchedMesh, instance rendering, draw-call budget
- Spectator mode, killcam, basic replay system
- Load test: 100 concurrent matches, profile hotspots

**Out of scope**: anti-cheat, voice chat, mobile.

### **Phase 4 — Public beta** (~3 weeks)
- Server-authoritative cheat detection (impossible movement, statistical anomalies)
- Report system, replay-based triage
- WebRTC voice chat (Agora or Daily)
- Anti-DoS on the matchmaker
- Soft launch: invite-only, then progressive rollout

**Out of scope**: mobile, ranked leagues, tournaments.

### **Phase 5 — Post-launch** (ongoing)
- Native level editor (in-browser)
- Mod-support / user-created content
- Workshop for community maps
- Tournaments with prizes
- Mobile companion app (stats, spectate, not play)

---

## Phase 0 — detailed plan

### Repo structure

```
~/Development/specialists-web/
├── client/                  # TypeScript + Vite + React + Babylon + Havok
│   ├── src/
│   │   ├── engine/          # Babylon scene, Havok integration, render loop
│   │   ├── game/            # Game logic, character controller, weapons
│   │   ├── net/             # ggrs integration, WebRTC + WebTransport adapters
│   │   ├── ui/              # React HUD, menus
│   │   └── main.tsx
│   ├── public/              # Static assets (mixamo models, kenney assets)
│   ├── package.json
│   ├── tsconfig.json
│   └── vite.config.ts
├── server/                  # Rust (later — Phase 1)
│   └── (placeholder)
├── protocol/                # Shared types (later — Phase 1)
│   └── (placeholder)
├── tools/                   # Build / asset pipeline scripts
│   └── (placeholder)
├── .github/
│   └── workflows/           # CI
├── README.md
├── LICENSE                  # TBD at public launch
└── .gitignore
```

**Phase 0 only the `client/` side is real.** The rest is empty placeholders so the structure is obvious.

### Asset strategy for Phase 0

**Goal**: highest quality assets without human intervention.

- **Characters**: Mixamo (acrobat + handgun kits) — free, animatable, web-friendly
- **Map textures**: Kenney CC0 kit
- **Map geometry**: hand-built in Blender (one map: corridor + rooftop)
- **Audio**: freesound CC0 sets (gunshots, impacts, footsteps)
- **HUD/icons**: Kenney + game-icons.net

### CI

- GitHub Actions: typecheck, lint, build, Playwright headless smoke test
- Deploy preview: Vercel or CloudFront (auto on PR)

### Phase 0 milestones

| Week | Milestone | Playtest acceptance |
|------|-----------|---------------------|
| 1 | Repo scaffolded, Vite + Babylon + Havok running, single-player character controller in a static scene | Kyle can open a URL in a browser and walk a character around an empty map. Movement must feel right (run, jump, dive, slide, wallrun, third-person toggle). |
| 2 | ggrs integrated, two tabs can roll back, single weapon + melee, bullet time, third-person toggle | Kyle can open two browser tabs, see the other player, dive/slide/wallrun, fire a gun, hit with melee, trigger bullet time with mid-air shots, and feel the rollback netcode is correct (no teleport, no desync). |

### Phase 0 — architecture details

#### ggrs ↔ Babylon ↔ Havok wiring (the hard part)

The non-obvious thing: **Babylon and Havok both simulate physics.** We need one canonical physics authority per client, and that's Havok. Babylon reads Havok's transforms for mesh sync; it does **not** run its own physics for gameplay.

```
┌─────────────────────────────────────────────────────────────┐
│                          CLIENT                              │
│                                                             │
│  Input ──► ggrs.GGRSession (collects inputs, drives ticks)  │
│                │                                            │
│                ▼                                            │
│         Game.tick(gs, inputs)                               │
│            │       │                                        │
│            │       └──► Havok.characterController.move()    │
│            │             │                                  │
│            │             ▼                                  │
│            │       Havok.physicsWorld.step()                │
│            │             │                                  │
│            │             ▼                                  │
│            └──► Mesh transforms = Havok transforms          │
│                                                             │
│  Babylon.scene.onBeforeRenderObservable ──► render meshes   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Tick loop** (every frame, ggrs advances and we render):
1. ggrs reports which inputs we have for frame N (locally captured, remote via rollback).
2. Game.applyInputs(gs, inputs) — converts inputs to intent (move, jump, fire, dive).
3. Havok controller applies intent → physics step.
4. Babylon meshes read rig.position / rotation from a thin "Player" object that wraps Havok's transform.
5. Render.

**Why this order**: physics is the source of truth, not Babylon. If we ever need a server (Phase 1), the server runs the same physics step with the same inputs — full determinism. Animation, FX, camera all **render only**. They never feed back into the sim.

**Havok capsule behavior**: we use Babylon's `PhysicsCharacterController` (Havok-backed). Default settings: 0.5m radius, 1.8m height, slope 45°, step 0.3m. **Tune anything in `client/src/engine/characterConfig.ts`** — never hard-code in the controller.

**Determinism rule**: every physics-affecting input is a frame-aligned integer (button bitmask + normalized analog). Never read `Date.now()` or `performance.now()` inside the tick.

#### WebRTC peer bootstrap (Phase 0 signalling)

Two browser tabs need to find each other. Phase 0 has no server, so the bootstrap is manual — share a link, paste the offer, paste the answer. This is intentional: we don't want to spend engineering time on a signalling server until we've proved the thing is fun.

**Flow** (host = tab that opened the room; guest = tab that joined via URL):

1. Host clicks "Create Room" → generates an SDP offer + ICE candidates.
2. Host displays a copy-pasteable blob (base64 of the SDP+ICE) and a URL like `?join=<blob>`.
3. Guest opens the URL → parse blob → generates an SDP answer → displays copy-pasteable blob back.
4. Host pastes guest's answer blob → both sides now have full SDP+ICE on each other.
5. WebRTC `RTCPeerConnection` opens a `RTCDataChannel` for game inputs (reliable ordered) and one for time-sensitive state (unreliable unordered).
6. Both tabs connect to ggrs → ggrs drives the rollback loop.

**Why no signalling server in Phase 0**: we want to prove the *feel* before investing in matchmaking infra. The copy-paste dance is annoying but it lets us land Phase 0 in 2 weeks instead of 4. Phase 1 replaces this with a Rust WebTransport server + a `/create` + `/join` REST endpoint.

**Implementation sketch** (`client/src/net/peer.ts`):
- One `WebRTCPeer` class wraps `RTCPeerConnection` + ICE handling.
- One `ClipboardPayload` type for the offer/answer blob (`{ sdp: string, candidates: RTCIceCandidateInit[] }`).
- Browser context menu exposes "Copy join link" / "Paste answer" — no React UI yet, raw `<button>`s on a debug overlay.

**Pitfall to avoid**: don't try to use WebRTC's auto-signalling (it doesn't exist — WebRTC always needs an out-of-band channel). The copy-paste is that channel.

#### Asset import pipeline

Phase 0 doesn't need a real pipeline — we drop pre-baked assets in `client/public/` and vitedev-serve them. The build-time pipeline is a Phase 3 concern. Here's what's in place for Phase 0:

**Source-of-truth files** (manual drops into `client/public/`):
- `models/` — Mixamo FBX exports, decompressed (no FBX in browser — convert to glTF first via `npx fbx2gltf`)
- `textures/` — Kenney CC0 PNGs, no compression (Phase 0 size budget is loose)
- `maps/` — Blender `.glb` exports of the test map (corridor + rooftop)
- `audio/` — freesound CC0 WAVs → convert to OGG with `ffmpeg` on import

**Loading pattern** (`client/src/engine/loader.ts`):
- `async loadCharacter(name: string): Promise<TransformNode>` — caches by URL, returns a Babylon `TransformNode` with the mesh + animation groups attached
- `async loadMap(name: string): Promise<Scene>` — builds a Babylon `Scene` from the `.glb`, returns it ready to attach to the engine
- `async loadAudio(name: string): Promise<Sound>` — Babylon sound handle

**Phase 0 budget**: client's initial JS+wasm payload should be under 5MB; assets are loaded lazily. Verify with `vite build --mode production && du -sh client/dist/assets/`.

**Phase 3 upgrade path** (placeholder, **don't build yet**): meshopt + KTX2 + Draco compression, CDN delivery, BatchedMesh for environment props. Architecture leaves room (the loader is a wrapper, not a Babylon singleton) but the optimization itself is out of scope.

### Phase 0 — milestone acceptance criteria (expanded)

The Phase 0 milestones table above is a one-liner. Below is the same info plus the *testable* acceptance criteria per milestone. Each item here is something Kyle can run and verify.

#### Milestone 1 — single-player feel (week 1)

| Acceptance criterion | How Kyle verifies |
|---|---|
| `npm install && npm run dev` boots a browser at `http://localhost:5173` | Page returns 200; React renders; no console errors |
| Babylon.js canvas is visible, scene has skydome + 1 directional light | Screenshot shows lit scene |
| A character model (Mixamo) is standing in the scene at origin | Visible in viewport |
| WASD moves the character, with smooth acceleration/deceleration | Hold W for 1s → character moves forward; release → character decelerates over ~0.3s |
| Space jumps (single, double-jump disabled in Phase 0) | Tap Space → character jumps, height ~1.5m |
| Shift toggles dive (forward + dive for 0.8s anim) | Tap Shift while moving → character dives forward |
| C toggles crouch/slide | Hold C + W → character slides |
| Q triggers wallrun if airborne near a wall at angle | Side approach wall, jump toward it → wallrun along wall for ~1s |
| V toggles third-person ↔ first-person camera | Press V → camera moves from over-shoulder to eye-level |
| Havok physics is the source of truth (verify by toggling Babylon physics off in DevTools) | Physics off → character doesn't move when WASD pressed |

**Done =** all 10 criteria pass in Kyle's browser.

#### Milestone 2 — netcode + combat (week 2)

| Acceptance criterion | How Kyle verifies |
|---|---|
| Two browser tabs can complete the WebRTC handshake (copy-paste dance) | Both tabs show "Connected" overlay |
| Each tab sees the other player's character in the same scene | Tabs side-by-side, both show 2 characters |
| Local input latency feels < 1 frame on remote view | Move in tab A → tab B sees motion within ~50ms |
| Rollback correction is invisible under 100ms simulated lag | `chrome://network-conditions` → set 100ms throttle; move erratically; no visible teleport |
| Firing the dual pistols (LMB) shoots a raycast that draws a tracer | Click LMB → tracer line from gun to hit point |
| Melee attack (RMB) hits within 1.5m cone | Approach within 1.5m, RMB → hit indicator on target |
| Holding T toggles bullet time (0.25x speed, full air control) | Hold T → time slows visibly, character can curve shots mid-air |
| Bullet time is independent per player (offensive + defensive mode) | Both players in bullet time independently; presses feel right |
| Health → 0 → respawn at spawn point | Take 100 damage → 1s respawn timer → back at spawn |
| One full minute of two-tab play = no console errors, no desync, no rubberbanding | Both tabs stay in sync for 60s |

**Done =** all 10 criteria pass with Kyle driving both tabs.

### Phase 0 risks

- **Netcode for bullet-time is the make-or-break.** This is the highest-risk single component. If it doesn't feel right, nothing else matters.
- **The "feel" of TS is the entire game.** Character controller, animation blending, screen shake, camera FOV bumps during dives, hit-stop on punches — these are the things that made TS feel like TS. Hard to spec, hard to test, easy to ship something that looks right but feels wrong.
- **Scope creep.** 30 weapons, 4 game modes, dual-toggle camera, 5 maps, customization, particle effects, etc. — none of it at launch. Pick a tight v1.

---

## Working with this doc

- **This file is the canonical source of truth.** Edit here, on a branch, in a PR. The vault entry at `~/Obsidian/mem/projects/specialists-web.md` is a one-way mirror for Obsidian's graph — never edit it directly, it gets overwritten on the next sync.
- **Top of file**: status, dates, repo location, sync notes. Update when phase changes.
- **Phase sections**: append-only as we complete work. Don't rewrite history — mark superseded phases with `(superseded by Phase N)` so we can chase the reasoning later.
- **Decisions**: log in the Decisions section below as we make them. Each decision = why + when + what we picked + what we rejected.
- **Open questions**: log in the Open Questions section. Surface blockers for the next session.
- **Session log**: see `HANDOFF.md` in the repo for session-to-session continuity.
- **Syncing to the vault**: run `./tools/sync-spec-to-vault.sh` from the repo root after merging changes here. One-way: repo → vault.

---

## Decisions

### 2026-08-11 — Stack picks
- **Client**: TS + Babylon.js on WebGPU + Havok + ggrs via wasm
- **Server**: Rust + Tokio + Rapier (deterministic)
- **Transport decision (2026-08-11)**: Phase 0 uses **WebRTC peer-to-peer** between two browser tabs (no dedicated server). Phase 1+ uses **WebTransport** (UDP over HTTP/3) for client→server traffic, with **WebSocket** fallback when WebTransport is unavailable. WebRTC stays as the option for peer-to-peer data channels in Phase 5+ (spectator relays, custom net topologies). **Why split**: WebRTC is the only browser-to-browser transport — no signalling server needed for Phase 0 feel test. WebTransport is the right client→server transport once a server exists, but it's not browser-to-browser. Don't relitigate this in Phase 0.
- **WebSocket fallback**: deferred to Phase 1 (only matters when there's a server)
- **Hosting**: Hetzner (matches existing infrastructure)
- **Auth (eventually)**: Discord OAuth (zero-friction)
- **Asset strategy**: Mixamo + Kenney CC0 for Phase 0
- **Working title**: "Specialists Web" — final name TBD at public launch

### 2026-08-11 — Project location
- **Vault**: `~/Obsidian/mem/projects/specialists-web.md` (this file)
- **Repo**: `~/Development/specialists-web/`
- **Remote**: `github.com/klampatech/specialists-web`

### 2026-08-11 — Legal/IP stance
- Don't worry about it during prototyping. Revisit at public launch.
- Original IP, different name, no verbatim copy. Clean and safe approach.

---

## Open questions

- **Final game name** — pick at public launch. Need a memorable, search-friendly name that doesn't collide with "The Specialists" brand.
- **Mobile** — likely no for play. Companion app for stats/spectate is the only mobile play.
- **Voice chat provider** — Agora vs Daily vs self-hosted. Decide at Phase 4.
- **Account persistence** — Discord OAuth only, or also email/password? Decide at Phase 2.
- **Modding support** — defer to Phase 5. Architecture should leave room (scripting hooks, asset pipelines) but not design for it.

---

## Session log

### 2026-08-11 — kickoff
- Kyle: "I'd like to essentially bring this version of the specialists into the browser. It must be multiplayer and available to anyone on the web to play."
- Pulled ModDB page, Fandom wiki, scouted WebGPU/netcode state of the art in 2026.
- Evan ended on: "Document the *vision* and the *plan*, then start building."
- Kyle: "I want a canonical living spec to grow alongside this project and track our work. So write the phased MVP plan and then we can fill in the details for phase 0."
- Created this vault doc + repo + remote. Next session: fill in Phase 0 details.
- Spec also checked into repo as `SPEC.md` (synced from vault). `HANDOFF.md` added for session-to-session continuity.
- **Operating principle added**: "Playtest everything. Handing Kyle a broken game is unacceptable." Each milestone ends with a playable build. Each session-end handoff has a mandatory Playtest status block. Phase 0 milestones now have playtest acceptance criteria.
- Kyle will start Phase 0 in the next session.
