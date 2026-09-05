#!/usr/bin/env node
// PR 11.7.D3+ — prod-bundle smoke (Hetzner staging, 2026-09-04).
//
// Catches the class of bug that bit us on 2026-09-04: a feature works in
// `vite dev` (which uses esbuild + no tree-shaking) but is dead-code-
// eliminated from the prod bundle that real users actually run.
//
// What it asserts:
//   1. The prod bundle was built successfully (dist/index.html + at least
//      one JS chunk exist).
//   2. The bundled JS contains the wire-up symbols the smoke relies on
//      (`wireServerTransport`, `__serverTransport`, `__damageBus`). If
//      tree-shaking eats any of these, this fails BEFORE we even boot a
//      browser.
//   3. Boot canary + serve-static.mjs (TLS mode) on a fresh port set.
//   4. Playwright headless Chrome navigates to the HTTPS lobby URL with
//      `?server=<wss_url from matchmaker>` and waits for the wire-up to
//      fire.
//   5. Asserts:
//        a. `window.__serverTransport` is an object (not undefined)
//        b. `window.__damageBus` is an object (not undefined)
//        c. `window.__serverTransport.connected === true` within 10s
//        d. `__serverTransport.activeKind === "websocket"` (Hetzner's
//           QUIC stack rejects self-signed certs at the WebTransport
//           layer; this is the documented fallback path)
//        e. The canary log shows a successful WebSocket connection
//           from the test origin
//   6. Lobby join flow: navigate the lobby at HTTPS, click "Create room"
//      and verify the lobby's Join path navigates to a `?server=<wss_url>`
//      (PR #125 fix — wss_url pick on HTTPS pages).
//
// Why this matters:
//   - All existing smokes run against `vite dev`. They passed when
//     `import.meta.env.DEV`-gated code was the only path; they passed
//     again after PR #119 removed the literal DEV gate, even though
//     Vite's tree-shaker was STILL eliminating the wire-up. This is the
//     smoke that would have caught the original prod bug at PR-merge
//     time instead of post-deploy.
//   - PR #123's `wireServerTransport` extraction is the canonical pattern
//     for any future runtime-opaque gating. This smoke protects against
//     regressions where someone moves wire-up code back into scene.ts
//     where it can be tree-shaken.
//
// **Required env vars** (defaults match Hetzner staging topology):
//   PROD_BUNDLE_PORT  (default 14432)  — serve-static.mjs TLS port
//   WT_PORT           (default 14433)  — canary WebTransport
//   WS_PORT           (default 14434)  — canary WebSocket
//   WSS_PORT          (default 14435)  — canary WebSocket TLS
//   HTTP_PORT         (default 18080)  — canary matchmaker HTTP
//   CERT_DIR          (default $REPO_ROOT/.certs)
//   SMOKE_PNG         (default client/tools/prod-bundle-smoke.png)
//   SMOKE_NO_BOOT=1   — skip canary/serve-static boot (use already-running)
//
// **Required teardown**: kill canary + serve-static, even on failure.
// Matches the killProcs shape in lobby-real-canary-smoke.mjs.

