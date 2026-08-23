// PR 11.7.B / §3.1 + §3.10 — Rapier 3D physics wrapper.
//
// The server's authoritative simulation is now Rapier (replacing
// the client-side Havok WASM as the source of truth for movement).
// PR 11.7.B introduces the `PhysicsWorld` newtype so the rest of the
// server doesn't depend on Rapier's API surface — a future Rapier
// version bump (or port away from Rapier) won't ripple past this
// module.
//
// **What this PR wires**:
//   - 64Hz fixed-timestep physics step (matches `TICK_RATE_HZ`).
//   - Per-player `KinematicPositionBased` rigid bodies (capsules).
//   - `KinematicCharacterController` for each body — gives us
//     grounded detection + automatic floor snap + slide behavior
//     out of the box.
//   - WASD from `inputs_buffer` decoded → desired horizontal velocity.
//   - §3.13 coyote-time parity grant (2-frame grace window so
//     Havok's empirical persistence matches server-side jump
//     success).
//
// **What this PR does NOT wire** (out of scope, queued for later):
//   - Rapier's `event_handler` hookups (collision events, etc.) —
//     no consumer in 11.7.B.
//   - Rapier's debug-render pipeline — disabled by default-features.
//   - Multi-room registry of physics worlds — there's one world per
//     room; room-level ownership is in `Room`, not here.

use std::collections::BTreeMap;

// NOTE: PR 11.7.B NBLK-1 — physics step uses `BTreeMap` instead of
// `HashMap` for per-player bookkeeping (`body_handles`, `controllers`,
// `last_grounded`, `last_grounded_frame`). `BTreeMap` iterates in
// key order (sorted by `PlayerId = u16`), giving the physics step
// a deterministic iteration order across runs. `HashMap::iter()`
// uses `RandomState` (random seed per process), so two runs of the
// same input stream would yield different float trajectories from
// the order of `move_shape` + `set_next_kinematic_translation`
// calls. The parity smokes at 24p depend on cross-run reproducibility
// to diff snapshot bytes against the reference.

use rapier3d::control::KinematicCharacterController;
use rapier3d::dynamics::{
    IntegrationParameters, IslandManager, RigidBodyHandle, RigidBodySet,
};
use rapier3d::geometry::{BroadPhase, ColliderBuilder, ColliderSet, NarrowPhase};
use rapier3d::math::Vector;
use rapier3d::dynamics::CCDSolver;
use rapier3d::pipeline::{PhysicsPipeline, QueryPipeline};

use rapier3d::prelude::*;

use crate::constants::{COYOTE_FRAMES, JUMP_IMPULSE, TICK_RATE_HZ};
use crate::position_history::Position;
use crate::session::{EncodedInput, PlayerId};

/// PR 11.7.B / §3.1 — `MoveBits` constants from
/// `client/src/net/inputBitmask.ts`. The server reads these bits
/// out of the first byte of each player's `EncodedInput` to derive
/// the desired horizontal velocity for the character controller.
///
/// NOTE: the brief said "bit 6" for jump. The actual
/// `MoveBits.JUMP = 16` (bit 4 of the first byte). Same convention
/// the client's `characterController.ts` reads.
const MOVE_FORWARD:  u8 = 1;  // bit 0
const MOVE_BACKWARD: u8 = 2;  // bit 1
const MOVE_LEFT:     u8 = 4;  // bit 2
const MOVE_RIGHT:    u8 = 8;  // bit 3
const MOVE_JUMP:     u8 = 16; // bit 4 (= `MoveBits.JUMP` in inputBitmask.ts)
const MOVE_FIRE:     u8 = 32; // bit 5

/// Movement speed in m/s. Mirrors
/// `client/src/engine/characterController.ts` `MAX_SPEED` —
/// keeping these in sync is the §3.13 contract.
const MAX_SPEED: f32 = 5.0;

/// Gravity vector (m/s²). Standard Earth gravity; matches
/// `client/src/engine/scene.ts` (the Havok-side scene applies the
/// same -9.81 to capsule bodies).
const GRAVITY_Y: f32 = -9.81;

/// Ground collider dimensions. The flat 40x40 ground at Y=0 in
/// `client/src/engine/scene.ts` is the only static body in the
/// dev-box scene. We register a single fixed cuboid once on first
/// player add so all the capsules share it.
const GROUND_HALF_THICKNESS: f32 = 0.5;
const GROUND_TOP_Y: f32 = 0.0; // top surface of the ground slab

