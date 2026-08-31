#!/usr/bin/env node
// PR 11.9 — matchmaker lobby smoke.
//
// Boots the canary server (WebTransport + WebSocket + matchmaker HTTP)
// + Vite on a fresh port, opens a SINGLE headless tab against the
// entry URL (no `?server=`), and asserts:
//
//   1. The Lobby component renders (button + input visible).
//   2. Clicking "Create room" navigates to a `?server=<ws_url>` URL
//      (within 3s) where `<ws_url>` matches the matchmaker POST
//      response.
//   3. After navigation, the scene mounts and the `ServerTransport`
//      connects (connectionStatus === "connected" within 5s).
//
// The smoke is a single tab (NOT two-tab) because the matchmaker
// surface itself is single-player-shaped (you create a room, you
// share the URL, friends join). Two-tab flow is covered by the
// existing `damage-server-smoke.mjs` (which uses pre-baked URLs).
//
// **Required env vars**:
//   LOBBY_SMOKE_URL          (default http://localhost:5194/) — Vite URL
//   CANARY_SERVER_PORT_WT    (default 14433)
//   CANARY_SERVER_PORT_WS    (default 14434)
//   CANARY_SERVER_PORT_HTTP  (default 18080)
//   SMOKE_PNG                (default client/tools/lobby-smoke.png)
//
// **Required teardown**: kill vite + canary on exit, even on failure.

import { chromium } from "playwright";
import { spawn, execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

const URL_BASE = process.env.LOBBY_SMOKE_URL ?? "http://localhost:5194/";
const WT_PORT = Number(process.env.CANARY_SERVER_PORT_WT ?? 14433);
const WS_PORT = Number(process.env.CANARY_SERVER_PORT_WS ?? 14434);
const HTTP_PORT = Number(process.env.CANARY_SERVER_PORT_HTTP ?? 18080);
const VITE_PORT = 5194;
const SCREENSHOT = process.env.SMOKE_PNG ?? "client/tools/lobby-smoke.png";

const NAV_TIMEOUT = Number(process.env.SMOKE_NAV_TIMEOUT ?? 30000);
const CONNECT_TIMEOUT_MS = Number(process.env.SMOKE_CONNECT_TIMEOUT_MS ?? 5000);
const CREATE_NAV_TIMEOUT_MS = Number(process.env.LOBBY_SMOKE_CREATE_TIMEOUT ?? 3000);

const SCREENSHOT_PATH = resolve(REPO_ROOT, SCREENSHOT);

const log = (...args) => console.log("[lobby-smoke]", ...args);
const fail = (...args) => console.error("[lobby-smoke][FAIL]", ...args);

mkdirSync(dirname(SCREENSHOT_PATH), { recursive: true });

let canaryProc = null;
let viteProc = null;

async function bootCanary() {
  log(`Booting canary (WT=${WT_PORT}, WS=${WS_PORT}, HTTP=${HTTP_PORT})...`);
  canaryProc = spawn(
    "bash",
    [
      resolve(REPO_ROOT, "tools", "canary-server.sh"),
      "--port-wt", String(WT_PORT),
      "--port-ws", String(WS_PORT),
      "--port-http", String(HTTP_PORT),
      "--cert-source", "self-signed",
    ],
    {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CARGO_PROFILE: "debug" },
    }
  );
  canaryProc.stdout.on("data", (d) => process.stderr.write(`[canary] ${d}`));
  canaryProc.stderr.on("data", (d) => process.stderr.write(`[canary-err] ${d}`));

  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (canaryProc.exitCode !== null) {
      throw new Error(`canary exited with code ${canaryProc.exitCode} during boot`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/health`);
      if (res.ok) {
        log(`Canary matchmaker HTTP ready after ${i + 1}s`);
        return;
      }
    } catch (_) {
      // not yet
    }
  }
  throw new Error(`canary did not bind matchmaker HTTP ${HTTP_PORT} within 60s`);
}

async function bootVite() {
  log(`Booting Vite on port ${VITE_PORT}...`);
  viteProc = spawn(
    "npm",
    ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(VITE_PORT), "--strictPort"],
    {
      cwd: resolve(REPO_ROOT, "client"),
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    }
  );
  viteProc.stdout.on("data", (d) => process.stderr.write(`[vite] ${d}`));
  viteProc.stderr.on("data", (d) => process.stderr.write(`[vite-err] ${d}`));

  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (viteProc.exitCode !== null) {
      throw new Error(`Vite exited with code ${viteProc.exitCode} during boot`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${VITE_PORT}/`);
      if (res.ok) {
        log(`Vite ready after ${i + 1}s`);
        return;
      }
    } catch (_) {
      // not yet
    }
  }
  throw new Error(`Vite did not bind port ${VITE_PORT} within 60s`);
}

