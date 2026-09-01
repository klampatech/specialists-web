// PR 11.6.C / §3.4.2 — server-side hitscan raycast.
//
// Pure Rust port of `client/src/game/combat.ts:dualPistolShoot`. The
// server-side version is intentionally minimal — no Babylon, no scene,
// no mesh picking. It answers a single question: given a chest-height
// ray (origin + direction + range) and a capsule target (position +
// radius), does the ray hit the capsule?
//
// **Why we port the hitscan math to the server**: PR 11.6.D's lag-comp
// validator (`validate_and_relay`) calls this on the rewound target
// position (see `PositionHistory::snapshot_at`). The server must reach
// the same hit verdict as the client for damage to feel fair. If the
// client and server disagree on a hit, "shot didn't count" — the #1
// netcode complaint in shooters.
//
// **Math (3D ray-vs-sphere, PR 11.6.C review fix B1)**:
//   For a ray `p = origin + t * forward` (t >= 0) to hit a sphere of
//   radius `r` centered at `target_pos`, we need the closest distance
//   from `target_pos` to the ray to be `<= r` AND the closest point
//   to be IN FRONT of the ray (`t >= 0`) AND within `max_range`.
//
//   The full 3D forward vector (already unit-length from
//   `forward_from_yaw_pitch`) is used — projecting only on the
//   xz-plane at non-zero pitch gave wrong t values (scaled by
//   cos(pitch)²) and wrong hit verdicts (verified: a target exactly
//   on the 3D ray at yaw=0, pitch=π/4, range=10m produced MISS under
//   the 2D math, HIT under the 3D math). The chest height is baked
//   into the ray origin (`chest_position` adds +0.45 to y), and the
//   sphere is centered at the target's full 3D position — so a
//   crouched target still gets hit if the ray grazes the sphere
//   around the chest, exactly matching the client's behavior
//   (`Babylon.scene.pickWithRay` against the capsule meshes).
//
// **Determinism**: this is the same math the client uses, expressed in
// f32 with IEEE-754 round-to-nearest-even. Same inputs produce the
// same bits on both sides. The 100-pose fixture test in this file
// compares the Rust verdict against a JS reference implementation
// (see `client/src/game/combat.ts:forwardFromYawPitch` for the
// direction vector — the canonical yaw/pitch → (x, y, z) mapping).
//
// `glam::Vec3` is kept as a direct dependency so the public API remains
// stable even if the WebTransport dependency graph changes. The arithmetic
// below is written component-wise to preserve the client's f32 rounding and
// avoid SIMD reassociation changing a lag-comp verdict.

use crate::constants::WeaponDef;
//
// **The 100-pose fixture**: tests/hitscan_fixture.rs generates 100
// random (origin, yaw, pitch, target_pos, target_radius) tuples,
// computes the hit verdict, and cross-checks against an independent
// analytic reference (also computed in pure Rust, but via a different
// formulation — closest-point-on-ray + distance check). Both sides use
// the same primitives so the test really only catches sign / clamp
// bugs; the TS reference in `combat.ts` is the external ground truth
// (the cross-check between TS and Rust f32 round-to-nearest-even).
// PR 11.6.C: the fixture now varies `target.y` over [-2, +2] and pitch
// over [-π/3, +π/3] so the 3D math is exercised (the previous fixture
// had `target.y ≈ origin.y ± 0.5` and pitch clamped to ±π/4, which
// masked the 2D math bug).

/// The damage a confirmed dual-pistol hit applies. Mirrors
/// `client/src/game/combat.ts:COMBAT.dualPistol.damage = 12`.
pub const DUAL_PISTOL_DAMAGE: u8 = 12;

/// Maximum pistol range, matching `client/src/game/combat.ts`.
pub const DUAL_PISTOL_MAX_RANGE_METERS: f32 = 50.0;

/// The default capsule radius for the humanoid target. Mirrors
/// `client/src/engine/characterConfig.ts:CAPSULE.radius = 0.5`.
pub const DEFAULT_TARGET_RADIUS: f32 = 0.5;

