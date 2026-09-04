// wireServerTransport.ts
//
// (Hetzner staging, 2026-09-04) — extracted from scene.ts to escape
// Vite/Rollup tree-shaking. The wire-up logic used to live inside
// scene.ts's createScene() function as an `if (useServerTransportFromOpts ||
// useServerTransportFromWindow) { ... }` block. Vite analyzed the
// call graph and decided the whole branch was dead (probably because
// the `MultiplayerOptions` parameter is always `undefined` at the
// single call site in App.tsx, and Vite's static analysis didn't
// fully account for the runtime `__forceServerTransport` flag).
//
// To force the wiring to ship, we put it in a separate module with
// a side-effect-import at App.tsx's top level. The side-effect
// import runs on every page load; the wire-up reads the runtime
// `__forceServerTransport` flag and the `__damageServerUrl` /
// `__damageServerRoomId` globals set by PeerOverlay when the URL
// has `?server=`.
//
// This module is intentionally minimal — it just calls
// `wireServerTransport()` once at import time and writes the
// resulting ServerTransport to `window.__serverTransport` (matching
// the contract scene.ts used to honor in dev).

import { ServerTransport } from "../net/serverTransport";
import { createDamageBusProbe } from "../net/damageBus";
import { decodeSnapshot } from "../../../protocol/snapshot";

export function wireServerTransport(): void {
  // Set the runtime flag ourselves if `?server=` is in the URL.
  // PeerOverlay also sets this, but it might run AFTER us in the
  // module-load order — checking the URL directly is the safer
  // single-source-of-truth for prod. (Hetzner staging, 2026-09-04.)
  const url =
    typeof window !== "undefined" && typeof window.location !== "undefined"
      ? new URL(window.location.href)
      : null;
  const serverParam = url?.searchParams.get("server") ?? null;
  if (serverParam && serverParam.length > 0) {
    (window as unknown as { __forceServerTransport?: boolean }).__forceServerTransport = true;
  }
  // Guarded by the runtime flag — same condition as the old in-scene
  // check. Bail silently if no multiplayer requested.
  const flag =
    typeof window !== "undefined" &&
    (window as unknown as { __forceServerTransport?: boolean })
      .__forceServerTransport === true;
  console.info("[wireServerTransport] flag=", flag, "url=", window.location.href);
  if (!flag) return;

  // Don't double-wire. The IIFE race-guard that used to live in
  // scene.ts is moved here, simplified.
  const win = window as unknown as {
    __serverTransport?: unknown;
    __damageBus?: unknown;
    __broadcastHandlerRegistered?: boolean;
    __predictor?: unknown;
    __interpolator?: unknown;
    __latestSnap?: () => import("../../../protocol/snapshot").Snapshot | null;
    __damageServerUrl?: string;
    __damageServerRoomId?: string;
    __localPlayerId?: number;
    __peerPlayerId?: number;
    __remoteController?: unknown;
  };
  if (win.__serverTransport !== undefined) return;
  win.__serverTransport = "INIT_INFLIGHT";

  const urlBase =
    win.__damageServerUrl ?? `${window.location.protocol}//${window.location.host}`;
  const roomId = win.__damageServerRoomId;
  if (!roomId) {
    console.error(
      "[wireServerTransport] __damageServerRoomId not set — ?server= URL malformed",
    );
    win.__serverTransport = undefined;
    return;
  }

  const localPlayerId = win.__localPlayerId ?? 1;

  void (async () => {
    try {
      const server = new ServerTransport(urlBase, roomId);
      await server.connect();
      // Replace the sentinel with the real transport.
      win.__serverTransport = server;
      // Expose snapshot getter + damage bus probe on window for
      // smoke instrumentation. Mirrors the prod surface that the
      // dev-mode probe used to expose.
      const snapGetter = (): import("../../../protocol/snapshot").Snapshot | null => {
        try {
          // ServerTransport exposes the latest snapshot via getStats
          // in newer revisions; fall back to a placeholder if absent.
          const stats = server.getStats?.();
          if (stats && "latestSnap" in stats && stats.latestSnap) {
            return stats.latestSnap as import("../../../protocol/snapshot").Snapshot;
          }
          return null;
        } catch {
          return null;
        }
      };
      win.__latestSnap = snapGetter;
      win.__damageBus = createDamageBusProbe(server);
      // Expose the gameSession + remoteController on the window for
      // DebugHud's combat panel. scene.ts's createScene() also
      // publishes __gameSession, but it may not have run yet when
      // wireServerTransport completes; we re-publish here to be safe.
      const gs = (window as unknown as { __gameSession?: { remoteController?: unknown; localController?: unknown } })
        .__gameSession;
      if (gs?.remoteController) {
        win.__remoteController = gs.remoteController;
      }
      console.info(
        "[wireServerTransport] connected to",
        urlBase,
        "room",
        roomId,
        "as player",
        localPlayerId,
      );
    } catch (err) {
      console.error("[wireServerTransport] connect failed:", err);
      win.__serverTransport = undefined;
    }
  })();

  // Eagerly bind decodeSnapshot so Vite keeps it in the bundle
  // (defensive — keep around for future wiring expansion).
  void decodeSnapshot;
}

// Auto-wire on import. App.tsx imports this module for the side
// effect; the function is also exported for tests / manual re-wiring.
// Tagged with `/* @__SIDE_EFFECT__ */` comment so bundlers that
// understand the hint keep the call even if the function appears
// side-effect-free. (Rollup doesn't read this hint, but the explicit
// assignment to a window property below gives it a real observable
// effect that survives tree-shaking.)
/* @__SIDE_EFFECT__ */
const __wireResult = wireServerTransport();
(window as unknown as { __wireServerTransportCalled?: boolean }).__wireServerTransportCalled = true;
void __wireResult;
