// CDP-driven two-tab video recorder for specialists-web multiplayer.
// Opens 2 tabs in Kyle's Chrome (via SSH tunnel on :9224), uses
// window.__applyYawDelta() to rotate both cameras so they face each
// other, walks Tab A, captures Page.captureScreenshot every ~200ms
// for BOTH tabs, writes PNG sequence to /tmp/cdp-screencast/.
//
// This time: camera rotation uses the DEV-only __applyYawDelta hook
// from client/src/engine/scene.ts, which actually moves the chase
// camera. The previous attempt's "Runtime.evaluate yaw assignment"
// didn't take because state.yaw isn't the source of truth for the
// camera — chase.getYaw() is.

import WebSocket from "ws";
import { writeFileSync, mkdirSync } from "node:fs";

const CDP_BROWSER = "http://localhost:9224";
const FRAME_INTERVAL_MS = 200;
const WALK_MS = 3000;
const FIRE_COUNT = 5;
const OUT_DIR = "/tmp/cdp-screencast";
mkdirSync(OUT_DIR, { recursive: true });

async function main() {
  console.log("Creating Tab A...");
  const pageA = await newTab(
    `${CDP_BROWSER}/json/new?http://100.95.111.112:5174/?server=ws://100.95.111.112:14434/rooms/DEVBX&localId=1&peerId=2`,
  );
  console.log("Creating Tab B...");
  const pageB = await newTab(
    `${CDP_BROWSER}/json/new?http://100.95.111.112:5174/?server=ws://100.95.111.112:14434/rooms/DEVBX&localId=2&peerId=1`,
  );

  const cdpA = await connectCdp(pageA.webSocketDebuggerUrl);
  const cdpB = await connectCdp(pageB.webSocketDebuggerUrl);
  for (const cdp of [cdpA, cdpB]) {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1024,
      height: 768,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  console.log("Waiting for gameSession AND remoteController on both tabs...");
  for (const [name, cdp] of [["A", cdpA], ["B", cdpB]]) {
    // CRITICAL: Wait for remoteController to be set on BOTH tabs.
    // The remoteController is created when the server reports the other
    // player via snapshot. Without it, neither tab renders the other's rig.
    await waitForCondition(
      cdp,
      `window.__gameSession !== undefined
       && window.__serverTransport && window.__serverTransport.connected === true
       && window.__gameSession.remoteController != null`,
      15000,
    );
    console.log(`Tab ${name} ready (with remoteController)`);
  }

  // Wait a moment for everything to settle
  await sleep(800);

  // Sanity check: confirm both tabs have both rigs in their interpolator
  for (const [name, cdp] of [["A", cdpA], ["B", cdpB]]) {
    const r = await cdp.send("Runtime.evaluate", {
      expression: `JSON.stringify({
        yaw: window.__mouseLookProbe?.(),
        pitch: window.__pitchLookProbe?.(),
        latestSnapPlayers: window.__latestSnap?.()?.players?.map(p => ({id: p.player_id, x: p.position_x, z: p.position_y})),
      })`,
      returnByValue: true,
    });
    console.log(`Tab ${name} pre-test:`, r.result.value);
  }

  // 4. Recording loop — capture frames continuously while driving
  console.log(`Recording frames at ${FRAME_INTERVAL_MS}ms intervals...`);
  const recordingStart = Date.now();
  const frames = [];

  const captureFrame = async () => {
    const [bufA, bufB] = await Promise.all([
      cdpA.send("Page.captureScreenshot", { format: "png" }).then((r) => Buffer.from(r.data, "base64")),
      cdpB.send("Page.captureScreenshot", { format: "png" }).then((r) => Buffer.from(r.data, "base64")),
    ]);
    return { a: bufA, b: bufB };
  };

  const drivingPromise = (async () => {
    // STEP 1: Rotate Tab A's camera to face Tab B (which is at x=-4, +X relative to A at x=-8).
      // After testing: __applyYawDelta(-π/2) makes the camera look -X (away from Tab B).
      // __applyYawDelta(+π/2) makes the camera look +X (toward Tab B). Confirmed empirically.
      console.log(`[t+200ms] Tab A: rotate camera to face +X (toward Tab B)`);
      await cdpA.send("Runtime.evaluate", {
        expression: `window.__applyYawDelta?.(Math.PI / 2); 'rotated'`,
      });

      // Tab B (at x=-4) needs to look at Tab A (at x=-8), which is -X relative to B.
      console.log(`[t+200ms] Tab B: rotate camera to face -X (toward Tab A)`);
      await cdpB.send("Runtime.evaluate", {
        expression: `window.__applyYawDelta?.(-Math.PI / 2); 'rotated'`,
      });
      await sleep(500);

    // STEP 2: Verify both cameras rotated
    const yawA = await cdpA.send("Runtime.evaluate", {
      expression: `JSON.stringify({yaw: window.__mouseLookProbe()})`,
      returnByValue: true,
    });
    console.log(`Tab A after rotation:`, yawA.result.value);
    const yawB = await cdpB.send("Runtime.evaluate", {
      expression: `JSON.stringify({yaw: window.__mouseLookProbe()})`,
      returnByValue: true,
    });
    console.log(`Tab B after rotation:`, yawB.result.value);

    // STEP 3: Click canvas to focus, walk forward 3s
    console.log(`[t+700ms] Tab A: click canvas + walk forward 3s`);
    await cdpA.send("Runtime.evaluate", { expression: `document.querySelector('canvas').click()` });
    await sleep(300);
    await cdpA.send("Input.dispatchKeyEvent", {
      type: "keyDown", windowsVirtualKeyCode: 87, code: "KeyW", key: "w",
    });
    await sleep(WALK_MS);
    await cdpA.send("Input.dispatchKeyEvent", {
      type: "keyUp", windowsVirtualKeyCode: 87, code: "KeyW", key: "w",
    });
    console.log(`[t+${700 + WALK_MS}ms] Tab A: stopped walking`);
    await sleep(500);

    // Verify Tab A walked
    const stateA = await cdpA.send("Runtime.evaluate", {
      expression: `JSON.stringify({
        localPos: window.__gameSession.localController.state.position,
        remotePos: window.__gameSession?.remoteController?.havok?.getPosition?.(),
        remoteId: window.__gameSession?.remoteController?.playerId,
      })`,
      returnByValue: true,
    });
    console.log(`Tab A state after walk:`, stateA.result.value);

    // STEP 4: Fire 5 shots
    for (let i = 0; i < FIRE_COUNT; i++) {
      console.log(`[fire ${i + 1}/${FIRE_COUNT}]`);
      await cdpA.send("Input.dispatchMouseEvent", {
        type: "mousePressed", x: 640, y: 360, button: "left", clickCount: 1,
      });
      await cdpA.send("Input.dispatchMouseEvent", {
        type: "mouseReleased", x: 640, y: 360, button: "left", clickCount: 1,
      });
      await sleep(400);
    }

    // Continue recording for 2 more seconds to see damage result
    await sleep(2000);
  })();

  // Capture frames concurrently for 12 seconds
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

  // Final state check
  for (const [name, cdp] of [["A", cdpA], ["B", cdpB]]) {
    const r = await cdp.send("Runtime.evaluate", {
      expression: `JSON.stringify({
        yaw: window.__mouseLookProbe?.(),
        localPos: window.__gameSession.localController.state.position,
        remotePos: window.__gameSession?.remoteController?.havok?.getPosition?.(),
        remoteId: window.__gameSession?.remoteController?.playerId,
        latestSnap: window.__latestSnap?.()?.players?.map(p => ({id: p.player_id, x: p.position_x, z: p.position_y, hp: p.hp})),
      })`,
      returnByValue: true,
    });
    console.log(`Tab ${name} FINAL:`, r.result.value);
  }

  console.log(`captured ${frames.length} frames over ${Date.now() - recordingStart}ms`);

  // Write frames
  for (let i = 0; i < frames.length; i++) {
    writeFileSync(`${OUT_DIR}/frame-${String(i).padStart(3, "0")}-A.png`, frames[i].a);
    writeFileSync(`${OUT_DIR}/frame-${String(i).padStart(3, "0")}-B.png`, frames[i].b);
  }
  console.log(`frames written to ${OUT_DIR}/`);

  // Close tabs
  await fetch(`${CDP_BROWSER}/json/close/${pageA.id}`, { method: "PUT" }).catch(() => {});
  await fetch(`${CDP_BROWSER}/json/close/${pageB.id}`, { method: "PUT" }).catch(() => {});
  cdpA.close();
  cdpB.close();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function newTab(url) {
  const r = await fetch(url, { method: "PUT" });
  const text = await r.text();
  const jsonStart = text.indexOf("{");
  return JSON.parse(text.slice(jsonStart));
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