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
//
// PR #108 — adds the per-weapon HUD strip: weapon display name,
// ASCII-letter weapon icon (D/S/N), ammo bar driven by
// `WEAPONS_TABLE[weaponId].magazineSize` (was hardcoded to 6 via
// `maxAmmo` prop), fire-mode label (SEMI / BURST-3), and a Burst
// "active" badge when the snapshot's `isFiring` is 1 + we're in
// Burst mode + burst count > 0. The icon work was deferred to a
// polish PR per the carry-forward (no real icon sprites shipped
// with PR #108; fal.ai was locked).

import {
  WEAPONS_TABLE,
  WeaponId,
  FireMode,
  type WeaponDef,
} from "../../../protocol/constants";

/** PR 11.7.E / §3.5 — BulletHud props. PR #108 added per-weapon
 *  fields; PR #115 (post-#114) adds `isFiring` so the HUD can show
 *  a "● FIRING" badge while the local tab holds LMB in Burst mode
 *  (carries the Burst-active feedback from PR #108's comment into
 *  code). The snapshot's `isFiring` is the wire-bool; the local
 *  fireModeIndex lets us gate the badge to Burst3 mode (no need to
 *  flash on every Semi shot — that'd be visual noise). */
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
  /** PR 11.7.E / §3.5 — magazine size for the CURRENT weapon.
   *  Sourced from `WEAPONS_TABLE[weaponId].magazineSize` (PR #108
   *  moved this out of the hardcoded `COMBAT.dualPistol.PLAYER_MAX_AMMO`
   *  mirror so the HUD reads the correct magazine cap when the player
   *  switches to Shotgun (8) or Sniper (5)). Kept as a prop rather than
   *  computed inline so the existing reload-progress math doesn't need
   *  to derive it (the parent `App.tsx` already plumbs the per-weapon
   *  value through `gameSession.getLocalWeaponState()` → snapshot). */
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
  /** PR #108 — current weapon id (0=DualPistol, 1=Shotgun, 2=Sniper).
   *  Sources from `gameSession.getLocalWeaponState()`. Used by the
   *  per-weapon HUD strip to render the right display name + icon +
   *  fire-mode label. */
  weaponId: number;
  /** PR #108 — current fire-mode index (0=Semi, 1=Burst3 for DualPistol;
   *  0=Semi for Shotgun/Sniper). Used by the HUD's fire-mode label
   *  ("SEMI" / "BURST-3") and by the Burst-active badge in PR #115. */
  fireModeIndex: number;
  /** PR #115 (post-#114) — local snapshot's `isFiring` (0 or 1
   *  wire-bool). When 1 AND fireModeIndex corresponds to Burst3,
   *  the HUD shows the "● FIRING" badge. For Semi/Auto modes we
   *  don't show the badge (visual noise on every shot). */
  isFiring: number;
}

/** PR 11.7.E / §3.5 — Burst-active helper. Returns true iff the
 *  HUD should show the "● FIRING" badge: weapon is in Burst3 mode
 *  AND snapshot reports `isFiring=1`. Exported so the vitest in
 *  `BulletHud.test.ts` can lock the contract. */
export function isBurstActiveBadge(
  weapon: WeaponDef,
  fireModeIndex: number,
  isFiring: number,
): boolean {
  // 1 = Burst3 in DualPistol's fireModes[]. Defensively check
  // bounds so the helper is safe to call with arbitrary inputs.
  return (
    fireModeIndex >= 0 &&
    fireModeIndex < weapon.fireModes.length &&
    weapon.fireModes[fireModeIndex] === FireMode.Burst3 &&
    isFiring === 1
  );
}

function statusLabel(s: BulletHudProps["connectionStatus"]): string {
  switch (s) {
    case "connected": return "Connected";
    case "waiting-ice": return "Waiting for ICE…";
    case "disconnected": return "Disconnected";
    default: return "Offline";
  }
}

/** PR #108 — pick the per-weapon HUD data from the current
 *  weaponId. Falls back to DualPistol for unknown ids (the
 *  defensive pattern from `weaponDef()` in protocol/constants.ts).
 *  The HUD never blocks on unknown ids — it just shows whatever
 *  the snapshot's first frame reported. */
function currentWeaponDef(weaponId: number): WeaponDef {
  return WEAPONS_TABLE[weaponId] ?? WEAPONS_TABLE[WeaponId.DualPistol];
}

