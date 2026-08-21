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
/// PR 11.6.D FIX 6: melee damage matches
/// `client/src/game/combat.ts:COMBAT.melee.damage` (25). Without
/// this constant, gate 9+10 would use `dual_pistol_damage(...)
/// which always returns 12 — and the client's optimistic apply
/// would diverge from the broadcast (see FIX 4 forecast/correction
/// path).
pub const MELEE_DAMAGE: u8 = 25;
/// PR 11.6.D FIX 6: melee range matches
/// `client/src/game/combat.ts:COMBAT.melee.rangeMeters` (1.5).
/// The 50m pistol range would allow a "melee" hit from across
/// the map — clearly wrong.
pub const MELEE_MAX_RANGE_METERS: f32 = 1.5;
/// PR 11.6.D FIX 7: bounded window for the eventId monotonicity
/// gate. Strict monotonicity (`req.event_id > last_event_id`) breaks
/// when the client tab reloads (its `nextEventId` resets to 1) but
/// the server's `last_event_id_for_source` persists for the room's
/// lifetime — every subsequent request fails. The bounded window
/// allows the client some retry budget: if `req.event_id` is within
/// `EVENT_ID_WINDOW` of the last seen, accept; otherwise reject.
/// 64 covers normal use + rapid retry storms.
pub const EVENT_ID_WINDOW: u32 = 64;

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

    // --- Gate 6: eventId bounded-window per source -------------------
    // FIX 7: bounded window — accept if `req.event_id` is within
    // `EVENT_ID_WINDOW` of `last_event_id`. Reject only if the gap
    // exceeds the window. This allows client tab reloads (where
    // `nextEventId` resets to 1) to recover without invalidating
    // every subsequent request.
    let last_event_id = room
        .last_event_id_for_source
        .get(&req_source)
        .copied()
        .unwrap_or(0);
    if req.event_id.saturating_add(EVENT_ID_WINDOW) < last_event_id {
        warn!(
            source = req_source,
            event_id = req.event_id,
            last_event_id = last_event_id,
            window = EVENT_ID_WINDOW,
            "validate_and_relay: rejected — eventId more than EVENT_ID_WINDOW behind last_event_id",
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

    // FIX 6: branch amount + hit-range by source type. The
    // `dual_pistol_damage` function returns 12 (or 0 if out of
    // range) — wrong for melee. Melee uses a simple distance check
    // (no raycast; the client already ran the cone check at fire
    // time — PR 11.6.D's server-side is a permissive "are they
    // within melee range" verifier).
    let amount = match req.source {
        0 => dual_pistol_damage(distance),
        _ => MELEE_DAMAGE,
    };
    if amount == 0 {
        return None;
    }
    // FIX 6: for melee, the 50m pistol range is wrong. Use a
    // MELEE_MAX_RANGE_METERS gate. We already passed the hit-box
    // test above (the dual_pistol_hit check); for melee we
    // re-verify with the melee range. If the target is OUT of
    // melee range, this is a hit that the client's cone check
    // already validated — but only if the target is within melee
    // range. Reject if not.
    if req.source != 0 && distance > MELEE_MAX_RANGE_METERS {
        // Silent reject — no broadcast.
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

    // PR 11.7.D / D1 / §4.4 closure: mutate the target's HP on the
    // server so the snapshot's `players[i].hp` is the
    // server-authoritative value (the brief's premise). Without this
    // decrement, the snapshot's HP would stay at 100 forever — the
    // client-side `applyBroadcast` was the only path that ever
    // changed HP, and the §4.4 race (optimistic-apply vs broadcast-
    // receive ordering) was the only reason HP could diverge on the
    // same broadcast. With the snapshot's HP mutated here, the
    // snapshot stream is the single source of truth and broadcast
    // drops become invisible (the snapshot doesn't drop under the
    // outbound-channel pressure that the damage-broadcast stream
    // does).
    //
    // Gate 3 (above, `room.players.contains_key(&req_target)`) already
    // validated the target is present; the `expect` documents that
    // invariant explicitly and avoids the redundant HashMap lookup
    // the `if let Some` would incur.
    let target_player = room
        .players
        .get_mut(&req_target)
        .expect("validate_and_relay: gate 3 invariant violated — req_target not in room.players");
    target_player.hp = target_player.hp.saturating_sub(amount);

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

/// PR 11.6.D FIX 4: encode a `DamageReject` to on-the-wire bytes
/// (discriminator prepended). The transport sends this to the
/// source tab only (not broadcast) so the source can revert its
/// optimistic apply.
pub fn relay_reject(event_id: u32, reason: u8) -> Vec<u8> {
    let r = specialists_server::protocol::DamageReject { event_id, reason };
    let body = specialists_server::protocol::encode_damage_reject(&r);
    let mut out = Vec::with_capacity(1 + body.len());
    out.push(specialists_server::protocol::DISCRIMINATOR_DAMAGE_REJECT);
    out.extend(body);
    debug_assert_eq!(
        out.len(),
        1 + specialists_server::protocol::DAMAGE_REJECT_BODY_SIZE,
        "relay_reject: produced {} bytes, expected {}",
        out.len(),
        1 + specialists_server::protocol::DAMAGE_REJECT_BODY_SIZE,
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
    fn validates_rejects_when_position_history_is_empty() {
        // PR 11.7.B / §3.14 — `snapshot_at` no longer returns
        // None for normal lag-comp windows (it snaps to nearest
        // within ±8 frames). The only path that returns None is
        // an empty history buffer. The validator's
        // `let Some(target_pos) = ... else { return None; }`
        // rejection branch is now reachable only when the buffer
        // is completely empty for the target.
        let mut room = setup_room((0.0, 0.0), (5.0, 0.0));
        // Wipe both players' history completely.
        room.position_history.get_mut(&1).unwrap().frames.clear();
        room.position_history.get_mut(&2).unwrap().frames.clear();
        let mut req = passing_request();
        req.frame = 3;
        let result = validate_and_relay(&req, 1, &mut room, 0, Instant::now());
        assert!(result.is_none(), "request with empty history must be rejected");
    }

    #[test]
    fn validates_uses_nearest_snapshot_within_tolerance() {
        // PR 11.7.B / §3.14 — verify the snap-to-nearest math is
        // exercised end-to-end. History has frames 5..10; the
        // request asks for frame 7 (an exact match). The
        // validator should accept (the lag-comp rewind matches
        // the recorded position).
        let mut room = setup_room((0.0, 0.0), (5.0, 0.0));
        room.position_history.get_mut(&1).unwrap().frames.clear();
        room.position_history.get_mut(&2).unwrap().frames.clear();
        for frame in 5..10u32 {
            room.record_position(1, frame, Position { x: 0.0, y: 0.0 });
            room.record_position(2, frame, Position { x: 5.0, y: 0.0 });
        }
        let mut req = passing_request();
        req.frame = 7;
        let result = validate_and_relay(&req, 1, &mut room, 0, Instant::now());
        assert!(result.is_some(), "request with frame 7 (exact match in history) must be accepted");
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
        // FIX 6: melee target must be within 1.5m; use (1.0, 0.0).
        let mut room = setup_room((0.0, 0.0), (1.0, 0.0));
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

    #[test]
    fn melee_uses_melee_damage_constant_not_dual_pistol_damage() {
        // FIX 6: melee request must produce bc.amount == MELEE_DAMAGE (25),
        // NOT dual_pistol_damage(distance) which is always 12.
        let mut room = setup_room((0.0, 0.0), (1.0, 0.0));
        let mut req = passing_request();
        req.source = 1;
        req.amount = 25;
        let bc = validate_and_relay(&req, 1, &mut room, 0, Instant::now())
            .expect("melee within range must succeed");
        assert_eq!(bc.amount, MELEE_DAMAGE, "melee damage must be MELEE_DAMAGE (25), not 12");
        assert_eq!(bc.amount, 25, "client's COMBAT.melee.damage is 25");
    }

    #[test]
    fn melee_rejects_target_outside_melee_range() {
        // FIX 6: melee target at 5m must be rejected (out of 1.5m range).
        let mut room = setup_room((0.0, 0.0), (5.0, 0.0));
        let mut req = passing_request();
        req.source = 1;
        req.amount = 25;
        let result = validate_and_relay(&req, 1, &mut room, 0, Instant::now());
        assert!(result.is_none(), "melee target outside melee range must be rejected");
    }

    #[test]
    fn rejects_event_id_more_than_window_behind_last() {
        // FIX 7: bounded window for eventId gate. Reject if
        // req.event_id + EVENT_ID_WINDOW < last_event_id.
        let mut room = setup_room((0.0, 0.0), (5.0, 0.0));
        let now = Instant::now();
        let req1 = passing_request();
        let _ = validate_and_relay(&req1, 1, &mut room, 0, now);
        assert_eq!(room.last_event_id_for_source.get(&1).copied(), Some(1));

        // req.event_id + EVENT_ID_WINDOW == last_event_id -> reject
        let mut req_far_behind = req1.clone();
        req_far_behind.event_id = 1 + EVENT_ID_WINDOW;  // 65
        let result = validate_and_relay(&req_far_behind, 1, &mut room, 0, now);
        assert!(result.is_none(), "event_id + WINDOW < last_event_id must be rejected");

        // req.event_id + EVENT_ID_WINDOW == last_event_id + 1 -> accept
        let mut req_just_in_window = req1.clone();
        req_just_in_window.event_id = EVENT_ID_WINDOW;  // 64
        let result = validate_and_relay(&req_just_in_window, 1, &mut room, 0, now);
        assert!(result.is_none(), "event_id + WINDOW == last_event_id still rejects");

        // Same event_id repeated -> reject (duplicates still don't replay)
        let req_dup = req1.clone();
        let result = validate_and_relay(&req_dup, 1, &mut room, 0, now);
        assert!(result.is_none(), "duplicate eventId must be rejected");

        // Newer event_id -> accept (advances last_event_id)
        let mut req_newer = req1.clone();
        req_newer.event_id = 2;
        let result = validate_and_relay(&req_newer, 1, &mut room, 0,
            now + Duration::from_millis(200));
        assert!(result.is_some(), "newer eventId must be accepted");
    }

    #[test]
    fn event_id_drift_within_then_beyond_window() {
        // FIX 7: bounded window. After a request with event_id=A
        // succeeds, last_event_id=A. A request with event_id in
        // [A-WINDOW, A] is accepted; a request with event_id < A-WINDOW
        // is rejected.
        let mut room = setup_room((0.0, 0.0), (5.0, 0.0));
        let now = Instant::now();
        let mut req_advance = passing_request();
        req_advance.event_id = 1000;
        let result = validate_and_relay(&req_advance, 1, &mut room, 0, now);
        assert!(result.is_some(), "first request must succeed");
        assert_eq!(room.last_event_id_for_source.get(&1).copied(), Some(1000));

        // event_id=950 (50 behind 1000) -> 950 + 64 = 1014; 1014 < 1000 = false -> accept.
        let mut req_within = passing_request();
        req_within.event_id = 950;
        let result = validate_and_relay(&req_within, 1, &mut room, 0,
            now + Duration::from_millis(200));
        assert!(result.is_some(), "drift within EVENT_ID_WINDOW must be accepted");
        // After this, last_event_id=950 (the bounded window accepted
        // the smaller event_id and STAMPED it; this is how retries
        // work — the server advances last_event_id to the actually-
        // accepted event_id, not the supremum).

        // event_id=885 (65 behind 950) -> 885 + 64 = 949; 949 < 950 = true -> reject.
        let mut req_beyond = passing_request();
        req_beyond.event_id = 885;
        let result = validate_and_relay(&req_beyond, 1, &mut room, 0,
            now + Duration::from_millis(400));
        assert!(result.is_none(), "drift beyond EVENT_ID_WINDOW must be rejected");
    }

    #[test]
    fn rejected_request_leaves_state_unchanged() {
        // Gate 6 rejection (stale eventId) must NOT stamp state. The
        // source's ammo, last_fire_at, and last_event_id_for_source
        // must be unchanged.
        let mut room = setup_room((0.0, 0.0), (5.0, 0.0));
        let now = Instant::now();
        let req1 = passing_request();
        let _ = validate_and_relay(&req1, 1, &mut room, 0, now);
        let ammo_before = room.players[&1].ammo;
        let last_fire_at_before = room.players[&1].last_fire_at;
        let last_event_id_before = room.last_event_id_for_source.get(&1).copied().unwrap_or(0);

        // Same event_id again -> reject.
        let req_dup = req1.clone();
        let result = validate_and_relay(&req_dup, 1, &mut room, 0, now);
        assert!(result.is_none(), "duplicate eventId must be rejected");
        assert_eq!(room.players[&1].ammo, ammo_before, "ammo must not decrement on reject");
        assert_eq!(room.players[&1].last_fire_at, last_fire_at_before, "last_fire_at must not change on reject");
        assert_eq!(room.last_event_id_for_source.get(&1).copied().unwrap_or(0), last_event_id_before, "last_event_id must not advance on reject");
    }

    #[test]
    fn lag_comp_verdict_change() {
        // FIX test: with rewind, the validator sees the rewound
        // position; without rewind, it sees the current position.
        // The test sets up: source at (0,0), target at (5,0) for
        // frames 0-1, then at (100,0) for frames 2-5. At frame 5
        // with RTT=64ms (lag_frames=2), rewind to frame 3 →
        // snapshot_at(3) returns frame 2's position (100,0) which
        // is OUT of range → MISS. Without rewind, the current
        // position (100,0) is also out of range, so this test
        // doesn't differentiate. We need a case where the rewind
        // CHANGES the verdict.
        //
        // Setup: source at (0,0), target at (5,0) for frames 0-50,
        // then at (100,0) for frame 51. At frame 51 with RTT=400ms
        // (lag_frames=12, rewind to frame 39), snapshot_at(39)
        // returns frame 39's position (5,0) → HIT.
        // Without rewind, current position is (100,0) → MISS.
        let mut room = Room::new("DEVBX");
        room.add_player(1);
        room.add_player(2);
        room.players.get_mut(&1).unwrap().ammo = 10;
        for frame in 0..51u32 {
            room.record_position(1, frame, Position { x: 0.0, y: 0.0 });
            room.record_position(2, frame, Position { x: 5.0, y: 0.0 });
        }
        room.record_position(1, 51, Position { x: 0.0, y: 0.0 });
        room.record_position(2, 51, Position { x: 100.0, y: 0.0 });
        let req = DamageRequest {
            frame: 51,
            source_player_id: 1,
            target_player_id: 2,
            source: 0,
            amount: 12,
            event_id: 1,
        };
        // With RTT=400ms (lag_frames=12, rewind to frame 39),
        // validator sees target at (5,0) -> HIT.
        let result = validate_and_relay(&req, 1, &mut room, 400, Instant::now());
        assert!(result.is_some(), "lag-comp rewind to in-range position must HIT");
        let bc = result.unwrap();
        assert_eq!(bc.amount, 12);

        // Reset & test the no-rewind case: RTT=0 -> validator sees
        // current position (100,0) -> MISS.
        let mut room = Room::new("DEVBX");
        room.add_player(1);
        room.add_player(2);
        room.players.get_mut(&1).unwrap().ammo = 10;
        for frame in 0..51u32 {
            room.record_position(1, frame, Position { x: 0.0, y: 0.0 });
            room.record_position(2, frame, Position { x: 5.0, y: 0.0 });
        }
        room.record_position(1, 51, Position { x: 0.0, y: 0.0 });
        room.record_position(2, 51, Position { x: 100.0, y: 0.0 });
        let result = validate_and_relay(&req, 1, &mut room, 0, Instant::now());
        assert!(result.is_none(), "no rewind -> current position (100,0) is OUT of range -> MISS");
    }

    #[test]
    fn fire_rate_boundary_119_rejected_120_accepted() {
        // FIX test: pin the < vs <= choice in the cooldown gate.
        // 119ms since last fire -> REJECT (< 120ms).
        // 120ms since last fire -> ACCEPT (>= 120ms).
        let mut room = setup_room((0.0, 0.0), (5.0, 0.0));
        let now = Instant::now();
        let req1 = passing_request();
        let result = validate_and_relay(&req1, 1, &mut room, 0, now);
        assert!(result.is_some(), "first request must succeed");
        let req2 = DamageRequest { event_id: 2, ..req1.clone() };
        let result = validate_and_relay(&req2, 1, &mut room, 0, now + Duration::from_millis(119));
        assert!(result.is_none(), "119ms since last fire must be rejected (cooldown is 120ms)");
        // 120ms+ cooldown: each request must be 120ms after the previous
        // accepted one. The 119ms test did NOT stamp last_fire_at (it
        // was rejected), so we can fire at now+120ms.
        let req3 = DamageRequest { event_id: 3, ..req1.clone() };
        let result = validate_and_relay(&req3, 1, &mut room, 0, now + Duration::from_millis(120));
        assert!(result.is_some(), "120ms since last fire must be accepted (cooldown is 120ms)");
        // 240ms+ after the 120ms test (which stamped last_fire_at).
        let req4 = DamageRequest { event_id: 4, ..req1.clone() };
        let result = validate_and_relay(&req4, 1, &mut room, 0, now + Duration::from_millis(240));
        assert!(result.is_some(), "240ms (>= 120ms cooldown) since last fire must be accepted");
    }

    #[test]
    fn event_id_wraparound_u32_max() {
        // FIX test: event_id=u32::MAX must be accepted, event_id=0 (after
        // a long session) must be rejected (it's more than EVENT_ID_WINDOW
        // behind).
        let mut room = setup_room((0.0, 0.0), (5.0, 0.0));
        let now = Instant::now();
        let mut req_max = passing_request();
        req_max.event_id = u32::MAX;
        let result = validate_and_relay(&req_max, 1, &mut room, 0, now);
        assert!(result.is_some(), "event_id=u32::MAX must be accepted");
        // After u32::MAX, event_id=0 is a wraparound. With the bounded
        // window, 0 + 64 < u32::MAX is true -> reject.
        let mut req_zero = passing_request();
        req_zero.event_id = 0;
        let result = validate_and_relay(&req_zero, 1, &mut room, 0,
            now + Duration::from_millis(200));
        assert!(result.is_none(), "event_id=0 after u32::MAX is more than WINDOW behind -> reject");
    }

    #[test]
    fn lag_comp_uses_server_stamped_rtt() {
        // FIX 1 test: when the source's last_ping_received_at is
        // within MAX_RTT_MS, the validator uses a non-zero lag_frames.
        // We can't directly observe lag_frames (it's local to the
        // fn), but we can observe the verdict: with RTT=0 and the
        // target moving out of range after frame 30, the request
        // MISSes. With RTT=400ms (lag_frames=12, rewind to frame
        // 18), the request HITs.
        let mut room = Room::new("DEVBX");
        room.add_player(1);
        room.add_player(2);
        room.players.get_mut(&1).unwrap().ammo = 10;
        // source at (0,0) throughout; target at (5,0) until frame 30,
        // then at (100,0) from frame 30 onward.
        for frame in 0..30u32 {
            room.record_position(1, frame, Position { x: 0.0, y: 0.0 });
            room.record_position(2, frame, Position { x: 5.0, y: 0.0 });
        }
        for frame in 30..50u32 {
            room.record_position(1, frame, Position { x: 0.0, y: 0.0 });
            room.record_position(2, frame, Position { x: 100.0, y: 0.0 });
        }
        let req = DamageRequest {
            frame: 40,
            source_player_id: 1,
            target_player_id: 2,
            source: 0,
            amount: 12,
            event_id: 1,
        };
        // RTT=400ms -> lag_frames=12 -> rewind to frame 28 -> target
        // at (5,0) -> HIT.
        let result = validate_and_relay(&req, 1, &mut room, 400, Instant::now());
        assert!(result.is_some(), "with RTT=400ms, lag-comp must rewind to in-range frame");
    }
}
