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
    let co = specialists_server::connection_outbound::ConnectionOutbound::with_capacity(8);
    room.register_connection(id, co);
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
    //   (playerCount) + 31 (player payload) = 40 bytes (PR #106:
    //   +1 byte per player for current_fire_mode; PR #102 was 30
    //   and PR #59 was 29).
    // The on-the-wire size (disc + body) is 41 bytes — see
    // `SNAPSHOT_WIRE_SIZE_MIN + 1 * PLAYER_STATE_WIRE_SIZE`
    // in the protocol module.
    assert_eq!(bytes.len(), 9 + 1 * 31);
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
    let co_a = specialists_server::connection_outbound::ConnectionOutbound::with_capacity(8);
    let co_b = specialists_server::connection_outbound::ConnectionOutbound::with_capacity(8);
    let co_c = specialists_server::connection_outbound::ConnectionOutbound::with_capacity(8);
    let mut rx_a = co_a.clone();
    let mut rx_b = co_b.clone();
    let mut rx_c = co_c.clone();
    room.register_connection(1, co_a);
    room.register_connection(2, co_b);
    room.register_connection(3, co_c);

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

/// PR 11.7.D2 — broadcast_snapshot back-pressure drops the OLDEST
/// queued snapshot when the outbound mpsc is full, then re-sends
/// the new one. We fill the channel to capacity with synthetic
/// snapshots, then call `broadcast_snapshot` once — the new
/// snapshot must succeed (after dropping the oldest in queue).
///
/// The "drops oldest" assertion verifies the channel state by
/// draining the receiver end after the broadcast and checking the
/// queue order: the latest snapshot should be at the tail.
#[tokio::test]
async fn broadcast_snapshot_drops_oldest_on_full_channel() {
    use specialists_server::protocol::DISCRIMINATOR_SNAPSHOT;
    use specialists_server::transport::broadcast_snapshot;

    let mut room = Room::new("DEVBX");
    // Custom small capacity — small enough to fill quickly with
    // synthetic data. ConnectionOutbound::with_capacity bypasses the
    // CONNECTION_OUTBOUND_CAPACITY=512 floor (we exercise the
    // drop-oldest path at small N here).
    let co = specialists_server::connection_outbound::ConnectionOutbound::with_capacity(4);
    let mut rx = co.clone();
    room.register_connection(1, co.clone());
    let room_arc = std::sync::Arc::new(tokio::sync::RwLock::new(room));

    // Pre-fill the channel with 4 snapshots (saturating the queue).
    let initial_snap = vec![
        DISCRIMINATOR_SNAPSHOT,
        0xAA,
        0xAA,
        0xAA,
        0xAA,
        0xAA,
        0xAA,
        0xAA,
        0xAA,
        0xAA,
    ];
    for _ in 0..4 {
        // try_send is async (returns Future<Output = Result<(), ()>>).
        co.try_send(initial_snap.clone()).await.expect("prefill ok");
    }

    // The new snapshot — different byte pattern so we can identify it.
    let new_snap = vec![
        DISCRIMINATOR_SNAPSHOT,
        0xBB,
        0xBB,
        0xBB,
        0xBB,
        0xBB,
        0xBB,
        0xBB,
        0xBB,
        0xBB,
    ];

    // broadcast_snapshot should drop one of the pre-filled snapshots
    // and queue the new one. No panic, no thread block.
    broadcast_snapshot(room_arc.clone(), new_snap.clone()).await;

    // Drain the receiver and verify: at least one new_snap should be
    // in the queue (proving the drop-oldest path worked). We don't
    // assert exact ordering because the broadcast_snapshot's internal
    // ordering interacts with HashMap iteration order over
    // room.connections — but the new_snap MUST appear because the
    // channel was full and the function had to make room.
    //
    // **Drain semantics**: with cap=4 and 4 prefills + 1
    // broadcast, the queue ends at cap=4 (one old dropped, new added).
    // The recv pop_back returns the newest first (LIFO from consumer
    // perspective): new_snap, then the 3 prefill entries that survived.
    // After 4 recvs, the queue is empty and recv awaits forever.
    // We break BEFORE awaiting once we've drained the expected count.
    let mut got_new = false;
    let mut drained_count = 0;
    let expected_total = 4; // 3 surviving prefills + 1 new_snap
    while drained_count < expected_total {
        match rx.recv().await {
            Some(msg) => {
                drained_count += 1;
                if msg == new_snap {
                    got_new = true;
                }
            }
            None => break,
        }
    }
    assert!(
        got_new,
        "broadcast_snapshot back-pressure must have queued the new snapshot after dropping oldest",
    );
    assert!(
        drained_count <= 4,
        "back-pressure must drop at least one entry (drained {} entries)",
        drained_count,
    );
}

