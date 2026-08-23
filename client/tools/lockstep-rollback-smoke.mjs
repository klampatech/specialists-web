#!/usr/bin/env node
// PR 11.7.D2 / §3.10 — lockstepState stub smoke (REWRITTEN post-D2.2).
//
// The original Phase 0 / PR 11.5 smoke drove the P2P `LockstepRuntime`
// rollback-cap math (when `localFrame - highestRemoteFrameSeen >= 8`
// the runtime returns a `{paused: true, ...}` sentinel). The P2P
// lockstep substrate was DELETED in PR 11.7.D2 (`ggrsRuntime.ts`,
// `peer.ts`, `ggnet.ts` — see squash 36e475a). The rollback concept
// is gone with it (no peer wire, no cap, no pause-and-wait).
//
// **What this smoke verifies now**: the new `client/src/engine/lockstepState.ts`
// stub produces the right `AdvancedFrame` shape so `gameSession.tick()`
// can keep compiling + running unchanged after the substrate swap. The
// stub replaces the P2P runtime but preserves the call-site surface —
// this smoke is the regression guard against any drift in that surface.
//
// The smoke exercises the stub DIRECTLY via Vite's module import
// (no scene / no PeerOverlay / no canvas). Same in-memory pattern the
// yaw / pitch wire-format smokes use: drive the API, assert public
// state. No WebRTC / no peer setup — there is no peer concept in the
// stub.
//
// Assertions:
//   1. `LockstepState` is constructible with no args (no transport).
//   2. `submitLocalInput(encoded)` stashes a defensive copy — mutating
//      the caller's buffer after submit does NOT affect the stub's
//      stored input.
//   3. `advanceFrame()` returns the canonical sentinel shape:
//        { frame, local, remote: zeroed, remoteConfirmed: true, paused: false }
//      where `local` is the most-recently-submitted encoded input
//      (defensively copied) and `frame` is the just-finished frame.
//   4. Frame counter increments monotonically: 0 → 1 → 2 → 3 across
//      4 advance calls.
//   5. `latestConfirmedFrame` mirrors `frame - 1` after at least one
//      advance has fired (the stub doesn't wait for snapshot-server
//      confirmation; this getter is the legacy P2P surface).
//   6. `predictionDepth` === 0, `repeatedFrameCount` === 0,
//      `pausedFrames` === 0, `totalPausedFrameCount` === 0,
//      `hasRemote` === false, `isPaused` === false (P2P-derived
//      getters all return zero / false in the stub).
//   7. `INPUT_SIZE === 12` (the wire-body byte count from
//      `protocol/inputBitmask.ts` — unaffected by D2.2; just confirms
//      the stub imports the same constant the rest of the engine uses).
//   8. The runtime surface used by `gameSession.tick()` (the call sites
//      in `client/src/game/gameSession.ts`) is intact: the stub
//      exposes `submitLocalInput`, `advanceFrame`, `frame`,
//      `latestConfirmedFrame`, `repeatedFrameCount`, `pausedFrames`,
//      `totalPausedFrameCount`, `predictionDepth`, `hasRemote`,
//      `isPaused`, `dispose`. We list them here as a regression guard
//      so a future PR that accidentally removes a method from the
//      stub will surface here, not in 5191's HP-convergence CI run.
//   9. After `dispose()`, further `advanceFrame()` returns the
//      disposed sentinel `{paused: true, ...}` (defensive — the smoke
//      also relies on this for teardown symmetry with the old
//      LockstepRuntime.dispose() contract).
//  10. Screenshot to `lockstep-rollback.png` for CI artifact upload
//      (matches the pre-D2.2 file path so the existing CI upload step
//      keeps working without changes).
//
// Exit 0 on pass; exit 1 with `[FAIL]` diagnostic on fail.

import { chromium } from "playwright";

const URL = process.env.LOCKSTEP_ROLLBACK_SMOKE_URL ?? "http://localhost:5188/";
const SCREENSHOT = process.env.LOCKSTEP_ROLLBACK_SMOKE_PNG ?? "lockstep-rollback.png";

// The shape gameSession.tick() depends on (matches the read sites in
// client/src/game/gameSession.ts lines 163-181, 639-657). If any of
// these names disappear from the stub, gameSession's compile will
// break — but we check at runtime too as a defense-in-depth smoke
// (a future patch could keep the TS surface intact while breaking
// the runtime behavior; this list is the safety net).
const REQUIRED_RUNTIME_SURFACE = [
  "submitLocalInput",
  "advanceFrame",
  "frame",
  "latestConfirmedFrame",
  "repeatedFrameCount",
  "pausedFrames",
  "totalPausedFrameCount",
  "predictionDepth",
  "hasRemote",
  "isPaused",
  "dispose",
];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
const errors = [];