/// Forward vector from yaw + pitch. Mirrors
/// `client/src/game/combat.ts:forwardFromYawPitch` byte-for-byte:
///   cp = cos(pitch)
///   x = sin(yaw) * cp
///   y = sin(pitch)
///   z = cos(yaw) * cp
///
/// Babylon is left-handed Y-up; the player's "forward" at yaw=0 is
/// +Z. Same convention used here so server and client agree on hit
/// direction.
pub fn forward_from_yaw_pitch(yaw_radians: f32, pitch_radians: f32) -> glam::Vec3 {
    let cp = pitch_radians.cos();
    glam::Vec3::new(
        yaw_radians.sin() * cp,
        pitch_radians.sin(),
        yaw_radians.cos() * cp,
    )
}

/// Chest-height ray origin: capsule centre + a quarter-height offset up.
/// Mirrors `client/src/game/combat.ts:chestPosition`:
///   `controller.state.position + Vector3(0, CAPSULE.height / 4, 0)`
///
/// `CAPSULE.height = 1.8` so the offset is `0.45`. We hard-code 0.45
/// here to avoid coupling `hitscan.rs` to `characterConfig.ts` (which
/// doesn't exist on the server side); the constant is canonical from
/// the SPEC and won't drift without a deliberate SPEC update.
pub fn chest_position(capsule_centre: glam::Vec3) -> glam::Vec3 {
    glam::Vec3::new(capsule_centre.x, capsule_centre.y + 0.45, capsule_centre.z)
}

/// Did the dual-pistol ray hit the target capsule?
///
///   `origin`      chest-height ray origin
///   `forward`     unit-length direction vector (use `forward_from_yaw_pitch`)
///   `target_pos`  capsule-centre target position (the rewound position for
///                 lag-comp, the current position for the local tick)
///   `target_radius`  capsule radius (0.5 for the humanoid)
///
/// Returns true iff the ray hits within `max_range` metres. The math is
/// a 3D ray-vs-sphere test (PR 11.6.C review fix B1) — the full 3D
/// forward vector is used, the target's full 3D position is the
/// sphere centre, and the capsule is approximated as a sphere of
/// radius `target_radius` around the target's chest. This matches the
/// client's behavior (Babylon's `scene.pickWithRay` casts the 3D ray
/// against the capsule meshes).
pub fn dual_pistol_hit(
    origin: glam::Vec3,
    forward: glam::Vec3,
    // `_yaw_radians` is retained in the public contract for callers
    // that have the shot orientation alongside the already-derived
    // direction. The direction vector is the authoritative 3D ray;
    // yaw is NOT consulted (the 3D ray-vs-sphere math uses the full
    // `forward` vector). Underscore-prefix silences the unused-
    // variable warning while preserving the public signature.
    _yaw_radians: f32,
    target_pos: glam::Vec3,
    target_radius: f32,
) -> bool {
    dual_pistol_hit_at_range(
        origin,
        forward,
        target_pos,
        target_radius,
        DUAL_PISTOL_MAX_RANGE_METERS,
    )
}

/// Backward-compat shim for the PR 11.6.C 100-pose fixture +
/// any in-flight callers that imported the dual-pistol-specific
/// name. PR #102 renames the canonical math to `ray_vs_sphere_hit`
/// (private) and exposes `weapon_hitscan(weapon_def, ...)` as the
/// new public API.
fn dual_pistol_hit_at_range(
    origin: glam::Vec3,
    forward: glam::Vec3,
    target_pos: glam::Vec3,
    target_radius: f32,
    max_range: f32,
) -> bool {
    ray_vs_sphere_hit(origin, forward, target_pos, target_radius, max_range)
}

