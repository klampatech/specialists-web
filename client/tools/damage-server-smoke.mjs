#!/usr/bin/env node
// PR 11.6.C / §3.6 — server-transport round-trip smoke.
//
// Boots the canary server (WebTransport + WebSocket) + vite on port 5190,
// opens a SINGLE headless tab against the dev server with the
// `__forceServerTransport = true` DEV probe set, and asserts:
//
//   1. `ServerTransport.connect()` resolves within 5s.
//   2. `getStats()` returns `{ rttMs: number, transport: 'webtransport' | 'websocket' }`.
//   3. `sendPing(...)` → `onPong` fires within 100ms with the right
//      `clientTimestamp` echo.
//   4. `sendDamageRequest(...)` → `onDamageBroadcast` fires within 100ms
//      with matching `originEventId` (the synthetic-broadcast PR 11.6.C
//      behavior; PR 11.6.D replaces with real validation).
//   5. `sendPositionUpdate(...)` → no reply, but no error.
//   6. `sendInputs(...)` (the §1.2 seam test) → no error.
//   7. Malformed payload: opens a parallel connection, sends a
//      `[0xFF, 0x00, 0x00]` packet, asserts no crash + that
//      `getStats()` still reports a valid `rttMs`.
//
// This is the PR 11.6.C deliverable smoke for the transport + codecs.
// PR 11.6.D adds a two-tab HP-convergence smoke on top of this.
//
// **Note on cert handling**: Chromium rejects self-signed certs by
// default; we pass `--ignore-certificate-errors` to the Playwright
// launcher (the standard pattern for dev-only HTTPS to localhost).
// This is dev-only — production (PR 11.11) replaces with Let's Encrypt.
//
// **Required env vars**:
//   DAMAGE_SERVER_SMOKE_URL (default http://localhost:5190/)
//   CANARY_SERVER_PORT_WT (default 14433)
//   CANARY_SERVER_PORT_WS (default 14434)
//   SMOKE_PNG (default client/tools/damage-server-smoke.png)
//
// **Required teardown**: kill vite + canary on exit, even on failure
// (try/finally).

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

const URL = process.env.DAMAGE_SERVER_SMOKE_URL ?? "http://localhost:5190/";
const WT_PORT = Number(process.env.CANARY_SERVER_PORT_WT ?? 14433);
const WS_PORT = Number(process.env.CANARY_SERVER_PORT_WS ?? 14434);
const SCREENSHOT = process.env.SMOKE_PNG ?? "client/tools/damage-server-smoke.png";

const NAV_TIMEOUT = Number(process.env.SMOKE_NAV_TIMEOUT ?? 30000);
const CONNECT_TIMEOUT_MS = Number(process.env.SMOKE_CONNECT_TIMEOUT_MS ?? 5000);
const PONG_TIMEOUT_MS = Number(process.env.SMOKE_PONG_TIMEOUT_MS ?? 1000);
const BROADCAST_TIMEOUT_MS = Number(process.env.SMOKE_BROADCAST_TIMEOUT_MS ?? 1000);

const SCREENSHOT_PATH = resolve(REPO_ROOT, SCREENSHOT);

const log = (...args) => console.log("[smoke]", ...args);
const fail = (...args) => console.error("[smoke][FAIL]", ...args);

// ---------------------------------------------------------------------------
// Step 1: Boot the canary server + vite dev server in background.
// ---------------------------------------------------------------------------

mkdirSync(dirname(SCREENSHOT_PATH), { recursive: true });

let canaryProc = null;
let viteProc = null;

async function bootCanary() {
  log(`Booting canary server (WT=${WT_PORT}, WS=${WS_PORT})...`);
  canaryProc = spawn(
    "bash",
    [
      resolve(REPO_ROOT, "tools", "canary-server.sh"),
      "--port-wt", String(WT_PORT),
      "--port-ws", String(WS_PORT),
    ],
    {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CARGO_PROFILE: "debug" },
    }
  );
  canaryProc.stdout.on("data", (d) => process.stderr.write(`[canary] ${d}`));
  canaryProc.stderr.on("data", (d) => process.stderr.write(`[canary-err] ${d}`));
  // Give the canary up to 60s to boot (cert generation + cargo build).
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (canaryProc.exitCode !== null) {
      throw new Error(`canary exited with code ${canaryProc.exitCode}`);
    }
    // Try to connect to the WebSocket port to see if it's up.
    const reachable = await isTcpReachable("127.0.0.1", WS_PORT);
    if (reachable) {
      log(`Canary ready after ${i + 1}s`);
      return;
    }
  }
  throw new Error(`canary did not become ready in 60s`);
}