page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
page.on("console", (msg) => {
  // Match the project convention (see yaw/pitch wire-format smokes):
  // surface console.errors EXCEPT for known headless-environment noise.
  if (msg.type() === "error" && !/WebGPU|Babylon|WebGL|GPU stall/.test(msg.text())) {
    errors.push(`console.error: ${msg.text()}`);
  }
});

try {
  await page.goto(URL, { waitUntil: "networkidle", timeout: 30000 });
  // The lockstepState module doesn't depend on a runtime scene — we just
  // need Vite up so the dynamic import resolves. Wait for the React shell
  // to settle then run the assertion block.
  await page.waitForFunction(
    () => typeof window !== "undefined",
    null,
    { timeout: 5000 },
  );

  // Drive the whole scenario in a single page.evaluate so the math
  // lives in the browser context (where the Vite module loader can
  // resolve `/src/engine/lockstepState.ts`). Pattern matches the
  // yaw / pitch wire-format smokes (single dynamic import, in-browser
  // asserts, return a serializable result).
  const result = await page.evaluate(async () => {
    // The new stub lives in client/src/engine/lockstepState.ts (PR 11.7.D2
    // moved it out of net/ alongside the substrate retirement). Importing
    // via Vite's dev-server transform hits the same module instance the
    // production bundle would use, so the smoke exercises the actual
    // surface the game consumes.
    const mod = await import("/src/engine/lockstepState.ts");
    const { LockstepState } = mod;

    // Surface checklist: every name gameSession.tick() reads on the
    // runtime. A future patch that removes any of these breaks the
    // smoke before it breaks CI compile. The getters are defined on the
    // class prototype (TS `get frame()` compiles to a prototype accessor)
    // — instance `Object.keys()` only enumerates own properties, so we
    // look at BOTH the instance AND the prototype chain.
    const instanceKeys = Object.keys(new LockstepState());
    const protoNames = Object.getOwnPropertyNames(LockstepState.prototype);
    const protoKeys = protoNames.filter((n) => n !== "constructor");
    const surfaceHas = (k) => instanceKeys.includes(k) || protoKeys.includes(k);

    // (1) Constructible with no args.
    const runtime = new LockstepState();

    // (2) Defensive copy on submit. We mutate the caller's buffer
    // after submitLocalInput and verify the stored `local` returned
    // by advanceFrame is unaffected. The check happens BEFORE the
    // multi-advance loop below — otherwise subsequent submitLocalInput
    // calls would overwrite `lastLocalInput` and the first-frame
    // sentinel would reflect the most-recent input, not the 0xAB we
    // submitted for this assertion.
    const submitted = new Uint8Array(12);
    submitted[0] = 0xAB;
    submitted[5] = 0xCD;
    runtime.submitLocalInput(submitted);
    submitted[0] = 0x00;
    submitted[5] = 0x00;
    const defensiveCopyFrame = runtime.advanceFrame();

    // (3) + (4) Drive 4 more advances with monotonically incrementing
    // sentinels so we can check frame-counter + sentinel-shape across
    // multiple calls. Each advance returns the canonical sentinel
    // shape; the first of these is `frame=1` (since the defensive-copy
    // call above already bumped localFrame from 0 to 1).
    const frames = [];
    for (let i = 0; i < 4; i++) {
      const fresh = new Uint8Array(12);
      fresh[0] = 0x10 + i;
      runtime.submitLocalInput(fresh);
      frames.push(runtime.advanceFrame());
    }

    // (5) After 4 advances, frame === 4 (next-to-advance) and
    // latestConfirmedFrame === 3 (last advanced frame).
    const frameGetter = runtime.frame;
    const latestConfirmedGetter = runtime.latestConfirmedFrame;

    // (6) P2P-derived getters — all zero / false in the stub.
    const p2pGetters = {
      repeatedFrameCount: runtime.repeatedFrameCount,
      pausedFrames: runtime.pausedFrames,
      totalPausedFrameCount: runtime.totalPausedFrameCount,
      predictionDepth: runtime.predictionDepth,
      hasRemote: runtime.hasRemote,
      isPaused: runtime.isPaused,
    };

    // (7) INPUT_SIZE constant import + sanity (the stub uses it
    // internally; we re-read from inputBitmask to catch a future
    // accidental decoupling — same module the wire-format smokes use).
    const inputBitmask = await import("/src/net/inputBitmask.ts");
    const inputSize = inputBitmask.INPUT_SIZE;

    // (9) dispose() flips the stub into the disposed sentinel mode.
    runtime.dispose();
    const disposedFrame = runtime.advanceFrame();

    // Return a serializable result. We can't return the runtime
    // instance directly (functions aren't serializable), so we
    // flatten everything we want to assert on.
    const frameShapes = frames.map((f) => ({
      frame: f.frame,
      localLen: f.local.length,
      localByte0: f.local[0],
      remoteLen: f.remote.length,
      remoteAllZero: Array.from(f.remote).every((b) => b === 0),
      remoteConfirmed: f.remoteConfirmed,
      paused: f.paused,
    }));
    const defensiveCopy = {
      frame: defensiveCopyFrame.frame,
      localByte0: defensiveCopyFrame.local[0],
      remoteConfirmed: defensiveCopyFrame.remoteConfirmed,
      paused: defensiveCopyFrame.paused,
    };
    return {
      instanceKeys,
      protoKeys,
      surfaceHas: Object.fromEntries([
        "submitLocalInput",
        "advanceFrame",
        "frame",
        "latestConfirmedFrame",
        "repeatedFrameCount",
        "pausedFrames",
        "totalPausedFrameCount",
        "predictionDepth",
        "hasRemote",
        "isPaused",
        "dispose",
      ].map((k) => [k, surfaceHas(k)])),
      frameShapes,
      defensiveCopy,
      frameGetter,
      latestConfirmedGetter,
      p2pGetters,
      inputSize,
      disposedShape: {
        frame: disposedFrame.frame,
        paused: disposedFrame.paused,
        localLen: disposedFrame.local.length,
        remoteLen: disposedFrame.remote.length,
        remoteConfirmed: disposedFrame.remoteConfirmed,
      },
    };
  });

  // (1) Surface checklist — every name gameSession.tick() reads on
  // the runtime must still be exposed by the stub. Defensive against
  // a future PR removing one of these methods (the stub's purpose
  // is call-site compatibility).
  for (const k of REQUIRED_RUNTIME_SURFACE) {
    if (!result.surfaceHas[k]) {
      throw new Error(
        `[surface-${k}] expected LockstepState to expose "${k}" (gameSession.tick() reads it); missing.`,
      );
    }
  }
  console.log(`SURFACE_OK: ${REQUIRED_RUNTIME_SURFACE.length} runtime methods exposed (${REQUIRED_RUNTIME_SURFACE.join(", ")})`);

  // (2) The defensive-copy frame's local is the submitted input
  // (with the post-submit mutation NOT visible). We submitted 0xAB
  // then mutated back to 0x00 before advancing; if the stub copied
  // by reference the stored local[0] would be 0x00.
  if (result.defensiveCopy.localByte0 !== 0xAB) {
    throw new Error(
      `[defensive-copy] expected defensive-copy frame local[0] === 0xAB (preserved across submitLocalInput's defensive copy); got 0x${result.defensiveCopy.localByte0.toString(16)}. ` +
      `If this is 0x00 the stub is storing a reference instead of a copy — would corrupt the input buffer when the caller mutates it.`,
    );
  }
  console.log(`DEFENSIVE_COPY_OK: submitLocalInput copies (preserved 0xAB across post-submit mutation)`);

  // (3) Sentinel shape: every advance returns the canonical
  // {frame, local, remote, remoteConfirmed: true, paused: false}
  // with remote zeroed. The contract is the same for every frame.
  for (let i = 0; i < result.frameShapes.length; i++) {
    const f = result.frameShapes[i];
    const expectedFrame = i + 1; // defensive-copy call advanced localFrame to 1 already
    if (f.frame !== expectedFrame) {
      throw new Error(`[frame-counter ${i}] expected frame === ${expectedFrame}, got ${f.frame}`);
    }
    if (f.localLen !== 12) {
      throw new Error(`[local-len ${i}] expected local.length === 12, got ${f.localLen}`);
    }
    if (f.remoteLen !== 12) {
      throw new Error(`[remote-len ${i}] expected remote.length === 12, got ${f.remoteLen}`);
    }
    if (!f.remoteAllZero) {
      throw new Error(`[remote-zeroed ${i}] expected remote to be all zeros (no peer), got non-zero bytes`);
    }
    if (f.remoteConfirmed !== true) {
      throw new Error(`[remote-confirmed ${i}] expected remoteConfirmed === true, got ${f.remoteConfirmed}`);
    }
    if (f.paused !== false) {
      throw new Error(`[paused ${i}] expected paused === false, got ${f.paused}`);
    }
    if (f.localByte0 !== 0x10 + i) {
      throw new Error(`[local-content ${i}] expected local[0] === ${0x10 + i} (submitted this round), got 0x${f.localByte0.toString(16)}`);
    }
  }
  console.log(`SHAPE_OK: ${result.frameShapes.length} advances returned canonical AdvancedFrame {frame, local, remote: zeroed, remoteConfirmed: true, paused: false}`);

  // (4) Frame counter monotonic — frame getter is the next-to-advance
  // number. After 1 defensive-copy advance + 4 loop advances, that's
  // 5 advances total → frame === 5 (next-to-advance), latestConfirmed
  // === 4 (last advanced).
  if (result.frameGetter !== 5) {
    throw new Error(`[frame-getter] expected runtime.frame === 5 after 5 advances (1 defensive-copy + 4 loop), got ${result.frameGetter}`);
  }
  if (result.latestConfirmedGetter !== 4) {
    throw new Error(`[latest-confirmed] expected runtime.latestConfirmedFrame === 4 after 5 advances, got ${result.latestConfirmedGetter}`);
  }
  console.log(`MONOTONIC_OK: frame=${result.frameGetter}, latestConfirmedFrame=${result.latestConfirmedGetter} (counter increments every advance)`);

  // (5) P2P-derived getters all zero / false in the stub. These are
  // the legacy LockstepRuntime HUD-surfaced values — the stub
  // preserves them as zero so the HUD compiles but they always
  // report "no peer" state.
  for (const k of ["repeatedFrameCount", "pausedFrames", "totalPausedFrameCount", "predictionDepth"]) {
    if (result.p2pGetters[k] !== 0) {
      throw new Error(`[p2p-getter ${k}] expected 0, got ${result.p2pGetters[k]}`);
    }
  }
  for (const k of ["hasRemote", "isPaused"]) {
    if (result.p2pGetters[k] !== false) {
      throw new Error(`[p2p-getter ${k}] expected false, got ${result.p2pGetters[k]}`);
    }
  }
  console.log(`P2P_GETTERS_OK: repeatedFrameCount=0 pausedFrames=0 totalPausedFrameCount=0 predictionDepth=0 hasRemote=false isPaused=false (no peer concept)`);

  // (6) INPUT_SIZE constant matches the engine wire-format (12 bytes).
  // The stub's `new Uint8Array(INPUT_SIZE)` uses this; if it ever
  // drifted from inputBitmask the wire format would silently break.
  if (result.inputSize !== 12) {
    throw new Error(`[input-size] expected INPUT_SIZE === 12, got ${result.inputSize}`);
  }
  console.log(`INPUT_SIZE_OK: INPUT_SIZE === ${result.inputSize} (matches protocol/inputBitmask.ts wire body)`);

  // (7) dispose() flips the stub into the disposed sentinel mode —
  // advanceFrame returns {paused: true, ...} for symmetry with the
  // old LockstepRuntime.dispose() contract (gameSession.dispose()
  // calls runtime.dispose(); the subsequent tick must short-circuit
  // cleanly).
  if (result.disposedShape.paused !== true) {
    throw new Error(
      `[disposed-paused] expected advanceFrame after dispose() to return paused: true, got ${result.disposedShape.paused}`,
    );
  }
  if (result.disposedShape.localLen !== 12 || result.disposedShape.remoteLen !== 12) {
    throw new Error(
      `[disposed-shape] expected disposed advanceFrame to still return zeroed local+remote Uint8Array(12), got localLen=${result.disposedShape.localLen} remoteLen=${result.disposedShape.remoteLen}`,
    );
  }
  if (result.disposedShape.remoteConfirmed !== true) {
    throw new Error(
      `[disposed-remote-confirmed] expected remoteConfirmed === true even after dispose, got ${result.disposedShape.remoteConfirmed}`,
    );
  }
  console.log(`DISPOSE_OK: advanceFrame() after dispose() returns {paused: true, ...} sentinel (call-site symmetry preserved)`);

  await page.screenshot({ path: SCREENSHOT });

  if (errors.length) {
    console.error("PAGE_ERRORS:");
    for (const e of errors) console.error(" -", e);
    process.exit(1);
  }

  console.log(`OK — lockstepState stub smoke passed (10 assertions: surface, defensive-copy, sentinel-shape, monotonic, p2p-getters, input-size, dispose)`);
  await browser.close();
  process.exit(0);
} catch (err) {
  console.error("FAIL:", err.message);
  try {
    await page.screenshot({ path: SCREENSHOT });
  } catch {}
  await browser.close();
  process.exit(1);
}
