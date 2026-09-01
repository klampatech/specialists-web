# PR 101 — WEAPONS-table refactor + multi-weapon Phase 2 — Plan

> **Status: PLAN-DRAFT. Not approved for implementation.** Spec-first.
> This is the architecture decision record for the first Phase 2
> chunk (WEAPONS-table refactor + dual-pistol/shotgun/sniper split).
> It is the deliverable for this session — opening as a docs PR for
> review before any Rust code, any Vite churn, or any codex dispatch.
>
> **Owner**: kyle + Evo
> **Branch**: `docs/pr-101-weapons-table` (this PR; will rename to
> `feat/...` once implementation starts)
> **Target merge**: review-only — no merge until the open questions below
> have a call. The next PR (102) implements it.
>
> **Predecessors**: PR #56 (dual-pistol reload mechanics, 2026-08-25)
> made `PLAYER_MAX_AMMO =6` and the reload bar a temporary bridge between
> the original single-weapon model and a future multi-weapon arc. PR #59
> (2026-08-26) introduced the `0x0A AimEvent` wire type so the server
> could own hitscan + fire-rate. **PR #101 is the natural Phase 2 next
> chunk** — Kyle flagged post-PR-78 that this was the next major arc.

---

## 1. Why this PR exists (the gap today)

The codebase is hardcoded to dual-pistol throughout:

