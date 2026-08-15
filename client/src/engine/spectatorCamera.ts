// Phase 0 / PR 11.4 — dev-box free-fly spectator camera (debug-only).
//
// **What this is**: a second `UniversalCamera` instantiated lazily on the
// first F2 press, reused across subsequent F2 toggles. When active,
// `scene.activeCamera` swaps to the spectator; when inactive, the chase
// camera takes over at its existing lerp position (no snap).
//
// **Activation**: F2 only (registered unconditionally in DEV by
// `inputListener.ts`; production builds: no listener, no F2 behavior).
// The toggle is also exposed as a DEV probe path (`__spectatorToggle`)
// so the smoke can drive the same path headlessly.
//
// **Movement**: WASD at `SPECTATOR.moveSpeed` (5 m/s flat — matches
// the character `walkSpeed: 5`). Same WASD keys
// as the character controller — the spectator ABSORBS WASD when active
// (`gameSession.ts` gates `controller.update` on `!spectator.active`).
// Movement is applied on top of the current camera yaw / pitch. Direction
// convention: W = forward along camera-forward (XZ-projected), S = back,
// A = left, D = right. Per the locked design there is NO Space (up) /
// Shift (down) modifier — WASD is plain planar at 8 m/s.
//
// **Look**: held-right-click-drag rotates the camera (yaw + pitch
// simultaneously). The right-button drag is the ergonomic model for
// editor free-fly cameras (Blender, Unity Editor). Pitch CLAMPS to
// [-π/2, +π/2] (same convention as the chase camera — wrap would flip
// the view at the limits). Yaw wraps mod 2π. Sensitivity reuses
// `MOUSE_LOOK.sensitivityRadPerPixel` (same value as PR 11.1's yaw +
// PR 11.3's pitch — single source of truth).
//
// **DEV-only gate**: this whole module is wrapped in `import.meta.env.DEV`
// by the caller (`scene.ts`). The `createSpectatorCamera` function itself
// is exported unconditionally, but every call site is DEV-gated; Vite
// strips the call sites in production, so the function is dead code in
// the production bundle (tree-shaken). The DEV probes (window.*) are
// registered in the same DEV block.
//
// **No collision, no gravity, no physics integration**: free-fly is
// truly free — the spectator can fly through crates / floor / sky. This
// is intentional (dev-box inspection ergonomics). If we ever want
// collision, add a `PhysicsRaycast` floor check (deferred follow-up).

import { UniversalCamera, Vector3, type Scene } from "@babylonjs/core";

import { MOUSE_LOOK, SPECTATOR } from "./characterConfig";

/** Result of `createSpectatorCamera`. */
export interface SpectatorCameraHandle {
  /** The Babylon camera instance. The scene swaps `scene.activeCamera`
   *  to this on enter, back to the chase camera on exit. */
  readonly camera: UniversalCamera;
  /** True while the spectator is active (F2 entered, not yet exited). */
  isActive: () => boolean;
  /** Enter spectator mode at the given world position. If already
   *  active, no-op (call `exit()` first if you want to teleport). */
  enter: (worldPosition: Vector3) => void;
  /** Exit spectator mode. Restores `scene.activeCamera` to the chase
   *  camera. If already inactive, no-op. */
  exit: () => void;
  /** Programmatic toggle. Returns the new active state. */
  toggle: (chaseCameraPosition: Vector3) => boolean;
  /** Move the spectator by `(dx, dy, dz)` (world units). Used by the
   *  smoke's `__spectatorMoveDelta` probe (bypasses the keyboard for
   *  headless determinism). */
  moveDelta: (dx: number, dy: number, dz: number) => void;
  /** Apply a yaw delta (radians, wraps mod 2π). Same convention as
   *  `chase.applyYawDelta`. Used by the smoke's `__spectatorYawDelta`
   *  probe. */
  applyYawDelta: (deltaRadians: number) => void;
  /** Apply a pitch delta (radians, CLAMPS to [-π/2, +π/2]). Same
   *  convention as `chase.applyPitchDelta`. Used by the smoke's
   *  `__spectatorPitchDelta` probe. */
  applyPitchDelta: (deltaRadians: number) => void;
  /** Current yaw (radians, 0..2π). */
  getYaw: () => number;
  /** Current pitch (radians, [-π/2, +π/2]). */
  getPitch: () => number;
  /** Drives the per-frame WASD pump. Called from `scene.ts`'s render
   *  loop ONLY when `spectator.isActive() === true` — cheaper than
   *  doing the active-check inside the function. */
  /** Per-frame WASD pump. `deltaSeconds` is the frame time in
   *  seconds (from `engine.getDeltaTime() / 1000`) — frame-rate-
   *  independent m/s so the speed feels the same at 30fps or 144fps. */
  pumpWASD: (input: { forward: number; right: number }, deltaSeconds: number) => void;
  /** Tear down. Detach mouse listeners if attached. */
  dispose: () => void;
}

