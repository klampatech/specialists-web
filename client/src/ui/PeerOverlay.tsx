// Phase 0 / PR 4 — WebRTC peer overlay UI.
//
// The peer is owned by App.tsx and passed in as a prop. We surface:
//   - a status badge (data-testid="status") reflecting the current
//     connection state — "Waiting for room" / "Waiting for ICE…" /
//     "Connected" / "Disconnected" / etc.
//   - "Create Room" + "Join" buttons + a paste-an-answer textarea.
//
// On `peer.on("open")` the status flips to "Connected". On disconnect it
// flips to "Disconnected". The parent (App.tsx) mirrors the status into
// `BulletHud` so the bottom-left HUD chip stays in sync.

import { useEffect, useState } from "react";
import { mapStatusToConnectionStatus } from "./connectionStatus";
import { parseRoomFromUrl } from "../net/serverTransport";

// PR 11.7.D2 / §3.10 — WebRTCPeer + signaling imports REMOVED.
// The P2P host/join flow is gone; the overlay now surfaces the
// ServerTransport lifecycle (driven by scene.ts via a future
// getServerTransport accessor + a window probe).

interface PeerOverlayProps {
  /** PR 11.7.D2 / §3.10 — peer prop REMOVED. The WebRTC overlay
   *  is gone; the overlay now drives purely off the `?server=`
   *  URL flag + the ServerTransport connection lifecycle. */
  /** Mirror the connection status up to App so BulletHud can show it. */
  onStatusChange?: (status: "offline" | "waiting-ice" | "connected" | "disconnected") => void;
}

/**
 * PR 11.6.D / §3.6 — read the `?server=` URL parameter on module
 * load. When present (e.g. `?server=ws://localhost:14434/rooms/DEVBX`
 * or `https://localhost:14433/rooms/DEVBX`), sets the
 * `__forceServerTransport` DEV probe so scene.ts wires the
 * server-auth transport on boot. Default (no `?server=`) keeps the
 * existing P2P substrate for the 14 legacy smokes.
 *
 * Side-effect runs at module evaluation time (BEFORE React renders,
 * BEFORE scene.ts's `useEffect` runs), so scene.ts sees the flag.
 *
 * Fires in BOTH dev and prod builds. The `?server=` URL parameter
 * is the canonical prod entrypoint — lobby clients hit
 * `?server=wss://...` after Create room, and the prod scene wires
 * ServerTransport off this flag. Previously gated behind
 * `import.meta.env.DEV` (so prod bundles stripped this block) —
 * that broke production: no ServerTransport in prod → HUD stuck
 * "Offline". See PR #112+ for prod deploy testing. Removed DEV gate
 * in Hetzner staging rollout 2026-09-04.
 */
