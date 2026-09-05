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
// PR #128 follow-up (Hetzner staging, 2026-09-05) — Kyle's playtest on
// the prod bundle (https://65.108.87.1:14432/?server=...) showed the
// wire-up connecting (RTT 234ms, transport=websocket) but no snapshot
// stream reaching the scene — `__serverTransport.connected = true` but
// `snapshot = null`, no remote rig rendered, no hits registering. Root
// cause: scene.ts's createScene() runs an `if (useServerTransport...)`
// block (line 920) that wires `server.onDamageBroadcast(...)`,
// `liveGameSession.setServerTransport(server)`, and
// `server.onSnapshot(...) → predictor`. Vite/Rollup tree-shake that
// entire block from the prod bundle because the condition
// `useServerTransportFromOpts || useServerTransportFromWindow` is a
// runtime window-flag check the bundler can't prove is ever true.
//
// Fix: drive the wire-up integration from THIS module (top-level,
// side-effect-imported, Vite guarantees preservation). After
// `server.connect()` resolves, we:
//   1. Wait for the live `__gameSession` to be published (it is, after
//      scene.ts's createScene() reaches line 733 — `__gameSession =
//      gameSession`).
//   2. Register `server.onDamageBroadcast(broadcastHandler)` using the
//      late-bound gameSession controllers.
//   3. Register damageBus.onDamageReject (reverts spam-phase overshoot).
//   4. Call `liveGameSession.setServerTransport(server)` so gameSession.tick()
//      forwards PositionUpdate + DamageRequest through the wire.
//   5. Wire `server.onSnapshot(...)` so server-sent snapshots feed
//      gameSession's input/predictor subsystem.
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
import { createDamageBusProbe, applyReject } from "../net/damageBus";
import type { CharacterController } from "./characterController";

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
    // Not an error — most pages don't have `?server=` and that's
    // fine. The dev-only legacy smokes (mouse-look, mouse-pitch,
    // spectator-camera, etc.) treat `console.error` as a page-level
    // failure signal, so we log at info level. The smoke harness
    // bypass is to set `__forceServerTransport` + the URL-derived
    // globals via `page.addInitScript`.
    console.info(
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
      const damageBus = createDamageBusProbe(server);
      win.__damageBus = damageBus;
      // Expose the gameSession + remoteController on the window for
      // DebugHud's combat panel. scene.ts's createScene() also
      // publishes __gameSession, but it may not have run yet when
      // wireServerTransport completes; we re-publish here to be safe.
      const readGameSession = (): {
        remoteController?: unknown;
        localController?: unknown;
        setServerTransport?: (t: unknown) => void;
        health?: unknown;
      } | null =>
        (window as unknown as { __gameSession?: {
          remoteController?: unknown;
          localController?: unknown;
          setServerTransport?: (t: unknown) => void;
          health?: unknown;
        } }).__gameSession ?? null;
      const gs0 = readGameSession();
      if (gs0?.remoteController) {
        win.__remoteController = gs0.remoteController;
      }
      // PR #128 follow-up — drive the wire-up integration here.
      // scene.ts's IIFE was the previous home for these wires, but
      // Vite tree-shakes the IIFE in prod (the `if
      // (useServerTransport...)` condition is a runtime window-flag
      // check the bundler can't analyze). Doing the wire-up here
      // means it's part of THIS module's top-level statements,
      // which Vite preserves unconditionally.
      //
      // Order-sensitive: scene.ts publishes `__gameSession` at line
      // ~733 AFTER creating it. If we run before that point, we
      // retry on a microtask until `__gameSession` appears. On dev
      // canary the wire-up completes before scene.ts; in prod it
      // typically completes after (slow React render + Havok WASM
      // init). Either way the retry loop converges.
      const waitForGameSession = async (): Promise<NonNullable<ReturnType<typeof readGameSession>>> => {
        // Up to ~2s of retries — Havok WASM load + scene init can
        // take ~1s on cold prod. Subsequent polls run on microtasks.
        const start = performance.now();
        while (performance.now() - start < 2000) {
          const gs = readGameSession();
          if (gs) return gs;
          await new Promise<void>((r) => setTimeout(r, 16));
        }
        // Fallback: last poll. May be null in unit tests or page errors.
        return readGameSession() as unknown as NonNullable<ReturnType<typeof readGameSession>>;
      };
      const session = await waitForGameSession();
      if (!session) {
        // No gameSession present. Wire-up is still connected
        // (window.__serverTransport = server) so the smoke matrix
        // sees the wire, but the scene won't drive. Don't throw —
        // log and let the page continue rendering.
        console.warn(
          "[wireServerTransport] no __gameSession on window after 2s — wire connected but scene integration skipped",
        );
      } else {
        // PR #128 integration — register broadcast + reject handlers
        // and forward the live transport onto the GameSession.
        //
        // Broadcast handler — calls damageBus.applyBroadcast with the
        // late-bound controllers from the live gameSession. Mirrors
        // scene.ts's makeBroadcastHandler (which is inlined here so
        // we don't pull scene.ts's tree-shake-prone code in).
        const broadcastHandler = (body: Uint8Array): void => {
          if (typeof window !== "undefined") {
            const w = window as unknown as { __broadcastHandlerCount?: number };
            w.__broadcastHandlerCount = (w.__broadcastHandlerCount ?? 0) + 1;
          }
          const bc = damageBus.decodeDamageBroadcast(body);
          if (!bc) return;
          const liveSession: {
            localController?: CharacterController | unknown;
            remoteController?: CharacterController | unknown;
          } | null = readGameSession();
          const localCtrl = liveSession?.localController as CharacterController | undefined;
          const remoteCtrl = liveSession?.remoteController as CharacterController | undefined;
          if (!localCtrl || !remoteCtrl) return;
          damageBus.applyBroadcast(
            bc,
            performance.now(),
            (playerId: number) => (playerId === localPlayerId ? localCtrl : remoteCtrl),
          );
        };
        server.onDamageBroadcast(broadcastHandler);
        // Damage reject handler — late-binds applyReject to the live
        // session. PR 11.6.D fix4: reverts spam-phase overshoot by
        // recording rejections on the live damage bus.
        damageBus.onDamageReject((r) => {
          applyReject(localPlayerId, r.eventId, r.reason);
        });
        // PR #128 — forward the live transport onto the GameSession
        // so gameSession.tick() sends DamageRequest + PositionUpdate
        // through serverTransport.
        if (typeof session.setServerTransport === "function") {
          session.setServerTransport(server);
          console.info(
            "[wireServerTransport] live gameSession.setServerTransport(server) called — wire is integrated",
          );
        }
        if (typeof window !== "undefined") {
          const w = window as unknown as { __broadcastHandlerRegistered?: boolean };
          w.__broadcastHandlerRegistered = true;
        }
      }
      window.dispatchEvent(
        new CustomEvent("specialists:server-transport-ready", {
          detail: { server, damageBus: win.__damageBus },
        }),
      );
      console.info(
        "[wireServerTransport] connected to",
        urlBase,
        "room",
        roomId,
        "as player",
        localPlayerId,
      );
    } catch (err) {
      // console.warn, not console.error — same reason as above.
      // The smoke harness treats console.error as a page-level failure.
      console.warn("[wireServerTransport] connect failed:", err);
      win.__serverTransport = undefined;
    }
  })();
}

// Auto-wire on import. App.tsx imports this module for the side
// effect; the function is also exported for tests / manual re-wiring.
const __wireResult = wireServerTransport();
(window as unknown as { __wireServerTransportCalled?: boolean }).__wireServerTransportCalled = true;
void __wireResult;
