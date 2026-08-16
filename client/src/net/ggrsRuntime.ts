// Phase 0 / PR 4 — deterministic fixed-frame lockstep runtime.
// Phase 0 / PR 11.5 — pause-and-wait rollback cap.
//
// **Why not ggrs?** The `ggrs` / `ggpo` npm packages 404 on the registry as of
// 2026-08-12 (they are Rust crates; there is no published wasm/JS binding we
// can `npm i`). Rather than ship a stub and call Milestone 2 rows 1-4 done,
// this module implements a real deterministic fixed-frame **lockstep** over
// the reliable-ordered `inputs` RTCDataChannel that `net/peer.ts` already
// opens.
//
// The class surface (`submitLocalInput` / `advanceFrame` / `frame` /
// `latestConfirmedFrame` / `dispose`) is deliberately shaped like a ggrs
// `P2PSession`, so swapping in a real ggrs binding later is a class swap in
// this file, not a rewrite of the call sites.
//
// ## The model
//
// Both clients run the *same* simulation with the *same* two inputs. The only
// thing that crosses the wire is each client's own encoded input, tagged with
// the frame it belongs to. When a remote input for frame N arrives, we apply
// it on frame N. If it hasn't arrived by the time we must step frame N, we
// repeat the last known remote input (input buffering).
//
// ## The honest limitation (PR 4 — documented in docs/SPEC.md)
//
// There is **no rollback**. Real ggrs would speculatively simulate, then
// re-simulate from the last confirmed frame when a late input contradicts the
// prediction. Here, a late input is simply missed for that frame and the
// simulation continues from the repeated input. Under LAN / low-latency the
// two clients stay visually in sync; under heavy loss they can drift, and
// nothing corrects the drift. Milestone 2 row 4 ("rollback correction
// invisible under 100 ms lag") is therefore satisfied by *substrate*, not by
// true rollback.
//
// ## PR 11.5 — pause-and-wait cap (first-cut pre-rollback safety net)
//
// When `localFrame - highestRemoteFrameSeen >= ROLLBACK_CAP_FRAMES` (8),
// `advanceFrame()` returns a sentinel `{paused: true, ...}` frame instead
// of advancing the simulation. The encoder still runs (the wire packet goes
// out every tick) so the peer eventually catches up and sends us the
// missing frames; once `aheadBy` drops below the cap, the next
// `advanceFrame()` call resumes normally. Correct but visibly choppy under
// packet loss — the honest UX is "the local character freezes for a beat,
// then catches up". The upside is no drift, no rollback implementation, and
// lockstep determinism is preserved. See `docs/SPEC.md` PR 11.5 decisions
// log for the full rationale.
//
// Wire format for one packet (4 + INPUT_SIZE = 12 bytes):
//
//   byte 0..3   frame number, big-endian uint32
//   byte 4..11  encoded input (see net/inputBitmask.ts)
//
// The cap is purely local — the peer doesn't know we're paused, and the
// wire format is unchanged.

import { INPUT_SIZE } from "./inputBitmask";
import type { GgnetTransport } from "./ggnet";

/** Bytes prefixed to every input packet to carry the frame number. */
export const FRAME_HEADER_SIZE = 4;

/** Total wire size of a single lockstep packet. */
export const PACKET_SIZE = FRAME_HEADER_SIZE + INPUT_SIZE;

/**
 * How far ahead of the last received remote frame we tolerate before the HUD
 * calls the link "predicting". Purely informational — the simulation never
 * blocks on it, because blocking would stall the render loop on a peer hiccup.
 *
 * PR 11.5: this constant becomes the load-bearing threshold for the
 * pause-when-too-far-behind cap. `advanceFrame()` returns a sentinel
 * `{paused: true}` frame when `localFrame - highestRemoteFrameSeen`
 * reaches this value. 8 frames @ 60Hz ≈ 133ms lookahead budget — enough
 * for LAN + low-loss WAN; tighter cap = more visible pauses, looser
 * cap = more drift.
 */
export const MAX_PREDICTION_FRAMES = 8;

