#!/usr/bin/env node
// Phase 0 / PR 11.4 — dev-box free-fly spectator camera smoke.
//
// Verifies the PR 11.4 spectator camera contract end-to-end:
//
//   F2 detaches the camera from the character (free-fly at the chase
//   camera's current world position). WASD moves the spectator around.
//   Held-right-click-drag rotates the camera (yaw + pitch). F2 again
//   reattaches to the chase camera.
//
// The smoke drives the spectator headlessly via the DEV probes
// (`__spectatorToggle`, `__spectatorProbe`, `__spectatorMoveDelta`,
// `__spectatorYawDelta`, `__spectatorPitchDelta`) registered in
// `client/src/engine/scene.ts` under `import.meta.env.DEV`.
//
// What this smoke verifies:
//   1. Initial state: spectator is inactive.
//   2. __spectatorToggle() activates. spectator position ≈ current
//      chase camera position (no teleport).
//   3. __spectatorMoveDelta(dx, dy, dz) moves the spectator position.
//   4. __spectatorYawDelta(deltaRadians) updates yaw (mod 2π wrap).
//   5. __spectatorPitchDelta(deltaRadians) clamps at ±π/2 (not wrap).
//   6. __spectatorToggle() deactivates; chase camera resumes.
//   7. Re-toggle preserves a stable yaw.
//   8. With spectator active, a synthetic W keypress doesn't move the
//      character (controller.update is gated).
//   9. Pitch clamp regression guard (push past ±π/2 → final pitch is
//      exactly ±π/2, mirroring the chase camera's clamp behavior).

import { chromium } from "playwright";

const URL = process.env.SPECTATOR_CAMERA_SMOKE_URL ?? "http://localhost:5187/";
const SCREENSHOT = process.env.SPECTATOR_CAMERA_SMOKE_PNG ?? "spectator-camera.png";
const POSITION_TOLERANCE = 0.05; // 5cm
const PITCH_TOLERANCE = 0.0001;
const HALF_PI = Math.PI / 2;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
const errors = [];

page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
page.on("console", (msg) => {
  // Match the project convention (see mouse-pitch-smoke.mjs, pointer-lock-camera-smoke.mjs):
  // surface console.errors EXCEPT for known headless-environment noise (WebGPU adapter
  // unavailable, Babylon/Havok warnings about that, WebGL perf warnings).
  if (msg.type() === "error" && !/WebGPU|Babylon|WebGL|GPU stall/.test(msg.text())) {
    errors.push(`console.error: ${msg.text()}`);
  }
});

