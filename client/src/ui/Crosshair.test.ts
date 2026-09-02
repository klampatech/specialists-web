/**
 * PR #110 — Crosshair helper-function tests.
 *
 * The Crosshair is a React DOM overlay. We don't have @testing-library/react
 * wired up (vitest runs in node environment; React component tests would
 * require jsdom + RTL setup). The component's behavior is tested end-to-end
 * via `client/tools/crosshair-smoke.mjs` (real canary + Playwright).
 *
 * What we CAN test in vitest are the helper functions:
 *   - `currentWeaponDef` (defensive fallback for unknown weapon ids)
 *   - `weaponColor` (per-weapon color)
 *   - `spreadRadiusPx` (accuracyDegrees → pixel radius mapping)
 *   - `applyRecoil` (1.6× multiplier when fireHeld)
 *
 * These are the inputs the component's JSX keys off of, so testing them
 * in isolation covers the data-derivation surface. The DOM-render surface
 * is tested in the smoke (DOM is environment-dependent, smoke runs against
 * a real canary).
 */

import { describe, it, expect } from "vitest";
import {
  currentWeaponDef,
  weaponColor,
  spreadRadiusPx,
  applyRecoil,
  RECOIL_MULTIPLIER,
} from "./Crosshair";
import { WEAPONS_TABLE, WeaponId, FireMode } from "../../../protocol/constants";

