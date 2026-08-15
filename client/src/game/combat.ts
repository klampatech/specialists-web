// Phase 0 / PR 7 — combat semantics: dual-pistol raycast, melee cone hit,
// and per-client bullet-time scaling.
//
// This module is the single source of truth for combat tunables (the
// `COMBAT` constant) and the three combat operations the GameSession calls
// per tick:
//
//   - `dualPistolShoot(input, local, remote, scene)` — cast a ray from the
//     LOCAL controller's chest height along yaw-forward. If the ray hits
//     either the remote rig or a static crate, return a tracer path. Damage
//     application is logged to a returned struct (PR 9 wires real health).
//   - `meleeSwing(input, local, remote)` — if the remote controller's
//     capsule is within `COMBAT.melee.rangeMeters` AND inside the 60°
//     forward-facing cone, return a hit. Uses the existing `isWithinMeleeCone`
//     helper for the cone math.
//   - `bulletTimeScale(input, deltaSeconds)` — when `input.bulletTimeHeld`
//     is true, scale deltaSeconds by `COMBAT.bulletTime.scale = 0.25`. This
//     is applied PER-CLIENT LOCAL before the tick — bullet time is not
//     synced across the wire.
//
// ## Determinism rule (SPEC §"Determinism rule")
//
// Combat code MUST NOT read `Date.now()` / `performance.now()`. The lockstep
// is dt-driven: same dt + same inputs ⇒ same state on both clients. The
// rising-edge detection for fire / melee is local-frame-driven; if the
// peer's last-known input is being replayed while the local tab is in bullet
// time, the rising edge still fires once per press on the LOCAL frame
// counter. Documented in the GameSession header too.
//
// ## Per-client bullet time
//
// When the LOCAL client holds T, only the local tick runs at 0.25x. The
// peer's full-speed tick is replicated through the lockstep normally
// (deltaSeconds is sampled by the engine per-tick, not crossed on the wire).
// Both clients see their own bullet-time visuals simultaneously; the remote
// character still moves at full sim speed in each client's view. This is
// intentional — the SPEC calls out per-player independent bullet time as
// Milestone 2 row 8.
//
// ## Mesh picking
//
// We use Babylon's `scene.pickWithRay(ray, predicate)` to do the dual-pistol
// raycast. The predicate filters out local rig meshes (otherwise the ray
// would self-hit on the chest it starts from), the sky dome, and the
// placeholder ground plane (so misses against the world don't accidentally
// count as crate hits). The remote rig + crate boxes are pickable so they
// can register hits.
//
// The render-only tracer line is created via `MeshBuilder.CreateLines` and
// disposed after `COMBAT.dualPistol.tracerDurationMs` (80ms by default) via
// a plain `window.setTimeout`. Each tracer MUST be disposed exactly once or
// the scene leaks meshes.

import {
  Color3,
  MeshBuilder,
  Ray,
  Vector3,
  type AbstractMesh,
  type Scene,
} from "@babylonjs/core";

import { CAPSULE } from "../engine/characterConfig";
import type {
  CharacterController,
  InputState,
} from "../engine/characterController";

/**
 * Combat tunables — the single source of truth. Real damage application
 * is PR 9+; the damage fields here are logged-only in PR 7 so the HUD
 * can show numbers without mutating world state.
 */
export const COMBAT = {
  dualPistol: {
    fireCooldownMs: 120,
    damage: 12,
    tracerDurationMs: 80,
    tracerColor: "#ffce5a",
    /** Maximum ray range in metres. Picked to comfortably exceed the demo map. */
    maxRangeMeters: 50,
  },
  melee: {
    coneRadians: Math.PI / 3, // 60° total, ±30° from forward
    rangeMeters: 1.5,
    damage: 25,
    swingDurationMs: 220,
  },
  bulletTime: {
    scale: 0.25,
    energyMax: 100,
    energyDrainPerSec: 33,
    energyRechargePerSec: 20,
  },
} as const;

// ---------------------------------------------------------------------------
// Picking predicate
// ---------------------------------------------------------------------------

/**
 * Mesh-name predicate for the dual-pistol raycast. Excludes the LOCAL rig
 * (so the ray doesn't self-hit the chest it originates from), the skydome,
 * and the ground plane. Crates (`crate_*`) and the REMOTE rig are
 * pickable.
 */
function buildCombatPickPredicate(localPrefix: string): (mesh: AbstractMesh) => boolean {
  return (mesh: AbstractMesh): boolean => {
    if (!mesh.isPickable) return false;
    const name = mesh.name;
    // Skip local rig (and any of its body parts).
    if (name.startsWith(localPrefix)) return false;
    // Skip the placeholder ground plane (so misses against the world don't
    // accidentally register as a crate hit on the far side).
    if (name === "ground") return false;
    // Skip the sky dome.
    if (name.startsWith("sky")) return false;
    return true;
  };
}

// ---------------------------------------------------------------------------
// -------------------------------------------------------------------
// Forward vector from yaw + pitch (PR 7+11.1+11.3)
// -------------------------------------------------------------------

