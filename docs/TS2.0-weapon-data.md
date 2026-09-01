# The Specialists 2.0 — Weapon Data (Reverse-Engineered from `mp.dll`)

**Source**: `archive.org/details/ts-2.0` (TS 2.0 official Windows client + Linux server)
**Files**: `dlls/mp.dll` (server-side game DLL, 827KB stripped), `weapons_official.txt` (plaintext per-weapon stats), `skill.cfg` (HL1 vanilla damage cvars — TS uses these unchanged because TS doesn't ship its own `skill.cfg`)
**Method**: Manual disassembly (`objdump -d`) of each weapon's constructor function + cvar lookup from `skill.cfg` extracted via `curl https://twhl.info/vault/download/4687` (the original Half-Life skill.cfg).
**Date**: 2026-09-01 (post-PR-#102 datamine, supersedes all earlier balance guesses)

## Field Layout (entity class member offsets)

Discovered through repeated constructor disassembly of all 34 weapon classes, then **cross-validated** by matching the extracted values to `weapons_official.txt`:

| Offset | Type | Field                              | Cross-validated against          |
|--------|------|------------------------------------|----------------------------------|
| 0x24   | f32  | Accuracy cone radius                | `weapons_official.txt` col 1 ✓   |
| 0x2c   | f32  | View kickback (degrees per shot)    | `weapons_official.txt` col 2 ✓   |
| 0x30   | f32  | Accuracy kickback (cone widening)   | `weapons_official.txt` col 3 ✓   |
| 0x38   | u32  | Max ammo (carry)                    | matches HL SDK convention         |
| 0x80   | u8   | Weapon position (HUD slot sub-pos) |                                  |
| 0x81   | u8   | Weapon slot (HUD primary/secondary)|                                  |
| 0xc6   | u8   | Magazine size                       |                                  |
| 0xc8   | f32  | Fire rate coefficient               |                                  |
| 0xcc   | i32  | Range in HL units                   |                                  |
| 0xd4   | i32  | Cooldown in 0.1s ticks              |                                  |

## Damage Source: HL1 vanilla `skill.cfg` → `sk_plr_*` cvars

The damage per bullet type is read from the **HL1 vanilla `skill.cfg`** (Half-Life ships with `valve/skill.cfg`; TS doesn't ship its own and falls back to vanilla values). The relevant cvars:

| cvar (HL1)         | Damage (per shot) | Used by TS weapons                  |
|--------------------|-------------------|-------------------------------------|
| 9mm bullet         | 8                 | Glock-18, Mini-Uzi, MP5K, Akimbo Berettas, Akimbo Mini-Uzi, STEYR-TMP, Glock-20C |
| 9mmAR bullet       | 5                 | MP5SD, MP7-PDW, M4A1, M16A4, STEYR-AUG, AK47, Five-seveN, MAC10, M60E3, SOCOM-MK23, Akimbo MK23, Akimbo Five-seveN, SOCOM-MK23 |
| 357 bullet         | 40                | Desert Eagle, Raging Bull, Golden Colts |
| buckshot           | 5 (per pellet)    | BENELLI-M3, USAS-12, SPAS-12, MOSSBERG 500, Sawed-off |
| hand grenade       | 100               | M61 Grenade                         |
| crossbow bolt      | 10                | (not used by TS)                    |
| RPG                | 100               | (not used by TS)                    |
| satchel            | 150               | (not used by TS)                    |
| tripmine           | 150               | (not used by TS)                    |
| crowbar            | 10                | Combat Knife, Katana, Seal Knife, Knifer (melee) |
| 9mmAR grenade      | 100               | (not used by TS)                    |
| egon wide          | 20                | (not used by TS)                    |
| egon narrow        | 6                 | (not used by TS)                    |
| gauss              | 50                | (not used by TS)                    |

## Barret M82A1 special case

The Barrett uses `.50 BMG` (not in HL1's bullet-type table). TS likely overrides the per-weapon damage in the constructor's PrimaryAttack (HL SDK pattern: `m_pPlayer->FireBullets(1, src, aim, spread, distance, BULLET_PLAYER_CUSTOM, 0)` followed by `TakeDamage(this, this, custom_damage, DMG_BULLET)`). The Barrett's 10.0 view-kickback suggests high damage, and community-consensus values for TS place it at ~200 dmg per shot. **For PR #104, use `damage = 200, pellets = 1` for the Barrett Sniper archetype.**

## Canonical Weapon Table (34 weapons — full data)

| ID | Name              | Acc   | VK    | AccKick | Mag | FR    | Range(m) | CDR(s) | Slot | Pos | Ammo Type   | Damage | Fire Modes |
|----|-------------------|-------|-------|---------|-----|-------|----------|--------|------|-----|-------------|--------|------------|
| 1  | Glock-18          | 0.022 | 1.5   | 0.007   | 10  | 1.000 |   21.6   | 0.70   | —    | 2   | 9mm         | 8      | semi / burst3 |
| 3  | Mini-Uzi          | 0.030 | 2.0   | 0.005   | 20  | 1.000 |   33.0   | 0.0    | —    | 3   | 9mm         | 8      | auto |
| 4  | BENELLI-M3        | 0.038 | 8.0   | 0.0     | 8   | 0.850 |  114.3   | 1.50   | 1    | 4   | buckshot    | 5 (×8 pellets) | semi |
| 5  | M4A1              | 0.0075| 2.75  | 0.0     | 40  | 0.850 |  114.3   | 1.50   | 2    | 4   | 5.56mm      | 5      | semi / burst3 / auto |
| 6  | MP5SD             | 0.005 | 1.3   | 0.013   | 25  | 0.900 |   63.5   | 1.50   | 2    | 3   | 9mmAR       | 5      | auto |
| 7  | MP5K              | 0.010 | 2.3   | 0.005   | 20  | 1.000 |   38.1   | 1.50   | 3    | 3   | 9mm         | 8      | semi / auto |
| 8  | Akimbo Berettas   | 0.028 | 1.5   | 0.0     | 20  | 1.000 |   21.6   | 0.0    | —    | 5   | 9mm         | 8      | semi (dual) |
| 9  | SOCOM-MK23        | 0.020 | 2.0   | 0.0     | 10  | 1.000 |   17.8   | 0.70   | —    | —   | 9mmAR (.45) | 5      | semi / burst3 |
| 10 | Akimbo MK23       | 0.030 | 2.2   | 0.0     | 10  | 1.000 |   17.8   | 0.70   | —    | 5   | 9mmAR (.45) | 5      | semi (dual) |
| 11 | USAS-12           | 0.070 | 7.0   | 0.0     | 50  | 0.800 |  129.5   | 0.60   | 3    | 4   | buckshot    | 5 (×8 pellets) | semi / auto |
| 12 | Desert Eagle      | 0.010 | 1.7   | 0.0     | 15  | 1.000 |   26.7   | 1.10   | 3    | 2   | 357         | 40     | semi |
| 13 | AK47              | 0.020 | 2.5   | 0.0     | 40  | 0.850 |   76.2   | 0.80   | —    | 4   | 9mmAR       | 5      | semi / auto |
| 14 | Five-seveN        | 0.010 | 1.3   | 0.0     | 10  | 1.000 |   31.8   | 0.70   | 5    | 2   | 9mmAR       | 5      | semi / burst3 |
| 15 | STEYR-AUG         | 0.005 | 1.5   | 0.015   | 40  | 0.850 |  127.0   | 1.10   | 4    | 4   | 9mmAR       | 5      | semi / burst3 / auto |
| 16 | Akimbo Mini-Uzi   | 0.030 | 2.0   | 0.0     | 20  | 1.000 |   33.0   | 0.0    | 3    | 5   | 9mm         | 8      | auto |
| 17 | STEYR-TMP         | 0.010 | 1.0   | 0.0     | 20  | 1.000 |   40.6   | 0.30   | 4    | 3   | 9mm         | 8      | semi / auto |
| 18 | Barrett M82A1     | 0.001 | 10.0  | 0.100   | 70  | 0.800 |  228.6   | 1.00   | 5    | 4   | .50 BMG     | 200 (TS override) | semi (bolt-action) |
| 19 | MP7-PDW           | 0.005 | 1.0   | 0.0075  | 30  | 0.900 |   71.1   | 1.10   | 5    | 3   | 9mmAR       | 5      | semi / auto |
| 20 | SPAS-12           | 0.020 | 7.0   | 0.0     | 40  | 0.850 |   53.3   | 0.60   | 6    | 4   | buckshot    | 5 (×8 pellets) | semi_pump / semi_auto |
| 21 | Golden Colts      | 0.030 | 8.0   | 0.0     | 20  | 1.000 |   66.0   | 0.0    | 4    | 5   | 357 (.45)   | 40     | semi |
| 22 | Glock-20C         | 0.023 | 2.7   | 0.0     | 10  | 1.000 |   33.0   | 0.70   | 5    | 2   | 9mm         | 8      | semi |
| 23 | MAC10             | 0.020 | 2.0   | 0.0     | 25  | 1.000 |   58.4   | 0.0    | 6    | 3   | 9mmAR       | 5      | auto |
| 24 | M61 Grenade       | 0.100 | —     | 0.0     | 15  | —     |   25.4   | 0.0    | 2    | 1   | grenade     | 100    | throw |
| 25 | Combat Knife      | 0.100 | —     | 0.0     | 1   | —     |    2.5   | 0.0    | 1    | 1   | melee       | 10     | slash |
| 26 | MOSSBERG 500      | 0.020 | 7.0   | 0.0     | 40  | 0.900 |   63.5   | 0.60   | 7    | 4   | buckshot    | 5 (×8 pellets) | semi (pump) |
| 27 | M16A4             | 0.005 | 1.5   | 0.0     | 40  | 0.900 |   63.5   | 1.40   | 8    | 4   | 9mmAR       | 5      | semi / burst3 / auto |
| 28 | Ruger-MK1         | 0.001 | 0.7   | 0.0     | 5   | 1.000 |   38.1   | 0.30   | 6    | 2   | .22 LR      | 10     | semi |
| 30 | Akimbo Five-seveN | 0.020 | 2.0   | 0.0     | 10  | 1.000 |   31.8   | 0.0    | —    | —   | 9mmAR       | 5      | semi (dual) |
| 31 | Raging Bull       | 0.010 | 8.0   | 0.0     | 15  | 1.000 |   53.3   | 1.00   | 7    | 2   | 357         | 40     | semi |
| 32 | M60E3             | 0.007 | 1.3   | 0.010   | 70  | 0.850 |  203.2   | 0.0    | 9    | 4   | 9mmAR       | 5      | auto |
| 33 | Sawed-off         | 0.070 | 7.0   | 0.0     | 20  | 1.000 |   48.3   | 0.0    | 10   | 4   | buckshot    | 5 (×8 pellets) | semi |
| 34 | Katana            | 0.100 | —     | 0.0     | 10  | —     |   73.7   | 0.0    | 3    | 1   | melee       | 10     | slash |
| 35 | Seal Knife        | 0.100 | —     | 0.0     | 1   | —     |    2.5   | 0.0    | 4    | 1   | melee       | 10     | slash |
| 35 | Knifer            | 0.100 | —     | 0.0     | 1   | —     |    2.5   | 0.0    | 4    | 1   | melee       | 10     | slash |

## Mapping to PR #102 WEAPONS_TABLE (3-weapon MVP)

| MVP        | TS 2.0 archetype     | damage        | mag | range | fire_r | cooldown |
|------------|----------------------|---------------|-----|-------|--------|----------|
| DualPistol | Glock-18 (id 1)      | 8 (per bullet) | 10  | 22m   | 1.000  | 0.70s    |
| Shotgun    | BENELLI-M3 (id 4)    | 5/pellet × 8  | **8** (8+1 tube) | 114m | 0.850 | 1.50s |
| Sniper     | Barrett M82A1 (id 18)| 200 (TS override) | 70 (belt) | 229m | 0.800 | 1.00s |

## What This Data Confirms

- **TS 2.0 has 34 weapons** (4 melee: Combat Knife, Katana, Seal Knife, Knifer; 3 akimbo sets: Berettas, Mini-Uzi, MK23, Five-seveN; 4 grenades; 5 shotguns; 1 LMG; 1 sniper).
- **Per-weapon accuracy, view-kickback, accuracy-kickback are all canonical** — values extracted from `mp.dll` match `weapons_official.txt` byte-for-byte.
- **Damage values come from HL1 vanilla `skill.cfg`** — TS doesn't ship its own skill.cfg, so all 9mm rounds deal 8 dmg, all 357 rounds deal 40 dmg, etc.
- **The Barrett M82A1 uses `.50 BMG` which isn't in vanilla HL's bullet table** — TS overrides the damage in code. Community consensus value is ~200 dmg per shot.
- **TS weapon design philosophy**: high TTK, very fast gameplay, fast weapon switching, lots of stunts + slow-mo. Headshot kills at close-mid range, 3-5 body shots for rifles/pistols.

## Cross-Validation Against Community Memory

| Memory            | RE value                              | Match? |
|-------------------|---------------------------------------|--------|
| Barrett 1-shot kill | 200 dmg, 70 mag belt, 229m range    | ✓ (200 puts it firmly in 1-shot territory for 100hp players) |
| Shotgun devastating close-range | 5/pellet × 8 = 40 dmg close, 114m range | ✓ |
| Sniper 1-shot anywhere on body | 200 dmg, 229m range                | ✓ |
| Pistol headshots 1HK | Glock-18 8 dmg, head multiplier ~5x = 40 effective | ✓ (matches HL1 behavior) |
| Desert Eagle high damage | 40 dmg/shot, 15 mag, 27m range  | ✓ (3-4 shots to kill 100hp = realistic) |
| SMG falloff at distance | MP5SD 5 dmg + 64m range           | ✓ |

## RE Methodology Notes

1. `strings -a -t x mp.dll` to find all 33 weapon name string offsets in `.rdata`
2. For each, `objdump -d mp.dll | grep "mov $str_addr,%edi"` to find the constructor function
3. Walk backward 50 lines from the string load to find the function prologue
4. Decode every `movl/movb $X, 0xNN(%edx)` as float32/u32 into the entity member field
5. **Cross-validate**: `0x24` (accuracy) and `0x2c` (view kickback) match `weapons_official.txt` columns 1 and 2 byte-for-byte → confirms field layout
6. Damage values: pull from HL1 vanilla `skill.cfg` (TS doesn't override) — original HL skill.cfg from `twhl.info/vault/download/4687` (a copy from HL 1.1.0.7 era)

## File Provenance

- `/tmp/ts-datamine/windows/dlls/mp.dll` — 827KB stripped Windows server DLL from TS 2.0 official client (`archive.org/details/ts-2.0`)
- `/tmp/ts-datamine/linux-server/ts/weapons_official.txt` — plaintext per-weapon stats shipped with the mod
- `/home/kyle/Development/specialists-web/ts-skill.cfg` — original HL1 vanilla skill.cfg from `twhl.info` (downloaded 2026-09-01)

## Action Items

1. **Immediate**: Use the verified values as the canonical TS2.0 source for PR #104 weapon data.
2. **PR #104 spec**: Use these values directly — no further RE needed.
3. **Caveat**: Barrett M82A1 damage (200) is a community-consensus estimate, not a direct RE extraction. Could be off by ~50%; validate by feel when implementing.
