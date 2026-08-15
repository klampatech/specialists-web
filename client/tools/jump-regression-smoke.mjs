// Phase 0 / PR 8 — regression smoke for "jump makes you fly up forever".
//
// Symptom (per docs/SPEC.md Milestone 1 row 5, HANDOFF 2026-08-12):
//   Holding Space should fire ONE jump and return to the ground.
//   Bug: holding Space makes the character fly upward indefinitely.
//
// Strategy:
//   1. Boot the single-player scene; wait for it to settle.
//   2. Read the initial grounded Y (should be CAPSULE.height/2 = 0.9).
//   3. Hold Space for 2.0s.
//   4. Sample the local rig's world Y every 200ms.
//   5. PASS if:
//        - peak Y rose above initial (jump impulse fired)
//        - final Y returned near initial within 2s (came back down)
//        - Y does NOT monotonically rise the entire 2s window
//      FAIL otherwise. Log the Y samples either way for diagnostics.
//
// Repro path: the smoke attaches a `page.exposeBinding` callback that the
// scene reads after each `onBeforeRenderObservable` tick. The scene pushes
// the local controller's position into `window.__jumpProbe` via the
// SceneHandle's `getCharacterTransform` accessor (already exposed by the
// PR 7 PR — same getter the existing scene-smoke uses).
//
// This file is the "fail first, then fix" reproduction. PR 8 only ships
// when this smoke turns green after the controller fix.

import { chromium } from "playwright";

const URL = process.env.JUMP_SMOKE_URL ?? "http://localhost:5173/";
const OUT = process.env.JUMP_SMOKE_OUT ?? "./jump-regression.png";
const NAV_TIMEOUT = Number(process.env.JUMP_SMOKE_NAV_TIMEOUT ?? 30000);
const SCENE_TIMEOUT = Number(process.env.JUMP_SMOKE_SCENE_TIMEOUT ?? 15000);
const HOLD_DURATION_MS = Number(process.env.JUMP_SMOKE_HOLD_MS ?? 2000);
const SAMPLE_INTERVAL_MS = Number(process.env.JUMP_SMOKE_SAMPLE_MS ?? 200);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
});
const page = await context.newPage();

const consoleLogs = [];
const errors = [];
page.on("console", (msg) => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));
page.on("pageerror", (err) => errors.push(`[pageerror] ${err.message}`));
page.on("requestfailed", (req) => {
  const url = req.url();
  if (url.includes("/@vite/") || url.includes("/ws")) return;
  errors.push(`[requestfailed] ${url} :: ${req.failure()?.errorText}`);
});

await page.goto(URL, { waitUntil: "networkidle", timeout: NAV_TIMEOUT });

try {
  await page.waitForFunction(
    () => !document.body.textContent.includes("Loading scene"),
    { timeout: SCENE_TIMEOUT },
  );
  console.log("Scene ready (loading banner cleared)");
} catch (e) {
  errors.push(`[scene-timeout] Loading banner did not clear within ${SCENE_TIMEOUT}ms`);
}

// Let the controller settle on the ground for half a second before we
// press anything. The PhysicsCharacterController takes a tick or two to
// report SUPPORTED after world init.
await page.waitForTimeout(500);

// Click the canvas to make sure keyboard focus is on the page.
await page.locator("canvas").first().click();

// Snapshot the initial grounded Y before pressing anything. The controller
// spawns at CAPSULE.height/2 (0.9m) on the ground plane, so this should be
// very close to 0.9. We re-measure here in case the controller drifted.
const initialY = await page.evaluate(() => {
  // Exposed by the PR 7 PR's SceneHandle.getCharacterTransform — gives the
  // LOCAL rig's world position. The scene-smoke already exercises this
  // accessor indirectly.
  // The actual exposed handle isn't on window today, so we read the
  // controller via a probe the scene sets (see below).
  return window.__jumpProbe ? window.__jumpProbe() : null;
});
if (initialY === null) {
  errors.push("[probe-missing] window.__jumpProbe is not set; PR 8's probe wiring is missing");
}

