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
import { isBurstActiveBadge } from "./BulletHud";
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
