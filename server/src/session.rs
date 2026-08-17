// PR 11.6.B / §3.4 + §1.2 — `Room` and `Player` types.
//
// PR 11.6.B plumbs the data shape; PR 11.6.D reads/writes the damage
// fields, PR 11.7 reads `inputs_buffer` for snapshot generation.
//
// Critical constraint (gotcha #1 from the brief): `Room.inputs_buffer`
// is WRITE-ONLY in PR 11.6.B. Adding a read here would ship a
// "server depends on something clients haven't been taught to send"
// bug.

use std::collections::{HashMap, VecDeque};
use std::time::Instant;

use crate::constants::POSITION_HISTORY_RETENTION_FRAMES;
use crate::position_history::PositionHistory;

/// Tab id. `u16` matches the wire format's player-id field.
pub type PlayerId = u16;

/// Server-side frame counter. PR 11.6.D's tick loop will increment
/// this once per server tick (see §6 Q3: `tokio::time::Instant`-based
/// monotonic clock from server startup). PR 11.6.B doesn't tick — it
/// only buffers.
pub type ServerFrame = u32;

/// `INPUT_SIZE` from `client/src/net/inputBitmask.ts` (12 bytes).
pub type EncodedInput = [u8; 12];

/// Per-player state. `ammo` and `last_fire_at` exist for §3.4.2
/// fire-rate validation but PR 11.6.B doesn't use them yet.
#[derive(Debug, Clone)]
pub struct Player {
    pub id: PlayerId,
    /// 100 default — `client/src/game/health.ts` mirrors this on the
    /// client side (PR 10's HP pool).
    pub hp: u8,
    pub ammo: u8,
    /// `Some(t)` if the player has fired since joining; `None` for a
    /// fresh player. PR 11.6.D's fire-rate validator reads this.
    pub last_fire_at: Option<Instant>,
    /// PR 11.6.D FIX 1: when the server last received a `Ping` from
    /// this player's connection. The validator uses this to compute
    /// a smoothed RTT for lag-comp rewind:
    /// `rtt_ms = (now - last_ping_received_at) * 2 + heartbeat_bonus`
    /// (the "* 2" approximates the round-trip from the server's
    /// perspective; the heartbeat_bonus accounts for time since the
    /// last ping landed). Pure client timestamp-based RTT requires
    /// the server to remember the client's `clientTimestamp` on the
    /// inbound ping then compare with the outbound pong's
    /// `server_timestamp` — PR 11.7 wires that; for now we use the
    /// proxy below.
    pub last_ping_received_at: Option<Instant>,
}

impl Player {
    pub fn new(id: PlayerId) -> Self {
        Self {
            id,
            hp: 100,
            ammo: 0,
            last_fire_at: None,
            last_ping_received_at: None,
        }
    }
}

/// Per-room state. In PR 11.6.B there is one room (`"DEVBX"`) and
/// every connection joins it. PR 11.9 replaces this with a real
/// matchmaker + multi-room registry.
#[derive(Debug)]
pub struct Room {
    pub id: String,
    pub players: HashMap<PlayerId, Player>,
    pub position_history: HashMap<PlayerId, PositionHistory>,
    /// NEW §1.2 — per-player ring buffer of recently-received inputs.
    /// PR 11.6.B buffers them (no consumption). PR 11.7 reads them
    /// for snapshot generation + lag-comp math. Capacity: ~64 entries
    /// per player (= 1s at 64Hz input rate).
    ///
    /// The buffer is bounded to keep memory predictable at 24p; the
    /// `push_input` helper trims the front when the buffer overflows.
    pub inputs_buffer: HashMap<PlayerId, VecDeque<(ServerFrame, EncodedInput)>>,
    /// Monotonic; increments per `DamageBroadcast`. The server_seq
    /// field on the wire (see `protocol::DamageBroadcast`) is what
    /// tabs use to detect out-of-order broadcasts.
    pub next_server_seq: u32,
    /// PR 11.6.D: per-source `eventId` monotonicity gate. The
    /// `validate_and_relay` rejects any `event_id <=` the last
    /// seen value for the source tab. Prevents replay / out-of-order
    /// duplicates from producing broadcasts.
    pub last_event_id_for_source: HashMap<PlayerId, u32>,
    /// Inputs buffer retention in entries per player. Matches
    /// `POSITION_HISTORY_RETENTION_FRAMES` (64) so lag-comp reads can
    /// correlate position frames with input frames over the same
    /// 1-second window.
    pub inputs_buffer_capacity: usize,
    /// PR 11.6.D: per-room outbound fan-out. The transport layer
    /// spawns one `mpsc::Sender<Vec<u8>>` per connected player; when
    /// `validate_and_relay` emits a `DamageBroadcast`, the listener
    /// pushes the encoded bytes onto every sender in this map so the
    /// broadcast reaches ALL tabs in the room (including the source --
    /// the source applies optimistically, the broadcast confirms).
    pub connections: HashMap<PlayerId, tokio::sync::mpsc::Sender<Vec<u8>>>,
    /// PR 11.6.D: global server frame counter. Increments per
    /// `TICK_RATE_HZ` tick (64Hz). Used as the `server_frame` field
    /// on `DamageBroadcast`.
    pub next_server_frame: u32,
}

