// PR 78 — shared constant for smoke scripts.
//
// **Source of truth**: `server/src/constants.rs::PLAYER_MAX_AMMO` (the
// authoritative value). The client mirror lives in
// `client/src/engine/characterConfig.ts::PLAYER_MAX_AMMO`. If either
// changes, this constant must change in lockstep.
//
// NB-1 carry-forward from PR 11.7.E: before this file existed, the
// literal `6` was hardcoded in 4 smoke scripts (real-input, aim-event,
// reload, reload-t3). If `server::PLAYER_MAX_AMMO` ever changed, every
// smoke would silently break. The smoke suite is the regression guard
// that catches the value drift between server and client; having the
// constant in one place here makes the coupling explicit.
//
// Pre-PR-78, the literal `6` appeared at these sites:
//   - client/tools/damage-server-aim-event-smoke.mjs:62
//   - client/tools/damage-server-reload-smoke.mjs:61
//   - client/tools/damage-server-reload-t3-smoke.cjs (multiple)
//   - client/tools/real-input-smoke.mjs:31
export const PLAYER_MAX_AMMO = 6;