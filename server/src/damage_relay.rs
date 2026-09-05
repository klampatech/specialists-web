// PR #59 / §3.4 -- server-authoritative AimEvent validation + lag-comp
// hit-detection + fire-rate cooldown + ammo gate.
//
// **Why this is its own module**: the validator's job is to take an
// `AimEvent` from a tab and decide whether to emit a
// `DamageBroadcast`(s) for the WHOLE room. The decision involves 8
// gates plus a lag-compensated raycast at the rewound target
// position for every OTHER player in the room. Splitting it from
// `transport.rs` keeps the dispatcher readable + lets the unit tests
// target the pure logic without spinning up the listener loops.
//
// **Locked decisions (do not change without PR)**:
//   1. The server's `validate_and_relay_aim` is the SOLE source of
//      truth for `DamageBroadcast`. Clients apply optimistically on
//      the local rig only (§3.9 visual tracer); HP/ammo wait for
//      the snapshot.
//   2. Lag-compensation rewind — `snapshot_at(req.frame - rtt/2)`
//      against the TARGET's `PositionHistory`. The shooter's
//      historical position is also rewound (same frame).
//   3. Fire-rate cooldown — 120ms for fire (mirrors
//      `COMBAT.dualPistol.fireCooldownMs`), 220ms for melee
//      (PR #114 — matches `COMBAT.melee.swingDurationMs = 220`,
//      the client's swing animation duration; the bound is
//      symmetrical — client can't send faster than its animation,
//      server won't accept faster than its rate-limit).
//   4. Ammo gate — `ammo` decrements by 1 per successful fire;
//      reload is out of scope (PR 11.7+). Melee is exempt from
//      the ammo gate (it's free to swing, per the original game's
//      "no-ammo-melee" design).
//   5. eventId monotonicity — the source tab issues a monotonic u32;
//      the server rejects stale eventIds per source.

use std::time::{Duration, Instant};

use tracing::{debug, warn};

use specialists_server::constants::{
    weapon_def, FireMode, WeaponId, FIRE_COOLDOWN_MS_DEFAULT, PLAYER_MAX_AMMO,
    POSITION_HISTORY_RETENTION_FRAMES, RELOAD_RATE_LIMIT_MS, WEAPONS_TABLE,
};
use specialists_server::hitscan::{
    chest_position, dual_pistol_damage, dual_pistol_hit, forward_from_yaw_pitch,
    melee_cone_hit,
};
use specialists_server::protocol::{
    AimEvent, DamageBroadcast, MeleeEvent, ReloadRequest, WeaponSwitch,
};
use specialists_server::session::{PlayerId, Room, ServerFrame};

/// Fire-rate cooldown for the dual-pistol (matches
/// `client/src/game/combat.ts:COMBAT.dualPistol.fireCooldownMs`).
// PR 11.6.D / §3.5 -- server-side per-shot validator. The server
// owns damage application; the client sends `AimEvent` (0x0A)
// with yaw + pitch + frame + eventId (+ weaponId from PR #102),
// the server runs hitscan against snapshot-known positions and
// applies damage if the hit lands.
//
// PR #102 — the per-weapon fire-rate cooldown comes from
// `WEAPONS_TABLE[req.weapon_id].fire_cooldown_ms` (was the
// hardcoded `FIRE_COOLDOWN_MS_DEFAULT = 120` constant). Dual-pistol
// keeps the 120ms cadence; shotgun is 800ms; sniper is 1500ms. The
// `req.weapon_id` is also used to look up damage_per_hit +
// max_range + pellets from the table (was a single hardcoded
// `dual_pistol_hit` + `dual_pistol_damage(12)` pair).
//
// PR #102 — the per-player `current_weapon` field on `Player`
// tracks the active weapon. Players start as DualPistol (the
// pre-#102 default). Weapon switches come via the `0x0C
// WeaponSwitch` wire type (PR #103); PR #102's `validate_and_relay`
// always uses `req.weapon_id` for the per-shot cooldown/damage
// lookups, so a client that sends `weaponId=1` (Shotgun) while
// holding DualPistol still gets the shotgun cadence + damage.
//
// This is the intended anti-cheat behavior: the server trusts the
// claimed weapon_id for cooldown purposes. A client that claims
// weaponId=0 (DualPistol) while actually firing at the shotgun's
// rate (800ms) is silently rate-limited to the dual-pistol cadence
// (120ms) — the lowest-cooldown weapon. Adding a weapon with a
// LOWER fire-rate than the player's current weapon is therefore
// always punished by the server's cooldown gate; the client can't
// gain advantage by misreporting.