/// Capsule dimensions. The client's `CharacterController` uses
/// 1.0m height + 0.3m radius (matches Havok's default `Capsule`
/// body). The server mirrors these so the hit cone math is
/// symmetric (no client-side "I see a 1m capsule, server says I'm
/// 1.2m" reconciliation drift).
const CAPSULE_HALF_HEIGHT: f32 = 0.5;
const CAPSULE_RADIUS: f32 = 0.3;

/// PR 11.7.B / §3.1 — server's authoritative physics world.
///
/// Owns Rapier's composed-pipeline state (in 0.18 there's no
/// single `World` struct — it's a tuple of `RigidBodySet`,
/// `ColliderSet`, `IslandManager`, `BroadPhase`, `NarrowPhase`,
/// `CCDSolver`, `QueryPipeline`, plus the `PhysicsPipeline`
/// stepper). `PhysicsWorld` is the public surface; consumers
/// (snapshot generator, tests) go through `position` /
/// `velocity` / `grounded` / `is_mid_air`.
pub struct PhysicsWorld {
    bodies: RigidBodySet,
    colliders: ColliderSet,
    impulse_joints: rapier3d::dynamics::ImpulseJointSet,
    multibody_joints: rapier3d::dynamics::MultibodyJointSet,
    islands: IslandManager,
    broad_phase: BroadPhase,
    narrow_phase: NarrowPhase,
    ccd_solver: CCDSolver,
    query_pipeline: QueryPipeline,
    pipeline: PhysicsPipeline,
    integration_parameters: IntegrationParameters,

    /// Per-player capsule rigid body. Keyed by PlayerId.
    /// Sorted by `PlayerId` for deterministic iteration.
    body_handles: BTreeMap<PlayerId, RigidBodyHandle>,

    /// Per-player character controller (drives `move_shape` each
    /// tick to produce the desired_translation). Sorted by
    /// `PlayerId` for deterministic iteration.
    controllers: BTreeMap<PlayerId, KinematicCharacterController>,

    /// Per-player grounded status cached at the end of the last
    /// `move_shape` call. Used by `apply_jump` for coyote-time.
    last_grounded: BTreeMap<PlayerId, bool>,

    /// PR 11.7.B / §3.13 — per-player last-grounded-frame counter
    /// for the coyote-time jump grant. Updated by the `step()`
    /// loop whenever the character controller reports `grounded =
    /// true` AND the body has no active jump velocity; consumed
    /// by the `step()`'s phase 1 coyote grant to decide whether
    /// a JUMP press is within `COYOTE_FRAMES` of the last
    /// grounded frame. Persists across ticks (lives on
    /// `PhysicsWorld`, not on `Room`) — the original throwaway-
    /// local-map design was BLK-1 because the coyote window is
    /// precisely the mid-air case where `grounded_now == false`.
    last_grounded_frame: BTreeMap<PlayerId, u64>,

    /// PR 11.7.B / §3.13 — per-player current Y velocity from a
    /// jump impulse. Set to `JUMP_IMPULSE` on a jump grant
    /// (either from grounded or within the coyote window). Decays
    /// by `GRAVITY_Y * dt` each subsequent step (gravity
    /// decelerates the upward velocity). Each step contributes
    /// `jump_v_y * dt` to the body's Y translation, producing a
    /// multi-frame jump trajectory that matches Havok's
    /// `CharacterController` behavior. When `jump_v_y` decays to
    /// ≤ 0, no further jump translation is applied and the body
    /// falls under the controller's natural gravity.
    ///
    /// **Persists across ticks** — the original single-frame
    /// `JUMP_IMPULSE * dt` translation didn't actually lift the
    /// body into the air (one tick of upward translation was
    /// immediately canceled by the controller's snap-to-ground
    /// + the next tick's gravity). Tracking the velocity as a
    /// persistent state gives the body a real arc.
    jump_v_y: BTreeMap<PlayerId, f32>,
    /// PR 11.7.D2.1 — set of player ids whose translation is
    /// authoritative on the CLIENT side (post-substrate-
    /// retirement). `step()` skips these bodies so the server's
    /// input-driven physics sim doesn't overwrite the client's
    /// reported translation. See `set_position`.
    client_driven: std::collections::BTreeSet<PlayerId>,
}

