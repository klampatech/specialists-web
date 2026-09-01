# PR 105 — Client-side weapons wire + per-weapon HUD + smoke gate

> **Status: PLAN-DRAFT. Not approved for implementation.** Spec-first.
> This is the architecture decision record for the client-side weapon
> surface: the `0x0C WeaponSwitch` wire, key bindings, per-weapon HUD,
> burst-fire state, and the new real-canary smoke that exercises all of
> it end-to-end. PR #102 (server WEAPONS_TABLE) + PR #104 (TS 2.0 data)
> are merged; PR #105 closes the carry-forward PR #101 §3.9/§4 and the
> 6 open questions from PR #102's TL;DR.
>
> **Owner**: kyle + Evo
> **Branch**: `docs/pr-105-client-weapons` (this PR; will rename to
> `feat/...` once implementation starts)
> **Target merge**: review-only — no merge until the open questions below
> have a call. The next PR (106) implements it.

## 1. Why this PR exists (the gap today)

PR #102 landed the server-side `WEAPONS_TABLE` and the `weapon_id: u8`
byte in `PlayerState` (snapshot grew 29→30 bytes per player). The MVP
is wired server-side: DualPistol cooldown gate works, `validate_and_relay_aim`
resolves per-weapon cooldown from the table. **But:**

- Players can only use DualPistol — there's no client-side input to switch
 weapons, and no server-side `0x0C WeaponSwitch` wire handler.
