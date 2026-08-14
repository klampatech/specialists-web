// Phase 0 / PR 4+7+10 — bottom-left HUD chip.
//
// PR 4 shows the live lockstep frame number, how many frames the runtime had
// to fill by repeating the last-known remote input (a tell-tale of packet
// loss or peer lag), and the high-level WebRTC connection state.
//
// PR 7 adds a `hits:` line driven by `gameSession.getCombatEvents().length`.
// "Hits" here counts every tracer render (fire_hit + fire_miss + melee_hit)
// — the test that proves the rising-edge combat code fired at least once in
// the smoke. Updated ~10Hz from App.tsx; the chip itself is a pure render.
//
// PR 10 adds `HP me:` / `HP them:` lines for the local + remote controllers
// with an optional `(respawn Xms)` countdown suffix when the respawn timer
// is armed.
//
// PR 7.4 cleanup: removed the `fireHeld` / `meleePressed` / `bulletTime`
// debug block that was originally added to prove the input listener was
// firing during the LMB/RMB-eating-HUD bug hunt. Combat is now confirmed
// working in headless + dev-box two-tab playtests, and the top-center
// `<BulletTimeChip>` in App.tsx renders the production bullet-time state.

interface BulletHudProps {
  frame: number;
  repeatedFrames: number;
  connectionStatus: "offline" | "waiting-ice" | "connected" | "disconnected";
  hasRemote: boolean;
  /** Total combat events emitted by the GameSession so far. */
  hits: number;
  /** PR 10: live HP for the LOCAL controller (clamped 0..HEALTH.maxHp). */
  localHp: number;
  /** PR 10: live HP for the REMOTE controller (clamped 0..HEALTH.maxHp). */
  remoteHp: number;
  /** PR 10: timestamp (ms) at which the LOCAL controller's respawn fires.
   *  0 when not respawning. Rendered as a countdown when > 0. */
  localRespawningMs: number;
  /** PR 10: same for the REMOTE controller. */
  remoteRespawningMs: number;
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
export function BulletHud({ frame, repeatedFrames, connectionStatus, hasRemote, hits, localHp, remoteHp, localRespawningMs, remoteRespawningMs }: BulletHudProps) {
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
          the timer is 0 (idle) we render nothing in parens so the line
          still occupies a stable row in the chip (no layout jitter on
          respawn). */}
      <div data-testid="bullet-hud-hp-local" style={{ opacity: 0.95 }}>
        HP me: {localHp}{localRespawningMs > 0 ? ` (respawn ${localRespawningMs}ms)` : ""}
      </div>
      <div data-testid="bullet-hud-hp-remote" style={{ opacity: 0.95 }}>
        HP them: {remoteHp}{remoteRespawningMs > 0 ? ` (respawn ${remoteRespawningMs}ms)` : ""}
      </div>
    </div>
  );
}
