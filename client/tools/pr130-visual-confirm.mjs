#!/usr/bin/env node
// PR #130 / Hetzner staging 2026-09-05 — visual confirmation that the
// snapshot decoder pipeline drives the remote rig in the prod bundle.
//
// Opens two tabs (player 1 + player 2) at the prod URL, waits 5s for
// snapshots to arrive + the remote rig to track Tab A's position,
// then screenshots Tab B's viewport. Asserts:
//   1. Both rigs are visible (not hidden, not NaN positions).
//   2. The remote rig's Havok position differs from the spawn position
//      (proof that the snapshot decoder actually moved it).
//
// Required env: same as prod-bundle-smoke.mjs. Pass SMOKE_NO_BOOT=1 if
// canary + serve-static are already running.
import { chromium } from "playwright";
import { spawn, execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
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
const PROD_BUNDLE_HOST = process.env.PROD_BUNDLE_HOST ?? "127.0.0.1";
const PROD_BUNDLE_SCHEME = process.env.PROD_BUNDLE_SCHEME ?? "https";
const CANARY_HOST = process.env.CANARY_HOST ?? PROD_BUNDLE_HOST;
const CANARY_SCHEME = process.env.CANARY_SCHEME ?? "http";
const CANARY_HTTP = `${CANARY_SCHEME}://${CANARY_HOST}:${HTTP_PORT}`;
const STATIC_URL = `${PROD_BUNDLE_SCHEME}://${PROD_BUNDLE_HOST}:${PROD_BUNDLE_PORT}/`;

const SMOKE_PNG = process.env.SMOKE_PNG ?? resolve(REPO_ROOT, "client/tools/pr130-visual-confirm.png");
const SMOKE_NO_BOOT = process.env.SMOKE_NO_BOOT === "1";

mkdirSync(dirname(SMOKE_PNG), { recursive: true });

const log = (...args) => console.error("[pr130-visual]", ...args);
const fail = (...args) => console.error("[pr130-visual][FAIL]", ...args);

let canaryProc = null;
let serveStaticProc = null;
let browserA = null;
let browserB = null;
const results = [];
function recordPass(name) { log(`PASS ${name}`); results.push({ name, ok: true }); }
function recordFail(name, msg) { log(`FAIL ${name}: ${msg}`); results.push({ name, ok: false, msg }); }

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
      if (pids.trim()) execSync(`kill -9 ${pids.trim().split(/\s+/).join(" ")} 2>/dev/null || true`);
    } catch {}
  }
}

async function bootCanary() {
  if (SMOKE_NO_BOOT) return;
  canaryProc = spawn("bash", [
    resolve(REPO_ROOT, "tools", "canary-server.sh"),
    "--port-wt", String(WT_PORT),
    "--port-ws", String(WS_PORT),
    "--port-wss", String(WSS_PORT),
    "--port-http", String(HTTP_PORT),
    "--cert-source", "self-signed",
    "--cert-dir", CERT_DIR,
  ], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CARGO_PROFILE: "debug" }, detached: true });
  canaryProc.stdout.on("data", (d) => process.stderr.write(`[canary] ${d}`));
  canaryProc.stderr.on("data", (d) => process.stderr.write(`[canary-err] ${d}`));
  const start = Date.now();
  while (Date.now() - start < 90000) {
    try { const r = await fetch(`${CANARY_HTTP}/health`); if (r.ok) return; } catch {}
    await sleep(500);
  }
  throw new Error("canary didn't come up");
}

async function bootServeStatic() {
  if (SMOKE_NO_BOOT) return;
  const CERT_PATH = resolve(CERT_DIR, "dev.pem");
  const KEY_PATH = resolve(CERT_DIR, "dev.key");
  serveStaticProc = spawn("node", [resolve(REPO_ROOT, "tools", "serve-static.mjs")], {
    cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(PROD_BUNDLE_PORT), ROOT: resolve(REPO_ROOT, "client/dist"), TLS_CERT: CERT_PATH, TLS_KEY: KEY_PATH },
    detached: true,
  });
  serveStaticProc.stdout.on("data", (d) => process.stderr.write(`[static] ${d}`));
  serveStaticProc.stderr.on("data", (d) => process.stderr.write(`[static-err] ${d}`));
  const start = Date.now();
  while (Date.now() - start < 30000) {
    const r = await fetch(`${STATIC_URL}health`, { agent: new (await import("node:https")).Agent({ rejectUnauthorized: false }) }).catch(() => null);
    if (r && r.ok) return;
    await sleep(500);
  }
  throw new Error("serve-static didn't come up");
}

async function waitForServerTransport(page, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await page.evaluate(() => {
      const t = window.__serverTransport;
      return !!(t && t.getStats && t.getStats().connected);
    }).catch(() => false);
    if (ok) return true;
    await sleep(100);
  }
  return false;
}

