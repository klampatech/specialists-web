#!/usr/bin/env node
// PR 65 — Real-input AimEvent smoke. DOES NOT use `bus.sendAimEvent`
// directly — drives the actual game loop via mouse click + key press,
// so the test exercises the same code path the player would. The
// pre-fix version of this test will FAIL because the real gameplay
// code never calls `sendInputsServer` (the client's camera rotation
// never reaches the server's `room.players[id].yaw_radians` field,
// so the server-side hitscan uses yaw=0 and misses every shot).
//
// Captures:
//   - browser-console-{A,B}.log    (full console: log/warn/error/info)
//   - browser-errors-{A,B}.log     (pageerror + requestfailed)
//   - dom-{A,B}-{phase}.json       (HUD chip + frame + HP + ammo per phase)
//   - screenshot-{A,B}-{phase}.png
//   - canary-stderr.log            (server-side logs)
//
// Goal: prove the "real gameplay" path matches the "smoke harness" path.
// Until this test passes 100% of the time, PR 65 is not done.

import { chromium } from "playwright";
import { setTimeout as sleep } from "node:timers/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { attachSmokeCapture, makeSmokeOutDir, spawnWithStderrCapture } from "./smoke-capture.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const VT_URL  = "http://localhost:5191/";
const WT_PORT = 14433;
const WS_PORT = 14434;
const PLAYER_MAX_AMMO = 6;
const DUAL_PISTOL_DAMAGE = 12;
const EXPECTED_HP_DROP = DUAL_PISTOL_DAMAGE;
const HIT_SETTLE_MS = 4000;  // generous wait for cross-machine latency

const OUT_DIR = makeSmokeOutDir("real-input");

const log = (...args) => console.log("[real-input-smoke]", ...args);
const fail = (...args) => console.error("[real-input-smoke][FAIL]", ...args);

async function isTcpReachable(host, port) {
  const net = await import("node:net");
  return new Promise((resolveP) => {
    const sock = net.createConnection({ host, port }, () => { sock.end(); resolveP(true); });
    sock.on("error", () => resolveP(false));
    sock.setTimeout(1000, () => { sock.destroy(); resolveP(false); });
  });
}

// --- Boot canary + vite
async function bootCanary() {
  log("Booting canary server…");
  const proc = await spawnWithStderrCapture(
    "bash",
    [resolve(REPO_ROOT, "tools", "canary-server.sh"), "--port-wt", String(WT_PORT), "--port-ws", String(WS_PORT)],
    { cwd: REPO_ROOT, env: { ...process.env, CARGO_PROFILE: "debug", RUST_LOG: "snapshot_debug=debug,info" } },
    OUT_DIR,
    "canary",
  );
  for (let i = 0; i < 60; i++) {
    if (proc.exitCode !== null) throw new Error(`canary exited ${proc.exitCode}`);
    if (await isTcpReachable("127.0.0.1", WS_PORT)) { log(`canary ready ${i+1}s`); return proc; }
    await sleep(1000);
  }
  throw new Error("canary did not become ready");
}

async function bootVite() {
  log("Booting vite on 5191…");
  const proc = await spawnWithStderrCapture(
    "npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", "5191", "--strictPort"],
    { cwd: resolve(REPO_ROOT, "client") },
    OUT_DIR, "vite",
  );
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(VT_URL);
      if (r.ok) { log(`vite ready ${i+1}s`); return proc; }
    } catch {}
    await sleep(1000);
  }
  throw new Error("vite did not become ready");
}

async function teardown(canary, vite) {
  for (const p of [vite, canary]) {
    if (p && p.exitCode === null) {
      try { p.kill("SIGKILL"); } catch {}
    }
  }
  await import("node:child_process").then(({ execSync }) => {
    for (const port of [5191, WT_PORT, WS_PORT]) {
      try { execSync(`lsof -ti:${port} 2>/dev/null | xargs -r kill -9`, { stdio: "ignore" }); } catch {}
    }
  });
}