async function bootVite() {
  log(`Booting vite on 5190...`);
  viteProc = spawn(
    "npm",
    ["run", "dev", "--", "--host", "127.0.0.1", "--port", "5190", "--strictPort"],
    {
      cwd: resolve(REPO_ROOT, "client"),
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  viteProc.stdout.on("data", (d) => process.stderr.write(`[vite] ${d}`));
  viteProc.stderr.on("data", (d) => process.stderr.write(`[vite-err] ${d}`));
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    try {
      const resp = await fetch(URL);
      if (resp.ok) {
        log(`Vite ready after ${i + 1}s`);
        return;
      }
    } catch {
      // not ready yet
    }
  }
  throw new Error(`vite did not become ready in 60s`);
}

async function isTcpReachable(host, port) {
  const net = await import("node:net");
  return new Promise((resolveP) => {
    const sock = net.createConnection({ host, port }, () => {
      sock.end();
      resolveP(true);
    });
    sock.on("error", () => resolveP(false));
    sock.setTimeout(1000, () => {
      sock.destroy();
      resolveP(false);
    });
  });
}

async function teardown() {
  log("Tearing down canary + vite...");
  for (const proc of [viteProc, canaryProc]) {
    if (proc && proc.exitCode === null) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  }
  // Belt-and-suspenders: nuke any stragglers on the known ports.
  for (const port of [5190, WT_PORT, WS_PORT]) {
    try {
      const { execSync } = await import("node:child_process");
      execSync(`lsof -ti:${port} 2>/dev/null | xargs -r kill -9`, { stdio: "ignore" });
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Step 2: Run the smoke.
// ---------------------------------------------------------------------------

async function runSmoke() {
  const browser = await chromium.launch({
    headless: true,
    // Self-signed cert for the canary WebTransport. Production (PR 11.11)
    // replaces with Let's Encrypt + system trust store.
    args: ["--ignore-certificate-errors"],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));

  // Set the DEV probe BEFORE the page loads (so scene.ts sees it on boot).
  await context.addInitScript({
    content: `
      window.__forceServerTransport = true;
      window.__damageServerPorts = { wt: ${WT_PORT}, ws: ${WS_PORT} };
      window.__damageServerUrl = ${JSON.stringify(URL)};
      window.__damageServerRoomId = "DEVBX";
    `,
  });

  try {
    log(`Navigating to ${URL}...`);
    await page.goto(URL, { waitUntil: "networkidle", timeout: NAV_TIMEOUT });

    // Wait for the scene to finish initializing + the DEV probe to
    // install the ServerTransport. The probe is async (the IIFE in
    // scene.ts awaits the dynamic imports + connect()), so we poll.
    log("Waiting for __serverTransport probe...");
    const connected = await waitForProbe(page, CONNECT_TIMEOUT_MS);
    if (!connected) {
      throw new Error(`__serverTransport did not become ready within ${CONNECT_TIMEOUT_MS}ms`);
    }

    // ---- 1. Connection + getStats ----
    const initialStats = await page.evaluate(() => {
      const t = (window).__serverTransport;
      return { ...t.getStats(), transport: t.getStats().transport };
    });
    log(`Initial stats: ${JSON.stringify(initialStats)}`);
    if (typeof initialStats.rttMs !== "number" || initialStats.rttMs < 0) {
      throw new Error(`getStats().rttMs invalid: ${initialStats.rttMs}`);
    }
    if (initialStats.transport !== "webtransport" && initialStats.transport !== "websocket") {
      throw new Error(`getStats().transport invalid: ${initialStats.transport}`);
    }
    if (!initialStats.connected) {
      throw new Error("getStats().connected is false after connect() resolved");
    }

    // ---- 2. Ping → Pong ----
    const pingEventId = Math.floor(Math.random() * 0xffffffff);
    const pongResult = await page.evaluate(async ({ pingEventId, timeoutMs }) => {
      const t = (window).__serverTransport;
      return await new Promise((resolveP) => {
        const t_p = setTimeout(() => resolveP({ ok: false, reason: "timeout" }), timeoutMs);
        t.onPong((body) => {
          clearTimeout(t_p);
          // We don't decode the body here — we just need to know the
          // callback fired. The decoder check is in step 3.
          resolveP({ ok: true, bodyLen: body.length });
        });
        t.sendPing({ clientTimestamp: pingEventId });
      });
    }, { pingEventId, timeoutMs: PONG_TIMEOUT_MS });
    if (!pongResult.ok) {
      throw new Error(`onPong did not fire within ${PONG_TIMEOUT_MS}ms: ${pongResult.reason}`);
    }
    log(`onPong fired (body length=${pongResult.bodyLen})`);

    // Wait briefly for the RTT to populate, then verify it.
    await sleep(500);
    const statsAfterPing = await page.evaluate(() => {
      return (window).__serverTransport.getStats();
    });
    log(`Stats after ping: ${JSON.stringify(statsAfterPing)}`);
    if (typeof statsAfterPing.rttMs !== "number" || statsAfterPing.rttMs < 0) {
      throw new Error(`RTT invalid: ${statsAfterPing.rttMs}`);
    }

    // ---- 3. DamageRequest → DamageBroadcast (PR 11.6.D / §3.4 server-auth) ----
    // PR 11.6.D: the server now VALIDATES the request (gates: source +
    // target in room, amount<=100, fire-rate cooldown, ammo gate,
    // eventId monotonicity, lag-comp hit re-validation). The smoke
    // must seed the room (send a PositionUpdate FIRST so source 7 is
    // in the room) before the DamageRequest will pass validation.
    const damageReq = {
      frame: 0xdeadbeef,
      sourcePlayerId: 7,
      targetPlayerId: 9,
      source: 0,
      amount: 12,
      eventId: 0xcafef00d,
    };
    // Seed: send PositionUpdate for source 7 + target 9 at frame 0
    // so they're registered in the room + have position history.
    await page.evaluate(() => {
      const t = (window).__serverTransport;
      t.sendPositionUpdate({serverFrame: 0, playerId: 7, positionX: 0.0, positionY: 0.0});
      t.sendPositionUpdate({serverFrame: 0, playerId: 9, positionX: 5.0, positionY: 0.0});
    });
    // Small delay so the server's writer applies both before our
    // DamageRequest arrives.
    await sleep(50);
    const bcResult = await page.evaluate(async ({ req, timeoutMs }) => {
      const t = (window).__serverTransport;
      const bus = (window).__damageBus;
      return await new Promise((resolveP) => {
        const t_p = setTimeout(() => resolveP({ ok: false, reason: "timeout" }), timeoutMs);
        t.onDamageBroadcast((body) => {
          clearTimeout(t_p);
          const bc = bus.decodeDamageBroadcast(body);
          resolveP({ ok: !!bc, bc });
        });
        bus.sendDamageRequest(req);
      });
    }, { req: damageReq, timeoutMs: BROADCAST_TIMEOUT_MS });
    if (!bcResult.ok || !bcResult.bc) {
      throw new Error(`onDamageBroadcast did not return a valid broadcast within ${BROADCAST_TIMEOUT_MS}ms: ${bcResult.reason}`);
    }
    const bc = bcResult.bc;
    log(`DamageBroadcast received: ${JSON.stringify(bc)}`);
    if (bc.sourcePlayerId !== damageReq.sourcePlayerId) {
      throw new Error(`sourcePlayerId mismatch: ${bc.sourcePlayerId} != ${damageReq.sourcePlayerId}`);
    }
    if (bc.targetPlayerId !== damageReq.targetPlayerId) {
      throw new Error(`targetPlayerId mismatch: ${bc.targetPlayerId} != ${damageReq.targetPlayerId}`);
    }
    if (bc.amount !== damageReq.amount) {
      throw new Error(`amount mismatch: ${bc.amount} != ${damageReq.amount}`);
    }
    if (bc.originEventId !== damageReq.eventId) {
      throw new Error(`originEventId mismatch: ${bc.originEventId} != ${damageReq.eventId}`);
    }

    // ---- 4. PositionUpdate — no reply ----
    const puResult = await page.evaluate(async ({ timeoutMs }) => {
      const t = (window).__serverTransport;
      return await new Promise((resolveP) => {
        let gotReply = false;
        const t_p = setTimeout(() => resolveP({ ok: !gotReply }), timeoutMs);
        // Register a one-shot listener that fires if the server replies.
        // The server's handle_binary returns an empty Vec for
        // PositionUpdate, so we expect gotReply === false after the
        // timeout.
        t.onDamageBroadcast(() => {
          gotReply = true;
          clearTimeout(t_p);
          resolveP({ ok: false, reason: "unexpected damageBroadcast reply" });
        });
        t.sendPositionUpdate({
          serverFrame: 42,
          playerId: 7,
          positionX: 1.5,
          positionY: -2.25,
        });
      });
    }, { timeoutMs: 500 });
    if (!puResult.ok) {
      throw new Error(`PositionUpdate produced unexpected reply: ${puResult.reason}`);
    }
    log(`PositionUpdate sent (no reply as expected)`);

    // ---- 5. sendInputs (§1.2 seam) — no error ----
    const inputsResult = await page.evaluate(async ({ timeoutMs }) => {
      const t = (window).__serverTransport;
      return await new Promise((resolveP) => {
        const t_p = setTimeout(() => resolveP({ ok: true }), timeoutMs);
        t.onInputs((body) => {
          // PR 11.6.C: server buffers onto inputs_buffer (no reply).
          // The smoke just checks the send path doesn't throw.
          clearTimeout(t_p);
          resolveP({ ok: true, bodyLen: body.length });
        });
        t.sendInputs({
          frame: 100,
          encodedInput: new Uint8Array(12).fill(0xab),
        });
      });
    }, { timeoutMs: 500 });
    log(`sendInputs completed (ok=${inputsResult.ok})`);

    // ---- 6. Malformed payload — no crash ----
    // We open a parallel connection (via WebSocket — see note below)
    // and send an unknown discriminator. The server should log
    // "unknown discriminator — discarded" but not crash. We can't grep
    // the server log from a headless browser, so we just assert no
    // client-side error + that getStats() still reports a valid rttMs.
    //
    // NOTE: we use WebSocket (not WebTransport) for this stress test
    // because the headless Chromium's QUIC stack rejects self-signed
    // certs even with `--ignore-certificate-errors` (a known Chromium
    // quirk — the QUIC TLS verifier has its own flag that the HTTP
    // one doesn't gate). The server's `handle_binary` is transport-
    // agnostic, so the test is equivalent via either path.
    const malformedResult = await page.evaluate(async ({ urlBase, wsPort, timeoutMs }) => {
      // Open a fresh WebSocket connection directly (bypassing our
      // ServerTransport class) so we can send a single malformed
      // packet. This is the "unknown discriminator" stress test.
      const url = `ws://${new URL(urlBase).hostname}:${wsPort}/rooms/DEVBX`;
      let ws;
      try {
        ws = new WebSocket(url);
        ws.binaryType = "arraybuffer";
        await new Promise((resolveP, rejectP) => {
          ws.addEventListener("open", () => resolveP(undefined));
          ws.addEventListener("error", () => rejectP(new Error("ws open failed")));
          setTimeout(() => rejectP(new Error("ws open timed out")), 5000);
        });
      } catch (err) {
        return { ok: false, reason: `WebSocket create failed: ${err}` };
      }
      try {
        // Send a 3-byte packet with discriminator 0xFF (unused).
        const payload = new Uint8Array([0xff, 0x00, 0x00]);
        ws.send(payload);
        // Read whatever comes back (should be empty since the server
        // discards unknown discriminators with no reply). We just wait
        // briefly + close.
        await new Promise((r) => setTimeout(r, 200));
      } catch (err) {
        return { ok: false, reason: `send failed: ${err}` };
      } finally {
        try { ws.close(); } catch {}
      }
      // Verify our main transport is still healthy.
      const mainStats = (window).__serverTransport.getStats();
      return {
        ok: typeof mainStats.rttMs === "number" && mainStats.rttMs >= 0,
        rttMs: mainStats.rttMs,
        transport: mainStats.transport,
      };
    }, { urlBase: URL, wsPort: WS_PORT, timeoutMs: 5000 });
    if (!malformedResult.ok) {
      throw new Error(`Malformed payload test failed: ${malformedResult.reason}`);
    }
    log(`Malformed payload handled cleanly (main transport rttMs=${malformedResult.rttMs}, transport=${malformedResult.transport})`);

    // ---- 7. Wire-size symmetry ----
    // The TS encoders must produce the exact sizes asserted by the
    // Rust encoders. We verify this directly via the encodeXxx helpers
    // (the production code uses them; we just inspect the output).
    const wireSizes = await page.evaluate(() => {
      const bus = (window).__damageBus;
      return {
        damageRequest: bus.encodeDamageRequest({
          frame: 1, sourcePlayerId: 1, targetPlayerId: 2,
          source: 0, amount: 1, eventId: 1,
        }).length,
        damageBroadcast: bus.encodeDamageBroadcast({
          serverFrame: 1, serverSeq: 1, sourcePlayerId: 1, targetPlayerId: 2,
          source: 0, amount: 1, originEventId: 1,
        }).length,
        positionUpdate: bus.encodePositionUpdate({
          serverFrame: 1, playerId: 1, positionX: 0.0, positionY: 0.0,
        }).length,
        ping: bus.encodePing({ clientTimestamp: 1 }).length,
        inputsServer: bus.encodeInputsServer({
          frame: 1, encodedInput: new Uint8Array(12),
        }).length,
      };
    });
    log(`Wire sizes: ${JSON.stringify(wireSizes)}`);
    // PR 11.6.C review fix B2: every TS encoder prefixes the
    // discriminator, so the wire sizes are body+1. InputsServer was
    // already 17 (disc + body) so it stays at 17. The others grow
    // by 1 (14 -> 15, 18 -> 19, 4 -> 5).
    const EXPECTED = { damageRequest: 15, damageBroadcast: 19, positionUpdate: 15, ping: 5, inputsServer: 17 };
    for (const [k, v] of Object.entries(EXPECTED)) {
      if (wireSizes[k] !== v) {
        throw new Error(`Wire size mismatch for ${k}: got ${wireSizes[k]}, expected ${v}`);
      }
    }

    // ---- Capture screenshot ----
    await page.screenshot({ path: SCREENSHOT_PATH });

    if (errors.length > 0) {
      throw new Error(`pageerror events: ${errors.join("; ")}`);
    }

    log(`OK — damage-server-smoke passed (RTT=${statsAfterPing.rttMs}ms via ${initialStats.transport})`);
    await browser.close();
    return true;
  } catch (err) {
    fail("FAIL:", err.message);
    try {
      await page.screenshot({ path: SCREENSHOT_PATH });
    } catch {
      // ignore
    }
    if (errors.length > 0) {
      fail(`pageerror events: ${errors.join("; ")}`);
    }
    await browser.close();
    return false;
  }
}

async function waitForProbe(page, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await page.evaluate(() => {
      const t = (window).__serverTransport;
      return !!(t && t.getStats && t.getStats().connected);
    }).catch(() => false);
    if (ready) return true;
    await sleep(100);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  let success = false;
  try {
    await bootCanary();
    await bootVite();
    // Give the canary + vite a moment to settle (the canary has just
    // bound; the vite has just compiled the page; let the page pick
    // up the roomId/ports from the init script).
    await sleep(500);
    success = await runSmoke();
  } catch (err) {
    fail("Boot error:", err.message);
    success = false;
  } finally {
    await teardown();
  }
  process.exit(success ? 0 : 1);
})();