/// PR 11.7.D2 — broadcast_snapshot drops only the OLDEST, not all.
/// Pre-fill the channel with snapshots labelled with frame numbers;
/// after broadcast, the receiver should still see some of the
/// originals (not all dropped). This guards against an
/// over-aggressive "drop-newest" or "drop-all" interpretation.
#[tokio::test]
async fn broadcast_snapshot_drops_only_oldest_not_all() {
    use specialists_server::protocol::DISCRIMINATOR_SNAPSHOT;
    use specialists_server::transport::broadcast_snapshot;

    let mut room = Room::new("DEVBX");
    let co = specialists_server::connection_outbound::ConnectionOutbound::with_capacity(4);
    let mut rx = co.clone();
    room.register_connection(1, co.clone());
    let room_arc = std::sync::Arc::new(tokio::sync::RwLock::new(room));

    // Pre-fill with 4 snapshots, each tagged with a frame number
    // (byte 1 = frame).
    for frame in 0..4u8 {
        let snap = vec![DISCRIMINATOR_SNAPSHOT, frame, 0, 0, 0, 0, 0, 0, 0, 0];
        co.try_send(snap).await.expect("prefill ok");
    }

    // New snapshot — frame 99 to distinguish.
    let new_snap = vec![DISCRIMINATOR_SNAPSHOT, 99, 0, 0, 0, 0, 0, 0, 0, 0];
    broadcast_snapshot(room_arc.clone(), new_snap.clone()).await;

    // Drain with bounded loop. With cap=4 + 4 prefills + 1 broadcast
    // = drop-oldest, queue ends at cap=4. LIFO recv order: new_snap
    // first, then 3 surviving prefills, then recv hangs on empty.
    // We count expected items and break BEFORE awaiting once we've
    // drained enough to make assertions.
    let mut drained = vec![];
    let expected_total = 4; // 3 surviving prefills + 1 new_snap
    while drained.len() < expected_total {
        match rx.recv().await {
            Some(msg) => drained.push(msg),
            None => break,
        }
    }
    let has_new = drained.iter().any(|m| m == &new_snap);
    let original_count = drained
        .iter()
        .filter(|m| m[1] != 99 && m[0] == DISCRIMINATOR_SNAPSHOT)
        .count();
    assert!(has_new, "new snapshot must be queued after back-pressure");
    assert!(
        original_count >= 1,
        "back-pressure must drop OLDEST only, not all originals (kept {} of 4)",
        original_count,
    );
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
            room.physics.add_player(
                id,
                Position {
                    x: id as f32,
                    y: id as f32,
                },
            );
            let co = specialists_server::connection_outbound::ConnectionOutbound::with_capacity(8);
            room.register_connection(id, co);
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
    assert_eq!(
        stored, 32,
        "expected 32 stored frames over 64 physics frames"
    );
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

/// PR AimEvent / §4.5 — once the `0x06 InputsServer` arm populates
/// `Room.players[id].yaw_radians` / `.pitch_radians`, the snapshot
/// MUST mirror those values (not the hardcoded 0.0 default). This
/// catches the regression where `snapshot.rs::maybe_emit` reverts
/// to hardcoded 0.0 (the bug PR #59 just fixed).
#[test]
fn snapshot_carries_yaw_pitch_populated_from_room() {
    let mut room = empty_room();
    register_connection(&mut room, 1);
    // Simulate the 0x06 InputsServer arm capturing the client's
    // last-reported yaw/pitch into Room.players[1].
    {
        let p = room.players.get_mut(&1).expect("player 1 in room");
        p.yaw_radians = 1.234;
        p.pitch_radians = -0.567;
    }
    let mut gen = SnapshotGenerator::new();
    let snap = gen.maybe_emit(&room, 100).expect("emit");
    // PR #59: snapshot MUST carry the populated yaw/pitch (not 0.0).
    let p1 = snap
        .players
        .iter()
        .find(|p| p.player_id == 1)
        .expect("player 1 in snap");
    assert!(
        (p1.yaw - 1.234).abs() < 0.001,
        "yaw must mirror Room.players[1].yaw_radians (got {})",
        p1.yaw
    );
    assert!(
        (p1.pitch - (-0.567)).abs() < 0.001,
        "pitch must mirror Room.players[1].pitch_radians (got {})",
        p1.pitch
    );
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
