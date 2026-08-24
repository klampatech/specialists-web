// Two-tab video recorder using Playwright (mirrors the manual-flow smoke
// exactly but adds screenshot capture). The smoke proved both rigs render;
// this just adds frame-by-frame capture + GIF stitching.

import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";

const URL_BASE = "http://100.95.111.112:5174";
const ROOM = "DEVBX";
const WS_HOST = "100.95.111.112";
const WS_PORT = 14434;
const FRAME_INTERVAL_MS = 200;
const WALK_MS = 3000;
const FIRE_COUNT = 5;
const OUT_DIR = "/tmp/cdp-screencast-v2";
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });

const ctxA = await browser.newContext({ viewport: { width: 1024, height: 768 } });
const ctxB = await browser.newContext({ viewport: { width: 1024, height: 768 } });
const pageA = await ctxA.newPage();
const pageB = await ctxB.newPage();

const urlA = `${URL_BASE}/?server=ws://${WS_HOST}:${WS_PORT}/rooms/${ROOM}&localId=1&peerId=2`;
const urlB = `${URL_BASE}/?server=ws://${WS_HOST}:${WS_PORT}/rooms/${ROOM}&localId=2&peerId=1`;

console.log(`URL A: ${urlA}`);
console.log(`URL B: ${urlB}`);

await pageA.goto(urlA, { waitUntil: "load" });
await pageB.goto(urlB, { waitUntil: "load" });

// Wait for both tabs to have remoteController
console.log("Waiting for remoteController on both tabs...");
await pageA.waitForFunction(
  () => window.__gameSession?.remoteController != null,
  null,
  { timeout: 15000 },
);
await pageB.waitForFunction(
  () => window.__gameSession?.remoteController != null,
  null,
  { timeout: 15000 },
);
console.log("Both tabs have remoteController");

await new Promise((r) => setTimeout(r, 1500));

// Rotate cameras to face each other
// Tab A (localId=1, x=-8) needs camera facing +X toward Tab B at x=-4
// Empirically: __applyYawDelta(+π/2) = look +X
await pageA.evaluate(() => window.__applyYawDelta?.(Math.PI / 2));
await pageB.evaluate(() => window.__applyYawDelta?.(-Math.PI / 2));
await new Promise((r) => setTimeout(r, 500));

// Verify
for (const [name, page] of [["A", pageA], ["B", pageB]]) {
  const s = await page.evaluate(() => ({
    yaw: window.__mouseLookProbe?.(),
    localPos: window.__gameSession?.localController?.state?.position,
    remotePos: window.__gameSession?.remoteController?.havok?.getPosition?.(),
    remoteId: window.__gameSession?.remoteController?.playerId,
    localId: window.__localPlayerId,
  }));
  console.log(`Tab ${name} pre-drive:`, JSON.stringify(s));
}

// Recording loop
const frames = [];
const recordingStart = Date.now();
const RECORD_MS = 12000;

const captureFrame = async () => {
  const [bufA, bufB] = await Promise.all([pageA.screenshot(), pageB.screenshot()]);
  return { a: bufA, b: bufB };
};

const drivingPromise = (async () => {
  // Click canvas to focus Tab A
  await pageA.locator("canvas").first().click({ position: { x: 400, y: 300 } });
  await new Promise((r) => setTimeout(r, 300));

  // Walk forward (W) for WALK_MS — camera faces +X so this moves +X toward Tab B
  console.log(`[t+500ms] Tab A: walking forward (W) for ${WALK_MS}ms`);
  await pageA.keyboard.down("w");
  await new Promise((r) => setTimeout(r, WALK_MS));
  await pageA.keyboard.up("w");
  console.log(`[t+${500 + WALK_MS}ms] Tab A: stopped walking`);

  const s = await pageA.evaluate(() => ({
    localPos: window.__gameSession?.localController?.state?.position,
    remotePos: window.__gameSession?.remoteController?.havok?.getPosition?.(),
  }));
  console.log("Tab A after walk:", JSON.stringify(s));

  // Fire 5 shots
  for (let i = 0; i < FIRE_COUNT; i++) {
    console.log(`[fire ${i + 1}/${FIRE_COUNT}]`);
    await pageA.mouse.click(640, 360);
    await new Promise((r) => setTimeout(r, 400));
  }

  await new Promise((r) => setTimeout(r, 2000));
})();

// Capture frames concurrently
while (Date.now() - recordingStart < RECORD_MS) {
  const t0 = Date.now();
  try {
    const frame = await captureFrame();
    frames.push(frame);
  } catch (e) {
    console.error("capture error:", e.message);
  }
  const elapsed = Date.now() - t0;
  if (elapsed < FRAME_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, FRAME_INTERVAL_MS - elapsed));
  }
}
await drivingPromise;

// Final state
for (const [name, page] of [["A", pageA], ["B", pageB]]) {
  const s = await page.evaluate(() => ({
    yaw: window.__mouseLookProbe?.(),
    localPos: window.__gameSession?.localController?.state?.position,
    remotePos: window.__gameSession?.remoteController?.havok?.getPosition?.(),
    hpMe: window.__gameSession?.localController?.state?.hp,
    hpThem: window.__gameSession?.remoteController?.state?.hp,
  }));
  console.log(`Tab ${name} FINAL:`, JSON.stringify(s));
}

console.log(`captured ${frames.length} frames over ${Date.now() - recordingStart}ms`);

for (let i = 0; i < frames.length; i++) {
  writeFileSync(`${OUT_DIR}/frame-${String(i).padStart(3, "0")}-A.png`, frames[i].a);
  writeFileSync(`${OUT_DIR}/frame-${String(i).padStart(3, "0")}-B.png`, frames[i].b);
}
console.log(`frames written to ${OUT_DIR}/`);

await browser.close();