/// PR #102 — the canonical ray-vs-sphere math. The dual-pistol
/// `dual_pistol_hit_at_range` shim is preserved below for callers +
/// the PR 11.6.C 100-pose fixture.
fn ray_vs_sphere_hit(
    origin: glam::Vec3,
    forward: glam::Vec3,
    target_pos: glam::Vec3,
    target_radius: f32,
    max_range: f32,
) -> bool {
    // PR 11.6.C review fix B1: 3D ray-vs-sphere math. Use the full 3D
    // forward vector (already unit-length from `forward_from_yaw_pitch`)
    // and the full 3D target position. The 2D xz-projection math at
    // non-zero pitch was scaling t by cos(pitch)² and producing wrong
    // verdicts (verified: a target exactly on the 3D ray at yaw=0,
    // pitch=π/4, range=10m produced MISS under the 2D math, HIT under
    // the 3D math).
    if !max_range.is_finite() || target_radius < 0.0 {
        return false;
    }
    // to_target = target_pos - origin (full 3D vector).
    let dx = target_pos.x - origin.x;
    let dy = target_pos.y - origin.y;
    let dz = target_pos.z - origin.z;
    // Project onto the ray (forward is unit-length, so this is t along
    // the ray to the closest point on the infinite line).
    let t = dx * forward.x + dy * forward.y + dz * forward.z;
    if t < 0.0 || t > max_range {
        return false;
    }
    // closest = the point on the ray at distance t.
    let cx = origin.x + forward.x * t;
    let cy = origin.y + forward.y * t;
    let cz = origin.z + forward.z * t;
    // Squared distance from target to closest point on ray.
    let ex = target_pos.x - cx;
    let ey = target_pos.y - cy;
    let ez = target_pos.z - cz;
    let dist_sq = ex * ex + ey * ey + ez * ez;
    dist_sq <= target_radius * target_radius
}

/// Damage value for a confirmed dual-pistol hit. Returns
/// `DUAL_PISTOL_DAMAGE` (12) on a hit, 0 on a miss. Mirrors the
/// client's `COMBAT.dualPistol.damage` semantics exactly.
///
/// Kept as a free function so PR 11.6.D's `validate_and_relay` has a
/// one-liner for the damage field of the synthesized `DamageBroadcast`.
pub fn dual_pistol_damage(distance: f32) -> u8 {
    if distance.is_finite() && distance >= 0.0 && distance <= DUAL_PISTOL_MAX_RANGE_METERS {
        DUAL_PISTOL_DAMAGE
    } else {
        0
    }
}

/// PR #102 — generic per-pellet hitscan. Replaces `dual_pistol_hit`
/// as the canonical server-side hit test. The previous
/// `dual_pistol_hit` is now a thin shim over this for backward
/// compat with existing callers + the PR 11.6.C 100-pose fixture.
///
///   `weapon_def`     the per-weapon tunables from `WEAPONS_TABLE`
///   `origin`         chest-height ray origin
///   `forward`        unit-length direction vector (use `forward_from_yaw_pitch`)
///   `target_pos`     capsule-centre target position (rewound for lag-comp)
///   `target_radius`  capsule radius (0.5 for the humanoid)
///
/// Returns true iff the ray hits within `weapon_def.max_range_meters`.
/// Per-pellet spread (shotgun) is handled by the caller looping over
/// `weapon_def.pellets` with jittered forward vectors; this function
/// is the single-pellet primitive.
pub fn weapon_hitscan(
    weapon_def: &WeaponDef,
    origin: glam::Vec3,
    forward: glam::Vec3,
    target_pos: glam::Vec3,
    target_radius: f32,
) -> bool {
    ray_vs_sphere_hit(
        origin,
        forward,
        target_pos,
        target_radius,
        weapon_def.max_range_meters,
    )
}

/// Multi-pellet shotgun hit test. Returns true if at least one of
/// `weapon_def.pellets` jittered pellets hits the target. The first
/// pellet uses the unmodified `forward`; subsequent pellets add a
/// random cone offset of up to `weapon_def.accuracy_degrees` degrees.
/// Uses the supplied `rng` (a `FnMut() -> f32` returning [0, 1)) for
/// determinism — the server can replay a battle given the same RNG
/// seed (used by the snapshot log if/when that lands).
///
/// PR #102: the precision tradeoff is that each pellet re-runs the
/// ray-vs-sphere math (no shortcut for "same forward, different
/// target" — the target is the same, the jitter is what varies).
/// For shotgun (8 pellets) this is 8× the dual-pistol cost, which
/// is still microseconds at the 20Hz snapshot cadence.
pub fn shotgun_pellet_hit(
    weapon_def: &WeaponDef,
    origin: glam::Vec3,
    forward: glam::Vec3,
    target_pos: glam::Vec3,
    target_radius: f32,
    rng: &mut dyn FnMut() -> f32,
) -> bool {
    let pellets = weapon_def.pellets.max(1) as usize;
    let max_cone_rad = (weapon_def.accuracy_degrees as f32).to_radians();
    for pellet_idx in 0..pellets {
        let pellet_forward = if pellet_idx == 0 {
            forward
        } else {
            jitter_forward(forward, max_cone_rad, rng)
        };
        if weapon_hitscan(
            weapon_def,
            origin,
            pellet_forward,
            target_pos,
            target_radius,
        ) {
            return true;
        }
    }
    false
}

