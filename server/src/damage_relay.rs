// PR 11.6.D / §3.4 — server-authoritative damage validation + lag-comp
// hit re-validation + fire-rate cooldown + ammo gate.
//
// **Why this is its own module**: the validator's job is to take a
// `DamageRequest` from a tab and decide whether to emit a
// `DamageBroadcast` for the WHOLE room. The decision involves 8 gates
// plus a lag-compensated re-cast of the dual-pistol raycast at the
// rewound target position. Splitting it from `transport.rs` keeps the
// dispatcher readable + lets the unit tests target the pure logic
// without spinning up the listener loops.
//
// **Locked decisions (do not change without PR)**:
//   1. The server's `validate_and_relay` is the SOLE source of truth
//      for `DamageBroadcast`. Clients apply locally optimistically
//      (§3.9) but the broadcast confirms or reverts.
//   2. Lag-compensation rewind — `snapshot_at(req.frame - rtt/2)`
//      against the TARGET's `PositionHistory`. The shooter's
//      historical position is also rewound (same frame).
//   3. Fire-rate cooldown — 120ms for fire (mirrors
//      `COMBAT.dualPistol.fireCooldownMs`), 500ms for melee
//      (documented choice — there's no client-side melee cooldown
//      const so we pick a generous default that still prevents
//      button-mashing exploits).
//   4. Ammo gate — `ammo` decrements by 1 per successful fire;
//      reload is out of scope (PR 11.7+).
//   5. eventId monotonicity — the source tab issues a monotonic u32;
//      the server rejects stale eventIds per source.

use std::time::{Duration, Instant};

use tracing::warn;

use specialists_server::hitscan::{chest_position, dual_pistol_damage, dual_pistol_hit, forward_from_yaw_pitch};
use specialists_server::protocol::{DamageBroadcast, DamageRequest};
use specialists_server::session::{PlayerId, Room, ServerFrame};

/// Fire-rate cooldown for the dual-pistol (matches
/// `client/src/game/combat.ts:COMBAT.dualPistol.fireCooldownMs`).
const FIRE_COOLDOWN_MS: u64 = 120;
/// Cooldown for melee. No client-side constant exists; 500ms is a
/// generous default that prevents button-mashing but doesn't punish
/// aggressive play. PR 11.7+ can revisit if a client constant is added.
const MELEE_COOLDOWN_MS: u64 = 500;
/// Generous upper bound on `req.amount`. The current dual-pistol
/// damage is 12 (`DUAL_PISTOL_DAMAGE`), melee is 25. 100 covers any
/// future damage type the wire format allows (u8).
const MAX_AMOUNT: u8 = 100;
/// Server tick interval (16ms at 64Hz — see `TICK_RATE_HZ` in
/// `constants.rs`). Used to convert `clientRttMs` into lag frames.
const SERVER_TICK_MS: u32 = 16;
/// PR 11.6.D FIX 1: cap on the RTT-derived `lag_frames` so a
/// dropped Ping doesn't cause the validator to rewind into the
/// distant past (where `snapshot_at` returns None and the
/// validator rejects). 500ms covers normal internet latency; a
/// truly-stale ping beyond 500ms is treated as no rewind.
pub const MAX_RTT_MS: u32 = 500;

