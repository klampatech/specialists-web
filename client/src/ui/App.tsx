// Phase 0 / PR 3+4+7 — React shell with Babylon canvas + HUD + WebRTC overlay.
//
// The canvas is mounted via a ref so the Babylon Engine can attach to it
// directly. The scene is built asynchronously (Havok wasm + WebGPU adapter
// are loaded), so we render a thin "Scene loading…" placeholder until the
// scene is ready. The `dispose()` handle lets us clean up on unmount so
// React StrictMode's double-mount doesn't leak a render loop.
//
// PR 4: the WebRTC `WebRTCPeer` is owned here (not inside PeerOverlay) so
// that App can hand it to `createScene` via a `GgnetTransport` wrapper. The
// GameSession ticks every frame regardless of connection state — the remote
// rig stays at its spawn with zero input until the peer actually sends
// packets. BulletHud shows the live frame number + connection state.
//
// PR 7: HUD grows a `hits:` counter (combat events emitted by the session)
// and a top-center "BULLET TIME" chip that lights red when the local tab
// holds T. KeybindHud adds the combat bindings. All polled at ~10Hz from
// the existing HUD interval — no per-frame React re-renders.

import { useCallback, useEffect, useRef, useState } from "react";
import { createScene, type SceneHandle } from "../engine/scene";
import { PeerOverlay } from "./PeerOverlay";
import { BulletHud } from "./BulletHud";
import { WebRTCPeer, smokeSignalPut, smokeSignalGet } from "../net/peer";
import { GgnetTransport } from "../net/ggnet";

/** Snapshot the HUD reads each frame. We sample a handful of fields rather
 *  than the whole transport so React doesn't re-render on every input. */
interface HudState {
  /** "offline" / "waiting-ice" / "connected" / "disconnected" — displays as
   *  a single readable string in the overlay. */
  connectionStatus: "offline" | "waiting-ice" | "connected" | "disconnected";
  /** Latest lockstep frame the runtime has advanced. 0 before the first tick. */
  frame: number;
  /** Frames the runtime had to fill by repeating the last-known remote input. */
  repeatedFrames: number;
  /** True once the runtime has received at least one packet from the peer. */
  hasRemote: boolean;
  /** PR 7: total combat events emitted by the local session so far. */
  hits: number;
  /** PR 7: true while the local tab holds the T key (bullet time). */
  bulletTime: boolean;
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<SceneHandle | null>(null);
  const peerRef = useRef<WebRTCPeer | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [engineLabel, setEngineLabel] = useState<"webgpu" | "webgl2" | null>(null);
  const [hud, setHud] = useState<HudState>({
    connectionStatus: "offline",
    frame: 0,
    repeatedFrames: 0,
    hasRemote: false,
    hits: 0,
    bulletTime: false,
  });

  // Construct the WebRTC peer once per mount. The peer lives across scene
  // rebuilds (so "disconnect → reconnect" doesn't drop ICE state). The
  // transport wraps it for the GameSession.
  if (!peerRef.current) peerRef.current = new WebRTCPeer();
  const peer = peerRef.current;

  // Expose smoke-test API on window — the smoke script calls window.__join()
  // explicitly after mount, so this works regardless of StrictMode timing.
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__peer = peer;
    (window as unknown as Record<string, unknown>).__smokeSignal = {
      put: smokeSignalPut,
      get: smokeSignalGet,
    };
    // Called by the smoke script after mount — triggers the signaling flow
    // without relying on URL param reading timing inside a React effect.
    (window as unknown as Record<string, unknown>).__join = (offerB64: string) => {
      const offer = JSON.parse(atob(offerB64));
      peer.createAnswer(offer).then((answer) => {
        smokeSignalPut("sw_answer", JSON.stringify(answer));
      }).catch((err) => {
        console.error("[__join] createAnswer failed:", err);
      });
    };
  }, [peer]);

  // Stable callback so PeerOverlay's useEffect doesn't re-fire every render.
  const reportConnection = useCallback((s: HudState["connectionStatus"]) => {
    setHud((h) => (h.connectionStatus === s ? h : { ...h, connectionStatus: s }));
  }, []);

  // Wire peer lifecycle to the HUD.
  useEffect(() => {
    const onOpen = () => reportConnection("connected");
    const onDisconnect = () => reportConnection("disconnected");
    peer.on("open", onOpen);
    peer.on("disconnect", onDisconnect);
    return () => {
      // PeerOverlay's cleanup closes the connection on unmount — don't
      // double-close here.
    };
  }, [peer, reportConnection]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    const transport = new GgnetTransport(peer);
    createScene(
      canvas,
      { transport }, // multiplayer-on from frame 0; the runtime idles until peer connects
    )
      .then((handle) => {
        if (disposed) {
          handle.dispose();
          return;
        }
        sceneRef.current = handle;
        setEngineLabel(handle.isWebGPU() ? "webgpu" : "webgl2");
        setPhase("ready");

        // Poll the runtime at ~10Hz for HUD display (avoids per-render React
        // re-renders from per-frame state updates).
        const hudTimer = window.setInterval(() => {
          const session = handle.getGameSession?.();
          if (!session) return;
          // PR 7: pull the live InputState snapshot for the bullet-time chip.
          const inputState = handle.getInputState?.();
          setHud((h) => ({
            ...h,
            frame: session.frame,
            repeatedFrames: session.repeatedFrameCount,
            hasRemote: session.runtime.hasRemote,
            hits: session.getCombatEvents().length,
            bulletTime: inputState?.bulletTimeHeld ?? false,
          }));
        }, 100);
        // Stash the timer on the scene ref so unmount can clear it.
        (handle as unknown as { __hudTimer: number }).__hudTimer = hudTimer;
      })
      .catch((err: unknown) => {
        if (disposed) return;
        setError(err instanceof Error ? err.message : String(err));
        setPhase("error");
      });

    return () => {
      disposed = true;
      const handle = sceneRef.current;
      if (handle) {
        const t = (handle as unknown as { __hudTimer?: number }).__hudTimer;
        if (t !== undefined) window.clearInterval(t);
        handle.dispose();
      }
      sceneRef.current = null;
    };
  }, [peer]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        margin: 0,
        background: "#0a0a0c",
        color: "#e6e6e6",
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      }}
    >
      <canvas
        ref={canvasRef}
        tabIndex={0}
        style={{
          width: "100vw",
          height: "100vh",
          display: "block",
          outline: "none",
          touchAction: "none",
        }}
      />
      {phase === "loading" && (
        <OverlayBanner>Loading scene…</OverlayBanner>
      )}
      {phase === "error" && (
        <OverlayBanner color="#5a1a1a">
          Scene failed to start: {error}
        </OverlayBanner>
      )}
      {phase === "ready" && (
        <>
          <KeybindHud engineLabel={engineLabel} />
          <BulletTimeChip active={hud.bulletTime} />
          <PeerOverlay peer={peer} onStatusChange={reportConnection} />
          <BulletHud
            frame={hud.frame}
            repeatedFrames={hud.repeatedFrames}
            connectionStatus={hud.connectionStatus}
            hasRemote={hud.hasRemote}
            hits={hud.hits}
          />
          <OverlayBanner bottom={16} size="0.7rem" opacity={0.35}>
            Phase 0 PR 7 — combat (LMB fire · RMB melee · T bullet time) · WASD/Space/Shift/C/Q/V unchanged
          </OverlayBanner>
        </>
      )}
    </div>
  );
}