try {
  await page.goto(URL, { waitUntil: "networkidle", timeout: 30000 });

  await page.waitForFunction(
    () => typeof window.__spectatorToggle === "function"
      && typeof window.__spectatorProbe === "function"
      && typeof window.__spectatorMoveDelta === "function"
      && typeof window.__spectatorYawDelta === "function"
      && typeof window.__spectatorPitchDelta === "function"
      && typeof window.__chaseCameraProbe === "function"
      && typeof window.__jumpProbe === "function",
    null,
    { timeout: 15000 },
  );
  await page.waitForTimeout(300);

  // (1) Initial state
  const s1 = await page.evaluate(() => window.__spectatorProbe());
  if (s1.active) throw new Error("[bad-initial] spectator should start inactive");
  console.log(`INITIAL_OK: active=false`);

  // (2) Toggle on; spectator position ≈ chase camera position (no teleport).
  await page.evaluate(() => window.__spectatorToggle());
  await page.waitForTimeout(150);

  const s2 = await page.evaluate(() => window.__spectatorProbe());
  if (!s2.active) throw new Error("[toggle-on-fail] didn't activate");
  const chaseAfterToggle = await page.evaluate(() => window.__chaseCameraProbe());
  const posDrift = Math.sqrt(
    Math.pow(s2.cameraPos.x - chaseAfterToggle.cameraPosition.x, 2) +
    Math.pow(s2.cameraPos.y - chaseAfterToggle.cameraPosition.y, 2) +
    Math.pow(s2.cameraPos.z - chaseAfterToggle.cameraPosition.z, 2),
  );
  // Chase lerp continues while spectator is active, so spectator
  // position (frozen at toggle time) drifts up to ~0.5m from the
  // current chase position. Allow 0.5m slack.
  if (posDrift > 0.5) {
    throw new Error(
      `[position-preserve] spectator pos ${JSON.stringify(s2.cameraPos)} ` +
      `drifted ${posDrift.toFixed(4)}m from chase ${JSON.stringify(chaseAfterToggle.cameraPosition)} (expected <= 0.5m)`,
    );
  }
  console.log(`TOGGLE_ON_POSITION_OK: drift=${posDrift.toFixed(4)}m <= 0.5m`);

  // (3) Move delta moves the spectator position.
  await page.evaluate(() => window.__spectatorMoveDelta(5, 0, 3));
  await page.waitForTimeout(100);
  const s3 = await page.evaluate(() => window.__spectatorProbe());
  const moveDrift = Math.sqrt(
    Math.pow(s3.cameraPos.x - (s2.cameraPos.x + 5), 2) +
    Math.pow(s3.cameraPos.y - (s2.cameraPos.y + 0), 2) +
    Math.pow(s3.cameraPos.z - (s2.cameraPos.z + 3), 2),
  );
  if (moveDrift > POSITION_TOLERANCE) {
    throw new Error(
      `[move-delta] spectator pos drifted ${moveDrift.toFixed(4)}m from expected (+5,0,+3)`,
    );
  }
  console.log(`MOVE_DELTA_OK: pos moved by (+5,0,+3), drift=${moveDrift.toFixed(4)}m`);

  // (4) Yaw delta updates yaw.
  await page.evaluate(() => window.__spectatorYawDelta(0.5));
  await page.waitForTimeout(50);
  const s4 = await page.evaluate(() => window.__spectatorProbe());
  const yawDelta = s4.yaw - s2.yaw;
  const yawModDelta = ((yawDelta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  if (Math.abs(yawModDelta - 0.5) > 0.01) {
    throw new Error(
      `[yaw-delta] expected yaw delta ~0.5 rad, got ${yawDelta.toFixed(4)}`,
    );
  }
  console.log(`YAW_DELTA_OK: yaw advanced by ${yawDelta.toFixed(4)} rad`);

  // (4b) Yaw wrap (mod 2π) regression guard.
  await page.evaluate(() => window.__spectatorYawDelta(7.0));
  await page.waitForTimeout(50);
  const s5 = await page.evaluate(() => window.__spectatorProbe());
  if (s5.yaw < 0 || s5.yaw >= 2 * Math.PI) {
    throw new Error(
      `[yaw-wrap] yaw=${s5.yaw.toFixed(4)} out of [0, 2π)`,
    );
  }
  console.log(`YAW_WRAP_OK: yaw=${s5.yaw.toFixed(4)} rad in [0, 2π)`);

  // (5) Pitch delta clamps at +π/2.
  await page.evaluate(() => window.__spectatorPitchDelta(2.0));
  await page.waitForTimeout(50);
  const s6 = await page.evaluate(() => window.__spectatorProbe());
  if (Math.abs(s6.pitch - HALF_PI) > PITCH_TOLERANCE) {
    throw new Error(
      `[pitch-clamp-up] expected pitch=+π/2 after +2.0 delta, got ${s6.pitch.toFixed(4)}`,
    );
  }
  console.log(`PITCH_CLAMP_UP_OK: pitch clamped at +π/2`);

  // (5b) Pitch clamp at -π/2.
  // Note: current pitch is +π/2 from step (5). To cross the -π/2
  // boundary we need `delta < -π` (because +π/2 + delta < -π/2 →
  // delta < -π). -5.0 guarantees the clamp fires regardless of FP
  // drift in the +π/2 starting value.
  await page.evaluate(() => window.__spectatorPitchDelta(-5.0));
  await page.waitForTimeout(50);
  const s7 = await page.evaluate(() => window.__spectatorProbe());
  if (Math.abs(s7.pitch - (-HALF_PI)) > PITCH_TOLERANCE) {
    throw new Error(
      `[pitch-clamp-down] expected pitch=-π/2 after -3.0 delta, got ${s7.pitch.toFixed(4)}`,
    );
  }
  console.log(`PITCH_CLAMP_DOWN_OK: pitch clamped at -π/2`);

  // Reset pitch to level for the WASD-absorbed check.
  // Pass the literal Math.PI/2 — the smoke's local HALF_PI constant
  // isn't visible inside page.evaluate's browser context.
  await page.evaluate(() => window.__spectatorPitchDelta(Math.PI / 2));
  await page.waitForTimeout(50);

  // (6) WASD absorbed — character doesn't move while spectator active.
  const charYBefore = await page.evaluate(() => window.__jumpProbe());
  const charXyzBefore = (await page.evaluate(() => window.__chaseCameraProbe())).characterPosition;
  await page.keyboard.down("w");
  await page.waitForTimeout(500);
  await page.keyboard.up("w");
  await page.waitForTimeout(150);
  const charYAfter = await page.evaluate(() => window.__jumpProbe());
  const charXyzAfter = (await page.evaluate(() => window.__chaseCameraProbe())).characterPosition;
  const charYDelta = Math.abs(charYAfter - charYBefore);
  const charXzDelta = Math.sqrt(
    Math.pow(charXyzAfter.x - charXyzBefore.x, 2) +
    Math.pow(charXyzAfter.z - charXyzBefore.z, 2),
  );
  if (charYDelta > POSITION_TOLERANCE || charXzDelta > POSITION_TOLERANCE) {
    throw new Error(
      `[wasd-absorbed] character moved while spectator active: Δy=${charYDelta.toFixed(4)}, Δxz=${charXzDelta.toFixed(4)}`,
    );
  }
  console.log(
    `WASD_ABSORBED_OK: character stationary during spectator (Δy=${charYDelta.toFixed(4)}, Δxz=${charXzDelta.toFixed(4)})`,
  );

  // (7) Toggle off.
  await page.evaluate(() => window.__spectatorToggle());
  await page.waitForTimeout(150);
  const s8 = await page.evaluate(() => window.__spectatorProbe());
  if (s8.active) throw new Error("[toggle-off-fail] didn't deactivate");
  console.log(`TOGGLE_OFF_OK: spectator deactivated`);

  // (8) Re-toggle — yaw preserved across off/on.
  await page.evaluate(() => window.__spectatorToggle());
  await page.waitForTimeout(100);
  await page.evaluate(() => window.__spectatorYawDelta(1.2));
  await page.waitForTimeout(50);
  const s9a = await page.evaluate(() => window.__spectatorProbe());
  await page.evaluate(() => window.__spectatorToggle());
  await page.waitForTimeout(100);
  await page.evaluate(() => window.__spectatorToggle());
  await page.waitForTimeout(100);
  const s9b = await page.evaluate(() => window.__spectatorProbe());
  const yawPreservedDelta = Math.abs(s9b.yaw - s9a.yaw);
  if (yawPreservedDelta > 0.01) {
    throw new Error(
      `[toggle-preserve] yaw drifted across off/on toggle: before=${s9a.yaw.toFixed(4)}, after=${s9b.yaw.toFixed(4)}`,
    );
  }
  console.log(`TOGGLE_PRESERVE_OK: yaw preserved across off/on toggle`);

  // Final toggle off to leave the page in a clean state.
  await page.evaluate(() => window.__spectatorToggle());
  await page.waitForTimeout(100);

  await page.screenshot({ path: SCREENSHOT });

  if (errors.length) {
    console.error("PAGE_ERRORS:");
    for (const e of errors) console.error(" -", e);
    process.exit(1);
  }

  console.log("OK — spectator camera (PR 11.4) verified end-to-end");
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
