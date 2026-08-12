// Phase 0 / PR 3 — tunable physics + animation constants for the character.
//
// **Spec rule (docs/SPEC.md §"Havok capsule behavior")**: "Tune anything in
// `client/src/engine/characterConfig.ts` — never hard-code in the controller."
// This file is the single source of truth for every number the controller
// reads. Stunts (dive, slide, wallrun) are animation-state only in PR 3 — they
// swap *values from this file* (speed, friction, jump Z, visual offset) rather
// than bending the collision shape. Stunt-as-physics is a Phase 1 polish item.

import { Vector3 } from "@babylonjs/core";

/** Capsule shape for the Havok PhysicsCharacterController. */
export const CAPSULE = {
  /** Per spec: 0.5m radius. */
  radius: 0.5,
  /** Per spec: 1.8m total height (top-to-bottom). */
  height: 1.8,
} as const;

/** Slope + step parameters for the Havok controller. */
export const SLOPE_AND_STEP = {
  /** 45° in radians — per spec. */
  slopeLimit: Math.PI * 0.25,
  /** 0.3m step-up per spec. */
  stepOffset: 0.3,
  /**
   * Strict step cap exposed on the controller itself. Matches `stepOffset` so
   * the controller enforces the same value whether the lift comes from the
   * rounded capsule bottom or the step-up sweep.
   */
  maxStepHeight: 0.3,
} as const;

/** Locomotion tunables — read each frame by the controller's input pump. */
export const MOVEMENT = {
  /** Top walking speed in m/s. */
  walkSpeed: 5.0,
  /** Planar acceleration toward the desired velocity (m/s²). */
  walkAcceleration: 35.0,
  /** Initial vertical velocity when Space is tapped (positive = up). */
  jumpZ: 5.2,
  /** Gravity vector applied via `integrate()`. Matches scene gravity. */
  gravity: new Vector3(0, -9.81, 0),
} as const;

/** Stunt tunables (animation-state only — no physics deformation). */
export const STUNTS = {
  /** Dive: forward boost + lower friction + visual lean for `durationMs`. */
  dive: {
    durationMs: 800,
    forwardBoost: 6.0,
    frictionMultiplier: 0.4,
    leanDegrees: 25,
  },
  /** Slide: lowered capsule center + reduced friction for as long as C is held. */
  slide: {
    frictionMultiplier: 0.2,
    speedMultiplier: 1.3,
    centerDrop: 0.35,
  },
  /** Wallrun: tap Q mid-air near a wall to attach for `durationMs`. */
  wallrun: {
    durationMs: 1000,
    upwardVelocity: 3.5,
    forwardVelocity: 3.0,
  },
} as const;

/** Chase camera tunables. */
export const CAMERA = {
  /** Third-person offset from the character (behind, above). */
  thirdPersonOffset: new Vector3(0, 1.5, -2.8),
  /** First-person offset from the character (eye height, no back-off). */
  firstPersonOffset: new Vector3(0, 1.6, 0),
  /** Look-at point relative to the character (chest height). */
  lookAtOffset: new Vector3(0, 0.9, 0),
  /** Lerp factor for the chase position (0 = no follow, 1 = snap). */
  followLerp: 0.25,
  /** Lerp factor for the look-at target. */
  lookLerp: 0.35,
  /** Vertical FOV (degrees). */
  fovDegrees: 65,
} as const;

/** Spawn position for the character (capsule centre sits at half-height above ground). */
export const SPAWN_POSITION = new Vector3(0, CAPSULE.height / 2, 0);

/** World gravity (m/s²) — also exposed for the Havok plugin. */
export const WORLD_GRAVITY = MOVEMENT.gravity.clone();