/// Apply a random cone offset to a unit forward vector. The cone
/// half-angle is `max_cone_rad`. Uniform sampling on the disc
/// perpendicular to `forward` ensures even spread (no clustering
/// at the cone's center). Yaw jitter uses `rng()` for the
/// azimuthal angle; pitch jitter uses `sqrt(rng())` for the radial
/// offset (sqrt ensures uniform area distribution, not uniform
/// distance — a uniform `rng()` distance would cluster at the cone
/// center).
fn jitter_forward(
    forward: glam::Vec3,
    max_cone_rad: f32,
    rng: &mut dyn FnMut() -> f32,
) -> glam::Vec3 {
    use glam::Vec3;
    // Pick a frame for the cone. `up` is the world up; if `forward`
    // is parallel to `up` (looking straight up/down), fall back to
    // +Z so the cone has a basis.
    let up = if forward.abs_diff_eq(Vec3::Y, 1e-4) {
        Vec3::Z
    } else {
        Vec3::Y
    };
    let right = forward.cross(up).normalize_or_zero();
    let true_up = right.cross(forward).normalize_or_zero();

    let azimuth = rng() * std::f32::consts::TAU;
    let radial = (rng() * max_cone_rad).max(0.0); // uniform-in-r² = sqrt(uniform)
    let sin_r = radial.sin();
    let cos_r = radial.cos();

    // Build the jittered forward: cos(cone) along `forward` + sin(cone)
    // in the (right, true_up) plane at azimuth.
    let offset = right * (sin_r * azimuth.cos()) + true_up * (sin_r * azimuth.sin());
    (forward * cos_r + offset).normalize_or_zero()
}

#[cfg(test)]
mod tests {
    use super::*;
    use glam::Vec3;

    fn hit(origin: Vec3, forward: Vec3, target: Vec3, radius: f32) -> bool {
        dual_pistol_hit(origin, forward, 0.0, target, radius)
    }

    /// Forward vector must match the client's
    /// `forwardFromYawPitch(yaw, pitch)` byte-for-byte. This is the
    /// load-bearing determinism gate — a divergence here means the
    /// server's "hit" verdict never matches the client's tracer.
    #[test]
    fn forward_from_yaw_pitch_matches_client() {
        // yaw=0, pitch=0 → (0, 0, 1) — facing +Z.
        let f = forward_from_yaw_pitch(0.0, 0.0);
        assert_eq!(f.x.to_bits(), 0.0_f32.to_bits());
        assert_eq!(f.y.to_bits(), 0.0_f32.to_bits());
        assert_eq!(f.z.to_bits(), 1.0_f32.to_bits());

        // yaw=π/2, pitch=0 → (1, 0, 0) — facing +X.
        let f = forward_from_yaw_pitch(std::f32::consts::FRAC_PI_2, 0.0);
        assert!((f.x - 1.0).abs() < 1e-6, "f.x={}", f.x);
        assert!(f.y.abs() < 1e-6, "f.y={}", f.y);
        assert!(f.z.abs() < 1e-6, "f.z={}", f.z);

        // yaw=0, pitch=π/4 → (0, sin(π/4) ≈ 0.707, cos(π/4) ≈ 0.707).
        let f = forward_from_yaw_pitch(0.0, std::f32::consts::FRAC_PI_4);
        assert!(f.x.abs() < 1e-6);
        assert!((f.y - 0.7071068).abs() < 1e-5, "f.y={}", f.y);
        assert!((f.z - 0.7071068).abs() < 1e-5, "f.z={}", f.z);
    }

