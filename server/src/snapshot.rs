// PR 11.7.B / §3.4 + §3.10.1 — `SnapshotGenerator`.
//
// Reads the physics world's per-player positions + velocities +
// grounded status, plus the room's player HP/ammo, and produces
// a `protocol::Snapshot` for broadcast to every connection in
// the room. The generator runs at `SNAPSHOT_RATE_HZ` (20Hz per
// §3.10 + the brief's locked decision Q2); the physics tick
// runs at `TICK_RATE_HZ` (64Hz). The snapshot is the lagged-
// authoritative-state push; the physics tick is the integration
// step.
//
// **Wire-format**: see `protocol::Snapshot` / `encode_snapshot`
// for the on-wire byte layout. Body = 4 (serverFrame) + 4
// (nextServerFrame) + 1 (playerCount) + player_count * 29
// bytes per `PlayerState`. At 24p: 706 bytes per snapshot ×
// 20Hz = 14.1 KB/s/server outbound.
//
// **Determinism**: `SnapshotGenerator::maybe_emit` is purely
// time-based (no random / no clock reads inside the snapshot
// body — the `now_ms` argument is the caller's responsibility).
// Two runs of the same physics evolution produce byte-equal
// snapshots (verified via the cargo-test determinism check).

use crate::constants::SNAPSHOT_RATE_HZ;
use crate::position_history::Position;
use crate::protocol::{PlayerState, Snapshot};
#[allow(unused_imports)]
use crate::session::{PlayerId, Room};

/// PR 11.7.B — the per-room snapshot emitter. Lives in
/// `snapshot_generator_loop` in `main.rs`; one instance per
/// room. The `last_emit_ms` field tracks the last emission time
/// so `maybe_emit` knows when the next emit is due.
pub struct SnapshotGenerator {
    /// PR 11.7.B — wall-clock millis at the last emit. Compared
    /// against the next call's `now_ms` to decide whether to
    /// emit (gated by `1000 / SNAPSHOT_RATE_HZ`).
    pub last_emit_ms: u64,
}

impl SnapshotGenerator {
    pub fn new() -> Self {
        // Initialize `last_emit_ms = 0` so the FIRST call to
        // `maybe_emit` will fire (0 + 50ms = 50ms < any reasonable
        // now_ms). PR 11.7.C's test suite uses a controlled clock
        // for the same reason.
        Self { last_emit_ms: 0 }
    }

    /// PR 11.7.B — emit a snapshot if the interval has elapsed
    /// since the last emit. Returns `Some(snap)` if `(now_ms -
    /// last_emit_ms) >= (1000 / SNAPSHOT_RATE_HZ)`, else `None`.
    /// Updates `last_emit_ms` to `now_ms` on emit.
    ///
    /// `room` is borrowed immutably (the snapshot is a snapshot,
    /// not a mutation). The frame numbers on the wire use
    /// `room.next_server_frame` as the "next" frame and
    /// `next_server_frame - 1` as the "just-stepped" frame.
    pub fn maybe_emit(&mut self, room: &Room, now_ms: u64) -> Option<Snapshot> {
        let interval_ms: u64 = 1000 / SNAPSHOT_RATE_HZ as u64;
        if now_ms.saturating_sub(self.last_emit_ms) < interval_ms {
            return None;
        }
        self.last_emit_ms = now_ms;
        Some(self.build_snapshot(room))
    }