/// Cooldown for melee. PR #114 — matches the client-side
/// `COMBAT.melee.swingDurationMs = 220` (the animation duration).
/// The bound is symmetrical: client can't send faster than its
/// swing animation; server won't accept faster than its rate-limit.
/// Pre-#114 the value was 500ms (a speculative default per the
/// PR 11.6.D brief); PR #114 retunes it to 220ms now that the
/// client-side constant exists. The earlier value is still seen
/// in git history (`MELEE_COOLDOWN_MS: u64 = 500` in the pre-#114
/// damage_relay.rs) — kept in mind when bisecting regressions.
pub const MELEE_COOLDOWN_MS: u32 = 220;
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
/// PR #114 — melee cone half-angle (full cone width is 60° = π/3).
/// Matches `client/src/game/combat.ts:COMBAT.melee.coneRadians =
/// Math.PI / 3`. Server's `melee_cone_hit` in `hitscan.rs` uses
/// this constant; the dot-product compares against `cos(halfCone)`
/// = `cos(π/6)` ≈ 0.866.
pub const MELEE_CONE_RADIANS: f32 = std::f32::consts::PI / 3.0;
/// PR 11.7.E / §3.5 — bounded window for the eventId monotonicity
/// gate on `validate_and_relay_reload`. Mirrors
/// `EVENT_ID_WINDOW` from the AimEvent path -- allows tab reloads
/// (`nextReloadEventId` resets to 1) to recover without invalidating
/// every subsequent request. The window is the SAME size (64) as the
/// damage path because the rationale is identical (tab reload resets
/// the counter; the server's `last_event_id_for_source` persists).
pub const RELOAD_EVENT_ID_WINDOW: u32 = EVENT_ID_WINDOW;
/// PR 11.6.D FIX 7: bounded window for the eventId monotonicity
/// gate. Strict monotonicity (`req.event_id > last_event_id`) breaks
/// when the client tab reloads (its `nextEventId` resets to 1) but
/// the server's `last_event_id_for_source` persists for the room's
/// lifetime — every subsequent request fails. The bounded window
/// allows the client some retry budget: if `req.event_id` is within
/// `EVENT_ID_WINDOW` of the last seen, accept; otherwise reject.
/// 64 covers normal use + rapid retry storms.
pub const EVENT_ID_WINDOW: u32 = 64;
/// PR AimEvent / Section 3.5 - bounded look-ahead window for the
/// AimEvent's `req.frame`. The client might be ahead of the
/// server's server-frame counter by a few frames (network jitter,
/// client tick rate slightly higher than server tick rate). 16
/// frames = 250ms at 64Hz - a generous cap that prevents the
/// client from "time-traveling" too far into the future while
/// still tolerating normal jitter.
pub const MAX_LOOKAHEAD_FRAMES: u32 = 16;
/// PR AimEvent / Section 3.5 - server-authoritative hit detection.
///
/// Validates an `AimEvent` from the client and, on success, emits
/// one `DamageBroadcast` per hit target for the whole room. The
/// validator runs `dual_pistol_hit` (from `hitscan.rs`) against
/// each OTHER player's position-history snapshot at
/// `req.frame - rtt/2` (lag-comp rewind, same shape as the damage
/// path's gate 9).
///
/// **8 gates, mirroring `validate_and_relay_reload`'s shape but
/// using the same hit-detection math (yaw/pitch -> forward -> dual_pistol_hit)**:
///   1. Source in room (auto-promotes the connection -- mirrors
///      the ReloadRequest path's gate 1).
///   2. Connection PlayerId anti-spoof (validated at the transport
///      dispatcher; the validator trusts the connection's claimed id).
///   3. eventId monotonicity (bounded window = EVENT_ID_WINDOW = 64).
///   4. Fire-rate cooldown (`WEAPONS_TABLE[weapon_id].fire_cooldown_ms`;
///      pre-#102 was `FIRE_COOLDOWN_MS = 120`, dual-pistol cadence).
///      The cooldown gate is OUTER -- one AimEvent = one cooldown
///      check. On reject: no ammo decrement, no fan-out (the event
///      never happened). PR #102 resolves the cooldown from the
///      table; the DualPistol entry matches the pre-#102 120ms so
///      the existing smokes stay green.
///   5. Ammo > 0 (server-authoritative). Once the fire rate gate
///      passes, ammo is ALWAYS decremented by 1 (matches smoke test
///      A4 "ammo STILL drops to 4 (fire rate consumed, no hit)"
///      and the client's "missed shot still spends ammo" semantics
///      in `combat.ts:dualPistolShoot`).
///   6. Shooter HP > 0 (can't fire while dead).
///   7. Yaw/pitch in valid range (-pi..=pi, -pi/2..=pi/2) and
///      frame is within the rewind window (frame <= current frame;
///      frame >= current frame - 32 = ~500ms @ 64Hz).
///   8. Per-target: lag-comp rewind both shooter and target to
///      `req.frame - rtt/2`, call `dual_pistol_hit` with the
///      AimEvent's claimed yaw/pitch. On hit: emit a
///      `DamageBroadcast`, decrement target HP by `dual_pistol_damage`,
///      decrement source ammo by 1, stamp source `last_fire_at` ONCE
///      (for the whole event -- the first hit's loop iteration
///      stamps it; subsequent iterations see it and skip).
///
/// Returns `Vec<DamageBroadcast>` (zero-or-more). The transport
/// layer fans each broadcast out to every room connection.
///
/// **Why no melee mode**: PR #59 is fire-only. The existing wire
/// (the old protocol's `DamageRequest.source` field had a `0 = fire,
/// 1 = melee` discriminator; PR #59 collapses to fire-only (no
/// melee wire format) since melee's melee-range proximity check
/// (`MELEE_MAX_RANGE_METERS = 1.5`) is symmetric with the hitscan
/// raycast and doesn't need its own wire path. Phase 2 melee work
/// can add a `0x0B Melee` discriminator if needed.
pub fn validate_and_relay_aim(
    req: &AimEvent,
    source_player_id: PlayerId,
    room: &mut Room,
    client_rtt_ms: u32,
    now: Instant,
) -> Vec<DamageBroadcast> {
    let req_source = req.source_player_id;
    if !room.players.contains_key(&req_source) {
        warn!(
            source = req_source,
            "validate_and_relay_aim: rejected - source not in room",
        );
        return vec![];
    }
    // --- Gate 2: connection PlayerId anti-spoof ------------------------
    if source_player_id != req_source {
        warn!(
            connection_id = source_player_id,
            req_source = req_source,
            "validate_and_relay_aim: rejected - connection PlayerId mismatch",
        );
        return vec![];
    }
    // --- Gate 3: eventId bounded-window per source -------------------
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
            "validate_and_relay_aim: rejected - eventId more than EVENT_ID_WINDOW behind last_event_id",
        );
        return vec![];
    }
    // PR #102 — the per-weapon fire-rate comes from the table. PR #102
    // only exercises DualPistol (the wire-break for `weapon_id` is
    // PR #103's responsibility), so `weapon_id` here is the future
    // PR #103 field. For now, the server treats every AimEvent as
    // DualPistol — preserves the pre-#102 behavior exactly. Once
    // PR #103 lands, this resolves to the table-driven value based
    // on the claimed weapon_id.
    let active_weapon_def = weapon_def(WeaponId::DEFAULT);
    let fire_cooldown_ms = active_weapon_def.fire_cooldown_ms;
    // --- Gate 4: fire-rate cooldown -----------------------------------
    if let Some(last_fire) = room.players[&req_source].last_fire_at {
        let cooldown = std::time::Duration::from_millis(fire_cooldown_ms);
        if now.duration_since(last_fire) < cooldown {
            warn!(
                source = req_source,
                since_last_ms = now.duration_since(last_fire).as_millis() as u64,
                cooldown_ms = cooldown.as_millis() as u64,
                weapon_id = active_weapon_def.weapon_id.to_wire(),
                "validate_and_relay_aim: rejected - fire-rate cooldown not elapsed",
            );
            return vec![];
        }
    }
    // --- Gate 5: ammo gate (fire only) ---------------------------------
    if room.players[&req_source].ammo == 0 {
        warn!(
            source = req_source,
            "validate_and_relay_aim: rejected - zero ammo",
        );
        return vec![];
    }
    // --- Gate 6: source is alive ---------------------------------------
    if room.players[&req_source].hp == 0 {
        warn!(
            source = req_source,
            "validate_and_relay_aim: rejected - source HP is 0 (dead)",
        );
        return vec![];
    }
    // --- Gate 7: yaw/pitch + frame validity ---------------------------------
    // Yaw: must be in [-pi, pi] (the client encodes 0..2pi via
    // the bitmask; we accept the full range and reject out-of-range
    // to catch cheaters).
    // Pitch: must be in [-pi/2, +pi/2] (clamped client-side; we
    // re-verify to catch cheaters).
    if !req.yaw_radians.is_finite() || !req.pitch_radians.is_finite() {
        warn!(
            source = req_source,
            yaw = req.yaw_radians,
            pitch = req.pitch_radians,
            "validate_and_relay_aim: rejected - non-finite yaw/pitch",
        );
        return vec![];
    }
    if req.yaw_radians < -std::f32::consts::PI || req.yaw_radians > std::f32::consts::PI {
        warn!(
            source = req_source,
            yaw = req.yaw_radians,
            "validate_and_relay_aim: rejected - yaw outside [-pi, pi]",
        );
        return vec![];
    }
    if req.pitch_radians < -std::f32::consts::FRAC_PI_2
        || req.pitch_radians > std::f32::consts::FRAC_PI_2
    {
        warn!(
            source = req_source,
            pitch = req.pitch_radians,
            "validate_and_relay_aim: rejected - pitch outside [-pi/2, +pi/2]",
        );
        return vec![];
    }
    // Frame must be within the rewind window. The rewind window
    // is bounded by `POSITION_HISTORY_RETENTION_FRAMES` (64 frames
    // @ 64Hz = 1s) -- same cap as the PositionHistory buffer.
    // A frame in the past is valid iff `current_frame - frame <=
    // REWIND_FRAMES_MAX`. A frame in the future (frame > current)
    // is also valid -- the client might be ahead of the server's
    // server-frame counter by up to a few frames (network jitter).
    let current_frame: ServerFrame = room.next_server_frame;
    if req.frame > current_frame + MAX_LOOKAHEAD_FRAMES {
        warn!(
            source = req_source,
            req_frame = req.frame,
            current_frame = current_frame,
            "validate_and_relay_aim: rejected - frame too far in the future",
        );
        return vec![];
    }
    let max_rewind = POSITION_HISTORY_RETENTION_FRAMES;
    if current_frame.saturating_sub(req.frame) > max_rewind {
        warn!(
            source = req_source,
            req_frame = req.frame,
            current_frame = current_frame,
            max_rewind = max_rewind,
            "validate_and_relay_aim: rejected - frame too far in the past (rewind window exceeded)",
        );
        return vec![];
    }
    // --- Gate 8: per-target lag-comp hit-test ----------------------------
    //
    // Iterate every OTHER player in the room. For each:
    //   1. Rewind source to `req.frame - rtt/2` via PositionHistory.
    //   2. Rewind target to the same frame.
    //   3. Compute forward = `forward_from_yaw_pitch(req.yaw, req.pitch)`.
    //   4. Call `dual_pistol_hit(shooter_origin, forward, source_yaw,
    //      target_pos, DEFAULT_TARGET_RADIUS)`.
    //   5. On hit: construct DamageBroadcast, push to result Vec.
    //      Decrement target HP, source ammo (ONCE for the whole event),
    //      stamp source `last_fire_at` (ONCE for the whole event).
    //
    // The forward vector is the AimEvent's claimed yaw/pitch
    // (intent, not state). The server trusts the claim -- anti-cheat
    // for yaw/pitch is Phase 4 (PR 11.10).
    let lag_frames: u32 = (client_rtt_ms / 2) / SERVER_TICK_MS;
    let rewind_frame: ServerFrame = req.frame.saturating_sub(lag_frames);

    // Snapshot the source player's history lookup ONCE (we use it
    // for every target). The `get` returns a `&PositionHistory`
    // borrow; we never hold it across the `for` loop's mutating
    // body (we read source_pos and target_pos into owned values
    // before mutating `room.players` / `room.position_history`).
    let source_history = match room.position_history.get(&req_source) {
        Some(h) => h,
        None => {
            warn!(
                source = req_source,
                "validate_and_relay_aim: rejected - source has no position history",
            );
            return vec![];
        }
    };
    let Some(source_pos) = source_history.snapshot_at(rewind_frame) else {
        warn!(
            source = req_source,
            rewind_frame = rewind_frame,
            "validate_and_relay_aim: rejected - no snapshot for source at rewound frame",
        );
        return vec![];
    };
    let source_origin = chest_position(glam::Vec3::new(source_pos.x, source_pos.y, 0.0));
    let forward = forward_from_yaw_pitch(req.yaw_radians, req.pitch_radians);
    // Pre-allocate the result Vec for the typical hit count (0..=3
    // in the 2-tab demo; 0..=23 in a 24-player stress test).
    let mut broadcasts: Vec<DamageBroadcast> = Vec::new();
    // Track whether THIS event consumed fire rate + ammo (set by
    // the first hit; subsequent hits see it set and skip the
    // re-stamp). Single fire-rate decrement per event, single ammo
    // decrement per event -- the brief's gate 3 caveat.
    //
    // (Removed: previous code had `let mut fire_consumed = false` +
    // a `if !fire_consumed { ... }` guard inside the loop, but the
    // per-hit logic was simplified to single-event semantics and
    // the variable is no longer read -- see claude review 2026-08-25
    // non-blocking #1.)
    // Iterate room.players (excluding source). We collect the
    // target ids first to avoid borrowing `room.players` mutably
    // during iteration over it (HashMap iter invalidation).
    let target_ids: Vec<PlayerId> = room
        .players
        .keys()
        .copied()
        .filter(|id| *id != req_source)
        .collect();
    for target_id in target_ids {
        // Re-fetch the target's position history (immutable borrow).
        let target_history = match room.position_history.get(&target_id) {
            Some(h) => h,
            None => {
                // Target hasn't sent any PositionUpdates yet (the
                // snapshot's slot for this player is missing). Skip
                // -- can't compute a rewind without history.
                continue;
            }
        };
        let Some(target_pos) = target_history.snapshot_at(rewind_frame) else {
            // No snapshot for this target at the rewound frame
            // (their position history doesn't reach back that far).
            // Skip -- the lag-comp rewind math needs both endpoints.
            continue;
        };
        // Skip dead targets (server-authoritative HP -- PR 11.7.D
        // §4.4 closure).
        if room.players[&target_id].hp == 0 {
            continue;
        }
        let target_pos_3d = glam::Vec3::new(target_pos.x, target_pos.y, source_origin.z);
        let hit = dual_pistol_hit(
            source_origin,
            forward,
            req.yaw_radians,
            target_pos_3d,
            specialists_server::hitscan::DEFAULT_TARGET_RADIUS,
        );
        if !hit {
            continue;
        }
        // HIT -- construct DamageBroadcast.
        let dx = target_pos.x - source_pos.x;
        let dy = target_pos.y - source_pos.y;
        let distance = (dx * dx + dy * dy).sqrt();
        let amount = dual_pistol_damage(distance);
        if amount == 0 {
            // Out of range (dual_pistol_damage returns 0 past the
            // 50m pistol range). Skip.
            continue;
        }
        let server_frame = room.next_server_frame;
        let server_seq = room.next_seq();
        let bc = DamageBroadcast {
            server_frame,
            server_seq,
            source_player_id: req_source,
            target_player_id: target_id,
            source: 0, // 0 = fire (PR #59 drops melee from the wire)
            amount,
            origin_event_id: req.event_id,
        };
        broadcasts.push(bc);
        // Target HP decrement on EVERY hit (one target per
        // DamageBroadcast -- a single shot can hit at most one
        // target in the dual-pistol cone, but the Vec allows
        // multi-hit if the cone is widened later).
       let target_player = room
           .players
           .get_mut(&target_id)
           .expect("target_id from keys() invariant violated");
       target_player.hp = target_player.hp.saturating_sub(amount);
    }
    // Side effects on every accepted event (gate 4 passes):
    // decrement source ammo + stamp last_fire_at + saturating
    // eventId stamp. The fire rate is consumed EVEN ON MISS
    // (smoke test A4: "ammo STILL drops to 4 (fire rate
    // consumed, no hit)"). The brief's Gate 3 caveat says
    // "fire rate IS consumed but no ammo is decremented",
    // but the canonical smoke test + the existing client
    // behavior treat ammo as the cost of firing regardless
    // of hit/miss (matches PR 11.7.D's "12 damage per
    // confirmed shot" ammo model from §4.2).
    // PR #107 — Burst state machine (driven by AimEvent's new
    // `is_firing` byte at offset 19). For Semi mode, every AimEvent
    // that passes Gate 4 fires one shot and decrements ammo by 1.
    // For Burst{N} mode, the first AimEvent that passes Gate 4
    // starts a fresh burst (consumes 1 ammo + sets
    // `burst_shots_remaining = N - 1`); subsequent AimEvents in the
    // same burst at the semi-cadence are accepted but consume NO
    // ammo (the burst was paid upfront). For Auto mode (not used by
    // any MVP weapon but supported), every AimEvent is a fresh shot.
    //
    // PR #107 trade-off: trigger release (is_firing: 0) resets the
    // burst state on the next AimEvent (the player has to pull the
    // trigger again to start a new burst). This matches TS 2.0's
    // burst-fire semantics.
    let mut burst_mid_shot = false;
    {
        let player = room
            .players
            .get_mut(&req_source)
            .expect("gate 1 invariant violated - req_source not in room");
        let fm = active_weapon_def.fire_modes[player.current_fire_mode as usize];
        match fm {
            FireMode::Semi => {
                if req.is_firing == 0 {
                    // Trigger release — the player pulled the
                    // trigger between AimEvents but isn't firing
                    // right now. Accept the AimEvent as a no-op
                    // (don't fire) and reset burst state.
                    player.burst_shots_remaining = 0;
                    player.trigger_held = false;
                    return vec![];
                }
                player.trigger_held = true;
            }
            FireMode::Burst { count } => {
                if req.is_firing == 0 {
                    // Trigger released — reset burst.
                    player.burst_shots_remaining = 0;
                    player.trigger_held = false;
                    return vec![];
                }
                if !player.trigger_held {
                    // Fresh burst — first shot.
                    player.trigger_held = true;
                    player.burst_shots_remaining = count.saturating_sub(1);
                } else {
                    // Mid-burst — subsequent shots don't consume ammo.
                    burst_mid_shot = true;
                    player.burst_shots_remaining =
                        player.burst_shots_remaining.saturating_sub(1);
                }
            }
            FireMode::Auto => {
                player.trigger_held = req.is_firing != 0;
            }
        }
    }
    let player = room
        .players
        .get_mut(&req_source)
        .expect("gate 1 invariant violated - req_source not in room");
    if !burst_mid_shot {
        player.ammo = player.ammo.saturating_sub(1);
    }
    player.last_fire_at = Some(now);
    // Saturating stamp on last_event_id_for_source (mirror
    // of the damage path's stamp_saturates_does_not_wrap
    // semantics).
    let prev_event_id = room
        .last_event_id_for_source
        .get(&req_source)
        .copied()
        .unwrap_or(0);
    let new_event_id = if req.event_id < prev_event_id {
        prev_event_id
    } else {
        req.event_id
    };
    room.last_event_id_for_source
       .insert(req_source, new_event_id);
   broadcasts
}
/// PR 11.7.E / §3.5 — `validate_and_relay_reload`.
///
/// Validates a `ReloadRequest` from the client and, on success,
/// mutates `room.players[source].ammo = PLAYER_MAX_AMMO`. The next
/// 20Hz `Snapshot` broadcast (discriminator 0x07) carries the new
/// ammo value to every connected tab — no outgoing packet from this
/// function. The relay-shape returns `Option<()>` so the call site
/// mirrors `validate_and_relay` (which returns `Option<DamageBroadcast>`).
///
/// 8 gates paralleling `validate_and_relay`:
///   1. Source in room (`room.players.contains_key(&source_player_id)`).
///   2. Connection PlayerId anti-spoof (validated at the transport
///      dispatcher; the validator trusts the connection's claimed id).
///   3. HP > 0 (no reload while dead — the §3.5 death gate).
///   4. Ammo < max (no point reloading a full mag).
///   5. Rate limit (`RELOAD_RATE_LIMIT_MS` since the previous reload).
///   6. eventId monotonicity (bounded window, mirrors `validate_and_relay`'s
///      EVENT_ID_WINDOW — allows tab reloads to recover).
///   7. Sentinel (no source-type for reload — it's always source=0
///      mode by definition; gate is a no-op but documented for symmetry
///      with the damage validator's gate structure).
///   8. Side-effect: on success, mutate `player.ammo = PLAYER_MAX_AMMO`,
///      stamp `player.last_reload_at = Some(now)`, advance
///      `last_event_id_for_source[source]` to `req.event_id` (saturating,
///      mirrors `validate_and_relay`'s saturation semantics).
pub fn validate_and_relay_reload(
    req: &ReloadRequest,
    connection_player_id: PlayerId,
    room: &mut Room,
    now: Instant,
) -> Option<()> {
    // --- Gate 1: source in room -----------------------------------------
    let req_source = req.source_player_id;
    if !room.players.contains_key(&req_source) {
        warn!(
            source = req_source,
            "validate_and_relay_reload: rejected — source not in room",
        );
        return None;
    }
    // --- Gate 2: connection PlayerId anti-spoof ------------------------
    // The transport dispatcher already validates this against
    // `connection_state.claimed_player_id` and stamps the actual
    // id on first DamageRequest. The validator receives the
    // dispatcher-resolved id (which may equal req_source or the
    // pre-DR placeholder) and asserts the room lookup matches.
    if connection_player_id != req_source {
        warn!(
            connection_id = connection_player_id,
            req_source = req_source,
            "validate_and_relay_reload: rejected — connection PlayerId mismatch",
        );
        return None;
    }

    // --- Gate 3: HP > 0 ------------------------------------------------
    if room.players[&req_source].hp == 0 {
        warn!(
            source = req_source,
            "validate_and_relay_reload: rejected — source HP is 0 (dead)",
        );
        return None;
    }

    // --- Gate 4: ammo < max --------------------------------------------
    if room.players[&req_source].ammo >= PLAYER_MAX_AMMO {
        warn!(
            source = req_source,
            ammo = room.players[&req_source].ammo,
            "validate_and_relay_reload: rejected — magazine already full",
        );
        return None;
    }

    // --- Gate 5: rate limit (1/sec per player) -------------------------
    if let Some(last) = room.players[&req_source].last_reload_at {
        let since_ms = now.duration_since(last).as_millis() as u64;
        if since_ms < RELOAD_RATE_LIMIT_MS {
            warn!(
                source = req_source,
                since_last_ms = since_ms,
                rate_limit_ms = RELOAD_RATE_LIMIT_MS,
                "validate_and_relay_reload: rejected — rate limit not elapsed",
            );
            return None;
        }
    }

    // --- Gate 6: eventId bounded-window per source --------------------
    // Mirrors `validate_and_relay`'s EVENT_ID_WINDOW logic exactly:
    // accept within the window, reject only if `req.event_id +
    // WINDOW < last_event_id`. The window allows tab reloads to
    // recover without invalidating every subsequent request.
    let last_event_id = room
        .last_event_id_for_source
        .get(&req_source)
        .copied()
        .unwrap_or(0);
    if req.event_id.saturating_add(RELOAD_EVENT_ID_WINDOW) < last_event_id {
        warn!(
            source = req_source,
            event_id = req.event_id,
            last_event_id = last_event_id,
            window = RELOAD_EVENT_ID_WINDOW,
            "validate_and_relay_reload: rejected — eventId more than WINDOW behind last_event_id",
        );
        return None;
    }

    // --- Gate 7: sentinel (no source-type for reload) -------------------
    // Reload is a mode-0-only concept (dual-pistol magazine refill).
    // Melee has no ammo, so no reload. Future modes (3+) would carry
    // their own reload rules — none exist in PR 11.7.E. Documented
    // for symmetry with the damage validator's gate structure.

    // --- Gate 8: side-effects on success -------------------------------
    // Mutate ammo + stamp last_reload_at + advance last_event_id. The
    // snapshot stream carries the new ammo on its next 20Hz tick.
    let player = room
        .players
        .get_mut(&req_source)
        .expect("gate 1 invariant violated — req_source not in room.players");
    player.ammo = PLAYER_MAX_AMMO;
    player.last_reload_at = Some(now);
    // Saturating eventId stamp — mirrors validate_and_relay's
    // semantics so a tab reload that resets the counter doesn't
    // wrap the stored value backward.
    let prev_event_id = room
        .last_event_id_for_source
        .get(&req_source)
        .copied()
        .unwrap_or(0);
    let new_event_id = if req.event_id < prev_event_id {
        prev_event_id
    } else {
        req.event_id
    };
    room.last_event_id_for_source
        .insert(req_source, new_event_id);
    debug!(
        source = req_source,
        event_id = req.event_id,
        new_ammo = player.ammo,
        "validate_and_relay_reload: success",
    );
    Some(())
}