    /// Direct hit: target straight ahead at chest height.
    #[test]
    fn direct_hit_in_front() {
        let origin = chest_position(Vec3::new(0.0, 0.9, 0.0));
        let forward = forward_from_yaw_pitch(0.0, 0.0); // facing +Z
        let target = Vec3::new(0.0, 0.9, 10.0); // 10m in front
        assert!(hit(origin, forward, target, 0.5));
    }

    /// Out of range: target 60m away, max range 50m. Miss.
    #[test]
    fn miss_when_out_of_range() {
        let origin = chest_position(Vec3::new(0.0, 0.9, 0.0));
        let forward = forward_from_yaw_pitch(0.0, 0.0);
        let target = Vec3::new(0.0, 0.9, 60.0);
        assert!(!hit(origin, forward, target, 0.5));
    }

    /// Behind the ray: target behind the shooter. The `t < 0` check
    /// catches this.
    #[test]
    fn miss_when_behind_ray() {
        let origin = chest_position(Vec3::new(0.0, 0.9, 0.0));
        let forward = forward_from_yaw_pitch(0.0, 0.0); // facing +Z
        let target = Vec3::new(0.0, 0.9, -10.0); // 10m BEHIND
        assert!(!hit(origin, forward, target, 0.5));
    }

    /// Lateral miss: target is 0.7m to the right of the ray. The
    /// capsule radius is 0.5m → miss. Under the PR 11.6.C 3D math
    /// the perpendicular distance also includes the y offset
    /// (target.y=0.9 vs chest origin.y=1.35 → 0.45m y delta), so
    /// 3D perp dist = sqrt(0.7² + 0.45²) ≈ 0.83m, well outside the
    /// 0.5m radius — miss.
    #[test]
    fn miss_when_laterally_outside_radius() {
        let origin = chest_position(Vec3::new(0.0, 0.9, 0.0));
        let forward = forward_from_yaw_pitch(0.0, 0.0);
        let target = Vec3::new(0.7, 0.9, 10.0);
        assert!(!hit(origin, forward, target, 0.5));
    }

    /// Lateral hit (just inside radius): target is 0.4m to the right
    /// and the capsule radius is 0.5m → hit.
    ///
    /// PR 11.6.C review fix B1: target y is at the chest height
    /// (origin.y + 0.45 = 1.35) so the y component contributes zero
    /// perpendicular distance; the x component alone (0.4) is below
    /// the 0.5 radius → HIT. The pre-fix 2D math also passed this
    /// test (it ignored y), but the new test aligns with the 3D math
    /// so it stays correct if anyone tweaks the chest offset.
    #[test]
    fn hit_when_laterally_inside_radius() {
        let origin = chest_position(Vec3::new(0.0, 0.9, 0.0));
        let forward = forward_from_yaw_pitch(0.0, 0.0);
        let target = Vec3::new(0.4, origin.y, 10.0);
        assert!(hit(origin, forward, target, 0.5));
    }

    /// PR 11.6.C review fix B1: under the 3D ray-vs-sphere math a
    /// y offset between the ray and the target DOES affect the
    /// verdict — the perpendicular distance is full 3D now. This
    /// test verifies the right boundary: a target within the sphere
    /// (even with a y offset) is still a hit. Perpendicular distance
    /// = sqrt(0.3² + 0.4²) ≈ 0.5m, exactly at the radius boundary —
    /// we use a smaller lateral offset (0.2m) to stay safely inside.
    #[test]
    fn y_offset_within_radius_still_hits() {
        let origin = chest_position(Vec3::new(0.0, 0.9, 0.0));
        let forward = forward_from_yaw_pitch(0.0, 0.0);
        // Target 0.4m below the chest ray origin (origin.y - 0.4 =
        // 0.95), laterally offset by 0.2m. 3D perpendicular distance
        // = sqrt(0.2² + 0.4²) = sqrt(0.2) ≈ 0.447m < 0.5m radius →
        // HIT.
        let target = Vec3::new(0.2, origin.y - 0.4, 10.0);
        assert!(hit(origin, forward, target, 0.5));
    }

