// PR 11.7.B / §3.4 + §3.10.1 — integration tests for the
// `SnapshotGenerator` + wire-format fan-out.
//
// These tests build a fresh `Room` + `SnapshotGenerator` in
// isolation (no listener, no network) and assert:
//   - the generator emits at exactly `SNAPSHOT_RATE_HZ` (20Hz)
//   - the snapshot includes only connected players
//   - the wire-format round-trip is byte-equal
//   - the generator doesn't emit before the interval has
//     elapsed
//
// All tests use a fake monotonic clock (`now_ms` argument) so
// the timing assertions are deterministic — no `Instant::now()`,
// no `tokio::time::sleep`.

use std::time::Duration;

use specialists_server::position_history::Position;
use specialists_server::protocol::{decode_snapshot, encode_snapshot};
use specialists_server::session::{PlayerId, Room};
use specialists_server::snapshot::SnapshotGenerator;

const ONE_PLAYER: [PlayerId; 1] = [1];

fn empty_room() -> Room {
    let mut room = Room::new("DEVBX");
    for id in ONE_PLAYER {
        room.add_player(id);
        // Seed the physics world with a body at origin so the
        // snapshot's position/velocity lookups return
        // sensible values (not Position::ZERO defaults).
        room.physics.add_player(id, Position { x: 0.0, y: 0.0 });
    }
    room
}

fn register_connection(room: &mut Room, id: PlayerId) {
    let (tx, _rx) = tokio::sync::mpsc::channel(8);
    room.register_connection(id, tx);
}

/// PR 11.7.B — generator emits at 20Hz. Run for 200ms of fake
/// time; assert 4 snapshots emitted (±1 — the `maybe_emit`
/// interval is 50ms so 200/50 = 4 exact).
#[test]
fn snapshot_emitted_at_20hz() {
    let mut room = empty_room();
    register_connection(&mut room, 1);
    let mut gen = SnapshotGenerator::new();
    let mut emit_count = 0;
    for now_ms in (0u64..=200).step_by(10) {
        if gen.maybe_emit(&room, now_ms).is_some() {
            emit_count += 1;
        }
    }
    // 200ms / 50ms interval = 4 emits. Allow ±1 for boundary
    // effects (the first emit at now_ms=0 because last_emit=0
    // + 50 = 50, so now=0 < 50 → no emit; now=50 → emit; etc).
    assert!(
        (3..=5).contains(&emit_count),
        "expected ~4 emits over 200ms at 20Hz, got {}",
        emit_count
    );
}

/// PR 11.7.B — `snapshot.player_count` matches the connected
/// players count, not `MAX_PLAYERS_PER_ROOM`.
#[test]
fn snapshot_player_count_matches_connections() {
    // First: room with 1 connection → snapshot has 1 player.
    let mut room = empty_room();
    register_connection(&mut room, 1);
    let mut gen = SnapshotGenerator::new();
    let snap = gen.maybe_emit(&room, 100).expect("emit");
    assert_eq!(snap.players.len(), 1);

    // Then: add 2 more connections → snapshot has 3 players.
    room.add_player(2);
    room.add_player(3);
    room.physics.add_player(2, Position::ZERO);
    room.physics.add_player(3, Position::ZERO);
    register_connection(&mut room, 2);
    register_connection(&mut room, 3);
    let snap = gen.maybe_emit(&room, 200).expect("emit");
    assert_eq!(snap.players.len(), 3);
}

/// PR 11.7.B — wire-format round-trip. Encode a snapshot,
/// decode it back, assert byte-equal.
#[test]
fn snapshot_wire_format_roundtrip() {
    let mut room = empty_room();
    register_connection(&mut room, 1);
    let mut gen = SnapshotGenerator::new();
    let snap = gen.maybe_emit(&room, 100).expect("emit");
    let bytes = encode_snapshot(&snap);
    let decoded = decode_snapshot(&bytes).expect("decode");
    assert_eq!(decoded, snap);
    // Pin the wire format. The encoder returns BODY only
    // (disc is prepended by the transport router, matching
    // the DamageBroadcast pattern). For 1 player:
    //   4 (serverFrame) + 4 (nextServerFrame) + 1
    //   (playerCount) + 29 (player payload) = 38 bytes.
    // The on-the-wire size (disc + body) is 39 bytes — see
    // `SNAPSHOT_WIRE_SIZE_MIN + 1 * PLAYER_STATE_WIRE_SIZE`
    // in the protocol module.
    assert_eq!(bytes.len(), 9 + 1 * 29);
    assert_eq!(
        bytes.len(),
        specialists_server::protocol::SNAPSHOT_WIRE_SIZE_MIN
            + 1 * specialists_server::protocol::PLAYER_STATE_WIRE_SIZE
    );
}

