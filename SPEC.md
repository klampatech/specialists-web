# Specialists Web — Living Spec

> **Canonical source of truth**: `~/Obsidian/mem/projects/specialists-web.md` (Obsidian vault).
> This file is a **synchronized copy** of the vault doc, checked into the repo so contributors and CI can see the spec without vault access.
>
> **Editing rule**: edit the vault doc first; sync to this file on commit. The vault is the source of truth for *why* we made decisions. This file is the source of truth for *what we are building right now*.

Browser-native, multiplayer remake of *The Specialists* (2002 Half-Life mod).
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
├── SPEC.md                  # This file (vault doc synced)
├── HANDOFF.md               # Session-to-session handoff
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

### Phase 0 risks

- **Netcode for bullet-time is the make-or-break.** This is the highest-risk single component. If it doesn't feel right, nothing else matters.
- **The "feel" of TS is the entire game.** Character controller, animation blending, screen shake, camera FOV bumps during dives, hit-stop on punches — these are the things that made TS feel like TS. Hard to spec, hard to test, easy to ship something that looks right but feels wrong.
- **Scope creep.** 30 weapons, 4 game modes, dual-toggle camera, 5 maps, customization, particle effects, etc. — none of it at launch. Pick a tight v1.

---

## Working with this spec

- **Edit the vault doc first** (`~/Obsidian/mem/projects/specialists-web.md`), then sync to this file on commit. The vault is the source of truth for *why* — this file is the source of truth for *what we are building right now*.
- **Phase sections**: append-only as we complete work. Don't rewrite history — mark superseded phases with `(superseded by Phase N)` so we can chase the reasoning later.
- **Decisions**: log in the Decisions section below as we make them. Each decision = why + when + what we picked + what we rejected.
- **Open questions**: log in the Open Questions section. Surface blockers for the next session.

For session-to-session continuity, see `HANDOFF.md`.

---

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

## Decisions

### 2026-08-11 — Stack picks
- **Client**: TS + Babylon.js on WebGPU + Havok + ggrs via wasm
- **Server**: Rust + Tokio + Rapier (deterministic)
- **Transport**: WebTransport (UDP), WebSocket fallback
- **Hosting**: Hetzner (matches existing infrastructure)
- **Auth (eventually)**: Discord OAuth (zero-friction)
- **Asset strategy**: Mixamo + Kenney CC0 for Phase 0
- **Working title**: "Specialists Web" — final name TBD at public launch

### 2026-08-11 — Project location
- **Vault**: `~/Obsidian/mem/projects/specialists-web.md` (this file's source of truth)
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
- Created vault doc + repo + remote. Next session: fill in Phase 0 details.
- Spec also checked into repo as `SPEC.md` (this file). Added `HANDOFF.md` for session-to-session continuity.
