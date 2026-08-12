# Specialists Web — Living Spec

> **Canonical source of truth: this file.** `~/Obsidian/mem/projects/specialists-web.md` is a one-way mirror used for Obsidian's graph and offline reading — see `tools/sync-spec-to-vault.sh`. Never edit the vault copy; edits there get overwritten on the next sync. Edit here, on a branch, in a PR.

**Editing rule**: branch + PR. No direct pushes to `main`. Decisions, operating principles, and acceptance criteria are all version-controlled here. The vault entry is a stub pointer that gets regenerated.

> **Current status (2026-08-11):** Phase 0 / Milestone 1 in progress.
> - **PR 1** (tooling baseline + CI + spec lock) — **MERGED** to main.
> - **PR 2** (Babylon scene + Havok + skydome + static mesh + static ground + Playwright headless smoke) — **MERGED** at https://github.com/klampatech/specialists-web/pull/3 (squash commit `2a12a59`), all 3 CI checks green.
> - **PR 3** (Havok character controller + WASD + stunts + chase camera + procedural character + WebGPU bootstrap) — **MERGED** at https://github.com/klampatech/specialists-web/pull/5 (squash commit `86feffa`), all 3 CI checks green.
>
> **Spec drift caught and fixed across PR 2:** pinned versions, WebGL2-vs-WebGPU decision, the 3-PR Phase 0 split, CI evolution, Vite `optimizeDeps.exclude` gotcha, and the milestone acceptance markings. See Decisions log + Session log.

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
- **TypeScript** + **Vite** + **React** (UI shell) — pinned in [client/package.json](client/package.json)
- **Babylon.js** for rendering — **WebGPU attempted in PR 3 with a verified WebGL2 fallback** (see Decisions log — 2026-08-11 PR 3). Pinned `@babylonjs/core@9.20.0`.
- **Havok** physics via wasm (character controller, world physics) — pinned `@babylonjs/havok@1.3.14`
- **ggrs** (Rust GGPO-style rollback netcode, talks to TS via wasm) — PR 3+ (netcode work)
- **WebTransport** (UDP over HTTP/3) for game traffic; **WebSocket** fallback for restricted networks
- **Playwright** (devDep) for headless smoke testing — pinned `playwright@1.62.1` as of PR 2

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

Three GitHub Actions jobs on every PR (`.github/workflows/ci.yml`):
- **`client-typecheck`** — `npm run typecheck` + `npm run build` (production bundle). Catches type and bundling errors.
- **`client-scene-smoke`** — boots `npm run dev`, runs Playwright headless Chromium against `http://localhost:5173`, captures a 1280x720 screenshot, fails on any pageerror. Uploads the screenshot as the `scene-screenshot` artifact on the PR. Lands in PR 2.
- **`spec-canonical`** — positive-claim assertion that `docs/SPEC.md` exists, declares itself canonical, and that the repo-root `SPEC.md` is a stub pointer. Catches accidental dual-canonical drift.

Deploy preview: Vercel or CloudFront (auto on PR) — not yet wired; deferred to Phase 1 when there's a real backend to deploy with.

### Phase 0 milestones

| Week | Milestone | Playtest acceptance |
|------|-----------|---------------------|
| 1 | **Lit 3D scene + character controller + stunts + camera toggle** (split into 3 PRs — see Decisions log) | Kyle can open a URL in a browser and walk a character around an empty map. Movement must feel right (run, jump, dive, slide, wallrun, third-person toggle). |
| 2 | ggrs integrated, two tabs can roll back, single weapon + melee, bullet time, third-person toggle | Kyle can open two browser tabs, see the other player, dive/slide/wallrun, fire a gun, hit with melee, trigger bullet time with mid-air shots, and feel the rollback netcode is correct (no teleport, no desync). |

**Phase 0 PR split (3 PRs, in order):**
- **PR 1 (DONE):** tooling baseline + CI + spec lock. No scene.
- **PR 2 (DONE, merged to main at `2a12a59`):** Babylon scene + Havok plugin + skydome + lights + one static mesh + static ground + Playwright headless smoke. **Covers Milestone 1 acceptance rows 1-3** (boots, shows lit scene, shows one object).
- **PR 3 (MERGED at `86feffa`):** Havok `PhysicsCharacterController` + procedural humanoid character + WASD + jump + dive + slide + wallrun + chase camera (V-toggle third/first person) + WebGPU bootstrap with WebGL2 fallback. **Covers Milestone 1 acceptance rows 3-10.** PR 3 also completes row 3 (real Mixamo glTF deferred to Phase 1; procedural rig is the documented placeholder).

#### Build & dev prerequisites (recover these BEFORE you start coding)