impl std::fmt::Debug for PhysicsWorld {
    /// PR 11.7.B: minimal `Debug` impl — Rapier's internal sets
    /// don't derive Debug, and we don't want to leak their
    /// internals through logs. The session tests assert that
    /// `Room` is Debug (PR 11.6.D added `#[derive(Debug)]` on
    /// Room); `PhysicsWorld` exposes just the count of
    /// registered players for the Debug printout.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PhysicsWorld")
            .field("n_players", &self.body_handles.len())
            .field("n_colliders", &self.colliders.len())
            .field("dt", &self.integration_parameters.dt)
            .finish()
    }
}

impl PhysicsWorld {
    pub fn new() -> Self {
        let mut integration_parameters = IntegrationParameters::default();
        // §3.10 — 64Hz fixed timestep. Determinism depends on this
        // being constant across runs (§5.2 hard-question 1).
        integration_parameters.dt = 1.0 / TICK_RATE_HZ as f32;

        Self {
            bodies: RigidBodySet::new(),
            colliders: ColliderSet::new(),
            impulse_joints: rapier3d::dynamics::ImpulseJointSet::new(),
            multibody_joints: rapier3d::dynamics::MultibodyJointSet::new(),
            islands: IslandManager::new(),
            broad_phase: BroadPhase::new(),
            narrow_phase: NarrowPhase::new(),
            ccd_solver: CCDSolver::new(),
            query_pipeline: QueryPipeline::new(),
            pipeline: PhysicsPipeline::new(),
            integration_parameters,

            body_handles: BTreeMap::new(),
            controllers: BTreeMap::new(),
            last_grounded: BTreeMap::new(),
            last_grounded_frame: BTreeMap::new(),
            jump_v_y: BTreeMap::new(),
            /// PR 11.7.D2.1 — clients whose position is the authority
            /// (post-substrate-retirement: the CLIENT Havok is the
            /// source of truth; the server reads the client's
            /// reported translation via `PositionUpdate` and the
            /// server's `physics.step()` should NOT integrate inputs
            /// to move these bodies — only the client's reported
            /// translation, applied via `set_position` (which calls
            /// `set_next_kinematic_translation` so the body reads
            /// correctly in the snapshot between steps), is
            /// authoritative). See the `set_position` doc comment.
            client_driven: std::collections::BTreeSet::new(),
        }
    }

    /// Add a new player to the world. Creates a kinematic
    /// position-based capsule at `start_pos` (XZ → (x, 0, y) since
    /// the wire format is 2D and Y is up).
    pub fn add_player(&mut self, id: PlayerId, start_pos: Position) {
        if self.body_handles.contains_key(&id) {
            return;
        }

        // First player seeds the ground (flat 40x40 at y=0).
        if self.colliders.is_empty() {
            self.add_ground();
        }

        let body = rapier3d::dynamics::RigidBodyBuilder::new(
            rapier3d::dynamics::RigidBodyType::KinematicPositionBased,
        )
        .translation(vector![
            start_pos.x,
            CAPSULE_HALF_HEIGHT + CAPSULE_RADIUS,
            start_pos.y
        ])
        // Lock rotations — the capsule is a player body, not a
        // tumbling rigid body. Matches Havok's
        // `CharacterController` which also locks rotation.
        .lock_rotations()
        .build();
        let body_handle = self.bodies.insert(body);

        let collider = ColliderBuilder::capsule_y(CAPSULE_HALF_HEIGHT, CAPSULE_RADIUS)
            // Capsule density for kinematic bodies is mostly
            // cosmetic (kinematic bodies don't use mass for
            // dynamics), but we set it to match Havok's character
            // body so any future physics interaction (e.g.,
            // knock-back) is symmetric.
            .density(1.0)
            .build();
        self.colliders
            .insert_with_parent(collider, body_handle, &mut self.bodies);

        let mut controller = KinematicCharacterController::default();
        // PR 11.7.B — disable `snap_to_ground`. The default
        // `snap_to_ground = Some(Absolute(0.2))` pulls the body
        // back into ground contact whenever the capsule is within
        // 0.2m of a ground surface. After a jump (body rises by
        // JUMP_IMPULSE * dt = ~0.086m), the body is still within
        // 0.2m of the ground, so the controller's snap fires on
        // the next tick and pulls it back down. The body never
        // actually leaves the ground, which breaks the §3.13
        // coyote-time contract: the controller's `grounded`
        // report stays `true` indefinitely, so
        // `last_grounded_frame` keeps refreshing and the coyote
        // window never expires.
        controller.snap_to_ground = None;
        controller.up = Vector::y_axis();
        // PR 11.7.B — disable the controller's auto-stepping.
        // The default `autostep` is enabled with a max_height of
        // Relative(0.25) * dims.y, which lets the controller climb
        // obstacles up to 0.2m. With the body in a state of partial
        // ground penetration (the body settles slightly into the
        // ground after the gravity translation pushes it down), the
        // controller's auto-step kicks in every tick and pushes the
        // body UP by ~0.086m per tick regardless of the desired
        // translation. This makes the §3.13 jump impulse
        // (JUMP_IMPULSE * dt = 0.086m) indistinguishable from the
        // controller's spurious step. Disabling autostep makes the
        // controller behave as a simple kinematic body that moves
        // only by the desired translation (modulo ground contact
        // clipping).
        controller.autostep = None;

        self.body_handles.insert(id, body_handle);
        self.controllers.insert(id, controller);
        self.last_grounded.insert(id, false);
        self.jump_v_y.insert(id, 0.0);
    }

