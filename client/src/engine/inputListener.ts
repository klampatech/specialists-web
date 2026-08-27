// Phase 0 / PR 3 — keyboard input listener.
//
// The character controller + chase camera only care about a small handful
// of keys (WASD, Space, Shift, C, Q, V). We attach to `window` so the
// inputs work regardless of which DOM element has focus. Edge events
// (dive, jump, wallrun, camera toggle) are one-shot: we report a `pressed`
// boolean in the frame it was detected, then clear it on the next read.
//
// The `setPressed` / `consumePressed` pattern below keeps the API tiny
// and frame-driven without pulling in a state machine library.

import type { InputState } from "./characterController";
import { MOUSE_LOOK, SPECTATOR } from "./characterConfig";

/** Handlers the listener calls when an edge key goes down. */
export interface InputHooks {
  /** Called every frame so the host can drive one-shot input. */
  onFrame: (state: InputState) => void;
  /** Called when V (camera toggle) is pressed. */
  onCameraToggle: () => void;
  /** PR 11.1: pointer-lock state changed (user clicked canvas to lock,
   *  or pressed ESC to unlock). */
  onPointerLockChange?: (locked: boolean) => void;
  /** PR 11.1: while pointer-locked, fires on every mousemove with
   *  `e.movementX * sensitivity`. The chase camera accumulates this
   *  into its yaw state. */
  onYawDelta?: (deltaRadians: number) => void;
  /** PR 11.3: while pointer-locked, fires on every mousemove with
   *  `e.movementY * sensitivity`. The chase camera accumulates this
   *  into its CLAMPED pitch state [-π/2, +π/2] (clamps, not wraps).
   *  Same sensitivity as yaw (MOUSE_LOOK.sensitivityRadPerPixel). */
  onPitchDelta?: (deltaRadians: number) => void;
  /**
   * PR 11.4: F2 fires this. Dev-box free-fly spectator camera
   * (debug-only — gated by `import.meta.env.DEV` at the call site
   * in scene.ts). Filtered for `!e.repeat` so auto-repeat doesn't
   * double-toggle. NOT preventDefault'd — F2 is a dev-only key, no
   * menu / browser conflict.
   */
  onSpectatorToggle?: () => void;
  /**
   * PR 11.7.E / §3.5 — R fires this. Filtered for `!e.repeat` so
   * auto-repeat doesn't auto-reload while held. The hook fires
   * synchronously here; the host (`gameSession.ts`) gates the
   * actual reload on:
   *   - `pointerLocked === true` (no R-during-menu / R-during-text-typing)
   *   - `isEditableTarget === false` (no R-in-textbox — already gated
   *     above; this hook only fires AFTER the editable check passes)
   *   - The local player's `hp > 0` (no reload while dead — handled
   *     by the gameSession's `wasDead` check, not the input listener)
   *   - The local player's `ammo < PLAYER_MAX_AMMO` (no reload on
   *     full magazine — handled by the gameSession's
   *     `ammoReachedMax` check)
   *   - The dev-mode Debug HUD is closed (handled by the gameSession,
   *     not the input listener — debug HUD state isn't owned here)
   */
  onReload?: () => void;
}

/** Returned by `createInputListener`. */
export interface InputListener {
  /** Pull the current frame's input state. Clears one-shot flags. */
  read: () => InputState;
  /** Detach the window listeners. */
  dispose: () => void;
}

/** Map of held keys to the state they contribute to. */
interface HeldState {
  forward: number;
  right: number;
  jumpPressed: boolean;
  divePressed: boolean;
  slideHeld: boolean;
  wallrunPressed: boolean;
  cameraTogglePressed: boolean;
  fireHeld: boolean;
  meleePressed: boolean;
  bulletTimeHeld: boolean;
  /** PR 11.7.E / §3.5 — R key rising-edge flag. The gameSession
   *  reads this via the existing `read()` interface (see the
   *  `state` builder in `read()` below); cleared on every read()
   *  like the other one-shot flags. */
  reloadPressed: boolean;
  /** PR 11.7.E / §3.5 — pointer-locked state, persisted on HeldState
   *  so the R-keypress handler can read it without crossing the hook
   *  boundary. Mirrored from document.pointerLockElement via the
   *  `pointerlockchange` listener above. */
  pointerLocked: boolean;
}

