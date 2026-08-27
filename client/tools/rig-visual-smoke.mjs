// Smoke — verifies the remote rig's VISUAL position tracks the
// snapshot's positionX/positionY. PR 66 wires `setVisualPosition` to
// fire every frame from the liveHook. Pre-fix the rig stayed at world
// origin because the closure-bound interpolatorTickHook is dead
// (PR 11.7.D3.2 / line 1233 explicitly sets it to null).
//
// This test:
//   1. Boots two tabs into a fresh room
//   2. Teleports Tab A (the local player) to position (+5, 0, 0) via
//      __teleportRemote so we know where the local rig should land
//   3. Reads Tab B's snapshot's positionX/positionY for Tab A
//      (the snapshot from Tab A's perspective reports Tab A's own
//      position via the per-player stream)
//   4. Reads the liveHook's debug hook __lastInterpolatorSetPosition
//      — this is the actual position written to remoteController.havok
//   5. Asserts the liveHook position matches the snapshot's positionX/Y
//
// This locks in the wire→visual-root pipeline so any future regression
// that detaches them surfaces immediately.

import { chromium } from "playwright";
import { resolve } from "path";
import { spawn } from "child_process";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { spawnWithStderrCapture, log, fail, sleep } from "./smoke-capture.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const SMOKE_NAME = "rig-visual";
const WT_PORT = Number(process.env.RUST_VIS_WT_PORT ?? 14435);
const WS_PORT = Number(process.env.RUST_VIS_WS_PORT ?? 14436);
const VITE_PORT = Number(process.env.RUST_VIS_VITE_PORT ?? 5192);
const ROOM = `RIGVIS_${Date.now()}`;

// ... (boot canary, vite, navigate both tabs to same room) ...

async function bootCanary() {
  log("Booting canary server…");
  const outDir = `/tmp/rig-visual-smoke-canary`;
  const proc = await spawnWithStderrCapture(
    "bash",
    [resolve(REPO_ROOT, "tools", "canary-server.sh"), "--port-wt", String(WT_PORT), "--port-ws", String(WS_PORT)],
    { RUST_LOG: "snapshot_debug=debug,info" },
    outDir,
    "canary",
  );
  // Poll the TCP port for "listening" — Rust canary has no /json/version.
  // We use net.Socket() on the m5 side to detect when bind completes.
  const net = await import("node:net");
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const ok = await new Promise((res) => {
      const s = net.connect(WS_PORT, "127.0.0.1");
      s.on("connect", () => { s.end(); res(true); });
      s.on("error", () => res(false));
      setTimeout(() => { s.destroy(); res(false); }, 300);
    });
    if (ok) { log(`  canary ready ${(i + 1) * 0.5}s (port ${WS_PORT} open)`); return proc; }
  }
  throw new Error("canary never came up");
}

async function bootVite() {
  log(`Booting vite on ${VITE_PORT}…`);
  const outDir = `/tmp/rig-visual-smoke-vite`;
  const proc = await spawnWithStderrCapture("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(VITE_PORT)], {
    cwd: resolve(REPO_ROOT, "client"),
  }, outDir, "vite");
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try {
      const r = await fetch(`http://127.0.0.1:${VITE_PORT}/`);
      if (r.ok) { log(`  vite ready ${(i + 1) * 0.5}s`); return proc; }
    } catch {}
  }
  throw new Error("vite never came up");
}