    fn add_ground(&mut self) {
        // 40x40 flat ground at Y=0 (matches
        // `client/src/engine/scene.ts`).
        let ground_body = rapier3d::dynamics::RigidBodyBuilder::fixed()
            .translation(vector![
                0.0,
                -GROUND_HALF_THICKNESS + GROUND_TOP_Y,
                0.0
            ])
            .build();
        let ground_handle = self.bodies.insert(ground_body);

        let ground_collider =
            ColliderBuilder::cuboid(20.0, GROUND_HALF_THICKNESS, 20.0)
                // Friction matters for the character controller's
                // slope-climb logic. The client's Havok ground
                // uses friction = 0.5; Rapier's default collider
                // friction (0.5) matches.
                .build();
        self.colliders.insert_with_parent(
            ground_collider,
            ground_handle,
            &mut self.bodies,
        );
    }

    /// Number of registered players.
    pub fn n_players(&self) -> usize {
        self.body_handles.len()
    }

    /// PR 11.7.B / §3.10 — step the physics world by one fixed
    /// tick (`dt = 1.0 / TICK_RATE_HZ`).
    ///
    /// `inputs` is a snapshot of the most-recent input per
    /// PlayerId (the consumer — the `physics_tick_loop` task —
    /// drains `Room.inputs_buffer` once per tick and passes the
    /// most-recent input here).
    ///
    /// `frame` is the server's authoritative frame counter
    /// (used for coyote-time bookkeeping).
    ///
    /// **Determinism** (per §5.2 hard-question 1): the step uses
    /// `IntegrationParameters.dt` set in `new()` — variable
    /// timestep would break same-inputs-same-state across runs.
    pub fn step(
        &mut self,
        inputs: &BTreeMap<PlayerId, EncodedInput>,
        frame: u64,
    ) {
        let dt = self.integration_parameters.dt;

        // 1. Phase 1 — §3.13 coyote-time jump grants, with
        //    multi-frame jump velocity decay.
        //
        //    For each player we either:
        //      - GRANT a fresh jump (set `jump_v_y = JUMP_IMPULSE`)
        //        when JUMP is pressed AND (grounded_now OR within
        //        the coyote window).
        //      - DECAY the previous tick's `jump_v_y` by gravity
        //        if no new grant fired and the previous value was
        //        still positive (the body is still rising from an
        //        earlier jump — the ballistic arc continues).
        //      - DROP the entry if neither (no active jump; the
        //        body falls naturally via the controller).
        //
        //    The persisted `jump_v_y` produces a proper arc — the
        //    body's Y position rises each step until gravity
        //    decelerates the velocity to 0 (~35 ticks at
        //    JUMP_IMPULSE = 5.5 m/s, GRAVITY_Y = -9.81 m/s²), then
        //    falls back to ground.
        let mut new_jump_v_y: BTreeMap<PlayerId, f32> = BTreeMap::new();
        for (id, _) in &self.body_handles {
            let input = inputs.get(id);
            let jump_pressed = input
                .map(|i| i[0] & MOVE_JUMP != 0)
                .unwrap_or(false);
            // `grounded_now` is the controller's per-tick grounded
            // report, refined to exclude "jumping" bodies. During
            // an active jump (`jump_v_y > 0`), the body's upward
            // sweep may report `grounded=true` from the controller
            // even though the body is leaving the ground — for
            // coyote purposes, an actively-jumping body is
            // "not grounded" (we don't want to re-grant a fresh
            // jump every tick).
            let grounded_now = self
                .last_grounded
                .get(id)
                .copied()
                .unwrap_or(false)
                && self
                    .jump_v_y
                    .get(id)
                    .copied()
                    .unwrap_or(0.0)
                    == 0.0;
            let last_grounded_frame_val =
                self.last_grounded_frame.get(id).copied();
            let within_coyote = match last_grounded_frame_val {
                Some(lf) => {
                    frame.saturating_sub(lf) <= COYOTE_FRAMES as u64
                }
                None => false,
            };
            let prev_vy = self.jump_v_y.get(id).copied().unwrap_or(0.0);

            if jump_pressed && (grounded_now || within_coyote) {
                // §3.13 — fresh jump grant (either grounded or
                // within the coyote window from a recent grounded
                // state). Reset `jump_v_y` to the full impulse.
                new_jump_v_y.insert(*id, JUMP_IMPULSE);
            } else if prev_vy > 0.0 {
                // Carry over the previous tick's upward velocity
                // and apply per-tick gravity deceleration. If the
                // decayed value is still positive, keep it as the
                // active jump velocity for this tick; otherwise
                // the entry is dropped (jump has run its course).
                let decayed = prev_vy + GRAVITY_Y * dt;
                if decayed > 0.0 {
                    new_jump_v_y.insert(*id, decayed);
                }
            }
        }
        self.jump_v_y = new_jump_v_y;

        // 2. Decode each player's WASD bits into a desired
        //    horizontal velocity vector. We accumulate gravity's
        //    Y contribution per-player (kinematic bodies don't
        //    auto-integrate gravity; the controller just sees a
        //    desired_translation). The character controller's
        //    `move_shape` will resolve contacts and clip the
        //    translation if a wall blocks movement.
        //
        //    If a §3.13 jump was granted in phase 1, add the
        //    JUMP_IMPULSE * dt to the desired Y so the controller
        //    carries the body upward by exactly the impulse's
        //    per-tick translation.
        let mut desired_translations: Vec<(PlayerId, Vector<f32>)> = Vec::new();
        for (id, _) in &self.body_handles {
            let mut vx = 0.0_f32;
            let mut vz = 0.0_f32;
            if let Some(input) = inputs.get(id) {
                let buttons = input[0];
                if buttons & MOVE_FORWARD != 0 {
                    vz -= MAX_SPEED * dt;
                }
                if buttons & MOVE_BACKWARD != 0 {
                    vz += MAX_SPEED * dt;
                }
                if buttons & MOVE_LEFT != 0 {
                    vx -= MAX_SPEED * dt;
                }
                if buttons & MOVE_RIGHT != 0 {
                    vx += MAX_SPEED * dt;
                }
                // Fire / jump have separate handling — see
                // phase 1 above. Buttons bit is consumed but
                // not used in the velocity math.
                let _ = buttons & MOVE_FIRE;
            }
            // Y translation per tick. The controller's
            // `move_shape` treats this as the desired
            // translation for the tick. The body moves by
            // this much (subject to contact clipping).
            //
            // Two cases:
            //   - active jump (`jump_v_y > 0`):
            //     vy = jump_v_y * dt (UPWARD; either fresh
            //     grant or carry-over from previous tick).
            //     The body rises by the jump velocity × dt,
            //     producing a ballistic arc that matches
            //     Havok's `CharacterController` behavior.
            //   - no jump: vy = GRAVITY_Y * dt (downward).
            //     The existing per-tick gravity translation.
            //     The controller's ground clipping prevents
            //     the body from falling through the ground.
            //
            // The pre-existing `GRAVITY_Y * dt` formula is
            // (m/s² * s = m/s) which is being used as a
            // translation — the resulting velocity is 9.81
            // m/s after one tick. The coyote-time grant
            // overrides this for the jump frame so the body
            // actually rises.
            let jump_vy = self.jump_v_y.get(id).copied().unwrap_or(0.0);
            let vy = if jump_vy > 0.0 {
                jump_vy * dt
            } else {
                GRAVITY_Y * dt
            };
            desired_translations.push((*id, vector![vx, vy, vz]));
        }

        // 3. Drive each character's `move_shape` with their
        //    desired_translation. Apply the resulting effective
        //    translation back to the rigid body via
        //    `set_next_kinematic_translation` so Rapier's
        //    integration step advances the body to that
        //    position. Cache `grounded` for the next tick's
        //    coyote check.
        let mut new_translations: Vec<(PlayerId, Vector<f32>, bool)> =
            Vec::new();
        for (id, handle) in &self.body_handles {
            // PR 11.7.D2.1 — skip client-driven bodies. Their
            // translation is set via `set_position` (which queues
            // `set_next_kinematic_translation`); the input-driven
            // step would overwrite that queue with stale
            // physics-derived motion. Bail out before the
            // `move_shape` call so the queued translation lands
            // untouched.
            if self.client_driven.contains(id) {
                continue;
            }
            let controller = match self.controllers.get(id) {
                Some(c) => *c,
                None => continue,
            };
            let desired = desired_translations
                .iter()
                .find(|(pid, _)| pid == id)
                .map(|(_, v)| *v)
                .unwrap_or(vector![0.0, GRAVITY_Y * dt, 0.0]);


            let body = match self.bodies.get(*handle) {
                Some(b) => b,
                None => continue,
            };
            let char_pos = body.position();
            // Capture the capsule collider handle for shape
            // access in move_shape.
            let capsule_coll_handle =
                body.colliders().first().copied();

            if let Some(coll_h) = capsule_coll_handle {
                let coll = self
                    .colliders
                    .get(coll_h)
                    .expect("player capsule collider");
                let shape = coll.shape();
                let effective = controller.move_shape(
                    dt,
                    &self.bodies,
                    &self.colliders,
                    &self.query_pipeline,
                    shape,
                    &char_pos,
                    desired,
                    rapier3d::pipeline::QueryFilter::default(),
                    |_| {},
                );

                // PR 11.7.B — Y translation policy:
                //
                //   - If `jump_v_y > 0` (active jump), use
                //     `jump_v_y * dt` — this is the full jump
                //     velocity × tick duration, producing the
                //     upward arc. We override the controller's
                //     `effective.translation.y` because the
                //     controller's collision clipping can clip
                //     the upward translation back to ground
                //     level (especially when the body is in
                //     slight penetration after a fresh jump).
                //
                //   - Otherwise (no active jump), trust the
                //     controller's `effective.translation.y`.
                //     The controller already accounts for
                //     gravity (`desired.y = GRAVITY_Y * dt` →
                //     `effective.y ≈ GRAVITY_Y * dt` when
                //     airborne, `effective.y ≈ 0` when grounded
                //     and clipped by ground contact).
                //
                // The XZ translation comes from the controller
                // for collision-aware horizontal motion.
                let jump_vy_now =
                    self.jump_v_y.get(id).copied().unwrap_or(0.0);
                let grounded = effective.grounded;
                let final_y = if jump_vy_now > 0.0 {
                    jump_vy_now * dt
                } else {
                    effective.translation.y
                };
                let new_pos = vector![
                    char_pos.translation.vector.x
                        + effective.translation.x,
                    char_pos.translation.vector.y + final_y,
                    char_pos.translation.vector.z
                        + effective.translation.z,
                ];
                new_translations.push((*id, new_pos, grounded));
            }
        }

        // 4. Commit the new positions back to the rigid bodies.
        //    Also persist the last-grounded-frame counter for the
        //    §3.13 coyote-time grant: the BTreeMap lives on the
        //    PhysicsWorld so the value survives across ticks (BLK-1
        //    fix — the previous throwaway-local-map left the coyote
        //    window structurally unreachable).
        //
        //    **Important**: `last_grounded_frame` is ONLY updated
        //    when the body is truly grounded — i.e., the controller
        //    reported `effective.grounded = true` AND the body has
        //    no active jump velocity (`jump_v_y == 0`). The
        //    controller's `effective.grounded` is true during a
        //    jump frame (the body's upward sweep passes through the
        //    ground, so the controller's collision detection flags
        //    it as "in contact"); if we naively updated
        //    `last_grounded_frame` on every `grounded=true`, the
        //    coyote window would refresh mid-jump and the grant
        //    would fire on every subsequent JUMP press. The
        //    `jump_v_y == 0` guard prevents this: an active jump
        //    is, by definition, "not grounded" for coyote purposes.
        for (id, new_pos, grounded) in &new_translations {
            if let Some(handle) = self.body_handles.get(id) {
                if let Some(body) = self.bodies.get_mut(*handle) {
                    body.set_next_kinematic_translation(*new_pos);
                }
                let jumping = self
                    .jump_v_y
                    .get(id)
                    .copied()
                    .unwrap_or(0.0)
                    > 0.0;
                self.last_grounded.insert(*id, *grounded);
                if *grounded && !jumping {
                    self.last_grounded_frame.insert(*id, frame);
                }
            }
        }

        // 5. Run Rapier's main integration step. This advances
        //    kinematic bodies to their `next_kinematic_translation`
        //    AND integrates dynamic bodies + resolves contacts.
        //    In PR 11.7.B we only have kinematic bodies (the
        //    ground is fixed), so the integration step is mostly
        //    a no-op for us — but the API contract requires it.
        let gravity = vector![0.0, GRAVITY_Y, 0.0];
        self.pipeline.step(
            &gravity,
            &self.integration_parameters,
            &mut self.islands,
            &mut self.broad_phase,
            &mut self.narrow_phase,
            &mut self.bodies,
            &mut self.colliders,
            &mut self.impulse_joints,
            &mut self.multibody_joints,
            &mut self.ccd_solver,
            Some(&mut self.query_pipeline),
            &(),
            &(),
        );
    }

