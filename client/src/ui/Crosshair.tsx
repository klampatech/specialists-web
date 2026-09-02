// Crosshair — PR #110 — center-screen weapon-aware crosshair.
//
// PR #108 shipped the weapons wire + HUD strip + smoke + CI job, but
// explicitly deferred a crosshair component as "new feature, not
// wire-follow-up". PR #110 closes that gap. The crosshair is a pure
// DOM overlay (no Babylon scene element) — it sits at viewport
// center, ignores pointer events, and re-renders only when its
// inputs change. Its appearance tracks the per-weapon tunables
// (color + spread from WEAPONS_TABLE) and the local fire state
// (a 1.6× recoil spread while LMB is held).
//
// **Why a DOM overlay and not a Babylon mesh?**
//   - Babylon meshes need a 3D position in world space; a
//     center-screen crosshair is by definition a screen-space
//     element. Doing it in the 3D scene would require either
//     billboarded sprite anchored to the camera (Babylon
//     `Sprite` with `SpriteManager`) or a `GUI.AdvancedDynamicTexture`
//     fullscreen plane. Either adds a per-frame draw call.
//   - A DOM div is GPU-composited, costs nothing in the render
//     loop, and is trivial to style with the existing monospace
//     chip aesthetic. Matches the existing HUD overlay pattern
//     (BulletHud, BulletTimeChip, PeerOverlay).
//   - Pointer-events: "none" — the crosshair MUST NOT eat clicks.
//     See PR 7.1 in BulletHud.tsx for the same lesson.
//
// **Why weapon-aware color + spread?**
//   The wire spec (docs/PR-105-spec.md §1.4) calls for "weapon-aware
//   crosshair (DualPistol grey, Shotgun orange, Sniper red), spread
//   per fire mode (Burst shows slight spread, Sniper a dot)". This
//   is the visual counterpart to the per-weapon HUD strip — same
//   intent, applied to where the player's eye lives (center-screen).
//   Sniper red signals "this is the long-range precision weapon,
//   hold steady"; Shotgun orange + wide spread signals "the cone
//   is wider than it looks, you won't get more accuracy than the
//   visual tells you".
//
// **Why recoil-spread on fire?**
//   Without it the crosshair is a static reticle that doesn't
//   react to firing. The TS 2.0 originals had ADS (aim-down-sights)
//   sway; we don't ship ADS yet (post-Phase-2 feature), but the
//   fire-spread cue is the cheap version of the same intent:
//   "you're firing, expect the cone to widen". 1.6× for the
//   duration of `fireHeld` reads as a noticeable "bloom" without
//   being so wide it makes the crosshair unreadable.
//
// **Crosshair sized to weapon:**
//   The crosshair is 4 short line segments (top / right / bottom /
//   left of center) at the weapon's `accuracyDegrees` projection
//   radius. The 4 segments are positioned absolutely from the
//   center — `spreadRadiusPx` controls the distance. While firing,
//   `spreadRadiusPx * 1.6`. The burst-active state adds a yellow
//   center dot (4px) so the player knows the Burst state machine
//   has consumed at least one round.
//
// **Edge cases:**
//   - weaponId unknown (pre-PR-#108 main): falls back to
//     DualPistol+tight spread (same defensive pattern as BulletHud).
//   - fireHeld true but ammo=0: the crosshair still spreads (firing
//     the empty chamber) — the server is authoritative for damage,
//     but the visual feedback stays consistent.
//   - Pointer not locked: crosshair still renders (it's a HUD
//     element, not gameplay-critical). Pausing (pointer unlocked
//     for the pause menu) keeps the crosshair visible — players
//     want to see their weapon state even when paused.

import {
  WEAPONS_TABLE,
  WeaponId,
  FireMode,
  type WeaponDef,
} from "../../../protocol/constants";

/** Same defensive fallback as `BulletHud.currentWeaponDef` —
 *  unknown weapon ids render as DualPistol rather than throwing.
 *  Mirrors the server's `weapon_def` PANIC-on-unknown-after-gate
 *  pattern but at the client we want the HUD to survive a snapshot
 *  race where the wire reports a weapon id the client mirror hasn't
 *  seen yet. Exported for the vitest boundary test. */
export function currentWeaponDef(weaponId: number): WeaponDef {
  return WEAPONS_TABLE[weaponId] ?? WEAPONS_TABLE[WeaponId.DualPistol];
}

/** Per-weapon color for the crosshair line segments. The color is
 *  desaturated (70% lightness) for legibility against any scene
 *  background — pure-white crosshairs are unreadable on bright
 *  outdoor scenes, and saturated colors look neon on dark scenes.
 *  Tuned in tandem with the BulletHud ammo bar's #ffce5a (yellow)
 *  so the two HUD elements have a coherent palette.
 *  Exported for the vitest boundary test. */
export function weaponColor(weaponId: number): string {
  switch (weaponId) {
    case WeaponId.Shotgun: return "#ff8c4a"; // orange
    case WeaponId.Sniper: return "#ff5a5a"; // red
    case WeaponId.DualPistol:
    default: return "#b8b8b8"; // neutral grey
  }
}

/** Map `accuracyDegrees` to a pixel radius for the crosshair line
 *  endpoints. The mapping is non-linear (sqrt) so the wide-spread
 *  Shotgun doesn't push the line segments off-screen, and the
 *  tight-spread Sniper still gets a readable ~8px gap.
 *
 *  Tunable: the constants below are calibrated for a 1080p display;
 *  the crosshair is `position: fixed` and rendered at 1:1 device
 *  pixels so 4K displays render it crisply without scaling.
 *  Smoke tolerance: ±2px on the spread radius assertions.
 *  Exported for the vitest boundary test. */
