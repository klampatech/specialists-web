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