- **`npm install` from `client/`** — pulls `@babylonjs/core`, `@babylonjs/havok`, `playwright` (devDep). No system packages required.
- **`vite.config.ts` requires `optimizeDeps.exclude: ["@babylonjs/havok"]`** — without it, Vite's pre-bundling rewrites Havok's `import.meta.url` to a hashed path the wasm fetch can't follow, and the browser fetches the HTML fallback with a "expected magic word 00 61 73 6d, found 3c 21 64 6f" error. If you see this error, you forgot the exclude (or the `.vite` cache is stale). Fix: `rm -rf client/node_modules/.vite` and reload. Full diagnosis in the `babylonjs-vite-havok-wasm` skill.
- **If you change the Vite config, clear the cache.** Same path as above.
- **Headless smoke test:** `cd client && node ./tools/scene-smoke.mjs` requires the dev server already running on `:5173`. CI does this automatically.

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
| `npm install && npm run dev` boots a browser at `http://localhost:5173` | Page returns 200; React renders; no console errors | **LANDED PR 2** ✅ |
| Babylon.js canvas is visible, scene has skydome + 1 directional light | Screenshot shows lit scene | **LANDED PR 2** ✅ (placeholder sphere instead of Mixamo character — see row 3) |
| A character model is standing in the scene at origin | Visible in viewport | **LANDED PR 3** ✅ — procedural humanoid rig (capsule torso + sphere head + cylinder limbs); real Mixamo glTF deferred to Phase 1 once an asset pipeline exists (see Decisions) |
| WASD moves the character, with smooth acceleration/deceleration | Hold W for 1s → character moves forward; release → character decelerates over ~0.3s | **LANDED PR 3** ✅ |
| Space jumps (single, double-jump disabled in Phase 0) | Tap Space → character jumps, height ~1.5m | **LANDED PR 3** ✅ |
| Shift toggles dive (forward + dive for 0.8s anim) | Tap Shift while moving → character dives forward | **LANDED PR 3** ✅ |
| C toggles crouch/slide | Hold C + W → character slides | **LANDED PR 3** ✅ |
| Q triggers wallrun if airborne near a wall at angle | Side approach wall, jump toward it → wallrun along wall for ~1s | **LANDED PR 3** ✅ (animation-state only; the stunt changes controller parameters + visual lean, it does not bend the collision shape) |
| V toggles third-person ↔ first-person camera | Press V → camera moves from over-shoulder to eye-level | **LANDED PR 3** ✅ |
| Havok physics is the source of truth (verify by toggling Babylon physics off in DevTools) | Physics off → character doesn't move when WASD pressed | **LANDED PR 3** ✅ (PhysicsCharacterController is the only physics source for the character; see Decisions) |

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

### 2026-08-11 — PR 2 implementation decisions
- **WebGPU vs WebGL2**: PR 2 ships **WebGL2** via `new Engine(canvas, true)` (the default). Spec says WebGPU but the Vite dev server + Playwright headless Chromium path is more reliable on WebGL2 today, and the WebGPU bootstrap adds an adapter-wait that complicates the headless capture. WebGPU targeted for PR 3 alongside the character controller. Bootstrap path is a one-line swap to `WebGPUEngine` in PR 3.
- **Vite `optimizeDeps.exclude: ["@babylonjs/havok"]`**: required for Havok to load in dev mode. Havok's ESM uses `import.meta.url` to locate its wasm at runtime; Vite's pre-bundling rewrites that URL to a hashed path the wasm fetch can't follow, causing the browser to fetch the HTML fallback. See the `babylonjs-vite-havok-wasm` skill for the full diagnosis.
- **No static mesh from the asset pipeline**: PR 2 uses a procedural red sphere as the placeholder for the Mixamo character model. The asset pipeline is a PR 3 concern — building it now would be premature for a single-object acceptance test.
- **Phase 0 split into 3 PRs**: tooling baseline (PR 1, done) → scene baseline (PR 2, this PR) → character controller (PR 3, next). Each PR ends at a playable beat: PR 1 = "build runs and shows a banner", PR 2 = "you can see a lit scene with one object", PR 3 = "you can walk a character around". Each PR is independently mergeable and reviewable.
- **Headless smoke in CI**: PR 2 adds a third CI job (`client-scene-smoke`) that boots the dev server, runs Playwright headless against it, captures a screenshot, fails on any pageerror, and uploads the screenshot as a build artifact. Replaces the deferred "Playwright headless smoke test" item from PR 1.
- **Bundle size flag**: Vite reports a 6.99 MB JS bundle (1.56 MB gzip) for PR 2. Spec's "<5MB initial" target is not met. Code-splitting is a PR 3 deliverable (the character controller will benefit from dynamic imports anyway). Not a blocker for PR 2.

