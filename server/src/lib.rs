// PR 11.6.B — server scaffold library entry point.
//
// Re-exports the modules that `main.rs` and the integration test in
// `tests/session_canary.rs` need. Keeping `main.rs` thin + pushing
// orchestration into `run()` is what makes the in-process canary test
// possible: the test calls `run(...)` with a tempdir + ports 0 (so the
// kernel assigns free ports), drives both transports, and tears down
// without spawning a child process.

#![allow(clippy::needless_return)]

pub mod cert;
pub mod constants;
pub mod position_history;
pub mod protocol;
pub mod session;
pub mod transport;

pub use constants::{MAX_PLAYERS_PER_ROOM, PING_HZ, POSITION_UPDATE_HZ, TICK_RATE_HZ};
pub use position_history::{Position, PositionHistory};
pub use protocol::{
    decode_damage_broadcast, decode_damage_request, decode_inputs_server, decode_ping,
    decode_pong, decode_position_update, encode_damage_broadcast, encode_damage_request,
    encode_inputs_server, encode_ping, encode_pong, encode_position_update, DamageBroadcast,
    DamageRequest, InputsServer, Ping, Pong, PositionUpdate, DISCRIMINATOR_DAMAGE_BROADCAST,
    DISCRIMINATOR_DAMAGE_REQUEST, DISCRIMINATOR_INPUTS, DISCRIMINATOR_INPUTS_SERVER,
    DISCRIMINATOR_PING, DISCRIMINATOR_PONG, DISCRIMINATOR_POSITION_UPDATE,
    DAMAGE_BROADCAST_WIRE_SIZE, DAMAGE_REQUEST_WIRE_SIZE, INPUTS_SERVER_WIRE_SIZE,
    PING_WIRE_SIZE, PONG_WIRE_SIZE, POSITION_UPDATE_WIRE_SIZE,
};
pub use session::{Player, PlayerId, Room, ServerFrame};
