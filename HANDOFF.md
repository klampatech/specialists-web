# Handoff — Session-to-Session Continuity

Drop a new entry at the top of the log on every session end. Keep entries short, factual, and **action-oriented** — what was done, what's next, what's blocking.

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
```

Or use the short-form for a quick check-in:

```markdown
## <ISO date> — <one-line summary>
**Done**: <one bullet>
**Next**: <one bullet>
**Blockers**: <one bullet or "none">
```

---

## Log

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

---

## Conventions

- **One entry per session, dated ISO-style.** New entries go on top.
- **Short, factual, action-oriented.** The point is so the next session can pick up without re-reading sessions.
- **Decisions go in `SPEC.md` too.** Cross-link if needed.
- **Blockers are surfaced, not buried.** Anything stuck >1 session = top of the vault doc's Open Questions section.
