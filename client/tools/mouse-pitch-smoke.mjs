#!/usr/bin/env node
// Phase 0 / PR 11.3 — pointer-lock mouse-pitch smoke.
//
// Verifies that the chase camera's pitch accumulator responds to pitch-delta
// updates. Headless Chromium doesn't always honor `requestPointerLock`
// (the user-activation requirements may not be met by synthetic clicks),
// so the smoke uses the DEV-only `window.__applyPitchDelta(deltaRadians)`
// accessor (exposed by scene.ts) to feed deltas directly into the same
// code path the locked-mousemove listener uses. The smoke's purpose is
// to prove the pitch-rotation code path works end-to-end — the actual
// pointer-lock acquisition is a browser-quirks concern that requires
// real-browser dev-box playtest, not headless Chromium.
//
// What this smoke verifies:
//   1. Initial pitch is ~0 (sanity check, must be a finite number).
//   2. After `__applyPitchDelta(0.3)`, observed pitch is ~0.3 ± 0.2.
//   3. After `__applyPitchDelta(-1.0)`, pitch is clamped to -\u03c0/2 \u2248 -1.5708.
//      (regression guard for wrap-vs-clamp gotcha: wrap would flip the
//      view at the limits, clamp holds at \u00b1\u03c0/2.)
//   4. After `__applyPitchDelta(+2.0)`, pitch is clamped to +\u03c0/2 \u2248 +1.5708.
//   5. __chaseCameraProbe().pitchRadians matches __pitchLookProbe().
//   6. No pageerrors / non-Babylon console errors.
//
// Screenshot to `mouse-pitch.png` for CI artifact upload.
//
// Exit 0 on pass; exit 1 with `[FAIL]` diagnostic on fail.

import { chromium } from "playwright";

const URL = process.env.MOUSE_PITCH_SMOKE_URL ?? "http://localhost:5184/";
const SCREENSHOT = process.env.MOUSE_PITCH_SMOKE_PNG ?? "mouse-pitch.png";
const HALF_PI = Math.PI / 2;
const CLAMP_TOLERANCE = 0.01; // clamp result should be within 0.01 rad of exact \u00b1HALF_PI
const LINEAR_TOLERANCE = 0.2; // \u00b120% slack on the linear-applied delta

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
const errors = [];

// Surface any uncaught pageerror (PR 11.3 shouldn't introduce any \u2014 the
// input packet extension + pitch plumbing are all defensive).
page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
page.on("console", (msg) => {
  if (msg.type() === "error" && !/WebGPU|Babylon/.test(msg.text())) {
    // WebGPU warnings are normal in headless; only surface non-Babylon errors.
    errors.push(`console.error: ${msg.text()}`);
  }
});