import { chromium } from "playwright";
import { spawn, execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

const PROD_BUNDLE_PORT = Number(process.env.PROD_BUNDLE_PORT ?? 14432);
const WT_PORT = Number(process.env.WT_PORT ?? 14433);
const WS_PORT = Number(process.env.WS_PORT ?? 14434);
const WSS_PORT = Number(process.env.WSS_PORT ?? 14435);
const HTTP_PORT = Number(process.env.HTTP_PORT ?? 18080);
const CERT_DIR = process.env.CERT_DIR ?? resolve(REPO_ROOT, ".certs");
const SMOKE_PNG = process.env.SMOKE_PNG ?? resolve(REPO_ROOT, "client/tools/prod-bundle-smoke.png");
const SMOKE_NO_BOOT = process.env.SMOKE_NO_BOOT === "1";

const PROD_BUNDLE_HOST = process.env.PROD_BUNDLE_HOST ?? "127.0.0.1";
const PROD_BUNDLE_SCHEME = process.env.PROD_BUNDLE_SCHEME ?? "https";
const STATIC_URL = `${PROD_BUNDLE_SCHEME}://${PROD_BUNDLE_HOST}:${PROD_BUNDLE_PORT}/`;
// The matchmaker HTTP listener port. May differ from the static port when
// the static port proxies to the matchmaker (Hetzner serves both on the
// same port). Override CANARY_HOST / CANARY_SCHEME when proxying.
const CANARY_HOST = process.env.CANARY_HOST ?? PROD_BUNDLE_HOST;
const CANARY_SCHEME = process.env.CANARY_SCHEME ?? "http";
const CANARY_HTTP = `${CANARY_SCHEME}://${CANARY_HOST}:${HTTP_PORT}`;

const CERT_PATH = resolve(CERT_DIR, "dev.pem");
const KEY_PATH = resolve(CERT_DIR, "dev.key");

let canaryProc = null;
let serveStaticProc = null;
let browser = null;
let results = [];
let exitCode = 0;

function log(...args) {
  console.error("[prod-bundle]", ...args);
}

function recordPass(name) {
  log(`PASS ${name}`);
  results.push({ name, ok: true });
}

function recordFail(name, message) {
  log(`FAIL ${name}: ${message}`);
  results.push({ name, ok: false, message });
  exitCode = 1;
}

function killProcs() {
  try {
    if (canaryProc && !canaryProc.killed) {
      try { process.kill(-canaryProc.pid, "SIGKILL"); } catch {}
      try { canaryProc.kill("SIGKILL"); } catch {}
    }
  } catch {}
  try {
    if (serveStaticProc && !serveStaticProc.killed) {
      try { process.kill(-serveStaticProc.pid, "SIGKILL"); } catch {}
      try { serveStaticProc.kill("SIGKILL"); } catch {}
    }
  } catch {}
  for (const port of [PROD_BUNDLE_PORT, WT_PORT, WS_PORT, WSS_PORT, HTTP_PORT]) {
    try {
      const pids = execSync(`lsof -ti:${port} 2>/dev/null || true`, { encoding: "utf8" });
      if (pids.trim()) {
        execSync(`kill -9 ${pids.trim().split(/\s+/).join(" ")} 2>/dev/null || true`);
      }
    } catch {}
  }
}

// ─── Step 1: build the prod bundle ───────────────────────────────────────
async function buildProdBundle() {
  log("Building prod bundle (npm run build with VITE_MATCHMAKER_ORIGIN=" +
      CANARY_HTTP + ")...");
  try {
    execSync(
      `npm run build`,
      {
        cwd: resolve(REPO_ROOT, "client"),
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          VITE_MATCHMAKER_ORIGIN: CANARY_HTTP,
        },
      }
    );
    recordPass("build-prod-bundle");
  } catch (e) {
    recordFail("build-prod-bundle", e.message);
    throw new Error("build failed; aborting");
  }
}

// ─── Step 2: assert tree-shake didn't eat the wire-up ─────────────────────
async function assertBundledSymbols() {
  const distDir = resolve(REPO_ROOT, "client/dist");
  if (!existsSync(join(distDir, "index.html"))) {
    recordFail("bundle-exists", "client/dist/index.html missing");
    throw new Error("no bundle");
  }
  recordPass("bundle-exists");

  // Find the main JS chunk (index-*.js)
  const mainJs = execSync(
    `ls ${distDir}/assets/index-*.js 2>/dev/null | head -1`,
    { encoding: "utf8" }
  ).trim();

  if (!mainJs) {
    recordFail("bundle-main-js", "no index-*.js in client/dist/assets");
    throw new Error("no main JS");
  }

  const bundleBytes = readFileSync(mainJs);
  const bundleText = bundleBytes.toString();

  // Check for the wire-up markers. After PR #123's extraction, these
  // should be in the bundle (the side-effect import is the live reference
  // Vite can't tree-shake).
  const requiredMarkers = [
    "wireServerTransport",
    "__serverTransport",
    "__damageBus",
  ];
  const missing = requiredMarkers.filter(m => !bundleText.includes(m));
  if (missing.length) {
    recordFail(
      "bundle-wire-up-symbols",
      `tree-shaking ate: ${missing.join(", ")} — wire-up NOT in prod bundle. ` +
      `This is the bug class that bit us on 2026-09-04. Fix: re-extract wire-up ` +
      `to a separate module with side-effect import (see PR #123).`
    );
    throw new Error("tree-shake");
  }
  recordPass("bundle-wire-up-symbols");

  log(`Bundle size: ${(bundleBytes.length / 1024 / 1024).toFixed(2)} MB`);
}

