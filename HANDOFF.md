# Handoff — Session-to-Session Continuity

Drop a new entry at the top of the log on every session end. Keep entries short, factual, and **action-oriented** — what was done, what's next, what's blocking.

**Spec location**: the canonical spec lives at `docs/SPEC.md` in the repo. The vault entry at `~/Obsidian/mem/projects/specialists-web.md` is a one-way mirror — regenerate with `./tools/sync-spec-to-vault.sh` after merging changes. Never edit the vault copy directly.

---

## Handoff template

When starting a fresh session, copy this template to the top of the log and fill it in:

```markdown
## <ISO date> — <one-line summary>

**Status**: <where we are in the phase plan — e.g. "Phase 0 / milestone 1 / repo scaffolded">
**Done this session**:
- <bullet>
- <bullet>

**Next session task**:
- <one concrete thing to start with>

**Blockers / open questions**:
- <bullet, or "none">

**Decisions made**:
- <decision + why, or "none">

**Playtest status** ⚠️
- <What was playable and tested this session?>
- <What was built but NOT playable yet — and why?>
- <Anything broken, missing, or regressed?>
- <URL / video / build artifact Kyle can hit to verify>
```

Or use the short-form for a quick check-in:

```markdown
## <ISO date> — <one-line summary>
**Done**: <one bullet>
**Next**: <one bullet>
**Blockers**: <one bullet or "none">
**Playtest**: <was it playable? what was tested?>
```

> ⚠️ **The playtest status is mandatory.** Every session end must answer: *"What did Kyle actually run and experience?"* — not "what was implemented." If nothing was playable this session, say so. That's the signal to prioritize a playable build next session. See `SPEC.md` → Operating Principles.

---

## Log

### 2026-08-11 — Phase 0 tooling baseline (PR 1)

**Status**: Phase 0 / milestone 1 / tooling + CI + spec lock landed, scene work begins in PR 2