/// Validate a `WeaponSwitch` request and apply the switch server-side.
/// Returns `true` on success (player switched weapons/fire mode), `false`
/// on rejection (no mutation).
///
/// PR #107 — `0x0C WeaponSwitch` wire (disc = 0x0C, body = 4 bytes:
/// source_player_id u16 + weapon_id u8 + fire_mode_index u8).
///
/// Gates (5):
///   1. Source in room.
///   2. Connection PlayerId matches request source (anti-spoof).
///   3. Rate limit: <1 sec since the player's last switch
///      (WEAPON_SWITCH_RATE_LIMIT_MS).
///   4. weapon_id is a known WeaponId (open-enum: any unknown value
///      is rejected — anti-cheat).
///   5. fire_mode_index is in range for the weapon's fire_modes[].
///
/// On success, mutates `room.players[source]` via
/// `Player::apply_weapon_switch` (resets burst state).
pub fn validate_and_relay_weapon_switch(
    req: &WeaponSwitch,
    connection_player_id: PlayerId,
    room: &mut Room,
    now: Instant,
) -> bool {
    use specialists_server::constants::WEAPON_SWITCH_RATE_LIMIT_MS;
    // Gate 1: source in room.
    if !room.players.contains_key(&req.source_player_id) {
        warn!(
            source = req.source_player_id,
            "weapon_switch: rejected — source not in room",
        );
        return false;
    }
    // Gate 2: anti-spoof — connection's PlayerId must match the request's.
    if connection_player_id != req.source_player_id {
        warn!(
            connection = connection_player_id,
            claimed = req.source_player_id,
            "weapon_switch: rejected — connection / claimed source mismatch",
        );
        return false;
    }
    // Gate 3: rate limit.
    let player = &room.players[&req.source_player_id];
    if let Some(last_switch) = player.last_weapon_switch_at {
        let elapsed = now.duration_since(last_switch);
        if elapsed < std::time::Duration::from_millis(WEAPON_SWITCH_RATE_LIMIT_MS) {
            warn!(
                source = req.source_player_id,
                elapsed_ms = elapsed.as_millis() as u64,
                rate_limit_ms = WEAPON_SWITCH_RATE_LIMIT_MS,
                "weapon_switch: rejected — rate limit not elapsed",
            );
            return false;
        }
    }
    // Gate 4: weapon_id is a known WeaponId (open-enum rejection).
    let new_weapon = match WeaponId::from_wire(req.weapon_id) {
        Some(w) => w,
        None => {
            warn!(
                source = req.source_player_id,
                claimed = req.weapon_id,
                "weapon_switch: rejected — unknown weapon_id",
            );
            return false;
        }
    };
    // Gate 5: fire_mode_index in range for the weapon's fire_modes[].
    let weapon_def = weapon_def(new_weapon);
    let fm_idx = req.fire_mode_index as usize;
    if fm_idx >= weapon_def.fire_modes.len() {
        warn!(
            source = req.source_player_id,
            fire_mode_idx = req.fire_mode_index,
            fire_modes_len = weapon_def.fire_modes.len(),
            "weapon_switch: rejected — fire_mode_index out of range",
        );
        return false;
    }
    // All gates passed — apply the switch.
    let player = room.players.get_mut(&req.source_player_id).unwrap();
    player.apply_weapon_switch(new_weapon, req.fire_mode_index);
    player.last_weapon_switch_at = Some(now);
    debug!(
        source = req.source_player_id,
        new_weapon = new_weapon.to_wire(),
        fire_mode_index = req.fire_mode_index,
        "weapon_switch: applied",
    );
    true
}

