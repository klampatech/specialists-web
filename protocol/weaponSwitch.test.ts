// PR #108 — client-side weapons wire mirror tests.
//
// Validates that the TS-side `protocol/constants.ts` mirror
// (WEAPONS_TABLE, WeaponId, FireMode, HEADSHOT_MULTIPLIER,
// WEAPON_SWITCH_RATE_LIMIT_MS, PLAYER_MAX_AMMO) matches the
// server's `server/src/constants.rs` source of truth. If
// either side drifts (a per-weapon tunable changes, a new
// weapon is added, etc.), these tests fail — surfacing the drift
// in CI before a deploy ships.
//
// The cross-language guarantee is "same data, two layers of
// safety" — the existing `server/tests/protocol_wire.rs` size
// assertions catch wire-format drift but NOT constant drift
// (numeric tunables that aren't on the wire). These vitest
// tests cover the TS half of the constant-drift guard.

import { describe, it, expect } from "vitest";

import {
  WEAPONS_TABLE,
  WEAPON_FIRE_MODES,
  WeaponId,
  FireMode,
  FireModeToWire,
  fireModeFromWire,
  weaponDef,
  WEAPON_SWITCH_RATE_LIMIT_MS,
  HEADSHOT_MULTIPLIER,
  PLAYER_MAX_AMMO,
} from "./constants";

describe("protocol PR #108 — WeaponId enum", () => {
  it("exposes the v1 weapon ids in canonical order (DualPistol/Shotgun/Sniper)", () => {
    // The wire format encodes `weaponId: u8` with these exact
    // values. If a new weapon is appended, the index shifts and
    // this assertion must be updated alongside the server's
    // `WeaponId` enum (`server/src/constants.rs`). Wire-byte
    // compatibility is preserved across appends as long as both
    // sides update together.
    expect(WeaponId.DualPistol).toBe(0);
    expect(WeaponId.Shotgun).toBe(1);
    expect(WeaponId.Sniper).toBe(2);
  });
});

describe("protocol PR #108 — FireMode enum", () => {
  it("encodes Semi/Burst3/Auto to the documented wire bytes", () => {
    // Mirror of `server/src/constants.rs::FireMode::to_wire`:
    //   Semi → 0x00
    //   Burst{count} → 0x10 | count  (Burst{3} → 0x13)
    //   Auto → 0x20
    expect(FireModeToWire[FireMode.Semi]).toBe(0x00);
    expect(FireModeToWire[FireMode.Burst3]).toBe(0x13);
    expect(FireModeToWire[FireMode.Auto]).toBe(0x20);
  });

  it("round-trips every FireMode through the encode/decode pair", () => {
    const cases = [FireMode.Semi, FireMode.Burst3, FireMode.Auto];
    for (const mode of cases) {
      const encoded = FireModeToWire[mode];
      const decoded = fireModeFromWire(encoded);
      expect(decoded).toBe(mode);
    }
  });

  it("fireModeFromWire returns null for unknown bytes", () => {
    // Anti-cheat pattern: fail loud on unknown fire-mode bytes
    // rather than silently falling back to Semi (matches
    // `WeaponId::from_wire` on the server).
    expect(fireModeFromWire(0x01)).toBeNull();
    expect(fireModeFromWire(0x14)).toBeNull(); // Burst{4} — not in MVP
    expect(fireModeFromWire(0xFF)).toBeNull();
    expect(fireModeFromWire(0x21)).toBeNull(); // Auto+1 — invalid
  });
});