/** PR #108 — ASCII-letter weapon icon (D/S/N). The carry-forward
 *  ships text labels first; real icon sprites are a follow-up PR.
 *  Single-letter codes: D=DualPistol (two pistols), S=Shotgun,
 *  N=Sniper (N for "sNiper"). */
function weaponIconLetter(weaponId: number): string {
  switch (weaponId) {
    case WeaponId.Shotgun: return "S";
    case WeaponId.Sniper: return "N";
    case WeaponId.DualPistol:
    default: return "D";
  }
}

/** PR 11.7.E / §3.5 — fire-mode label. Maps the `WEAPONS_TABLE[weaponId]
 *  .fireModes[fireModeIndex]` discriminant to a 4-character
 *  uppercase label. Burst3 → "BURST3", Semi/Auto → "SEMI"/"AUTO". */
export function fireModeLabel(weaponId: number, fireModeIndex: number): string {
  const def = currentWeaponDef(weaponId);
  const mode = def.fireModes[fireModeIndex] ?? FireMode.Semi;
  switch (mode) {
    case FireMode.Burst3: return "BURST";
    case FireMode.Auto: return "AUTO";
    case FireMode.Semi:
    default: return "SEMI";
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
export function BulletHud({ frame, repeatedFrames, connectionStatus, hasRemote, hits, localHp, remoteHp, localRespawningMs, remoteRespawningMs, localAmmo, reloadingUntilMs, reloadProgressMs, weaponId, fireModeIndex, isFiring }: BulletHudProps) {
  // PR #108 — derive per-weapon HUD data. The `maxAmmo` prop is
  // kept on the BulletHudProps interface for back-compat with
  // App.tsx's plumbing (the parent still passes the
  // `PLAYER_MAX_AMMO` constant for the reload-progress bar's
  // width math), but the ammo bar itself now uses
  // `weaponDef.magazineSize` so it reads correctly when the
  // player switches to Shotgun (8) or Sniper (5).
  const weapon = currentWeaponDef(weaponId);
  const magazineSize = weapon.magazineSize;
  const iconLetter = weaponIconLetter(weaponId);
  const modeLabel = fireModeLabel(weaponId, fireModeIndex);
  // PR #115 (post-#114) Burst-active badge. Show "● FIRING" only
  // when the player is in Burst3 mode AND actively firing — the
  // Burst3 mode is the only one where a single LMB hold produces
  // a multi-shot sequence worth visually distinguishing (Semi is
  // one-shot-per-click, Auto is full-auto and the badge would
  // just be permanently lit). Burst shot count is not in the
  // snapshot yet — see the carry-forward at the bottom of this
  // file for the count-down variant.
  const isBurstActive = isBurstActiveBadge(
    weapon,
    fireModeIndex,
    isFiring,
  );
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
      {/* PR #108 — per-weapon HUD strip. Shows the current
          weapon's display name, single-letter icon (D/S/N),
          and fire-mode label (SEMI / BURST / AUTO). The icon
          is a follow-up PR per the carry-forward (real sprite
          assets are a polish item). The strip lives above the
          ammo line so the player sees the weapon name first,
          then the ammo count underneath. */}
      <div data-testid="bullet-hud-weapon" style={{ opacity: 0.95 }}>
        <span style={{ display: "inline-block", width: 12, textAlign: "center", marginRight: 4, color: "#ffce5a" }}>[{iconLetter}]</span>
        <span style={{ opacity: 0.95 }}>{weapon.displayName}</span>
        <span style={{ marginLeft: 6, opacity: 0.7, fontSize: 10 }}>{modeLabel}</span>
        {isBurstActive && (
          <span
            data-testid="bullet-hud-burst-active"
            style={{
              marginLeft: 6,
              padding: "0 4px",
              background: "#ffce5a",
              color: "#0a0a0c",
              borderRadius: 2,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 0.5,
            }}
          >
            ● FIRING
          </span>
        )}
      </div>
      {/* PR 11.7.E / §3.5 + PR #108 — ammo display. Magazine size
          is now per-weapon (DualPistol=10, Shotgun=8, Sniper=5);
          the bar derives `magazineSize` from `WEAPONS_TABLE` so
          switching weapons updates the visible cap. Reads ammo
          from the snapshot's `local ammo` field; the HUD never
          reads a local controller field (the controller doesn't
          carry ammo — only the snapshot does, after PR 11.7.B's
          wire-format stabilization). */}
      <div data-testid="bullet-hud-ammo" style={{ opacity: 0.95 }}>
        Ammo: {Array.from({ length: magazineSize }, (_, i) => (i < localAmmo ? "▮" : "▯")).join("")} /{magazineSize}
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