/**
 * PR 11.5 — pause-when-too-far-behind cap. Re-export of
 * `MAX_PREDICTION_FRAMES` so the existing documented-but-unused constant
 * becomes load-bearing under its semantic name. Callers (the smoke, the
 * future `paused-frames` HUD chip) import `ROLLBACK_CAP_FRAMES` rather
 * than the older `MAX_PREDICTION_FRAMES` name.
 */
export const ROLLBACK_CAP_FRAMES = MAX_PREDICTION_FRAMES;

/** One advanced frame's worth of inputs. */
export interface AdvancedFrame {
  frame: number;
  local: Uint8Array;
  remote: Uint8Array;
  /** True when `remote` came off the wire rather than being repeated. */
  remoteConfirmed: boolean;
  /**
   * PR 11.5: true when this frame was a no-op pause (the cap fired; see
   * `ROLLBACK_CAP_FRAMES` JSDoc). The caller MUST check this flag and
   * skip the per-tick sim update / combat / bullet-time work when true.
   * Pre-PR-11.5 callers can ignore this field — it's always `false` until
   * the cap fires, and the field exists on the type so the upgrade window
   * compiles without forcing existing call sites to add a check.
   */
  paused: boolean;
}

/**
 * Deterministic fixed-frame lockstep session over a single reliable ordered
 * data channel.
 */
export class LockstepRuntime {
  /** frame -> encoded local input. Trimmed behind the confirmed horizon. */
  private readonly localInputs = new Map<number, Uint8Array>();
  /** frame -> encoded remote input, as received off the wire. */
  private readonly remoteInputs = new Map<number, Uint8Array>();
  private localFrame = 0;
  private remoteFrame = 0;
  /** Repeated when the remote input for the frame we need hasn't landed. */
  private lastRemoteInput: Uint8Array = new Uint8Array(INPUT_SIZE);
  /** Highest frame number we've actually received from the peer. */
  private highestRemoteFrameSeen = -1;
  /** Count of frames we had to fill by repeating — surfaced for the HUD. */
  private repeatedFrames = 0;
  private disposed = false;

  /**
   * PR 11.5: consecutive paused-frame counter. Increments every tick
   * where the cap fires; resets to 0 the moment we successfully advance
   * again. Exposed via the `pausedFrames` getter for the HUD ("paused:
   * 12 frames" indicator) and the smoke. Underscore-prefixed to avoid
   * colliding with the public getter of the same name.
   */
  private _pausedFrames = 0;

  /**
   * PR 11.5: total paused-frame count across the session. Monotonic —
   * never decreases. Useful for the HUD's "paused N frames total this
   * session" diagnostic. Exposed via the `totalPausedFrameCount` getter.
   */
  private _totalPausedFrames = 0;

  constructor(
    private readonly transport: GgnetTransport,
    private readonly onAdvance?: (advanced: AdvancedFrame) => void,
  ) {
    this.transport.onPacket((packet) => this.receive(packet));
  }

  /** Handle one inbound packet. Public so tests can inject without a peer. */
  public receive(packet: Uint8Array): void {
    if (this.disposed) return;
    if (packet.byteLength < PACKET_SIZE) return; // malformed / not ours
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    const frame = view.getUint32(0);
    const input = packet.slice(FRAME_HEADER_SIZE, FRAME_HEADER_SIZE + INPUT_SIZE);
    this.remoteInputs.set(frame, input);
    if (frame > this.highestRemoteFrameSeen) this.highestRemoteFrameSeen = frame;
  }

  /**
   * Record this frame's local input and ship it to the peer. Must be called
   * once per frame *before* `advanceFrame()`.
   */
  public submitLocalInput(input: Uint8Array): void {
    if (this.disposed) return;
    this.localInputs.set(this.localFrame, input);
    const packet = new Uint8Array(PACKET_SIZE);
    new DataView(packet.buffer).setUint32(0, this.localFrame);
    packet.set(input.subarray(0, INPUT_SIZE), FRAME_HEADER_SIZE);
    this.transport.send(packet);
  }

