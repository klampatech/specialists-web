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

/** Handlers the listener calls when an edge key goes down. */
export interface InputHooks {
  /** Called every frame so the host can drive one-shot input. */
  onFrame: (state: InputState) => void;
  /** Called when V (camera toggle) is pressed. */
  onCameraToggle: () => void;
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

export function createInputListener(hooks: InputHooks): InputListener {
  const held: HeldState = {
    forward: 0,
    right: 0,
    jumpPressed: false,
    divePressed: false,
    slideHeld: false,
    wallrunPressed: false,
    cameraTogglePressed: false, fireHeld: false, meleePressed: false, bulletTimeHeld: false,
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
      if (!e.repeat) held.cameraTogglePressed = true;
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

  const onMouseDown = (e: MouseEvent) => { if (e.button === 0) held.fireHeld = true; if (e.button === 2) held.meleePressed = true; };
  const onMouseUp = (e: MouseEvent) => { if (e.button === 0) held.fireHeld = false; };
  if (typeof window !== "undefined") {
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur); window.addEventListener("mousedown", onMouseDown); window.addEventListener("mouseup", onMouseUp);
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
        cameraTogglePressed: held.cameraTogglePressed, fireHeld: held.fireHeld, meleePressed: held.meleePressed, bulletTimeHeld: held.bulletTimeHeld,
      };
      hooks.onFrame(state);
      // Clear one-shot flags. Held flags stay until the matching keyup.
      held.jumpPressed = false;
      held.divePressed = false;
      held.wallrunPressed = false;
      held.cameraTogglePressed = false;
      return state;
    },
    dispose: () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("keyup", onKeyUp);
        window.removeEventListener("blur", onBlur); window.removeEventListener("mousedown", onMouseDown); window.removeEventListener("mouseup", onMouseUp);
      }
    },
  };
}