- Shotgun + Sniper have placeholder values in `WEAPONS_TABLE` (DualPistol
 has the canonical pre-#102 pin; Shotgun/Sniper are placeholders).
- `0x0A AimEvent` wire (19 bytes) doesn't carry a `weapon_id` field —
 server has to infer it from `player.current_weapon` (which never changes
 because there's no switch mechanism).
- `BulletHud` (`client/src/ui/BulletHud.tsx`) shows ammo for one weapon
 with no weapon-switch indicator.
- `damage-server-hp-convergence-smoke` only exercises DualPistol. There's
 no smoke that touches Shotgun or Sniper end-to-end.

The result: TS 2.0's defining mechanic (weapon variety) is invisible to
players.

## 2. Scope (what PR 105 ships)

Wire up the **client surface** for the 3-weapon MVP that PR #102's server
already supports, then close the loop with a real-canary smoke. Five things:

### 2.1 New `0x0C WeaponSwitch` wire type (server-side handler + client-side send)

**Wire format** (4 bytes):
```
[u16 source_player_id][u8 weapon_id][u8 fire_mode_index]
```

Where `weapon_id` is one of `WeaponId::DualPistol` (0), `WeaponId::Shotgun`
(1), `WeaponId::Sniper` (2). `fire_mode_index` is 0-based into
`WEAPONS_TABLE[weapon_id].fire_modes[]` (the array added in §2.5 below).

**Server behavior** (`server/src/transport.rs` — new `handle_weapon_switch`
arm of the WS frame dispatcher):
1. Validate `weapon_id` is in `WeaponId` enum range (reject unknown as `0xFE UnknownWeapon`)
2. Validate `fire_mode_index < WEAPONS_TABLE[weapon_id].fire_modes.len()` (reject out-of-range as `0xFF InvalidFireMode`)
3. Rate-limit: 1 switch/sec/player (reject faster switches as `0xFD TooFrequent`)
4. Reject if player has 0 ammo for the requested weapon (reject as `0xFC OutOfAmmo`) — **per Kyle's question, this is a closed-enum check; unknown weapons are rejected**
5. Update `player.current_weapon` + `player.current_fire_mode` + `player.burst_shots_remaining` (resets to 0)
6. Echo back via the existing snapshot stream (the next snapshot will reflect the new state)

**Client behavior** (`client/src/net/damageBus.ts` — new `sendWeaponSwitch(weaponId, fireModeIndex)`):
- Used by `inputListener.ts` on key press (see §2.2)
- Returns `Promise<void>` so the input handler can await the echo before allowing the next switch

### 2.2 Input bindings (hardcoded 1/2/3 + B for mode cycle)

`client/src/engine/inputListener.ts` — new key handlers:

| Key | Action |
|-----|--------|
| `1` | Switch to DualPistol (fire mode preserved per-weapon) |
| `2` | Switch to Shotgun (fire mode preserved) |
| `3` | Switch to Sniper (fire mode preserved) |
| `B` | Cycle fire mode of current weapon (DualPistol: semi↔burst3; Shotgun/Sniper: no-op) |
| `Mouse1` | Fire (existing; uses `player.current_weapon` + `player.current_fire_mode` from the new state) |

**Hardcoded** per Kyle's call (configurable in a future settings-menu PR).
The 1/2/3 choice mirrors PR #101 §3.9 — natural number keys for the
3-weapon MVP, easy to remember, doesn't conflict with WASD/Q/E/R.

**Anti-spam**: keys 1/2/3 are gated by the server's 1 switch/sec/player
rate limit (§2.1.3). Client-side input is queued — pressing 2 twice in
quick succession sends two `0x0C WeaponSwitch` frames; the server rejects
the second one with `0xFD TooFrequent`. Client logs the rejection but
doesn't surface it to the player (silent — the visual state will only
update after the server echo).

### 2.3 Burst-fire state machine (server-side)

New per-player fields:
- `current_fire_mode: u8` (0-based index into `WEAPONS_TABLE[id].fire_modes[]`)
- `burst_shots_remaining: u8` (resets to 0 on switch; set to `fire_mode.burst_count` on each trigger pull)

`server/src/damage_relay.rs` — extend `validate_and_relay_aim`:
- For `Semi`: every trigger pull fires 1 shot
- For `Burst3`: trigger pull fires 3 shots at the same cooldown; subsequent trigger pulls are rejected until trigger released AND burst completes
- For `Auto`: trigger held = continuous fire at `fire_cooldown_ms` cadence

**Release semantics**: client sends `is_firing: 0` when the trigger is
released (already happens in the existing AimEvent wire). Server tracks
this via a new `trigger_held: bool` per-player field. Burst completion
is checked on each AimEvent: if `burst_shots_remaining == 0`, allow next
pull. If `> 0` and trigger is held, server fires the next burst shot.
If `> 0` and trigger released, server resets `burst_shots_remaining = 0`
and clears the `pending_burst` flag.

### 2.4 Per-weapon HUD

`client/src/ui/BulletHud.tsx` — extend to show per-weapon state:

- **Weapon name** (top-left): "Dual Pistol" / "Shotgun" / "Sniper"
- **Ammo counter** (below name): current mag / max mag (e.g. "10 / 10")
- **Reload bar** (below ammo): fills during reload, disappears when full
- **Fire mode badge** (right of name): shows "BURST" only when DualPistol is in burst3 mode
- **Weapon icon strip** (bottom): 3 weapon slots with active highlight (1, 2, 3 keys labeled)

Visual is a thin strip at the bottom of the screen — minimal real estate,
doesn't cover the rig. Renders from `player.current_weapon` +
`player.current_fire_mode` fields in the snapshot stream.

**Headshot multiplier**: not visualized in MVP. Shots are validated
server-side (§2.6) but the HUD doesn't show "+200 headshot" or similar.
If a headshot occurs, the victim's HP drop is just bigger — visual feedback
is the same red damage flash.

### 2.5 WEAPONS_TABLE extension — fire modes column

**Server side** (`server/src/constants.rs`) — `WeaponDef` gains:

```rust
pub struct WeaponDef {
    pub weapon_id: WeaponId,
    pub display_name: &'static str,
    pub damage_per_hit: u8,
    pub pellets: u8,             // shotgun: 8, others: 1
    pub max_range_meters: u8,    // max range for falloff calc
    pub fire_cooldown_ms: u16,
    pub magazine_size: u8,
    pub reload_duration_ms: u16,
    pub accuracy_degrees: f32,
    pub damage_falloff: fn(distance_m: f32, max_range_m: f32) -> f32,
    pub fire_modes: &'static [FireMode],  // 1-3 entries
}

pub enum FireMode {
    Semi,                       // 1 shot per trigger pull
    Burst { count: u8 },        // N shots per trigger pull (Burst3 = Burst { count: 3 })
    Auto,                       // trigger held = continuous fire
}
```

**MVP entries** (canonical TS 2.0 datamine from `docs/TS2.0-weapon-data.md`):

```rust
pub const WEAPONS_TABLE: [WeaponDef; 3] = [
    WeaponDef {
        weapon_id: WeaponId::DualPistol,
        display_name: "Dual Pistol",
        damage_per_hit: 8,             // TS Glock-18 (per shot, per HL1 vanilla 9mm cvar)
        pellets: 1,
        max_range_meters: 22,          // TS Glock-18 range
        fire_cooldown_ms: 120,         // preserved pre-#102 value for backward-compat
        magazine_size: 10,             // TS Glock-18 mag
        reload_duration_ms: 1500,
        accuracy_degrees: 1.5,         // TS Glock-18 view kickback
        damage_falloff: linear,        // HL1 vanilla — uniform damage to max_range_meters
        fire_modes: &[FireMode::Semi, FireMode::Burst { count: 3 }],
    },
    WeaponDef {
        weapon_id: WeaponId::Shotgun,
        display_name: "Shotgun",
        damage_per_hit: 5,             // TS BENELLI-M3 (per pellet, per HL1 vanilla buckshot cvar)
        pellets: 8,                    // TS BENELLI-M3 (8+1 tube, fires 8 pellets per shot)
        max_range_meters: 20,          // effective range; HL unit range is 114m but cone spread limits damage
        fire_cooldown_ms: 800,         // TS BENELLI-M3 ~1500ms but tuned tighter for MVP feel
        magazine_size: 8,              // TS BENELLI-M3 8+1 tube (PR #102 placeholder was 2 — corrected)
        reload_duration_ms: 2200,      // 8 shells tube reloaded individually
        accuracy_degrees: 8.0,         // TS BENELLI-M3 view kickback (wide spread)
        damage_falloff: shotgun_cone,  // HL1 vanilla — each pellet's damage drops with distance via cone spread
        fire_modes: &[FireMode::Semi], // pump-action single mode
    },
    WeaponDef {
        weapon_id: WeaponId::Sniper,
        display_name: "Sniper",
        damage_per_hit: 200,           // TS Barrett M82A1 (community consensus, .50 BMG 1-hit kill territory)
        pellets: 1,
        max_range_meters: 100,         // effective range; HL unit range is 229m but cone doesn't apply
        fire_cooldown_ms: 1500,        // bolt-action
        magazine_size: 5,              // TS Barrett-style bolt-action magazine
        reload_duration_ms: 2500,
        accuracy_degrees: 1.0,         // tight scope; view kickback is 10° on the Barrett but cone spread is tiny
        damage_falloff: linear,        // HL1 vanilla — full damage to max_range_meters
        fire_modes: &[FireMode::Semi],
    },
];
```

**Client mirror** (`protocol/constants.ts`) — same struct shape. Cross-vendor
review will compare the two tables byte-for-byte in the smoke.

**Note on PR #102 corrections baked in**:
- Shotgun `magazine_size`: was 2 in PR #102 placeholder, now **8** (TS BENELLI-M3 8+1 tube)
- Shotgun `pellets`: was 8 in PR #102 placeholder, now **8** (same — confirmed correct)
- DualPistol `damage_per_hit`: was 12 in PR #102 (pre-#102 behavior pin), now **8** (per TS Glock-18 + HL1 9mm cvar). **This is a behavior change** — the existing `dual_pistol_matches_pre_102_values` test will FAIL on this PR.

### 2.6 Server-side damage validation

`server/src/hitscan.rs` — `validate_and_relay_aim` extension:
- After the existing cooldown gate, check the player's `current_weapon`:
 - DualPistol: hit scan at `accuracy_degrees=1.5°`, damage `8 × 1` (1 pellet, 8 dmg)
 - Shotgun: 8 hit scans with cone spread (`jitter_forward(forward, 8.0°)`), damage `5 × pellet_hits` (each pellet does 5, total up to 40 if all 8 hit)
 - Sniper: hit scan at `accuracy_degrees=1.0°`, damage `200 × 1` (1 pellet, 200 dmg → instant kill on 100hp target)

**Headshot multiplier**: per Kyle's call, ship with HL1 vanilla **uniform 3×**
applied to all weapons (per the PR #101 §10 deferral resolution). The
hit-scan identifies head vs body via the entity hitbox; headshot damage
is `damage_per_hit × 3`. Implementation: `weapon_hitscan` returns
`Hit { body_part: Head | Chest | Legs, distance_m: f32 }`; the caller
multiplies `damage_per_hit × HEADSHOT_MULTIPLIER` (3) when `body_part == Head`.

**Knife / melee / projectile / grenades**: out of scope for MVP. PR
#105 only ships the 3 hitscan weapons + 3 fire modes. Future PR.

### 2.7 PlayerState wire extension — 1 byte for fire mode

`server/src/protocol.rs` — `PlayerState` gains `current_fire_mode: u8`
at offset 30 (after `weapon_id` at offset 29). New size: 31 bytes per
player (was 30 in PR #102). 24-player snapshot: 31 × 24 + 9 header = 753
bytes (was 730 in PR #102; was 706 pre-PR-#102).

**This is a wire-break** — must land client + server together. Same
"next-deploy-is-all-clients-new" mitigation as PR #102. The new
`client-weapon-switch-smoke` CI job (added in §2.8) catches the regression.

### 2.8 New real-canary smoke — `weapon-switch-smoke.mjs`

Modeled on `client/tools/rig-visual-smoke.mjs` (PR #99). Structure:

```
1. Spawn canary on 14445/14446/18084 (unique ports — next slot after
   lobby 14433/14434 + rig-visual 14435/14436)
2. Spawn vite on 5195 (next slot after lobby 5194 + rig-visual 5192)
3. Playwright opens Tab A + Tab B
4. Wait for snapshot stream to start in both tabs
5. Assertions (6 total, all PASS/FAIL):
   A. Tab A starts with DualPistol (snapshot shows weapon_id=0,
      currentFireMode=0 — semi)
   B. Tab A presses '2' → switches to Shotgun (snapshot weapon_id=1
      within 200ms)
   C. Tab A fires Shotgun → 8-pellet spread hit-scan, Tab B HP drops by
      5..40 (assert: drop is in [5, 40] — accounts for some pellets
      missing)
   D. Tab A presses '1' → DualPistol again, presses 'B' → burst3 mode
      (snapshot weapon_id=0, currentFireMode=1 within 200ms)
   E. Tab A fires 3 rounds in burst → 3 AimEvents observed within
      1.4s window (assert: count == 3)
   F. Tab A presses '3' → Sniper (snapshot weapon_id=2), fires once
      → Tab B HP drops to 0 (200 dmg > 100hp)
```

**Implementation note**: the smoke uses Playwright's `page.evaluate(...)`
to drive the key events, then reads `window.__latestSnap?.()` from both
tabs to verify the snapshot stream reflects the new state. The new
`__latestSnap` accessor already exists in `scene.ts:1448` (added in
PR #102 as a debug hook).

**CI job**: `client-weapon-switch-smoke` in `.github/workflows/ci.yml`,
modeled on `client-rig-visual-smoke`. Parallel-runs with the other
`client-*` smokes. `timeout-minutes: 5`. Total job runtime ~90s.

### 2.9 File-by-file change list

**Server (Rust)** — ~280 LOC net:
- `server/src/constants.rs` (+160): extend `WeaponDef` with `fire_modes` + `FireMode` enum + updated `WEAPONS_TABLE` (3 entries → MVP-canonical TS 2.0 values). 8 new unit tests: `weapon_switch_validates_known_weapon`, `weapon_switch_rejects_unknown_weapon`, `weapon_switch_rejects_out_of_range_fire_mode`, `weapon_switch_rate_limits_one_per_second`, `weapon_switch_rejects_out_of_ammo`, `burst_fires_count_shots_in_window`, `burst_completes_on_trigger_release`, `player_state_size_includes_current_fire_mode`.
- `server/src/hitscan.rs` (+40): extend `weapon_hitscan` to apply `HEADSHOT_MULTIPLIER = 3`; update `Head | Chest | Legs` hitbox dispatch.
- `server/src/damage_relay.rs` (+80): extend `validate_and_relay_aim` to handle Burst and Auto fire modes; update the existing 6 tests to reflect new DualPistol damage (8 vs 12); add 4 new tests for burst + auto behavior.
- `server/src/protocol.rs` (+5): `PlayerState.current_fire_mode: u8`, `PLAYER_STATE_WIRE_SIZE` 30 → 31. Update `snapshot_at_24_players_is_753_bytes` test.
- `server/src/session.rs` (+10): add `current_fire_mode`, `burst_shots_remaining`, `trigger_held` fields. Add `apply_weapon_switch(...)` method.
- `server/src/snapshot.rs` (+10): read new fields into PlayerState.
- `server/src/transport.rs` (+40): new `handle_weapon_switch` dispatcher arm + error codes (`0xFC`/`0xFD`/`0xFE`/`0xFF`).

**Client (TypeScript)** — ~520 LOC net:
- `protocol/constants.ts` (+220): mirror `WEAPONS_TABLE` from Rust (cross-vendor review checks byte equality).
- `protocol/snapshot.ts` (+5): `PlayerState.currentFireMode: number`, `PLAYER_STATE_BODY_SIZE` 30 → 31. Update decoder.
- `client/src/engine/inputListener.ts` (+30): 1/2/3 + B key handlers.
- `client/src/net/damageBus.ts` (+60): `sendWeaponSwitch(weaponId, fireModeIndex)` + extend `sendAimEvent` with `weaponId` byte (AimEvent wire 19 → 20 bytes). Update test.
- `client/src/engine/scene.ts` (+30): read `currentFireMode` from snapshot, drive `player.currentFireMode` for HUD. `__latestSnap` accessor already exists (PR #102).
- `client/src/engine/clientPredictor.ts` (+15): forward-predict `currentFireMode` (it's discrete, no interpolation).
- `client/src/ui/BulletHud.tsx` (+60): weapon name + ammo + reload bar + mode badge + weapon strip.
- `client/src/ui/Crosshair.tsx` (+20): weapon-aware crosshair color (red scope for sniper).
- `client/src/engine/remoteInterpolator.ts` (+5): `lerpSnapshot` includes `currentFireMode` (discrete).
- 8 client engine test files: add `currentFireMode: 0` to PlayerState literals for typecheck.

**Smoke (Node.js + Playwright)** — ~260 LOC:
- `client/tools/weapon-switch-smoke.mjs` (NEW): the smoke above.
- `.github/workflows/ci.yml` (+60): `client-weapon-switch-smoke` CI job.

### 2.10 Wire-format summary (snapshot grows again)

| PR | PlayerState | 24p snapshot | Notes |
|----|-------------|--------------|-------|
| pre-#102 | 28 bytes | 706 bytes | Original dual-pistol-only |
| #102 | 29 bytes | 730 bytes | +`weapon_id: u8` |
| **#105** | **30 bytes** | **753 bytes** | +`current_fire_mode: u8` |

**Wire-break at snapshot boundary** (29 → 30 bytes per player): Same
"next-deploy-is-all-clients-new" mitigation as PR #102. The lobby is
the entry point — every connected client gets the new snapshot stream.
Pre-#105 clients would read 30-byte payloads but stop at byte 28
(isFiring), missing `weapon_id` + `currentFireMode` → HUD shows wrong
weapon. CI gate `client-weapon-switch-smoke` (new in this PR) catches
this on the post-deploy smoke run.

## 3. Cross-vendor review checklist

Before merge, run Claude Code on PR #105. Looking for:
- Server ↔ client table parity (Rust constants.rs ↔ TS constants.ts)
- Snapshot wire-byte equality (server encodes what client decodes)
- Burst state machine correctness (release semantics, edge cases)
- Smoke assert fidelity (each test PASS means what it claims)
- Pre-#105 client reads post-#105 snapshot = wrong weapon (intentional wire-break, documented)

## 4. Verification plan

1. `cargo test --manifest-path server/Cargo.toml` — expect 229 + 17 = **246 PASS / 0 FAIL** (5 new from constants.rs + 4 from damage_relay + 1 from protocol + 4 from session + 3 from transport)
2. `cd client && npx vitest run` — expect 66 + 12 = **78 PASS / 0 FAIL** (12 new from currentFireMode fields + Burst state)
3. `cd client && npm run typecheck` — expect clean
4. `cd client && node tools/lobby-smoke.mjs` — expect **18/18 PASS** (unchanged from PR #102)
5. `cd client && node tools/rig-visual-smoke.mjs` — expect **4/4 PASS** (unchanged)
6. `cd client && node tools/weapon-switch-smoke.mjs` — NEW, expect **6/6 PASS**
7. CI: all 32 jobs GREEN (29 existing + 3 new from `client-weapon-switch-smoke`)

## 5. Open questions (carry-forward from PR #102)

PR #102's TL;DR listed 6 carry-forward questions. PR #105 answers:

1. **Damage numbers** (Shotgun 5/pellet vs ?, Sniper 75 vs ?) — answered: **5/pellet (per HL1 buckshot cvar), 200 (TS Barrett M82A1 community consensus)**
2. **Magazine sizes** (6/2/4 vs 6/2/5) — answered: **10/8/5 (TS Glock-18/BENELLI-M3/Barrett)**
3. **Fire-rate plausibility edge cases** — answered: **per-weapon cooldown via `WEAPONS_TABLE[].fire_cooldown_ms`**
4. **Weapon-switch keybind** — answered: **hardcoded 1/2/3 + B (per Kyle's call in this PR's chat)**
5. **Server-side weaponId validation strictness** (open vs closed enum) — answered: **closed enum (reject unknown weapons with `0xFE UnknownWeapon`)**
6. **Reload cancelation semantics** — **deferred to PR #106** (out of MVP scope; the MVP uses hardcoded reload times; cancel-on-fire is a Q for next sprint)

### Remaining Q (deferred to PR #106+)

- Reload cancelation semantics (Q from PR #102 — remains open)
- Headshot multiplier per-weapon (PR #105 ships uniform 3×; per-weapon overrides deferred)
- Knife / melee / projectile / grenades (out of MVP scope; deferred to future Phase 2 chunks)

## 6. Risk + mitigation

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Burst state machine bug (e.g., trigger-release reset edge case) | Medium | 4 new tests in `validate_and_relay_aim` cover the burst state transitions; smoke assertion E exercises the full burst cycle |
| Snapshot wire regression (pre-#105 client reads post-#105 stream) | Low | New `client-weapon-switch-smoke` catches it; same next-deploy-is-all-clients-new mitigation as PR #102 |
| Server ↔ client table drift | Low | Cross-vendor review (Claude Code) checks byte equality; new parity test compares both tables in CI |
| Weapon-switch rate-limit too strict (1/sec blocks legit fast-switch combat) | Low | 1/sec is generous — TS allowed instant switch. If too strict, PR #106 can raise to 3/sec. MVP is fine |
| DualPistol damage regression breaks pre-#102 pin test | **High — known** | `dual_pistol_matches_pre_102_values` test will FAIL — fix is to update the test to use TS 2.0 canonical values (8 dmg). Documented in PR #105 commit. **This is the intended behavior change** |

## 7. Open carry-forward to PR #106+

1. Reload cancelation semantics (Q from PR #102, remains open)
2. Per-weapon headshot multipliers (PR #105 ships uniform 3×)
3. Knife / melee / projectile / grenades (future Phase 2 chunks)
4. Settings-menu configurability of weapon keys (deferred from PR #105)
5. Vivaldi tier-3 keyboard test (cross-cutting maintenance)
6. CF-N1 HP-convergence flake (existing flake, unchanged)
7. Port 5190 vite double-boot CI bug (pre-existing infra)

---

**Plan-first. Review this spec, mark up anything you want different, and I'll start implementation when you say go.** Estimated ~3 sessions of code work + Claude cross-vendor review.

Once approved, I'll open as `feat/2026-09-01-pr-105-client-weapons` and dispatch via the standard PR-102 pattern (Codex + Claude cross-vendor + smoke + manual verification).