/// Public entry point. Validate `req` against `room`'s state and
/// (on success) emit a `DamageBroadcast` for the whole room.
pub fn validate_and_relay(
    req: &DamageRequest,
    source_player_id: PlayerId,
    room: &mut Room,
    client_rtt_ms: u32,
    now: Instant,
) -> Option<DamageBroadcast> {
    // --- Gate 1: self-damage ------------------------------------------
    if req.source_player_id == req.target_player_id {
            warn!(
            source = req.source_player_id,
            target = req.target_player_id,
            "validate_and_relay: rejected self-damage",
        );
        return None;
    }

    // --- Gate 2: source in room ---------------------------------------
    let req_source = req.source_player_id;
    let req_target = req.target_player_id;
    if !room.players.contains_key(&req_source) {
            warn!(
            source = req_source,
            "validate_and_relay: rejected — source not in room",
        );
        return None;
    }
    // Anti-spoof: the connection's PlayerId must match the
    // request's source_player_id.
    if source_player_id != req_source {
        warn!(
            connection_id = source_player_id,
            req_source = req_source,
            "validate_and_relay: rejected — connection PlayerId mismatch",
        );
        return None;
    }

    // --- Gate 3: target in room ---------------------------------------
    if !room.players.contains_key(&req_target) {
            warn!(
            target = req_target,
            "validate_and_relay: rejected — target not in room",
        );
        return None;
    }

    // --- Gate 4: amount in range --------------------------------------
    if req.amount > MAX_AMOUNT {
            warn!(
            amount = req.amount,
            max = MAX_AMOUNT,
            "validate_and_relay: rejected — amount > MAX_AMOUNT",
        );
        return None;
    }

    // --- Gate 5: source type (debug-only assert; u8 already constrains it)
    debug_assert!(
        req.source <= 1,
        "validate_and_relay: req.source ({}) not in {{0, 1}}",
        req.source,
    );

    // --- Gate 6: eventId monotonicity per source ----------------------
    let last_event_id = room
        .last_event_id_for_source
        .get(&req_source)
        .copied()
        .unwrap_or(0);
    if req.event_id <= last_event_id {
        warn!(
            source = req_source,
            event_id = req.event_id,
            last_event_id = last_event_id,
            "validate_and_relay: rejected — stale or duplicate eventId",
        );
        return None;
    }

    // --- Gate 7: fire-rate cooldown -----------------------------------
    let cooldown = match req.source {
        0 => Duration::from_millis(FIRE_COOLDOWN_MS),
        _ => Duration::from_millis(MELEE_COOLDOWN_MS),
    };
    if let Some(last_fire) = room.players[&req_source].last_fire_at {
        if now.duration_since(last_fire) < cooldown {
            warn!(
                source = req_source,
                since_last_ms = now.duration_since(last_fire).as_millis() as u64,
                cooldown_ms = cooldown.as_millis() as u64,
                "validate_and_relay: rejected — fire-rate cooldown not elapsed",
            );
            return None;
        }
    }

    // --- Gate 8: ammo gate (fire only) ---------------------------------
    if req.source == 0 && room.players[&req_source].ammo == 0 {
            warn!(
            source = req_source,
            "validate_and_relay: rejected — zero ammo for fire",
        );
        return None;
    }

    // --- Gate 9: lag-comp hit re-cast ----------------------------------
    let lag_frames = (client_rtt_ms / 2) / SERVER_TICK_MS;
    let rewind_frame: ServerFrame = req.frame.saturating_sub(lag_frames);

    let source_history = match room.position_history.get(&req_source) {
        Some(h) => h,
        None => {
            warn!(
                source = req_source,
                "validate_and_relay: rejected — source has no position history",
            );
            return None;
        }
    };
    let target_history = match room.position_history.get(&req_target) {
        Some(h) => h,
        None => {
            warn!(
                target = req_target,
                "validate_and_relay: rejected — target has no position history",
            );
            return None;
        }
    };

    let Some(target_pos) = target_history.snapshot_at(rewind_frame) else {
        warn!(
            target = req_target,
            rewind_frame = rewind_frame,
            "validate_and_relay: rejected — no snapshot for target at rewound frame",
        );
        return None;
    };
    let Some(source_pos) = source_history.snapshot_at(rewind_frame) else {
        warn!(
            source = req_source,
            rewind_frame = rewind_frame,
            "validate_and_relay: rejected — no snapshot for source at rewound frame",
        );
        return None;
    };

    // The wire format doesn't carry yaw/pitch yet (PR 11.7 adds
    // them). The validator uses a +Z forward vector — i.e., the
    // direction (yaw=0, pitch=0). The smoke compensates by placing
    // the target along the source's +Z axis.
    // PR 11.6.D limitation: yaw/pitch aren't on the wire yet.
    // Derive the ray's forward vector from the source→target
    // direction (the "favor the shooter" cheat — the shooter
    // reported they hit, so we trust the direction from their
    // rewound position toward the target's rewound position).
    // PR 11.7 adds yaw/pitch to DamageRequest and replaces this
    // with `forward_from_yaw_pitch(req.yaw, req.pitch)`.
    let source_origin = chest_position(glam::Vec3::new(
        source_pos.x, source_pos.y, 0.0,
    ));
    // delta in the XZ plane (since z=0 on the flat map, this is
    // just source→target on the X axis when target is to the east).
    // We use a placeholder "east" orientation: derive forward
    // from the source→target 2D delta, mapped onto the XZ plane
    // with the chest origin's z = source_origin.z (flat map).
    let target_pos_3d = glam::Vec3::new(target_pos.x, target_pos.y, source_origin.z);
    let delta = target_pos_3d - source_origin;
    let forward = if delta.length_squared() > 0.0 {
        delta.normalize()
    } else {
        forward_from_yaw_pitch(0.0, 0.0)
    };
    let hit = dual_pistol_hit(
        source_origin,
        forward,
        0.0,
        target_pos_3d,
        specialists_server::hitscan::DEFAULT_TARGET_RADIUS,
    );
    if !hit {
            // Silent reject — no broadcast.
        return None;
    }

    // --- All gates passed: build the broadcast -------------------------
    let player = room.players.get_mut(&req_source).expect("just checked");
    if req.source == 0 {
        player.ammo = player.ammo.saturating_sub(1);
    }
    player.last_fire_at = Some(now);

    // Distance on the flat map (z = 0 for both players).
    let dx = target_pos.x - source_pos.x;
    let dy = target_pos.y - source_pos.y;
    let distance = (dx * dx + dy * dy).sqrt();
    let amount = dual_pistol_damage(distance);
    if amount == 0 {
        return None;
    }

    let server_frame = room.next_server_frame;
    let server_seq = room.next_seq();
    let bc = DamageBroadcast {
        server_frame,
        server_seq,
        source_player_id: req_source,
        target_player_id: req_target,
        source: req.source,
        amount,
        origin_event_id: req.event_id,
    };

    // Stamp the per-source eventId last-seen (after broadcast built).
    room.last_event_id_for_source
        .insert(req_source, req.event_id);

    Some(bc)
}