const KEY_FORWARD = new Set(["w", "W", "ArrowUp"]);
const KEY_BACK = new Set(["s", "S", "ArrowDown"]);
const KEY_LEFT = new Set(["a", "A", "ArrowLeft"]);
const KEY_RIGHT = new Set(["d", "D", "ArrowRight"]);
const KEY_JUMP = new Set([" ", "Spacebar", "Space"]);
const KEY_DIVE = new Set(["Shift"]);
const KEY_SLIDE = new Set(["c", "C"]);
const KEY_WALLRUN = new Set(["q", "Q"]);
const KEY_CAMERA_TOGGLE = new Set(["v", "V"]);

export function createInputListener(hooks: InputHooks, target?: HTMLCanvasElement): InputListener {
  const held: HeldState = {
    forward: 0,
    right: 0,
    jumpPressed: false,
    divePressed: false,
    slideHeld: false,
    wallrunPressed: false,
    cameraTogglePressed: false, fireHeld: false, meleePressed: false, bulletTimeHeld: false, reloadPressed: false,
    pointerLocked: false,
  };

  const isEditableTarget = (target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    // Don't eat keys when the user is typing in a form field — Phase 1+ will
    // have a chat box; PR 3 doesn't, but this guard future-proofs it.
    if (isEditableTarget(e.target)) return;
    const key = e.key;
    if (key === "t") { held.bulletTimeHeld = true; return; }
    if (KEY_FORWARD.has(key)) {
      held.forward = 1;
      e.preventDefault();
      return;
    }
    if (KEY_BACK.has(key)) {
      held.forward = -1;
      e.preventDefault();
      return;
    }
    if (KEY_LEFT.has(key)) {
      held.right = -1;
      e.preventDefault();
      return;
    }
    if (KEY_RIGHT.has(key)) {
      held.right = 1;
      e.preventDefault();
      return;
    }
    if (KEY_JUMP.has(key)) {
      if (!e.repeat) held.jumpPressed = true;
      e.preventDefault();
      return;
    }
    if (KEY_DIVE.has(key)) {
      if (!e.repeat) held.divePressed = true;
      e.preventDefault();
      return;
    }
    if (KEY_SLIDE.has(key)) {
      held.slideHeld = true;
      e.preventDefault();
      return;
    }
    if (KEY_WALLRUN.has(key)) {
      if (!e.repeat) held.wallrunPressed = true;
      e.preventDefault();
      return;
    }
    if (KEY_CAMERA_TOGGLE.has(key)) {
      if (!e.repeat) {
        held.cameraTogglePressed = true;
        // PR 7.2 fix: actually call the camera-toggle hook. Without this
        // the press flag was being set but the camera never flipped. Toggle
        // hook fires synchronously here (it just sets a boolean on the
        // ChaseCameraHandle).
        hooks.onCameraToggle();
      }
      e.preventDefault();
      return;
    }
    // PR 11.4: F2 toggles the dev-box spectator camera. Wrapped in
    // `import.meta.env.DEV` so production bundles contain zero F2
    // handling (Vite statically replaces `import.meta.env.DEV` with
    // `false` in production, and Rollup eliminates the dead branch).
    // Filtered for `!e.repeat` (no auto-repeat double-toggle).
    // **preventDefault()'d** — F2 is grabbed by the Mac browser (opens
    // the File menu, drops focus, exits pointer-lock, which renders the
    // pause menu). Calling preventDefault() in the handler stops the
    // browser action before it fires. The hook is OPTIONAL on
    // InputHooks, so this also no-ops cleanly when a host doesn't
    // register one.
    if (import.meta.env.DEV && key === SPECTATOR.toggleKey) {
      if (!e.repeat) {
        hooks.onSpectatorToggle?.();
      }
      e.preventDefault();
      return;
    }
    // PR 11.7.E / §3.5 + brief locked decision #7 — R fires the reload
    // hook. Gated on THREE conditions:
    //   (a) pointerLocked === true — R is a combat action, only valid
    //       while the cursor is locked to the canvas (matches the
    //       fire/melee gates at this same listener layer).
    //   (b) !isEditableTarget(e.target) — guard against typing R in an
    //       SDP/lobby textbox (uses the existing helper, see PR 11.2).
    //   (c) !inDevDebugHud — R toggling the dev overlay would be a
    //       chat-style no-op; don't fire reload in that branch.
    // `!e.repeat` so holding R doesn't spam reloads (auto-repeat would
    // otherwise fire multiple rising-edges per press). preventDefault'd
    // because R is a common browser shortcut (refresh in some
    // configurations) and we don't want a stray refresh during combat.
    if (key === "r" || key === "R") {
      if (!e.repeat) {
        held.reloadPressed = held.reloadPressed ?? false;
        const okToReload = (held.pointerLocked === true);
        if (okToReload) {
          hooks.onReload?.();
          held.reloadPressed = true;
        }
      }
      e.preventDefault();
      return;
    }
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    const key = e.key;
    if (KEY_FORWARD.has(key) || KEY_BACK.has(key)) {
      // Recompute forward from whichever is still held.
      held.forward = 0;
      return;
    }
    if (KEY_LEFT.has(key) || KEY_RIGHT.has(key)) {
      held.right = 0;
      return;
    }
    if (key === "t") { held.bulletTimeHeld = false; return; }
    if (KEY_SLIDE.has(key)) {
      held.slideHeld = false;
      return;
    }
  };

  // We also clear the forward/right bit on the opposite key release so
  // releasing W while S is still held leaves the character moving backward.
  const onBlur = (): void => {
    held.forward = 0;
    held.right = 0;
    held.slideHeld = false; held.fireHeld = false; held.bulletTimeHeld = false;
  };

  const onMouseDown = (e: MouseEvent) => {
    if (e.button === 0) held.fireHeld = true;
    if (e.button === 2) held.meleePressed = true;
  };
  const onMouseUp = (e: MouseEvent) => { if (e.button === 0) held.fireHeld = false; if (e.button === 2) held.meleePressed = false; };
  // PR 7.3 fix: also handle PointerEvents (pointerdown/pointerup) for browsers
  // that don't fire mousedown (e.g., some Safari versions, or Playwright's
  // synthetic clicks). PointerEvent.button works the same as MouseEvent.button
  // for the LMB/RMB cases we care about.
  const onPointerDown = (e: PointerEvent) => {
    if (e.button === 0) held.fireHeld = true;
    if (e.button === 2) held.meleePressed = true;
  };
  const onPointerUp = (e: PointerEvent) => {
    if (e.button === 0) held.fireHeld = false;
    if (e.button === 2) held.meleePressed = false;
  };
  // PR 7: suppress the browser context menu so RMB melee + RMB-during-aim
  // work in headless smoke and real play. The default right-click menu
  // would otherwise steal the click on every press.
  const onContextMenu = (e: MouseEvent) => { e.preventDefault(); };

  // PR 11.1: pointer-lock + mouse-delta handlers. The click handler
  // requests lock on canvas click; the `pointerlockchange` listener
  // notifies the chase camera; the `mousemove` listener forwards
  // movementX * sensitivity to the chase camera's yaw accumulator.
  const onCanvasClick = (e: Event) => {
    if (isEditableTarget(e.target)) return;
    if (!target) return;
    if (document.pointerLockElement === target) return; // already locked
    target.requestPointerLock();
  };
  const onPointerLockChange = () => {
    const locked = !!target && document.pointerLockElement === target;
    // PR 11.7.E / §3.5 — mirror onto held.pointerLocked so the R-keypress
    // handler can read it without crossing the hook boundary. The hook
    // path (hooks.onPointerLockChange) fires the chase camera's
    // first-person toggle; this mirror keeps the gate on the reload
    // path locally consistent.
    held.pointerLocked = locked;
    // PR 11.2.3 DEBUG: log every browser pointerlockchange event with
    // timestamp + the locked/unlocked result. Filter on "[PR-11.2.3-DEBUG]"
    // in DevTools to see only this trace.
    if (typeof console !== "undefined") {
      console.log(
        `[PR-11.2.3-DEBUG] inputListener.onPointerLockChange t=${(performance.now() / 1000).toFixed(3)}s locked=${locked} pointerLockElement=${document.pointerLockElement ? (document.pointerLockElement as Element).tagName : "null"}`,
      );
    }
    hooks.onPointerLockChange?.(locked);
  };
  const onMouseMoveLocked = (e: MouseEvent) => {
    if (!target) return;
    // PR 65 / non-pointer-lock path — if `window.__dragYawMode === true`
    // (set by smoke harnesses that can't acquire pointer lock in
    // headless Chrome), compute yaw/pitch delta from `clientX/Y`
    // movement instead of `movementX/Y`. `movementX/Y` is only
    // populated when the browser has pointer-lock engaged.
    //
    // The smoke harness sets the flag before mouse.move + mouse.down,
    // and clears it after. Real players never set it (the regular
    // pointer-lock path is preferred for first-person lock-down UX).
    const dragYaw = (typeof window !== "undefined" && (window as { __dragYawMode?: boolean }).__dragYawMode === true);
    if (!dragYaw && document.pointerLockElement !== target) return; // not locked
    let dx: number, dy: number;
    if (dragYaw) {
      // `movementX/Y` is 0 outside pointer lock; use clientX/Y deltas
      // tracked across calls. The MouseEvent object's properties
      // don't persist across event invocations, so use the
      // hook-state store via a `lastClientX/Y` window global.
      const win = window as Window & { __dragYawLastClientX?: number; __dragYawLastClientY?: number };
      const lastX = win.__dragYawLastClientX ?? e.clientX;
      const lastY = win.__dragYawLastClientY ?? e.clientY;
      dx = e.clientX - lastX;
      dy = e.clientY - lastY;
      win.__dragYawLastClientX = e.clientX;
      win.__dragYawLastClientY = e.clientY;
    } else {
      dx = e.movementX;
      dy = e.movementY;
    }
    // PR 65 (debug) — emit a console.info on every drag-yaw mousemove
    // so the smoke harness can verify the drag actually accumulates
    // yaw. Without this, a broken drag would silently no-op and the
    // smoke would assert "yaw didn't change" without knowing why.
    if (dragYaw) {
      console.info(`[PR-65-DEBUG] dragYaw mousemove dx=${dx} dy=${dy} clientX=${e.clientX}`);
    }
    // PR 11.1: yaw delta on horizontal mouse movement.
    if (dx !== 0) {
      hooks.onYawDelta?.(dx * MOUSE_LOOK.sensitivityRadPerPixel);
    }
    // PR 11.3: pitch delta on vertical mouse movement. The convention is
    // "mouse up = look up = positive pitch", but the browser reports
    // `movementY` as POSITIVE when the mouse moves DOWN (away from the
    // user). So we NEGATE `movementY` to get the correct sign for pitch:
    //   mouse up    → movementY < 0 → -movementY > 0 → pitch increases → look up
    //   mouse down  → movementY > 0 → -movementY < 0 → pitch decreases → look down
    // The chase camera clamps to [-π/2, +π/2] so users physically hitting
    // the limits see the pitch hold at ±π/2 (not wrap).
    if (dy !== 0) {
      hooks.onPitchDelta?.(-dy * MOUSE_LOOK.sensitivityRadPerPixel);
    }
  };

  if (typeof window !== "undefined") {
    // PR 7.3 fix: bind mousedown/mouseup/contextmenu DIRECTLY to the canvas
    // element when provided, instead of just window/document. Babylon's
    // UniversalCamera.attachControl() (called in chaseCamera.ts) registers
    // pointer listeners on the canvas that may swallow or repath events
    // before they reach window/document listeners in some browser/canvas-
    // size combinations. Binding at the canvas level guarantees we fire
    // whenever the user clicks anywhere on the canvas.
    //
    // Fall back to document/window listeners for backwards compatibility
    // (e.g., unit tests that don't pass a canvas).
    if (target) {
      // PR 7.3: bind at BOTH the canvas (for canvas-area clicks) AND
      // document (for clicks on HUD/overlay elements that bubble up).
      // The smoke harness clicks the WebRTC overlay's Create button
      // which is OUTSIDE the canvas — without the document listener,
      // those clicks never reach us.
      target.addEventListener("mousedown", onMouseDown);
      target.addEventListener("mouseup", onMouseUp);
      target.addEventListener("contextmenu", onContextMenu);
      target.addEventListener("pointerdown", onPointerDown);
      target.addEventListener("pointerup", onPointerUp);
      document.addEventListener("mousedown", onMouseDown);
      document.addEventListener("pointerdown", onPointerDown);
      // PR 11.1: pointer-lock acquire + mouse-delta plumbing.
      target.addEventListener("click", onCanvasClick);
      document.addEventListener("pointerlockchange", onPointerLockChange);
      document.addEventListener("mousemove", onMouseMoveLocked);
    } else {
      document.addEventListener("mousedown", onMouseDown);
      document.addEventListener("mouseup", onMouseUp);
      document.addEventListener("contextmenu", onContextMenu);
      document.addEventListener("pointerdown", onPointerDown);
      document.addEventListener("pointerup", onPointerUp);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    window.addEventListener("mouseup", onMouseUp);
  }

  return {
    read: () => {
      const state: InputState = {
        forward: held.forward,
        right: held.right,
        jumpPressed: held.jumpPressed,
        divePressed: held.divePressed,
        slideHeld: held.slideHeld,
        wallrunPressed: held.wallrunPressed,
        cameraTogglePressed: held.cameraTogglePressed, fireHeld: held.fireHeld, meleePressed: held.meleePressed, bulletTimeHeld: held.bulletTimeHeld, reloadPressed: held.reloadPressed,
        // PR 11.1: yawRadians is populated by the scene.ts render loop
        // AFTER `read()` returns — scene pulls the latest yaw from the
        // chase camera and writes it onto the state object before
        // `encodeInput`. Keeping the listener pure-input (no camera
        // coupling) is what lets this stay a self-contained unit.
      };
      hooks.onFrame(state);
      // PR 65 — expose the live `held` snapshot to window so smoke
      // harnesses can verify that mousedown → fireHeld propagated
      // (without it, the smoke can only assert at the AimEvent
      // boundary, which is too far downstream to debug why a click
      // didn't register).
      if (typeof window !== "undefined") {
        (window as Window & { __inputHeld?: unknown }).__inputHeld = {
          forward: held.forward, right: held.right, jump: held.jumpPressed,
          dive: held.divePressed, slide: held.slideHeld, wallrun: held.wallrunPressed,
          fire: held.fireHeld, melee: held.meleePressed, bullet: held.bulletTimeHeld,
          reload: held.reloadPressed, pointerLocked: held.pointerLocked,
        };
      }
      // Clear one-shot flags. Held flags stay until the matching keyup.
      held.jumpPressed = false;
      held.divePressed = false;
      held.wallrunPressed = false;
      held.cameraTogglePressed = false;
      // PR 7: meleePressed was set on mousedown but never cleared before. Without
      // this, the rising-edge in combat code only fires on the FIRST RMB click
      // per session. Clearing here keeps `meleePressed` true for exactly one
      // read() — same shape as jump/dive/wallrun/cameraToggle edges.
      held.meleePressed = false;
      // PR 11.7.E: clear the reload rising-edge flag too (matches the
      // existing one-shot-flag discipline for jump / dive / wallrun /
      // cameraToggle / melee).
      held.reloadPressed = false;
      return state;
    },
    dispose: () => {
      if (typeof window !== "undefined") {
        if (target) {
          target.removeEventListener("mousedown", onMouseDown);
          target.removeEventListener("mouseup", onMouseUp);
          target.removeEventListener("contextmenu", onContextMenu);
          target.removeEventListener("pointerdown", onPointerDown);
          target.removeEventListener("pointerup", onPointerUp);
          document.removeEventListener("mousedown", onMouseDown);
          document.removeEventListener("pointerdown", onPointerDown);
          // PR 11.1: cleanup pointer-lock + mousemove listeners.
          target.removeEventListener("click", onCanvasClick);
          document.removeEventListener("pointerlockchange", onPointerLockChange);
          document.removeEventListener("mousemove", onMouseMoveLocked);
        } else {
          document.removeEventListener("mousedown", onMouseDown);
          document.removeEventListener("mouseup", onMouseUp);
          document.removeEventListener("contextmenu", onContextMenu);
          document.removeEventListener("pointerdown", onPointerDown);
          document.removeEventListener("pointerup", onPointerUp);
        }
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("keyup", onKeyUp);
        window.removeEventListener("blur", onBlur);
        window.removeEventListener("mouseup", onMouseUp);
      }
    },
  };
}
