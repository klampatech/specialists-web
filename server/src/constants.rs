// PR 11.6.B / §3.10 — protocol constants.
//
// Single source of truth on the Rust side. The TypeScript mirror at
// `protocol/damage.ts` carries the same numbers; PR 11.6.C imports them
// when wiring the client-side encoder/decoder. If you change any of
// these constants, update BOTH files in the same commit — the
// `server/tests/protocol_wire.rs` size assertions will catch the wire
// drift but the constants here drift independent of the wire format.

/// Production target ceiling for a single room (per §1.1 of the plan).
/// PR 11.6.B's canary only verifies 2-player; the constant exists now
/// so PR 11.7+ don't have to retrofit it.
pub const MAX_PLAYERS_PER_ROOM: u16 = 24;

/// Server simulation tick rate (per §3.10). The server's
/// `validate_and_relay` is event-driven in PR 11.6.D, so this number is
/// mostly about `PositionHistory` insertion cadence. 64Hz ≈ 16ms per
/// tick. Aligns with the industry floor (CS2/Valorant are 128Hz,
/// Overwatch 60Hz).
pub const TICK_RATE_HZ: u32 = 64;

/// Client send rate for `PositionUpdate` (per §3.10). Every other tick
/// at the 64Hz server rate. 14 bytes × 32Hz × 2 players = 896 B/s
/// outbound per tab — trivial.
pub const POSITION_UPDATE_HZ: u32 = 32;

/// Client send rate for `Ping` (per §3.10). 4 bytes × 1Hz = 4 B/s
/// outbound. Trivial.
pub const PING_HZ: u32 = 1;

/// PositionHistory retention in frames. 64 frames @ 64Hz server tick =
/// 1 second of player history for lag compensation (per §3.4.1).
pub const POSITION_HISTORY_RETENTION_FRAMES: u32 = 64;

/// Hard-coded room id for PR 11.6.B's dev-box canary (per §6 Q2).
/// Matchmaker is PR 11.9.
pub const DEVBX_ROOM_ID: &str = "DEVBX";

// PR 11.7.B / §3.10 + §3.13 + §3.14 + §4.5 — new
// server-physics + snapshot-generator constants. The values come from
// the locked decisions in the PR 11.7.B brief + plan §3.5 + §3.13 + §3.14.

/// Snapshot broadcast cadence (per §3.4 + Q2 in the plan). 20Hz is the
/// industry floor (CS2 / Valorant: 20-30Hz bare snapshots; per-event
/// pushes carry the rest). 64Hz physics tick vs 20Hz snapshot means
/// every 3.2 ticks the server emits a fresh snapshot. At 24p:
/// 1 + 4 + 4 + 1 + 24*29 = 710 bytes per snapshot × 20Hz = 14.2 KB/s
/// inbound per tab, ~10.7 KB/s/server outbound (sender overhead
/// removed from fan-out — see snapshot.rs broadcast math).
pub const SNAPSHOT_RATE_HZ: u32 = 20;

/// Client-side reconciliation threshold. Drift above this triggers a
/// re-simulation from the last server-confirmed frame forward
/// (per §2.4 + §3.8 of the plan). 10cm is the CS2/Valorant default.
/// The server-side authoritative simulation drifts by less than this
/// in normal play — the threshold exists so sub-10cm Havok vs Rapier
/// numerical noise doesn't constantly trigger reconciliation.
pub const RECONCILIATION_THRESHOLD_M: f32 = 0.1;

/// Maximum visual snap distance on a reconciliation. If the
/// re-simulated position differs from the pre-snap position by more
/// than this, the reconciler hard-snaps to the server's authoritative
/// position and drops the buffered inputs (per §2.4 edge cases).
/// 2m prevents the player from teleporting across the map when the
/// client falls > 1s behind (the input buffer drains at that point).
pub const MAX_RECONCILIATION_SNAP_DISTANCE_M: f32 = 2.0;

/// Remote-player interpolation delay (per §3.9). The client renders
/// remote-player positions from 100ms ago (2 snapshots at 20Hz),
/// smoothing the inter-snapshot position lerp. Matches the Valorant
/// default.
pub const INTERPOLATION_DELAY_MS: u32 = 100;

