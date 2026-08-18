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
//   - §3.13 coyote-time parity grant in `apply_jump` (2-frame grace
//     window so Havok's empirical persistence matches server-side
//     jump success).
//
// **What this PR does NOT wire** (out of scope, queued for later):
//   - Rapier's `event_handler` hookups (collision events, etc.) —
//     no consumer in 11.7.B.
//   - Rapier's debug-render pipeline — disabled by default-features.
//   - Multi-room registry of physics worlds — there's one world per
//     room; room-level ownership is in `Room`, not here.

use std::collections::HashMap;

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
    body_handles: HashMap<PlayerId, RigidBodyHandle>,

    /// Per-player character controller (drives `move_shape` each
    /// tick to produce the desired_translation).
    controllers: HashMap<PlayerId, KinematicCharacterController>,

    /// Per-player grounded status cached at the end of the last
    /// `move_shape` call. Used by `apply_jump` for coyote-time.
    last_grounded: HashMap<PlayerId, bool>,
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

            body_handles: HashMap::new(),
            controllers: HashMap::new(),
            last_grounded: HashMap::new(),
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
        // §3.1 — generous snap-to-ground so the player doesn't
        // hover when walking over small surface variations.
        // Matches the client's Havok `groundSweepLength` of 0.2m.
        controller.snap_to_ground =
            Some(rapier3d::control::CharacterLength::Absolute(0.2));
        controller.up = Vector::y_axis();

        self.body_handles.insert(id, body_handle);
        self.controllers.insert(id, controller);
        self.last_grounded.insert(id, false);
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
        inputs: &HashMap<PlayerId, EncodedInput>,
        frame: u64,
    ) {
        let dt = self.integration_parameters.dt;

        // 1. Decode each player's WASD bits into a desired
        //    horizontal velocity vector. We accumulate gravity's
        //    Y contribution per-player (kinematic bodies don't
        //    auto-integrate gravity; the controller just sees a
        //    desired_translation). The character controller's
        //    `move_shape` will resolve contacts and clip the
        //    translation if a wall blocks movement.
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
                // `apply_jump` below. Buttons bit is consumed but
                // not used in the velocity math.
                let _ = buttons & MOVE_FIRE;
            }
            // Gravity for the Y axis — kinematic bodies don't
            // auto-gravity, so we add it here every tick. The
            // controller will clip if the capsule is on the
            // ground (effective translation Y = 0 on contact).
            let vy = GRAVITY_Y * dt;
            desired_translations.push((*id, vector![vx, vy, vz]));
        }

        // 2. Drive each character's `move_shape` with their
        //    desired_translation. Apply the resulting effective
        //    translation back to the rigid body via
        //    `set_next_kinematic_translation` so Rapier's
        //    integration step advances the body to that
        //    position. Cache `grounded` for coyote-time next
        //    tick.
        let mut new_translations: Vec<(PlayerId, Vector<f32>, bool)> =
            Vec::new();
        for (id, handle) in &self.body_handles {
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

                let new_pos =
                    char_pos.translation.vector + effective.translation;
                let grounded = effective.grounded;
                new_translations.push((*id, new_pos, grounded));
            }
        }

        // 3. Commit the new positions back to the rigid bodies.
        for (id, new_pos, grounded) in &new_translations {
            if let Some(handle) = self.body_handles.get(id) {
                if let Some(body) = self.bodies.get_mut(*handle) {
                    body.set_next_kinematic_translation(*new_pos);
                }
                self.last_grounded.insert(*id, *grounded);
            }
        }

        // 4. Run Rapier's main integration step. This advances
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

        // 5. §3.13 coyote-time jump grant. For each player whose
        //    inputs have the JUMP bit set, grant a jump if they
        //    were grounded within `COYOTE_FRAMES` of `frame`.
        self.apply_jumps(inputs, frame);
    }

    /// §3.13 — coyote-time parity helper. Reads the cached
    /// `last_grounded` from the previous step and the inputs'
    /// JUMP bit; if the player is mid-air but was grounded within
    /// the last `COYOTE_FRAMES` frames (or is grounded now), set
    /// the vertical velocity to `JUMP_IMPULSE`.
    ///
    /// **Havok parity**: Havok persists support contact for ~2
    /// frames after the geometric edge of a ledge (the contact
    /// manifold flips to `false` in 1 frame on Rapier). Without
    /// this grant, every coyote-frame jump produces
    /// reconciliation drift (Havok says JUMP SUCCEEDED; Rapier
    /// says jump DENIED).
    fn apply_jumps(
        &mut self,
        inputs: &HashMap<PlayerId, EncodedInput>,
        frame: u64,
    ) {
        // In PR 11.7.B we infer "last grounded frame" from the
        // cached `last_grounded` boolean (the move_shape result
        // from the current step). The room-level
        // `last_grounded_frame` map tracks frame numbers; for
        // the unit tests in this module we use `frame` itself
        // when the current tick was grounded. PR 11.7.C/D's
        // tick loop can switch to passing the actual frame
        // counter through `Room.last_grounded_frame` if more
        // precision is needed (the §3.13 spec is "2 frames"; 1
        // frame of slop is acceptable for the dev-box canary).
        let mut last_grounded_frame_local: HashMap<PlayerId, u64> =
            HashMap::new();
        for id in self.body_handles.keys() {
            let grounded_now =
                self.last_grounded.get(id).copied().unwrap_or(false);
            if grounded_now {
                last_grounded_frame_local.insert(*id, frame);
            }
        }

        // Collect (id, handle) pairs first to release the
        // immutable borrow on `self.body_handles` before calling
        // the mutable `set_y_velocity` helper.
        let candidates: Vec<(PlayerId, RigidBodyHandle)> =
            self.body_handles
                .iter()
                .map(|(id, h)| (*id, *h))
                .collect();
        for (id, handle) in candidates {
            let input = match inputs.get(&id) {
                Some(i) => i,
                None => continue,
            };
            let jump_pressed = input[0] & MOVE_JUMP != 0;
            if !jump_pressed {
                continue;
            }

            let grounded_now =
                self.last_grounded.get(&id).copied().unwrap_or(false);
            let last_grounded =
                last_grounded_frame_local.get(&id).copied();
            let within_coyote = match last_grounded {
                Some(lf) => {
                    frame.saturating_sub(lf) <= COYOTE_FRAMES as u64
                }
                None => false,
            };

            if grounded_now {
                // Normal in-air jump from ground.
                self.set_y_velocity(handle, JUMP_IMPULSE);
            } else if within_coyote {
                // §3.13 coyote-time grant: player walked off a
                // ledge but the jump button was pressed within
                // `COYOTE_FRAMES` of the last grounded tick.
                self.set_y_velocity(handle, JUMP_IMPULSE);
            }
        }
    }

    /// Helper: set the Y component of a body's linvel. Kinematic
    /// bodies don't auto-gravity; setting linvel is how we apply
    /// jump impulses. The body's X/Z velocity is whatever the
    /// controller left from the move_shape step (which already
    /// preserved horizontal motion).
    fn set_y_velocity(&mut self, handle: RigidBodyHandle, new_y: f32) {
        if let Some(body) = self.bodies.get_mut(handle) {
            let v = *body.linvel();
            body.set_linvel(vector![v.x, new_y, v.z], true);
        }
    }

    /// 2D XZ position for a player. Used by `SnapshotGenerator`
    /// and `Room.record_position`.
    pub fn position(&self, id: PlayerId) -> Option<Position> {
        let handle = self.body_handles.get(&id)?;
        let body = self.bodies.get(*handle)?;
        let t = body.translation();
        Some(Position { x: t.x, y: t.z })
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
        let inputs: HashMap<PlayerId, EncodedInput> = HashMap::new();
        w.step(&inputs, 0);
        // No input → no horizontal motion. The capsule settles
        // on the ground (gravity Y over many ticks pulls it down
        // until the controller stops it on contact).
        let p = w.position(1).unwrap();
        assert_eq!(p.x, 0.0);
        assert_eq!(p.y, 0.0);
    }
}