/**
 * Compute the 3D forward direction (unit vector) from yaw AND pitch.
 * PR 7 originally hardcoded yaw=0 because no mouse-look existed; PR 11.1
 * added yaw on the wire; PR 11.3 adds pitch on the wire (bytes 4-5).
 *
 *   yaw rotates in the XZ plane (around the world Y axis): yaw=0 means
 *     "facing +Z", yaw=π/2 means "facing +X".
 *   pitch rotates in the local YZ plane (around the local X axis):
 *     pitch=0 means level, +π/2 means "facing +Y" (straight up),
 *     -π/2 means "facing -Y" (straight down).
 *
 * Spherical-ish formula (yaw-pitch roll, no roll):
 *   forwardX = sin(yaw) * cos(pitch)
 *   forwardY = sin(pitch)
 *   forwardZ = cos(yaw) * cos(pitch)
 *
 * This is the same parameterization every FPS uses for camera/aim
 * direction. It's a unit vector for any (yaw, pitch).
 *
 * Why `input.yawRadians` / `input.pitchRadians` and not
 * `localController.state.rotation`:
 *   - `input.yawRadians` and `input.pitchRadians` are what the user just
 *     input (frame-N) — zero lag.
 *   - `localController.state.rotation` lags by 1-2 frames because:
 *       (a) encodeInput happens on frame-N
 *       (b) decodeInput + setYaw / setPitch happens on frame-N+1 (the next tick)
 *       (c) character.state.rotation reflects frame-N+1 yaw
 *     So the tracer would fire in the direction the character USED TO
 *     be facing, which is exactly the "tracer fires where I used to
 *     be facing" bug Kyle reported.
 *   - The tracer is a render-only side-effect (the DualPistolResult is
 *     not fed back to the wire), so using the input yaw/pitch here is
 *     lockstep-safe.
 */
function forwardFromYawPitch(yawRadians: number, pitchRadians: number): Vector3 {
  const cp = Math.cos(pitchRadians);
  return new Vector3(
    Math.sin(yawRadians) * cp,
    Math.sin(pitchRadians),
    Math.cos(yawRadians) * cp,
  );
}


/** Chest-height ray origin: capsule centre plus a quarter-height offset up. */
function chestPosition(controller: CharacterController): Vector3 {
  return controller.state.position.add(new Vector3(0, CAPSULE.height / 4, 0));
}

// ---------------------------------------------------------------------------
// dualPistolShoot
// ---------------------------------------------------------------------------

export interface DualPistolResult {
  hit: boolean;
  /** Always set — even on a miss, the tracer still draws so the player
   *  gets feedback. `tracerFrom` is the chest ray origin; `tracerTo` is
   *  either the hit point or `tracerFrom + forward * maxRangeMeters`. */
  tracerFrom: Vector3;
  tracerTo: Vector3;
  /** What was hit, if anything. The hit point is also `tracerTo`. */
  hitPoint: Vector3 | null;
  /** Damage logged for this shot (PR 9 actually applies it). */
  damage: number;
  /** Cooldown gate result — true when the shot was rejected by cooldown. */
  onCooldown: boolean;
}

/**
 * Cast a raycast from the LOCAL chest forward. If the ray hits the remote
 * rig or a crate, mark it as a hit and log damage.
 *
 * Damage is logged-only in PR 7; PR 9 will replace the void return with a
 * real application to a target's health pool.
 */
export function dualPistolShoot(
  input: InputState,
  localController: CharacterController,
  _remoteController: CharacterController,
  scene: Scene,
): DualPistolResult {
  const origin = chestPosition(localController);
  // PR 11.1 + PR 11.3: derive forward from input.yawRadians AND
  // input.pitchRadians (the current frame's user input). See
  // forwardFromYawPitch() for why this is frame-accurate. Pre-PR-11.3
  // input.pitchRadians is undefined; defaulting to 0 keeps the ray
  // horizontal (level aim) for the upgrade window.
  const yaw = input.yawRadians ?? 0;
  const pitch = input.pitchRadians ?? 0;
  const forward = forwardFromYawPitch(yaw, pitch);
  const range = COMBAT.dualPistol.maxRangeMeters;
  const rayEnd = origin.add(forward.scale(range));
  const ray = new Ray(origin, forward, range);

  // Pick against everything except the local rig + ground + sky.
  const predicate = buildCombatPickPredicate("local_");
  const pick = scene.pickWithRay(ray, predicate);

  let hit = false;
  let hitPoint: Vector3 | null = null;

  if (pick && pick.hit && pick.pickedPoint) {
    hit = true;
    hitPoint = pick.pickedPoint.clone();
  } else {
    // Miss — tracer still draws, but extends to max range.
    hitPoint = rayEnd.clone();
  }

  return {
    hit,
    tracerFrom: origin.clone(),
    tracerTo: hitPoint.clone(),
    hitPoint: hit ? hitPoint : null,
    damage: hit ? COMBAT.dualPistol.damage : 0,
    onCooldown: false, // cooldown is enforced at the call site (rising edge)
  };
}

