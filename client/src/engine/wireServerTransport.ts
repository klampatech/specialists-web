// wireServerTransport.ts
//
// (Hetzner staging, 2026-09-04) — extracted from scene.ts to escape
// Vite/Rollup tree-shaking. The wire-up logic that lived inside
// scene.ts's createScene() function as an `if (useServerTransportFromOpts ||
// useServerTransportFromWindow) { ... }` block was being tree-shaken
// from production builds. Even with PR #119's DEV-gate removal, the
// `MultiplayerOptions` parameter was always `undefined` at the single
// call site in App.tsx, and Vite's static analysis didn't fully
// account for the runtime `__forceServerTransport` flag.
//
// To force the wiring to ship reliably, we put it in a separate module
// with a side-effect-import at App.tsx's top level. The side-effect
// import runs on every page load.
//
// Module-load order note (Hetzner staging, 2026-09-04):
// `wireServerTransport()` runs synchronously when this module is first
// imported. `PeerOverlay`'s URL-parsing IIFE also runs at module
// evaluation, and which one runs first depends on the bundler's
// import graph + Vite's runtime. To avoid a race where we read
// `__damageServerRoomId` before PeerOverlay has populated it, this
// module parses the `?server=...` URL itself (the canonical prod
// entrypoint encodes the room id in the `/rooms/<id>` path).

import { ServerTransport, parseRoomFromUrl } from "../net/serverTransport";
import { createDamageBusProbe } from "../net/damageBus";

export function wireServerTransport(): void {
  // Window target — typed as `any`-shape for clarity.
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
    __forceServerTransport?: boolean;
  };

  // Parse `?server=...` URL ourselves — see module-load order note
  // at the top of this file.
  const url =
    typeof window !== "undefined" && typeof window.location !== "undefined"
      ? new URL(window.location.href)
      : null;
  const serverParam = url?.searchParams.get("server") ?? null;
  let urlBase: string | null = null;
  let roomId: string | null = null;
  if (serverParam && serverParam.length > 0) {
    win.__forceServerTransport = true;
    try {
      const u = new URL(serverParam);
      urlBase = u.origin;
      // Match PeerOverlay's room-extraction: explicit `?room=` param
      // first, else parse from the server URL's `/rooms/<id>` path.
      const roomParam = url?.searchParams.get("room");
      if (roomParam) {
        roomId = roomParam;
      } else {
        try {
          roomId = parseRoomFromUrl(u.toString());
        } catch {
          // malformed server URL — fall through, bail below
        }
      }
    } catch {
      // Malformed `?server=` URL — fall through, bail below.
    }
  }
  // Override with whatever PeerOverlay already populated (smoke
  // harnesses set these directly via page.addInitScript; legacy
  // flows also go through PeerOverlay's setter).
  if (urlBase === null) urlBase = win.__damageServerUrl ?? null;
  if (roomId === null) roomId = win.__damageServerRoomId ?? null;

  const flag = win.__forceServerTransport === true;
  console.info(
    "[wireServerTransport] flag=",
    flag,
    "urlBase=",
    urlBase,
    "roomId=",
    roomId,
  );
  if (!flag || urlBase === null || roomId === null) {
    console.error(
      "[wireServerTransport] not wiring — flag/URL/roomId missing (likely no ?server= in URL)",
    );
    return;
  }
  // Don't double-wire.
  if (win.__serverTransport !== undefined) return;
  win.__serverTransport = "INIT_INFLIGHT";

  const localPlayerId = win.__localPlayerId ?? 1;

  void (async () => {
    try {
      const server = new ServerTransport(urlBase as string, roomId as string);
      await server.connect();
      // Replace the sentinel with the real transport.
      win.__serverTransport = server;
      // Expose snapshot getter + damage bus probe on window for
      // smoke instrumentation. Mirrors the prod surface that the
      // dev-mode probe used to expose.
      const snapGetter = (): import("../../../protocol/snapshot").Snapshot | null => {
        try {
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
      const gs = (window as unknown as {
        __gameSession?: { remoteController?: unknown; localController?: unknown };
      }).__gameSession;
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
}

// Auto-wire on import. App.tsx imports this module for the side
// effect; the function is also exported for tests / manual re-wiring.
const __wireResult = wireServerTransport();
(window as unknown as { __wireServerTransportCalled?: boolean }).__wireServerTransportCalled = true;
void __wireResult;