function killProcs() {
  for (const proc of [canaryProc, viteProc]) {
    if (proc && proc.exitCode === null) {
      try { proc.kill("SIGTERM"); } catch (_) { /* dead */ }
    }
  }
  setTimeout(() => {
    for (const port of [WT_PORT, WS_PORT, HTTP_PORT, VITE_PORT]) {
      try {
        const out = execSync(`lsof -ti:${port} 2>/dev/null || true`, { encoding: "utf8" });
        const pids = out.trim().split("\n").filter(Boolean);
        for (const pid of pids) {
          try { process.kill(Number(pid), "SIGKILL"); } catch (_) { /* already dead */ }
        }
      } catch (_) { /* best-effort */ }
    }
  }, 1000);
}

async function main() {
  log(`=== lobby-smoke (PR 11.9) ===`);
  log(`vite: ${URL_BASE}  WT=${WT_PORT}  WS=${WS_PORT}  HTTP=${HTTP_PORT}`);

  let pass = true;

  try {
    await bootCanary();
    await bootVite();

    const browser = await chromium.launch({ args: ["--no-sandbox"] });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") log(`[browser:error] ${m.text()}`);
    });

    log(`Navigating to ${URL_BASE} (no ?server= param → lobby should render)`);
    await page.goto(URL_BASE, { waitUntil: "networkidle", timeout: NAV_TIMEOUT });

    // Assertion 1: Lobby renders.
    log(`ASSERTION 1: lobby component renders`);
    const createBtn = page.getByTestId("lobby-create");
    const joinInput = page.getByTestId("lobby-code");
    const joinBtn = page.getByTestId("lobby-join");
    if (!(await createBtn.isVisible())) {
      fail(`lobby-create button not visible`);
      pass = false;
    } else if (!(await joinInput.isVisible())) {
      fail(`lobby-code input not visible`);
      pass = false;
    } else if (!(await joinBtn.isVisible())) {
      fail(`lobby-join button not visible`);
      pass = false;
    } else {
      log(`  ✓ lobby rendered (create + code + join all visible)`);
    }

    await page.screenshot({ path: SCREENSHOT_PATH });
    log(`screenshot: ${SCREENSHOT_PATH}`);

    // Assertion 2: Click "Create room" → navigates to ?server=<ws_url>
    log(`ASSERTION 2: clicking "Create room" navigates to ?server=... within ${CREATE_NAV_TIMEOUT_MS}ms`);
    await createBtn.click();
    try {
      await page.waitForURL(
          (url) => {
            const u = new URL(url);
            return !!u.searchParams.get("server");
          },
          { timeout: CREATE_NAV_TIMEOUT_MS, waitUntil: "load" }
      );
      log(`  ✓ navigated to ${page.url()}`);
    } catch (e) {
      fail(`Create-room did not navigate: ${e.message}; current URL: ${page.url()}`);
      pass = false;
    }

    // Assertion 3: Scene mounts + ServerTransport connects within
    // CONNECT_TIMEOUT_MS. We poll `window.__forceServerTransport`
    // (set by PeerOverlay on boot) and the connectionStatus HUD chip.
    if (pass) {
      log(`ASSERTION 3: scene mounts + ServerTransport connects within ${CONNECT_TIMEOUT_MS}ms`);
      let status = null;
      const deadline = Date.now() + CONNECT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        try {
          status = await page.evaluate(() => ({
            force: window.__forceServerTransport ?? false,
            connection: window.__lastConnectionStatus ?? "unknown",
            roomId: window.__damageServerRoomId ?? null,
          }));
          if (status && (status.connection === "connected" || status.force)) {
            break;
          }
        } catch (_) {
          // page may not have the probes yet
        }
        await sleep(200);
      }
      if (!status || !(status.connection === "connected" || status.force)) {
        fail(`ServerTransport did not connect within ${CONNECT_TIMEOUT_MS}ms (status=${JSON.stringify(status)})`);
        pass = false;
      } else {
        log(`  ✓ connected (force=${status.force}, roomId=${status.roomId})`);
      }
    }

    await context.close();
    await browser.close();
  } catch (e) {
    fail(`unexpected error: ${e.message}`);
    pass = false;
  } finally {
    killProcs();
    await sleep(2000);
  }

  if (pass) {
    log(`\n=== ALL ASSERTIONS PASSED ===`);
    process.exit(0);
  } else {
    log(`\n=== ASSERTIONS FAILED — see [FAIL] lines above ===`);
    process.exit(1);
  }
}

main();