- `server/src/hitscan.rs:61` — `pub const DUAL_PISTOL_DAMAGE: u8 = 12;`
- `server/src/hitscan.rs:64` — `pub const DUAL_PISTOL_MAX_RANGE_METERS: f32 = 50.0;`
- `server/src/damage_relay.rs:49` — `MAX_AMOUNT: u8 = 100` (covers dual-pistol's 12; would need to scale up for shotgun/sniper)
- `server/src/damage_relay.rs:185` — `validate_and_relay_aim` calls `dual_pistol_hit(...)` directly
- `server/src/damage_relay.rs:194` — `FIRE_COOLDOWN_MS` is a single global; per-weapon would differ (sniper is slower than dual-pistol)
- `server/src/snapshot.rs:550` — `PlayerState` has `ammo: u8` but no `weapon_id`; every player implicitly uses dual-pistol
- `client/src/engine/characterConfig.ts:55` — `PLAYER_MAX_AMMO = 6` is the only weapon constant
- `client/src/net/damageBus.ts:230` — `sendAimEvent(req)` takes only yaw + pitch + frame + eventId; no weapon field
- `client/src/ui/BulletHud.tsx:42` — shows ammo for one weapon; no weapon-switch indicator

Adding a second weapon means touching all of these. The shape we land determines whether future weapons (rocket launcher, melee, etc.) are drop-in or each one needs its own PR.

## 2. Scope (what PR 101 ships)

A single `WEAPONS_TABLE` constant table that drives **all** per-weapon behavior. Three weapons in v1: dual-pistol (the current behavior, unchanged), shotgun (multi-pellet hitscan), sniper (single-shot high-damage with longer cooldown).

**The data**:
```
WEAPONS_TABLE = {
  DualPistol: {
    weaponId: 0,
    displayName: "Dual Pistol",
    damagePerHit: 12,           // per pellet for shotgun, per shot for others
    pellets: 1,                 // shotgun = 8
    maxRangeMeters: 50.0,
    fireCooldownMs: 200,        // per-shot
    magazineSize: 6,            // current PLAYER_MAX_AMMO
    reloadDurationMs: 1500,     // current behavior
    accuracyDegrees: 1.0,       // cone half-angle for pellet spread
    damageFalloff: false,       // shotgun yes; others no (v1)
  },
  Shotgun: {
    weaponId: 1,
    displayName: "Shotgun",
    damagePerHit: 8,            // per pellet (8 * 8 = 64 max)
    pellets: 8,
    maxRangeMeters: 20.0,       // shorter than pistol
    fireCooldownMs: 800,
    magazineSize: 2,            // fewer rounds
    reloadDurationMs: 2500,
    accuracyDegrees: 5.0,       // wide spread
    damageFalloff: true,        // per-pellet falloff over distance
  },
  Sniper: {
    weaponId: 2,
    displayName: "Sniper",
    damagePerHit: 75,           // one-shot body, two-shot limb (HP-gated later)
    pellets: 1,
    maxRangeMeters: 150.0,      // long range
    fireCooldownMs: 1500,
    magazineSize: 4,
    reloadDurationMs: 3000,
    accuracyDegrees: 0.2,       // precise
    damageFalloff: false,
  },
}
```

**The wire changes**:
- `0x0A AimEvent` extends from 19 → **20 bytes**: `disc(1) + sourcePlayerId(u16=2) + yaw(f32=4) + pitch(f32=4) + frame(u32=4) + eventId(u32=4) + weaponId(u8=1) = 20`. Adding a `weaponId: u8` field at the end is wire-compatible if we treat missing-byte as `0` (DualPistol). **Decision**: require explicit `weaponId` from day 1 — even dual-pistol packets carry `weaponId: 0`. Cleaner, no version-detection logic.
- `Snapshot.PlayerState` extends from 29 → **30 bytes** per player: add `weapon_id: u8` after `ammo`. Snapshot becomes `10 + playerCount * 30` bytes total. Same shape — clients/servers that haven't updated get a decode error on the next snapshot, which is loud and recoverable (the player reconnects with the new client).

**The server changes**:
- `server/src/constants.rs` — add `WEAPONS_TABLE: &[WeaponDef]` constant (or move it to `protocol/constants.ts` per the existing pattern from PR 11.7.D2).
- `server/src/hitscan.rs` — replace `dual_pistol_hit(...)` with a generic `weapon_hitscan(weapon_def, shooter_origin, forward, target_pos, target_radius) -> Vec<u8>` that loops over `pellets` and applies cone spread.
- `server/src/damage_relay.rs::validate_and_relay_aim` — pull the per-weapon values from the table instead of hardcoded constants; Gate 4 (fire-rate) becomes `WEAPONS_TABLE[req.weapon_id].fire_cooldown_ms` instead of `FIRE_COOLDOWN_MS`.
- `server/src/snapshot.rs::encode_snapshot` — append `weapon_id: u8` to `PlayerState`. Update `PLAYER_STATE_WIRE_SIZE` from 29 to 30.
- `server/src/session.rs` — `Room.players[id]` gains `current_weapon: WeaponId` (default DualPistol). Reload resets to the current weapon's magazine size (not always PLAYER_MAX_AMMO).

**The client changes**:
- `protocol/damage.ts` — `AimEvent` interface gains `weaponId: number`. `encodeAimEvent` writes the byte. `decodeAimEvent` reads it. Round-trip tests updated.
- `protocol/snapshot.ts` — `PlayerState` interface gains `weaponId: number`. Wire encoder/decoder updated.
- `client/src/engine/characterConfig.ts` — add `WEAPONS_TABLE` mirror (server is canonical; client mirrors for HUD only).
- `client/src/engine/inputListener.ts` — keys 1/2/3 switch weapon via `bus.sendWeaponSwitch({weaponId, eventId})` (new wire type `0x0C WeaponSwitch`).
- `client/src/net/damageBus.ts` — `sendAimEvent` accepts `weaponId`; default to current weapon if omitted.
- `client/src/ui/BulletHud.tsx` — show `weaponId` icon + per-weapon ammo + per-weapon reload bar (the bar's `maxAmmo` prop becomes per-weapon).

**The new wire type**:
- `0x0C WeaponSwitch` — disc(1) + sourcePlayerId(u16=2) + weaponId(u8=1) + eventId(u32=4) = **8 bytes**. Server-side: `validate_and_relay_weapon_switch` validates (source in room, weaponId in range, not switching to current weapon within rate limit) and mutates `player.current_weapon`. Snapshot broadcast reflects the change within 50ms (next 20Hz tick).

**Anti-cheat extension** (server-side plausibility):
- Per-weapon fire-rate is server-enforced (already there via Gate 4 with the per-weapon constant).
- Per-weapon accuracy is server-enforced on the FIRST pellet; subsequent pellets use the same `forward` vector from yaw/pitch (the client doesn't need to compute spread).
- Weapon switch rate limit: 1 switch per 250ms (`WEAPON_SWITCH_RATE_LIMIT_MS`).

## 3. What's explicitly NOT in this PR

- **Headshot / limb hit detection** — current hitscan uses a single target radius (`DEFAULT_TARGET_RADIUS`). Headshot multipliers (sniper = 1-shot head) are a separate PR.
- **Per-weapon HUD icons** — text label only (`"Dual Pistol" / "Shotgun" / "Sniper"`); icons come later.
- **Weapon pickup / inventory** — weapons are starting equipment, switched via keypress. Drops / pick-ups are a future arc.
- **Projectile weapons** (rocket launcher, grenade) — shotgun/sniper/dual-pistol are hitscan only.
- **Sound / muzzle flash / camera shake per weapon** — VFX hooks for future PR.
- **Tier-3 Mac keyboard test for weapon switch** — manual recipe for Kyle to launch.

## 4. Files touched (estimated)

- `protocol/constants.ts` — `WEAPONS_TABLE` (NEW, ~50 LOC)
- `protocol/damage.ts` — `AimEvent` + `WeaponSwitch` encode/decode (+60 LOC)
- `protocol/damage.test.ts` — round-trip tests updated (+20 LOC)
- `protocol/snapshot.ts` — `PlayerState` + `Snapshot` encode/decode (+15 LOC)
- `server/src/constants.rs` — `WEAPONS_TABLE` mirror (~50 LOC)
- `server/src/hitscan.rs` — `weapon_hitscan` replaces `dual_pistol_hit` (~80 LOC)
- `server/src/damage_relay.rs` — `validate_and_relay_aim` uses table; new `validate_and_relay_weapon_switch` (+60 LOC)
- `server/src/snapshot.rs` — `PlayerState` gets `weapon_id`; `PLAYER_STATE_WIRE_SIZE` 29→30 (~10 LOC)
- `server/src/session.rs` — `Room.players` gains `current_weapon` field (~10 LOC)
- `server/src/transport.rs` — wire-type router handles `0x0C WeaponSwitch` (~30 LOC)
- `client/src/engine/characterConfig.ts` — `WEAPONS_TABLE` mirror (~50 LOC)
- `client/src/engine/inputListener.ts` — keys 1/2/3 + fire-rate per weapon (~80 LOC)
- `client/src/net/damageBus.ts` — `sendAimEvent` takes `weaponId` (~10 LOC)
- `client/src/net/damageBus.ts` — `sendWeaponSwitch` (~15 LOC)
- `client/src/ui/BulletHud.tsx` — per-weapon HUD (~30 LOC)
- `client/tools/weapon-switch-smoke.mjs` — NEW smoke (~150 LOC)
- `.github/workflows/ci.yml` — new `client-weapon-switch-smoke` job (~60 LOC)

**Total estimate**: 17 files, ~780 LOC + new smoke (~150 LOC) + new CI job (~60 LOC) = ~990 LOC. **Single PR is too big** — see §5.

## 5. Roll-out sequence (revised 2026-09-01)

The single-PR estimate of ~990 LOC is over the sweet spot for a codex + claude-review cycle. **Split into 2 PRs**:

**PR #101 (this plan, docs-only)**: the spec you're reading.

**PR #102 (server-side WEAPONS_TABLE + dual-pistol backward-compat)**: lands the server-side changes only. The client still sends weaponId-less AimEvents which the server interprets as DualPistol (default). Wire format stays 19 bytes. No client-facing change. ~350 LOC. Goal: get the WEAPONS_TABLE shape reviewed + the server-side refactor in production before the client-side wire extension.

**PR #103 (client-side multi-weapon + new 0x0C WeaponSwitch wire type)**: extends AimEvent to 20 bytes, adds WeaponSwitch wire type, client-side weapon switching via keys 1/2/3, BulletHud per-weapon display. New weapon-switch smoke + CI job. ~640 LOC + 150 LOC smoke + 60 LOC CI = ~850 LOC. Bigger but contained to client + protocol + CI.

**Why split here**:
- The server refactor is the riskier part (touching `validate_and_relay_aim`, `dual_pistol_hit`, snapshot wire format). Smaller, server-only PR → shorter review loop.
- The client PR can be a codex + claude cross-vendor review cycle (the architecture is already proven in #102).
- Each PR independently mergeable; if #103 needs to be reverted, the server is already consistent.

**Open question**: does PR #103 extend the wire format on day 1 (20-byte AimEvent + 0x0C WeaponSwitch), or do we keep the 19-byte format for one PR and add the byte later? **My recommendation**: add the byte in #103. The 19→20 extension is wire-compatible if we treat missing-byte as DualPistol, but cleaner to require it from day 1 (no version-detection logic). One breaking PR is better than two half-PRs.

## 6. Cross-vendor review expectations

This PR is **larger than PR #94** (which was ~960 LOC across 10 files including a11y + bugfixes + 3 new smokes). Claude Code review on PR #94 caught 3 real bugs in the smoke coverage + 6 non-blockings. Expect a similar shape here:
- **0-2 blocking bugs** in the wire format (off-by-one in encode/decode, missing field in round-trip)
- **2-4 non-blockings** in the server-side validation (likely edge cases in per-weapon fire-rate, ammo gating, weapon-switch rate limit)
- **1-2 nits** (cosmetic)

**Plan**: open PR #103 as a regular PR, run Claude Code cross-vendor review before merging, file the issues, fix them in the same PR (don't reopen for follow-ups — get them right the first time).

## 7. Smoke strategy

**New smoke**: `client/tools/weapon-switch-smoke.mjs` — 2-tab Playwright, drives:
1. Tab B holds 1 (dual-pistol), fires 5 shots, asserts `weaponId=0` in Tab A's snapshot
2. Tab B presses 2 (switch to shotgun), waits 300ms (switch cooldown), asserts `weaponId=1` in snapshot
3. Tab B fires once, asserts HP drop >50 (8 pellets * 8 dmg = 64 max from shotgun)
4. Tab B presses 3 (switch to sniper), asserts `weaponId=2`
5. Tab B fires once, asserts HP drop =75 (sniper exact damage)

**Updated smokes**:
- `damage-server-hp-convergence-smoke.mjs` — asserts the snapshot still reports `ammo=6` for dual-pistol (regression check that we didn't break the existing single-weapon path).
- `damage-server-aim-event-smoke.mjs` — explicitly sends `weaponId: 0` to verify the new field is parsed correctly.

**Real-canary smoke** (per the PR #94 lesson): the new smoke MUST be real-canary (boots the actual server, no `page.route` stubs) so server/client drift surfaces immediately. Model on `lobby-real-canary-smoke.mjs`.

## 8. Open questions (need Kyle's call before PR #102)

1. **Damage numbers**: are 12 / 8-per-pellet-8 / 75 the right values? Or should sniper be 100 (one-shot body, two-shot via damage-resistance perk)? **Recommendation**: ship v1 with 75 sniper (allows two-shot body kill at full HP), defer headshot multipliers.

2. **Magazine sizes**: 6 / 2 / 4 — too small for sniper? **Recommendation**: 6 / 2 / 5 (sniper is single-action rifle, 5 rounds feels right).

3. **Fire rates**: 200ms / 800ms / 1500ms — sniper feels slow vs. CS2 / Valorant (~700-900ms for AWP). **Recommendation**: 200 / 800 / 900ms (sniper faster than expected; we'll tune post-launch).

4. **Damage falloff for shotgun**: linear or exponential? **Recommendation**: linear (8 → 0 over 20m), simplest first version.

5. **Reload cancels fire**: should pressing R while the reload bar is filling cancel and refund ammo? **Recommendation**: no for v1 (current reload behavior is "press R, fill bar, full magazine"); defer cancel-on-fire.

6. **Weapon switch keybind**: hardcoded 1/2/3 or configurable? **Recommendation**: hardcoded for v1 (configurable keybinds is a future PR; we'll just have a `keyMap` constant in `inputListener.ts`).

7. **Wire-format breaking**: snapshot 29→30 bytes is breaking for clients/servers that haven't updated. **Recommendation**: breaking change is OK — this is the natural Phase 2 boundary. Document the upgrade path in the PR body.

## 9. Risks

- **Wire format breaking change**: existing PR #94 + lobby smoke clients will see decode errors. Mitigation: the lobby is the entry point; if the client can't decode snapshots, it can't play. So the rollout is "merge #103 → next deploy is all-clients-new". No partial-state risk because every client reads every snapshot.
- **Server-side test coverage**: the hitscan math change touches 80 LOC of geometry-heavy code. Mitigation: keep `dual_pistol_hit` as a thin shim over `weapon_hitscan(WEAPONS_TABLE[DualPistol], ...)` for the first PR; add new tests for shotgun pellet spread + sniper falloff in the same PR.
- **Race in weapon switch + fire**: client presses 2 then immediately fires before the switch takes effect. Mitigation: server-side `current_weapon` is authoritative; if the AimEvent arrives with `weaponId: 1` before the WeaponSwitch event, it's accepted (the fire happens at the new weapon). The reverse (fire then switch) is also fine. The race is benign.
- **Anti-cheat extension**: a client could send `weaponId: 0` (DualPistol) forever and bypass the sniper's lower fire-rate. Mitigation: server enforces per-weapon fire-rate based on `req.weaponId`; client can't fake lower fire-rate by lying about their weapon.

## 10. What this PR DOES NOT do (deferred to future PRs)

- **Headshot / limb hit detection** (multi-session, requires hitbox geometry)
- **Per-weapon VFX** (muzzle flash, camera shake, sound) — needs audio assets + Babylon hookup
- **Projectile weapons** (rocket launcher) — needs server-side projectile simulation + collision
- **Weapon pickup / inventory** — needs entity system + room state changes
- **Per-weapon animation states** — characterController needs weapon-specific attack animations
- **Melee weapons** (`0x0B MeleeEvent` already on the deferred list from PR 11.7.D; this PR doesn't pick it up)

---

**Recommended next step**: Kyle review + answer the 7 open questions. Once signed off, dispatch PR #102 (server-side) as a codex + claude-review cycle, then PR #103 (client-side) as another.