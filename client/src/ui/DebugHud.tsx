// PR 11.7.D3 — Debug HUD overlay.
//
// Toggle with the `~` (backtick) key. Shows real-time diagnostic state
// for cross-tab multiplayer debugging — replaces the need to read
// window globals via page.evaluate every time something looks wrong.
//
// Renders:
//   - Transport kind (websocket vs webtransport)
//   - WebGPU status
//   - Local Havok position
//   - Remote Havok position (from window.__remoteController)
//   - Snapshot players (live)
//   - Connection status + frame count
//
// Lives in its own component (not bolted onto BulletHud) because:
//   1. It runs at a higher poll rate (every render frame) than the HUD
//   2. It's DEV-only — gated on import.meta.env.DEV at the call site
//   3. It bypasses React state for low-latency display
//
// Reference: docs/SPEC.md "Observability" carry-forward (2026-08-23).

import * as React from "react";

export interface DebugHudProps {
  /** Whether the overlay is visible (toggle state, owned by parent). */
  visible: boolean;
}

export function DebugHud({ visible }: DebugHudProps): JSX.Element | null {
  // Refs for the DOM nodes we update each frame so we don't trigger React
  // re-renders 60 times a second.
  const transportRef = React.useRef<HTMLDivElement>(null);
  const localPosRef = React.useRef<HTMLDivElement>(null);
  const remotePosRef = React.useRef<HTMLDivElement>(null);
  const snapshotsRef = React.useRef<HTMLDivElement>(null);
  const ghostRef = React.useRef<HTMLDivElement>(null);
  const connectionRef = React.useRef<HTMLDivElement>(null);
  const webgpuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!visible) return;

    let rafId = 0;
    const tick = () => {
      rafId = requestAnimationFrame(tick);

      // Transport kind — read directly from the ServerTransport instance
      // exposed by client/src/net/serverTransport.ts.
      const transport = (window as any).__serverTransport;
      const activeKind: string = transport?.activeKind ?? "?";
      const isWT = activeKind === "webtransport";
      if (transportRef.current) {
        transportRef.current.innerHTML = `transport: <b style="color:${isWT ? "#0f0" : "#ff0"}">${activeKind}</b>`;
      }

      // Local Havok position — pull from window.__gameSession.localController.
      const sess = (window as any).__gameSession;
      const lp = sess?.localController?.havok?.getPosition?.();
      if (localPosRef.current) {
        if (lp) {
          localPosRef.current.innerHTML = `local  Havok:  (${lp.x.toFixed(2)}, ${lp.y.toFixed(2)}, ${lp.z.toFixed(2)})`;
        } else {
          localPosRef.current.innerHTML = `local  Havok:  —`;
        }
      }

      // Remote Havok position — pulled from the live remote controller that
      // the interpolator tick hook updates each frame.
      const remote = (window as any).__remoteController;
      const rp = remote?.havok?.getPosition?.();
      if (remotePosRef.current) {
        if (rp) {
          remotePosRef.current.innerHTML = `remote Havok:  (${rp.x.toFixed(2)}, ${rp.y.toFixed(2)}, ${rp.z.toFixed(2)})`;
        } else {
          remotePosRef.current.innerHTML = `remote Havok:  —`;
        }
      }

      // Snapshot players — read from the latest snapshot the interpolator
  // consumed. The scene exposes this via window.__latestSnap() which
  // returns the most recent snapshot the transport handed us.
  const getLatestSnap = (window as any).__latestSnap;
  const snap = typeof getLatestSnap === "function" ? getLatestSnap() : null;
  let playerList: any[] = [];
  if (snap?.players) {
    playerList = Array.isArray(snap.players)
      ? snap.players
      : Array.from(snap.players.values?.() ?? []);
  }
      if (snapshotsRef.current) {
        if (playerList.length > 0) {
          const ids = playerList.map((p: any) => p.id ?? p.playerId ?? "?").join(", ");
          const hps = playerList
            .map((p: any) => `${p.id ?? "?"}:${p.hp ?? "?"}`)
            .join(", ");
          snapshotsRef.current.innerHTML = `snapshot players: [${ids}]<br/>&nbsp;&nbsp;HP: [${hps}]`;
        } else {
          snapshotsRef.current.innerHTML = `snapshot players: (none)`;
        }
      }

      // Ghost connection counter — populated by the client. Increments
      // every time a snapshot includes a playerId >= 1000 (placeholder
      // ghost connection from before DamageRequest promoted the peer).
      const ghost = sess?.runtime?.ghostConnections ?? 0;
      if (ghostRef.current) {
        ghostRef.current.innerHTML = `ghost-connections (id>=1000): <b style="color:${ghost > 0 ? "#f55" : "#0f0"}">${ghost}</b>`;
      }

      // Connection state — read from the BulletHud's existing fields.
      const status = sess?.getStats?.() ?? {};
      if (connectionRef.current) {
        connectionRef.current.innerHTML = `connection: ${status.connected ? "✓" : "✗"}  rtt=${status.rttMs ?? "?"}ms  frame=${sess?.frame ?? "?"}`;
      }

      // WebGPU status — read once on mount, doesn't change at runtime.
      if (webgpuRef.current) {
        const wgpu = (window as any).__engineLabel;
        webgpuRef.current.innerHTML = `renderer: <b style="color:${wgpu === "webgpu" ? "#0f0" : "#ff0"}">${wgpu ?? "?"}</b>`;
      }
    };

    rafId = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(rafId);
  }, [visible]);

  if (!visible) return null;

  return (
    <div
      data-testid="debug-hud"
      style={{
        position: "fixed",
        top: 16,
        right: 16,
        padding: "10px 14px",
        background: "rgba(0, 0, 0, 0.85)",
        color: "#0f0",
        fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
        fontSize: 12,
        lineHeight: 1.5,
        border: "1px solid #0f0",
        borderRadius: 4,
        minWidth: 280,
        zIndex: 9999,
        pointerEvents: "none",
        whiteSpace: "pre",
      }}
    >
      <div style={{ color: "#fff", fontWeight: "bold", marginBottom: 4 }}>
        🐛 DEBUG HUD (toggle: `)
      </div>
      <div ref={transportRef}>transport: ?</div>
      <div ref={webgpuRef}>renderer: ?</div>
      <div ref={connectionRef}>connection: ?</div>
      <div ref={localPosRef}>local  Havok:  —</div>
      <div ref={remotePosRef}>remote Havok:  —</div>
      <div ref={snapshotsRef}>snapshot players: —</div>
      <div ref={ghostRef}>ghost-connections: 0</div>
    </div>
  );
}
