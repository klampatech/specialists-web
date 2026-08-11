// Phase 0 / PR 2 — headless scene smoke test.
//
// Boots a headless Chromium against the running dev server, waits for the
// Babylon scene to finish initializing, captures a screenshot, and fails if
// any pageerror / requestfailed events fired during the load.
//
// Run from the `client/` directory:
//   node ./tools/scene-smoke.mjs
//
// The CI job (`.github/workflows/ci.yml` → `client-scene-smoke`) is the
// authoritative caller. This script is also runnable locally for debugging —
// see the HANDOFF.md "Blockers / open questions" section for the dev-server
// prerequisite.

import { chromium } from "playwright";

const URL = process.env.SCENE_SMOKE_URL ?? "http://localhost:5173/";
const OUT = process.env.SCENE_SMOKE_OUT ?? "./scene-smoke.png";
const NAV_TIMEOUT = Number(process.env.SCENE_SMOKE_NAV_TIMEOUT ?? 30000);
const SCENE_TIMEOUT = Number(process.env.SCENE_SMOKE_SCENE_TIMEOUT ?? 15000);

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
  // Some Vite HMR pings fail during teardown; ignore those.
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

// Allow the render loop to settle a couple of frames so the screenshot
// captures a stable lit scene rather than the first-frame flicker.
await page.waitForTimeout(1500);

await page.screenshot({ path: OUT, fullPage: false });

// Verify the canvas has WebGL (a lit scene requires it).
const canvasInfo = await page.evaluate(() => {
  const c = document.querySelector("canvas");
  if (!c) return { exists: false };
  const gl = c.getContext("webgl2") || c.getContext("webgl");
  return {
    exists: true,
    width: c.width,
    height: c.height,
    hasWebGL: !!gl,
    bannerText: document.body.textContent.trim().slice(0, 200),
  };
});

console.log("CANVAS_INFO:", JSON.stringify(canvasInfo));
console.log("CONSOLE_LOGS_COUNT:", consoleLogs.length);
console.log("ERRORS_COUNT:", errors.length);

if (!canvasInfo.exists) errors.push("[canvas-missing] No <canvas> element in the DOM");
if (!canvasInfo.hasWebGL) errors.push("[webgl-missing] Canvas has no WebGL context");

if (consoleLogs.length) {
  console.log("CONSOLE_LOGS:", JSON.stringify(consoleLogs.slice(0, 30)));
}
if (errors.length) {
  console.error("ERRORS:");
  for (const e of errors) console.error(" -", e);
  await browser.close();
  process.exit(1);
}

console.log("OK — scene smoke passed");
await browser.close();