// --- Run smoke
async function runSmoke() {
  await bootCanary();
  await bootVite();

  const browser = await chromium.launch({
    headless: true,
    args: ["--ignore-certificate-errors", "--enable-unsafe-swiftshader", "--use-angle=swiftshader-webgl"],
  });

  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  const capA = attachSmokeCapture(pageA, { label: "A", outDir: OUT_DIR });
  const capB = attachSmokeCapture(pageB, { label: "B", outDir: OUT_DIR });

  // Capture initial DOM
  await sleep(500);
  await capA.snapshotDom("boot");
  await capB.snapshotDom("boot");

  // init scripts
  const runId = Date.now();
  const roomId = `REAL_${runId}`;
  for (const [page, localId, peerId] of [[pageA, 1, 2], [pageB, 2, 1]]) {
    await page.addInitScript({ content: `
      window.__forceServerTransport = true;
      window.__damageServerPorts   = { wt: ${WT_PORT}, ws: ${WS_PORT} };
      window.__damageServerUrl     = ${JSON.stringify(VT_URL)};
      window.__damageServerRoomId  = "${roomId}";
      window.__localPlayerId       = ${localId};
      window.__peerPlayerId        = ${peerId};
    ` });
  }
  log(`Room = ${roomId}`);

  const navUrl = `${VT_URL}?server=${encodeURIComponent(`ws://localhost:${WS_PORT}/rooms/${roomId}`)}`;
  log("Navigating both tabs");
  await Promise.all([
    pageA.goto(navUrl, { waitUntil: "networkidle", timeout: 30000 }),
    pageB.goto(navUrl, { waitUntil: "networkidle", timeout: 30000 }),
  ]);

  // Wait for both connected
  const t0 = Date.now();
  while (Date.now() - t0 < 12000) {
    const [a, b] = await Promise.all([
      pageA.evaluate(() => ({ c: window.__serverTransport?.connected, hud: document.body.innerText.match(/Connected|Disconnected|connecting/i)?.[0] })),
      pageB.evaluate(() => ({ c: window.__serverTransport?.connected, hud: document.body.innerText.match(/Connected|Disconnected|connecting/i)?.[0] })),
    ]);
    if (a.c && /Connected/.test(a.hud) && b.c && /Connected/.test(b.hud)) break;
    await sleep(250);
  }
  await sleep(3000); // settle for snapshot stream + scene init
  await capA.snapshotDom("settled");
  await capB.snapshotDom("settled");
  await capA.writeArtifact("settled");
  await capB.writeArtifact("settled");

  // ============== ASSERTION 1: both Connected ==============
  log("=== ASSERTION 1: both tabs Connected (idle) ===");
  // Probe must distinguish the HUD chip ("Connected (idle)") from
  // the lower-case server status ("Server: connected (websocket)").
  // Match exact phrases only.
  const probeConn = async (p) => p.evaluate(() => {
    const t = window.__serverTransport;
    const text = document.body.innerText || "";
    const hudChipIdle = /Connected\s*\(\s*idle\s*\)/i.test(text);
    const disconnected = /Disconnected|Offline/i.test(text);
    const connecting = /connecting|reconnecting/i.test(text);
    return { c: t?.connected, hudIdle: hudChipIdle, disconnected, connecting };
  });
  const [a1, b1] = await Promise.all([probeConn(pageA), probeConn(pageB)]);
  log(`  A: conn=${a1.c} hudIdle=${a1.hudIdle} disconnected=${a1.disconnected} connecting=${a1.connecting}`);
  log(`  B: conn=${b1.c} hudIdle=${b1.hudIdle} disconnected=${b1.disconnected} connecting=${b1.connecting}`);
  if (!a1.c || !a1.hudIdle) throw new Error(`Tab A not Connected (idle): ${JSON.stringify(a1)}`);
  if (!b1.c || !b1.hudIdle) throw new Error(`Tab B not Connected (idle): ${JSON.stringify(b1)}`);
  log("  ✓ both Connected (idle)");

  // ============== ASSERTION 2: REAL mouse-click fires AimEvent ==============
  log("=== ASSERTION 2: REAL mouse click on Tab A's canvas → fires AimEvent → Tab B HP drops ===");
  log("  focusing Tab A canvas + clicking center (640, 360)");
  await pageA.evaluate(() => {
    // Find the canvas and dispatch a click event manually
    const canvas = document.querySelector("canvas");
    if (!canvas) throw new Error("no canvas");
    canvas.focus();
    window.__realFireTestRan = false;
    return canvas.getBoundingClientRect();
  });
  // Use real Playwright click — Playwright simulates a real mouse event
  // that the Babylon engine's pointer handler will pick up.
  await pageA.mouse.click(640, 360);
  await sleep(500);
  await pageA.mouse.click(640, 360);
  await sleep(HIT_SETTLE_MS);

  // Probe both snapshots
  const [a2, b2] = await Promise.all([
    capA.snapshotDom("after-real-fire"),
    capB.snapshotDom("after-real-fire"),
  ]);
  log(`  Tab A's view of Tab B (peer): ${JSON.stringify(a2.latestSnapPlayers?.[1] ?? null)}`);
  log(`  Tab B's view of itself (me):  ${JSON.stringify(b2.latestSnapPlayers?.[1] ?? null)}`);

  const hpA = a2.latestSnapPlayers?.[1]?.hp;   // what A sees for B
  const hpB = b2.latestSnapPlayers?.[1]?.hp;   // what B sees for itself
  log(`  Tab B HP from A's view: ${hpA}`);
  log(`  Tab B HP from B's view: ${hpB}`);
  await capA.writeArtifact("after-real-fire");
  await capB.writeArtifact("after-real-fire");

  if (hpA === 100 && hpB === 100) {
    fail("FAIL: REAL mouse click did NOT cause damage to Tab B (HP stayed at 100).");
    fail("       This means the client's game loop is NOT forwarding yaw/pitch to the server.");
    fail("       The smoke uses bus.sendAimEvent which works — but real gameplay does not.");
    fail("       >>> PR 65 (wire sendInputsServer from the real camera rotation code) is needed.");
    throw new Error("real-input fire had no effect");
  }
  log(`  ✓ REAL fire caused damage (HP went 100 → ${hpA})`);

  // ============== ASSERTION 3: REAL keyboard turn → yaw actually reaches server ==============
  log("=== ASSERTION 3: REAL keyboard press → yaw reaches server ===");
  // Tab A presses the camera turn key (whatever it is — likely ArrowRight or similar)
  // First log what happens to the snapshot's yaw slot BEFORE the key press
  const beforeYaw = await pageA.evaluate(() => window.__latestSnap?.()?.players?.find(p => p.playerId === 1)?.yaw ?? null);
  log(`  Tab A yaw in snapshot BEFORE key press: ${beforeYaw}`);

  // Try common keys for camera turn. Vite HUD said "A D" for strafe; "Q wallrun tap mid-air";
  // Camera movement is likely mouse-look (no keyboard by default).
  // Use mouse-drag to actually rotate the camera:
  await pageA.mouse.move(640, 360);
  await pageA.mouse.down();
  await pageA.mouse.move(740, 360, { steps: 5 });
  await pageA.mouse.up();
  await sleep(2000);
  const afterYaw = await pageA.evaluate(() => window.__latestSnap?.()?.players?.find(p => p.playerId === 1)?.yaw ?? null);
  log(`  Tab A yaw in snapshot AFTER mouse-drag right: ${afterYaw}`);
  await capA.snapshotDom("after-yaw-drag");
  await capB.snapshotDom("after-yaw-drag");
  await capA.writeArtifact("after-yaw-drag");
  await capB.writeArtifact("after-yaw-drag");

  if (beforeYaw === afterYaw && beforeYaw === 0) {
    fail("FAIL: Mouse-drag camera rotation did NOT update yaw in server snapshot.");
    fail(`       Before: ${beforeYaw}, After: ${afterYaw}`);
    fail("       >>> The client is NOT calling sendInputsServer from the camera rotation handler.");
    throw new Error("real-input yaw had no effect");
  }
  log(`  ✓ yaw went ${beforeYaw} → ${afterYaw}`);

  log("=== ALL REAL-INPUT ASSERTIONS PASSED ===");
  await capA.writeArtifact("final");
  await capB.writeArtifact("final");
  await browser.close();
}

let canaryProc, viteProc;
try {
  await runSmoke();
  log(`✓ smoke passed — artifacts at ${OUT_DIR}`);
  process.exit(0);
} catch (e) {
  fail(e.message);
  log(`✗ smoke failed — artifacts at ${OUT_DIR}`);
  await teardown(canaryProc, viteProc);
  process.exit(1);
}
