// createGameSessionEntry.ts
//
// PR #129 follow-up (Hetzner staging, 2026-09-05) — extract gameSession
// creation out of scene.ts's tree-shaken IIFE. The `if (effectiveMultiplayer)`
// branch in scene.ts is gated on a runtime `window.__forceServerTransport`
// check, which Vite/Rollup's static analyzer can't prove is ever true. The
// IIFE (and the `window.__gameSession = gameSession` publication inside it)
// were being dead-code-eliminated from the prod bundle, so HUD reads of
// `handle.getGameSession?.()` returned `undefined` (HUD showed the
// hardcoded `localHp: 100`, `frame: 0` fallbacks).
//
// Fix: mirror the pattern PR #128 used for `wireServerTransport.ts`. Put
// the create+publish logic in a separate module with a side-effect import
// at App.tsx's top level. Vite preserves top-level statements in
// side-effect-imported modules unconditionally, so the call to
// `createGameSession(...)` survives tree-shaking.
//
// `ensureGameSession(scene, opts)` is idempotent — it bails if
// `window.__gameSession` is already set. This lets the dev canary
// (where the in-scene.ts IIFE still runs) coexist with this prod-only
// fallback: scene.ts publishes first, then this module short-circuits.

import { createGameSession, type GameSession } from "../game/gameSession";
import type { Scene } from "@babylonjs/core";

/** Options for {@link ensureGameSession}. Matches the call site at
 *  scene.ts:421-426 (reads `__localPlayerId` / `__peerPlayerId` from
 *  the window with defaults 1/2). */
export interface EnsureGameSessionOpts {
  localPlayerId: number;
  peerPlayerId: number;
}

/** Typed window slot — keeps the assignments type-safe without leaking
 *  `any` into module scope. */
interface GameSessionWindow {
  __gameSession?: GameSession;
}

/**
 * Lazily create + publish the {@link GameSession} for the live Babylon
 * scene. Idempotent: returns the existing `window.__gameSession` if it
 * is already set (e.g. dev canary path where scene.ts published it
 * first), otherwise constructs a fresh session via
 * {@link createGameSession} and publishes it on the window slot the
 * rest of the wire-up (server transport, broadcast handler, snapshot
 * stream) reads.
 *
 * Safe to call multiple times — the second + subsequent calls are
 * cheap no-ops that return the same instance. Safe to call in any
 * environment that exposes `window` (no-ops in a worker / SSR).
 */
export function ensureGameSession(
  scene: Scene,
  opts: EnsureGameSessionOpts,
): GameSession | null {
  if (typeof window === "undefined") {
    // SSR / worker — nothing to publish. Behave like the dev
    // single-player path: no gameSession.
    return null;
  }
  const win = window as unknown as GameSessionWindow;
  if (win.__gameSession !== undefined) {
    // Already published — dev canary, smoke harness, or a prior
    // ensureGameSession() call. Reuse the live reference so the
    // wire-up (which reads `window.__gameSession` late) sees the
    // SAME instance scene.ts's IIFE created (StrictMode guard).
    return win.__gameSession;
  }
  // Keep an explicit runtime guard at this entry point. Besides making a
  // corrupt/mismatched module graph fail loudly, the diagnostic retains
  // the factory name in the minified production bundle so bundle checks
  // can distinguish this live entry point from a tree-shaken import.
  if (typeof createGameSession !== "function") {
    throw new Error("createGameSession is unavailable");
  }
  const session = createGameSession(scene, {
    localPlayerId: opts.localPlayerId,
    peerPlayerId: opts.peerPlayerId,
  });
  win.__gameSession = session;
  return session;
}