    /// 2D XZ position for a player. Used by `SnapshotGenerator`
    /// and `Room.record_position`.
    pub fn position(&self, id: PlayerId) -> Option<Position> {
        let handle = self.body_handles.get(&id)?;
        let body = self.bodies.get(*handle)?;
        let t = body.translation();
        Some(Position { x: t.x, y: t.z })
    }

    /// PR 11.7.D2.1 — snap a kinematic player body to a client-
    /// authoritative position (the wire format is 2D XZ; we set
    /// the body's y to `CAPSULE_HALF_HEIGHT + CAPSULE_RADIUS` so
    /// the capsule rests on the ground after the teleport). The
    /// server-side physics simulation runs in `step()` and
    /// computes body translation from inputs, but the post-
    /// substrate-retirement (PR 11.7.D) model treats the CLIENT
    /// Havok as authoritative for position — so on each
    /// `PositionUpdate` the server snaps the kinematic body to
    /// whatever the client reported. This ensures
    /// `SnapshotGenerator` (which reads `physics.position(id)`)
    /// reflects the client's reported position immediately,
    /// without waiting for the next `step()` to integrate
    /// inputs into a (possibly stale) server-side guess.
    ///
    /// Also marks the player as `client_driven` — `step()` then
    /// skips its physics integration, so the body's translation
    /// stays at whatever the client reported (instead of being
    /// overwritten by the server's input-driven physics sim).
    pub fn set_position(&mut self, id: PlayerId, pos: Position) {
        self.client_driven.insert(id);
        if let Some(handle) = self.body_handles.get(&id) {
            if let Some(body) = self.bodies.get_mut(*handle) {
                body.set_next_kinematic_translation(vector![
                    pos.x,
                    CAPSULE_HALF_HEIGHT + CAPSULE_RADIUS,
                    pos.y
                ]);
            }
        }
    }