impl Room {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            players: HashMap::new(),
            position_history: HashMap::new(),
            inputs_buffer: HashMap::new(),
            next_server_seq: 0,
            last_event_id_for_source: HashMap::new(),
            inputs_buffer_capacity: POSITION_HISTORY_RETENTION_FRAMES as usize,
            connections: HashMap::new(),
            next_server_frame: 0,
        }
    }

    /// Add a player to the room with default HP=100. Idempotent on
    /// rejoin (existing player state preserved) — reconnection is
    /// PR 11.9+.
    pub fn add_player(&mut self, id: PlayerId) {
        self.players.entry(id).or_insert_with(|| Player::new(id));
        self.position_history
            .entry(id)
            .or_insert_with(|| PositionHistory::new(POSITION_HISTORY_RETENTION_FRAMES));
        self.inputs_buffer.entry(id).or_insert_with(VecDeque::new);
    }

    /// Record a position sample for the given player. Delegates to
    /// `PositionHistory::record`.
    pub fn record_position(&mut self, id: PlayerId, frame: ServerFrame, pos: crate::position_history::Position) {
        let hist = self
            .position_history
            .entry(id)
            .or_insert_with(|| PositionHistory::new(POSITION_HISTORY_RETENTION_FRAMES));
        hist.record(frame, pos);
    }

    /// §1.2 seam — push a server-routed input onto `inputs_buffer`.
    /// Trims the front when the buffer overflows `inputs_buffer_capacity`.
    ///
    /// PR 11.6.B is the only consumer; PR 11.7 will be the reader.
    pub fn push_input(&mut self, id: PlayerId, frame: ServerFrame, input: EncodedInput) {
        let buf = self.inputs_buffer.entry(id).or_insert_with(VecDeque::new);
        buf.push_back((frame, input));
        while buf.len() > self.inputs_buffer_capacity {
            buf.pop_front();
        }
    }

    /// PR 11.6.D: register an outbound `mpsc::Sender` for the given
    /// player. Called by the listener loop on connect; the
    /// connection map is the per-room fan-out target for
    /// `DamageBroadcast` (and any future server-originated broadcasts).
    pub fn register_connection(
        &mut self,
        id: PlayerId,
        sender: tokio::sync::mpsc::Sender<Vec<u8>>,
    ) {
        self.connections.insert(id, sender);
    }

    /// PR 11.6.D: drop a connection's sender. Called by the listener
    /// loop on disconnect. Idempotent.
    pub fn unregister_connection(&mut self, id: PlayerId) {
        self.connections.remove(&id);
    }

    /// PR 11.6.D: increment the global server frame counter by 1
    /// and return the NEW value. Called by the 64Hz tick task.
    pub fn tick_server_frame(&mut self) -> u32 {
        let f = self.next_server_frame;
        self.next_server_frame = self.next_server_frame.wrapping_add(1);
        f
    }

    /// PR 11.6.D: stamp the source player's `last_fire_at` to
    /// `now`. Convenience wrapper used by tests; the validator
    /// mutates `last_fire_at` inline.
    pub fn record_fire(&mut self, id: PlayerId, now: Instant) {
        if let Some(p) = self.players.get_mut(&id) {
            p.last_fire_at = Some(now);
        }
    }

    /// Allocate and return the next server sequence number. PR 11.6.D's
    /// `validate_and_relay` calls this when emitting a `DamageBroadcast`.
    pub fn next_seq(&mut self) -> u32 {
        let seq = self.next_server_seq;
        self.next_server_seq = self.next_server_seq.wrapping_add(1);
        seq
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::position_history::Position;

    #[test]
    fn new_room_is_empty() {
        let room = Room::new("DEVBX");
        assert_eq!(room.id, "DEVBX");
        assert!(room.players.is_empty());
        assert!(room.position_history.is_empty());
        assert!(room.inputs_buffer.is_empty());
        assert_eq!(room.next_server_seq, 0);
    }

    #[test]
    fn add_player_initializes_state() {
        let mut room = Room::new("DEVBX");
        room.add_player(7);
        let p = &room.players[&7];
        assert_eq!(p.id, 7);
        assert_eq!(p.hp, 100);
        assert!(room.position_history.contains_key(&7));
        assert!(room.inputs_buffer.contains_key(&7));
    }

    #[test]
    fn add_player_is_idempotent() {
        let mut room = Room::new("DEVBX");
        room.add_player(1);
        room.record_position(1, 5, Position { x: 1.0, y: 2.0 });
        room.push_input(1, 0, [1u8; 12]);
        // Re-add shouldn't wipe state.
        room.add_player(1);
        assert_eq!(room.position_history[&1].len(), 1);
        assert_eq!(room.inputs_buffer[&1].len(), 1);
    }

    #[test]
    fn push_input_trims_to_capacity() {
        let mut room = Room::new("DEVBX");
        room.add_player(2);
        // Default capacity = 64. Push 70.
        for frame in 0..70u32 {
            room.push_input(2, frame, [0u8; 12]);
        }
        let buf = &room.inputs_buffer[&2];
        assert_eq!(buf.len(), 64);
        assert_eq!(buf.front().unwrap().0, 6); // 0..=6 popped
        assert_eq!(buf.back().unwrap().0, 69);
    }

    #[test]
    fn next_seq_is_monotonic() {
        let mut room = Room::new("DEVBX");
        assert_eq!(room.next_seq(), 0);
        assert_eq!(room.next_seq(), 1);
        assert_eq!(room.next_seq(), 2);
    }
}

