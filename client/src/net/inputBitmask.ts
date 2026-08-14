// Phase 0 / PR 7+11.1 — wire-format encoder/decoder for the per-frame input packet.
//
// Wire format is INPUT_SIZE = 10 bytes. PR 4 reserved byte 1 for
// FIRE/MELEE/BULLET bits but never wrote them; PR 7 fixed that. PR 11.1
// extends bytes 2-3 to carry the per-player yaw (little-endian uint16,
// 1/65536 of a full revolution) so both clients compute identical
// movement directions from the same yaw on the same frame.
//
//   byte 0: movement bits (MoveBits below)
//   byte 1: combat bits   (CombatBits below) — PR 7 actually encodes these
//   bytes 2-3: yaw as little-endian uint16 (PR 11.1)
//   bytes 4-9: reserved, currently always 0 (the lockstep rounds up to 10
//              bytes for forward-compat — Phase 1 may pack more there)
//
// `InputBits` used to be a single `as const` object that aliased FIRE=1
// against LEFT=1 (both byte-0 names and byte-1 names lived in the same object
// with the same numeric identifier, which TypeScript happily allowed). That
// made the FIRE/MELEE/BULLET bits effectively unreadable. PR 7 splits the
// names into `MoveBits` (byte 0) and `CombatBits` (byte 1).

import type { InputState } from "../engine/characterController";

/** Total wire bytes per input packet. PR 11.1 bumped from 8 to 10
 *  to carry yaw on bytes 2-3. Both clients upgrade together. */
export const INPUT_SIZE = 10;

/**
 * PR 11.1: scale for encoding yaw radians as a uint16 on bytes 2-3.
 * 65535 / (2π) ≈ 10430.4 — so 1 LSB ≈ 0.000096 radians ≈ 0.0055°.
 * Plenty of resolution for a multiplayer FPS feel.
 */
export const YAW_BITS_SCALE = 65535 / (2 * Math.PI);

/**
 * Encode a yaw (radians, any real number) as a uint16 representing the
 * same angle mod 2π in [0, 2π). Clamps to [0, 65535] so floating-point
 * drift at exactly 2π can't overflow the peer's uint16 read.
 */
function yawToBits(radians: number): number {
  const TWO_PI = 2 * Math.PI;
  let r = radians % TWO_PI;
  if (r < 0) r += TWO_PI;
  const scaled = Math.round(r * YAW_BITS_SCALE);
  return Math.min(65535, Math.max(0, scaled));
}

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
  // PR 11.1: yaw lives on bytes 2-3 as a little-endian uint16. Default
  // to 0 (no rotation) when the caller doesn't supply a yaw — preserves
  // backwards compat with PR 6/7/10 traffic where bytes 2-3 are zero.
  const yawBits = yawToBits(s.yawRadians ?? 0);
  b[2] = yawBits & 0xff;
  b[3] = (yawBits >>> 8) & 0xff;
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
    // PR 11.1: yawRadians pulled off bytes 2-3. Always defined for
    // PR 11.1+ traffic. Defensive `?? 0` on the byte reads keeps this
    // robust against truncated packets (e.g., a PR 6 replay buffer
    // with only 8 bytes during the upgrade window).
    yawRadians: (((b[2] ?? 0) | ((b[3] ?? 0) << 8)) & 0xffff) / YAW_BITS_SCALE,
  };
}