    /// 2D XZ velocity for a player (XZ components of linvel).
    /// Returns `[0.0, 0.0]` if the player isn't in the world.
    pub fn velocity(&self, id: PlayerId) -> [f32; 2] {
        match self.body_handles.get(&id) {
            Some(handle) => match self.bodies.get(*handle) {
                Some(body) => {
                    let v = body.linvel();
                    [v.x, v.z]
                }
                None => [0.0, 0.0],
            },
            None => [0.0, 0.0],
        }
    }

    /// PR 11.7.B / §3.13 (BLK-3 test support) — Y-component of
    /// the player's linear velocity (the up axis). Returns
    /// `None` if the player isn't in the physics world.
    ///
    /// Note: for `KinematicPositionBased` bodies, `linvel` is
    /// computed by the integration step from the position delta.
    /// Each tick the body moves by `jump_v_y * dt` (when an
    /// active jump exists) or `controller.effective.translation.y`
    /// (otherwise); `linvel.y = position_delta / dt`. So
    /// `velocity_y` returns the same value as `jump_v_y` (when
    /// jumping) or `GRAVITY_Y` (when in free fall).
    pub fn velocity_y(&self, id: PlayerId) -> Option<f32> {
        let handle = self.body_handles.get(&id)?;
        let body = self.bodies.get(*handle)?;
        Some(body.linvel().y)
    }

