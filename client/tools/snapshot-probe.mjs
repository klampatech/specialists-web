// Quick probe: open 2 tabs, walk in Tab A, then check what each tab's
// snapshot says about the OTHER player. Catches walk-mirror bugs.

import { chromium } from "playwright";

const URL_BASE = "http://100.95.111.112:5174";
const ROOM = "DEVBX";
const WS_HOST = "100.95.111.112";
const WS_PORT = 14434;

const browser = await chromium.launch({ headless: true });

const ctxA = await browser.newContext({ viewport: { width: 1024, height: 768 } });
const ctxB = await browser.newContext({ viewport: { width: 1024, height: 768 } });
const pageA = await ctxA.newPage();
const pageB = await ctxB.newPage();

const urlA = `${URL_BASE}/?server=ws://${WS_HOST}:${WS_PORT}/rooms/${ROOM}&localId=1&peerId=2`;
const urlB = `${URL_BASE}/?server=ws://${WS_HOST}:${WS_PORT}/rooms/${ROOM}&localId=2&peerId=1`;

await pageA.goto(urlA, { waitUntil: "load" });
await pageB.goto(urlB, { waitUntil: "load" });

await pageA.waitForFunction(() => window.__gameSession?.remoteController != null, null, { timeout: 15000 });
await pageB.waitForFunction(() => window.__gameSession?.remoteController != null, null, { timeout: 15000 });

await new Promise((r) => setTimeout(r, 1500));

console.log("=== Before walk ===");
for (const [name, page] of [["A", pageA], ["B", pageB]]) {
  const s = await page.evaluate(() => {
    const snap = window.__latestSnap?.();
    return {
      localId: window.__localPlayerId,
      localPos: window.__gameSession?.localController?.state?.position,
      remoteId: window.__gameSession?.remoteController?.playerId,
      remotePos: window.__gameSession?.remoteController?.state?.position,
      remoteHavokPos: window.__gameSession?.remoteController?.havok?.getPosition?.(),
      snapPlayers: snap?.players?.map(p => ({id: p.playerId, x: p.positionX, y: p.positionY, hp: p.hp})),
    };
  });
  console.log(`Tab ${name}:`, JSON.stringify(s, null, 2));
}

console.log("\n=== Tab A walks 3s ===");
await pageA.locator("canvas").first().click({ position: { x: 400, y: 300 } });
await new Promise((r) => setTimeout(r, 300));
await pageA.keyboard.down("w");
await new Promise((r) => setTimeout(r, 3000));
await pageA.keyboard.up("w");
await new Promise((r) => setTimeout(r, 1000));

console.log("=== After walk ===");
for (const [name, page] of [["A", pageA], ["B", pageB]]) {
  const s = await page.evaluate(() => {
    const snap = window.__latestSnap?.();
    return {
      localPos: window.__gameSession?.localController?.state?.position,
      remotePos: window.__gameSession?.remoteController?.state?.position,
      remoteHavokPos: window.__gameSession?.remoteController?.havok?.getPosition?.(),
      snapPlayers: snap?.players?.map(p => ({id: p.playerId, x: p.positionX, y: p.positionY, hp: p.hp})),
      remoteCtrlSnapshot: window.__gameSession?.remoteController?.state,
    };
  });
  console.log(`Tab ${name}:`, JSON.stringify(s, null, 2));
}

await browser.close();