/// PR 11.7.B — first call within the 50ms interval returns
/// None (the interval gate). The first emit requires
/// `now_ms >= 50`.
#[test]
fn snapshot_does_not_emit_before_interval() {
    let mut room = empty_room();
    register_connection(&mut room, 1);
    let mut gen = SnapshotGenerator::new();
    // First call: now_ms = 49, last_emit = 0 → diff = 49 < 50 → None.
    assert!(gen.maybe_emit(&room, 49).is_none());
    // After the gate, next call returns Some.
    let snap = gen.maybe_emit(&room, 50);
    assert!(snap.is_some());
}

/// PR 11.7.B / §3.10 — snapshot cadence is exactly 20Hz with
/// no drift. Verify that calling `maybe_emit` at t=50, 100,
/// 150, 200, 250 each return Some (5 consecutive emits).
#[test]
fn snapshot_cadence_is_exactly_20hz_no_drift() {
    let mut room = empty_room();
    register_connection(&mut room, 1);
    let mut gen = SnapshotGenerator::new();
    for tick in 1..=5u64 {
        let now_ms = tick * 50;
        let snap = gen.maybe_emit(&room, now_ms);
        assert!(
            snap.is_some(),
            "tick {} (now_ms={}) should emit",
            tick,
            now_ms
        );
    }
    // 49ms after the last emit (interval = 50ms) should NOT emit.
    assert!(gen.maybe_emit(&room, 5 * 50 + 49).is_none());
    // Exactly at 50ms after the last emit (now = 300ms) should emit.
    assert!(gen.maybe_emit(&room, 6 * 50).is_some());
}