    /// Build the `Snapshot` from the current room state. Reads:
    ///   - `room.next_server_frame` → wire's `nextServerFrame`.
    ///   - `room.next_server_frame - 1` → wire's `serverFrame`
    ///     (the just-stepped authoritative frame).
    ///   - `room.players` → per-player HP + ammo.
    ///   - `room.physics` → per-player position + velocity.
    ///
    /// Players present in `room.connections` (the live transport
    /// map) are the ones included; players with a Player entry
    /// but no connection (e.g., disconnected mid-session) are
    /// skipped — there's no peer to broadcast TO.
    fn build_snapshot(&self, room: &Room) -> Snapshot {
        // Collect the live player ids in `room.connections` (the
        // authoritative fan-out target). The brief says
        // "player_count is the number of currently-connected
        // players (not MAX_PLAYERS_PER_ROOM)".
        let mut player_states: Vec<PlayerState> = Vec::new();
        for (player_id, _) in &room.connections {
            // Look up HP/ammo. If the player isn't in `room.players`
            // (e.g., the connection arrived but no DamageRequest has
            // been processed yet), default to 100/0.
            let (hp, ammo) = room
                .players
                .get(player_id)
                .map(|p| (p.hp, p.ammo))
                .unwrap_or((100, 0));
            // Position + velocity from the physics world.
            let pos: Position = room
                .physics
                .position(*player_id)
                .unwrap_or(Position::ZERO);
            let vel: [f32; 2] = room.physics.velocity(*player_id);
            // PR AimEvent / §3.5 — yaw/pitch are now sourced from
            // Room.players[id].yaw_radians / .pitch_radians
            // (server-side mirror of the client's last-reported
            // intent, captured by the 0x06 InputServer inbound arm
            // at transport.rs). The default 0.0 (set in
            // session.rs::Player::new) is what the snapshot reports
            // until the first input packet arrives — matches the
            // pre-PR-#59 hardcoded 0.0 so existing smokes don't
            // regress.
            //
            // Pre-PR-#59 these slots were hardcoded 0.0; the wire
            // carried no yaw/pitch. The PR #59 motivation for
            // populating them: the server's lag-comp hit-test
            // (validate_and_relay_aim) needs to know each player's
            // pose at the AimEvent's frame for the rewind. The
            // snapshot's yaw/pitch slots are read by the same
            // snapshot stream that drives the visual + predictor +
            // interpolator — they carry the client-claimed intent.
            let (yaw, pitch) = room
                .players
                .get(player_id)
                .map(|p| (p.yaw_radians, p.pitch_radians))
                .unwrap_or((0.0, 0.0));
            // PR 65 (debug) — log the yaw/pitch read from the room's
            // player entry. Pre-PR-65 the client's game loop never
            // sent `sendInputsServer`, so yaw/pitch were always 0.0
            // here and every server-side hit-scan used yaw=0 (miss).
            // This log fires once per snapshot (20Hz per room) so a
            // smoke can grep for "yaw=" lines and verify the client
            // is actually sending inputs.
            tracing::debug!(
                target: "snapshot_debug",
                room_id = %room.id,
                player_id = *player_id,
                yaw,
                pitch,
                hp,
                ammo,
                "snapshot_read_player_state"
            );
            player_states.push(PlayerState {
                player_id: *player_id,
                position_x: pos.x,
                position_y: pos.y,
                velocity_x: vel[0],
                velocity_y: vel[1],
                yaw,
                pitch,
                hp,
                ammo,
                is_firing: 0, // PR 11.7.E wires the fire bit
            });
        }

        // Sort by player_id for determinism (HashMap iteration
        // order is randomized by Rust's default hasher).
        player_states.sort_by_key(|p| p.player_id);

        Snapshot {
            server_frame: room.next_server_frame.saturating_sub(1),
            next_server_frame: room.next_server_frame,
            players: player_states,
        }
    }
}

impl Default for SnapshotGenerator {
    fn default() -> Self {
        Self::new()
    }
}

// PlayerId re-export so consumers can write
// `snapshot::PlayerIdT` if they need the u16 type without
// pulling in `session::PlayerId`.
pub use crate::session::PlayerId as PlayerIdT;