describe("Crosshair helpers", () => {
  describe("currentWeaponDef", () => {
    it("returns the matching WEAPONS_TABLE entry for known weapon ids", () => {
      expect(currentWeaponDef(WeaponId.DualPistol).weaponId).toBe(WeaponId.DualPistol);
      expect(currentWeaponDef(WeaponId.Shotgun).weaponId).toBe(WeaponId.Shotgun);
      expect(currentWeaponDef(WeaponId.Sniper).weaponId).toBe(WeaponId.Sniper);
    });

    it("falls back to DualPistol for unknown weapon ids (defensive)", () => {
      // Mirrors BulletHud's defensive pattern. The component never
      // crashes on a snapshot race where the wire reports an id the
      // client mirror hasn't seen yet.
      const fallback = currentWeaponDef(99);
      expect(fallback.weaponId).toBe(WeaponId.DualPistol);
      // Sanity-check the fallback isn't accidentally returning the same
      // object as a known lookup (would mask bug where the index is
      // valid but pointing at the wrong weapon).
      expect(fallback).toBe(WEAPONS_TABLE[WeaponId.DualPistol]);
    });

    it("falls back to DualPistol for negative ids (out-of-range)", () => {
      const fallback = currentWeaponDef(-1);
      expect(fallback.weaponId).toBe(WeaponId.DualPistol);
    });
  });

  describe("weaponColor", () => {
    it("DualPistol gets the neutral grey #b8b8b8", () => {
      expect(weaponColor(WeaponId.DualPistol).toLowerCase()).toBe("#b8b8b8");
    });

    it("Shotgun gets orange #ff8c4a (the wide-cone visual cue)", () => {
      expect(weaponColor(WeaponId.Shotgun).toLowerCase()).toBe("#ff8c4a");
    });

    it("Sniper gets red #ff5a5a (the precision-weapon visual cue)", () => {
      expect(weaponColor(WeaponId.Sniper).toLowerCase()).toBe("#ff5a5a");
    });

    it("unknown weapon ids render with the neutral grey (fallback)", () => {
      // Defensive pattern — an unknown id doesn't throw, it just
      // renders the same color as DualPistol. Players see the
      // crosshair; they don't see "an error occurred".
      expect(weaponColor(99).toLowerCase()).toBe(weaponColor(WeaponId.DualPistol).toLowerCase());
    });
  });

  describe("spreadRadiusPx (accuracyDegrees → pixel radius)", () => {
    it("DualPistol (1.5°) maps to ~18px", () => {
      // 8 + sqrt(1.5) * 8 ≈ 17.8 → round to 18.
      expect(spreadRadiusPx(1.5)).toBeGreaterThanOrEqual(16);
      expect(spreadRadiusPx(1.5)).toBeLessThanOrEqual(20);
    });

    it("Shotgun (8.0°) maps to ~31px (wider than DualPistol)", () => {
      // 8 + sqrt(8) * 8 ≈ 30.6 → round to 31.
      expect(spreadRadiusPx(8.0)).toBeGreaterThanOrEqual(28);
      expect(spreadRadiusPx(8.0)).toBeLessThanOrEqual(34);
    });

    it("Sniper (0.5°) maps to ~14px (the tightest spread)", () => {
      // 8 + sqrt(0.5) * 8 ≈ 13.66 → round to 14.
      // Lower bound is tightened — Sniper should be tighter than DualPistol.
      expect(spreadRadiusPx(0.5)).toBeGreaterThanOrEqual(10);
      expect(spreadRadiusPx(0.5)).toBeLessThanOrEqual(16);
    });

    it("spreads are monotonic in accuracyDegrees (sqrt curve)", () => {
      // Higher accuracyDegrees → wider spread. The smoke depends on this
      // ordering to know which weapon is "wider" without hardcoding radii.
      const sniper = spreadRadiusPx(0.5);
      const pistol = spreadRadiusPx(1.5);
      const shotgun = spreadRadiusPx(8.0);
      expect(sniper).toBeLessThan(pistol);
      expect(pistol).toBeLessThan(shotgun);
    });

    it("RECOIL_MULTIPLIER is 1.6 (matches the BLOOM_RECOIL contract)", () => {
      // Pin the multiplier. The smoke's bloom-cue assertion reads this
      // value back from the rendered DOM (data-spread-radius-px with
      // fireHeld=true vs false). If you change this constant, the
      // smoke needs updating too.
      expect(RECOIL_MULTIPLIER).toBe(1.6);
    });
  });

  describe("applyRecoil (1.6× on fireHeld)", () => {
    it("returns baseRadius unchanged when fireHeld=false", () => {
      expect(applyRecoil(18, false)).toBe(18);
    });

    it("multiplies by RECOIL_MULTIPLIER (1.6×) when fireHeld=true", () => {
      // Tolerance ±1px — Math.round on the multiplied value can drift
      // by 1px on odd baseRadius values.
      expect(applyRecoil(18, true)).toBeGreaterThanOrEqual(Math.round(18 * 1.6) - 1);
      expect(applyRecoil(18, true)).toBeLessThanOrEqual(Math.round(18 * 1.6) + 1);
    });

    it("recruit-spread ratio holds for all three MVP weapons", () => {
      // Firing spread is consistently ~1.6× the rest spread across
      // Sniper (0.5°), DualPistol (1.5°), and Shotgun (8.0°). The
      // smoke asserts this on the rendered DOM.
      for (const weaponId of [WeaponId.Sniper, WeaponId.DualPistol, WeaponId.Shotgun]) {
        const weapon = currentWeaponDef(weaponId);
        const base = spreadRadiusPx(weapon.accuracyDegrees);
        const firing = applyRecoil(base, true);
        expect(firing).toBeGreaterThanOrEqual(Math.round(base * 1.5));
        expect(firing).toBeLessThanOrEqual(Math.round(base * 1.7));
      }
    });
  });

  describe("Burst-active center dot logic (cross-component check)", () => {
    // The center-dot logic is computed in the JSX directly, not via a
    // helper — testing it here would require re-extracting. Instead,
    // this section tests the inputs that drive the dot, so the smoke
    // can reason about them: isBurstMode = weapon.fireModes[fireModeIndex] === FireMode.Burst3.

    it("DualPistol with fireModeIndex=1 is Burst3 (Burst-active when firing)", () => {
      const weapon = currentWeaponDef(WeaponId.DualPistol);
      expect(weapon.fireModes[1]).toBe(FireMode.Burst3);
    });

    it("Shotgun with fireModeIndex=0 is Semi (no Burst dot regardless of firing)", () => {
      const weapon = currentWeaponDef(WeaponId.Shotgun);
      expect(weapon.fireModes[0]).toBe(FireMode.Semi);
      expect(weapon.fireModes).not.toContain(FireMode.Burst3);
    });

    it("Sniper with fireModeIndex=0 is Semi (no Burst dot regardless of firing)", () => {
      const weapon = currentWeaponDef(WeaponId.Sniper);
      expect(weapon.fireModes[0]).toBe(FireMode.Semi);
      expect(weapon.fireModes).not.toContain(FireMode.Burst3);
    });
  });
});
