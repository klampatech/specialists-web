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