/// PR 11.7.B — broadcast_snapshot fan-out writes to every
/// registered connection's mpsc sender. Uses an async test to
/// drive the mpsc receivers.
#[tokio::test]
async fn broadcast_snapshot_writes_to_every_connection() {
    use specialists_server::protocol::DISCRIMINATOR_SNAPSHOT;
    use specialists_server::transport::broadcast_snapshot;

    let mut room = Room::new("DEVBX");
    let (tx_a, mut rx_a) = tokio::sync::mpsc::channel::<Vec<u8>>(8);
    let (tx_b, mut rx_b) = tokio::sync::mpsc::channel::<Vec<u8>>(8);
    let (tx_c, mut rx_c) = tokio::sync::mpsc::channel::<Vec<u8>>(8);
    room.register_connection(1, tx_a);
    room.register_connection(2, tx_b);
    room.register_connection(3, tx_c);

    let room_arc = std::sync::Arc::new(tokio::sync::RwLock::new(room));
    let snap_bytes = vec![DISCRIMINATOR_SNAPSHOT, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    broadcast_snapshot(room_arc.clone(), snap_bytes.clone()).await;

    // Each receiver should have the bytes.
    let a = rx_a.recv().await.expect("rx_a recv");
    let b = rx_b.recv().await.expect("rx_b recv");
    let c = rx_c.recv().await.expect("rx_c recv");
    assert_eq!(a, snap_bytes);
    assert_eq!(b, snap_bytes);
    assert_eq!(c, snap_bytes);
}

/// PR 11.7.B — broadcast_snapshot with no connections is a
/// no-op (no panic, no message).
#[tokio::test]
async fn broadcast_snapshot_with_no_connections_is_noop() {
    use specialists_server::protocol::DISCRIMINATOR_SNAPSHOT;
    use specialists_server::transport::broadcast_snapshot;

    let room = Room::new("DEVBX");
    let room_arc = std::sync::Arc::new(tokio::sync::RwLock::new(room));
    let snap_bytes = vec![DISCRIMINATOR_SNAPSHOT, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    // Should complete without error.
    broadcast_snapshot(room_arc, snap_bytes).await;
}

/// PR 11.7.B — end-to-end determinism. Run the same physics +
/// snapshot sequence twice; the outputs must be byte-equal.
/// Catches nondeterminism in HashMap iteration or Rapier's
/// internal state.
#[test]
fn snapshot_is_deterministic_across_runs() {
    fn run_once() -> Vec<u8> {
        let mut room = Room::new("DEVBX");
        for id in [1u16, 2, 3, 4, 5] {
            room.add_player(id);
            room.physics
                .add_player(id, Position { x: id as f32, y: id as f32 });
            let (tx, _rx) = tokio::sync::mpsc::channel(8);
            room.register_connection(id, tx);
        }
        let mut gen = SnapshotGenerator::new();
        let snap = gen.maybe_emit(&room, 100).expect("emit");
        encode_snapshot(&snap)
    }
    let bytes_a = run_once();
    let bytes_b = run_once();
    assert_eq!(
        bytes_a, bytes_b,
        "snapshot wire bytes must be deterministic across runs"
    );
}

/// PR 11.7.B — sanity check on the timing: 100ms of fake time
/// produces exactly 2 emits (at t=50 and t=100).
#[test]
fn snapshot_emits_at_50ms_and_100ms_only() {
    let mut room = empty_room();
    register_connection(&mut room, 1);
    let mut gen = SnapshotGenerator::new();
    let mut emits: Vec<u64> = Vec::new();
    for now_ms in 0..=100u64 {
        if gen.maybe_emit(&room, now_ms).is_some() {
            emits.push(now_ms);
        }
    }
    assert_eq!(
        emits,
        vec![50, 100],
        "expected emits at 50ms and 100ms (20Hz cadence), got {:?}",
        emits
    );
    // Duration sanity: 1 second = 1000ms = 20 emits exactly.
    let mut gen2 = SnapshotGenerator::new();
    let mut emits2 = 0;
    for now_ms in 0..=1000u64 {
        if gen2.maybe_emit(&room, now_ms).is_some() {
            emits2 += 1;
        }
    }
    assert_eq!(
        emits2, 20,
        "1 second of fake time at 20Hz = 20 emits exactly, got {}",
        emits2
    );
}

/// PR 11.7.B — `PositionHistory::should_store_frame` predicate.
/// Even frames store (0, 2, 4, ...); odd frames don't (1, 3,
/// 5, ...). The physics tick uses this to gate recording.
#[test]
fn should_store_frame_predicate_matches_32hz_at_64hz_physics() {
    use specialists_server::position_history::should_store_frame;
    // 64 ticks at 1ms each = 64 frames recorded, 32 stored.
    let mut stored = 0;
    for frame in 0..64u32 {
        if should_store_frame(frame) {
            stored += 1;
        }
    }
    assert_eq!(stored, 32, "expected 32 stored frames over 64 physics frames");
}

/// PR 11.7.B — `Snapshot` carries yaw/pitch as 0.0 default (the
/// server-side wire doesn't include them this PR; PR 11.7.E's
/// weapon switch logic will use them).
#[test]
fn snapshot_carries_yaw_pitch_as_zero_default() {
    let mut room = empty_room();
    register_connection(&mut room, 1);
    let mut gen = SnapshotGenerator::new();
    let snap = gen.maybe_emit(&room, 100).expect("emit");
    assert_eq!(snap.players[0].yaw, 0.0);
    assert_eq!(snap.players[0].pitch, 0.0);
}

/// PR 11.7.B — sanity check on the integration interval math:
/// `Duration::from_millis(50)` = exactly 20Hz.
#[test]
fn snapshot_interval_is_exactly_50ms() {
    use specialists_server::constants::SNAPSHOT_RATE_HZ;
    let interval_ms = 1000u64 / SNAPSHOT_RATE_HZ as u64;
    assert_eq!(interval_ms, 50);
    let d = Duration::from_millis(interval_ms);
    assert_eq!(d, Duration::from_millis(50));
}
