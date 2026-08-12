// Phase 0 / PR 4 — two-tab WebRTC handshake smoke test.
//
// Boots a headless Chromium against the running dev server, opens two pages
// (tab A as host, tab B as guest), drives the manual copy-paste SDP/ICE
// handshake end-to-end, asserts both tabs reach the "Connected" state,
// captures a screenshot per tab, and exits 0 on success.
//
// Run from the `client/` directory (CI does this automatically):
//   node ./tools/two-tab-smoke.mjs
//
// Env vars:
//   URL                 — http://localhost:5173/  (override for staging)
//   CONNECT_TIMEOUT_MS  — max ms to wait for the "Connected" status
//                          per tab (default 30000)
//
// Why a single-script multi-line rewrite of the previous 1-liner:
//   The old `two-tab-smoke.mjs` only exchanged blobs and called it a day.
//   The PR-4 acceptance test for row 1 is "Both tabs show Connected" — the
//   true proof that the WebRTC data channels opened on both ends AND the
//   lockstep is actually exchanging. Anything that can be faked by `console.log`
//   before either side opens its channels is not a smoke test.

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const URL = process.env.URL ?? "http://localhost:5173/";
const CONNECT_TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS ?? 30000);
const STUN_FLAGS = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
];

const browser = await chromium.launch({
  headless: true,
  args: STUN_FLAGS,
});
const ctx = await browser.newContext();

// Two separate pages so they look like two real tabs to the browser.
const a = await ctx.newPage();
const b = await ctx.newPage();

// Surface any in-page errors so the dev console doesn't swallow the real
// reason a step failed.
a.on("pageerror", (e) => console.log("[A pageerror]", e.message));
b.on("pageerror", (e) => console.log("[B pageerror]", e.message));
a.on("console", (m) => {
  if (m.type() === "error") console.log("[A console.error]", m.text());
});
b.on("console", (m) => {
  if (m.type() === "error") console.log("[B console.error]", m.text());
});

await a.goto(URL, { waitUntil: "domcontentloaded" });
await b.goto(URL, { waitUntil: "domcontentloaded" });

// Wait for the React shell to mount the WebRTC overlay.
await a.waitForSelector('[data-testid="peer-overlay"]', { timeout: 15000 });
await b.waitForSelector('[data-testid="peer-overlay"]', { timeout: 15000 });

// ---- Host (tab A): generate the SDP offer -----------------------------
console.log("Tab A: generating offer…");
await a.locator('[data-testid="btn-create"]').click();
await a.locator('[data-testid="offer-blob"]').waitFor({ timeout: 30000 });
const offer = await a.locator('[data-testid="offer-blob"]').inputValue();
if (!offer || offer.length < 100) {
  console.log(`[FAIL] tab A produced no/incomplete offer (len=${offer?.length})`);
  await browser.close();
  process.exit(1);
}
console.log(`Tab A: offer produced (${offer.length} chars)`);

// ---- Guest (tab B): join via the offer as a URL query param, then
//      click "Join" to generate the SDP answer.
console.log("Tab B: joining via offer URL…");
await b.goto(`${URL}?join=${encodeURIComponent(offer)}`, {
  waitUntil: "domcontentloaded",
});
await b.waitForSelector('[data-testid="peer-overlay"]', { timeout: 15000 });
await b.locator('[data-testid="btn-join"]').click();
await b.locator('[data-testid="answer-blob"]').waitFor({ timeout: 30000 });
const answer = await b.locator('[data-testid="answer-blob"]').inputValue();
if (!answer || answer.length < 100) {
  console.log(`[FAIL] tab B produced no/incomplete answer (len=${answer?.length})`);
  await browser.close();
  process.exit(1);
}
console.log(`Tab B: answer produced (${answer.length} chars)`);

// ---- Host (tab A): paste the answer and complete the handshake -----
console.log("Tab A: pasting answer…");
await a.locator('[data-testid="paste-area"]').fill(answer);
await a.locator('[data-testid="btn-paste-answer"]').click();

// ---- Both tabs reach "Connected" --------------------------------------
console.log("Waiting for both tabs to reach Connected…");
await Promise.all([
  a.locator('[data-testid="status"]').filter({ hasText: "Connected" }).waitFor({ timeout: CONNECT_TIMEOUT_MS }),
  b.locator('[data-testid="status"]').filter({ hasText: "Connected" }).waitFor({ timeout: CONNECT_TIMEOUT_MS }),
]);
console.log("Both tabs reached Connected state.");

// ---- Drive the local character in tab A; assert the lockstep runtime
//      exchanged at least a few frames (HUD shows frame number > 0). ---
await a.locator("canvas").first().focus();
await a.keyboard.down("w");
await new Promise((r) => setTimeout(r, 500));
await a.keyboard.up("w");
await new Promise((r) => setTimeout(r, 200));

const aFrameText = await a.locator('[data-testid="bullet-hud"]').textContent();
const bFrameText = await b.locator('[data-testid="bullet-hud"]').textContent();
console.log("Tab A HUD:", aFrameText?.replace(/\s+/g, " ").trim());
console.log("Tab B HUD:", bFrameText?.replace(/\s+/g, " ").trim());

// Parse the frame number from the HUD ("frame: 42").
function parseFrame(text) {
  const m = /frame:\s*(\d+)/.exec(text);
  return m ? Number(m[1]) : NaN;
}
const aFrame = parseFrame(aFrameText ?? "");
const bFrame = parseFrame(bFrameText ?? "");
if (!Number.isFinite(aFrame) || aFrame < 5) {
  console.log(`[FAIL] tab A frame counter too low (${aFrame}) — runtime didn't tick`);
  await browser.close();
  process.exit(1);
}
if (!Number.isFinite(bFrame) || bFrame < 5) {
  console.log(`[FAIL] tab B frame counter too low (${bFrame}) — runtime didn't tick`);
  await browser.close();
  process.exit(1);
}

// ---- Screenshot both tabs for the PR artifact -----------------------
mkdirSync("./", { recursive: true });
await a.screenshot({ path: "./two-tab-smoke.png", fullPage: false });
await b.screenshot({ path: "./two-tab-smoke-connected.png", fullPage: false });

// ---- Final status assertions --------------------------------------
const aStatus = await a.locator('[data-testid="status"]').textContent();
const bStatus = await b.locator('[data-testid="status"]').textContent();
if (!aStatus || !aStatus.includes("Connected")) {
  console.log(`[FAIL] tab A status is "${aStatus}", expected to include "Connected"`);
  await browser.close();
  process.exit(1);
}
if (!bStatus || !bStatus.includes("Connected")) {
  console.log(`[FAIL] tab B status is "${bStatus}", expected to include "Connected"`);
  await browser.close();
  process.exit(1);
}

console.log("OK — two-tab smoke passed");
await browser.close();
process.exit(0);
