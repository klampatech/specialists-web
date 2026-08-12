// Phase 0 / PR 4 — bottom-left HUD chip.
//
// Shows the live lockstep frame number, how many frames the runtime had to
// fill by repeating the last-known remote input (a tell-tale of packet loss
// or peer lag), and the high-level WebRTC connection state. Updated ~10Hz
// from App.tsx; the chip itself is a pure render.

interface BulletHudProps {
  frame: number;
  repeatedFrames: number;
  connectionStatus: "offline" | "waiting-ice" | "connected" | "disconnected";
  hasRemote: boolean;
}

function statusLabel(s: BulletHudProps["connectionStatus"]): string {
  switch (s) {
    case "connected": return "Connected";
    case "waiting-ice": return "Waiting for ICE…";
    case "disconnected": return "Disconnected";
    default: return "Offline";
  }
}

export function BulletHud({ frame, repeatedFrames, connectionStatus, hasRemote }: BulletHudProps) {
  return (
    <div
      data-testid="bullet-hud"
      style={{
        position: "fixed",
        left: 16,
        bottom: 16,
        padding: "6px 9px",
        background: "rgba(10, 10, 12, 0.72)",
        color: "#ddd",
        font: "12px monospace",
        zIndex: 4,
        border: "1px solid rgba(230, 230, 230, 0.18)",
        borderRadius: 4,
        lineHeight: 1.45,
      }}
    >
      <div>frame: {frame}</div>
      <div>
        confirmed: {frame - 1}
      </div>
      <div style={{ opacity: 0.7 }}>
        repeated: {repeatedFrames}
      </div>
      <div data-testid="bullet-hud-status" style={{ opacity: 0.85 }}>
        {statusLabel(connectionStatus)}{hasRemote ? "" : " (idle)"}
      </div>
    </div>
  );
}
