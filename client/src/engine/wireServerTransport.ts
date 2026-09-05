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
// PR #130 / Hetzner staging 2026-09-05 — predictor/interpolator/snapshot-decoder
// migration out of scene.ts (see the new IIFE block at the bottom of this module).
// Top-level imports keep the symbols alive in Vite's tree-shake output
// (mirrors the wireServerTransport extraction pattern from PR #128).
import { decodeSnapshot } from "../../../protocol/snapshot";
import { Predictor } from "./clientPredictor";
import { Interpolator } from "./remoteInterpolator";
import { decodeInput } from "../net/inputBitmask";
import { HEALTH } from "./characterConfig";
import type { GameSession } from "../game/gameSession";

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
        // Broadcast handler — calls damageBus.applyBroadcast with
        // a LATE-BOUND controller resolver (reads `__gameSession`
        // on every broadcast, not the closure-captured controller).
        // Pre-fix: closure capture pinned localCtrl/remoteCtrl to the
        // first createScene()'s instance. Under React StrictMode
        // the SECOND createScene's instance is the live one, so the
        // broadcast handler would apply damage to a disposed
        // controller (no observable HP change in the HUD). Late-binding
        // mirrors the PR #128 setServerTransport fix.
        const broadcastHandler = (body: Uint8Array) => {
          const bc = damageBus.decodeDamageBroadcast(body);
          if (!bc) return;
          const liveSess: {
            localController?: CharacterController | unknown;
            remoteController?: CharacterController | unknown;
          } | null = readGameSession();
          const liveLocalCtrl = liveSess?.localController as CharacterController | undefined;
          const liveRemoteCtrl = liveSess?.remoteController as CharacterController | undefined;
          if (!liveLocalCtrl || !liveRemoteCtrl) return;
          damageBus.applyBroadcast(
            bc,
            performance.now(),
            (playerId: number) => (playerId === localPlayerId ? liveLocalCtrl : liveRemoteCtrl),
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

// === PR #130 / Hetzner staging 2026-09-05 — Snapshot decoder block ===
//
// The snapshot decoder + Predictor + Interpolator + LIVE
// `__liveInterpolatorTickHook` publish that lived inside scene.ts's
// `if (useServerTransportFromOpts || useServerTransportFromWindow)` IIFE
// (lines 1197-1513 pre-#129-followup) was being tree-shaken from prod
// builds. The snapshot stream arrived on the wire but was NEVER decoded
// — `__latestSnap()` returned null in prod. Mirror the PR #128 / PR #129
// pattern: do it here in this side-effect-imported module so Vite
// preserves it.
//
// Order note: the wire-up IIFE above polls for `__gameSession` for up to
// 2s; this block ALSO polls for `__gameSession` (same window). They are
// independent — both run on page load in parallel, both see the same
// live gameSession instance. No race; no double-wire (the
// `__predictor` / `__interpolator` guards bail on a second invocation).
//
// Local aliases for window reads — keep the IIFE self-contained (the
// `win` + `readGameSession` closure-captures inside wireServerTransport()
// aren't visible at module top-level).
const __wstWindow = window as unknown as {
  __serverTransport?: {
    onSnapshot?: (cb: (body: Uint8Array) => void) => void;
  };
  __gameSession?: GameSession;
  __predictor?: unknown;
  __interpolator?: unknown;
  __latestSnap?: () => import("../../../protocol/snapshot").Snapshot | null;
  __localPlayerId?: number;
  __remoteController?: unknown;
};
const __wstReadGameSession = (): GameSession | null => {
  return __wstWindow.__gameSession ?? null;
};
void (async () => {
  try {
    // Don't double-wire — React StrictMode (App.tsx) imports this
    // module twice on mount; bail if the second invocation finds the
    // first's Interpolator already published.
    if (__wstWindow.__interpolator !== undefined || __wstWindow.__predictor !== undefined) {
      return;
    }
    // Poll for __gameSession (up to 10s — Havok WASM streaming-compile
    // failure + ArrayBuffer fallback path on self-signed certs can push
    // scene init well past 2s on cold prod. Mirrors the existing
    // waitForGameSession helper used in the wire-up block above.
    const __wstStart = performance.now();
    let liveSession: GameSession | null = null;
    while (performance.now() - __wstStart < 10000) {
      liveSession = __wstReadGameSession();
      if (liveSession) break;
      await new Promise<void>((r) => setTimeout(r, 32));
    }
    if (!liveSession) {
      console.warn(
        "[wireServerTransport] snapshot decoder skipped — no __gameSession on window after 2s",
      );
      return;
    }
    // PR #131 — also poll for a REAL __serverTransport (ServerTransport
    // instance), not the "INIT_INFLIGHT" sentinel. The broadcast wire-up
    // IIFE races us; if we find gameSession first (scene.ts publishes it
    // before IIFE 1's `await server.connect()` resolves), __serverTransport
    // may still be the sentinel. Without this poll, snapshot decoder
    // bails while the wire is still connecting.
    const __wstServerStart = performance.now();
    let liveServer: ServerTransport | null = null;
    while (performance.now() - __wstServerStart < 5000) {
      const candidate = __wstWindow.__serverTransport;
      if (candidate && typeof candidate === "object" && typeof candidate.onSnapshot === "function") {
        liveServer = candidate as ServerTransport;
        break;
      }
      await new Promise<void>((r) => setTimeout(r, 16));
    }
    if (!liveServer) {
      console.warn(
        "[wireServerTransport] snapshot decoder skipped — __serverTransport not yet connected (or no onSnapshot) after 5s",
      );
      return;
    }
    const liveLocalCtrl = liveSession.localController as
      | CharacterController
      | undefined;
    const liveRemoteCtrl = liveSession.remoteController as
      | CharacterController
      | undefined;
    const liveLocalPlayerId = __wstWindow.__localPlayerId ?? 1;
    if (!liveLocalCtrl) {
      console.warn(
        "[wireServerTransport] snapshot decoder skipped — __gameSession.localController missing",
      );
      return;
    }

    // Havok-step wrapper (PR 11.7.C / §3.7) — advances the LIVE Havok
    // controller by one frame, reads the post-update state, then
    // RESTORES the controller to its prior position+velocity (a
    // "phantom" simulation: temporarily step physics, capture the
    // result, then revert). The live controller is unchanged after the
    // wrapper returns, but the wrapper reports the state Havok WOULD
    // have reached if the input had been applied. This is the
    // predictor's source of forward-predicted positions for the
    // snapshot-driven drift check.
    //
    // **Why save/restore, not just step**: `gameSession.tick()` (called
    // from the render observer at scene.ts:484) already advances the
    // live controller per-frame. A naive step would double-advance.
    // Save/restore is O(1) per call.
    const havokStep = (
      _state: import("../../../protocol/snapshot").PlayerState,
      encoded: Uint8Array,
    ): import("../../../protocol/snapshot").PlayerState => {
      const decoded = decodeInput(encoded);
      const savedPos = liveLocalCtrl.havok.getPosition().clone();
      const savedVel = liveLocalCtrl.havok.getVelocity().clone();
      liveLocalCtrl.update(decoded, 1 / 60, performance.now());
      const postPos = liveLocalCtrl.havok.getPosition();
      const postVel = liveLocalCtrl.havok.getVelocity();
      const result: import("../../../protocol/snapshot").PlayerState = {
        playerId: liveLocalPlayerId,
        positionX: postPos.x,
        positionY: postPos.z,
        velocityX: postVel.x,
        velocityY: postVel.z,
        yaw: 0, // PR 11.7.B wire doesn't carry yaw/pitch
        pitch: 0,
        hp: liveLocalCtrl.state.hp,
        ammo: 0,
        isFiring: decoded.fireHeld ? 1 : 0,
        weaponId: 0,
        currentFireMode: 0,
      };
      liveLocalCtrl.havok.setPosition(savedPos);
      liveLocalCtrl.havok.setVelocity(savedVel);
      return result;
    };
    const predictor = new Predictor(
      liveLocalPlayerId,
      havokStep,
      () => liveSession.frame,
    );
    const interpolator = new Interpolator(liveLocalPlayerId);

    // PR 11.7.D3.1 — respawn-snap HP edge detector. Snapshot's
    // `players[i].hp` going `0 → 100` on the 20Hz server-authoritative
    // stream is the canonical respawn signal post-#50. Fire
    // `remoteController.respawn()` so Havok + visualRoot teleport to
    // `respawnPosition` (already canonical per PR 10.2). The 3s grace
    // window inside respawn() suppresses the observer's setPosition
    // clobbering the teleport with the snapshot's pre-respawn value.
    const prevHpByPlayerId = new Map<number, number>();

    let latestSnap: import("../../../protocol/snapshot").Snapshot | null = null;
    liveServer.onSnapshot((body: Uint8Array) => {
      const snap = decodeSnapshot(body);
      if (!snap) return;
      const now = performance.now();
      latestSnap = snap;
      // HP edge detection — must run BEFORE the interpolator so the
      // respawn teleport takes effect this frame.
      for (const p of snap.players) {
        // Skip placeholder ids (1000+) — un-promoted connections
        // waiting for their first DamageRequest.
        if (p.playerId >= 1000) continue;
        const prevHp = prevHpByPlayerId.get(p.playerId) ?? HEALTH.maxHp;
        if (prevHp <= 0 && p.hp === HEALTH.maxHp) {
          if (liveRemoteCtrl) {
            liveRemoteCtrl.respawn(now);
            // Refresh the interpolator's per-frame buffer so the visual
            // tracking starts clean at the respawn position.
            if (typeof window !== "undefined") {
              const w = window as unknown as {
                __lastInterpolatorSetPosition?: {
                  x: number;
                  z: number;
                  ts: number;
                  playerId: number;
                };
              };
              w.__lastInterpolatorSetPosition = {
                x: liveRemoteCtrl.respawnPosition.x,
                z: liveRemoteCtrl.respawnPosition.z,
                ts: now,
                playerId: p.playerId,
              };
            }
          }
        }
        prevHpByPlayerId.set(p.playerId, p.hp);
      }
      // PR #108 — pull the LOCAL player's authoritative weapon state
      // from the snapshot. The snapshot's weaponId / currentFireMode
      // are the source of truth; the optimistic local state set by
      // `tryStartWeaponSwitch` is overwritten here so a dropped packet
      // (server's rate-limit gate) doesn't leave the HUD desynced.
      const localSnap = snap.players.find(
        (p) => p.playerId === liveLocalPlayerId,
      );
      if (localSnap) {
        const sessWithSet = liveSession as {
          _setLocalWeaponStateFromSnapshot?: (
            weaponId: number,
            fireMode: number,
          ) => void;
        };
        sessWithSet._setLocalWeaponStateFromSnapshot?.(
          localSnap.weaponId,
          localSnap.currentFireMode,
        );
      }
      predictor.onSnapshot(snap, now);
      interpolator.onSnapshot(snap, now);
    });

    // PR 11.7.D2.1 — publish the LIVE remote-controller + the
    // interpolation tick body to the window slot. This decouples the
    // render observer from the createScene() closure that originally
    // set the hook. Under React StrictMode the first createScene wins
    // the sync-claim guard, then gets disposed; the second
    // createScene's observer must then drive the hook against the
    // LIVE (window-resolved) remote controller. Without this, the
    // observer calls a closure-bound hook whose remoteCtrl is disposed
    // (scene.dispose → gameSession.dispose → remoteController.havok
    // disposed) and setPosition silently no-ops.
    if (typeof window !== "undefined") {
      const liveHook = (nowMs: number) => {
        const liveRemote = (window as unknown as {
          __gameSession?: GameSession;
        }).__gameSession?.remoteController as CharacterController | undefined;
        if (!liveRemote) return;
        const liveInterpolator = (window as unknown as {
          __interpolator?: InstanceType<typeof Interpolator>;
        }).__interpolator;
        if (!liveInterpolator) return;
        const liveStates = liveInterpolator.tick(nowMs);
        if (liveStates.length === 0) return;
        const liveState = liveStates[0];
        // PR 11.7.D3.2 / post-merge hardening — skip position writes
        // during the respawn grace period (3s after `respawn()` fires).
        if (liveRemote.isInRespawnGrace(nowMs)) {
          return;
        }
        liveRemote.havok.setPosition(liveState.position);
        // PR 11.7.D3 / walk-mirror visual fix — mirror the snapshot
        // position onto the visualRoot TransformNode AND state.position
        // so the rig visually tracks the snapshot, not just the Havok
        // body.
        liveRemote.setVisualPosition(liveState.position);
        liveRemote.state.position.copyFrom(liveState.position);
        // Debug hooks so the smoke's __lastInterpolatorTick +
        // __lastInterpolatorSetPosition stay populated when the
        // render observer is in a different scope from the original
        // closure.
        const w = window as unknown as {
          __lastInterpolatorTick?: { ts: number; statesCount: number };
          __lastInterpolatorSetPosition?: {
            x: number;
            z: number;
            ts: number;
            playerId: number;
          };
        };
        w.__lastInterpolatorTick = {
          ts: performance.now(),
          statesCount: liveStates.length,
        };
        w.__lastInterpolatorSetPosition = {
          x: liveState.position.x,
          z: liveState.position.z,
          ts: performance.now(),
          playerId: liveState.playerId,
        };
      };
      (window as unknown as {
        __liveInterpolatorTickHook?: ((nowMs: number) => void) | null;
      }).__liveInterpolatorTickHook = liveHook;
    }

    // DEV probes — forward-looking instrumentation for the snapshot
    // smoke. The `__latestSnap` getter OVERWRITES the null-returning
    // snapGetter installed by the wire-up block above so smoke
    // consumers get the real decoded snapshot.
    (window as unknown as { __predictor?: Predictor }).__predictor = predictor;
    (window as unknown as { __interpolator?: Interpolator }).__interpolator =
      interpolator;
    (window as unknown as {
      __latestSnap?: () => import("../../../protocol/snapshot").Snapshot | null;
    }).__latestSnap = () => latestSnap;

    // Late-bind the predictor onto the GameSession so tick() can call
    // predictor.recordLocalInput alongside the existing
    // runtime.submitLocalInput.
    const sessWithSetPred = liveSession as {
      setPredictor?: (p: Predictor) => void;
    };
    sessWithSetPred.setPredictor?.(predictor);

    console.info(
      "[wireServerTransport] snapshot decoder wired, Interpolator + LIVE tick hook published",
    );
  } catch (e) {
    // console.warn, not console.error — same reason as the wire-up
    // block above. The smoke harness treats console.error as a
    // page-level failure.
    console.warn("[wireServerTransport] snapshot decoder init failed:", e);
  }
})();

// Auto-wire on import. App.tsx imports this module for the side
// effect; the function is also exported for tests / manual re-wiring.
const __wireResult = wireServerTransport();
(window as unknown as { __wireServerTransportCalled?: boolean }).__wireServerTransportCalled = true;
void __wireResult;