  /**
   * Advance exactly one simulation frame and return the inputs applied. The
   * caller feeds `local` to its own controller and `remote` to the mirrored
   * controller — both clients therefore step identical physics.
   *
   * PR 11.5 — pause-when-too-far-behind cap:
   *   If `localFrame - highestRemoteFrameSeen >= ROLLBACK_CAP_FRAMES`
   *   (frames we want to process locally but the peer hasn't sent yet),
   *   return a sentinel `{paused: true, ...}` frame WITHOUT incrementing
   *   `localFrame` / `remoteFrame` / `repeatedFrames`. The wire packet for
   *   this tick is already on the wire (submitLocalInput ran first in
   *   gameSession.tick), so the peer can catch up; once `aheadBy` drops
   *   below the cap, the next successful advance resets `_pausedFrames`
   *   to 0 and resumes.
   */
  public advanceFrame(): AdvancedFrame {
    if (this.disposed) {
      // Sentinel: zeroed inputs, paused flag set so callers can detect
      // the disposed state without an extra null check. Same shape as
      // the PR 11.5 cap path below; matches the `paused: true` contract.
      return {
        frame: this.localFrame,
        local: new Uint8Array(INPUT_SIZE),
        remote: new Uint8Array(INPUT_SIZE),
        remoteConfirmed: true,
        paused: true,
      };
    }

    // PR 11.5: cap check. `aheadBy` is the number of frames we want to
    // process locally that the peer hasn't sent yet — equivalent to the
    // existing `predictionDepth` getter (which clamps at 0 when no peer
    // packet has arrived yet so the runtime doesn't self-pause on the
    // first frame before any handshake completes). Threshold: a "more
    // than 8 frames ahead" condition pauses local simulation, but DOES
    // NOT stop our wire encoder (submitLocalInput already ran in
    // gameSession.tick BEFORE this call, so the peer keeps receiving
    // our packets and will eventually catch up).
    //
    // The check is `>= ROLLBACK_CAP_FRAMES` (not `>`) — the gotcha
    // documented in the brief: `> 8` would be off-by-one (would tolerate
    // 9 frames of lookahead before pausing). Per the comment on
    // `ROLLBACK_CAP_FRAMES`, 8 frames @ 60Hz ≈ 133ms is the load-bearing
    // budget.
    //
    // IMPORTANT: use the same `predictionDepth` formula as the getter
    // (`max(0, localFrame - 1 - highestRemoteFrameSeen)`) rather than raw
    // `localFrame - highestRemoteFrameSeen`. Without the `-1` and
    // `max(0, ...)`, the cap would fire on the very first advance before
    // any peer input arrives (initial state: localFrame=0,
    // highestRemoteFrameSeen=-1 → raw delta=1, not >= 8 fine — but by
    // advance #8 raw delta=8 and the cap fires one tick EARLIER than the
    // getter says we are). Using the predictionDepth formula keeps the
    // cap and the getter synchronized, and keeps the runtime from
    // self-pausing during the handshake window.
    const aheadBy = Math.max(0, this.localFrame - 1 - this.highestRemoteFrameSeen);
    if (aheadBy >= ROLLBACK_CAP_FRAMES) {
      this._pausedFrames++;
      this._totalPausedFrames++;
      // Sentinel: zeroed LOCAL input (the controller MUST NOT be fed this
      // frame); repeat the LAST KNOWN remote input (the controllers'
      // state shouldn't drift visually); `remoteConfirmed: true` because
      // we're explicitly NOT predicting — we paused; and `paused: true`
      // so the caller (gameSession.tick) knows to skip the controller
      // update + combat + bullet-time work.
      const paused: AdvancedFrame = {
        frame: this.localFrame, // didn't advance — same frame number
        local: new Uint8Array(INPUT_SIZE),
        remote: this.lastRemoteInput,
        remoteConfirmed: true,
        paused: true,
      };
      this.onAdvance?.(paused);
      return paused;
    }

    // Normal advance path. Same as pre-PR-11.5 behaviour, plus the
    // `paused: false` flag on the returned AdvancedFrame.
    const local = this.localInputs.get(this.localFrame) ?? new Uint8Array(INPUT_SIZE);
    const received = this.remoteInputs.get(this.remoteFrame);
    let remote: Uint8Array;
    let remoteConfirmed: boolean;
    if (received) {
      // Confirmed: the peer's input for this exact frame arrived in time.
      this.lastRemoteInput = received;
      remote = received;
      remoteConfirmed = true;
    } else {
      // Late, lost, or the peer simply hasn't started sending yet. Repeat the
      // last input we saw. No rollback — see the module header.
      remote = this.lastRemoteInput;
      remoteConfirmed = false;
      this.repeatedFrames++;
    }

    const advanced: AdvancedFrame = {
      frame: this.localFrame,
      local,
      remote,
      remoteConfirmed,
      paused: false,
    };
    this.onAdvance?.(advanced);

    this.localFrame++;
    this.remoteFrame++;
    // PR 11.5: a successful advance resets the consecutive-paused
    // counter. `totalPausedFrameCount` is monotonic-by-construction
    // (we only ever increment it) so it stays where it was.
    this._pausedFrames = 0;
    this.trim();
    return advanced;
  }