/**
 * PR 7: top-center chip that lights red while the local tab holds T.
 * Tiny chip — it's a status indicator, not a feature surface.
 */
function BulletTimeChip({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div
      data-testid="bullet-time-chip"
      style={{
        position: "fixed",
        top: 16,
        left: "50%",
        transform: "translateX(-50%)",
        padding: "0.4rem 0.9rem",
        background: "rgba(154, 30, 30, 0.85)",
        color: "#fff",
        font: "bold 0.85rem ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        border: "1px solid rgba(255, 120, 120, 0.6)",
        borderRadius: "0.4rem",
        zIndex: 5,
        pointerEvents: "none",
        letterSpacing: "0.12em",
      }}
    >
      BULLET TIME
    </div>
  );
}

function KeybindHud({ engineLabel }: { engineLabel: "webgpu" | "webgl2" | null }) {
  return (
    <div
      style={{
        position: "fixed",
        top: 16,
        left: 16,
        padding: "0.6rem 0.9rem",
        background: "rgba(10, 10, 12, 0.72)",
        border: "1px solid rgba(230, 230, 230, 0.18)",
        borderRadius: "0.45rem",
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        fontSize: "0.78rem",
        lineHeight: "1.45",
        color: "#e6e6e6",
        pointerEvents: "none",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>
        Specialists Web — PR 7 controls (PR 6 keymap unchanged)
      </div>
      <div><Key>W A S D</Key> walk</div>
      <div><Key>Space</Key> jump</div>
      <div><Key>Shift</Key> dive (tap while moving)</div>
      <div><Key>C</Key> slide (hold + move)</div>
      <div><Key>Q</Key> wallrun (tap mid-air)</div>
      <div><Key>V</Key> camera · third-person ↔ first-person</div>
      <div><Key>LMB</Key> fire dual pistols · <Key>RMB</Key> melee (1.5m cone) · <Key>T</Key> bullet time (0.25x, per-client)</div>
      {engineLabel && (
        <div style={{ marginTop: "0.4rem", opacity: 0.7 }}>
          renderer: {engineLabel}
        </div>
      )}
    </div>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: "inline-block",
        minWidth: "3.2rem",
        padding: "0 0.35rem",
        marginRight: "0.4rem",
        background: "rgba(230, 230, 230, 0.12)",
        border: "1px solid rgba(230, 230, 230, 0.25)",
        borderRadius: "0.25rem",
        textAlign: "center",
        fontSize: "0.72rem",
      }}
    >
      {children}
    </span>
  );
}

function OverlayBanner({
  children,
  color = "#0a0a0c",
  bottom = "50%",
  size = "0.95rem",
  opacity = 0.7,
}: {
  children: React.ReactNode;
  color?: string;
  bottom?: number | string;
  size?: string;
  opacity?: number;
}) {
  return (
    <div
      style={{
        position: "fixed",
        left: "50%",
        transform: "translate(-50%, -50%)",
        bottom,
        background: color,
        color: "#e6e6e6",
        padding: "0.5rem 0.9rem",
        borderRadius: "0.4rem",
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        fontSize: size,
        opacity,
        pointerEvents: "none",
      }}
    >
      {children}
    </div>
  );
}