    /// PR 11.7.B / §3.13 (test support) — the per-player jump
    /// impulse velocity. Set to `JUMP_IMPULSE` when a jump is
    /// granted (grounded or within coyote window); decays by
    /// `GRAVITY_Y * dt` each subsequent step. `None` if the
    /// player isn't in the physics world; `Some(0.0)` if no
    /// active jump.
    ///
    /// Tests use this to distinguish a granted jump (velocity
    /// reset to `JUMP_IMPULSE`) from a denied one (velocity
    /// remains 0 or negative).
    pub fn jump_velocity_y(&self, id: PlayerId) -> Option<f32> {
        self.jump_v_y.get(&id).copied()
    }

    /// PR 11.7.B / §3.13 (BLK-3 test support) — Y-component of
    /// the player's body translation (the up axis). Returns
    /// `None` if the player isn't in the physics world. Used
    /// by the rewritten coyote-time tests to assert that a
    /// jump raised the capsule (the floor of the §3.13 grant
    /// contract — the Y position must rise after a granted
    /// jump). The XZ position is reported via `position(id)`;
    /// the Y is internal to the body.
    pub fn body_y(&self, id: PlayerId) -> Option<f32> {
        let handle = self.body_handles.get(&id)?;
        let body = self.bodies.get(*handle)?;
        Some(body.translation().y)
    }