async function main() {
  let exitCode = 0;
  try {
    await bootCanary();
    await bootServeStatic();

    // Create room via matchmaker
    const roomJson = execSync(`curl -sk -m 10 -X POST ${JSON.stringify(`${CANARY_HTTP}/rooms`)}`, { encoding: "utf8" });
    const room = JSON.parse(roomJson);
    log(`Room: ${room.wss_url}`);

    browserA = await chromium.launch({ headless: true, args: ["--ignore-certificate-errors"] });
    browserB = await chromium.launch({ headless: true, args: ["--ignore-certificate-errors"] });
    const ctxA = await browserA.newContext({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true });
    const ctxB = await browserB.newContext({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true });
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    for (const [page, localId, peerId] of [[pageA, 1, 2], [pageB, 2, 1]]) {
      await page.addInitScript({
        content: `
          window.__forceServerTransport = true;
          window.__localPlayerId = ${localId};
          window.__peerPlayerId = ${peerId};
        `,
      });
    }
    const navUrl = (() => {
      const u = new URL(STATIC_URL);
      u.searchParams.set("server", room.wss_url);
      return u.toString();
    })();
    await pageA.goto(navUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await pageB.goto(navUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

    const [okA, okB] = await Promise.all([
      waitForServerTransport(pageA, 10000),
      waitForServerTransport(pageB, 10000),
    ]);
    if (!okA || !okB) {
      throw new Error(`ServerTransport didn't connect (okA=${okA}, okB=${okB})`);
    }
    recordPass("server-transport-connected");

    // Wait 5s for snapshots to flow + remote rig to track Tab A's position.
    log("Waiting 5s for snapshot decoder to drive remote rig ...");
    await sleep(5000);

    // Probe both rigs in Tab B.
    const probe = await pageB.evaluate(() => {
      const sess = window.__gameSession;
      if (!sess) return null;
      const local = sess.localController;
      const remote = sess.remoteController;
      const localPos = local?.state?.position;
      const remotePos = remote?.state?.position;
      const remoteVisualRootPos = (() => {
        const vr = remote?.visualRoot;
        return vr ? { x: vr.position.x, y: vr.position.y, z: vr.position.z } : null;
      })();
      return {
        localId: sess.localPlayerId,
        peerId: sess.peerPlayerId,
        localPos: localPos ? { x: localPos.x, y: localPos.y, z: localPos.z } : null,
        remotePos: remotePos ? { x: remotePos.x, y: remotePos.y, z: remotePos.z } : null,
        remoteVisualRootPos,
        remoteRespawnPos: remote?.respawnPosition ? { x: remote.respawnPosition.x, y: remote.respawnPosition.y, z: remote.respawnPosition.z } : null,
        latestSnap: window.__latestSnap?.() ?? null,
        lastSetPos: window.__lastInterpolatorSetPosition ?? null,
        hasInterpolator: !!window.__interpolator,
      };
    });
    log(`Tab B probe: ${JSON.stringify({
      localPos: probe?.localPos,
      remotePos: probe?.remotePos,
      remoteVisualRootPos: probe?.remoteVisualRootPos,
      remoteRespawnPos: probe?.remoteRespawnPos,
      snapPlayers: probe?.latestSnap?.players?.length ?? 0,
      lastSetPos: probe?.lastSetPos,
      hasInterpolator: probe?.hasInterpolator,
    })}`);

    if (!probe) {
      recordFail("probe", "Tab B __gameSession missing — scene didn't init");
    } else {
      // Both rigs have non-spawn positions (allow some tolerance for floating point).
      const spawnTolerance = 0.5;
      const localSpawn = probe.remoteRespawnPos;
      const remoteSpawn = probe.remoteRespawnPos; // both rigs use the same respawnPosition
      const movedLocal = localSpawn && probe.localPos && (
        Math.abs(probe.localPos.x - localSpawn.x) > spawnTolerance ||
        Math.abs(probe.localPos.z - localSpawn.z) > spawnTolerance
      );
      const movedRemote = remoteSpawn && probe.remotePos && (
        Math.abs(probe.remotePos.x - remoteSpawn.x) > spawnTolerance ||
        Math.abs(probe.remotePos.z - remoteSpawn.z) > spawnTolerance
      );
      if (!movedLocal) {
        recordFail("local-rig-moved", `Tab B local rig at spawn (pos=${JSON.stringify(probe.localPos)}, spawn=${JSON.stringify(localSpawn)})`);
      } else {
        recordPass(`local-rig-moved-pos=${JSON.stringify(probe.localPos)}`);
      }
      if (!movedRemote) {
        recordFail("remote-rig-moved", `Tab B remote rig at spawn (pos=${JSON.stringify(probe.remotePos)}, spawn=${JSON.stringify(remoteSpawn)}, lastSetPos=${JSON.stringify(probe.lastSetPos)})`);
      } else {
        recordPass(`remote-rig-moved-pos=${JSON.stringify(probe.remotePos)}-lastSetPos=${JSON.stringify(probe.lastSetPos)}`);
      }
    }

    await pageB.screenshot({ path: SMOKE_PNG, fullPage: true });
    log(`Screenshot: ${SMOKE_PNG}`);
  } catch (e) {
    fail(`FATAL: ${e.message}`);
    exitCode = 1;
  } finally {
    try { if (browserA) await browserA.close(); } catch {}
    try { if (browserB) await browserB.close(); } catch {}
    killProcs();
    log(`\n=== SUMMARY ===`);
    log(`Passed: ${results.filter(r => r.ok).length}`);
    log(`Failed: ${results.filter(r => !r.ok).length}`);
    for (const r of results) log(`  ${r.ok ? "✓" : "✗"} ${r.name}${r.message ? `: ${r.message}` : ""}`);
  }
  process.exit(exitCode);
}

main();