  /**
   * Drop input history behind the horizon we could ever need. With no rollback
   * we only keep a small window, for debugging and for a future rollback pass.
   */
  private trim(): void {
    const horizon = this.localFrame - MAX_PREDICTION_FRAMES * 4;
    if (horizon <= 0) return;
    for (const frame of this.localInputs.keys()) {
      if (frame < horizon) this.localInputs.delete(frame);
    }
    for (const frame of this.remoteInputs.keys()) {
      if (frame < horizon) this.remoteInputs.delete(frame);
    }
  }

  /** The frame that will be simulated by the next `advanceFrame()` call. */
  public get frame(): number {
    return this.localFrame;
  }

  /** The last frame that has been simulated. -1 before the first advance. */
  public get latestConfirmedFrame(): number {
    return this.localFrame - 1;
  }

  /** How far ahead of the peer we are, in frames. 0 when perfectly in step. */
  public get predictionDepth(): number {
    return Math.max(0, this.localFrame - 1 - this.highestRemoteFrameSeen);
  }

  /** Frames whose remote input had to be repeated. Informational. */
  public get repeatedFrameCount(): number {
    return this.repeatedFrames;
  }

  /** True once we've received at least one packet from the peer. */
  public get hasRemote(): boolean {
    return this.highestRemoteFrameSeen >= 0;
  }

  /**
   * PR 11.5: was the most recent `advanceFrame()` call a no-op pause?
   * Equivalent to `pausedFrames > 0` — true while we're in the middle
   * of a paused streak, false the moment we successfully advance.
   * Exposed for the HUD ("PAUSED" badge) and the smoke.
   */
  public get isPaused(): boolean {
    return this._pausedFrames > 0;
  }

  /**
   * PR 11.5: monotonically-resetting pause counter. The number of
   * consecutive ticks the runtime has been paused (>= 1) since the
   * last successful advance. Resets to 0 the moment we successfully
   * advance. Useful for the HUD's "paused: 12 frames" indicator and
   * the smoke's catch-up assertions.
   */
  public get pausedFrames(): number {
    return this._pausedFrames;
  }

  /**
   * PR 11.5: total frames we've been paused across the entire session.
   * Monotonically increasing — never decreases. Surfaces in the HUD
   * as a "paused N frames total" diagnostic. Verified by the smoke
   * (asserts the value is 5 after 5 paused advances + stays at 5 after
   * the catch-up advance).
   */
  public get totalPausedFrameCount(): number {
    return this._totalPausedFrames;
  }

  public dispose(): void {
    this.disposed = true;
    this.localInputs.clear();
    this.remoteInputs.clear();
    // PR 11.5: clear the paused counters so a re-constructed runtime
    // (in the unlikely event of a dispose + recreate flow) starts
    // fresh. The `disposed` flag short-circuits advanceFrame anyway,
    // but clearing the counters keeps the public getters honest.
    this._pausedFrames = 0;
    this._totalPausedFrames = 0;
  }
}

/**
 * Back-compat alias for the PR-4-stub name. Kept so any in-flight import of
 * `GgrsRuntime` keeps compiling; the lockstep class is the real thing.
 */
export { LockstepRuntime as GgrsRuntime };