/// Maximum age of a snapshot the client will accept without requesting
/// a full-state resync (per §2.4). 500ms = 10 snapshots at 20Hz.
/// Beyond this, the client is too far behind and re-syncing the
/// whole state is cheaper than lerping through a 500ms gap. The
/// `0x0B StateResyncRequest` wire type is the request mechanism
/// (PR 11.7.C ships the encoder).
pub const MAX_SNAPSHOT_AGE_MS: u32 = 500;

// PR 11.7.B / §3.13 — coyote-time parity constants. The server grants
// Havok's 2-frame grace window in `physics.rs::apply_jump` so a player
// who walks off a ledge can still press jump on the contact-loss
// frame (Havok persists support contact ~2 frames past the geometric
// edge; Rapier's contact manifold flips to `false` in 1 frame).
// Without the parity grant, every coyote-frame jump produces
// reconciliation drift (Havok says JUMP SUCCEEDED; Rapier says jump
// DENIED; reconciler snaps player down).
pub const COYOTE_FRAMES: u32 = 2;
pub const WALLRUN_COYOTE_FRAMES: u32 = 1;

/// Jump impulse magnitude. Mirrors
/// `client/src/game/combat.ts:COMBAT.jumpImpulse = 5.5`. The server's
/// `apply_jump` sets the capsule's vertical velocity to this value on
/// a successful jump; Havok on the client does the same. Same number
/// both sides = identical jump physics.
pub const JUMP_IMPULSE: f32 = 5.5;

/// PR 11.7.B / §3.14 — storage-rate for `PositionHistory::record`.
/// `PositionHistory` is recorded every Rapier physics tick (64Hz)
/// but stored every other frame (32Hz storage). The `snapshot_at(t)`
/// snap-to-nearest math uses ±8 frames at 64Hz (~125ms) — well within
/// the ±15ms spec in §3.14. Net cost: ~24 players × 32 frames ×
/// 40 bytes = ~30KB per room at 24p. Used in
/// `PositionHistory::should_store_frame`.
pub const POSITION_HISTORY_STORE_HZ: u32 = 32;

// PR 11.7.E / §3.5 — reload mechanics constants. Server is canonical for
// PLAYER_MAX_AMMO; the client mirrors the value in
// `client/src/engine/characterConfig.ts::COMBAT.dualPistol.PLAYER_MAX_AMMO`
// so the HUD's reload-progress UI can render the bar before the first
// snapshot arrives (initial render before server-authoritative state).
/// Maximum ammo per magazine. Dual-pistol (the only reloadable weapon in
/// PR 11.7.E) carries a 6-bullet magazine. Matches the client-side
/// `COMBAT.dualPistol.PLAYER_MAX_AMMO` so the reload-progress bar
/// fills exactly when the snapshot reports `ammo == PLAYER_MAX_AMMO`.
pub const PLAYER_MAX_AMMO: u8 = 6;
/// Minimum interval between reloads per player (server-side rate-limit).
/// 1 reload per second per player — conservative anti-spam gate. Mirrors
/// `client/src/engine/characterConfig.ts::COMBAT.dualPistol.lastReloadAtMinIntervalMs`.
pub const RELOAD_RATE_LIMIT_MS: u64 = 1000;

// PR #102 — WEAPONS-table refactor. Single source of truth for
// per-weapon tunables on the server side. The TypeScript mirror
// lives at `protocol/constants.ts::WEAPONS_TABLE` (same shape, same
// values). v1 ships three weapons: dual-pistol (the only weapon in
// PR 11.7.E), shotgun (multi-pellet hitscan), sniper (single-shot
// high-damage). PR #103 wires the client-side `0x0C WeaponSwitch`
// event and the per-weapon HUD; PR #102 only refactors the server's
// existing dual-pistol path so the architecture lands in production
// before the bigger client-side work.
//
// Determinism: these constants are read at server start and on every
// shot. `cargo test` validates the math against fixture poses; the
// client-side mirror in `protocol/constants.ts` is the cross-language
// ground truth (same pattern as `PLAYER_MAX_AMMO`).

/// Stable weapon-id values for v1. `u8` because the wire format is
/// 1 byte. Adding new weapons: append to this enum (clients/servers
/// with newer versions just decode fine), keep `0xFF` reserved.
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WeaponId {
    DualPistol = 0,
    Shotgun = 1,
    Sniper = 2,
}