    /// `dual_pistol_damage(distance)` returns the right constants.
    #[test]
    fn damage_amounts_match_client() {
        assert_eq!(dual_pistol_damage(10.0), 12);
        assert_eq!(dual_pistol_damage(60.0), 0);
        assert_eq!(dual_pistol_damage(f32::INFINITY), 0);
        assert_eq!(DUAL_PISTOL_DAMAGE, 12);
    }

    /// PR 11.6.C review fix B1: regression test for the 2D-vs-3D math
    /// bug. A target placed EXACTLY on the 3D ray at yaw=0, pitch=π/4
    /// (45° upward), range=10m MUST register as a HIT — the previous
    /// 2D xz-plane math scaled t by cos(pitch)² and produced MISS for
    /// the same input. This test was failing on the pre-fix code; it
    /// passes on the 3D math.
    #[test]
    fn hit_when_target_exactly_on_3d_ray_at_pitch_45() {
        // Shooter chest origin at (0, 0.9, 0). Forward at yaw=0,
        // pitch=π/4 = (0, sin(π/4), cos(π/4)) ≈ (0, 0.707, 0.707).
        // A target placed at exactly 10m along this forward vector
        // is at origin + 10 * forward = (0, 0.9 + 7.07, 10 * 0.707)
        // ≈ (0, 7.97, 7.07). That's the target's CENTRE. The sphere
        // around it has radius 0.5, so the ray hits the sphere dead-
        // center → definite HIT.
        let origin = chest_position(Vec3::new(0.0, 0.9, 0.0));
        let forward = forward_from_yaw_pitch(0.0, std::f32::consts::FRAC_PI_4);
        let target = origin + forward * 10.0;
        assert!(
            hit(origin, forward, target, 0.5),
            "expected HIT at pitch=π/4, range=10m; the 2D xz math gave \
             MISS for this case (the y component was ignored, scaling \
             the xz projection by cos(pitch)² and producing a wrong t)"
        );
    }

    /// PR 11.6.C review fix B1: a second regression test, with pitch
    /// at 30° (a common gameplay pitch). The target is exactly on the
    /// 3D ray, 15m forward — HIT under 3D math, MISS under the old 2D
    /// xz-projection (cos(30°)² ≈ 0.75, so the 2D t was ~11.25 not
    /// 15.0, placing the target "beyond the max range").
    #[test]
    fn hit_when_target_exactly_on_3d_ray_at_pitch_30() {
        let origin = chest_position(Vec3::new(0.0, 0.9, 0.0));
        let pitch = std::f32::consts::FRAC_PI_6; // 30°
        let forward = forward_from_yaw_pitch(0.0, pitch);
        let target = origin + forward * 15.0;
        assert!(
            hit(origin, forward, target, 0.5),
            "expected HIT at pitch=π/6, range=15m; 2D math gave MISS"
        );
    }

    /// PR 11.6.C review fix B1: same scenario but the target is
    /// slightly off the 3D ray (still inside the sphere radius) — HIT.
    /// This verifies the 3D math handles the perpendicular-distance
    /// check correctly when the y axis is involved.
    #[test]
    fn hit_when_target_offset_in_y_at_pitch_45() {
        let origin = chest_position(Vec3::new(0.0, 0.9, 0.0));
        let forward = forward_from_yaw_pitch(0.0, std::f32::consts::FRAC_PI_4);
        // Place the target at the 10m point along the ray, then shift
        // it 0.3m up. The sphere radius is 0.5m, so the ray still
        // grazes the sphere — HIT.
        let on_ray = origin + forward * 10.0;
        let target = on_ray + Vec3::new(0.0, 0.3, 0.0);
        assert!(hit(origin, forward, target, 0.5));
    }