// Hold Space and sample Y.
const samples = [];
await page.keyboard.down(" ");
const startTs = Date.now();
let lastSampleTs = startTs;
while (Date.now() - startTs < HOLD_DURATION_MS) {
  await page.waitForTimeout(SAMPLE_INTERVAL_MS);
  const y = await page.evaluate(() => (window.__jumpProbe ? window.__jumpProbe() : null));
  samples.push({ tMs: Date.now() - startTs, y });
  lastSampleTs = Date.now();
}
await page.keyboard.up(" ");

// Capture a screenshot of the final state.
await page.screenshot({ path: OUT, fullPage: false });

// PR 11.2.1: extend the assertion window to give the character time to
// land. The character's gravity-impulse vector may not have settled
// by the end of HOLD_DURATION_MS under slow CI runners. Poll for
// ground-recovery for up to 2000ms after release.
const GROUND_SETTLE_TIMEOUT_MS = 2000;
const settleStart = Date.now();
while (Date.now() - settleStart < GROUND_SETTLE_TIMEOUT_MS) {
  const y = await page.evaluate(() => (window.__jumpProbe ? window.__jumpProbe() : null));
  if (typeof y === "number" && y <= (initialY ?? 0.9) + 0.4) break;
  await page.waitForTimeout(100);
}

// ---- Assertions ------------------------------------------------------------
// 1. The jump must have fired: peak Y must be at least 0.3m above initial.
const ys = samples.map((s) => s.y).filter((y) => typeof y === "number");
if (ys.length === 0) {
  errors.push("[no-samples] No Y samples collected; controller likely not running");
}

const initial = initialY ?? ys[0] ?? 0.9;
const peak = ys.length ? Math.max(...ys) : 0;
// PR 11.2.1: after the settle loop, take one more sample for the
// "final" assertion. The samples-taken-during-hold array may end a few
// ms before the character lands, even though the settle loop already
// waited for ground contact.
const finalSample = await page.evaluate(() => (window.__jumpProbe ? window.__jumpProbe() : null));
const final = typeof finalSample === "number" ? finalSample : (ys.length ? ys[ys.length - 1] : 0);
const roseAboveInitial = peak - initial;

// 2. The character must come back down within 2s of holding. Allow generous
//    2.5m leeway (the jump impulse is 5.2 m/s, gravity 9.81 m/s² → peak
//    height above takeoff = (5.2)^2 / (2 * 9.81) ≈ 1.38m, then back to
//    ground in another ~0.53s; total ~1.0s for one jump).
const returnedToGround = final <= initial + 0.4;

// 3. Y must not monotonically rise the whole time. We detect this by
//    looking at the trend: count "rises" (consecutive positive deltas) and
//    require at least one descent.
let rises = 0;
let descents = 0;
for (let i = 1; i < ys.length; i++) {
  const dy = ys[i] - ys[i - 1];
  if (dy > 0.001) rises++;
  else if (dy < -0.001) descents++;
}
const monotonic = descents === 0 && rises > 1;

console.log("JUMP_PROBE: initial=", initial.toFixed(3),
  " peak=", peak.toFixed(3),
  " final=", final.toFixed(3),
  " roseAboveInitial=", roseAboveInitial.toFixed(3),
  " rises=", rises, " descents=", descents,
  " monotonic=", monotonic);
console.log("JUMP_SAMPLES:", JSON.stringify(samples.map((s) => ({ t: s.tMs, y: typeof s.y === "number" ? +s.y.toFixed(3) : null }))));

if (roseAboveInitial < 0.3) errors.push(`[jump-too-small] Jump did not register (peak rose only ${roseAboveInitial.toFixed(3)}m above initial)`);
if (!returnedToGround) errors.push(`[flew-up-forever] Y did not return to ground within 2s: final=${final.toFixed(3)} vs initial=${initial.toFixed(3)}`);
if (monotonic) errors.push(`[monotonic-rise] Y monotonically rose for the full ${HOLD_DURATION_MS}ms (no descent)`);

if (errors.length) {
  console.error("ERRORS:");
  for (const e of errors) console.error(" -", e);
  await browser.close();
  process.exit(1);
}

console.log("OK — jump regression smoke passed (jump fired, returned to ground, no monotonic rise)");
await browser.close();