describe("protocol PR #108 — WEAPONS_TABLE", () => {
  it("has 3 entries (DualPistol, Shotgun, Sniper)", () => {
    expect(WEAPONS_TABLE.length).toBe(3);
    expect(WEAPONS_TABLE[WeaponId.DualPistol].weaponId).toBe(WeaponId.DualPistol);
    expect(WEAPONS_TABLE[WeaponId.Shotgun].weaponId).toBe(WeaponId.Shotgun);
    expect(WEAPONS_TABLE[WeaponId.Sniper].weaponId).toBe(WeaponId.Sniper);
  });

  it("DualPistol carries the TS 2.0 canonical tunables", () => {
    // Pinned numbers per `docs/TS2.0-weapon-data.md` + PR #106.
    // If any of these change, the server's
    // `server/src/constants.rs::WEAPONS_TABLE[0]` must update
    // in lockstep (and the wire-level test in protocol_wire.rs
    // should catch any downstream damage-per-shot drift).
    const dual = WEAPONS_TABLE[WeaponId.DualPistol];
    expect(dual.damagePerHit).toBe(8);
    expect(dual.pellets).toBe(1);
    expect(dual.magazineSize).toBe(10);
    expect(dual.fireCooldownMs).toBe(120);
    expect(dual.accuracyDegrees).toBe(1.5);
    expect(dual.maxRangeMeters).toBe(22.0);
    expect(dual.damageFalloff).toBe(false);
    expect(dual.fireModes).toEqual([FireMode.Semi, FireMode.Burst3]);
  });

  it("Shotgun carries 8 pellets + 8-round magazine + Semi only", () => {
    const sg = WEAPONS_TABLE[WeaponId.Shotgun];
    expect(sg.damagePerHit).toBe(5);
    expect(sg.pellets).toBe(8);
    expect(sg.magazineSize).toBe(8);
    expect(sg.fireCooldownMs).toBe(800);
    expect(sg.accuracyDegrees).toBe(8.0);
    expect(sg.maxRangeMeters).toBe(20.0);
    expect(sg.damageFalloff).toBe(true);
    expect(sg.fireModes).toEqual([FireMode.Semi]);
  });

  it("Sniper carries 200 damage + 5-round magazine + Semi only", () => {
    const sn = WEAPONS_TABLE[WeaponId.Sniper];
    expect(sn.damagePerHit).toBe(200);
    expect(sn.pellets).toBe(1);
    expect(sn.magazineSize).toBe(5);
    expect(sn.fireCooldownMs).toBe(1500);
    expect(sn.accuracyDegrees).toBe(1.0);
    expect(sn.maxRangeMeters).toBe(100.0);
    expect(sn.damageFalloff).toBe(false);
    expect(sn.fireModes).toEqual([FireMode.Semi]);
  });

  it("every weapon has at least one fire mode", () => {
    // A weapon with zero fire modes is a config bug — the
    // server's `validate_and_relay_weapon_switch` 5-gate would
    // reject any switch to it (no valid index in the empty
    // array). Surfacing this here catches the misconfiguration
    // at the type-table level rather than at first deploy.
    for (const def of WEAPONS_TABLE) {
      expect(def.fireModes.length).toBeGreaterThan(0);
    }
  });
});

describe("protocol PR #108 — weaponDef() lookup", () => {
  it("returns the canonical def for each valid WeaponId", () => {
    expect(weaponDef(WeaponId.DualPistol).weaponId).toBe(WeaponId.DualPistol);
    expect(weaponDef(WeaponId.Shotgun).weaponId).toBe(WeaponId.Shotgun);
    expect(weaponDef(WeaponId.Sniper).weaponId).toBe(WeaponId.Sniper);
  });

  it("falls back to DualPistol for unknown ids (defensive default)", () => {
    // The defensive default matches the server's `weapon_def()`
    // behavior — unknown ids panic AFTER the caller has gated
    // via `WeaponId::from_wire`, so we never hit this path
    // in production. The fallback exists for the HUD which
    // doesn't want to crash on a misconfigured snapshot.
    const fallback = weaponDef(99 as unknown as WeaponId);
    expect(fallback.weaponId).toBe(WeaponId.DualPistol);
  });
});

describe("protocol PR #108 — WEAPON_FIRE_MODES table", () => {
  it("DualPistol has both Semi + Burst3 modes (B cycles)", () => {
    expect(WEAPON_FIRE_MODES[WeaponId.DualPistol]).toEqual([
      FireMode.Semi,
      FireMode.Burst3,
    ]);
  });

  it("Shotgun + Sniper have only Semi (B is a no-op)", () => {
    expect(WEAPON_FIRE_MODES[WeaponId.Shotgun]).toEqual([FireMode.Semi]);
    expect(WEAPON_FIRE_MODES[WeaponId.Sniper]).toEqual([FireMode.Semi]);
  });
});

describe("protocol PR #108 — rate-limit + headshot constants", () => {
  it("WEAPON_SWITCH_RATE_LIMIT_MS = 1000 (1 Hz per player, mirrors server)", () => {
    // The client uses this to gate local emissions; the
    // server's `validate_and_relay_weapon_switch` 5-gate #3
    // uses the same value. Drift = either client burns
    // dropped-rate-limit packets OR server rejects valid
    // emissions.
    expect(WEAPON_SWITCH_RATE_LIMIT_MS).toBe(1000);
  });

  it("HEADSHOT_MULTIPLIER = 3 (uniform across MVP weapons)", () => {
    // Per Kyle's call for PR #105 spec §2.6: ship uniform 3×
    // across all MVP weapons (HL1 vanilla). Per-weapon
    // overrides deferred to a tuning PR.
    expect(HEADSHOT_MULTIPLIER).toBe(3);
  });

  it("PLAYER_MAX_AMMO = 6 (DualPistol magazine size)", () => {
    // Mirror of `server/src/constants.rs::PLAYER_MAX_AMMO`. The
    // HUD's reload-progress bar uses this for the
    // fill-when-full computation. Drift = HUD reload bar
    // vanishes before the server confirms the reload.
    expect(PLAYER_MAX_AMMO).toBe(6);
  });
});