async function main() {
  // Boot
  const canary = await bootCanary();
  const vite = await bootVite();
  let browserA, browserB, pageA, pageB;
  try {
    log(`Room = ${ROOM}`);
    browserA = await chromium.launch({ headless: true });
    browserB = await chromium.launch({ headless: true });
    pageA = await browserA.newPage({ viewport: { width: 1280, height: 720 } });
    pageB = await browserB.newPage({ viewport: { width: 1280, height: 720 } });

    // PR #64 / §forceServerTransport — same setup as real-input smoke:
    // addInitScript MUST run before navigation so the game picks up the
    // `__forceServerTransport` flag and the room id.
    for (const [page, localId, peerId] of [[pageA, 1, 2], [pageB, 2, 1]]) {
      await page.addInitScript({
        content: `
          window.__forceServerTransport = true;
          window.__damageServerPorts   = { wt: ${WT_PORT}, ws: ${WS_PORT} };
          window.__damageServerUrl     = ${JSON.stringify(`http://127.0.0.1:${VITE_PORT}/`)};
          window.__damageServerRoomId  = "${ROOM}";
          window.__localPlayerId       = ${localId};
          window.__peerPlayerId        = ${peerId};
        `,
      });
    }

    // Capture all console messages
    pageA.on("console", (msg) => {
      captureConsole("A", msg.text());
    });
    pageB.on("console", (msg) => {
      captureConsole("B", msg.text());
    });

    // Navigate both tabs to the same room
    const navUrl = `http://127.0.0.1:${VITE_PORT}/?server=${encodeURIComponent(`ws://localhost:${WS_PORT}/rooms/${ROOM}`)}`;
    await Promise.all([
      pageA.goto(navUrl, { waitUntil: "networkidle", timeout: 30000 }),
      pageB.goto(navUrl, { waitUntil: "networkidle", timeout: 30000 }),
    ]);

    log("Waiting for both Connected (idle)…");
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const a = await pageA.evaluate(() => {
        const t = window.__serverTransport;
        const text = document.body.innerText || "";
        return {
          c: t?.connected,
          hudIdle: /Connected\s*\(\s*idle\s*\)/i.test(text),
        };
      });
      const b = await pageB.evaluate(() => {
        const t = window.__serverTransport;
        const text = document.body.innerText || "";
        return {
          c: t?.connected,
          hudIdle: /Connected\s*\(\s*idle\s*\)/i.test(text),
        };
      });
      if (a.c && a.hudIdle && b.c && b.hudIdle) {
        log(`  settled at ${(i + 1) * 0.5}s`);
        break;
      }
      if (i === 59) {
        const aConn = await pageA.evaluate(() => ({ c: window.__serverTransport?.connected, hud: (document.body.innerText || "").slice(0, 200) }));
        const bConn = await pageB.evaluate(() => ({ c: window.__serverTransport?.connected, hud: (document.body.innerText || "").slice(0, 200) }));
        throw new Error(`failed to settle: A=${JSON.stringify(aConn)}, B=${JSON.stringify(bConn)}`);
      }
    }

    // Allow snapshot stream to land
    await sleep(2000);

    log("=== ASSERTION 1: both tabs have a remote rig visualRoot ===");
    const probeRig = async (page, label) => {
      return await page.evaluate(() => {
        const sess = window.__gameSession;
        if (!sess) return { error: "no gameSession" };
        const ctrl = sess.remoteController;
        if (!ctrl) return { error: "no remoteController" };
        const v = ctrl.visualRoot;
        return {
          visualX: v?.position?.x ?? null,
          visualY: v?.position?.y ?? null,
          visualZ: v?.position?.z ?? null,
          havokX: ctrl.havok?.getPosition?.()?.x ?? null,
          havokY: ctrl.havok?.getPosition?.()?.y ?? null,
          havokZ: ctrl.havok?.getPosition?.()?.z ?? null,
          isInRespawnGrace: ctrl.isInRespawnGrace ? ctrl.isInRespawnGrace(performance.now()) : null,
          lastTick: window.__lastInterpolatorSetPosition ?? null,
          liveHookFn: typeof window.__liveInterpolatorTickHook === "function",
        };
      });
    };
    const rigA = await probeRig(pageA, "A");
    const rigB = await probeRig(pageB, "B");
    log(`  Tab A remote rig: ${JSON.stringify(rigA)}`);
    log(`  Tab B remote rig: ${JSON.stringify(rigB)}`);
    if (!rigA.liveHookFn || !rigB.liveHookFn) {
      fail("liveHook missing — the snapshot→visual-root pipeline is detached.");
      throw new Error("liveHook not set");
    }
    log(`  ✓ liveHook is set on both tabs`);

    log("=== ASSERTION 2: snapshot updates as rig moves ===");
    // Drive Tab B's local controller via the chase camera + keypress.
    // Tab B's local rig is at (-8, 0, 0) initially. We want it to
    // move so Tab A's snapshot of Tab B shows a new positionX.
    // The cleanest test: have Tab B's character controller walk +X
    // by pressing 'd' (right). The client's sendPositionUpdate flow
    // pushes to the server which broadcasts via snapshot.
    const tabBInitialPos = await pageB.evaluate(() => {
      const s = window.__latestSnap?.();
      const me = s?.players?.find?.(p => p.playerId === 2);
      return me ? { x: me.positionX, y: me.positionY } : null;
    });
    log(`  Tab B's own snapshot BEFORE move: ${JSON.stringify(tabBInitialPos)}`);

    // Hold 'd' (right) for 2 seconds — character should walk in +X
    await pageB.keyboard.down("d");
    await sleep(2000);
    await pageB.keyboard.up("d");
    await sleep(2000);  // let snapshot catch up

    const tabBAfterMove = await pageB.evaluate(() => {
      const s = window.__latestSnap?.();
      const me = s?.players?.find?.(p => p.playerId === 2);
      return me ? { x: me.positionX, y: me.positionY } : null;
    });
    log(`  Tab B's own snapshot AFTER 'd' held 2s: ${JSON.stringify(tabBAfterMove)}`);

    // Tab A's view of Tab B should also reflect the move
    const tabAView = await pageA.evaluate(() => {
      const s = window.__latestSnap?.();
      return s?.players?.find?.(p => p.playerId === 2)?.positionX ?? null;
    });
    log(`  Tab A's view of Tab B (player 2): x=${tabAView}`);

    if (tabBAfterMove === null || Math.abs(tabBAfterMove.x - tabBInitialPos.x) < 0.5) {
      fail(`Tab B didn't move on 'd' press. before=${JSON.stringify(tabBInitialPos)} after=${JSON.stringify(tabBAfterMove)}`);
      fail(`Either input isn't reaching the controller, or sendPositionUpdate isn't wiring the wire.`);
      throw new Error(`Tab B movement failed`);
    }
    log(`  ✓ Tab B's local rig moved x=${tabBInitialPos.x} → x=${tabBAfterMove.x.toFixed(2)}`);

    // Now check Tab A's view of Tab B
    if (tabAView === null || Math.abs(tabAView - tabBAfterMove.x) > 1) {
      fail(`Tab A's snapshot of Tab B doesn't match Tab B's local. expected ~${tabBAfterMove.x.toFixed(2)}, got ${tabAView}`);
      throw new Error(`snapshot propagation failed`);
    }
    log(`  ✓ Tab A's snapshot of Tab B matches (x=${tabAView.toFixed(2)})`);

    // Now check the visual rig
    const rigAAfter = await probeRig(pageA, "A-after");
    log(`  Tab A remote rig: visual=(${rigAAfter.visualX.toFixed(2)}, ${rigAAfter.visualZ.toFixed(2)}) lastTick=${JSON.stringify(rigAAfter.lastTick)}`);

    // Assert Tab A's view of Tab B (the remote rig in A's scene) moved
    // to approximately match Tab B's actual position.
    const aX = rigAAfter.visualX;
    if (aX === null || Math.abs(aX - tabBAfterMove.x) > 2) {
      fail(`Tab A's remote rig didn't track Tab B's position. expected x≈${tabBAfterMove.x.toFixed(2)}, got x=${aX}`);
      fail(`Snapshot reported the new position but visualRoot didn't follow.`);
      throw new Error(`rig visual didn't move: A=(${aX}, ${tabBAfterMove.x.toFixed(2)})`);
    }
    log(`  ✓ Tab A's remote rig visual x=${aX.toFixed(2)} matches Tab B's actual x=${tabBAfterMove.x.toFixed(2)}`);

    log("=== ASSERTION 3: move again → visual follows ===");
    // Walk back with 'a' (left)
    await pageB.keyboard.down("a");
    await sleep(2000);
    await pageB.keyboard.up("a");
    await sleep(2000);

    const tabBAfterMove2 = await pageB.evaluate(() => {
      const s = window.__latestSnap?.();
      const me = s?.players?.find?.(p => p.playerId === 2);
      return me ? { x: me.positionX, y: me.positionY } : null;
    });
    log(`  Tab B's snapshot after second move: ${JSON.stringify(tabBAfterMove2)}`);
    const rigAAfter2 = await probeRig(pageA, "A-after2");
    log(`  Tab A remote rig: visual=(${rigAAfter2.visualX.toFixed(2)}, ${rigAAfter2.visualZ.toFixed(2)}) lastTick=${JSON.stringify(rigAAfter2.lastTick)}`);
    const aX2 = rigAAfter2.visualX;
    if (aX2 === null || Math.abs(aX2 - tabBAfterMove2.x) > 2) {
      fail(`Tab A's remote rig didn't track second move. expected x≈${tabBAfterMove2.x.toFixed(2)}, got x=${aX2}`);
      throw new Error(`rig visual didn't track second move: A=(${aX2}, ${tabBAfterMove2.x.toFixed(2)})`);
    }
    log(`  ✓ Tab A's remote rig visual x=${aX2.toFixed(2)} matches Tab B's actual x=${tabBAfterMove2.x.toFixed(2)}`);

    log("=== ASSERTION 4: lastTick matches the snapshot position ===");
    const tick = rigAAfter2.lastTick;
    if (!tick || Math.abs(tick.x - tabBAfterMove2.x) > 2) {
      fail(`__lastInterpolatorSetPosition doesn't match expected (${tabBAfterMove2.x.toFixed(2)}, ${tabBAfterMove2.y.toFixed(2)}): got (${tick?.x}, ${tick?.z})`);
      throw new Error("lastTick mismatch");
    }
    log(`  ✓ __lastInterpolatorSetPosition = (${tick.x.toFixed(2)}, ${tick.z.toFixed(2)})`);

    log("=== ALL RIG-VISUAL ASSERTIONS PASSED ===");
  } finally {
    if (browserA) await browserA.close();
    if (browserB) await browserB.close();
    if (canary) canary.kill("SIGTERM");
    if (vite) vite.kill("SIGTERM");
  }
}

const capturedLines = { A: [], B: [] };
function captureConsole(tab, line) {
  capturedLines[tab].push(line);
  if (capturedLines[tab].length > 5000) capturedLines[tab].shift();
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