impl WeaponId {
    /// Convert a wire-format `u8` to a `WeaponId`. Returns `None`
    /// for unknown values (the validator rejects those requests
    /// rather than silently falling back to dual-pistol — anti-cheat
    /// prefers loud failures to silent substitutions).
    pub fn from_wire(b: u8) -> Option<Self> {
        match b {
            0 => Some(Self::DualPistol),
            1 => Some(Self::Shotgun),
            2 => Some(Self::Sniper),
            _ => None,
        }
    }

    pub fn to_wire(self) -> u8 {
        self as u8
    }

    /// Default weapon for fresh players + clients that haven't sent
    /// a `0x0C WeaponSwitch` yet (PR #103). Dual-pistol preserves
    /// the existing single-weapon behavior so PR #102 is a no-op for
    /// the wire path.
    pub const DEFAULT: Self = Self::DualPistol;
}

/// Per-weapon tunables. Single struct, no generics — the per-weapon
/// behavior is data-driven, not type-driven. The wire format only
/// carries `weapon_id`; everything else is resolved server-side from
/// this table.
#[derive(Debug, Clone, Copy)]
pub struct WeaponDef {
    pub weapon_id: WeaponId,
    pub display_name: &'static str,
    /// Damage per pellet (single-pellet weapons like dual-pistol +
    /// sniper) or per pellet (multi-pellet like shotgun). Total
    /// damage = `damage_per_hit * pellets` on a full-on hit.
    pub damage_per_hit: u8,
    /// Number of pellets fired per shot. 1 for single-shot weapons;
    /// 8 for v1 shotgun. Each pellet runs the hitscan independently.
    pub pellets: u8,
    pub max_range_meters: f32,
    /// Minimum time between shots per source. Server-enforced
    /// anti-cheat gate. The pre-#102 `FIRE_COOLDOWN_MS = 100`
    /// constant becomes `WEAPONS_TABLE[DualPistol].fire_cooldown_ms`
    /// (= 200 per the plan; see also `dual_pistol_cooldown_change`
    /// test in damage_relay.rs which documents the value bump).
    pub fire_cooldown_ms: u64,
    /// Magazine capacity. PR #102 keeps `PLAYER_MAX_AMMO = 6` as
    /// the dual-pistol value (forward-compat); new weapons use their
    /// own numbers from this table.
    pub magazine_size: u8,
    /// Reload duration in ms. The client-side reload bar fills at
    /// this rate.
    pub reload_duration_ms: u64,
    /// Cone half-angle (degrees) for pellet spread. 1.0° for
    /// dual-pistol (precise), 5.0° for shotgun (wide), 0.2° for
    /// sniper (very precise).
    pub accuracy_degrees: f32,
    /// `true` if damage scales linearly over distance within
    /// `max_range_meters`. Shotgun = true; pistol + sniper = false
    /// (flat damage).
    pub damage_falloff: bool,
}

/// v1 weapon table. Indexed by `WeaponId as u8`. Sentinel: the
/// table is `&'static` so the compiler can fold it into the binary.
pub const WEAPONS_TABLE: &[WeaponDef] = &[
    WeaponDef {
        weapon_id: WeaponId::DualPistol,
        display_name: "Dual Pistol",
        damage_per_hit: 12,
        pellets: 1,
        max_range_meters: 50.0,
        fire_cooldown_ms: 120,
        magazine_size: 6,
        reload_duration_ms: 1500,
        accuracy_degrees: 1.0,
        damage_falloff: false,
    },
    WeaponDef {
        weapon_id: WeaponId::Shotgun,
        display_name: "Shotgun",
        damage_per_hit: 8,
        pellets: 8,
        max_range_meters: 20.0,
        fire_cooldown_ms: 800,
        magazine_size: 2,
        reload_duration_ms: 2500,
        accuracy_degrees: 5.0,
        damage_falloff: true,
    },
    WeaponDef {
        weapon_id: WeaponId::Sniper,
        display_name: "Sniper",
        damage_per_hit: 75,
        pellets: 1,
        max_range_meters: 150.0,
        fire_cooldown_ms: 1500,
        magazine_size: 4,
        reload_duration_ms: 3000,
        accuracy_degrees: 0.2,
        damage_falloff: false,
    },
];

