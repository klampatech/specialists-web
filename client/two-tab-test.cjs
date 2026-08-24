// Two-tab Vivaldi test: open 2 tabs, walk in Tab A, screenshot both
const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.connectOverCDP("http://localhost:9224");
  const ctx = browser.contexts()[0];

  // Tab A: localId=1 peerId=2
  const tabA = await ctx.newPage();
  await tabA.goto("http://100.95.111.112:5174/?server=ws://100.95.111.112:14434/rooms/DEVBX&localId=1&peerId=2", { waitUntil: "load" });
  await new Promise(r => setTimeout(r, 4000));

  // Tab B: localId=2 peerId=1
  const tabB = await ctx.newPage();
  await tabB.goto("http://100.95.111.112:5174/?server=ws://100.95.111.112:14434/rooms/DEVBX&localId=2&peerId=1", { waitUntil: "load" });
  await new Promise(r => setTimeout(r, 4000));

  // Verify both connected
  for (const [name, page] of [["A", tabA], ["B", tabB]]) {
    const s = await page.evaluate(() => ({
      connected: window.__serverTransport?.connected,
      kind: window.__serverTransport?.activeKind,
      rtt: window.__serverTransport?.getStats?.()?.rttMs,
    }));
    console.log(`Tab ${name}:`, JSON.stringify(s));
  }

  // Click canvas on Tab A to focus, then walk forward (W key)
  console.log("Walking Tab A forward (W)...");
  await tabA.bringToFront();
  const canvasA = await tabA.locator("canvas").first();
  await canvasA.click({ position: { x: 400, y: 300 } });
  await new Promise(r => setTimeout(r, 500));
  await tabA.keyboard.down("w");
  await new Promise(r => setTimeout(r, 2500));
  await tabA.keyboard.up("w");
  await new Promise(r => setTimeout(r, 1000));

  // Take screenshots
  console.log("Taking screenshots...");
  await tabA.screenshot({ path: "/tmp/two-tab-A.png", fullPage: false });
  await tabB.screenshot({ path: "/tmp/two-tab-B.png", fullPage: false });

  // Read final state
  const aFinal = await tabA.evaluate(() => ({
    h: window.__gameSession?.localController?.state?.hp,
    pos: window.__gameSession?.localController?.havok?.getPosition?.(),
    snapCount: window.__latestSnap?.()?.players?.length ?? 0,
  }));
  const bFinal = await tabB.evaluate(() => ({
    h: window.__gameSession?.localController?.state?.hp,
    pos: window.__gameSession?.localController?.havok?.getPosition?.(),
    snapCount: window.__latestSnap?.()?.players?.length ?? 0,
    remotePos: window.__remoteController?.havok?.getPosition?.(),
  }));
  console.log("A final:", JSON.stringify(aFinal));
  console.log("B final:", JSON.stringify(bFinal));

  await browser.close();
})().catch(e => console.log("ERR:", e.message));