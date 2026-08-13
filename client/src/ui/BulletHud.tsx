// Phase 0 / PR 4+7 — bottom-left HUD chip.
//
// PR 4 shows the live lockstep frame number, how many frames the runtime had
// to fill by repeating the last-known remote input (a tell-tale of packet
// loss or peer lag), and the high-level WebRTC connection state.
//
// PR 7 adds a `hits:` line driven by `gameSession.getCombatEvents().length`.
// "Hits" here counts every tracer render (fire_hit + fire_miss + melee_hit)
// — the test that proves the rising-edge combat code fired at least once in
// the smoke. Updated ~10Hz from App.tsx; the chip itself is a pure render.

interface BulletHudProps {
  frame: number;
  repeatedFrames: number;
  connectionStatus: "offline" | "waiting-ice" | "connected" | "disconnected";
  hasRemote: boolean;
  /** Total combat events emitted by the GameSession so far. */
  hits: number;
  /** PR 7.2 debug: live mouse-button state from the input listener. */
  fireHeld: boolean;
  meleePressed: boolean;
  /** PR 7.2 debug: same as `bulletTime` but raw boolean. */
  bulletTime: boolean;
  /** PR 10: live HP for the LOCAL controller (clamped 0..HEALTH.maxHp). */
  localHp: number;
  /** PR 10: live HP for the REMOTE controller (clamped 0..HEALTH.maxHp). */
  remoteHp: number;
  /** PR 10: timestamp (ms) at which the LOCAL controller's respawn fires.
   *  0 when not respawning. Rendered as a countdown when > 0. */
  localRespawningMs: number;
  /** PR 10: same for the REMOTE controller. */
  remoteRespawningMs: number;
  /** PR 10.2 diagnostic: remote rig's world position (x, z) so we can
   *  confirm the visual mesh actually teleports to spawn on respawn. */
  remotePos: { x: string; z: string };
  /** PR 10.2 diagnostic: local rig's world position (x, z) for context. */
  localPos: { x: string; z: string };
  /** PR 10.2 diagnostic: respawn count (window.__respawnCount). 0 if N/A. */
  respawnCount: number;
}

function statusLabel(s: BulletHudProps["connectionStatus"]): string {
  switch (s) {
    case "connected": return "Connected";
    case "waiting-ice": return "Waiting for ICE…";
    case "disconnected": return "Disconnected";
    default: return "Offline";
  }
}

/**
 * PR 7.1 fix (post-Kyle playtest): the HUD chip was missing `pointerEvents: none`,
 * which meant clicks landing inside the bottom-left ~80x100px HUD box never
 * reached `window` — `BulletHud` was eating the LMB/RMB events that should
 * have been triggering combat. The chip is purely informational; nothing
 * inside it should ever intercept a click. Every overlaid HUD chip in this
 * file MUST keep `pointerEvents: "none"` (or `pointerEvents: "auto"` only on
 * the buttons it contains — but right now there are no buttons in the HUD).
 */
export function BulletHud({ frame, repeatedFrames, connectionStatus, hasRemote, hits, fireHeld, meleePressed, bulletTime, localHp, remoteHp, localRespawningMs, remoteRespawningMs, remotePos, localPos, respawnCount }: BulletHudProps) {
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
        font: "11px monospace",
        zIndex: 4,
        border: "1px solid rgba(230, 230, 230, 0.18)",
        borderRadius: 4,
        lineHeight: 1.4,
        pointerEvents: "none",
      }}
    >
      <div>frame: {frame}</div>
      <div>confirmed: {frame - 1}</div>
      <div style={{ opacity: 0.7 }}>repeated: {repeatedFrames}</div>
      <div data-testid="bullet-hud-status" style={{ opacity: 0.85 }}>
        {statusLabel(connectionStatus)}{hasRemote ? "" : " (idle)"}
      </div>
      <div data-testid="bullet-hud-hits" style={{ opacity: 0.95 }}>hits: {hits}</div>
      {/* PR 10: health pools + optional respawn countdown. The countdown
          shows the remaining ms on the respawning-until timestamp. When
          the timer is 0 (idle) we render `idle` so the line still occupies
          a stable row in the chip (no layout jitter on respawn). */}
      <div data-testid="bullet-hud-hp-local" style={{ opacity: 0.95 }}>
        HP me: {localHp}{localRespawningMs > 0 ? ` (respawn ${localRespawningMs}ms)` : ""}
      </div>
      <div data-testid="bullet-hud-hp-remote" style={{ opacity: 0.95 }}>
        HP them: {remoteHp}{remoteRespawningMs > 0 ? ` (respawn ${remoteRespawningMs}ms)` : ""}
      </div>
      {/* PR 10.2 diagnostic: rig world positions so we can visually
          confirm the respawn teleport actually moves the cyan rig back
          to (2.5, 0, 0). localPos is the red rig (chase-cam target),
          remotePos is the cyan rig. respawnCount is the lifetime count
          of `controller.respawn()` calls (local + remote combined). */}
      <div data-testid="bullet-hud-pos-local" style={{ opacity: 0.7 }}>
        me pos: ({localPos.x}, {localPos.z})
      </div>
      <div data-testid="bullet-hud-pos-remote" style={{ opacity: 0.7 }}>
        them pos: ({remotePos.x}, {remotePos.z})
      </div>
      <div data-testid="bullet-hud-respawn-count" style={{ opacity: 0.7 }}>
        respawns: {respawnCount}
      </div>
      {/* PR 7.2 DEBUG BLOCK: shows live input listener state so we can
          confirm whether the mouse/keyboard handlers are firing at all.
          If these stay "false" while LMB/T are pressed, the inputListener
          is the bug. Remove once combat is confirmed working. */}
      <div style={{ borderTop: "1px dashed #444", marginTop: 2, paddingTop: 2, opacity: 0.85 }}>
        <div>LMB: <span data-testid="debug-fire">{fireHeld ? "TRUE" : "false"}</span></div>
        <div>RMB: <span data-testid="debug-melee">{meleePressed ? "TRUE" : "false"}</span></div>
        <div>T: <span data-testid="debug-bullet">{bulletTime ? "TRUE" : "false"}</span></div>
      </div>
    </div>
  );
}