export function spreadRadiusPx(accuracyDegrees: number): number {
  // Empirical mapping: 1.5° → 14px, 8° → 30px, 0.5° → 8px.
  // Square-root keeps the wide end from running off-screen.
  return Math.round(8 + Math.sqrt(accuracyDegrees) * 8);
}

/** Recoil multiplier applied to spreadRadiusPx while fireHeld is
 *  true. 1.6× is "noticeable but not obtrusive" — auto-fire on a
 *  sniper would push it to 2.0× but we don't have auto fire yet
 *  (Burst state machine is Semi + Burst3; Auto is wire-defined but
 *  not yet bound to a key). Exported for the vitest boundary test. */
export const RECOIL_MULTIPLIER = 1.6;

/** Pure function — applies the recoil multiplier when fireHeld=true.
 *  Pulled out of the JSX so the vitest boundary test can assert on
 *  the math without rendering React. Returns the rounded pixel
 *  value the DOM uses. */
export function applyRecoil(baseRadius: number, fireHeld: boolean): number {
  return Math.round(fireHeld ? baseRadius * RECOIL_MULTIPLIER : baseRadius);
}

/** Visual props for the Crosshair component. Mirror the BulletHud
 *  shape (weaponId + fireModeIndex as numbers; fireHeld as boolean)
 *  so App.tsx can pass them straight through from the HudState. */
interface CrosshairProps {
  /** PR #108 — current weapon id (0=DualPistol, 1=Shotgun, 2=Sniper). */
  weaponId: number;
  /** PR #108 — current fire-mode index (0=Semi, 1=Burst3 on DualPistol).
   *  Drives the Burst-active center dot. */
  fireModeIndex: number;
  /** PR #110 — local fire-held flag (true while LMB is held).
   *  Drives the recoil-spread cue. */
  fireHeld: boolean;
}

/** Center-screen crosshair overlay. Four line segments (top, right,
 *  bottom, left) radiating from a center dot. Spacing is
 *  `spreadRadiusPx(weaponDef.accuracyDegrees)` plus the recoil
 *  multiplier when `fireHeld`. The Burst center dot shows when the
 *  player is in a Burst fire-mode AND currently firing. */
export function Crosshair({ weaponId, fireModeIndex, fireHeld }: CrosshairProps) {
  const weapon = currentWeaponDef(weaponId);
  const baseRadius = spreadRadiusPx(weapon.accuracyDegrees);
  const radius = applyRecoil(baseRadius, fireHeld);
  const color = weaponColor(weaponId);
  // PR #110 — burst-active cue: the center dot shows when the
  // player's fire-mode is a Burst variant AND they're currently
  // firing. This signals "the Burst state machine is consuming
  // rounds right now" without occupying permanent HUD real estate.
  const isBurstMode = weapon.fireModes[fireModeIndex] === FireMode.Burst3;
  const showBurstDot = isBurstMode && fireHeld;
  // Line segment length: 6px. Combined with the radius this gives
  // a crosshair that spans ~28-72px diameter depending on weapon.
  const lineLen = 6;
  return (
    <div
      data-testid="crosshair"
      data-weapon-id={weaponId}
      data-fire-held={fireHeld ? "1" : "0"}
      data-spread-radius-px={radius}
      style={{
        position: "fixed",
        top: "50%",
        left: "50%",
        // Translate -50%/-50% centers the wrapper on viewport center;
        // child line segments are positioned absolutely from there.
        transform: "translate(-50%, -50%)",
        width: 0,
        height: 0,
        // PR 7.1 — the crosshair MUST NOT eat clicks. The pointer-
        // lock flow expects every click outside an actual interactive
        // element to reach window for the input listener to handle.
        pointerEvents: "none",
        // Crosshair is layered above the canvas + below the pause
        // menu. BulletHud is z-index 4; Crosshair is z-index 3 so
        // the HUD chip stays on top when they overlap (rare, but
        // possible if the player has the reticle over the chip).
        zIndex: 3,
        // Smooth spread transition: ~120ms ease-out for the
        // recoil-spread cue, ~200ms for the per-weapon switch.
        // Matches the BulletHud ammo bar's `transition: width
        // 0.05s linear` cadence so the HUD feels coherent.
        transition: "transform 120ms ease-out",
      }}
    >
      {/* Top line */}
      <div
        style={{
          position: "absolute",
          left: -1,
          top: -(radius + lineLen),
          width: 2,
          height: lineLen,
          background: color,
          opacity: 0.9,
        }}
      />
      {/* Right line */}
      <div
        style={{
          position: "absolute",
          left: radius,
          top: -1,
          width: lineLen,
          height: 2,
          background: color,
          opacity: 0.9,
        }}
      />
      {/* Bottom line */}
      <div
        style={{
          position: "absolute",
          left: -1,
          top: radius,
          width: 2,
          height: lineLen,
          background: color,
          opacity: 0.9,
        }}
      />
      {/* Left line */}
      <div
        style={{
          position: "absolute",
          left: -(radius + lineLen),
          top: -1,
          width: lineLen,
          height: 2,
          background: color,
          opacity: 0.9,
        }}
      />
      {/* Center dot — always present (1px), grows to 4px when
          Burst-mode + fireHeld (the "Burst is consuming" cue). */}
      <div
        data-testid="crosshair-center-dot"
        style={{
          position: "absolute",
          left: -2,
          top: -2,
          width: showBurstDot ? 4 : 1,
          height: showBurstDot ? 4 : 1,
          borderRadius: "50%",
          background: showBurstDot ? "#ffce5a" : color,
          // Smooth size + color transition for the Burst cue.
          transition: "width 120ms ease-out, height 120ms ease-out, background 120ms ease-out",
        }}
      />
    </div>
  );
}
