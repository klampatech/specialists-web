// Phase 0 / PR 7 — wire-format encoder/decoder for the per-frame input packet.
//
// Wire format is fixed at INPUT_SIZE = 8 bytes. PR 4 reserved byte 1 for
// FIRE/MELEE/BULLET bits but never wrote them; PR 7 fixes that.
//
//   byte 0: movement bits (MoveBits below)
//   byte 1: combat bits   (CombatBits below) — PR 7 actually encodes these
//   byte 2..7: reserved, currently always 0 (the lockstep rounds up to 8
//              bytes for forward-compat — Phase 1 may pack more there)
//
// `InputBits` used to be a single `as const` object that aliased FIRE=1
// against LEFT=1 (both byte-0 names and byte-1 names lived in the same object
// with the same numeric identifier, which TypeScript happily allowed). That
// made the FIRE/MELEE/BULLET bits effectively unreadable. PR 7 splits the
// names into `MoveBits` (byte 0) and `CombatBits` (byte 1).

import type { InputState } from "../engine/characterController";

/** Total wire bytes per input packet. Locked in PR 4. */
export const INPUT_SIZE = 8;

/** Bit flags for byte 0 — movement + stunt edges. */
export const MoveBits = {
  LEFT: 1,
  RIGHT: 2,
  FORWARD: 4,
  BACK: 8,
  JUMP: 16,
  DIVE: 32,
  SLIDE: 64,
  WALLRUN: 128,
} as const;

/** Bit flags for byte 1 — combat edges (PR 7 actually writes these). */
export const CombatBits = {
  FIRE: 1,
  MELEE: 2,
  BULLET: 4,
} as const;

export type EncodedInput = Uint8Array;

export function encodeInput(s: InputState): EncodedInput {
  const b = new Uint8Array(INPUT_SIZE);
  if (s.right < 0) b[0] |= MoveBits.LEFT;
  if (s.right > 0) b[0] |= MoveBits.RIGHT;
  if (s.forward > 0) b[0] |= MoveBits.FORWARD;
  if (s.forward < 0) b[0] |= MoveBits.BACK;
  if (s.jumpPressed) b[0] |= MoveBits.JUMP;
  if (s.divePressed) b[0] |= MoveBits.DIVE;
  if (s.slideHeld) b[0] |= MoveBits.SLIDE;
  if (s.wallrunPressed) b[0] |= MoveBits.WALLRUN;
  // PR 7: actually write byte 1. Previously a no-op — the bits were
  // reserved but `decodeInput` always read them as false. Backwards
  // compatible because existing PR 6 traffic has byte 1 = 0 (no
  // combat bits set) and both clients upgrade together.
  if (s.fireHeld) b[1] |= CombatBits.FIRE;
  if (s.meleePressed) b[1] |= CombatBits.MELEE;
  if (s.bulletTimeHeld) b[1] |= CombatBits.BULLET;
  return b;
}

export function decodeInput(b: Uint8Array): InputState {
  return {
    forward: (b[0] & MoveBits.FORWARD ? 1 : 0) - (b[0] & MoveBits.BACK ? 1 : 0),
    right: (b[0] & MoveBits.RIGHT ? 1 : 0) - (b[0] & MoveBits.LEFT ? 1 : 0),
    jumpPressed: !!(b[0] & MoveBits.JUMP),
    divePressed: !!(b[0] & MoveBits.DIVE),
    slideHeld: !!(b[0] & MoveBits.SLIDE),
    wallrunPressed: !!(b[0] & MoveBits.WALLRUN),
    cameraTogglePressed: false,
    // PR 7: actually read byte 1. Previously always false.
    fireHeld: !!(b[1] & CombatBits.FIRE),
    meleePressed: !!(b[1] & CombatBits.MELEE),
    bulletTimeHeld: !!(b[1] & CombatBits.BULLET),
  };
}
