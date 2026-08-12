// Phase 0 / PR 3 — React shell with Babylon canvas + a keybind HUD.
//
// The canvas is mounted via a ref so the Babylon Engine can attach to it
// directly. The scene is built asynchronously (Havok wasm + WebGPU adapter
// are loaded), so we render a thin "Scene loading…" placeholder until the
// scene is ready. The `dispose()` handle lets us clean up on unmount so
// React StrictMode's double-mount doesn't leak a render loop.
//
// The keybind HUD on top of the canvas lists the PR 3 controls (WASD /
// Space / Shift / C / Q / V) so Kyle doesn't have to guess.

import { useEffect, useRef, useState } from "react";
import { createScene, type SceneHandle } from "../engine/scene";

export function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<SceneHandle | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [engineLabel, setEngineLabel] = useState<"webgpu" | "webgl2" | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    createScene(canvas)
      .then((handle) => {
        if (disposed) {
          handle.dispose();
          return;
        }
        sceneRef.current = handle;
        setEngineLabel(handle.isWebGPU() ? "webgpu" : "webgl2");
        setPhase("ready");
      })
      .catch((err: unknown) => {
        if (disposed) return;
        setError(err instanceof Error ? err.message : String(err));
        setPhase("error");
      });

    return () => {
      disposed = true;
      sceneRef.current?.dispose();
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
          <OverlayBanner bottom={16} size="0.7rem" opacity={0.35}>
            Phase 0 — character controller · click canvas to focus · WASD to move
          </OverlayBanner>
        </>
      )}
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
        Specialists Web — PR 3 controls
      </div>
      <div><Key>W A S D</Key> walk</div>
      <div><Key>Space</Key> jump</div>
      <div><Key>Shift</Key> dive (tap while moving)</div>
      <div><Key>C</Key> slide (hold + move)</div>
      <div><Key>Q</Key> wallrun (tap mid-air)</div>
      <div><Key>V</Key> camera · third-person ↔ first-person</div>
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
