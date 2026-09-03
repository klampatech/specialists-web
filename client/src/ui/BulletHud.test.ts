// PR #115 (post-#114) — BulletHud helper-function tests.
//
// The BulletHud is a React DOM overlay. We don't have
// @testing-library/react wired up (vitest runs in node
// environment; React component tests would require jsdom + RTL
// setup). The component's behavior is tested end-to-end via
// `client/tools/crosshair-smoke.mjs` (real canary + Playwright),
// which covers the DOM-render surface.
//
// What we CAN test in vitest are the helper functions added in
// PR #115 — `isBurstActiveBadge()` decides whether the "● FIRING"
// badge shows. The DOM-render surface for this is a single
// conditional render keyed off `data-testid="bullet-hud-burst-active"`,
// which is exercised by the crosshair smoke.
//
// The contract that matters here is "Burst3 + isFiring=1 ⇒ true;
// everything else ⇒ false". Lock that contract in vitest so a
// future tweak to the fire-mode enum (e.g. adding Burst5) can't
// silently break the badge.

import { describe, it, expect } from "vitest";
import { isBurstActiveBadge, weaponIconSvg } from "./BulletHud";
import { WEAPONS_TABLE, WeaponId, FireMode } from "../../../protocol/constants";

describe("BulletHud isBurstActiveBadge (PR #115)", () => {
  const dualPistol = WEAPONS_TABLE[WeaponId.DualPistol];
  // Sanity: DualPistol actually has Burst3 at index 1 — if this
  // changes (e.g. a new Burst5 mode is added before Burst3), the
  // Burst-active contract changes too. Lock that here.
  const BURST3_INDEX = dualPistol.fireModes.findIndex(
    (m) => m === FireMode.Burst3,
  );

  it("DualPistol's Burst3 mode is at fireModeIndex=1 (lock the contract)", () => {
    expect(BURST3_INDEX).toBe(1);
  });

  it("returns true iff DualPistol is in Burst3 AND isFiring=1", () => {
    // Burst3 + firing → active
    expect(isBurstActiveBadge(dualPistol, BURST3_INDEX, 1)).toBe(true);
    // Burst3 + NOT firing → inactive (badge flashes only while firing)
    expect(isBurstActiveBadge(dualPistol, BURST3_INDEX, 0)).toBe(false);
  });

  it("returns false in Semi mode regardless of isFiring (no visual noise)", () => {
    const SEMI_INDEX = dualPistol.fireModes.findIndex(
      (m) => m === FireMode.Semi,
    );
    expect(SEMI_INDEX).toBe(0);
    expect(isBurstActiveBadge(dualPistol, SEMI_INDEX, 1)).toBe(false);
    expect(isBurstActiveBadge(dualPistol, SEMI_INDEX, 0)).toBe(false);
  });

  it("returns false for Shotgun/Sniper (no Burst3 mode, badge must not show)", () => {
    const shotgun = WEAPONS_TABLE[WeaponId.Shotgun];
    const sniper = WEAPONS_TABLE[WeaponId.Sniper];
    // Both Shotgun + Sniper only have Semi at index 0.
    expect(shotgun.fireModes[0]).toBe(FireMode.Semi);
    expect(sniper.fireModes[0]).toBe(FireMode.Semi);
    expect(isBurstActiveBadge(shotgun, 0, 1)).toBe(false);
    expect(isBurstActiveBadge(sniper, 0, 1)).toBe(false);
    // Bounds check: any out-of-range fireModeIndex returns false
    // (defensive — the snapshot can't actually push past the
    // array length, but the helper is exposed for unit testing).
    expect(isBurstActiveBadge(dualPistol, 99, 1)).toBe(false);
    expect(isBurstActiveBadge(dualPistol, -1, 1)).toBe(false);
  });
});

describe("BulletHud weaponIconSvg (PR #115)", () => {
  // PR #115 (post-#114) — close the "weapon icon sprites" carry-
  // forward from PR #108. Replaces ASCII-letter D/S/N labels with
  // inline SVG icons. The contract: each weapon gets a unique
  // non-empty SVG string, unknown ids fall back to DualPistol's
  // icon (defensive — the snapshot can't actually push an unknown
  // weaponId, but the helper is exposed for unit testing).

  it("returns a non-empty <svg> for each known weaponId", () => {
    for (const weaponId of [WeaponId.DualPistol, WeaponId.Shotgun, WeaponId.Sniper]) {
      const svg = weaponIconSvg(weaponId);
      expect(svg).toContain("<svg");
      expect(svg).toContain("</svg>");
      expect(svg.length).toBeGreaterThan(50); // real SVG, not empty stub
    }
  });

  it("returns different SVG per weapon (icons are visually distinct)", () => {
    const dSvg = weaponIconSvg(WeaponId.DualPistol);
    const sSvg = weaponIconSvg(WeaponId.Shotgun);
    const nSvg = weaponIconSvg(WeaponId.Sniper);
    expect(dSvg).not.toBe(sSvg);
    expect(sSvg).not.toBe(nSvg);
    expect(dSvg).not.toBe(nSvg);
  });

  it("falls back to DualPistol icon for unknown / negative ids", () => {
    const dualPistolIcon = weaponIconSvg(WeaponId.DualPistol);
    expect(weaponIconSvg(99)).toBe(dualPistolIcon);
    expect(weaponIconSvg(-1)).toBe(dualPistolIcon);
    expect(weaponIconSvg(0.5)).toBe(dualPistolIcon);
  });

  it("uses currentColor (cascades from the parent's color style)", () => {
    // All three icons must use stroke="currentColor" so the chip's
    // `color: "#ffce5a"` style cascades into the SVG strokes. If
    // a future tweak hardcodes a color, the icon won't react to
    // theme changes.
    for (const weaponId of [WeaponId.DualPistol, WeaponId.Shotgun, WeaponId.Sniper]) {
      expect(weaponIconSvg(weaponId)).toContain('stroke="currentColor"');
    }
  });
});