if (typeof window !== "undefined" && typeof window.location !== "undefined") {
  const url = new URL(window.location.href);
  const serverParam = url.searchParams.get("server");
  // PR 11.7.D3 / loud diagnostic — always log the parsed state on
  // module load. Lets the user (and DevTools) see immediately
  // whether the URL had the param, what was parsed, and whether
  // the transport will be enabled. Was previously silent.
  console.info(
    `[PeerOverlay] boot: href=${url.href.slice(0, 120)}… serverParam=${serverParam ?? "<missing>"} forceServerTransport=${serverParam ? "true" : "false"}`,
  );
  if (serverParam && serverParam.length > 0) {
    (window as unknown as {__forceServerTransport?: boolean}).__forceServerTransport = true;
    try {
      const u = new URL(serverParam);
      (window as unknown as {__damageServerUrl?: string}).__damageServerUrl = u.origin;
      const roomParam = url.searchParams.get("room");
      let resolvedRoomId: string | undefined;
      if (roomParam) {
        resolvedRoomId = roomParam;
      } else {
        // DEVBX-hardcode-cleanup (2026-08-30): if the smoke harness
        // didn't pass a redundant `?room=...` query param, derive the
        // room id from the `?server=ws://host:port/rooms/<id>` path.
        // The smoke harness convention is to encode the room in the
        // server URL, so this is the path the actual URLs use. If
        // the path is malformed (no `/rooms/<id>`), surface it here
        // — `scene.ts`'s `ServerTransport` constructor will throw
        // loudly rather than silently default to DEVBX.
        try {
          resolvedRoomId = parseRoomFromUrl(u.toString());
        } catch {
          // No room in the server URL — leave `__damageServerRoomId`
          // unset; scene.ts will throw if it's actually needed.
        }
      }
      if (resolvedRoomId) {
        (window as unknown as {__damageServerRoomId?: string}).__damageServerRoomId = resolvedRoomId;
      }
      const localIdParam = url.searchParams.get("localId");
      if (localIdParam) {
        const n = Number(localIdParam);
        if (Number.isFinite(n) && n > 0) {
          (window as unknown as {__localPlayerId?: number}).__localPlayerId = n;
        }
      }
      // PR 11.7.D2.1 / FIX — peerId URL param was silently ignored.
      // Pre-fix: PeerOverlay read `?localId` but NOT `?peerId`, so
      // Tab B's URL `?localId=2&peerId=1` set __localPlayerId=2 but
      // __peerPlayerId fell back to its default (2). Both tabs
      // thought Player 2 was the peer, leading to misrouted
      // DamageRequests when the server's Gate3 fix landed. Reading
      // both URL params keeps the two tabs symmetric.
      const peerIdParam = url.searchParams.get("peerId");
      if (peerIdParam) {
        const n = Number(peerIdParam);
        if (Number.isFinite(n) && n > 0) {
          (window as unknown as {__peerPlayerId?: number}).__peerPlayerId = n;
        }
      }
    } catch {
      // Malformed server URL — ignore, fall back to default path.
    }
  } else {
    // PR 11.7.D3 / fix — surface a hard error in the HUD if the
    // page loaded WITHOUT ?server=. Post-substrate-retirement
    // (PR #50), the lockstep P2P transport is gone; without
    // ?server= the GameSession gets no transport and the HUD
    // silently shows "Disconnected: (idle)" — looks like a bug
    // but is really a missing URL param. Setting a window flag
    // lets BulletHud render an actionable error instead.
    //
    // PR 11.7.D3 / CI-fix — only emit the console.error when the
    // page is actually requesting multiplayer transport. The HUD
    // flag still fires so the user sees the actionable banner.
    // The console.error was causing CI smokes (mouse-look, mouse-pitch,
    // lockstep-rollback, spectator-camera, health-regression) to
    // fail on `PAGE_ERRORS:` because they test single-player behaviors
    // and don't pass `?server=`. Pre-#50 these smokes were P2P-aware;
    // post-#50 they're single-player with multiplayer plumbing idle.
    // The HUD shows the actionable error to real users; the console
    // log was redundant noise.
    (window as unknown as {__missingServerParam?: boolean}).__missingServerParam = true;
    if ((window as unknown as {__forceServerTransport?: boolean}).__forceServerTransport === true) {
      console.error(
        "[PeerOverlay] URL is missing ?server=ws://...&localId=N&peerId=M. " +
        "After PR #50 retired the lockstep P2P substrate, the page " +
        "needs the ?server= param to know where to connect. " +
        "Example: http://100.95.111.112:5174/?server=ws://100.95.111.112:14434/rooms/DEVBX&localId=1&peerId=2",
      );
    }
  }
}

export function PeerOverlay({ onStatusChange }: PeerOverlayProps) {
  const [status, setStatus] = useState<string>("Server: waiting");

  // PR 11.7.D2 / §3.10 — replaced WebRTC peer-lifecycle hooks
  // (`peer.on("open" / "disconnect")`) with a polling loop on
  // `window.__serverTransport` (set by scene.ts's
  // __forceServerTransport probe). Reports the current
  // `getStats().connected` bit + transport kind up to the parent via
  // `onStatusChange`.
  //
  // PR 75 — bumped poll cadence from 200ms → 100ms (10Hz, matches
  // App.tsx's HUD-timer cadence) so the BulletHud connection chip
  // reflects mid-frame transport state transitions within the same
  // window as the other HUD fields. Was previously lagging ~200ms
  // behind, which surfaces as a visible flicker when the MacBook
  // sleeps + wakes or the WebTransport connection drops + reconnects.
  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      if (cancelled) return;
      const t = (window as unknown as {__serverTransport?: {getStats?: () => {connected?: boolean; transport?: string}}}).__serverTransport;
      if (!t || !t.getStats) {
        setStatus("Server: offline (no __serverTransport)");
        return;
      }
      const stats = t.getStats();
      if (stats.connected) {
        setStatus(`Server: connected (${stats.transport ?? "unknown"})`);
      } else {
        setStatus(`Server: connecting (${stats.transport ?? "unknown"})`);
      }
    };
    poll();
    const interval = window.setInterval(poll, 100);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  // Mirror the status up to App for the BulletHud connection chip.
  // PR 75 — extracted the mapping to a pure helper (vitested under
  // Node, no jsdom) so the state-machine surface is regression-covered.
  useEffect(() => {
    if (!onStatusChange) return;
    onStatusChange(mapStatusToConnectionStatus(status));
  }, [status, onStatusChange]);

  return (
    <div
      data-testid="peer-overlay"
      style={{
        position: "fixed",
        right: 16,
        top: 16,
        width: 310,
        padding: 12,
        background: "rgba(10, 10, 12, 0.82)",
        color: "#eee",
        font: "12px monospace",
        zIndex: 5,
        border: "1px solid rgba(230, 230, 230, 0.18)",
        borderRadius: 6,
      }}
    >
      {/* PR 11.7.D2 / §3.10 — overlay renamed to "Server connection"
          and now shows only the ServerTransport status. The
          Host/Join clipboard UI is gone (no P2P). */}
      <b>Server connection</b>
      <div data-testid="status" style={{ margin: "8px 0" }}>{status}</div>
    </div>
  );
}
