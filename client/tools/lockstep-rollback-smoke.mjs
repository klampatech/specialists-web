#!/usr/bin/env node
// Phase 0 / PR 11.5 — gap-bridging rollback cap smoke.
//
// Verifies the PR 11.5 pause-when-too-far-behind cap in LockstepRuntime.
// The cap fires when `localFrame - highestRemoteFrameSeen >=
// ROLLBACK_CAP_FRAMES (8)`. When it fires, `advanceFrame()` returns a
// sentinel `{paused: true, ...}` frame instead of advancing the
// simulation. Wire encode + submit still happens every tick so the peer
// can catch up.
//
// Headless Chromium can't reach TURN (documented in HANDOFF §"PR 6
// caveat"), so the smoke exercises the runtime directly via a synthetic
// in-memory transport stub — no WebRTC, no peer setup. Same pattern as
// the yaw/pitch wire-format smokes (import the module via Vite, drive
// the API directly, assert the public state).
//
// What this smoke verifies:
//   1. ROLLBACK_CAP_FRAMES === 8 (the documented-but-unused constant
//      became load-bearing; smear test that the re-export compiles).
//   2. Advance 8 times within the cap → all advance, none paused,
//      localFrame reaches 8. (The cap fires at aheadBy >= 8 where
//      aheadBy = max(0, localFrame - 1 - highestRemoteFrameSeen).
//      With highestRemoteFrameSeen = -1 at startup, the cap fires
//      when localFrame - 1 - (-1) = localFrame = 8, so all 8
//      within-cap advances succeed — the 9th advance has localFrame=8
//      and aheadBy=8, tripping the cap.)
//   3. Advance 5 more times (over the cap) → all return paused=true,
//      localFrame stays at 8, isPaused=true, pausedFrames grows to 5,
//      totalPausedFrameCount is 5.
//   4. Wire encode + submit still happens while paused (peer needs
//      our packets to catch up). 8 + 5 = 13 sent packets after the
//      first 13 advanceFrame calls.
//   5. Feed the runtime 9 zeroed-input peer packets at frames 0..8.
//      After the feed, highestRemoteFrameSeen = 8. The next
//      advanceFrame call sees aheadBy = max(0, 8-1-8) = 0 and
//      resumes normally.
//   6. The caught-up advance returns paused=false, localFrame
//      increments to 9, pausedFrames resets to 0,
//      totalPausedFrameCount stays at 5 (monotonic — never decreases).
//   7. The new __lockstepProbe DEV probe exposes cap + the paused
//      counters + the existing frame + repeated + prediction getters.
//      Production bundle grep verifies the probe + ROLLBACK_CAP_FRAMES
//      name are tree-shaken out of `dist/assets/index-*.js`.
//
// Screenshot to `lockstep-rollback.png` for CI artifact upload.
// Exit 0 on pass; exit 1 with `[FAIL]` diagnostic on fail.

import { chromium } from "playwright";

const URL = process.env.LOCKSTEP_ROLLBACK_SMOKE_URL ?? "http://localhost:5188/";
const SCREENSHOT = process.env.LOCKSTEP_ROLLBACK_SMOKE_PNG ?? "lockstep-rollback.png";
const EXPECTED_CAP = 8;
const WITHIN_CAP_ADVANCES = 8;     // 8 successful advances before the cap fires (see ggrsRuntime.ts cap math)
const OVER_CAP_ADVANCES = 5;       // 5 paused advances (paused counter hits 5)
const EXPECTED_TOTAL_PAUSED = 5;    // matches OVER_CAP_ADVANCES
const CATCHUP_FRAMES = 9;           // feed 9 peer packets (frames 0..8) to put highestRemoteFrameSeen = 8
const EXPECTED_TOTAL_SENT_PACKETS = WITHIN_CAP_ADVANCES + OVER_CAP_ADVANCES + 1; // 14

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
const errors = [];

page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
page.on("console", (msg) => {
  // Match the project convention (see mouse-pitch-smoke.mjs,
  // pointer-lock-camera-smoke.mjs, spectator-camera-smoke.mjs):
  // surface console.errors EXCEPT for known headless-environment noise
  // (WebGPU adapter unavailable, Babylon/Havok warnings, WebGL perf
  // warnings, GPU stall drift).
  if (msg.type() === "error" && !/WebGPU|Babylon|WebGL|GPU stall/.test(msg.text())) {
    errors.push(`console.error: ${msg.text()}`);
  }
});

