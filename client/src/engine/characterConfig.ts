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

// PR 78 — client canonical source for `PLAYER_MAX_AMMO`. The server
// (`server/src/constants.rs::PLAYER_MAX_AMMO`) remains the authoritative
// source; this constant is the client's mirror. If the server value
// changes, this constant must change in lockstep (the smoke suite
// validates the value end-to-end).
//
// NB-1 carry-forward from PR 11.7.E: before this constant existed,
// the literal `6` was hardcoded in 8+ client-side sites
// (`gameSession.tryStartReload`'s ammo gate, `scene.ts` reload
// completion edge, `<BulletHud maxAmmo={...} />`, and 4 smoke
// scripts). If `server/src/constants.rs::PLAYER_MAX_AMMO` ever
// changed, every one of those sites would silently break. The
// constant is now imported wherever the literal was.
export const PLAYER_MAX_AMMO: number = 6;

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
  /**
   * PR 11.1.2: third-person-locked offset (over-shoulder). Camera at
   * eye height + 1.6m behind + slightly above character head. Used
   * when the user is pointer-locked and presses V (mode 1). Mouse
   * still rotates the character via the wire-yaw; the camera follows
   * the character's yaw with this back-off. Distinct from
   * `thirdPersonOffset` because (a) the chase lerp is disabled while
   * locked, (b) the offset is much tighter (over-shoulder, not wide
   * chase-cam). Tuned from Kyle's screenshot of the original mod.
   */
  overShoulderOffset: new Vector3(0, 1.7, -1.6),
  /**
   * PR 11.1.2: user-visible viewMode is {0, 1}. Kept as a config
   * value (rather than hardcoded 2) so future expansion is cheap.
   */
  viewModeCount: 2 as const,
  /**
   * PR 11.1.2: menu orbit camera tunables. When pointer-locked=false
   * AND everLocked=true, the camera slowly auto-rotates around the
   * character at `radius` metres, `height` metres above ground, at
   * `angularSpeed` rad/sec. This is the "menu camera" — when ESC
   * opens a pause/loadout menu, the cursor is free and the camera
   * drifts so the menu doesn't feel static.
   */
  menuOrbit: {
    radius: 4.5,
    height: 1.8,
    angularSpeed: 0.3, // rad/sec; one full orbit in ~21s
  },
  /** Look-at point relative to the character (chest height). */
  lookAtOffset: new Vector3(0, 0.9, 0),
  /** Lerp factor for the chase position (0 = no follow, 1 = snap). */
  followLerp: 0.25,
  /** Lerp factor for the look-at target. */
  lookLerp: 0.35,
  /** Vertical FOV (degrees). */
  /** PR 11.7.D2.1 — wider FOV (90° vs the legacy 65°) so the
   *  remote peer rig stays in frame at typical 2-tab distances.
   *  Pre-fix the chase camera's 65° FOV cone covered ±32.5° of
   *  horizontal arc; a peer 2.5m to the side at the chase camera's
   *  ~2.8m back-off fell at ~39° off-axis — visually outside the
   *  cone, so the player only saw their own rig and assumed the
   *  other tab was "broken." 90° (half-angle 45°) comfortably
   *  encloses the peer in the standard 2-tab test setup. The
   *  first-person view inherits the same FOV (Babylon single
   *  UniversalCamera) — the slight widening is acceptable for a
   *  multiplayer context where situational awareness matters more
   *  than the tight 65° immersion. */
  fovDegrees: 90,
} as const;

/**
 * PR 11.1: pointer-locked mouse-look tunables. The chase camera reads
 * `sensitivityRadPerPixel` when applying a mouse-delta to the local yaw
 * accumulator (one mousemove event → `e.movementX * sensitivityRadPerPixel`
 * added to yaw). 0.0025 rad/px ≈ 0.143°/px — comfortable for a typical
 * 1080p display with the OS pointer speed at default; tune via in-game
 * settings later.
 */
export const MOUSE_LOOK = {
  /** Radians of yaw per pixel of mouse-delta. */
  sensitivityRadPerPixel: 0.0025,
} as const;

/**
 * PR 11.4: dev-box free-fly spectator camera tunables. The spectator
 * camera is a debug-only second `UniversalCamera` activated by F2 (or
 * the `__spectatorToggle` DEV probe). The whole block is read only
 * inside the DEV-gated paths in `scene.ts` / `spectatorCamera.ts`,
 * so shipping a value here is safe — production bundles strip the
 * call sites entirely (Vite `import.meta.env.DEV` static removal).
 */
export const SPECTATOR = {
  /** Flat WASD speed in metres per frame (frame-rate-coupled, see
   *  `spectatorCamera.ts` `pumpWASD` for the rationale — accept the
   *  same coupling as the chase camera's lerp). Matches the character
   *  `walkSpeed: 5` so the user feels like they're walking around the
   *  world during dev-box inspection (Kyle's 2026-08-15 playtest —
   *  faster speeds felt jarring). */
  moveSpeed: 5.0,
  /** Toggle key. Read by `inputListener.ts` to register the F2 handler.
   *  Single source of truth — same convention as the existing
   *  `KEY_CAMERA_TOGGLE` (V) lookup pattern. */
  toggleKey: "F2",
} as const;

/** Spawn position for the character (capsule centre sits at half-height above ground). */
export const SPAWN_POSITION = new Vector3(0, CAPSULE.height / 2, 0);

/** World gravity (m/s²) — also exposed for the Havok plugin. */
export const WORLD_GRAVITY = MOVEMENT.gravity.clone();

/**
 * PR 10: health-pool tunables. The HP pool lives on the
 * `CharacterController.state` (see `characterController.ts`) and the
 * damage values are reused from `client/src/game/combat.ts`
 * (`COMBAT.dualPistol.damage = 12`, `COMBAT.melee.damage = 25`). This
 * block owns the *pool size* and the *respawn delay* — the damage
 * application itself lives in `client/src/game/health.ts`.
 */
export const HEALTH = {
  maxHp: 100,
  respawnDelayMs: 1000,
} as const;

// PR 7: combat tunables now live in `client/src/game/combat.ts` as the single
// structured source. The flat `COMBAT` / `BULLET_TIME` placeholders that
// landed in PR 4 are removed — nothing read them, and they shadowed the
// structured tunables in combat.ts.
// PR 10: health tunables now live above (`HEALTH`); combat damage
// constants stay in `combat.ts` so PR 7's `COMBAT` is unchanged.