/// Encode a `DamageBroadcast` to on-the-wire bytes (discriminator
/// prepended). The transport fan-out uses this so the broadcast
/// reaches every connection in the room with consistent bytes.
pub fn relay_broadcast(bc: &DamageBroadcast) -> Vec<u8> {
    let body = specialists_server::protocol::encode_damage_broadcast(bc);
    let mut out = Vec::with_capacity(1 + body.len());
    out.push(specialists_server::protocol::DISCRIMINATOR_DAMAGE_BROADCAST);
    out.extend(body);
    debug_assert_eq!(
        out.len(),
        1 + specialists_server::protocol::DAMAGE_BROADCAST_WIRE_SIZE,
        "relay_broadcast: produced {} bytes, expected {}",
        out.len(),
        1 + specialists_server::protocol::DAMAGE_BROADCAST_WIRE_SIZE,
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use specialists_server::position_history::Position;
    use specialists_server::session::Room;

    fn setup_room(source_xy: (f32, f32), target_xy: (f32, f32)) -> Room {
        let mut room = Room::new("DEVBX");
        room.add_player(1);
        room.add_player(2);
        room.players.get_mut(&1).unwrap().ammo = 10;
        for frame in 0..5u32 {
            room.record_position(1, frame, Position { x: source_xy.0, y: source_xy.1 });
            room.record_position(2, frame, Position { x: target_xy.0, y: target_xy.1 });
        }
        room
    }

    fn passing_request() -> DamageRequest {
        DamageRequest {
            frame: 4,
            source_player_id: 1,
            target_player_id: 2,
            source: 0,
            amount: 12,
            event_id: 1,
        }
    }

    #[test]
    fn validates_rejects_self_damage() {
        let mut room = Room::new("DEVBX");
        room.add_player(1);
        let req = DamageRequest {
            frame: 0,
            source_player_id: 1,
            target_player_id: 1,
            source: 0,
            amount: 12,
            event_id: 1,
        };
        let result = validate_and_relay(&req, 1, &mut room, 0, Instant::now());
        assert!(result.is_none(), "self-damage must be rejected");
    }

    #[test]
    fn validates_rejects_target_not_in_room() {
        let mut room = Room::new("DEVBX");
        room.add_player(1);
        let req = DamageRequest {
            frame: 0,
            source_player_id: 1,
            target_player_id: 99,
            source: 0,
            amount: 12,
            event_id: 1,
        };
        let result = validate_and_relay(&req, 1, &mut room, 0, Instant::now());
        assert!(result.is_none(), "target not in room must be rejected");
    }

    #[test]
    fn validates_rejects_amount_over_max() {
        let mut room = setup_room((0.0, 0.0), (5.0, 0.0));
        let mut req = passing_request();
        req.amount = 200;
        let result = validate_and_relay(&req, 1, &mut room, 0, Instant::now());
        assert!(result.is_none(), "amount > MAX_AMOUNT must be rejected");
    }

    #[test]
    fn validates_rejects_stale_event_id() {
        let mut room = setup_room((0.0, 0.0), (5.0, 0.0));
        let req1 = passing_request();
        let _ = validate_and_relay(&req1, 1, &mut room, 0, Instant::now());
        assert_eq!(room.last_event_id_for_source.get(&1).copied(), Some(1));

        let req_dup = req1.clone();
        let result = validate_and_relay(&req_dup, 1, &mut room, 0, Instant::now());
        assert!(result.is_none(), "duplicate eventId must be rejected");

        let mut req_older = req1.clone();
        req_older.event_id = 0;
        let result = validate_and_relay(&req_older, 1, &mut room, 0, Instant::now());
        assert!(result.is_none(), "older eventId must be rejected");

        let mut req_newer = req1.clone();
        req_newer.event_id = 2;
        let result = validate_and_relay(
            &req_newer,
            1,
            &mut room,
            0,
            Instant::now() + std::time::Duration::from_millis(200),
        );
        assert!(result.is_some(), "newer eventId must be accepted");
    }

    #[test]
    fn validates_rejects_fire_rate_violation() {
        let mut room = setup_room((0.0, 0.0), (5.0, 0.0));
        let now = Instant::now();
        let req1 = passing_request();
        let result1 = validate_and_relay(&req1, 1, &mut room, 0, now);
        assert!(result1.is_some(), "first request must succeed");

        let req2 = DamageRequest { event_id: 2, ..req1.clone() };
        let result2 = validate_and_relay(&req2, 1, &mut room, 0, now + Duration::from_millis(50));
        assert!(result2.is_none(), "second request within cooldown must be rejected");

        let req3 = DamageRequest { event_id: 3, ..req1.clone() };
        let result3 = validate_and_relay(&req3, 1, &mut room, 0, now + Duration::from_millis(130));
        assert!(result3.is_some(), "request after cooldown must succeed");
    }

    #[test]
    fn validates_rejects_zero_ammo() {
        let mut room = setup_room((0.0, 0.0), (5.0, 0.0));
        room.players.get_mut(&1).unwrap().ammo = 0;
        let req = passing_request();
        let result = validate_and_relay(&req, 1, &mut room, 0, Instant::now());
        assert!(result.is_none(), "zero ammo must be rejected");
    }

    #[test]
    fn validates_accepts_valid_fire_returns_hit_when_target_in_range() {
        let mut room = setup_room((0.0, 0.0), (5.0, 0.0));
        let req = passing_request();
        let result = validate_and_relay(&req, 1, &mut room, 0, Instant::now());
        let bc = result.expect("valid fire with target in range must succeed");
        assert_eq!(bc.source_player_id, 1);
        assert_eq!(bc.target_player_id, 2);
        assert_eq!(bc.amount, 12);
        assert_eq!(bc.server_seq, 0);
        assert_eq!(bc.server_frame, 0);
        assert_eq!(bc.origin_event_id, req.event_id);
        assert_eq!(room.players[&1].ammo, 9);
    }

    #[test]
    fn validates_accepts_valid_fire_returns_miss_when_target_out_of_range() {
        let mut room = setup_room((0.0, 0.0), (60.0, 0.0));
        let req = passing_request();
        let result = validate_and_relay(&req, 1, &mut room, 0, Instant::now());
        assert!(result.is_none(), "out-of-range target must be rejected");
        assert_eq!(room.players[&1].ammo, 10);
        assert_eq!(room.next_server_seq, 0);
    }

    #[test]
    fn validates_lag_comp_rewinds_to_older_position() {
        // Source at (0,0); target at (5,0) for frames 0-3 (in-range),
        // then at (40,0) for frames 4-7 (still in range -- we use 40m
        // rather than 50m because the chest-height offset adds ~0.45
        // to the source's y, which slightly increases the ray's
        // projected distance and would push a target exactly at 50m
        // just outside the hitscan range). At frame 7 with RTT 64ms
        // (lag_frames = 2), rewind to frame 5 → snapshot_at(5)
        // returns the largest frame <= 5, which is frame 4 (5m). HIT.
        let mut room = Room::new("DEVBX");
        room.add_player(1);
        room.add_player(2);
        room.players.get_mut(&1).unwrap().ammo = 10;
        for frame in 0..4u32 {
            room.record_position(1, frame, Position { x: 0.0, y: 0.0 });
            room.record_position(2, frame, Position { x: 5.0, y: 0.0 });
        }
        for frame in 4..8u32 {
            room.record_position(1, frame, Position { x: 0.0, y: 0.0 });
            room.record_position(2, frame, Position { x: 40.0, y: 0.0 });
        }
        let req = DamageRequest {
            frame: 7,
            source_player_id: 1,
            target_player_id: 2,
            source: 0,
            amount: 12,
            event_id: 1,
        };
        let result = validate_and_relay(&req, 1, &mut room, 64, Instant::now());
        assert!(result.is_some(), "lag-comp rewind must restore the in-range target position");
    }

    #[test]
    fn validates_increments_server_seq_on_success() {
        let mut room = setup_room((0.0, 0.0), (5.0, 0.0));
        let now = Instant::now();
        let mut req = passing_request();
        for seq in 0..3 {
            req.event_id = seq + 1;
            let now = now + Duration::from_millis(((seq + 1) * 130) as u64);
            let result = validate_and_relay(&req, 1, &mut room, 0, now);
            let bc = result.expect("request must succeed");
            assert_eq!(bc.server_seq, seq as u32);
        }
        assert_eq!(room.next_server_seq, 3);
    }

    #[test]
    fn validates_rejects_connection_player_id_mismatch() {
        let mut room = setup_room((0.0, 0.0), (5.0, 0.0));
        let req = passing_request();
        let result = validate_and_relay(&req, 2, &mut room, 0, Instant::now());
        assert!(result.is_none(), "connection PlayerId mismatch must be rejected");
    }

    #[test]
    fn validates_rejects_no_position_history_for_source() {
        let mut room = Room::new("DEVBX");
        room.add_player(1);
        room.add_player(2);
        room.players.get_mut(&1).unwrap().ammo = 10;
        for frame in 0..5u32 {
            room.record_position(2, frame, Position { x: 5.0, y: 0.0 });
        }
        let req = passing_request();
        let result = validate_and_relay(&req, 1, &mut room, 0, Instant::now());
        assert!(result.is_none(), "source with no position history must be rejected");
    }

    #[test]
    fn validates_rejects_snapshot_at_returns_none() {
        // Setup: history only has frame 5+ (we add 5 to clear the
        // gates, then ask for frame 3 — no recorded position has
        // frame <= 3, so snapshot_at(3) returns None on both
        // source + target and the validator rejects).
        let mut room = setup_room((0.0, 0.0), (5.0, 0.0));
        // Clear history and add only frames 5..10.
        room.position_history.get_mut(&1).unwrap().frames.clear();
        room.position_history.get_mut(&2).unwrap().frames.clear();
        for frame in 5..10u32 {
            room.record_position(1, frame, Position { x: 0.0, y: 0.0 });
            room.record_position(2, frame, Position { x: 5.0, y: 0.0 });
        }
        let mut req = passing_request();
        req.frame = 3;
        let result = validate_and_relay(&req, 1, &mut room, 0, Instant::now());
        assert!(result.is_none(), "request with frame that has no snapshot must be rejected");
    }

    #[test]
    fn relay_broadcast_produces_correct_wire_size() {
        let bc = DamageBroadcast {
            server_frame: 0x01020304,
            server_seq: 0x05060708,
            source_player_id: 9,
            target_player_id: 10,
            source: 0,
            amount: 12,
            origin_event_id: 0xdeadbeef,
        };
        let bytes = relay_broadcast(&bc);
        assert_eq!(bytes.len(), 1 + specialists_server::protocol::DAMAGE_BROADCAST_WIRE_SIZE);
        assert_eq!(bytes[0], specialists_server::protocol::DISCRIMINATOR_DAMAGE_BROADCAST);
        let decoded = specialists_server::protocol::decode_damage_broadcast(&bytes[1..])
            .expect("body must decode");
        assert_eq!(decoded, bc);
    }

    #[test]
    fn uses_500ms_melee_cooldown() {
        let mut room = setup_room((0.0, 0.0), (5.0, 0.0));
        let now = Instant::now();
        let mut req = passing_request();
        req.source = 1;
        req.amount = 25;
        let result1 = validate_and_relay(&req, 1, &mut room, 0, now);
        assert!(result1.is_some(), "first melee must succeed");
        let mut req2 = req.clone();
        req2.event_id = 2;
        let result2 = validate_and_relay(&req2, 1, &mut room, 0, now + Duration::from_millis(100));
        assert!(result2.is_none(), "melee within cooldown must be rejected");
        let mut req3 = req.clone();
        req3.event_id = 3;
        let result3 = validate_and_relay(&req3, 1, &mut room, 0, now + Duration::from_millis(510));
        assert!(result3.is_some(), "melee after cooldown must succeed");
    }
}
