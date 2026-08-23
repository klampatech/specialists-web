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
import { DebugHud } from "./DebugHud";
import { PauseMenu } from "./PauseMenu";
// PR 11.7.D2 / §3.10 — WebRTCPeer + GgnetTransport imports REMOVED.
 // The P2P lockstep substrate is gone; see the header comment.

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
  /** PR 10: live HP for the LOCAL controller (drives the HUD chip). */
  localHp: number;
  /** PR 10: live HP for the REMOTE controller. */
  remoteHp: number;
  /** PR 10: timestamp (ms) at which the LOCAL controller's respawn fires.
   *  0 when not respawning. */
  localRespawningMs: number;
  /** PR 10: same for the REMOTE controller. */
  remoteRespawningMs: number;
  /** PR 11.2: pointer-lock state from the chase camera. Drives the
   *  pause-menu visibility (visible when `!isPointerLocked && everLocked`,
   *  which mirrors `chase.isMenuOrbit()`). */
  isPointerLocked: boolean;
  /** PR 11.2: true once the user has engaged pointer-lock at least once.
   *  Used as the gate that prevents the menu from flashing on a fresh
   *  page that hasn't been interacted with yet. */
  everLocked: boolean;
  /** PR 11.2: current locked viewMode (0 first-person, 1 over-shoulder).
   *  Drives the "return to <view>" subtitle on the Resume button. */
  viewMode: number;
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<SceneHandle | null>(null);
  // PR 11.7.D2 / §3.10 — peerRef REMOVED. No WebRTC peer to own;
  // the snapshot stream is the multiplayer connection now.
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [engineLabel, setEngineLabel] = useState<"webgpu" | "webgl2" | null>(null);
  // PR 11.7.D3 — Debug HUD visibility toggle (key: backtick `).
  // Persists across renders via React state; the keydown listener is
  // attached once at mount.
  const [debugHudVisible, setDebugHudVisible] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Backtick (the key above Tab on US keyboards). Also accept ~ via
      // Shift+Backtick for convenience.
      if (e.key === "`" || (e.shiftKey && e.key === "~")) {
        e.preventDefault();
        setDebugHudVisible((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Publish engineLabel to window so DebugHud can read it.
  // (Effect runs after engineLabel updates.)
  useEffect(() => {
    if (engineLabel) (window as any).__engineLabel = engineLabel;
  }, [engineLabel]);
  const [hud, setHud] = useState<HudState>({
    connectionStatus: "offline",
    frame: 0,
    repeatedFrames: 0,
    hasRemote: false,
    hits: 0,
    bulletTime: false,
    localHp: 100,
    remoteHp: 100,
    localRespawningMs: 0,
    remoteRespawningMs: 0,
    isPointerLocked: false,
    everLocked: false,
    viewMode: 0,
  });

  // PR 11.7.D2 / §3.10 — WebRTC peer / __peer / __smokeSignal /
  // __join probes REMOVED. The P2P lockstep signaling flow is
  // gone; the smoke uses `?server=` URL routing + the
  // ServerTransport DEV probes instead.

  // Stable callback so PeerOverlay's useEffect doesn't re-fire every render.
  const reportConnection = useCallback((s: HudState["connectionStatus"]) => {
    setHud((h) => (h.connectionStatus === s ? h : { ...h, connectionStatus: s }));
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    // PR 11.7.D2 / §3.10 — no transport arg. The multiplayer scene
    // is enabled by the `?server=` URL flag (PeerOverlay.tsx reads
    // it on module load + sets `__forceServerTransport`). When set,
    // scene.ts wires ServerTransport + remoteInterpolator + remote
    // Havok controller. If unset, the scene is single-player.
    createScene(canvas)
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
          // PR 11.7.D2 / fixes #50-verify: read chase state FIRST
          // (it's independent of gameSession — the pause menu /
          // pointer-lock UI needs it even in single-player mode).
          // The health + repeatedFrames + combatEvents reads below
          // remain gated on gameSession existence (single-player
          // has no gameSession; the values are multiplayer-only).
          //
          // PR 11.2: chase-camera state (pointer lock + menu orbit +
          // viewMode). Drives the pause-menu visibility. Single source
          // of truth: `handle.getChaseState?.()` returns a snapshot
          // read of the chase camera's internal flags.
          const chase = handle.getChaseState?.() ?? {
            isPointerLocked: false,
            isMenuOrbit: false,
            everLocked: false,
            viewMode: 0,
          };
          const session = handle.getGameSession?.();
          if (!session) {
            // Single-player path: keep chase-derived HUD fields live
            // (pointer lock, everLocked, viewMode) but skip the
            // multiplayer-only reads (HP, repeated frames, combat
            // events, bullet time).
            setHud((h) => ({
              ...h,
              connectionStatus: "offline",
              frame: 0,
              repeatedFrames: 0,
              hasRemote: false,
              hits: 0,
              bulletTime: false,
              localHp: 100,
              remoteHp: 100,
              localRespawningMs: 0,
              remoteRespawningMs: 0,
              isPointerLocked: chase.isPointerLocked,
              everLocked: chase.everLocked,
              viewMode: chase.viewMode,
            }));
            return;
          }
          // PR 7: pull the live InputState snapshot for the bullet-time chip.
          const inputState = handle.getInputState?.();
          // PR 10: pull the health snapshot so the HUD chip can render HP
          // + respawn countdown. Cheap read — just two field accesses.
          const health = session.getHealthSnapshot();
          // chase already declared above
          setHud((h) => ({
            ...h,
            frame: session.frame,
            repeatedFrames: session.repeatedFrameCount,
            hasRemote: session.runtime.hasRemote,
            hits: session.getCombatEvents().length,
            bulletTime: inputState?.bulletTimeHeld ?? false,
            localHp: health.local.hp,
            remoteHp: health.remote.hp,
            localRespawningMs: health.local.respawningMs,
            remoteRespawningMs: health.remote.respawningMs,
            isPointerLocked: chase.isPointerLocked,
            everLocked: chase.everLocked,
            viewMode: chase.viewMode,
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
  }, []);

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
          {/* PR 11.7.D3 — Debug HUD overlay. Toggle with ` key. */}
          <DebugHud visible={debugHudVisible} />
          <BulletTimeChip active={hud.bulletTime} />
          {/* PR 11.7.D2 / §3.10 — PeerOverlay repurposed for server
              connection status (no peer). The overlay no longer
              drives SDP copy/paste; it surfaces the ServerTransport
              connect/disconnect lifecycle via the existing
              onStatusChange prop. */}
          <PeerOverlay onStatusChange={reportConnection} />
          <BulletHud
            frame={hud.frame}
            repeatedFrames={hud.repeatedFrames}
            connectionStatus={hud.connectionStatus}
            hasRemote={hud.hasRemote}
            hits={hud.hits}
            localHp={hud.localHp}
            remoteHp={hud.remoteHp}
            localRespawningMs={hud.localRespawningMs}
            remoteRespawningMs={hud.remoteRespawningMs}
          />
          {/* PR 11.2: pause / loadout menu overlay. Visible when the
              pointer is unlocked AND the user has locked at least once
              (the `everLocked` gate prevents the menu from flashing on a
              fresh page). Resume closes the menu; Disconnect Peer closes
              the WebRTC connection. */}
          <PauseMenu
            visible={!hud.isPointerLocked && hud.everLocked}
            onResume={() => {
              // PR 11.2.3 DEBUG: log every Resume action (whether triggered
              // by the button click or by ESC-while-menu-visible — they
              // both funnel through here). Filter on "[PR-11.2.3-DEBUG]".
              if (typeof console !== "undefined") {
                console.log(
                  `[PR-11.2.3-DEBUG] App.onResume() t=${(performance.now() / 1000).toFixed(3)}s → calling handle.setPointerLock(true)`,
                );
              }
              const handle = sceneRef.current;
              if (!handle) return;
              handle.setPointerLock?.(true);
            }}
            onDisconnect={() => {
              // PR 11.7.D2 / §3.10 — close the ServerTransport.
              // The PeerOverlay surfaces the "disconnected" state
              // via its own interval; React state updates via
              // reportConnection. No peer to close.
              try {
                const t = sceneRef.current?.getServerTransport?.();
                t?.close?.();
              } catch (e) {
                console.error("[pause-menu] server-transport close failed:", e);
              }
            }}
            viewMode={hud.viewMode}
          />
          <OverlayBanner bottom={16} size="0.7rem" opacity={0.35}>
            Phase 0 PR 11.2 — pause menu (ESC to resume · LMB fire · RMB melee · T bullet time) · WASD/Space/Shift/C/Q/V unchanged
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
        Specialists Web — PR 10 controls (PR 6+7 keymap unchanged)
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
