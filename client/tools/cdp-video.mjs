// CDP-driven two-tab video recorder for specialists-web multiplayer.
// Opens 2 tabs in Kyle's Chrome (via SSH tunnel on :9224), drives
// walk + fire in Tab A, captures Page.captureScreenshot every ~250ms
// for BOTH tabs, writes PNG sequence to /tmp/cdp-screencast/ for
// stitching into GIF/video off-band.

import WebSocket from "ws";
import { writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const CDP_BROWSER = "http://localhost:9224";
const FRAME_INTERVAL_MS = 200;
const WALK_MS = 4000;
const FIRE_COUNT = 3;
const OUT_DIR = "/tmp/cdp-screencast";
mkdirSync(OUT_DIR, { recursive: true });

async function main() {
  // 1. Create 2 tabs
  console.log("Creating Tab A...");
  const pageA = await newTab(
    `${CDP_BROWSER}/json/new?http://100.95.111.112:5174/?server=ws://100.95.111.112:14434/rooms/DEVBX&localId=1&peerId=2`,
  );
  console.log("Creating Tab B...");
  const pageB = await newTab(
    `${CDP_BROWSER}/json/new?http://100.95.111.112:5174/?server=ws://100.95.111.112:14434/rooms/DEVBX&localId=2&peerId=1`,
  );

  // 2. Connect CDP to each tab
  const cdpA = await connectCdp(pageA.webSocketDebuggerUrl);
  const cdpB = await connectCdp(pageB.webSocketDebuggerUrl);
  for (const cdp of [cdpA, cdpB]) {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    // Set viewport to 1024×768 like the manual smoke
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1024,
      height: 768,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  // 3. Wait for gameSession
  console.log("Waiting for gameSession on both tabs...");
  for (const [name, cdp] of [["A", cdpA], ["B", cdpB]]) {
    await waitForCondition(
      cdp,
      "window.__gameSession !== undefined && window.__serverTransport && window.__serverTransport.connected === true",
      12000,
    );
    console.log(`Tab ${name} ready`);
  }

  // 4. Recording loop — capture frames continuously
  console.log(`Recording frames at ${FRAME_INTERVAL_MS}ms intervals...`);
  const recordingStart = Date.now();
  const frames = [];

  // Helper to grab both screenshots in parallel
  const captureFrame = async () => {
    const [bufA, bufB] = await Promise.all([
      cdpA.send("Page.captureScreenshot", { format: "png" }).then((r) => Buffer.from(r.data, "base64")),
      cdpB.send("Page.captureScreenshot", { format: "png" }).then((r) => Buffer.from(r.data, "base64")),
    ]);
    return { a: bufA, b: bufB };
  };

  // 4. While recording, drive Tab A: rotate camera to face Tab B (yaw=PI),
  //    walk forward, then fire at Tab B
  const drivingPromise = (async () => {
    // Click canvas to focus + grab pointer
    await sleep(500);
    await cdpA.send("Runtime.evaluate", {
      expression: `document.querySelector('canvas').click()`,
    });
    await sleep(300);

    // Teleport Tab A to right next to Tab B's spawn, with camera looking -X (toward Tab B)
    console.log(`[t+800ms] Tab A: teleport next to Tab B, yaw -PI/2 (looking -X)`);
    await cdpA.send("Runtime.evaluate", {
      expression: `
        // Walk Tab A over to where Tab B is and rotate to face them
        const ctl = window.__gameSession?.localController;
        if (ctl) {
          ctl.state.position.x = -6;  // Between spawn (-8) and Tab B (-4)
          ctl.state.position.z = 0;
          ctl.state.yaw = -Math.PI / 2;  // Looking -X (toward Tab B's spawn -4)
          ctl.havok?.setPosition?.(ctl.state.position);
        }
        'done'
      `,
    });
    await sleep(300);
    // Walking forward (W key down) for 2s
    console.log(`[t+1100ms] Tab A: walking forward (W)`);
    await cdpA.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      windowsVirtualKeyCode: 87,
      code: "KeyW",
      key: "w",
    });
    await sleep(WALK_MS);
    await cdpA.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      windowsVirtualKeyCode: 87,
      code: "KeyW",
      key: "w",
    });
    console.log(`[t+${1100 + WALK_MS}ms] Tab A: stopped walking`);
    await sleep(300);

    // Fire 3 shots while aiming — but we need to be aimed at Tab B
    // Try just clicking; if hits don't register, that's a separate issue
    for (let i = 0; i < FIRE_COUNT; i++) {
      console.log(`[fire ${i + 1}/${FIRE_COUNT}]`);
      await cdpA.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: 640,
        y: 360,
        button: "left",
        clickCount: 1,
      });
      await cdpA.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: 640,
        y: 360,
        button: "left",
        clickCount: 1,
      });
      await sleep(500);
    }

    // Continue recording for 3 more seconds
    await sleep(3000);
  })();

  // Capture frames concurrently — record for the duration of the driving promise + 3s tail
  const RECORD_MS = 12000;
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
      await sleep(FRAME_INTERVAL_MS - elapsed);
    }
  }
  await drivingPromise;

  console.log(`captured ${frames.length} frames over ${Date.now() - recordingStart}ms`);

  // 6. Write frames to disk
  for (let i = 0; i < frames.length; i++) {
    writeFileSync(`${OUT_DIR}/frame-${String(i).padStart(3, "0")}-A.png`, frames[i].a);
    writeFileSync(`${OUT_DIR}/frame-${String(i).padStart(3, "0")}-B.png`, frames[i].b);
  }
  console.log(`frames written to ${OUT_DIR}/`);

  // 7. Close tabs
  await fetch(`${CDP_BROWSER}/json/close/${pageA.id}`, { method: "PUT" }).catch(() => {});
  await fetch(`${CDP_BROWSER}/json/close/${pageB.id}`, { method: "PUT" }).catch(() => {});
  cdpA.close();
  cdpB.close();
}

async function newTab(url) {
  const r = await fetch(url, { method: "PUT" });
  const text = await r.text();
  // Chrome may prepend "Using unsafe ..." warning; strip it
  const jsonStart = text.indexOf("{");
  return JSON.parse(text.slice(jsonStart));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let msgId = 0;
    const pending = new Map();
    const handlers = [];
    ws.on("open", () => {
      const cdp = {
        ws,
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = ++msgId;
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        on(handler) {
          handlers.push(handler);
        },
        close() {
          ws.close();
        },
      };
      resolve(cdp);
    });
    ws.on("error", (e) => reject(e));
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      } else if (msg.method) {
        for (const h of handlers) h(msg.method, msg.params);
      }
    });
  });
}

async function waitForCondition(cdp, expr, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await cdp.send("Runtime.evaluate", { expression: expr + " ? 'OK' : 'WAIT'", returnByValue: true });
      if (r.result?.value === "OK") return;
    } catch (e) {}
    await sleep(200);
  }
  throw new Error(`waitForCondition timeout: ${expr}`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});