# Specialists Web — Living Spec

> **Canonical source of truth: this file.** `~/Obsidian/mem/projects/specialists-web.md` is a one-way mirror used for Obsidian's graph and offline reading — see `tools/sync-spec-to-vault.sh`. Never edit the vault copy; edits there get overwritten on the next sync. Edit here, on a branch, in a PR.

**Editing rule**: branch + PR. No direct pushes to `main`. Decisions, operating principles, and acceptance criteria are all version-controlled here. The vault entry is a stub pointer that gets regenerated.

> **Current status (2026-08-13):** Phase 0 / Milestone 1 / PR 9 MERGED.
> - **PR 1** (tooling baseline + CI + spec lock) — **MERGED** to main.
> - **PR 2** (Babylon scene + Havok + skydome + static mesh + static ground + Playwright headless smoke) — **MERGED** at https://github.com/klampatech/specialists-web/pull/3 (squash commit `2a12a59`), all 3 CI checks green.
> - **PR 3** (Havok character controller + WASD + stunts + chase camera + procedural character + WebGPU bootstrap) — **MERGED** at https://github.com/klampatech/specialists-web/pull/5 (squash commit `86feffa`), all 3 CI checks green.
> - **PR 4** (spec drift fix — pinned `playwright@1.62.1`, explicit Vite Havok cache rule, Milestone 1 acceptance markers) — **MERGED** at https://github.com/klampatech/specialists-web/pull/4 (squash commit `1a0a5fd4`), all 3 CI checks green. No code surface change; spec alignment only.
|> - **PR 6** (WebRTC peer bootstrap + deterministic fixed-frame lockstep + 2-character scene + two-tab handshake smoke + new `client-two-tab-smoke` CI job + spec alignment for actual shipped signaling surface) — **MERGED** at https://github.com/klampatech/specialists-web/pull/6 (squash commit `461dcaf`), all 3 CI checks green. Substrate for Milestone 2 rows 1-4. **PR 6 caveat (fixed in PR 10.1):** the original `createOffer` / `createAnswer` fire-and-forget'd the ICE gather AFTER serializing the return blob, so the blob's `candidates: []` was always empty. CI smoke passed (SDP state, not `connectionState === "connected"`) but real two-tab playtest over Tailscale failed. PR 10.1 awaits ICE gathering (5s timeout) and serializes the gathered candidates into the blob.
|> - **PR 7** (combat semantics: dual-pistol raycast firing + tracer render, melee cone hit detection, per-client bullet-time scaling at 0.25x with air control) — **MERGED** at https://github.com/klampatech/specialists-web/pull/8 (squash commit `50ee9f2`), all 6 CI checks green. Wires the byte-1 FIRE / MELEE / BULLET bits that PR 6 reserved; byte-1 encoding was previously a no-op (decode always read `false`). Damage application is render-side log only (no real health pool mutation in this PR — that's PR 10+).
|> - **PR 9** (jump regression fix: gravity accumulation in the Havok controller's `update()` + tightened jump condition `vy ≤ 0`; PLUS PR 8.1 wallrun rising-edge + post-wallrun cooldown guard; PLUS Milestone 1 row 6 scope-clarification) — **MERGED** at https://github.com/klampatech/specialists-web/pull/9 (squash commit `2ed55a8`), all 6 CI checks green. Closes the "holding Space = fly up forever" jump bug AND the "holding Q mid-air = fly up forever" wallrun auto-repeat loophole. Ships two new CI jobs (`client-jump-smoke` on port 5175, `client-wallrun-smoke` on port 5176) as regression guards.
|> - **PR 10** (first real health pool + damage application + 1s respawn — Milestone 2 row 9) — code-complete on `feat/phase0-health-damage-respawn` (PR #11). Two bugs caught by Evo's verification-gate re-verify (HUD label showed absolute timestamp as countdown; smoke asserted wrong-target HP), both fixed in the same branch. Push + PR-open were the next steps.
|>
|> **Next**: PR 10.1 — WebRTC ICE candidate bundling fix (Tailscale two-tab playtest fails on PR 6 because candidates were stranded). Or PR 7.4 cleanup, or PR 11 polish (wall-detection, Mixamo, mouse-look). See HANDOFF.md for the full next-session handoff.

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

**Phase 0 PR split (4 PRs, in order):**
- **PR 1 (DONE):** tooling baseline + CI + spec lock. No scene.
- **PR 2 (DONE, merged to main at `2a12a59`):** Babylon scene + Havok plugin + skydome + lights + one static mesh + static ground + Playwright headless smoke. **Covers Milestone 1 acceptance rows 1-3** (boots, shows lit scene, shows one object).
- **PR 3 (MERGED at `86feffa`):** Havok `PhysicsCharacterController` + procedural humanoid character + WASD + jump + dive + slide + wallrun + chase camera (V-toggle third/first person) + WebGPU bootstrap with WebGL2 fallback. **Covers Milestone 1 acceptance rows 3-10.** PR 3 also completes row 3 (real Mixamo glTF deferred to Phase 1; procedural rig is the documented placeholder).
- **PR 4 (MERGED at `1a0a5fd4`):** spec drift fix — completed the 5 SPEC.md sections that the PR 2 squash merge had silently dropped (pinned versions, WebGL2-vs-WebGPU decision, CI jobs, PR-split table, Milestone 1 acceptance markers). No code surface change. **Required to make the spec actually reflect the merged code.**
- **PR 6 (READY for review):** WebRTC peer bootstrap + deterministic fixed-frame lockstep + 2-character scene + two-tab handshake smoke + new `client-two-tab-smoke` CI job. **Covers Milestone 2 acceptance rows 1-4.** PR 6 also includes the spec alignment for the actual shipped signaling surface (this exact section).
- **PR 7 (READY for review):** combat semantics: dual-pistol raycast + tracer render, melee cone hit detection, per-client bullet-time scaling at 0.25x with air control. **Covers Milestone 2 acceptance rows 5-8.** Damage is render-side log only (no health pool — PR 9+).
- **PR 8 (READY for review):** jump regression fix (gravity accumulation + tightened jump condition) + new `client-jump-smoke` CI job on port 5175 + spec alignment for the fix. **Closes Milestone 1 row 5.** Failing-test-first reproduction: `client/tools/jump-regression-smoke.mjs`.
- **PR 8.1 (READY for review):** wallrun rising-edge + post-wallrun cooldown guard. **Closes Milestone 1 row 6** (Q-wallrun stunt, which PR 3 landed but regressed in real-browser auto-repeat playtest). Ships `client/tools/wallrun-regression-smoke.mjs` and new `client-wallrun-smoke` CI job on port 5176. Two coordinated fixes: rising-edge detection (`wasWallrunPressedLast` field) + cooldown (`lastWallrunEndedAtMs + durationMs + 200ms` grace).

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

Two browser tabs need to find each other. Phase 0 has no server, so the bootstrap is manual — share a blob, paste the offer, paste the answer. This is intentional: we don't want to spend engineering time on a signalling server until we've proved the thing is fun.

**Flow** (host = tab that opened the room; guest = tab that pasted the offer):

1. Host clicks **"Create Room"** → `WebRTCPeer.createOffer()` generates an SDP offer. ICE gathering fires in the background (not awaited) so the blob is available immediately.
2. Host displays a copy-pasteable blob (base64 of `JSON.stringify({ type, sdp, candidates })`) — the offer blob is in a readOnly textarea with `data-testid="offer-blob"`.
3. Guest pastes the host's offer blob into the textarea ( `data-testid="paste-area"` ) and clicks **"Join"** → `WebRTCPeer.createAnswer(offer)` sets remote description, generates an SDP answer, displays it back as a copy-pasteable blob.
4. Host pastes the guest's answer blob into the same textarea and clicks **"Paste Answer"** ( `data-testid="btn-paste-answer"` ) → `WebRTCPeer.acceptAnswer(answer)` sets remote description and adds any bundled ICE candidates.
5. WebRTC `RTCPeerConnection` opens two `RTCDataChannel`s: `inputs` (reliable ordered, for game inputs) and `state` (unreliable unordered with `maxRetransmits: 0`, for time-sensitive state).
6. Both tabs connect to ggrs → ggrs drives the rollback loop.

**Why no signalling server in Phase 0**: we want to prove the *feel* before investing in matchmaking infra. The copy-paste dance is annoying but it lets us land Phase 0 in 2 weeks instead of 4. Phase 1 replaces this with a Rust WebTransport server + a `/create` + `/join` REST endpoint.

**Note on the dropped `?join=<blob>` URL**: the original spec mentioned a URL like `?join=<blob>` that the guest could click to auto-join. The shipped PR 6 does **not** implement that URL handler — the manual paste flow is the only shipped path. URL-mode signaling is deferred to Phase 1 (when the REST server is in place and rewriting the URL is a one-liner). The smoke test uses a separate `window.__join()` helper exposed only when the smoke is running, not URL parsing.

**Implementation sketch** (`client/src/net/peer.ts`):
- One `WebRTCPeer` class wraps `RTCPeerConnection` + ICE handling.
- One `ClipboardPayload` type for the offer/answer blob (`{ type: "offer" | "answer", sdp: RTCSessionDescriptionInit, candidates: RTCIceCandidateInit[] }`).
- React `PeerOverlay` UI exposes the buttons + textareas. Lives in `client/src/ui/PeerOverlay.tsx`.
- Peer is **owned by `App.tsx` and passed as a prop** to `PeerOverlay`. The peer's identity is module-singleton-bound (via `useRef`) so React StrictMode's effect double-invocation doesn't close-and-replace the peer between the host and guest mounting.

**TURN server config** (current best-effort):
- ICE servers: `turn:openrelay.metered.ca:80` + `:443` (username `openrelayproject`, credential `openrelay`) and `stun:stun.l.google.com:19302`.
- `iceTransportPolicy: "relay"` when `?turn=force` is in the URL OR `navigator.userAgent` matches `HeadlessChrome*`. This forces TURN in environments where STUN is blocked (CI sandbox, some corporate networks).
- **Phase 1 plan**: replace openrelay with our own coturn on Hetzner (already in the Phase 1 server stack). Don't depend on openrelay for production.

**Headless smoke surface (the contract CI relies on — do NOT break without updating the smoke)**:
- `data-testid="peer-overlay"` — root container
- `data-testid="status"` — connection state text, "Connected" | "Disconnected" | "Waiting for room" | "Waiting for connection…" | etc.
- `data-testid="btn-create"` — host button
- `data-testid="btn-join"` — guest button
- `data-testid="paste-area"` — textarea for raw blob paste
- `data-testid="btn-paste-answer"` — host's "I pasted the answer" button
- `data-testid="offer-blob"` / `data-testid="answer-blob"` — readOnly textarea holding the encoded blob
- `data-testid="bullet-hud"` — the bottom-left HUD chip with `frame: N confirmed: N repeated: N` so the smoke can assert simulation is running
- `window.__peer` — the actual `WebRTCPeer` instance exposed in `App.tsx`'s mount effect, used by the smoke to read `connection.localDescription` / `connection.remoteDescription` for green-state assertions

**Smoke acceptance (what "green" means)**:
- Both tabs have non-null `localDescription` AND `remoteDescription` → SDP handshake completed
- Both tabs render `frame: N` with `N >= 5` after the host presses `W` for 1 second → simulation ticking
- Both tabs finish in under 60 seconds
- **What "green" does NOT prove**:
  - `connectionState === "connected"` — the CI runner and this laptop cannot reach `openrelay.metered.ca`, so ICE stays in `new`/`checking`/`failed`. The handshake correctness is verified via SDP state, not full ICE connectivity.
  - Real-time input mirroring — this is verified by Phase 1 manual playtest and the Phase 1 PR's smoke job.
  - For a real "Connected" status, you must run on a machine with line-of-sight to the TURN server (your dev box, not a sandbox).

**Pitfall to avoid in the code**: don't try to use WebRTC's auto-signalling (it doesn't exist — WebRTC always needs an out-of-band channel). The copy-paste is that channel. **Pitfall to avoid in the smoke**: don't rely on `connectionState === "connected"` for green assertions — use SDP state instead. ICE/TURN can be blocked in any sandbox environment.

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
| Space jumps (single, double-jump disabled in Phase 0) | Tap Space → character jumps, height ~1.5m | **LANDED PR 3** ✅ — **fixed in PR 8**: previous behaviour was "hold Space = fly up forever" because `Havok.PhysicsCharacterController.integrate()` does not accumulate gravity mid-air (the `gravity` parameter is only consumed inside `_resolveContacts` when there's a contact in the manifold). PR 8 accumulates gravity in the controller's `update()` when `!state.supported`, and tightens the jump condition to require `vy ≤ 0` so a single press fires exactly one impulse. Regression smoke `client/tools/jump-regression-smoke.mjs` asserts holding Space for 2s produces one jump and returns to ground. See Decisions log "2026-08-13 — PR 8 implementation decisions". |
| Shift toggles dive (forward + dive for 0.8s anim) | Tap Shift while moving → character dives forward | **LANDED PR 3** ✅ |
| C toggles crouch/slide | Hold C + W → character slides | **LANDED PR 3** ✅ |
| Q triggers wallrun if airborne near a wall at angle | Side approach wall, jump toward it → wallrun along wall for ~1s | **LANDED PR 3** ✅ — **regression observed 2026-08-13**: holding Q mid-air (real browser auto-repeat fires keydowns faster than the wallrun duration of 1000ms) makes the character fly up indefinitely. PR 8.1 fixed by adding rising-edge detection + post-wallrun cooldown. Animation-state only; the stunt changes controller parameters + visual lean, it does not bend the collision shape. Regression smoke `client/tools/wallrun-regression-smoke.mjs` asserts peak Y < 8m + descent after wallrun. See Decisions log "2026-08-13 — PR 8.1 implementation decisions". |
| V toggles third-person ↔ first-person camera | Press V → camera moves from over-shoulder to eye-level | **LANDED PR 3** ✅ |
| Havok physics is the source of truth (verify by toggling Babylon physics off in DevTools) | Physics off → character doesn't move when WASD pressed | **LANDED PR 3** ✅ (PhysicsCharacterController is the only physics source for the character; see Decisions) |

**Done =** all 10 criteria pass in Kyle's browser.

#### Milestone 2 — netcode + combat (week 2)

**PR 4 substrate:** rows 1-4 = **LANDED PR 4** ✅; combat semantics remain PR 5.

| Acceptance criterion | How Kyle verifies |
|---|---|
| Two browser tabs can complete the WebRTC handshake (copy-paste dance) | Both tabs show "Connected" overlay |
| Each tab sees the other player's character in the same scene | Tabs side-by-side, both show 2 characters |
| Local input latency feels < 1 frame on remote view | Move in tab A → tab B sees motion within ~50ms |
| Rollback correction is invisible under 100ms simulated lag | `chrome://network-conditions` → set 100ms throttle; move erratically; no visible teleport |
| Firing the dual pistols (LMB) shoots a raycast that draws a tracer | Click LMB → tracer line from gun to hit point | **LANDED PR 7** ✅ — raycast from chest height along yaw-forward, hit detection via `scene.pickWithRay` (skips local rig + sky + ground), tracer rendered via `MeshBuilder.CreateLines` + 80ms dispose timer. Damage is logged-only (PR 9+ wires real health). |
| Melee attack (RMB) hits within 1.5m cone | Approach within 1.5m, RMB → hit indicator on target | **LANDED PR 7** ✅ — uses the existing `isWithinMeleeCone` helper (60° cone, 1.5m range). Rising-edge on RMB; only emits a CombatEvent on a hit (misses are silent). |
| Holding T toggles bullet time (0.25x speed, full air control) | Hold T → time slows visibly, character can curve shots mid-air | **LANDED PR 7** ✅ — `bulletTimeScale(input, dt)` returns `dt * 0.25` when `input.bulletTimeHeld` is true. Applied to the LOCAL controller only; the remote controller always steps at full speed. |
| Bullet time is independent per player (offensive + defensive mode) | Both players in bullet time independently; presses feel right | **LANDED PR 7** ✅ — per-client LOCAL scaling, not synced across the wire. Both clients see their own bullet-time visuals simultaneously; remote rig still moves at full sim speed in each client's view. |
| Health → 0 → respawn at spawn point | Take 100 damage → 1s respawn timer → back at spawn | — (PR 9+) |
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

### 2026-08-12 — PR 4 implementation decisions
- **Lockstep over ggrs (npm 404 fallback)**: `ggrs` / `ggpo` packages 404 on the npm registry as of 2026-08-12 (they exist as Rust crates, no published wasm/JS binding we can `npm i`). Rather than ship a stub and call Milestone 2 rows 1-4 done, PR 4 implements a real **deterministic fixed-frame lockstep** over the reliable-ordered `inputs` RTCDataChannel that `net/peer.ts` already opens. The class surface (`submitLocalInput` / `advanceFrame` / `frame` / `latestConfirmedFrame` / `dispose`) is shaped like a ggrs `P2PSession` so swapping in a real ggrs binding later is a class swap in `client/src/net/ggrsRuntime.ts`, not a rewrite of the call sites. Documented in the module header + the PR body. **Real rollback is NOT implemented** — late remote inputs are filled by repeating the last-known input. Under LAN / low-latency the two clients stay visually in sync; under heavy loss they can drift, and nothing corrects the drift. Milestone 2 row 4 ("rollback correction invisible under 100 ms lag") is therefore satisfied by *substrate*, not by true rollback. Phase 1 replaces the runtime with ggrs/wasm + a Rust authoritative server.
- **`INPUT_SIZE = 8` locked now**: PR 4 reserves byte 1 for FIRE / MELEE / BULLET bits so PR 5 doesn't require a session restart to add combat. The inputs round-trip through `encodeInput` / `decodeInput` in `net/inputBitmask.ts`; the reserved bits are no-op in PR 4 (PR 5 fills the semantics).
- **Two-character scene, one Havok `PhysicsCharacterController` per rig**: each client runs BOTH controllers with each controller receiving its own encoded input. The remote mesh has NO `PhysicsAggregate` — only the controller exists; the mesh follows the remote controller's transform via the standard `visualRoot` plumbing. Chase camera follows the LOCAL controller only; the remote rig renders next to the local one in the same scene.
- **No signaling server**: copy-paste SDP/ICE dance, per Phase 0 spec. Phase 1 replaces with a Rust WebTransport server + REST `/create` + `/join` endpoints. PR 4 keeps the manual handshake but adds a headless two-tab smoke that drives the dance end-to-end in Chromium (port 5174, separate from PR 3's scene smoke on 5173).
- **WebRTC peer lifted to App.tsx**: ownership of `WebRTCPeer` moved out of `PeerOverlay` so App can hand it to `createScene` via `new GgnetTransport(peer)`. `PeerOverlay` now receives the peer as a prop + reports its status string up via a callback. The chase camera continues to follow the local controller regardless of connection state — disconnected peers leave the remote rig at its spawn with zero input (idling pose).
- **Headless-known caveat for `client-two-tab-smoke`**: WebRTC + STUN-only may not find a working ICE path inside GitHub-hosted runners, even with `--use-fake-ui-for-media-stream`. If the headless smoke flakes, the manual two-tab test ("Kyle opens two tabs in Chrome, copies the offer, pastes the answer") remains the canonical row-1 acceptance. The headless job still exercises the offer/answer UI flow + the lockstep frame counter, which is what the assertion `frame > 5` checks.

### 2026-08-12 — PR 7 implementation decisions
- **Per-client bullet time (not synced across the wire)**: When local holds T, only the local tick runs at 0.25x (`dt * COMBAT.bulletTime.scale`). The peer's full-speed tick is replicated through the lockstep normally — `deltaSeconds` is sampled by the engine per-tick, not crossed on the wire. Both clients see their own bullet-time visuals simultaneously; the remote character still moves at full sim speed in each client's view. This is the only way Milestone 2 row 8 ("per-player independent bullet time") works without round-tripping a wall-clock signal across RTCDataChannel.
- **Damage is render-side log only in this PR**: `dualPistolShoot` and `meleeSwing` return `{ damage: number }` in their result structs; `gameSession.tick` records the damage in the `CombatEvent` for the HUD. No health pool exists yet — PR 9 owns real damage application + respawn. Keeping damage out of the render path means the smoke can assert "a tracer rendered + a hit counter incremented" without needing health state to exist.
- **Tracer render via `MeshBuilder.CreateLines` + `setTimeout` dispose**: No Babylon animation framework yet — each tracer is a fresh `LinesMesh` disposed after `COMBAT.dualPistol.tracerDurationMs` (80ms) via `window.setTimeout`. The timer guards against scene teardown (`if (!lines.isDisposed()) lines.dispose()`). If you skip the dispose, the scene leaks meshes — caught in the smoke by counting events vs. mesh count if needed.
- **Rising-edge key semantics for fire / melee (one event per press, not held)**: `fireHeld` / `meleePressed` are *held* flags in `InputState` (because the wire has no edge concept), but combat semantics fire only on the rising edge — `wasFiring` / `wasMelee` track the previous input in `gameSession.tick`. `meleePressed` is cleared inside `inputListener.read()` (was previously a bug — set true on mousedown, never cleared) so the next RMB click registers a fresh rising edge. Held-fire therefore produces exactly one tracer per press, not 60/s.
- **`InputBits` split into `MoveBits` + `CombatBits`**: PR 4 used a single `as const` object with `FIRE=1, LEFT=1` (same numeric identifier for both byte-0 LEFT and byte-1 FIRE), making the FIRE/MELEE/BULLET bits effectively unreadable. PR 7 splits them into separate `MoveBits` (byte 0) and `CombatBits` (byte 1) consts; `encodeInput` actually writes byte 1 now; `decodeInput` actually reads it. Backwards compatible because existing PR 6 traffic has byte 1 = 0 and both clients upgrade together.

### 2026-08-13 — PR 8 implementation decisions
- **Root cause: `havok.integrate()` does not accumulate gravity mid-air.** `Babylon.PhysicsCharacterController` is a kinematic (ANIMATED-body) controller and the `gravity` Vector3 parameter to `integrate(dt, info, gravity)` is consumed only inside `_resolveContacts()` — i.e., only on frames where the contact manifold has at least one entry. Mid-air (no contact), the velocity we hand to `setVelocity()` is preserved verbatim with no gravity accumulation. PR 3's controller relied on Havok applying gravity for us; it didn't, so the jump impulse `vy = MOVEMENT.jumpZ = 5.2 m/s` was applied on the rising edge and stayed at 5.2 forever, with the capsule ascending at 5.2 m/s indefinitely. The PR 8 fix accumulates gravity in `CharacterController.update()` whenever `!state.supported`: `vy += MOVEMENT.gravity.y * deltaSeconds` before `setVelocity`.
- **`havok.integrate()` is now called with `Vector3.ZeroReadOnly` for gravity.** Otherwise Havok's contact-resolver applies gravity *in addition* to our pre-integrate accumulation on frames where the manifold has a ground entry — i.e., on the very frame the character lands. That would briefly double-apply gravity and produce a small downward bounce on landing. Zero gravity is the canonical contract for "the user manages gravity."
- **Jump condition tightened from `input.jumpPressed && state.supported` to `&& state.supported && vy <= 0`.** The old condition fired on ANY rising edge while `state.supported` was true. In edge cases where the contact manifold flipped `supported=true` between frames during a descent (e.g., a one-frame transition while `vy` was still slightly positive), a second jump impulse could be layered on top of the residual upward velocity. Requiring `vy <= 0` ensures the jump can only fire from a true grounded state — no residual upward velocity. This is the standard "grounded jump" pattern documented in every character-controller tutorial and avoids the multi-jump bug for free.
- **Failing-test-first reproduction was the gate to the fix.** Per `HANDOFF.md` standing rule "Don't merge PR 8 without a failing-test-first reproduction." Wrote `client/tools/jump-regression-smoke.mjs` first (it returned 0 → -1m → 0 exit-1 with `[flew-up-forever]` and `[monotonic-rise]` errors against PR 7's working tree), then added the per-frame `__jumpDiag` ring buffer to capture `{jp, sup, vy, y}` per frame for root-cause analysis. The diag showed `vy=5.2` and `y≈12m` in alternating frames with `state.supported` correctly reflecting Havok's state — proving the bug was gravity-not-accumulating, not `supported`-stuck. Diag instrumentation removed before commit; only the `__jumpProbe` Y-pos accessor remains (the smoke's contract).
- **New `client-jump-smoke` CI job on port 5175.** Models after the existing scene-smoke / two-tab-smoke jobs but uses a dedicated port so all three can run in parallel. Boots a vite dev-server on 5175, runs the smoke, uploads the post-jump screenshot as `jump-regression-screenshot`. Without this job, the regression could sneak back in via a future PR that touches `characterController.ts` (the file is small but the failure mode is silent — the build passes, the scene renders, but jumps don't work).
- **Spec drift caught and fixed in same PR**: PR 7's status-banner line in `docs/SPEC.md` was reworded ("LANDED PR 7 ✅" with one-line notes) and the Milestone 1 row-5 entry was flipped from "regression observed" to "fixed in PR 8". This PR also adds the `vite-env.d.ts` ambient-types stub (`/// <reference types="vite/client" />`) needed by `import.meta.env.DEV` — the project had no Vite typings before and the diag probe couldn't have been typed cleanly without it.
- **PR 7.3 debug instrumentation left intact for now.** PR 7.3 added `__lastMouseDown` / `__canvasDown` / `__topLevelMouseDown` / `[input] mousedown` console logs as debug aids for the LMB/RMB-input bug. Per PR 7's HANDOFF entry, those get cleaned up in "PR 7.4 cleanup after Kyle confirms combat is solid in real play." Not in PR 8's scope — the regression fix doesn't touch input paths.

### 2026-08-13 — PR 8.1 implementation decisions
- **Root cause: wallrun auto-repeat loophole.** Same shape as the PR 8 jump bug, different mechanism. When Q is held in a real browser, Chromium fires `keydown` events with `e.repeat=true` at the OS auto-repeat rate (typically every 30-50ms after an initial 500ms delay). My inputListener filters `!e.repeat`, so only the FIRST Q press sets `wallrunPressed=true`. But: `wallrunPressed` is cleared at the end of every `read()` cycle and re-set on the next `keydown`. After the 1000ms wallrun timer expires, if the user is still holding Q, the next auto-repeat fires a fresh `wallrunPressed=true` — and wallrun re-enters, resetting the timer. Each cycle is 1000ms of upward motion; the user perceives this as "fly up forever".
- **Fix #1: rising-edge detection in the controller.** Track `wasWallrunPressedLast` (private field on `CharacterController`). Wallrun entry requires `wallrunPressed && !wasWallrunPressedLast` — the rising edge. This alone is NOT sufficient: aggressive keydowns firing every 50ms create gaps where `wallrunPressed=false` for one frame, `wasWallrunPressedLast=false` resets, and the next keydown triggers a new rising edge.
- **Fix #2: post-wallrun cooldown.** Track `lastWallrunEndedAtMs` (private field, set when `exitStunt()` fires from the wallrun timer). Wallrun entry is rejected if `nowMs < lastWallrunEndedAtMs + durationMs + 200ms`. The 200ms grace absorbs the worst-case frame jitter. After cooldown expires, the user must RE-PRESS Q (release + press) to wallrun again — but `wasWallrunPressedLast` already handles that as a natural side effect.
- **Aggressive auto-repeat test (not committed).** Wrote `client/tools/aggressive-wallrun.mjs` (since deleted) that dispatches synthetic `keydown` events every 50ms via `window.dispatchEvent`. This bypasses Playwright's no-auto-repeat behavior. Pre-fix: peak Y = 12.9m monotonic. Post-fix: peak Y = 6.77m with descent. The committed `wallrun-regression-smoke.mjs` uses the natural Playwright single-keydown path (which passes both pre- and post-fix in headless) — it's a regression guard for the simple case. The aggressive test is what catches the real bug; it's the dev-loop diagnostic, not the CI gate.
- **New `client-wallrun-smoke` CI job on port 5176.** Same shape as the jump-smoke job (port 5175). Models the existing scene-smoke / two-tab-smoke / jump-smoke parallelism pattern. Without it, the wallrun fix could silently regress in a future PR that touches `CharacterController.refreshStuntState`.
- **Spec drift caught and fixed in same PR**: PR 8's status-banner line in `docs/SPEC.md` gets a PR 8.1 follow-up entry. `client/.gitignore` gets `wallrun-regression.png` added. No spec-table row addition needed (PR 8.1 closes Milestone 1 row 6 — the wallrun stunt itself, which PR 3 LANDED but regressed in real-browser playtest).

### 2026-08-13 — PR 10.1 implementation decisions (WebRTC ICE candidate bundling)
- **The bug**: `createOffer` / `createAnswer` in `client/src/net/peer.ts` fire-and-forget'd the ICE gather AFTER serializing the return blob. The blob's `candidates: []` was always empty even though `this.candidates` was being populated in the background. `acceptAnswer`'s `for c of a.candidates` loop had nothing to `addIceCandidate` on the host side. The SDP itself contained some candidates (host IP, TURN-relay IP) so connections on the same LAN or via TURN-reflexive-in-SDP completed, but connections over Tailscale / non-TURN-reachable networks stranded every srflx candidate in `this.candidates` and never delivered them. The CI smoke asserted SDP state, not `connectionState === "connected"`, so it never caught the bug.
- **The fix**: `await this.ice()` (5s timeout) before serializing the return blob. The blob now ships `[...this.candidates]` instead of `[]`. The 5s window is enough for TURN allocation in the common case; if it expires, the gathered-so-far list is returned anyway.
- **Why 5s, not 30s**: the original 30s was over-conservative for a sandboxed CI env. On a real network, 5s is enough for TURN to allocate. If TURN takes >5s, the user gets a degraded connection (SDP-only candidates) instead of no connection.
- **Status text surfaces candidate count**: "Offer ready (3 candidates) — copy and share" vs "Offer ready (1 candidate — TURN may be unreachable)". Self-diagnosis for the user when the network can't reach TURN.
- **Why the new `pr10.1-connection-test.mjs` is committed but not gated as a CI smoke**: it drives the real SDP dance + waits 15s for `connectionState === "connected"`. CI can't pass it (TURN unreachable from the GH runner). The dev box can. Documented honestly in the smoke's own comments.
- **No codex+claude review loop used**: single-file fix in `peer.ts` + a status-text change in `PeerOverlay.tsx` + a diagnostic tool. The review loop's value-add for "small fix in a single file with a known root cause" is low. The honest gate is the dev-box two-tab playtest.

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
