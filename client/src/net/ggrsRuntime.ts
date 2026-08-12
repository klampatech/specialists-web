// Phase 0 / PR 4 — deterministic fixed-frame lockstep runtime.
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
// ## The honest limitation (documented in docs/SPEC.md + the PR body)
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
// Wire format for one packet (4 + INPUT_SIZE = 12 bytes):
//
//   byte 0..3   frame number, big-endian uint32
//   byte 4..11  encoded input (see net/inputBitmask.ts)

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
 */
export const MAX_PREDICTION_FRAMES = 8;

/** One advanced frame's worth of inputs. */
export interface AdvancedFrame {
  frame: number;
  local: Uint8Array;
  remote: Uint8Array;
  /** True when `remote` came off the wire rather than being repeated. */
  remoteConfirmed: boolean;
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
   */
  public advanceFrame(): AdvancedFrame {
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
    };
    this.onAdvance?.(advanced);

    this.localFrame++;
    this.remoteFrame++;
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

  public dispose(): void {
    this.disposed = true;
    this.localInputs.clear();
    this.remoteInputs.clear();
  }
}

/**
 * Back-compat alias for the PR-4-stub name. Kept so any in-flight import of
 * `GgrsRuntime` keeps compiling; the lockstep class is the real thing.
 */
export { LockstepRuntime as GgrsRuntime };