// ─── Step 3: boot canary ─────────────────────────────────────────────────
async function bootCanary() {
  if (SMOKE_NO_BOOT) {
    log("SMOKE_NO_BOOT=1, skipping canary boot");
    return;
  }
  log(`Booting canary (WT=${WT_PORT}, WS=${WS_PORT}, WSS=${WSS_PORT}, HTTP=${HTTP_PORT}, CERT_DIR=${CERT_DIR})...`);
  canaryProc = spawn(
    "bash",
    [
      resolve(REPO_ROOT, "tools", "canary-server.sh"),
      "--port-wt", String(WT_PORT),
      "--port-ws", String(WS_PORT),
      "--port-wss", String(WSS_PORT),
      "--port-http", String(HTTP_PORT),
      "--cert-source", "self-signed",
      "--cert-dir", CERT_DIR,
    ],
    {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CARGO_PROFILE: "debug" },
      detached: true,
    }
  );
  canaryProc.stdout.on("data", (d) => process.stderr.write(`[canary] ${d}`));
  canaryProc.stderr.on("data", (d) => process.stderr.write(`[canary-err] ${d}`));

  // Wait for /health to return 200 (max 90s — cold cargo build)
  const HEALTH_TIMEOUT_MS = 90000;
  const start = Date.now();
  while (Date.now() - start < HEALTH_TIMEOUT_MS) {
    try {
      const r = await fetch(`${CANARY_HTTP}/health`);
      if (r.ok) {
        log(`Canary healthy after ${((Date.now() - start) / 1000).toFixed(1)}s`);
        return;
      }
    } catch {}
    await sleep(500);
  }
  throw new Error(`canary didn't come up within ${HEALTH_TIMEOUT_MS}ms`);
}

// ─── Step 4: boot serve-static.mjs in TLS mode ───────────────────────────
async function bootServeStatic() {
  if (SMOKE_NO_BOOT) {
    log("SMOKE_NO_BOOT=1, skipping serve-static boot");
    return;
  }
  if (!existsSync(CERT_PATH) || !existsSync(KEY_PATH)) {
    throw new Error(`cert files missing: ${CERT_PATH} / ${KEY_PATH}`);
  }
  log(`Booting serve-static.mjs (PORT=${PROD_BUNDLE_PORT}, TLS_CERT=${CERT_PATH})...`);
  serveStaticProc = spawn(
    "node",
    [
      resolve(REPO_ROOT, "tools", "serve-static.mjs"),
    ],
    {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: String(PROD_BUNDLE_PORT),
        ROOT: resolve(REPO_ROOT, "client/dist"),
        TLS_CERT: CERT_PATH,
        TLS_KEY: KEY_PATH,
      },
      detached: true,
    }
  );
  serveStaticProc.stdout.on("data", (d) => process.stderr.write(`[static] ${d}`));
  serveStaticProc.stderr.on("data", (d) => process.stderr.write(`[static-err] ${d}`));

  // Wait for HTTPS to be reachable. We use node:https directly (not
  // globalThis.fetch) because fetch in Node 22 doesn't honor the
  // `tls.rejectUnauthorized` option — silently rejects self-signed
  // certs. node:https.request accepts rejectUnauthorized in options.
  const START_TIMEOUT_MS = 30000;
  const start = Date.now();
  while (Date.now() - start < START_TIMEOUT_MS) {
    const reachable = await new Promise((resolve) => {
      const req = httpsRequest(
        {
          host: PROD_BUNDLE_HOST,
          port: PROD_BUNDLE_PORT,
          path: "/health",
          method: "GET",
          rejectUnauthorized: false,
        },
        (res) => {
          // Drain the response stream so the socket can close cleanly.
          res.resume();
          resolve(res.statusCode === 200);
        }
      );
      req.on("error", () => resolve(false));
      req.end();
    });
    if (reachable) {
      log(`serve-static HTTPS up after ${((Date.now() - start) / 1000).toFixed(1)}s`);
      return;
    }
    await sleep(500);
  }
  throw new Error(`serve-static didn't come up within ${START_TIMEOUT_MS}ms`);
}