const TWO_PI = 2 * Math.PI;
const HALF_PI = Math.PI / 2;

/**
 * Build a spectator camera and wire up the right-click-drag mouse
 * handlers. The camera is instantiated lazily here (one allocation
 * per session — reused across F2 toggles). The mouse listeners are
 * attached at construction time (they're no-ops while inactive —
 * the listener just records movement deltas without applying them
 * unless `active === true`).
 *
 * Returns a handle the caller (`scene.ts`) drives via `enter()` /
 * `exit()` / `pumpWASD()` from the render loop.
 */
export function createSpectatorCamera(
  scene: Scene,
  chaseCamera: UniversalCamera,
): SpectatorCameraHandle {
  // ---- Camera -----------------------------------------------------------
  // Initial position is the chase camera's current position; scene.ts
  // calls `enter(worldPos)` to teleport to a specific point. The camera
  // is detached from controls (no `attachControl`) because WASD / mouse
  // are driven by our own pump + drag handlers — Babylon's built-in
  // inputs would fight us.
  const camera = new UniversalCamera("spectator", new Vector3(0, 1.5, -2.8), scene);
  // Slightly wider than chase's 65° vertical FOV for free-fly ergonomics
  // (60° horizontal here, narrower vertical FOV in chase). YAGNI to
  // expose a knob; tune via direct edit if it matters.
  camera.fov = (60 * Math.PI) / 180;
  camera.minZ = 0.1;
  camera.maxZ = 1000;
  camera.inertia = 0; // free-fly should be 1:1 — no smoothing
  camera.inputs.clear();

  // ---- State -----------------------------------------------------------
  let active = false;
  let yawRadians = 0;
  let pitchRadians = 0;
  let rightDragActive = false;

  // ---- Right-click-drag handlers --------------------------------------
  // Bound on `window` (not canvas — spectator is full-screen, the chase
  // camera's pointer-lock state is irrelevant while spectator is active).
  // The handlers fire only when `active === true`; otherwise they're
  // no-ops. We don't unbind/rebind on enter/exit because the listeners
  // are cheap (one `if` each) and binding in a constructor then later
  // toggling in handlers is the convention used elsewhere in this repo
  // (see `inputListener.ts`'s `setPressed` pattern).
  const onMouseDown = (e: MouseEvent): void => {
    if (!active) return;
    if (e.button === 2) rightDragActive = true;
  };
  const onMouseUp = (e: MouseEvent): void => {
    if (!active) return;
    if (e.button === 2) rightDragActive = false;
  };
  const onMouseMove = (e: MouseEvent): void => {
    if (!active) return;
    if (!rightDragActive) return;
    if (e.movementX !== 0) {
      yawRadians =
        ((yawRadians + e.movementX * MOUSE_LOOK.sensitivityRadPerPixel) % TWO_PI + TWO_PI) % TWO_PI;
    }
    if (e.movementY !== 0) {
      // PR 11.3 sign convention (also applied to the chase camera):
      // browser reports movementY > 0 for mouse-DOWN; FPS convention
      // is "mouse down = look down = negative pitch", so we negate.
      pitchRadians = Math.max(
        -HALF_PI,
        Math.min(
          HALF_PI,
          pitchRadians + (-e.movementY) * MOUSE_LOOK.sensitivityRadPerPixel,
        ),
      );
    }
    // Apply yaw/pitch to the camera immediately so the visible view
    // updates while dragging (not just on toggle/exit). Babylon's
    // camera.rotation uses Y-up Euler — positive rotation.x looks DOWN,
    // so we negate pitchRadians to make positive pitch mean "look up".
    camera.rotation.y = yawRadians;
    camera.rotation.x = -pitchRadians;
  };
  // Suppress the context menu while the spectator is active (the
  // right-drag is the canonical look control). Without this, every
  // RMB press fires the browser's context menu and breaks the drag.
  // We bind the listener unconditionally and let it no-op when the
  // spectator is inactive (so the chase camera's RMB melee behavior
  // — also bound at window-level by inputListener — keeps working).
  const onContextMenu = (e: MouseEvent): void => {
    if (!active) return;
    e.preventDefault();
  };

  if (typeof window !== "undefined") {
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("contextmenu", onContextMenu);
  }

  // ---- Active-camera management ----------------------------------------
  // We save the previous `scene.activeCamera` so we can restore it on
  // exit. Almost always the chase camera, but defensively we record
  // whatever was active before `enter()`.
  let prevActiveCamera: UniversalCamera | null = null;

  const enter = (worldPosition: Vector3): void => {
    if (active) return;
    // Seed the spectator position from the supplied world position (the
    // chase camera's current position when scene.ts calls enter()). The
    // camera's `rotation` is set from the current yaw/pitch so the
    // initial frame renders the same view direction the chase camera
    // had — no visible snap on F2 enter.
    camera.position.copyFrom(worldPosition);
    camera.rotation.set(-pitchRadians, yawRadians, 0);
    prevActiveCamera = scene.activeCamera as UniversalCamera | null;
    scene.activeCamera = camera;
    active = true;
  };

  const exit = (): void => {
    if (!active) return;
    active = false;
    // Restore the previous active camera (almost always the chase
    // camera). The chase camera's `tmpCurrent` lerp accumulator is
    // untouched — it'll resume lerping from wherever the spectator
    // left it, which is fine for the dev-box inspection use case
    // (we don't teleport, we re-attach).
    if (prevActiveCamera) {
      scene.activeCamera = prevActiveCamera;
    } else {
      scene.activeCamera = chaseCamera;
    }
    prevActiveCamera = null;
    // Reset right-drag so the next spectator activation doesn't
    // inherit a stuck state if the user released RMB during exit.
    rightDragActive = false;
  };

  const toggle = (chaseCameraPosition: Vector3): boolean => {
    if (active) {
      exit();
    } else {
      enter(chaseCameraPosition);
    }
    return active;
  };

  // ---- Per-frame WASD pump ---------------------------------------------
  // Called from the render loop in scene.ts. Movement is in WORLD space
  // along the spectator's current yaw (XZ projection — we ignore pitch
  // for the movement direction so W doesn't tilt up/down; the user
  // controls vertical movement via Space/Shift in a real free-fly, but
  // per the locked design, WASD is plain planar at 8 m/s).
  //
  // Convention: W = forward (camera-forward XZ), S = back, A = left
  // (camera-left XZ), D = right. The forward vector comes from the
  // yaw only (no pitch) so W is always horizontal — this is the
  // Blender / Unity Editor free-fly convention.
  const pumpWASD = (input: { forward: number; right: number }, deltaSeconds: number): void => {
    if (!active) return;
    if (input.forward === 0 && input.right === 0) return;
    // Frame-rate-independent metres-per-second. Earlier PR 11.4 versions
    // applied `speed` as a per-frame displacement (= 8 m/frame at 60fps ≈
    // 480 m/s) — felt insane to play. Kyle's 2026-08-15 playtest caught it.
    // Now: displacement = speed * dtSeconds, so 5 m/s means 5 m/s at any
    // framerate. The chase camera's lerp is also frame-rate-coupled but
    // only affects a small delta per frame, not position — switching to
    // dt-scaled math only here.
    const speed = SPECTATOR.moveSpeed;
    const cy = Math.cos(yawRadians);
    const sy = Math.sin(yawRadians);
    // World-forward from yaw (XZ projection): (sin(yaw), 0, cos(yaw)).
    // World-right   from yaw (XZ projection): (cos(yaw), 0, -sin(yaw)).
    //   forward=+1 (W) → move along world-forward.
    //   forward=-1 (S) → move along -world-forward.
    //   right=+1 (D)   → move along world-right.
    //   right=-1 (A)   → move along -world-right.
    // Total: dx = forward*sin(yaw) + right*cos(yaw),
    //        dz = forward*cos(yaw) - right*sin(yaw).
    const dx = (input.forward * sy + input.right * cy) * speed * deltaSeconds;
    const dz = (input.forward * cy - input.right * sy) * speed * deltaSeconds;
    camera.position.x += dx;
    camera.position.z += dz;
  };

  // ---- DEV probes (also used by the smoke) -----------------------------
  const moveDelta = (dx: number, dy: number, dz: number): void => {
    if (!active) return;
    camera.position.x += dx;
    camera.position.y += dy;
    camera.position.z += dz;
  };
  const applyYawDelta = (deltaRadians: number): void => {
    yawRadians = ((yawRadians + deltaRadians) % TWO_PI + TWO_PI) % TWO_PI;
    if (active) camera.rotation.y = yawRadians;
  };
  const applyPitchDelta = (deltaRadians: number): void => {
    pitchRadians = Math.max(
      -HALF_PI,
      Math.min(HALF_PI, pitchRadians + deltaRadians),
    );
    if (active) camera.rotation.x = -pitchRadians;
  };

  return {
    camera,
    isActive: () => active,
    enter,
    exit,
    toggle,
    moveDelta,
    applyYawDelta,
    applyPitchDelta,
    getYaw: () => yawRadians,
    getPitch: () => pitchRadians,
    pumpWASD,
    dispose: () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("mousedown", onMouseDown);
        window.removeEventListener("mouseup", onMouseUp);
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("contextmenu", onContextMenu);
      }
      if (active) exit();
      camera.dispose();
    },
  };
}