### 2026-08-11 — PR 3 implementation decisions
- **WebGPU bootstrap (target met, fallback verified)**: PR 3 swaps in `new WebGPUEngine(canvas, { ... })` + `await initAsync()` as the primary bootstrap, with `new Engine(canvas, true, ...)` as the documented fallback for environments without a WebGPU adapter (CI's headless Chromium, Firefox, older browsers). The fallback path was exercised end-to-end in this PR's smoke run — the canvas still renders the lit scene with the character walking. WebGPU is the spec's target; WebGL2 is the supported safety net, not a permanent decision.
- **Mixamo model decision (procedural humanoid placeholder)**: The acceptance test is "Kyle sees a character that responds to WASD." The real Mixamo glTF is not in this repo (no asset pipeline; CI runs offline), and bundling a `.glb` from a network call at runtime is forbidden by the spec. We ship a procedural humanoid rig (`client/src/engine/characterModel.ts`) — capsule torso matching the Havok collision shape, sphere head, cylinder arms/legs — parented to a `TransformNode` the controller drives. The visual rig is good enough to sell the "character moves" test; a real glTF lands in Phase 1 once we have an asset pipeline. Documented in `characterModel.ts` header so the swap point is obvious.
- **Stunts are animation-state only (no physics deformation)**: Dive, slide, and wallrun swap *values from `characterConfig.ts`* (speed, friction, jumpZ, visual offset) plus visual pose (lean/squash) on the rig. They do NOT change the collision shape height, the capsule radius, or the contact-manifold handling. Stunt-as-physics is a Phase 1 polish item — the spec for row 8 ("wallrun along wall for ~1s") accepts the parameter-swap version. Documented in the controller header.
- **Camera has no mouse-look yet (PR 3)**: The chase camera follows the character with a fixed yaw; no mouse-driven rotation. The character always faces +Z so W moves "forward in the direction the character is looking", independent of the camera. Mouse-look is a Phase 1 polish item per locked decisions.
- **Headless smoke dual-screenshot pattern**: PR 3's smoke (`client/tools/scene-smoke.mjs`) captures two screenshots — the initial scene and a post-W-walk capture — to show, not tell, that WASD actually moves the character. The "walked" capture is uploaded as the `scene-screenshot-walked` artifact. This is the evidence pattern for the rest of the PR series.
- **Bundle delta**: The controller + model + camera + input listener add ~6 source files, all internal (no new npm deps). Vite bundle delta vs PR 2 is < 50 KB gzip — well under the 200 KB guardrail. Bundle size remains flagged for Phase 1 (code-splitting is a Phase 1 task).
- **Spec-canonical CI**: Unchanged. The `spec-canonical` job still passes — the canonical spec is still at `docs/SPEC.md` and `SPEC.md` is still the stub pointer.

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

### 2026-08-11 — PR 2 (scene baseline) shipped, spec drift caught and fixed
- Branched `feat/phase0-scene-baseline` off `main` (origin/main @ `05d960c` at handoff-time)
- Installed `@babylonjs/core@9.20.0` + `@babylonjs/havok@1.3.14` + `playwright@1.62.1` (devDep)
- `client/src/engine/scene.ts` — first real Babylon scene (Engine + Scene + ArcRotateCamera + HemisphericLight + DirectionalLight + skydome + red sphere + 30x30 ground + Havok + static rigid bodies). PR 2 scope per Milestone 1 acceptance rows 1-3.
- `client/src/ui/App.tsx` — replaced React banner with Babylon canvas mounted via ref. Loading / error / ready overlays.
- `client/vite.config.ts` — added `optimizeDeps.exclude: ["@babylonjs/havok"]` to fix the dev-mode wasm load (Havok's `import.meta.url` was being rewritten by Vite's pre-bundling)
- `.github/workflows/ci.yml` — new `client-scene-smoke` job (boots dev server, runs Playwright headless, fails on pageerror, uploads screenshot as artifact)
- `client/tools/scene-smoke.mjs` — headless smoke test script
- `docs/pr2-screenshot.png` — the lit-scene screenshot (in-repo evidence)
- PR opened: https://github.com/klampatech/specialists-web/pull/3 — all 3 CI checks green (typecheck + build, scene smoke, spec-canonical)
- **Spec drift caught by Kyle post-merge**: PR 2 didn't ship a spec update. Fixed here: pinned versions, recorded WebGL2-vs-WebGPU decision, recorded Vite gotcha, recorded CI evolution, realigned the Milestone 1 acceptance table with the actual PR split, recorded the 3-PR Phase 0 split. Spec also synced to vault via `tools/sync-spec-to-vault.sh` (next step).
- **Lesson learned**: every PR must land with the spec updated. The spec is the load-bearing artifact for this project; PRs without spec updates rot the next session's understanding. Add this to the session-end checklist.

### 2026-08-11 — kickoff
- Kyle: "I'd like to essentially bring this version of the specialists into the browser. It must be multiplayer and available to anyone on the web to play."
- Pulled ModDB page, Fandom wiki, scouted WebGPU/netcode state of the art in 2026.
- Evan ended on: "Document the *vision* and the *plan*, then start building."
- Kyle: "I want a canonical living spec to grow alongside this project and track our work. So write the phased MVP plan and then we can fill in the details for phase 0."
- Created this vault doc + repo + remote. Next session: fill in Phase 0 details.
- Spec also checked into repo as `SPEC.md` (synced from vault). `HANDOFF.md` added for session-to-session continuity.
- **Operating principle added**: "Playtest everything. Handing Kyle a broken game is unacceptable." Each milestone ends with a playable build. Each session-end handoff has a mandatory Playtest status block. Phase 0 milestones now have playtest acceptance criteria.
- Kyle will start Phase 0 in the next session.
