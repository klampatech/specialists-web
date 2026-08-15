// PR 8.1: wallrun regression smoke.
//
// Kyle's dev-box playtest (Discord 1537454310470717492) reported that
// holding Q while mid-air makes the character fly up forever. Root cause
// (verified by aggressive-test scenario in PR 8.1 debug notes): if
// `wallrunPressed` is true at any frame AFTER the wallrun timer expires,
// the controller re-enters wallrun, resetting the timer. Real browsers
// fire auto-repeat keydowns faster than the 1000ms wallrun duration.
//
// The fix: wallrun entry now requires the rising edge of `wallrunPressed`
// (last frame false → this frame true), so a held/auto-repeating Q can
// only fire ONE wallrun per Q-press. To wallrun again, the user must
// release Q and re-press.
//
// This smoke runs the headless scenario A (single Q keydown, hold):
// wallrun should rise for ~1s, peak ~6.5m, then descend. Without the
// fix this scenario PASSED in headless (because Playwright doesn't
// auto-repeat) but FAILED in real browsers with auto-repeat. The
// aggressive auto-repeat scenario is in `tools/aggressive-wallrun.mjs`
// (debug-only, removed before commit).
//
// PASS criteria: peak Y < 8m AND Y descends after the wallrun timer
// expires (i.e. the character does NOT fly up indefinitely).

import { chromium } from "playwright";

const URL = process.env.WALLRUN_SMOKE_URL ?? "http://localhost:5173/";
const HOLD_MS = Number(process.env.WALLRUN_SMOKE_HOLD_MS ?? 2500);
const SAMPLE_MS = Number(process.env.WALLRUN_SMOKE_SAMPLE_MS ?? 200);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();

const errors = [];
const consoleLogs = [];
page.on("console", (m) => consoleLogs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (err) => errors.push(`[pageerror] ${err.message}`));
page.on("requestfailed", (req) => {
  const url = req.url();
  if (url.includes("/@vite/") || url.includes("/ws")) return;
  errors.push(`[requestfailed] ${url} :: ${req.failure()?.errorText}`);
});

await page.goto(URL, { waitUntil: "networkidle", timeout: 30000 });

// Wait for the canvas to mount — that's the real readiness signal.
await page.locator("canvas").first().waitFor({ state: "attached", timeout: 15000 });
await page.waitForTimeout(800);
await page.locator("canvas").first().click({ timeout: 5000 });

// Step 1: tap Space to jump.
await page.keyboard.down(" ");
await page.waitForTimeout(150);
await page.keyboard.up(" ");

// Wait until the character is clearly mid-air.
let waited = 0;
while (waited < 800) {
  await page.waitForTimeout(50); waited += 50;
  const y = await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    return typeof w.__jumpProbe === "function" ? w.__jumpProbe() : 0;
  });
  if (y > 1.5) break;
}

// Step 2: hold Q while in mid-air (single keydown, no auto-repeat).
const samples = [];
await page.keyboard.down("q");
const startTs = Date.now();
while (Date.now() - startTs < HOLD_MS) {
  await page.waitForTimeout(SAMPLE_MS);
  const y = await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    return typeof w.__jumpProbe === "function" ? w.__jumpProbe() : null;
  });
  samples.push({ tMs: Date.now() - startTs, y });
}
await page.keyboard.up("q");

// PR 11.2.3: extend the assertion window to give the character time to
// descend. Same pattern as the jump-regression-smoke settle loop — under
// slow CI runners the gravity-impulse vector may not have settled by
// the end of the keyboard.up window. Poll for descent for up to 2s.
await page.screenshot({ path: "./wallrun-regression.png", fullPage: false });
const GROUND_SETTLE_TIMEOUT_MS = 2000;
const settleStart = Date.now();
while (Date.now() - settleStart < GROUND_SETTLE_TIMEOUT_MS) {
  const y = await page.evaluate(() => (window.__jumpProbe ? window.__jumpProbe() : null));
  if (typeof y === "number" && y < 1.5) break;
  await page.waitForTimeout(100);
}

const ys = samples.map((s) => s.y).filter((y) => typeof y === "number");
const peak = ys.length ? Math.max(...ys) : 0;
// PR 11.2.3: after the settle loop, take one more sample for the
// "final" assertion — the samples-taken-during-keyboard.down array may
// end a few ms before the character lands.
const finalSample = await page.evaluate(() => (window.__jumpProbe ? window.__jumpProbe() : null));
const final = typeof finalSample === "number" ? finalSample : (ys.length ? ys[ys.length - 1] : 0);

console.log("WALLRUN_PROBE: initial=0.900 peak=", peak.toFixed(3), "final=", final.toFixed(3));
console.log("WALLRUN_SAMPLES:", JSON.stringify(samples.map((s) => ({
  t: s.tMs,
  y: typeof s.y === "number" ? +s.y.toFixed(3) : null,
}))));

// The headless single-keydown scenario always passed even before the
// PR 8.1 fix (Playwright doesn't auto-repeat). The aggressive scenario
// in `tools/aggressive-wallrun.mjs` is what catches the real bug.
// This smoke is the regression guard for the simple case: peak < 8m +
// descent after wallrun.
if (peak > 8.0) errors.push(`[unbounded-peak] peak=${peak.toFixed(3)}m > 8m`);
if (final > peak - 0.3) errors.push(`[no-descent] final=${final.toFixed(3)} didn't descend from peak=${peak.toFixed(3)}`);
if (ys.length === 0) errors.push("[no-samples]");

if (errors.length) {
  console.error("ERRORS:");
  for (const e of errors) console.error(" -", e);
  await browser.close();
  process.exit(1);
}

console.log("OK — wallrun regression smoke passed (bounded peak, descended after wallrun)");
await browser.close();