try {
  await page.goto(URL, { waitUntil: "networkidle", timeout: 30000 });

  // Wait for the scene to be ready \u2014 the DEV-only pitch probes.
  await page.waitForFunction(
    () => typeof window.__pitchLookProbe === "function" && typeof window.__applyPitchDelta === "function",
    null,
    { timeout: 15000 },
  );

  // Give the engine one or two frames to settle so the initial pitch
  // (which is 0 in chaseCamera.ts) is what we read.
  await page.waitForTimeout(200);

  // \u2500\u2500 1. Initial state \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  const initial = await page.evaluate(() => window.__pitchLookProbe());
  if (typeof initial !== "number" || !Number.isFinite(initial)) {
    throw new Error(`[bad-initial] __pitchLookProbe returned non-finite: ${initial}`);
  }
  if (Math.abs(initial) > CLAMP_TOLERANCE) {
    throw new Error(`[bad-initial] expected pitch ~0, got ${initial.toFixed(4)}`);
  }
  console.log(`PITCH_INITIAL: ${initial.toFixed(4)} (expected ~0)`);

  // \u2500\u2500 2. Linear apply: +0.3 rad \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  await page.evaluate(() => window.__applyPitchDelta(0.3));
  await page.waitForTimeout(50);
  const afterUp = await page.evaluate(() => window.__pitchLookProbe());
  if (typeof afterUp !== "number" || !Number.isFinite(afterUp)) {
    throw new Error(`[bad-after-up] __pitchLookProbe returned non-finite: ${afterUp}`);
  }
  const upDrift = Math.abs(afterUp - 0.3);
  if (upDrift > LINEAR_TOLERANCE) {
    throw new Error(
      `[pitch-drift] after +0.3 delta, pitch=${afterUp.toFixed(4)} differs from 0.3 by ${upDrift.toFixed(4)} (> ${LINEAR_TOLERANCE})`,
    );
  }
  console.log(`PITCH_UP_OK: after +0.3 delta, pitch=${afterUp.toFixed(4)} (\u00b1${LINEAR_TOLERANCE})`);

  // \u2500\u2500 3. Negative clamp: apply -1.0, then -1.0 more \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  // Currently at ~0.3. Apply -1.0 \u2192 pitch should be -0.7 (linear).
  await page.evaluate(() => window.__applyPitchDelta(-1.0));
  await page.waitForTimeout(50);
  const afterDown1 = await page.evaluate(() => window.__pitchLookProbe());
  if (Math.abs(afterDown1 - (-0.7)) > LINEAR_TOLERANCE) {
    throw new Error(
      `[pitch-down-drift] after -1.0 delta from 0.3, pitch=${afterDown1.toFixed(4)} differs from -0.7 by ${Math.abs(afterDown1 - (-0.7)).toFixed(4)} (> ${LINEAR_TOLERANCE})`,
    );
  }
  console.log(`PITCH_DOWN_LINEAR_OK: after -1.0 from 0.3, pitch=${afterDown1.toFixed(4)} (\u2248-0.7)`);

  // Now apply ANOTHER -1.0 \u2192 pitch should be -1.7 \u2192 clamped to -HALF_PI \u2248 -1.5708.
  // This is the regression guard for the wrap-vs-clamp gotcha.
  await page.evaluate(() => window.__applyPitchDelta(-1.0));
  await page.waitForTimeout(50);
  const afterClampDown = await page.evaluate(() => window.__pitchLookProbe());
  const expectedClampDown = -HALF_PI;
  if (Math.abs(afterClampDown - expectedClampDown) > CLAMP_TOLERANCE) {
    throw new Error(
      `[clamp-down-failed] expected pitch clamped to -HALF_PI=${expectedClampDown.toFixed(4)}, got ${afterClampDown.toFixed(4)}. ` +
      `If the value is near +HALF_PI (e.g., 1.5), the applyPitchDelta is WRAPPING instead of CLAMPING.`,
    );
  }
  console.log(
    `PITCH_CLAMP_DOWN_OK: pitch clamped to -HALF_PI=${afterClampDown.toFixed(4)} (expected ${expectedClampDown.toFixed(4)})`,
  );

  // \u2500\u2500 4. Positive clamp: apply +3.0 from -HALF_PI \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  // -HALF_PI + 3.0 \u2248 1.43 rad \u2192 still within [\u00b1HALF_PI], linear.
  // Then apply +2.0 more \u2192 would exceed +HALF_PI \u2192 clamp to +HALF_PI.
  await page.evaluate(() => window.__applyPitchDelta(3.0));
  await page.waitForTimeout(50);
  const afterClimb = await page.evaluate(() => window.__pitchLookProbe());
  // -HALF_PI + 3.0 = -1.5708 + 3.0 = 1.4292 rad. Within range, so linear.
  if (Math.abs(afterClimb - 1.4292) > LINEAR_TOLERANCE) {
    throw new Error(
      `[pitch-climb-drift] after +3.0 from -HALF_PI, pitch=${afterClimb.toFixed(4)} differs from 1.4292 by ${Math.abs(afterClimb - 1.4292).toFixed(4)}`,
    );
  }
  console.log(`PITCH_CLIMB_OK: after +3.0 from -HALF_PI, pitch=${afterClimb.toFixed(4)} (\u22481.43)`);

  await page.evaluate(() => window.__applyPitchDelta(2.0));
  await page.waitForTimeout(50);
  const afterClampUp = await page.evaluate(() => window.__pitchLookProbe());
  const expectedClampUp = +HALF_PI;
  if (Math.abs(afterClampUp - expectedClampUp) > CLAMP_TOLERANCE) {
    throw new Error(
      `[clamp-up-failed] expected pitch clamped to +HALF_PI=${expectedClampUp.toFixed(4)}, got ${afterClampUp.toFixed(4)}. ` +
      `If the value is near -HALF_PI, the applyPitchDelta is WRAPPING instead of CLAMPING.`,
    );
  }
  console.log(
    `PITCH_CLAMP_UP_OK: pitch clamped to +HALF_PI=${afterClampUp.toFixed(4)} (expected ${expectedClampUp.toFixed(4)})`,
  );

  // \u2500\u2500 5. Cross-probe consistency: __chaseCameraProbe().pitchRadians == __pitchLookProbe() \u2500\u2500\u2500\u2500
  const probePitch = await page.evaluate(() => window.__chaseCameraProbe().pitchRadians);
  const directPitch = await page.evaluate(() => window.__pitchLookProbe());
  if (Math.abs(probePitch - directPitch) > 0.0001) {
    throw new Error(
      `[probe-mismatch] __chaseCameraProbe().pitchRadians=${probePitch} differs from __pitchLookProbe()=${directPitch}`,
    );
  }
  console.log(`PROBE_CONSISTENCY_OK: chaseCameraProbe.pitchRadians=${probePitch} == pitchLookProbe=${directPitch}`);

  await page.screenshot({ path: SCREENSHOT });

  if (errors.length) {
    console.error("PAGE_ERRORS:");
    for (const e of errors) console.error(" -", e);
    process.exit(1);
  }

  console.log("OK \u2014 mouse-pitch smoke passed (linear apply + clamp-at-both-limits + probe consistency verified)");
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