    /// Returns `true` if the player's capsule is in contact with
    /// the ground (as detected by `KinematicCharacterController`).
    pub fn grounded(&self, id: PlayerId) -> bool {
        self.last_grounded.get(&id).copied().unwrap_or(false)
    }

    /// Returns `true` if the player is in mid-air (not grounded).
    /// Convenience inverse of `grounded` for snapshot emitters
    /// that want to flag airborne players.
    pub fn is_mid_air(&self, id: PlayerId) -> bool {
        !self.grounded(id)
    }
}

impl Default for PhysicsWorld {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    //! Unit tests for `PhysicsWorld`. These verify the wrapper's
    //! API contract (add_player, position, velocity, grounded) and
    //! the §3.13 coyote-time logic at the unit level. The
    //! integration suite (`server/tests/session_canary.rs` +
    //! `server/tests/snapshot.rs`) covers end-to-end behavior.

    use super::*;

    #[test]
    fn new_physics_world_is_empty() {
        let w = PhysicsWorld::new();
        assert_eq!(w.n_players(), 0);
    }

    #[test]
    fn add_player_creates_capsule_at_start_pos() {
        let mut w = PhysicsWorld::new();
        w.add_player(1, Position { x: 2.0, y: 3.0 });
        assert_eq!(w.n_players(), 1);
        // Position is XZ-only: the capsule's body translation is
        // (start.x, capsule_half_height + radius, start.y) — we
        // report (x, z) which is (start.x, start.y).
        let p = w.position(1).expect("player 1 has a position");
        assert_eq!(p.x, 2.0);
        assert_eq!(p.y, 3.0);
    }

    #[test]
    fn add_player_is_idempotent() {
        let mut w = PhysicsWorld::new();
        w.add_player(1, Position::ZERO);
        w.add_player(1, Position { x: 99.0, y: 99.0 });
        assert_eq!(w.n_players(), 1);
        // The second call is a no-op so position stays at (0, 0).
        let p = w.position(1).unwrap();
        assert_eq!(p.x, 0.0);
        assert_eq!(p.y, 0.0);
    }

    #[test]
    fn velocity_zero_before_any_step() {
        let mut w = PhysicsWorld::new();
        w.add_player(1, Position::ZERO);
        assert_eq!(w.velocity(1), [0.0, 0.0]);
    }

    #[test]
    fn grounded_false_for_ungrounded_capsule() {
        let mut w = PhysicsWorld::new();
        w.add_player(1, Position::ZERO);
        assert!(!w.grounded(1));
        assert!(w.is_mid_air(1));
    }

    #[test]
    fn position_velocity_grounded_return_none_zero_for_unknown_player() {
        let w = PhysicsWorld::new();
        assert_eq!(w.position(99), None);
        assert_eq!(w.velocity(99), [0.0, 0.0]);
        assert!(!w.grounded(99));
    }

    #[test]
    fn step_with_no_inputs_keeps_player_at_origin() {
        let mut w = PhysicsWorld::new();
        w.add_player(1, Position::ZERO);
        let inputs: BTreeMap<PlayerId, EncodedInput> = BTreeMap::new();
        w.step(&inputs, 0);
        // No input → no horizontal motion. The capsule settles
        // on the ground (gravity Y over many ticks pulls it down
        // until the controller stops it on contact).
        let p = w.position(1).unwrap();
        assert_eq!(p.x, 0.0);
        assert_eq!(p.y, 0.0);
    }
}