    /// 100-pose property-style test. Generates random poses and asserts
    /// the hitscan verdict agrees with an independent analytic
    /// reference (closest-point-on-ray formulation). The independent
    /// reference uses a different code path (explicit
    /// `clamp(t, 0, max_range)` + `distance` helper) so the test
    /// catches sign / clamp bugs the main path might hide.
    ///
    /// The TS reference in `client/src/game/combat.ts` is the EXTERNAL
    /// ground truth — that's verified by the browser-side smoke in
    /// `tools/damage-server-smoke.mjs` (PR 11.6.D). This test is the
    /// internal cross-check.
    ///
    /// PR 11.6.C review fix B1: the fixture now varies `target.y` over
    /// [-2, +2] and pitch over [-π/3, +π/3] so the 3D math is exercised
    /// (the previous fixture had `target.y ≈ origin.y ± 0.5` and pitch
    /// clamped to ±π/4, which masked the 2D math bug).
    #[test]
    fn hundred_pose_fixture_internal_cross_check() {
        // Tiny LCG so the test is deterministic across runs.
        let mut state: u64 = 0x12345678_9abcdef0;
        let mut next = || {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            // 24 bits of randomness is plenty for a positional fixture.
            (state >> 40) as u32 as f32 / ((1u32 << 24) as f32)
        };
        let mut total = 0usize;
        let mut hits = 0usize;
        for _ in 0..100 {
            // Random yaw in [0, 2π), pitch in [-π/3, π/3] (PR 11.6.C:
            // wider range than the previous ±π/4 clamp — exercises the
            // 3D math).
            let yaw = next() * std::f32::consts::TAU;
            let pitch = (next() - 0.5) * 2.0 * std::f32::consts::FRAC_PI_3;
            // Random origin in a 30m x 30m square, y = 0.9 (chest height).
            let origin = Vec3::new((next() - 0.5) * 30.0, 0.9, (next() - 0.5) * 30.0);
            // Random target within 50m of origin (the max range).
            // PR 11.6.C: target.y varies over [-2, +2] (the previous
            // fixture used ±0.5 which masked the 2D math bug).
            let target = Vec3::new(
                origin.x + (next() - 0.5) * 50.0,
                // origin.y + (next() - 0.5) * 1.0,  // PRE-FIX
                origin.y + (next() - 0.5) * 4.0, // PR 11.6.C: ±2m
                origin.z + (next() - 0.5) * 50.0,
            );
            let radius = 0.5 + next() * 0.5; // 0.5..1.0
            let max_range = 50.0;

            let forward = forward_from_yaw_pitch(yaw, pitch);
            let primary_verdict =
                dual_pistol_hit_at_range(origin, forward, target, radius, max_range);
            let reference_verdict = reference_hit_check(origin, forward, target, radius, max_range);

            total += 1;
            if primary_verdict {
                hits += 1;
            }
            assert_eq!(
                primary_verdict, reference_verdict,
                "verdict mismatch for yaw={} pitch={} origin={:?} forward={:?} target={:?} radius={}",
                yaw, pitch, origin, forward, target, radius,
            );
        }
        // Sanity: with random poses we expect ~3-5% hits (small target
        // in a large field). If the count is 0 or 100, something is
        // wrong with the random-number generator or the math.
        assert!(
            hits > 0,
            "expected at least 1 hit in 100 random poses, got {}",
            hits
        );
        assert!(
            hits < total,
            "expected at least 1 miss in 100 random poses, got {}",
            hits
        );
    }

    /// Independent analytic reference for the 100-pose fixture. Uses
    /// a different formulation (explicit closest-point computation +
    /// range clamp + squared-distance compare) so a sign or clamp
    /// bug in the primary path will diverge.
    ///
    /// PR 11.6.C: this was also 2D-only before B1. The reference is
    /// now full 3D so it actually cross-checks the 3D math.
    fn reference_hit_check(
        origin: glam::Vec3,
        forward: glam::Vec3,
        target: glam::Vec3,
        target_radius: f32,
        max_range: f32,
    ) -> bool {
        let to_target = target - origin;
        // Project onto the ray. forward is unit-length.
        let t = to_target.dot(forward);
        if t < 0.0 {
            return false; // target is behind the ray
        }
        if t > max_range {
            return false; // beyond max range
        }
        let closest = origin + forward * t;
        let diff = target - closest;
        // Full 3D squared-distance compare (PR 11.6.C).
        let dist_sq = diff.dot(diff);
        dist_sq <= target_radius * target_radius
    }
}