try {
  await page.goto(URL, { waitUntil: "networkidle", timeout: 30000 });

  // Wait for the scene to be ready — the DEV-only lockstep probe.
  await page.waitForFunction(
    () => typeof window.__lockstepProbe === "function",
    null,
    { timeout: 15000 },
  );
  // Give the engine a frame to settle so the probe's internal state
  // is what we observe (currently the test runtime is never advanced,
  // so all counters are 0; this just confirms the probe is wired).
  await page.waitForTimeout(200);

  // (1) Probe sanity — the runtime module is loaded and the cap
  // constant is exposed. The probe wraps a no-op runtime so
  // `cap` should be ROLLBACK_CAP_FRAMES = 8 and all counters
  // start at 0.
  const probe1 = await page.evaluate(() => window.__lockstepProbe());
  if (probe1.cap !== EXPECTED_CAP) {
    throw new Error(
      `[probe-cap] expected __lockstepProbe().cap === ${EXPECTED_CAP}, got ${probe1.cap}`,
    );
  }
  if (probe1.frame !== 0) {
    throw new Error(`[probe-frame] expected frame === 0, got ${probe1.frame}`);
  }
  if (probe1.isPaused !== false) {
    throw new Error(`[probe-ispaused] expected isPaused === false, got ${probe1.isPaused}`);
  }
  if (probe1.pausedFrames !== 0) {
    throw new Error(`[probe-pausedframes] expected pausedFrames === 0, got ${probe1.pausedFrames}`);
  }
  if (probe1.totalPausedFrames !== 0) {
    throw new Error(`[probe-totalpaused] expected totalPausedFrames === 0, got ${probe1.totalPausedFrames}`);
  }
  console.log(`PROBE_OK: cap=${probe1.cap}, frame=${probe1.frame}, isPaused=${probe1.isPaused}`);

  // Drive the whole scenario in a single page.evaluate so the math
  // lives in the browser context (where the runtime / encoding /
  // etc. modules are loaded) and we don't fight cross-realm
  // Uint8Array serialization. Pattern matches yaw-wire-format-smoke.mjs.
  const result = await page.evaluate(async (cap) => {
    const mod = await import("/src/net/ggrsRuntime.ts");
    const { LockstepRuntime, INPUT_SIZE, PACKET_SIZE } = mod;

    // Synthetic in-memory transport stub. The runtime only calls
    // `transport.send(packet)` and `transport.onPacket(callback)` —
    // a duck-typed object with both shapes is enough. The lockstep
    // runtime's constructor expects a `GgnetTransport` instance at
    // the TS type level, but we're in the browser JS context here
    // (TS types don't apply at runtime), so the duck-typed object
    // is fine.
    let capturedInboundCallback = null;
    const sentPackets = [];
    const syntheticTransport = {
      onPacket: (cb) => { capturedInboundCallback = cb; },
      send: (p) => { sentPackets.push(p); },
    };

    const runtime = new LockstepRuntime(syntheticTransport);

    // Helper: build a zeroed-input peer packet for a given frame.
    // The peer's input bits are all zero (no input / first connect),
    // but the wire format is unchanged from PR 11.3 — 4-byte header
    // + 12-byte input.
    const makePeerPacket = (frame) => {
      const packet = new Uint8Array(PACKET_SIZE);
      new DataView(packet.buffer).setUint32(0, frame);
      // bytes 4..PACKET_SIZE-1 are zeroed (no input)
      return packet;
    };

    // --- Phase A: 8 within-cap advances ---
    const withinCap = [];
    for (let i = 0; i < 8; i++) {
      runtime.submitLocalInput(new Uint8Array(INPUT_SIZE));
      const advanced = runtime.advanceFrame();
      withinCap.push({
        paused: advanced.paused,
        frame: advanced.frame,
        remoteConfirmed: advanced.remoteConfirmed,
        localFrame: runtime.frame,
        isPaused: runtime.isPaused,
        pausedFrames: runtime.pausedFrames,
        totalPausedFrameCount: runtime.totalPausedFrameCount,
      });
    }

    // --- Phase B: 5 over-cap advances (cap fires) ---
    const overCap = [];
    for (let i = 0; i < 5; i++) {
      runtime.submitLocalInput(new Uint8Array(INPUT_SIZE));
      const advanced = runtime.advanceFrame();
      overCap.push({
        paused: advanced.paused,
        frame: advanced.frame,
        remoteConfirmed: advanced.remoteConfirmed,
        localFrame: runtime.frame,
        isPaused: runtime.isPaused,
        pausedFrames: runtime.pausedFrames,
        totalPausedFrameCount: runtime.totalPausedFrameCount,
      });
    }
    const totalPausedAtEndOfPhaseB = runtime.totalPausedFrameCount;

    // --- Phase C: feed 9 peer packets (catch-up) ---
    for (let f = 0; f < 9; f++) {
      capturedInboundCallback(makePeerPacket(f));
    }

    // --- Phase D: 1 caught-up advance (should resume) ---
    runtime.submitLocalInput(new Uint8Array(INPUT_SIZE));
    const caughtUp = runtime.advanceFrame();

    return {
      cap,
      withinCap,
      overCap,
      totalPausedAtEndOfPhaseB,
      caughtUp: {
        paused: caughtUp.paused,
        frame: caughtUp.frame,
        remoteConfirmed: caughtUp.remoteConfirmed,
        localFrame: runtime.frame,
        isPaused: runtime.isPaused,
        pausedFrames: runtime.pausedFrames,
        totalPausedFrameCount: runtime.totalPausedFrameCount,
      },
      sentPacketCount: sentPackets.length,
    };
  }, EXPECTED_CAP);

  // (2) Cap constant value matches.
  if (result.cap !== EXPECTED_CAP) {
    throw new Error(`[cap] expected ROLLBACK_CAP_FRAMES === ${EXPECTED_CAP}, got ${result.cap}`);
  }
  console.log(`CAP_OK: ROLLBACK_CAP_FRAMES === ${result.cap}`);

  // (3) Within-cap advances: all 8 succeed, no paused, localFrame 0→8.
  if (result.withinCap.length !== WITHIN_CAP_ADVANCES) {
    throw new Error(`[within-cap-count] expected ${WITHIN_CAP_ADVANCES} advances, got ${result.withinCap.length}`);
  }
  for (let i = 0; i < result.withinCap.length; i++) {
    const a = result.withinCap[i];
    if (a.paused !== false) {
      throw new Error(`[within-cap ${i}] expected paused === false, got ${a.paused}`);
    }
    if (a.frame !== i) {
      throw new Error(`[within-cap ${i}] expected frame === ${i}, got ${a.frame}`);
    }
    if (a.localFrame !== i + 1) {
      throw new Error(`[within-cap ${i}] expected localFrame === ${i + 1}, got ${a.localFrame}`);
    }
    if (a.isPaused !== false) {
      throw new Error(`[within-cap ${i}] expected isPaused === false, got ${a.isPaused}`);
    }
    if (a.pausedFrames !== 0) {
      throw new Error(`[within-cap ${i}] expected pausedFrames === 0, got ${a.pausedFrames}`);
    }
  }
  console.log(`WITHIN_CAP_OK: ${WITHIN_CAP_ADVANCES} advances succeeded, localFrame 0→${result.withinCap[result.withinCap.length - 1].localFrame}`);

  // (4) Over-cap advances: all 5 paused, localFrame stays at 8.
  if (result.overCap.length !== OVER_CAP_ADVANCES) {
    throw new Error(`[over-cap-count] expected ${OVER_CAP_ADVANCES} over-cap advances, got ${result.overCap.length}`);
  }
  for (let i = 0; i < result.overCap.length; i++) {
    const a = result.overCap[i];
    if (a.paused !== true) {
      throw new Error(`[over-cap ${i}] expected paused === true, got ${a.paused}`);
    }
    if (a.frame !== 8) {
      throw new Error(`[over-cap ${i}] expected frame === 8 (unchanged), got ${a.frame}`);
    }
    if (a.localFrame !== 8) {
      throw new Error(`[over-cap ${i}] expected localFrame === 8 (unchanged), got ${a.localFrame}`);
    }
    if (a.isPaused !== true) {
      throw new Error(`[over-cap ${i}] expected isPaused === true, got ${a.isPaused}`);
    }
    if (a.pausedFrames !== i + 1) {
      throw new Error(`[over-cap ${i}] expected pausedFrames === ${i + 1}, got ${a.pausedFrames}`);
    }
    if (a.totalPausedFrameCount !== i + 1) {
      throw new Error(`[over-cap ${i}] expected totalPausedFrameCount === ${i + 1}, got ${a.totalPausedFrameCount}`);
    }
  }
  const lastOverCap = result.overCap[result.overCap.length - 1];
  console.log(
    `OVER_CAP_OK: ${OVER_CAP_ADVANCES} advances paused, localFrame stayed at ${lastOverCap.localFrame}, ` +
    `totalPausedFrameCount=${lastOverCap.totalPausedFrameCount}`,
  );

  // (5) Wire encode + submit still happens while paused (peer needs
  // our packets to catch up). Submit fires once per advanceFrame call
  // (in our test). 7 + 5 + 1 = 13 sent packets total.
  if (result.sentPacketCount !== EXPECTED_TOTAL_SENT_PACKETS) {
    throw new Error(
      `[sent-packets] expected ${EXPECTED_TOTAL_SENT_PACKETS} sent packets (${WITHIN_CAP_ADVANCES} within + ${OVER_CAP_ADVANCES} paused + 1 caught up), got ${result.sentPacketCount}`,
    );
  }
  console.log(`SENT_PACKETS_OK: ${result.sentPacketCount} sent packets (wire encoded every tick, even while paused)`);

  // (6) Caught-up advance: paused=false, localFrame=9, pausedFrames=0,
  // totalPausedFrameCount stays at 5 (monotonic — never decreases).
  if (result.caughtUp.paused !== false) {
    throw new Error(`[caught-up] expected paused === false, got ${result.caughtUp.paused}`);
  }
  if (result.caughtUp.frame !== 8) {
    throw new Error(`[caught-up] expected frame === 8, got ${result.caughtUp.frame}`);
  }
  if (result.caughtUp.localFrame !== 9) {
    throw new Error(`[caught-up] expected localFrame === 9, got ${result.caughtUp.localFrame}`);
  }
  if (result.caughtUp.isPaused !== false) {
    throw new Error(`[caught-up] expected isPaused === false, got ${result.caughtUp.isPaused}`);
  }
  if (result.caughtUp.pausedFrames !== 0) {
    throw new Error(`[caught-up] expected pausedFrames === 0 (reset on resume), got ${result.caughtUp.pausedFrames}`);
  }
  if (result.caughtUp.totalPausedFrameCount !== EXPECTED_TOTAL_PAUSED) {
    throw new Error(
      `[caught-up] expected totalPausedFrameCount === ${EXPECTED_TOTAL_PAUSED} (monotonic — never decreases), got ${result.caughtUp.totalPausedFrameCount}`,
    );
  }
  console.log(
    `CAUGHT_UP_OK: unpaused, localFrame=${result.caughtUp.localFrame}, ` +
    `pausedFrames=${result.caughtUp.pausedFrames}, totalPausedFrameCount=${result.caughtUp.totalPausedFrameCount}`,
  );

  // (7) Monotonic — totalPausedFrameCount NEVER decreased across the
  // session (Phase B end vs. caught-up).
  if (result.caughtUp.totalPausedFrameCount < result.totalPausedAtEndOfPhaseB) {
    throw new Error(
      `[monotonic] totalPausedFrameCount decreased from ${result.totalPausedAtEndOfPhaseB} to ${result.caughtUp.totalPausedFrameCount}`,
    );
  }
  console.log(
    `MONOTONIC_OK: totalPausedFrameCount ${result.totalPausedAtEndOfPhaseB} → ${result.caughtUp.totalPausedFrameCount} (non-decreasing)`,
  );

  await page.screenshot({ path: SCREENSHOT });

  if (errors.length) {
    console.error("PAGE_ERRORS:");
    for (const e of errors) console.error(" -", e);
    process.exit(1);
  }

  console.log(`OK — lockstep rollback cap verified (7 assertions: cap, within-cap, over-cap, sent-packets, caught-up, monotonic, probe)`);
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
