// PR 11.6.B — server scaffold library entry point.
//
// Re-exports the modules that the binary + integration harness need.
// `transport.rs` is included directly by `tests/session_canary.rs` so its
// individual listener entry points can stay crate-private. Keeping `main.rs` thin + pushing
// orchestration into `run()` is what makes the in-process canary test
// possible: the test calls `run(...)` with a tempdir + ports 0 (so the
// kernel assigns free ports), drives both transports, and tears down
// without spawning a child process.

#![allow(clippy::needless_return)]

// Alias the package for modules included directly by the integration canary.
// That lets `#[path]` include `transport.rs` without leaking listener
// entry points through the public library surface.
extern crate self as specialists_server;

pub mod cert;
pub mod connection_outbound;
pub mod damage_relay;
pub mod constants;
pub mod hitscan;
pub mod physics;
pub mod position_history;
pub mod protocol;
pub mod session;
pub mod snapshot;
pub mod transport;

pub use constants::{MAX_PLAYERS_PER_ROOM, PING_HZ, PLAYER_MAX_AMMO, POSITION_HISTORY_RETENTION_FRAMES, POSITION_HISTORY_STORE_HZ, POSITION_UPDATE_HZ, RECONCILIATION_THRESHOLD_M, INTERPOLATION_DELAY_MS, MAX_SNAPSHOT_AGE_MS, MAX_RECONCILIATION_SNAP_DISTANCE_M, RELOAD_RATE_LIMIT_MS, TICK_RATE_HZ, SNAPSHOT_RATE_HZ};
pub use glam::Vec3;
pub use hitscan::{
    chest_position, dual_pistol_damage, dual_pistol_hit, forward_from_yaw_pitch,
    DEFAULT_TARGET_RADIUS, DUAL_PISTOL_DAMAGE, DUAL_PISTOL_MAX_RANGE_METERS,
};
pub use position_history::{
    should_store_frame, Position, PositionHistory, PHYSICS_HZ, STORE_HZ,
};
pub use physics::PhysicsWorld;
pub use protocol::{
    decode_damage_broadcast, decode_damage_request, decode_inputs_server, decode_ping,
    decode_pong, decode_position_update, decode_snapshot, encode_damage_broadcast,
    encode_damage_request, encode_inputs_server, encode_ping, encode_pong,
    encode_position_update, encode_snapshot, DamageBroadcast, DamageRequest, InputsServer,
    Ping, Pong, PlayerState, PositionUpdate, Snapshot, DISCRIMINATOR_DAMAGE_BROADCAST,
    DISCRIMINATOR_DAMAGE_REJECT, DISCRIMINATOR_DAMAGE_REQUEST, DISCRIMINATOR_INPUTS,
    DISCRIMINATOR_INPUTS_SERVER, DISCRIMINATOR_PING, DISCRIMINATOR_PONG,
    DISCRIMINATOR_POSITION_UPDATE, DISCRIMINATOR_SNAPSHOT, DISCRIMINATOR_STATE_ACK,
    DAMAGE_BROADCAST_WIRE_SIZE, DAMAGE_REJECT_BODY_SIZE, DAMAGE_REQUEST_WIRE_SIZE,
    INPUTS_SERVER_WIRE_SIZE, PING_WIRE_SIZE, PONG_WIRE_SIZE, PLAYER_STATE_WIRE_SIZE,
    POSITION_UPDATE_WIRE_SIZE, SNAPSHOT_WIRE_SIZE_MIN,
};
pub use connection_outbound::ConnectionOutbound;
pub use session::{Player, PlayerId, Room, ServerFrame};
pub use snapshot::SnapshotGenerator;

// PR 11.7.E / §3.5 — ReloadRequest encoder/decoder/constants re-exports.
pub use protocol::{
    decode_reload_request, encode_reload_request, ReloadRequest,
    DISCRIMINATOR_RELOAD_REQUEST, RELOAD_REQUEST_BODY_SIZE, RELOAD_REQUEST_WIRE_SIZE,
};