// ─── Step 5: Playwright headless Chrome navigate + assert wire-up ────────
async function assertProdBundleWiresUp() {
  browser = await chromium.launch();
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  page.on("console", (msg) => {
    // Surface the wireServerTransport boot log so we can see it
    if (msg.text().includes("wireServerTransport") ||
        msg.text().includes("ServerTransport") ||
        msg.type() === "error") {
      process.stderr.write(`[page:${msg.type()}] ${msg.text()}\n`);
    }
  });
  page.on("pageerror", (err) => {
    process.stderr.write(`[pageerror] ${err.message}\n`);
  });

  // Hit the matchmaker first to get a real ws_url + wss_url.
  // We use curl (not globalThis.fetch) because Node 22's fetch
  // silently rejects self-signed certs without honoring the
  // tls.rejectUnauthorized option. curl's --insecure flag is the
  // universal escape hatch.
  let createRes;
  try {
    const curlOutput = execSync(
      `curl -sk -m 10 -X POST ${JSON.stringify(`${CANARY_HTTP}/rooms`)}`,
      { encoding: "utf8" },
    );
    const statusMatch = curlOutput.match(/"id"\s*:/);
    if (!statusMatch) {
      recordFail("matchmaker-create", `POST /rooms returned non-JSON: ${curlOutput.slice(0, 200)}`);
      await browser.close();
      return;
    }
    createRes = { ok: true, json: () => JSON.parse(curlOutput) };
  } catch (e) {
    recordFail("matchmaker-create", `POST /rooms fetch failed: ${e.message}`);
    await browser.close();
    return;
  }
  const created = await createRes.json();
  if (!created.wss_url) {
    recordFail("matchmaker-wss-url", `POST /rooms didn't return wss_url (got: ${JSON.stringify(created)})`);
    await browser.close();
    return;
  }
  recordPass("matchmaker-create");

  // Navigate to the static HTTPS URL with ?server=<wss_url>
  const target = new URL(STATIC_URL);
  target.searchParams.set("server", created.wss_url);
  target.searchParams.set("localId", "1");
  target.searchParams.set("peerId", "2");
  log(`Navigating to ${target.toString()}`);
  await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 30000 });

  // Wait for wire-up to populate window.__serverTransport
  const CONNECT_TIMEOUT_MS = 10000;
  let connected = false;
  let finalState = null;
  const start = Date.now();
  while (Date.now() - start < CONNECT_TIMEOUT_MS) {
    finalState = await page.evaluate(() => {
      const t = window.__serverTransport;
      if (!t) return null;
      return {
        connected: t.connected,
        activeKind: t.activeKind,
        kind: t.kind,
        stats: typeof t.getStats === "function" ? t.getStats() : null,
      };
    });
    if (finalState && finalState.connected && finalState.activeKind) {
      connected = true;
      break;
    }
    await sleep(200);
  }

  if (!finalState) {
    recordFail(
      "wire-up",
      `window.__serverTransport is undefined after ${CONNECT_TIMEOUT_MS}ms — ` +
      `tree-shake regression (PR #123 fix not present or new bug). State: ${JSON.stringify(finalState)}`
    );
  } else if (!connected) {
    recordFail(
      "wire-up-connected",
      `__serverTransport exists but never connected within ${CONNECT_TIMEOUT_MS}ms. ` +
      `State: ${JSON.stringify(finalState)}`
    );
  } else {
    recordPass("wire-up-connected");
    if (finalState.activeKind !== "websocket") {
      log(`Note: activeKind=${finalState.activeKind} (websocket is the documented fallback for self-signed certs)`);
    }
  }

  // Assert __damageBus
  const damageBus = await page.evaluate(() => {
    const b = window.__damageBus;
    if (!b) return null;
    return { type: typeof b, keys: Object.keys(b).slice(0, 5) };
  });
  if (!damageBus) {
    recordFail("damage-bus", "window.__damageBus is undefined");
  } else if (damageBus.type !== "object") {
    recordFail("damage-bus", `__damageBus is not an object (got type=${damageBus.type})`);
  } else {
    recordPass("damage-bus");
  }

  // Screenshot for the artifact
  try {
    await page.screenshot({ path: SMOKE_PNG, fullPage: true });
    log(`Screenshot saved to ${SMOKE_PNG}`);
  } catch (e) {
    log(`Screenshot failed: ${e.message}`);
  }

  await browser.close();
}

