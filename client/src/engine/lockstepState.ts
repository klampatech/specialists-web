// PR 11.7.D2 / §3.10 — lockstep substrate retirement stub.
//
// **The story**: PR 11.7.D2 retires the WebRTC P2P lockstep substrate
// (the old `ggrsRuntime.ts` + `peer.ts` + `ggnet.ts` files —
// DELETED in this PR). The architectural reason is that the server is
// now authoritative for player state (PR 11.7.B's snapshot stream +
// PR 11.7.D's server-side HP mutation): both clients receive the
// same authoritative `Snapshot` 20 times a second, so there's no
// need for client-side rollback / pause-and-wait / cap-fired logic.
// The remote visual is INTERPOLATED off the snapshot stream
// (`remoteInterpolator.ts`), not PREDICTED via lockstep inputs.
//
// **What survives here**: the minimum surface needed by:
//   - `gameSession.submitLocalInput(input)` — the per-frame input
//     submission path. In the old substrate this sent the encoded
//     input over the peer wire + recorded it for the next
//     `advanceFrame()` call. In the stub it just bumps a local
//     tracker so the predictor / HUD getters remain consistent.
//   - `gameSession.tick()`'s `advanceFrame()` call — returns a
//     sentinel `{paused: false, ...}` frame so the call-site shape
//     is unchanged. The predictor records its own input buffer
//     directly via `predictor.recordLocalInput(advanced.frame,
//     encodedInput)` (the same call as before — no longer needs the
//     lockstep's replay buffer to feed it).
//   - HUD getters: `frame`, `latestConfirmedFrame`,
//     `repeatedFrameCount`, `pausedFrames`, `totalPausedFrameCount`,
//     `predictionDepth`, `hasRemote`, `isPaused` — all return zero
//     (no P2P = no values to surface). The HUD reads
//     `session.frame` and `session.runtime.hasRemote` (`App.tsx`);
//     both still work, just always report a "no peer" state.
//
// **What's DELETED with the substrate**:
//   - WebRTC peer (`peer.ts` + `signaling.ts`)
//   - Lockstep runtime rollback / pause-and-wait cap
//   - Clipboard signaling (`PeerOverlay.tsx` Host/Join UI)
//   - `MultiplayerOptions.transport` parameter on `createScene`
//
// **Removal of `remoteController`** is post-D2.2 (the brief locks
// this: decouple the read path only in D2.2; full removal in D2.3+).
// The remote controller stays as a write-target for the snapshot's
// interpolated position (interpolator owns the position, Havok
// applies it via `setPosition()` each frame).

import { INPUT_SIZE } from "../net/inputBitmask";

/** One advanced frame's worth of inputs (sentinel shape preserved
 *  from the old `ggrsRuntime.AdvancedFrame` so `gameSession.tick()`
 *  doesn't need to branch on substrate type). */
export interface AdvancedFrame {
  frame: number;
  local: Uint8Array;
  remote: Uint8Array;
  /** True when `remote` came off the wire rather than being
   *  repeated. In the stub: always `true` (no peer concept). */
  remoteConfirmed: boolean;
  /** True when the lockstep cap fired and the simulator was paused
   *  for this frame. In the stub: always `false` (no cap). */
  paused: boolean;
}

/**
 * Lockstep substrate replacement stub. ~80 LOC.
 *
 * Surface matches the old `LockstepRuntime` so `gameSession.ts`,
 * `App.tsx`, and any HUD consumer keeps compiling without a
 * branch. The behavioral contract changes are:
 *   - `submitLocalInput(input)` no longer ships to a peer.
 *   - `advanceFrame()` always returns a `paused: false` sentinel.
 *   - All getters return zeros (no P2P state to surface).
 *
 * The `dispose()` call is a no-op (the stub holds no resources).
 */
export class LockstepState {
  private localFrame = 0;
  private lastLocalInput: Uint8Array = new Uint8Array(INPUT_SIZE);
  private disposed = false;

  /** Record the local input for this frame. In the old substrate
   *  this also sent the encoded bytes to the peer; here it just
   *  stashes the most-recent input for `advanceFrame()`'s return
   *  shape (the predictor records its own input buffer
   *  independently via `recordLocalInput`). */
  public submitLocalInput(input: Uint8Array): void {
    if (this.disposed) return;
    // Defensive copy — the caller may reuse the buffer next frame.
    this.lastLocalInput = new Uint8Array(input.subarray(0, INPUT_SIZE));
  }

  /** Advance one tick. Returns a sentinel frame:
   *    - `frame`: the current local frame number (post-bump on the
   *      call, so the return value is the just-finished frame)
   *    - `local`: the most-recently submitted encoded input
   *    - `remote`: zeroed (no peer)
   *    - `remoteConfirmed`: true (no peer to wait for)
   *    - `paused`: false (no cap)
   *
   *  In the old substrate this also re-simulated / repeated the
   *  remote input + applied the pause-when-too-far-behind cap.
   *  Both are gone with the substrate.
   */
  public advanceFrame(): AdvancedFrame {
    if (this.disposed) {
      return {
        frame: this.localFrame,
        local: new Uint8Array(INPUT_SIZE),
        remote: new Uint8Array(INPUT_SIZE),
        remoteConfirmed: true,
        paused: true,
      };
    }
    const advanced: AdvancedFrame = {
      frame: this.localFrame,
      local: new Uint8Array(this.lastLocalInput),
      remote: new Uint8Array(INPUT_SIZE),
      remoteConfirmed: true,
      paused: false,
    };
    this.localFrame++;
    return advanced;
  }

  /** The next frame to be advanced (0 before the first advance). */
  public get frame(): number {
    return this.localFrame;
  }

  /** The last frame that has been simulated (-1 before the first). */
  public get latestConfirmedFrame(): number {
    return this.localFrame - 1;
  }

  /** Frames whose remote input had to be repeated (P2P artifact).
   *  Always 0 in the stub. */
  public get repeatedFrameCount(): number {
    return 0;
  }

  /** Consecutive paused-tick counter (P2P artifact). Always 0. */
  public get pausedFrames(): number {
    return 0;
  }

  /** Total paused-tick count (P2P artifact). Always 0. */
  public get totalPausedFrameCount(): number {
    return 0;
  }

  /** Frames we're ahead of the peer (P2P artifact). Always 0. */
  public get predictionDepth(): number {
    return 0;
  }

  /** True once we've received a peer packet. Always false. */
  public get hasRemote(): boolean {
    return false;
  }

  /** True while paused. Always false. */
  public get isPaused(): boolean {
    return false;
  }

  /** No-op (no resources held). Kept for `gameSession.dispose()`
   *  symmetry with the old substrate. */
  public dispose(): void {
    this.disposed = true;
  }
}