// ---------------------------------------------------------------------------
// meleeSwing
// ---------------------------------------------------------------------------

export interface MeleeResult {
  hit: boolean;
  /** "remote" if the remote rig was in the cone. */
  target: "remote" | null;
  damage: number;
}

/**
 * Cone-vs-position melee check. Uses the existing `isWithinMeleeCone` helper
 * below — do not write a new one. The helper compares the local controller's
 * forward vector against the vector to the target position.
 */
export function meleeSwing(
  input: InputState,
  localController: CharacterController,
  remoteController: CharacterController,
): MeleeResult {
  const attackerOrigin = chestPosition(localController);
  // PR 11.1 + PR 11.3: derive forward from input.yawRadians AND
  // input.pitchRadians (3D direction), same as dualPistolShoot. The
  // melee cone is a 60° cone around forward; pitch tilts the cone
  // up/down so aiming at a higher / lower target actually hits.
  const yaw = input.yawRadians ?? 0;
  const pitch = input.pitchRadians ?? 0;
  const forward = forwardFromYawPitch(yaw, pitch);
  const targetPos = remoteController.state.position.clone();

  const inCone = isWithinMeleeCone(attackerOrigin, forward, targetPos);
  if (!inCone) return { hit: false, target: null, damage: 0 };
  return { hit: true, target: "remote", damage: COMBAT.melee.damage };
}

// ---------------------------------------------------------------------------
// bulletTimeScale
// ---------------------------------------------------------------------------

/**
 * Apply per-client bullet-time scaling to a frame's deltaSeconds. Returns
 * the scaled dt — never reads the wall clock. Local-only: the GameSession
 * calls this BEFORE stepping the local controller; the remote controller
 * still receives the unscaled dt.
 */
export function bulletTimeScale(input: InputState, deltaSeconds: number): number {
  if (!input.bulletTimeHeld) return deltaSeconds;
  return deltaSeconds * COMBAT.bulletTime.scale;
}

// ---------------------------------------------------------------------------
// renderTracer
// ---------------------------------------------------------------------------

/**
 * Spawn a single tracer line in the scene and dispose it after
 * `COMBAT.dualPistol.tracerDurationMs`. Each call creates exactly one mesh;
 * the timer is the only owner of the disposal. If you skip the timer, the
 * tracer leaks. The tracer is not pickable (ray queries don't hit it).
 */
export function renderTracer(scene: Scene, from: Vector3, to: Vector3): void {
  // `MeshBuilder.CreateLines` builds a `LinesMesh` with the named mesh in
  // the scene; we dispose the LinesMesh via its standard dispose().
  const lines = MeshBuilder.CreateLines(
    "tracer",
    { points: [from, to], updatable: false },
    scene,
  );
  // Apply the configured tracer colour to the line system. `LinesMesh.color`
  // is a Color3 on the Babylon type.
  lines.color = Color3.FromHexString(COMBAT.dualPistol.tracerColor);
  lines.isPickable = false;
  // Schedule the dispose. `window.setTimeout` returns a number id we don't
  // need to track (each tracer is fire-and-forget).
  if (typeof window !== "undefined") {
    window.setTimeout(() => {
      // Guard against the scene being torn down before the timer fires
      // (StrictMode double-mount, hot reload). LinesMesh.dispose() is a
      // no-op if the mesh is already disposed.
      if (!lines.isDisposed()) lines.dispose();
    }, COMBAT.dualPistol.tracerDurationMs);
  }
}

// ---------------------------------------------------------------------------
// Melee cone helper (preserved from PR 4 stub)
// ---------------------------------------------------------------------------

/**
 * Returns true if `target` is within melee range of `attacker` AND inside the
 * forward-facing cone (60° total, half-angle from forward vector). Used by
 * `meleeSwing` and any future combat check that needs to know "is this
 * target in front of me and close enough to hit".
 *
 * Signatures deliberately preserved from the PR 4 stub:
 *   (attacker, forward, target, slop?) => boolean
 *
 * @param attacker Position the cone emanates from (typically the chest).
 * @param forward  Unit vector the attacker is facing. Must be normalised.
 * @param target   Position of the candidate target.
 * @param slop     Optional extra distance added to the range. Useful for
 *                 tests / debugging; combat code passes 0.
 */
export function isWithinMeleeCone(
  attacker: Vector3,
  forward: Vector3,
  target: Vector3,
  slop = 0,
): boolean {
  const delta = target.subtract(attacker);
  const distance = delta.length();
  if (distance > COMBAT.melee.rangeMeters + slop) return false;
  if (distance <= 0) return false;
  // Vector3.Dot returns the cosine of the angle between two unit vectors;
  // compare against cos(halfCone) so target is inside the cone iff the
  // angle from forward to delta is at most halfCone.
  const forwardN = forward.normalize();
  const deltaN = delta.normalize();
  return Vector3.Dot(forwardN, deltaN) >= Math.cos(COMBAT.melee.coneRadians / 2);
}