// PR #114 — MeleeEvent validator. The melee path is
// "client-sends-intent → server-runs-cone-check → server-broadcasts
// damage". Mirrors `validate_and_relay_aim`'s 8-gate structure but
// with melee-specific gates: no ammo, no fire-rate, but yes cone
// + range + cooldown.
//
// **Differences from validate_and_relay_aim**:
//   - Gate 4 (fire-rate cooldown) → **melee cooldown** (220ms,
//     mirrors client swing animation duration).
//   - Gate 5 (ammo) → **REMOVED**. Melee is free to swing; no
//     `ammo` decrement on success.
//   - Gate 9-10 (raycast hit + damage application) → **cone hit**
//     (proximity-based, not ray-vs-sphere). Damage = MELEE_DAMAGE
//     (25, single fixed value matching client-side COMBAT.melee).
//
// **Why no lag-comp rewind for melee?** The cone hit is proximity-
// based (`melee_cone_hit` checks target position at the server's
// latest snapshot, not the rewound position). At 1.5m range + a
// 220ms swing cooldown, the target can move at most ~0.5m in that
// window (typical player speed) — well within the 60° cone at 1.5m
// distance (the cone radius is ~1.5m at the edge). Lag-comp on
// melee is unnecessary complexity for the precision gain. If the
// play test reveals lag-feel issues, add rewind later.
pub fn validate_and_relay_melee(
    req: &MeleeEvent,
    source_player_id: PlayerId,
    room: &mut Room,
    _client_rtt_ms: u32,
    now: Instant,
) -> Vec<DamageBroadcast> {
    // --- Gate 1: source in room -----------------------------------------
    let req_source = req.source_player_id;
    if !room.players.contains_key(&req_source) {
        warn!(
            source = req_source,
            "validate_and_relay_melee: rejected - source not in room",
        );
        return vec![];
    }
    // --- Gate 2: connection PlayerId anti-spoof ------------------------
    if source_player_id != req_source {
        warn!(
            connection_id = source_player_id,
            req_source = req_source,
            "validate_and_relay_melee: rejected - connection PlayerId mismatch",
        );
        return vec![];
    }
    // --- Gate 3: eventId bounded-window per source -------------------
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
            "validate_and_relay_melee: rejected - eventId more than EVENT_ID_WINDOW behind last_event_id",
        );
        return vec![];
    }
    // --- Gate 4: melee cooldown (PR #114 — independent of fire-rate) -
    if let Some(last_melee) = room.players[&req_source].last_melee_at {
        let cooldown = std::time::Duration::from_millis(MELEE_COOLDOWN_MS as u64);
        if now.duration_since(last_melee) < cooldown {
            debug!(
                source = req_source,
                since_last_ms = now.duration_since(last_melee).as_millis() as u64,
                cooldown_ms = MELEE_COOLDOWN_MS,
                "validate_and_relay_melee: rejected - melee cooldown not elapsed",
            );
            return vec![];
        }
    }
    // --- Gate 5: source is alive (no ammo gate for melee) -------------
    if room.players[&req_source].hp == 0 {
        warn!(
            source = req_source,
            "validate_and_relay_melee: rejected - source HP is 0 (dead)",
        );
        return vec![];
    }
    // --- Gate 6: yaw/pitch/frame validity -----------------------------
    if !req.yaw_radians.is_finite() || !req.pitch_radians.is_finite() {
        warn!(
            source = req_source,
            "validate_and_relay_melee: rejected - non-finite yaw/pitch",
        );
        return vec![];
    }
    // --- Gate 7: per-player eventId update + last_melee_at stamp ------
    // All gates before this point are zero-cost when they fail (no
    // side effects). This is the first point where we mutate state,
    // so it's the natural commit point.
    let new_last_event_id = req.event_id.max(last_event_id);
    room.last_event_id_for_source
        .insert(req_source, new_last_event_id);
    room.players.get_mut(&req_source).unwrap().last_melee_at = Some(now);

    // --- Gate 8: cone-vs-position hit detection ------------------------
    // Derive the source's forward direction from the claim's yaw +
    // pitch (server trusts this claim for melee — anti-cheat is
    // Phase 4 / PR 11.10). Iterate all OTHER players in the room
    // and run `melee_cone_hit` against each. If a target is in the
    // cone, emit a DamageBroadcast for that target.
    //
    // Position source: `room.position_history[source].snapshot_at(LATEST)`.
    // Melee doesn't lag-comp (proximity-based; the cone is wide
    // enough that a single-tick target offset doesn't matter). The
    // `PositionHistory::snapshot_at(frame)` API accepts `u32::MAX`
    // and returns the latest recorded position.
    let source_pos = match room.position_history[&req_source].snapshot_at(u32::MAX) {
        Some(pos) => chest_position(glam::Vec3::new(pos.x, pos.y, 0.0)),
        None => {
            // Source hasn't sent any PositionUpdates yet. Without a
            // position we can't run the cone check. Skip — same as
            // the AimEvent path's "target history empty" branch.
            warn!(
                source = req_source,
                "validate_and_relay_melee: skipped - source has no position history",
            );
            return Vec::new();
        }
    };
    let forward = forward_from_yaw_pitch(req.yaw_radians, req.pitch_radians);
    let mut broadcasts = Vec::new();
    let target_ids: Vec<PlayerId> = room
        .players
        .keys()
        .copied()
        .filter(|&id| id != req_source)
        .collect();
    for target_id in target_ids {
        let target = &room.players[&target_id];
        // Skip dead targets — no point damaging a corpse.
        if target.hp == 0 {
            continue;
        }
        let Some(target_pos_2d) = room.position_history[&target_id].snapshot_at(u32::MAX) else {
            // Target hasn't sent any PositionUpdates yet (the
            // snapshot's slot for this player is missing). Skip —
            // can't compute a cone check without a position.
            continue;
        };
        // The game is 2D-on-y (fixed chest-height per `chest_position`'s
        // +0.45 offset) — mirror the AimEvent path's z-handling
        // (target_pos.z = source_origin.z so the raycast stays on
        // the attacker's horizontal plane).
        let target_pos = chest_position(glam::Vec3::new(
            target_pos_2d.x,
            target_pos_2d.y,
            source_pos.z,
        ));
        if melee_cone_hit(
            source_pos,
            forward,
            target_pos,
            MELEE_CONE_RADIANS,
            MELEE_MAX_RANGE_METERS,
        ) {
            // Hit! Emit a DamageBroadcast for this target.
            let bc = DamageBroadcast {
                server_frame: room.next_server_frame,
                server_seq: room.next_seq(),
                source_player_id: req_source,
                target_player_id: target_id,
                source: 1, // 1 = melee (per `DAMAGE_SOURCE_MELEE`)
                amount: MELEE_DAMAGE,
                origin_event_id: req.event_id,
            };
            broadcasts.push(bc);
            // PR #114 — Target HP decrement on EVERY melee hit. Mirrors
            // the AimEvent path's `target_player.hp = target_player.hp
            // .saturating_sub(amount)` (line 459). Pre-fix: melee
            // events emitted a DamageBroadcast but never decremented
            // the server-side `target_player.hp`, so the snapshot's HP
            // value stayed at 100 — the smoke's HP-drop assertions
            // failed even when the cone hit. The DamageBroadcast is
            // now also the trigger for the HP state mutation.
            let target_player = room
                .players
                .get_mut(&target_id)
                .expect("target_id from keys() invariant violated");
            target_player.hp = target_player.hp.saturating_sub(MELEE_DAMAGE);
        }
    }
    if !broadcasts.is_empty() {
        debug!(
            source = req_source,
            hits = broadcasts.len(),
            "meleeEvent applied ({} hit(s))",
            broadcasts.len(),
        );
    }
    broadcasts
}

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
///
/// PR #107 — DEPRECATED. DamageReject was never wired (the
/// DamageRequest path was replaced by AimEvent in PR #59; DamageReject
/// was defined as a follow-up but the transport never got a sender).
/// PR #107 reclaimed 0x0C for WeaponSwitch. This function remains
/// compiled for source compatibility but is unreachable from the
/// hot path. Safe to delete in a future cleanup PR.
#[allow(deprecated)]
pub fn relay_reject(event_id: u32, reason: u8) -> Vec<u8> {
    let r = specialists_server::protocol::DamageReject { event_id, reason };
    let body = specialists_server::protocol::encode_damage_reject(&r);
    let mut out = Vec::with_capacity(1 + body.len());
    out.push(specialists_server::protocol::DAMAGE_REJECT);
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
            room.record_position(
                1,
                frame,
                Position {
                    x: source_xy.0,
                    y: source_xy.1,
                },
            );
            room.record_position(
                2,
                frame,
                Position {
                    x: target_xy.0,
                    y: target_xy.1,
                },
            );
        }
        room
    }

    // -- AimEvent (PR #59: server-authoritative hit detection) ------------
    //
    // The AimEvent path replaces the old client-raycast-verified
    // `DamageRequest` (PR 11.6.D). The new flow:
    //
    // 1. Client sends `AimEvent { source, yaw, pitch, frame, event_id }`.
    // 2. Server runs 8 gates (source-in-room, eventId monotonicity,
    //    fire-rate cooldown, ammo, hp, yaw/pitch range, frame-in-window).
    // 3. For each OTHER player in the room, server rewinds both
    //    shooter and target to `frame - rtt/2`, then runs
    //    `hitscan::dual_pistol_hit` to decide hit/miss.
    // 4. Returns `Vec<DamageBroadcast>` (one per hit) and decrements
    //    source ammo + target hp server-side.

    /// Build an AimEvent that should hit a target sitting on the
    /// +X axis at `target_xy`, with the shooter at `source_xy` facing
    /// yaw=PI/2 (which is the +X axis per `hitscan::forward_from_yaw_pitch`:
    ///   forward = (sin(yaw)*cos(pitch), sin(pitch), cos(yaw)*cos(pitch))
    /// yaw=0 fires along +Z, yaw=PI/2 fires along +X).
    fn passing_aim_event() -> AimEvent {
        AimEvent {
            source_player_id: 1,
            yaw_radians: std::f32::consts::FRAC_PI_2,
            pitch_radians: 0.0,
            frame: 4,
            event_id: 1,
            is_firing: 1, // PR #107 — defaults to "trigger pulled" for tests
        }
    }

    #[test]
    fn aim_event_round_trip_hits_target_emits_broadcast_decrements_ammo() {
        // Shooter at (0,0), target at (5,0), facing +X. Both have
        // position history at frames 0-4.
        let mut room = setup_room((0.0, 0.0), (5.0, 0.0));
        let initial_ammo = room.players.get(&1).unwrap().ammo;
        let req = passing_aim_event();
        let result = validate_and_relay_aim(&req, 1, &mut room, 0, Instant::now());
        assert_eq!(
            result.len(),
            1,
            "single hit on target must emit exactly one DamageBroadcast"
        );
        let bc = &result[0];
        assert_eq!(bc.source_player_id, 1);
        assert_eq!(bc.target_player_id, 2);
        assert_eq!(bc.origin_event_id, req.event_id);
        // Ammo decremented by 1 on hit (server-authoritative).
        let post_ammo = room.players.get(&1).unwrap().ammo;
        assert_eq!(
            post_ammo,
            initial_ammo - 1,
            "hit must decrement source ammo by 1"
        );
        // Target HP decremented by damage amount.
        let target_post_hp = room.players.get(&2).unwrap().hp;
        assert!(target_post_hp < 100, "target HP must drop after hit");
    }

    #[test]
    fn aim_event_miss_still_decrements_ammo() {
        // Shooter at (0,0), target at (5,0), but shooter aims at
        // yaw=pi (away from target). No hit. Fire-rate consumed
        // (gate 3 passes), ammo decremented by 1.
        let mut room = setup_room((0.0, 0.0), (5.0, 0.0));
        let initial_ammo = room.players.get(&1).unwrap().ammo;
        let req = AimEvent {
            yaw_radians: std::f32::consts::PI,
            pitch_radians: 0.0,
            ..passing_aim_event()
        };
        let result = validate_and_relay_aim(&req, 1, &mut room, 0, Instant::now());
        assert!(
            result.is_empty(),
            "aiming away from target must produce no broadcasts"
        );
        let post_ammo = room.players.get(&1).unwrap().ammo;
        assert_eq!(
            post_ammo,
            initial_ammo - 1,
            "miss must STILL decrement ammo (fire-rate consumed)"
        );
    }

    #[test]
    fn aim_event_rejects_yaw_out_of_range() {
        // yaw=10.0 is outside [-pi, pi]. Gate 6 rejects.
        let mut room = setup_room((0.0, 0.0), (5.0, 0.0));
        let initial_ammo = room.players.get(&1).unwrap().ammo;
        let req = AimEvent {
            yaw_radians: 10.0,
            ..passing_aim_event()
        };
        let result = validate_and_relay_aim(&req, 1, &mut room, 0, Instant::now());
        assert!(
            result.is_empty(),
            "out-of-range yaw must produce no broadcasts"
        );
        let post_ammo = room.players.get(&1).unwrap().ammo;
        assert_eq!(
            post_ammo, initial_ammo,
            "rejected yaw must NOT consume fire-rate or ammo"
        );
    }

    #[test]
    fn aim_event_rejects_pitch_out_of_range() {
        // pitch=2.0 is outside [-pi/2, pi/2]. Gate 6 rejects.
        let mut room = setup_room((0.0, 0.0), (5.0, 0.0));
        let initial_ammo = room.players.get(&1).unwrap().ammo;
        let req = AimEvent {
            pitch_radians: 2.0,
            ..passing_aim_event()
        };
        let result = validate_and_relay_aim(&req, 1, &mut room, 0, Instant::now());
        assert!(
            result.is_empty(),
            "out-of-range pitch must produce no broadcasts"
        );
        assert_eq!(room.players.get(&1).unwrap().ammo, initial_ammo);
    }

    #[test]
    fn aim_event_rejects_source_not_in_room() {
        // Source player 99 doesn't exist in the room.
        let mut room = setup_room((0.0, 0.0), (5.0, 0.0));
        let req = AimEvent {
            source_player_id: 99,
            ..passing_aim_event()
        };
        let result = validate_and_relay_aim(&req, 99, &mut room, 0, Instant::now());
        assert!(
            result.is_empty(),
            "unknown source must produce no broadcasts"
        );
    }

    #[test]
    fn aim_event_rejects_zero_ammo() {
        // Gate 4: ammo must be > 0.
        let mut room = setup_room((0.0, 0.0), (5.0, 0.0));
        room.players.get_mut(&1).unwrap().ammo = 0;
        let req = passing_aim_event();
        let result = validate_and_relay_aim(&req, 1, &mut room, 0, Instant::now());
        assert!(result.is_empty(), "zero ammo must reject");
    }

    #[test]
    fn aim_event_rejects_dead_shooter() {
        // Gate 5: shooter HP must be > 0.
        let mut room = setup_room((0.0, 0.0), (5.0, 0.0));
        room.players.get_mut(&1).unwrap().hp = 0;
        let req = passing_aim_event();
        let result = validate_and_relay_aim(&req, 1, &mut room, 0, Instant::now());
        assert!(result.is_empty(), "dead shooter must reject");
    }

    #[test]
    fn aim_event_rejects_stale_event_id() {
        // Gate 3: eventId must be within EVENT_ID_WINDOW (64) of
        // last seen id. We advance the eventId past the window via
        // a large advance (req.event_id = 1000), then send an
        // eventId that's beyond the window behind it.
        let mut room = setup_room((0.0, 0.0), (5.0, 0.0));
        let now = Instant::now();
        let mut req_advance = passing_aim_event();
        req_advance.event_id = 1000;
        let _ = validate_and_relay_aim(&req_advance, 1, &mut room, 0, now);
        // Now send eventId = 900 (100 behind 1000, beyond
        // EVENT_ID_WINDOW = 64). Must reject.
        let mut stale = passing_aim_event();
        stale.event_id = 900;
        let result =
            validate_and_relay_aim(&stale, 1, &mut room, 0, now + Duration::from_millis(200));
        assert!(
            result.is_empty(),
            "stale eventId must reject (window check)"
        );
    }

    #[test]
    fn aim_event_rejects_fire_rate_violation() {
        // Gate 3: two AimEvents in <120ms, second must be rejected.
        let mut room = setup_room((0.0, 0.0), (5.0, 0.0));
        let now = Instant::now();
        let req1 = passing_aim_event();
        let _ = validate_and_relay_aim(&req1, 1, &mut room, 0, now);
        let req2 = AimEvent {
            event_id: 2,
            ..passing_aim_event()
        };
        // 50ms later: inside 120ms cooldown.
        let result =
            validate_and_relay_aim(&req2, 1, &mut room, 0, now + Duration::from_millis(50));
        assert!(result.is_empty(), "second fire inside cooldown must reject");
        // 200ms later: outside cooldown, second fire succeeds.
        let req3 = AimEvent {
            event_id: 3,
            ..passing_aim_event()
        };
        let result =
            validate_and_relay_aim(&req3, 1, &mut room, 0, now + Duration::from_millis(200));
        assert_eq!(result.len(), 1, "second fire outside cooldown must hit");
    }

    #[test]
    fn aim_event_lag_comp_rewinds_to_in_range_position() {
        // Target moves out of range at frame 30, but AimEvent at frame 40
        // with RTT=400ms rewinds to frame 28 (lag=12), where target
        // was still in range.
        let mut room = Room::new("DEVBX");
        room.add_player(1);
        room.add_player(2);
        room.players.get_mut(&1).unwrap().ammo = 10;
        for frame in 0..30u32 {
            room.record_position(1, frame, Position { x: 0.0, y: 0.0 });
            room.record_position(2, frame, Position { x: 5.0, y: 0.0 });
        }
        for frame in 30..50u32 {
            room.record_position(1, frame, Position { x: 0.0, y: 0.0 });
            room.record_position(2, frame, Position { x: 100.0, y: 0.0 });
        }
        // Advance the room's server frame so the AimEvent's
        // `req.frame = 40` is within MAX_LOOKAHEAD_FRAMES (16) of
        // the current server frame.
        room.next_server_frame = 40;
        let req = AimEvent {
            source_player_id: 1,
            // yaw=PI/2 fires along +X axis (where the in-range target lives).
            yaw_radians: std::f32::consts::FRAC_PI_2,
            pitch_radians: 0.0,
            frame: 40,
            event_id: 1,
            is_firing: 1, // PR #107
        };
        // RTT=400ms -> lag_frames=12 -> rewind to frame 28 (in range).
        let result = validate_and_relay_aim(&req, 1, &mut room, 400, Instant::now());
        assert_eq!(
            result.len(),
            1,
            "with RTT=400ms, lag-comp must rewind to in-range frame"
        );
    }

    #[test]
    fn aim_event_no_targets_in_room_returns_empty() {
        // Shooter is in room, but alone (no other player). No broadcast.
        let mut room = Room::new("DEVBX");
        room.add_player(1);
        room.players.get_mut(&1).unwrap().ammo = 10;
        for frame in 0..5u32 {
            room.record_position(1, frame, Position { x: 0.0, y: 0.0 });
        }
        let req = passing_aim_event();
        let initial_ammo = room.players.get(&1).unwrap().ammo;
        let result = validate_and_relay_aim(&req, 1, &mut room, 0, Instant::now());
        assert!(result.is_empty(), "alone in room: no broadcasts");
        // Ammo still decremented (fire consumed).
        assert_eq!(room.players.get(&1).unwrap().ammo, initial_ammo - 1);
    }

    #[test]
    fn aim_event_two_targets_one_in_range_emits_one_broadcast() {
        // Three players: shooter at (0,0), target2 at (5,0) in range,
        // target3 at (50,0) out of range. Only one broadcast.
        let mut room = Room::new("DEVBX");
        room.add_player(1);
        room.add_player(2);
        room.add_player(3);
        room.players.get_mut(&1).unwrap().ammo = 10;
        // target3 at (200,0) is well past the 50m pistol range.
        for frame in 0..5u32 {
            room.record_position(1, frame, Position { x: 0.0, y: 0.0 });
            room.record_position(2, frame, Position { x: 5.0, y: 0.0 });
            room.record_position(3, frame, Position { x: 200.0, y: 0.0 });
        }
        let req = passing_aim_event();
        let result = validate_and_relay_aim(&req, 1, &mut room, 0, Instant::now());
        assert_eq!(
            result.len(),
            1,
            "single in-range target yields exactly one broadcast"
        );
        assert_eq!(result[0].target_player_id, 2);
    }

    // -- ReloadRequest (PR 11.7.E) --------------------------------------

    /// Helper: build a passing ReloadRequest for player 1.
    fn passing_reload_request() -> ReloadRequest {
        ReloadRequest {
            source_player_id: 1,
            event_id: 1,
        }
    }

    #[test]
    fn validate_and_relay_reload_basic() {
        // Happy path: ammo=3, alive, fresh rate-limit → reload to
        // PLAYER_MAX_AMMO. The snapshot stream (not exercised here;
        // see `validate_and_relay_reload_uses_snapshot_path` below)
        // will carry the new ammo to clients.
        let mut room = setup_room((0.0, 0.0), (5.0, 0.0));
        room.players.get_mut(&1).unwrap().ammo = 3;
        let req = passing_reload_request();
        let result = validate_and_relay_reload(&req, 1, &mut room, Instant::now());
        assert!(result.is_some(), "valid reload must succeed");
        assert_eq!(
            room.players[&1].ammo, PLAYER_MAX_AMMO,
            "reload must set ammo to PLAYER_MAX_AMMO",
        );
        assert!(
            room.players[&1].last_reload_at.is_some(),
            "reload must stamp last_reload_at",
        );
        assert_eq!(
            room.last_event_id_for_source.get(&1).copied(),
            Some(1),
            "reload must advance last_event_id_for_source",
        );
    }

    #[test]
    fn validate_and_relay_reload_zero_ammo_state() {
        // ammoless = full reload path. Magazine was empty (ammo=0),
        // reload fills it to PLAYER_MAX_AMMO (not +1 — `ammo` is the
        // absolute magazine count, not a delta).
        let mut room = setup_room((0.0, 0.0), (5.0, 0.0));
        room.players.get_mut(&1).unwrap().ammo = 0;
        let req = passing_reload_request();
        let result = validate_and_relay_reload(&req, 1, &mut room, Instant::now());
        assert!(result.is_some(), "reload from ammo=0 must succeed");
        assert_eq!(room.players[&1].ammo, PLAYER_MAX_AMMO);
    }

    #[test]
    fn validate_and_relay_reload_when_full() {
        // Magazine already full → reject (no-op reload would waste
        // the rate-limit window).
        let mut room = setup_room((0.0, 0.0), (5.0, 0.0));
        room.players.get_mut(&1).unwrap().ammo = PLAYER_MAX_AMMO;
        let req = passing_reload_request();
        let result = validate_and_relay_reload(&req, 1, &mut room, Instant::now());
        assert!(result.is_none(), "full magazine must reject reload");
        // State must be unchanged (no eventId stamp, no last_reload_at).
        assert_eq!(room.players[&1].ammo, PLAYER_MAX_AMMO);
        assert!(room.players[&1].last_reload_at.is_none());
        assert!(room.last_event_id_for_source.get(&1).is_none());
    }

    #[test]
    fn validate_and_relay_reload_when_dead() {
        // HP=0 → reject (can't reload while dead).
        let mut room = setup_room((0.0, 0.0), (5.0, 0.0));
        room.players.get_mut(&1).unwrap().ammo = 2;
        room.players.get_mut(&1).unwrap().hp = 0;
        let req = passing_reload_request();
        let result = validate_and_relay_reload(&req, 1, &mut room, Instant::now());
        assert!(result.is_none(), "reload while dead must be rejected");
        assert_eq!(
            room.players[&1].ammo, 2,
            "ammo must not change on dead-reload reject"
        );
    }

    #[test]
    fn validate_and_relay_reload_rate_limit() {
        // Two reloads within RELOAD_RATE_LIMIT_MS: first succeeds,
        // second rejected by the rate-limit gate.
        let mut room = setup_room((0.0, 0.0), (5.0, 0.0));
        room.players.get_mut(&1).unwrap().ammo = 2;
        let now = Instant::now();
        let req1 = passing_reload_request();
        let result1 = validate_and_relay_reload(&req1, 1, &mut room, now);
        assert!(result1.is_some(), "first reload must succeed");
        // Second request 100ms later: rate-limit (1/sec) → reject.
        let mut req2 = req1.clone();
        req2.event_id = 2;
        // Drain the magazine so gate 4 doesn't reject.
        room.players.get_mut(&1).unwrap().ammo = 1;
        let result2 =
            validate_and_relay_reload(&req2, 1, &mut room, now + Duration::from_millis(100));
        assert!(
            result2.is_none(),
            "second reload within RELOAD_RATE_LIMIT_MS must be rejected",
        );
        // Third request 1.5s later: rate-limit elapsed → succeed.
        let mut req3 = req1.clone();
        req3.event_id = 3;
        room.players.get_mut(&1).unwrap().ammo = 1;
        let result3 =
            validate_and_relay_reload(&req3, 1, &mut room, now + Duration::from_millis(1500));
        assert!(
            result3.is_some(),
            "reload after rate-limit window must succeed"
        );
    }

    #[test]
    fn validate_and_relay_reload_event_id_monotonic() {
        // First reload stamps event_id=1. A subsequent reload with
        // event_id=0 (within the bounded window) is ACCEPTED by the
        // window (similar to the damage path); a reload with
        // event_id far behind is REJECTED.
        let mut room = setup_room((0.0, 0.0), (5.0, 0.0));
        room.players.get_mut(&1).unwrap().ammo = 2;
        let now = Instant::now();
        let mut req_advance = passing_reload_request();
        req_advance.event_id = 1000;
        let result = validate_and_relay_reload(&req_advance, 1, &mut room, now);
        assert!(result.is_some(), "first reload must succeed");
        assert_eq!(room.last_event_id_for_source.get(&1).copied(), Some(1000),);

        // event_id=950 (50 behind 1000, within EVENT_ID_WINDOW=64) →
        // accepted by the bounded window. Stored value stays at 1000
        // (saturating, not wrapping).
        let mut req_within = passing_reload_request();
        req_within.event_id = 950;
        room.players.get_mut(&1).unwrap().ammo = 1;
        let result =
            validate_and_relay_reload(&req_within, 1, &mut room, now + Duration::from_millis(1100));
        assert!(
            result.is_some(),
            "drift within EVENT_ID_WINDOW must be accepted"
        );
        assert_eq!(
            room.last_event_id_for_source.get(&1).copied(),
            Some(1000),
            "stored event_id must saturate, not wrap to a smaller value",
        );

        // event_id=885 (65 behind 1000, beyond WINDOW=64) → rejected.
        let mut req_beyond = passing_reload_request();
        req_beyond.event_id = 885;
        room.players.get_mut(&1).unwrap().ammo = 1;
        let result =
            validate_and_relay_reload(&req_beyond, 1, &mut room, now + Duration::from_millis(2200));
        assert!(
            result.is_none(),
            "drift beyond EVENT_ID_WINDOW must be rejected"
        );
    }

    #[test]
    fn validate_and_relay_reload_self_only() {
        // Source not in room → reject (gate 1).
        let mut room = setup_room((0.0, 0.0), (5.0, 0.0));
        room.players.get_mut(&1).unwrap().ammo = 2;
        let mut req = passing_reload_request();
        req.source_player_id = 99; // not in room
        let result = validate_and_relay_reload(&req, 99, &mut room, Instant::now());
        assert!(result.is_none(), "source not in room must be rejected");

        // Connection PlayerId mismatch → reject (gate 2).
        let mut req_ok = passing_reload_request();
        let result = validate_and_relay_reload(
            &req_ok,
            2, // wrong connection id
            &mut room,
            Instant::now(),
        );
        assert!(
            result.is_none(),
            "connection PlayerId mismatch must be rejected",
        );
    }

    #[test]
    fn validate_and_relay_reload_uses_snapshot_path() {
        // Post-reload, the snapshot's `players[i].ammo` for the
        // source must equal PLAYER_MAX_AMMO. This pins the contract
        // that the validator mutates the room state and the snapshot
        // builder reads it. The actual snapshot encoding is tested
        // in `server/tests/snapshot.rs`; this is the integration
        // boundary.
        let mut room = setup_room((0.0, 0.0), (5.0, 0.0));
        room.players.get_mut(&1).unwrap().ammo = 0;
        let req = passing_reload_request();
        let result = validate_and_relay_reload(&req, 1, &mut room, Instant::now());
        assert!(result.is_some(), "reload must succeed");
        // Simulate the snapshot builder reading room state: the
        // PlayerState struct the snapshot generator produces carries
        // `ammo = room.players[id].ammo` (see `snapshot.rs::build_snapshot`).
        let snap_ammo = room.players[&1].ammo;
        assert_eq!(
            snap_ammo, PLAYER_MAX_AMMO,
            "post-reload snapshot must report ammo=PLAYER_MAX_AMMO for the source",
        );
    }
}
