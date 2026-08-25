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
  /** PR 11.7.E / §3.5 — current local ammo count (server-authoritative,
   *  sourced from `__latestSnap().players[localPeerId].ammo`). */
  localAmmo: number;
  /** PR 11.7.E / §3.5 — magazine size. Mirrors
   *  `COMBAT.dualPistol.PLAYER_MAX_AMMO` (server is canonical). */
  maxAmmo: number;
  /** PR 11.7.E / §3.5 — reload-progress timestamp (`performance.now()`-
   *  relative) or `null` when idle. While non-null, the HUD renders a
   *  fill-left-to-right progress bar normalized to
   *  `reloadProgressMs` (see below). Cleared by `__latestSnap` when
   *  the snapshot reports `local ammo === maxAmmo`. */
  reloadingUntilMs: number | null;
  /** PR 11.7.E / §3.5 — total reload animation duration in ms.
   *  Mirrors `COMBAT.dualPistol.reloadMs`. The HUD uses this to
   *  compute the fill ratio `(reloadingUntilMs - now) / reloadProgressMs`. */
  reloadProgressMs: number;
}

function statusLabel(s: BulletHudProps["connectionStatus"]): string {
  switch (s) {
    case "connected": return "Connected";
    case "waiting-ice": return "Waiting for ICE…";
    case "disconnected": return "Disconnected";
    default: return "Offline";
  }
}

// PR 11.7.D3 / UX fix — when the URL is missing ?server=, show
// an actionable error instead of the generic "Offline" label.
// Surfacing the actual cause in the HUD cuts debugging time
// from "is it Chrome? network? my code?" to "I forgot the
// URL param".
function missingServerMessage(): string | null {
  if (typeof window === "undefined") return null;
  const flag = (window as unknown as {__missingServerParam?: boolean}).__missingServerParam;
  if (!flag) return null;
  return "URL missing ?server=…&localId=N&peerId=M (post-PR #50 retired P2P)";
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
export function BulletHud({ frame, repeatedFrames, connectionStatus, hasRemote, hits, localHp, remoteHp, localRespawningMs, remoteRespawningMs, localAmmo, maxAmmo, reloadingUntilMs, reloadProgressMs }: BulletHudProps) {
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
        {missingServerMessage() ? (
          <span style={{ color: "#f55" }}>
            {missingServerMessage()}
          </span>
        ) : (
          <>{statusLabel(connectionStatus)}{hasRemote ? "" : " (idle)"}</>
        )}
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
      {/* PR 11.7.E / §3.5 — ammo display (server-authoritative via
          __latestSnap; mirrors the existing HP-them line pattern).
          `▮` for a loaded chamber, `▯` for an empty one. Reads from
          the snapshot's `local ammo` field; the HUD never reads a
          local controller field (the controller doesn't carry ammo —
          only the snapshot does, after PR 11.7.B's wire-format
          stabilization). */}
      <div data-testid="bullet-hud-ammo" style={{ opacity: 0.95 }}>
        Ammo: {Array.from({ length: maxAmmo }, (_, i) => (i < localAmmo ? "▮" : "▯")).join("")} /{maxAmmo}
      </div>
      {/* PR 11.7.E / §3.5 — reload progress bar. Renders only while
          `reloadingUntilMs !== null`. Fill ratio is
          `(reloadingUntilMs - now) / reloadProgressMs`, clamped 0..1.
          The bar's visible width tracks the client-local reload
          timer (NOT the server's processing time — the server
          completes the reload within one tick; the bar is purely
          visual feedback for "I'm reloading right now"). Cleared
          by the `__latestSnap` listener in scene.ts when the
          snapshot reports `local ammo === maxAmmo`. */}
      {reloadingUntilMs !== null && (() => {
        const now = performance.now();
        const remaining = Math.max(0, reloadingUntilMs - now);
        const fillRatio = Math.max(0, Math.min(1, remaining / reloadProgressMs));
        const barWidth = 80;
        const filledWidth = Math.round(barWidth * fillRatio);
        return (
          <div data-testid="bullet-hud-reload-bar" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ opacity: 0.85 }}>Reload:</span>
            <div
              style={{
                width: barWidth,
                height: 6,
                background: "rgba(230, 230, 230, 0.18)",
                borderRadius: 2,
                position: "relative",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  right: 0,
                  width: filledWidth,
                  background: "#ffce5a",
                  transition: "width 0.05s linear",
                }}
              />
            </div>
          </div>
        );
      })()}
    </div>
  );
}