// -- PR 80 — snapshot rate-limit predicate ------------------------------
//
// Producer-side gate: skip the next `broadcast_snapshot` if ANY
// connection's outbound queue is saturated (depth > threshold_pct%
// of the per-connection cap).
//
// **Why a free function (not a `SnapshotGenerator` method)**: the
// predicate reads per-connection state (queue depth), not
// per-generator state. It's a snapshot-decision input, not a
// generator-state accessor. Free function keeps the generator
// single-purpose (time-based emit).
//
// **Why async**: each `ConnectionOutbound::queue_depth()` takes a
// `tokio::sync::Mutex` lock. We have to await that per-connection.
// For an empty room, returns false immediately (no awaits). For
// a 24-player room, 24 sequential awaits — each lock is
// near-instant under low contention.
//
// **Threshold semantics**: strictly greater-than. A queue at
// exactly `threshold_pct%` of cap is NOT rate-limited (still room
// for one more emit before the gate trips).
//
// **False-positive risk**: low. The cost of skipping an emit is
// at most one missed snapshot (50ms gap, sub-perceptual); the cost
// of NOT skipping is consumer-saturation drops + smoke flake.
pub async fn should_rate_limit(room: &Room, threshold_pct: u8) -> bool {
    // Clamp to a sane range. Out-of-band values should not crash
    // the rate-limiter — fall back to "never rate-limit" (101%)
    // or "always rate-limit" (0%) per the env-var's intent.
    let clamped = threshold_pct.min(100);
    for outbound in room.connections.values() {
        let depth = outbound.queue_depth().await;
        let cap = outbound.capacity();
        // Avoid divide-by-zero on a misconfigured cap (shouldn't
        // happen — with_capacity rejects 0 — but defensive).
        if cap == 0 {
            continue;
        }
        // depth * 100 > cap * pct → depth/cap > pct/100
        // Multiply-first avoids floating-point; usize overflow
        // is impossible here (cap = 1024, depth <= 1024, pct <= 100,
        // so both products fit easily in u64).
        let threshold_depth = (cap as u64 * clamped as u64) / 100;
        if (depth as u64) > threshold_depth {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::Room;

    fn room_with_players(ids: &[PlayerId]) -> Room {
        let mut room = Room::new("DEVBX");
        for id in ids {
            room.add_player(*id);
            // Seed the physics world with a body at origin so the
            // snapshot's position/velocity lookups return
            // sensible values.
            room.physics
                .add_player(*id, Position { x: 0.0, y: 0.0 });
        }
        room
    }

    #[test]
    fn maybe_emit_returns_none_before_interval() {
        let mut gen = SnapshotGenerator::new();
        let room = room_with_players(&[1]);
        // First call at now_ms=1000 — interval is 50ms, last_emit
        // starts at 0, so 1000-0 >= 50 → emit. Use now_ms=49 to
        // get None.
        assert!(gen.maybe_emit(&room, 49).is_none());
    }

    #[test]
    fn maybe_emit_returns_some_after_interval() {
        let mut gen = SnapshotGenerator::new();
        let room = room_with_players(&[1]);
        // 50ms is exactly the interval. We use `>=`, so this fires.
        let snap = gen.maybe_emit(&room, 50);
        assert!(snap.is_some());
    }

    #[test]
    fn snapshot_includes_only_connected_players() {
        let mut gen = SnapshotGenerator::new();
        let mut room = room_with_players(&[1, 2]);
        // Only register a connection for player 1.
        let tx = crate::connection_outbound::ConnectionOutbound::with_capacity(8);
        room.register_connection(1, tx);
        let snap = gen.maybe_emit(&room, 100).expect("emit");
        assert_eq!(snap.players.len(), 1);
        assert_eq!(snap.players[0].player_id, 1);
    }

    #[test]
    fn snapshot_includes_all_connected_players() {
        let mut gen = SnapshotGenerator::new();
        let mut room = room_with_players(&[1, 2, 3]);
        let tx1 = crate::connection_outbound::ConnectionOutbound::with_capacity(8);
        let tx2 = crate::connection_outbound::ConnectionOutbound::with_capacity(8);
        room.register_connection(1, tx1);
        room.register_connection(3, tx2);
        let snap = gen.maybe_emit(&room, 100).expect("emit");
        assert_eq!(snap.players.len(), 2);
        let ids: Vec<u16> = snap.players.iter().map(|p| p.player_id).collect();
        assert!(ids.contains(&1));
        assert!(ids.contains(&3));
        assert!(!ids.contains(&2)); // not connected → not in snapshot
    }

    #[test]
    fn snapshot_server_frame_is_next_minus_one() {
        let mut gen = SnapshotGenerator::new();
        let mut room = room_with_players(&[1]);
        let tx = crate::connection_outbound::ConnectionOutbound::with_capacity(8);
        room.register_connection(1, tx);
        room.next_server_frame = 42;
        let snap = gen.maybe_emit(&room, 100).expect("emit");
        assert_eq!(snap.server_frame, 41);
        assert_eq!(snap.next_server_frame, 42);
    }

    #[test]
    fn snapshot_carries_hp_and_ammo_from_player() {
        let mut gen = SnapshotGenerator::new();
        let mut room = room_with_players(&[1]);
        let tx = crate::connection_outbound::ConnectionOutbound::with_capacity(8);
        room.register_connection(1, tx);
        // Mutate the player's HP/ammo.
        if let Some(p) = room.players.get_mut(&1) {
            p.hp = 88;
            p.ammo = 6;
        }
        let snap = gen.maybe_emit(&room, 100).expect("emit");
        assert_eq!(snap.players[0].hp, 88);
        assert_eq!(snap.players[0].ammo, 6);
    }

    #[test]
    fn maybe_emit_is_deterministic_for_same_inputs() {
        // PR 11.7.B §5.2 hard-question 1: snapshot output is
        // deterministic — same inputs produce byte-equal bytes.
        let mut gen_a = SnapshotGenerator::new();
        let mut gen_b = SnapshotGenerator::new();
        let mut room_a = room_with_players(&[1, 2, 3]);
        let mut room_b = room_with_players(&[1, 2, 3]);
        let txa1 = crate::connection_outbound::ConnectionOutbound::with_capacity(8);
        let txa2 = crate::connection_outbound::ConnectionOutbound::with_capacity(8);
        let txa3 = crate::connection_outbound::ConnectionOutbound::with_capacity(8);
        room_a.register_connection(1, txa1);
        room_a.register_connection(2, txa2);
        room_a.register_connection(3, txa3);
        let txb1 = crate::connection_outbound::ConnectionOutbound::with_capacity(8);
        let txb2 = crate::connection_outbound::ConnectionOutbound::with_capacity(8);
        let txb3 = crate::connection_outbound::ConnectionOutbound::with_capacity(8);
        room_b.register_connection(1, txb1);
        room_b.register_connection(2, txb2);
        room_b.register_connection(3, txb3);
        room_a.next_server_frame = 100;
        room_b.next_server_frame = 100;
        let snap_a = gen_a.maybe_emit(&room_a, 1000).expect("emit");
        let snap_b = gen_b.maybe_emit(&room_b, 1000).expect("emit");
        // Same PlayerId ordering, same fields → byte-equal.
        assert_eq!(snap_a, snap_b);
        let bytes_a = crate::protocol::encode_snapshot(&snap_a);
        let bytes_b = crate::protocol::encode_snapshot(&snap_b);
        assert_eq!(bytes_a, bytes_b);
    }

    // Empty-room sanity: no connections → no players in snapshot.
    #[test]
    fn snapshot_with_no_connections_has_no_players() {
        let mut gen = SnapshotGenerator::new();
        let room = room_with_players(&[1]);
        let snap = gen.maybe_emit(&room, 100).expect("emit");
        assert_eq!(snap.players.len(), 0);
        let bytes = crate::protocol::encode_snapshot(&snap);
        assert_eq!(bytes.len(), crate::protocol::SNAPSHOT_WIRE_SIZE_MIN);
    }

    // ---- PR 80 — should_rate_limit tests --------------------------------
    //
    // Helper: build a room with N players each wired to a
    // ConnectionOutbound of `cap` capacity. Returns the room +
    // a vec of outbound handles so the test can saturate specific
    // connections.
    async fn room_with_outbounds(
        ids: &[PlayerId],
        cap: usize,
    ) -> (Room, Vec<crate::connection_outbound::ConnectionOutbound>) {
        let mut room = Room::new("DEVBX");
        let mut outs = Vec::new();
        for id in ids {
            room.add_player(*id);
            room.physics
                .add_player(*id, Position { x: 0.0, y: 0.0 });
            let co = crate::connection_outbound::ConnectionOutbound::with_capacity(cap);
            room.register_connection(*id, co.clone());
            outs.push(co);
        }
        (room, outs)
    }

    #[tokio::test]
    async fn rate_limit_empty_room_is_false() {
        let room = Room::new("DEVBX");
        // No connections → can't be rate-limited.
        assert!(!should_rate_limit(&room, 25).await);
    }

    #[tokio::test]
    async fn rate_limit_all_consumers_healthy_is_false() {
        let (room, _outs) = room_with_outbounds(&[1, 2], 32).await;
        // Nothing enqueued → depth=0, well below 25% threshold
        // (which is 8 for cap=32). Should NOT rate-limit.
        assert!(!should_rate_limit(&room, 25).await);
    }

    #[tokio::test]
    async fn rate_limit_one_consumer_saturated_is_true() {
        let (room, outs) = room_with_outbounds(&[1, 2], 32).await;
        // Saturate the first connection: push 16 items (= 50% of
        // cap=32; 25% threshold means depth > 8 → 16 > 8 ✓).
        for _ in 0..16 {
            outs[0].try_send(vec![0u8; 4]).await.unwrap();
        }
        // Even though player 2 is empty, player 1 is saturated →
        // gate trips (it's ANY, not ALL).
        assert!(should_rate_limit(&room, 25).await);
    }

    #[tokio::test]
    async fn rate_limit_threshold_edge_at_exactly_pct_is_false() {
        let (room, outs) = room_with_outbounds(&[1], 100).await;
        // Fill exactly to 25% (= 25 entries for cap=100).
        // Predicate uses strict >, so depth==threshold → NOT
        // rate-limited (one more emit before the gate trips).
        for _ in 0..25 {
            outs[0].try_send(vec![0u8; 4]).await.unwrap();
        }
        assert!(!should_rate_limit(&room, 25).await);
        // One more → depth=26, strictly > 25 → rate-limit fires.
        outs[0].try_send(vec![0u8; 4]).await.unwrap();
        assert!(should_rate_limit(&room, 25).await);
    }

    #[tokio::test]
    async fn rate_limit_all_consumers_saturated_is_true() {
        let (room, outs) = room_with_outbounds(&[1, 2, 3], 16).await;
        // Saturate all 3 connections: 9 entries each (> 25% of 16 = 4).
        for out in &outs {
            for _ in 0..9 {
                out.try_send(vec![0u8; 4]).await.unwrap();
            }
        }
        assert!(should_rate_limit(&room, 25).await);
    }

    #[tokio::test]
    async fn rate_limit_pct_100_never_limits() {
        let (room, outs) = room_with_outbounds(&[1], 32).await;
        // Saturate fully (32 entries).
        for _ in 0..32 {
            outs[0].try_send(vec![0u8; 4]).await.unwrap();
        }
        // threshold_pct=100 means "never rate-limit" — even a
        // fully-saturated queue passes.
        assert!(!should_rate_limit(&room, 100).await);
    }

    #[tokio::test]
    async fn rate_limit_pct_clamped_above_100() {
        let (room, _outs) = room_with_outbounds(&[1], 32).await;
        // Out-of-band threshold → clamped to 100 → never limits.
        assert!(!should_rate_limit(&room, 150).await);
        assert!(!should_rate_limit(&room, 200).await);
        assert!(!should_rate_limit(&room, 255).await);
    }
}
