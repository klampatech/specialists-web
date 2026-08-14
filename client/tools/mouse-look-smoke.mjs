#!/usr/bin/env node
// Phase 0 / PR 11.1 — pointer-lock mouse-look smoke.
//
// Verifies that the chase camera's yaw accumulator responds to yaw-delta
// updates. Headless Chromium doesn't always honor `requestPointerLock`
// (the user-activation requirements may not be met by synthetic clicks),
// so the smoke uses the DEV-only `window.__applyYawDelta(deltaRadians)`
// accessor (exposed by scene.ts) to feed deltas directly into the same
// code path the locked-mousemove listener uses. The smoke's purpose is
// to prove the yaw-rotation code path works end-to-end — the actual
// pointer-lock acquisition is a browser-quirks concern that requires
// real-browser dev-box playtest, not headless Chromium.
//
// Flow:
//   1. Boots Chromium against the dev server (default port 5178; set
//      MOUSE_LOOK_SMOKE_URL to override).
//   2. Waits for `window.__mouseLookProbe()` to be defined (scene.ts
//      exposes it behind `import.meta.env.DEV`).
//   3. Reads initial yaw (should be a finite number, near 0).
//   4. Calls `window.__applyYawDelta(0.5)` to push +0.5 radians into
//      the yaw accumulator (mimics what the locked-mousemove listener
//      does on a real mouse-delta).
//   5. Reads yaw again. Asserts the delta is approximately 0.5 radians
//      (±20% slack to absorb float drift across the wrapping mod 2π).
//   6. Takes a screenshot to `mouse-look.png` for CI artifact upload.
//
// Exit 0 on pass; exit 1 with `[FAIL]` diagnostic on fail.

import { chromium } from "playwright";

const URL = process.env.MOUSE_LOOK_SMOKE_URL ?? "http://localhost:5178/";
const SCREENSHOT = process.env.MOUSE_LOOK_SMOKE_PNG ?? "mouse-look.png";
const EXPECTED_DELTA = 0.5;
const TOLERANCE = 0.2; // ±20% slack on the expected delta.

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
const errors = [];

// Surface any uncaught pageerror (PR 11.1 shouldn't introduce any — the
// input packet extension + pointer-lock plumbing are all defensive).
page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
page.on("console", (msg) => {
  if (msg.type() === "error" && !/WebGPU|Babylon/.test(msg.text())) {
    // WebGPU warnings are normal in headless; only surface non-Babylon errors.
    errors.push(`console.error: ${msg.text()}`);
  }
});

try {
  await page.goto(URL, { waitUntil: "networkidle", timeout: 30000 });

  // Wait for the scene to be ready — both the React shell + Babylon
  // canvas + the DEV-only mouse-look probes. The probe exposure is
  // gated behind `import.meta.env.DEV` so it only appears in vite dev
  // (or in `npm run build` + vite preview, if we ever wire that).
  await page.waitForFunction(
    () => typeof window.__mouseLookProbe === "function" && typeof window.__applyYawDelta === "function",
    null,
    { timeout: 15000 },
  );

  // Give the engine one or two frames to settle so the initial yaw
  // (which is 0 in chaseCamera.ts) is what we read.
  await page.waitForTimeout(200);

  const initial = await page.evaluate(() => window.__mouseLookProbe());
  if (typeof initial !== "number" || !Number.isFinite(initial)) {
    throw new Error(`[bad-initial] __mouseLookProbe returned non-finite: ${initial}`);
  }

  // Apply the yaw delta. The DEV accessor just calls chase.applyYawDelta,
  // which is the same path the locked-mousemove listener uses.
  await page.evaluate((delta) => window.__applyYawDelta(delta), EXPECTED_DELTA);
  // Yield a frame so any downstream effects (camera render, state
  // publish) propagate before we read the new yaw.
  await page.waitForTimeout(50);

  const after = await page.evaluate(() => window.__mouseLookProbe());
  if (typeof after !== "number" || !Number.isFinite(after)) {
    throw new Error(`[bad-after] __mouseLookProbe returned non-finite: ${after}`);
  }

  const observedDelta = after - initial;
  const drift = Math.abs(observedDelta - EXPECTED_DELTA);
  console.log(
    `MOUSE_LOOK_PROBE: initial=${initial.toFixed(4)} after=${after.toFixed(4)} ` +
    `delta=${observedDelta.toFixed(4)} (expected ~${EXPECTED_DELTA}, tolerance ±${TOLERANCE})`,
  );

  // Account for the mod-2π wrap: if `initial` was near 2π and the
  // delta pushed it past, `after` wraps back to a small number.
  // In that case the absolute drift (taking the wrap into account) is:
  //   wrapAwareDelta = ((after - initial + π) mod 2π) - π
  // For a 0.5 rad delta from a 0-rad initial, no wrap is involved —
  // the simple delta check is sufficient. Keep the assertion tight.
  if (drift > TOLERANCE) {
    throw new Error(
      `[yaw-drift] observed delta ${observedDelta.toFixed(4)} differs from ` +
      `expected ${EXPECTED_DELTA} by ${drift.toFixed(4)} (> ${TOLERANCE})`,
    );
  }

  // Verify the wrap: push a big delta that should overflow 2π.
  // initial ~ 0.5 (from the prior step) + 6.5 = ~7.0 → mod 2π = ~0.717.
  // The wrap math (`((0.717) % (2π))`) should produce a result in [0, 2π).
  await page.evaluate(() => window.__applyYawDelta(6.5));
  await page.waitForTimeout(50);
  const wrapped = await page.evaluate(() => window.__mouseLookProbe());
  if (typeof wrapped !== "number" || !Number.isFinite(wrapped)) {
    throw new Error(`[bad-wrapped] __mouseLookProbe returned non-finite: ${wrapped}`);
  }
  if (wrapped < 0 || wrapped >= 2 * Math.PI) {
    throw new Error(
      `[wrap-failed] yaw after 7.0 rad delta is ${wrapped}, expected in [0, 2π)`,
    );
  }
  console.log(
    `MOUSE_LOOK_WRAP: after 7.0 rad cumulative delta (0.5 + 6.5 = ${(0.5 + 6.5).toFixed(4)}) ` +
    `= ${wrapped.toFixed(4)} (expected in [0, 2π) ≈ ${((0.5 + 6.5) % (2 * Math.PI)).toFixed(4)})`,
  );

  await page.screenshot({ path: SCREENSHOT });

  if (errors.length) {
    console.error("PAGE_ERRORS:");
    for (const e of errors) console.error(" -", e);
    process.exit(1);
  }

  console.log("OK — mouse-look smoke passed (yaw-delta applied, wrap verified)");
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