**Done this session**:
- Detected drift between vault (~/.Obsidian/mem/projects/specialists-web.md) and repo SPEC.md; fixed remote URL typo (klampa → klampatech)
- Filled in Phase 0 detail in vault: ggrs ↔ Babylon ↔ Havok wiring diagram, WebRTC peer bootstrap flow, asset import pipeline, expanded acceptance criteria (10 testable rows each for milestones 1 and 2)
- Landed transport decision: WebRTC peer-to-peer for Phase 0, WebTransport for Phase 1+ client→server, WebSocket fallback deferred to Phase 1
- Synced vault → repo SPEC.md
- Created branch `feat/phase0-tooling-baseline` (off main, no direct push)
- Added GitHub Actions CI (.github/workflows/ci.yml): typecheck + production build on every PR
- Scaffolded client/ with Vite + React + TypeScript: package.json, tsconfig.{json,app,node}, vite.config.ts, index.html, src/main.tsx, src/ui/App.tsx
- Smoke tested locally: npm install (68 pkgs, 4s), npm run typecheck (exit 0), npm run build (143kB JS bundle), npm run dev (HTTP 200 on /, /src/main.tsx, /src/ui/App.tsx), headless browser visit (React renders, zero console errors)
- Opened PR #1: https://github.com/klampatech/specialists-web/pull/1
- CI green on PR #1 (client — typecheck + build, 13s, SUCCESS)
- Branch protection: not yet set on this repo (it's brand new). Followed the universal "no direct-to-main" rule anyway — branch + PR + green CI + review + merge.

**Next session task**:
- Continue with PR 2: Babylon.js scene + Havok plugin + skydome + directional light + a single static mesh (Milestone 1 acceptance rows 1-3). Start with the simplest possible Havok-free Babylon scene; layer Havok in once the scene runs.

**Blockers / open questions**:
- (No real blocker. Branch protection isn't set on this fresh repo yet. I conflated phaseturn's protected main with this one — corrected after Kyle's flag. Universal "no direct-to-main" rule still applies regardless.)

**Decisions made**:
- 2026-08-11 — Transport: WebRTC for Phase 0 peer-to-peer (no signalling server), WebTransport for Phase 1+ client→server, WebSocket fallback deferred to Phase 1
- 2026-08-11 — Phase 0 split into 3 PRs: (1) tooling/CI/spec, (2) Babylon scene + Havok plugin + static mesh, (3) character controller + WASD + stunts + camera toggle
- 2026-08-11 — CI scope: typecheck + production build only for now. Playwright headless smoke test deferred to PR 2 when there's a real scene to render
- 2026-08-11 — Vite default port 5173, host: true (listen on 0.0.0.0) so a second tab on another host can join later

**Playtest status** ⚠️
- **Playable**: yes, in the trivial sense — `npm run dev` boots a browser at http://localhost:5173 showing a styled React banner that says "Specialists Web / Phase 0 — tooling baseline / Babylon.js scene + Havok character controller lands in PR 2." See PR #1 description for the verbatim screenshot.
- **Not yet playable**: any actual game. PR 2 ships the first real scene.
- **What was tested this session**: HTTP 200 on /, /src/main.tsx (2.2kB transformed), /src/ui/App.tsx (5.9kB transformed); React heading rendered in headless browser; zero console errors/warnings.
- **Build artifact**: PR #1 (https://github.com/klampatech/specialists-web/pull/1), CI green, ready for Kyle's review/merge.
- **Next session's playtest target**: PR 2 lands a Babylon.js scene with a skydome, directional light, and a single static mesh. Kyle opens the URL, sees a lit 3D scene with one object. That's Milestone 1 acceptance rows 1-3.

#### Long-form

This session was a clean "tooling baseline" beat. Plan was: (1) lock the spec, (2) make the build pipeline work, (3) open a PR that's reviewable. Steps 1 and 2 were straightforward; step 3 hit a small friction — gitignore was missing `*.tsbuildinfo` so tsc artifacts tried to stage. Fixed in `.gitignore` before commit. The friction I should have surfaced cleaner: I initially framed the missing branch protection as a "discrepancy" because my memory said it was set. Kyle corrected it — that memory was from phaseturn, not specialists-web. Rule still applies (no direct-to-main), but it applies as a universal discipline, not a repo-level guarantee. PR is in a state Kyle can review and merge whenever he's ready.

The Phase 0 split into 3 PRs came out of the conversation at the start of this session. Driving principle: every PR ends at a playable beat. PR 1 ends at "the build runs and shows a banner." PR 2 ends at "you can see a lit scene with one object." PR 3 ends at "you can walk a character around." Each PR is independently mergeable and reviewable.

Deviations from the original HANDOFF.md plan for this session:
- Originally planned to also touch the vault transport section to be clearer; ended up making it a dedicated decision instead of a hidden edit. Net same content, better visibility.
- Originally planned to add Playwright now; deferred to PR 2 when there's a real scene to render. Documented in this entry.


### 2026-08-11 — Phase 0 kickoff

**Status**: Phase 0 / pre-milestone-1 / project scaffolding done, client/ not yet scaffolded

**Done this session**:
- Created canonical living spec at `~/Obsidian/mem/projects/specialists-web.md` (vault source of truth)
- Synced spec to `SPEC.md` in repo (this file's source of truth for "what we are building right now")
- Created `~/Development/specialists-web/` repo on `main` with mono structure (`client/`, `server/`, `protocol/`, `tools/`)
- Created GitHub remote: `github.com/klampatech/specialists-web` (public)
- Initial commit pushed (README, .gitignore, placeholders for each subdirectory)
- Stack decided: TS + Babylon.js (WebGPU) + Havok + ggrs (client) / Rust + Tokio + Rapier deterministic (server, Phase 1+)
- Created this `HANDOFF.md` for session-to-session continuity

**Next session task**:
- Fill in Phase 0 detailed spec: ggrs ↔ Babylon ↔ Havok wiring, WebRTC peer bootstrap, asset import pipeline, milestone-1 acceptance criteria
- Then scaffold `client/` with TypeScript + Vite + React + Babylon.js + Havok + ggrs

**Blockers / open questions**:
- None yet

**Decisions made**:
- 2026-08-11 — Stack (Babylon+Havok+ggrs client; Rust server Phase 1)
- 2026-08-11 — Asset strategy: Mixamo + Kenney CC0 for Phase 0
- 2026-08-11 — Vault `SPEC.md` is THE canonical spec; repo `SPEC.md` is a synced copy; vault is source of truth for *why*, repo for *what*
- 2026-08-11 — Phase 0 is "feel test" — two browser tabs, peer-to-peer, no dedicated server. Goal: prove movement + bullet time + rollback netcode feel right before investing in matchmaking infra
- 2026-08-11 — Operating principle: **playtest everything, hand Kyle a broken game is unacceptable.** Every milestone ends with a playable build. Every session-end handoff has a mandatory Playtest status block.

**Playtest status** ⚠️
- **No playable build yet.** Phase 0 has not started — repo is scaffolded but the client/ directory is empty.
- **Next session's playtest target**: Vite + Babylon + Havok running in a browser tab, with a single character controller visible in a static scene. Even that "walks around an empty room" is a playtest beat.

---

## Conventions

- **One entry per session, dated ISO-style.** New entries go on top.
- **Short, factual, action-oriented.** The point is so the next session can pick up without re-reading sessions.
- **Decisions go in `SPEC.md` too.** Cross-link if needed.
- **Blockers are surfaced, not buried.** Anything stuck >1 session = top of the vault doc's Open Questions section.
- **Playtest status is mandatory at every session end.** See `SPEC.md` → Operating Principles. If nothing was playable, say so.