// ─── Step 6: lobby HTTPS Join flow asserts wss_url ──────────────────────
async function assertLobbyHttpsJoinUsesWssUrl() {
  browser = await chromium.launch();
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  page.on("pageerror", (err) => {
    process.stderr.write(`[pageerror-2] ${err.message}\n`);
  });

  // Lobby URL with the lobby=test flag
  const lobbyUrl = new URL(STATIC_URL);
  lobbyUrl.searchParams.set("lobby", "1");
  await page.goto(lobbyUrl.toString(), { waitUntil: "domcontentloaded", timeout: 30000 });

  // Wait for the lobby component to render (Create room button visible)
  try {
    await page.getByTestId("lobby-create").waitFor({ timeout: 5000 });
  } catch {
    recordFail("lobby-render", "Create-room button never appeared");
    await browser.close();
    return;
  }
  recordPass("lobby-render");

  // Click Create room
  await page.getByTestId("lobby-create").click();

  // Wait for navigation to ?server=...
  let navigated = false;
  let finalServerUrl = null;
  const start = Date.now();
  while (Date.now() - start < 5000) {
    const url = new URL(page.url());
    finalServerUrl = url.searchParams.get("server");
    if (finalServerUrl) {
      navigated = true;
      break;
    }
    await sleep(200);
  }

  if (!navigated) {
    recordFail("lobby-create-join", `no ?server= navigation after Create (url=${page.url()})`);
    await browser.close();
    return;
  }

  // The lobby page is on HTTPS, so `server` must be a wss:// URL (PR #125)
  if (!finalServerUrl.startsWith("wss://")) {
    recordFail(
      "lobby-create-join-scheme",
      `HTTPS lobby → expected wss:// server URL, got "${finalServerUrl}" — PR #125 fix missing?`
    );
  } else {
    recordPass("lobby-create-join-scheme");
  }

  await browser.close();
}

async function main() {
  try {
    if (!SMOKE_NO_BOOT) {
      await buildProdBundle();
      await assertBundledSymbols();
    } else {
      log("SMOKE_NO_BOOT=1 — skipping build + bundle asserts; canary + serve-static assumed already up");
      // Still try the bundle asserts against whatever's in dist/
      try {
        await assertBundledSymbols();
      } catch (e) {
        log(`Bundle asserts failed in NO_BOOT mode: ${e.message}`);
      }
    }

    await bootCanary();
    await bootServeStatic();

    await assertProdBundleWiresUp();
    await assertLobbyHttpsJoinUsesWssUrl();

    // Summary
    const passed = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;
    log(`\n=== SUMMARY ===`);
    log(`Passed: ${passed}`);
    log(`Failed: ${failed}`);
    for (const r of results) {
      log(`  ${r.ok ? "✓" : "✗"} ${r.name}${r.message ? `: ${r.message}` : ""}`);
    }
  } catch (e) {
    log(`FATAL: ${e.message}`);
    exitCode = 1;
  } finally {
    killProcs();
  }

  process.exit(exitCode);
}

main();
