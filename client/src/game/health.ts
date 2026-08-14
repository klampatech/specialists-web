// Phase 0 / PR 10 — health pool + respawn helpers.
//
// This module is the single source of truth for the HP-application
// pipeline. `applyDamage` decrements the target's `state.hp` and, when
// HP crosses zero, starts the respawn timer. `tickRespawn` runs every
// frame and teleports the target back to spawn once the timer expires.
//
// **Why this file exists (and why it's not in `characterController.ts`)**:
// damage application is a *game-session* concern, not a controller
// concern. The controller exposes its state for the session to read +
// mutate; damage flow lives one layer up so the controller's `update()`
// stays pure-physics. Same encapsulation pattern as PR 7's `combat.ts`.
//
// **Determinism rule (SPEC §"Determinism rule")**:
// `applyDamage` and `tickRespawn` MUST NOT read `Date.now()` /
// `performance.now()`. The `nowMs` argument is the engine-driven frame
// timestamp passed into `gameSession.tick()`. Both clients sample
// `nowMs` independently each frame from `performance.now()` (the engine
// frame observer), so both will hit `nowMs >= respawningUntilMs` on the
// same frame and the teleport fires deterministically on both ends.
//
// **Lockstep symmetry (PR 7 pattern)**:
// both clients run BOTH controllers with BOTH inputs every frame
// (see `gameSession.tick()`). The damage events are computed from the
// local input on each client; applying them to the OPPONENT controller
// on each client produces identical state on both ends (same input ⇒
// same events ⇒ same HP decrements ⇒ same respawn timer ⇒ same
// teleport). This is the same shape as PR 7's per-client bullet-time
// (per-client LOCAL, lockstep guarantees identical-by-construction).

import { HEALTH } from "../engine/characterConfig";
import type { CharacterController } from "../engine/characterController";

/** Where the damage came from — the HUD can render different chip colors
 *  per source if it ever wants to (PR 10 currently only renders HP). */
export interface DamageEvent {
  source: "fire" | "melee";
  amount: number;
}

/**
 * Apply `ev.amount` damage to `target`'s HP pool. HP is clamped at 0.
 * When HP crosses 0 AND the target isn't already respawning, set the
 * respawn timer to `nowMs + HEALTH.respawnDelayMs`.
 *
 * The caller (gameSession.tick) supplies `nowMs` from the engine frame
 * observer — never from `Date.now()` / `performance.now()` directly.
 */
export function applyDamage(
  target: CharacterController,
  ev: DamageEvent,
  nowMs: number,
): void {
  const state = target.state;
  if (state.hp <= 0) {
    // Already dead — ignore further damage until respawn fires. This
    // prevents stacked hits during the respawn window from re-arming
    // the timer or producing negative HP.
    return;
  }
  state.hp = Math.max(0, state.hp - ev.amount);
  if (state.hp === 0 && state.respawningUntilMs === 0) {
    state.respawningUntilMs = nowMs + HEALTH.respawnDelayMs;
  }
}

/**
 * If `target` has a respawn timer armed AND `nowMs >= respawningUntilMs`,
 * fire the teleport via `target.respawn(nowMs)`. Otherwise no-op.
 *
 * Called every frame from `gameSession.tick()` for both controllers.
 */
export function tickRespawn(
  target: CharacterController,
  nowMs: number,
): void {
  const state = target.state;
  if (state.respawningUntilMs > 0 && nowMs >= state.respawningUntilMs) {
    target.respawn(nowMs);
  }
}

/** Snapshot the HUD reads from the session so it can render HP + the
 *  respawn countdown without touching the controllers directly. */
export interface HealthSnapshot {
  local: { hp: number; respawningMs: number };
  remote: { hp: number; respawningMs: number };
}