#[cfg(test)]
mod tests_pr11_6d {
    //! PR 11.6.D: tests for the new `Room` fields (eventId monotonicity,
    //! connections map, server frame counter). The base `tests` mod
    //! covers the unchanged surface area; this mod covers the PR 11.6.D
    //! additions so a regression in either has an isolated signal.

    use super::*;
    use tokio::sync::mpsc;

    #[test]
    fn new_room_has_event_id_map_initialized_empty() {
        let room = Room::new("DEVBX");
        assert!(room.last_event_id_for_source.is_empty());
        assert!(room.connections.is_empty());
        assert_eq!(room.next_server_frame, 0);
    }

    #[test]
    fn register_and_unregister_connection() {
        let mut room = Room::new("DEVBX");
        let (tx, _rx) = mpsc::channel(8);
        room.register_connection(7, tx);
        assert!(room.connections.contains_key(&7));
        room.unregister_connection(7);
        assert!(!room.connections.contains_key(&7));
        // Idempotent.
        room.unregister_connection(7);
        assert!(!room.connections.contains_key(&7));
    }

    #[test]
    fn tick_server_frame_is_monotonic() {
        let mut room = Room::new("DEVBX");
        assert_eq!(room.tick_server_frame(), 0);
        assert_eq!(room.tick_server_frame(), 1);
        assert_eq!(room.tick_server_frame(), 2);
    }

    #[test]
    fn record_fire_stamps_last_fire_at() {
        let mut room = Room::new("DEVBX");
        room.add_player(3);
        assert!(room.players[&3].last_fire_at.is_none());
        let now = Instant::now();
        room.record_fire(3, now);
        assert_eq!(room.players[&3].last_fire_at, Some(now));
    }
}