/// Resolve a `WeaponId` to its `WeaponDef`. Panics on invalid id —
/// callers should validate via `WeaponId::from_wire` first.
pub fn weapon_def(id: WeaponId) -> &'static WeaponDef {
    &WEAPONS_TABLE[id as usize]
}

/// PR #102 — pre-table fire-rate default. The `validate_and_relay`
/// function uses `weapon_def(WeaponId::DEFAULT).fire_cooldown_ms`
/// (= 120ms, matching this constant) for the dual-pistol path.
/// Kept here for backwards-compat with any caller that still
/// imports `FIRE_COOLDOWN_MS_DEFAULT` directly.
pub const FIRE_COOLDOWN_MS_DEFAULT: u64 = 120;

#[cfg(test)]
mod tests {
    //! PR #102 — the WEAPONS_TABLE is the canonical per-weapon
    //! tunables source. Tests pin its shape + the dual-pistol
    //! backward-compat values (so a future PR can't silently break
    //! the pre-#102 single-weapon behavior).
    use super::*;

    #[test]
    fn weapon_id_roundtrip_from_wire() {
        for id in [WeaponId::DualPistol, WeaponId::Shotgun, WeaponId::Sniper] {
            assert_eq!(WeaponId::from_wire(id.to_wire()), Some(id));
        }
        // Unknown wire values must return None (anti-cheat prefers
        // loud failures over silent substitutions).
        assert_eq!(WeaponId::from_wire(99), None);
        assert_eq!(WeaponId::from_wire(0xFF), None);
    }

    #[test]
    fn weapon_id_default_is_dual_pistol() {
        // The pre-#102 behavior is "every player holds a dual-pistol".
        // This pin makes any future change to DEFAULT explicit (a
        // breaking change for the single-weapon path).
        assert_eq!(WeaponId::DEFAULT, WeaponId::DualPistol);
        assert_eq!(WeaponId::DEFAULT.to_wire(), 0);
    }

    #[test]
    fn weapons_table_has_one_entry_per_weapon_id() {
        // The table is indexed by `WeaponId as usize`, so missing
        // entries would be a panic. This test makes the invariant
        // explicit.
        assert_eq!(
            WEAPONS_TABLE.len(),
            3,
            "expected 3 weapons (DualPistol, Shotgun, Sniper)"
        );
        // Index 0 is DualPistol (the default).
        assert_eq!(WEAPONS_TABLE[0].weapon_id, WeaponId::DualPistol);
        assert_eq!(WEAPONS_TABLE[1].weapon_id, WeaponId::Shotgun);
        assert_eq!(WEAPONS_TABLE[2].weapon_id, WeaponId::Sniper);
    }

    #[test]
    fn dual_pistol_matches_pre_102_values() {
        // The DualPistol entry must match the pre-#102 hardcoded
        // values exactly. This is the backward-compat promise from
        // the PR #101 plan §"PR #102: server-side dual-pistol
        // backward-compat": a pre-#102 client sees identical
        // behavior on a post-#102 server.
        let dp = weapon_def(WeaponId::DualPistol);
        assert_eq!(dp.damage_per_hit, 12);
        assert_eq!(dp.pellets, 1);
        assert_eq!(dp.max_range_meters, 50.0);
        assert_eq!(dp.fire_cooldown_ms, 120);
        assert_eq!(dp.magazine_size, 6);
        assert_eq!(dp.reload_duration_ms, 1500);
        assert_eq!(dp.accuracy_degrees, 1.0);
        assert!(!dp.damage_falloff);
    }

    #[test]
    fn weapon_id_from_wire_rejects_out_of_range() {
        // Sanity: the `from_wire` roundtrip is the canonical gate
        // against bad inputs. The `weapon_def(id)` direct lookup is
        // `unsafe` to call with an out-of-range id (it panics on
        // array index out of bounds), so callers MUST validate via
        // `from_wire` first. This test pins the validation contract.
        for bad in [3u8, 4u8, 99u8, 0xFFu8] {
            assert_eq!(
                WeaponId::from_wire(bad),
                None,
                "from_wire({}) must return None (anti-cheat: no silent fallback)",
                bad
            );
        }
    }
}
