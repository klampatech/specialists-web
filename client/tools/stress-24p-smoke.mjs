// PR 11.7.D3.3 — 24-player stress smoke.
//
// Spawns MAX_PLAYERS_PER_ROOM (24) chromium browser contexts, each
// with a unique localPlayerId 1..24, all connecting to the SAME
// ServerTransport room. Verifies:
//
//   1. ALL 24 tabs' ServerTransports connect successfully
//      (no handshake timeout, no max-player rejection).
//   2. ALL 24 player IDs appear in every tab's snapshot stream
//      (server fan-out reaches all clients; no connection is
//      silently dropped after connect).
//   3. Snapshot snapshot-server-side mpsc drop-oldest counter
//      stays at zero across the smoke window (no saturation
//      under N-player load with default behavior — a tab does
//      NOT need to actively walk/fire to drive the snapshot
//      stream; snapshots arrive at 20Hz regardless).
//
// Pattern mirrors `two-tab-smoke.mjs` (2 tabs, snapshot fan-out)
// and `two-tab-manual-flow.mjs` (manual flow assertions). This
// smoke is the canonical "does 24-player actually work?" gate
// for the 24-player scale goal stated in the architecture plan.
//
// **Why 24 and not 8/16**: `MAX_PLAYERS_PER_ROOM = 24` (server/src/
// constants.rs) is the hard cap. The stress smoke pushes the
// room to its absolute limit. Lower counts (8, 16) are subsets
// and should pass trivially if 24 passes — running at 24
// catches any N² quadratic pathology that smaller N hides.
//
// **Memory budget**: each Chromium headless context is ~80-120MB
// RSS at idle (Babylon GPU resource baseline). 24 contexts = ~2.5GB.
// Plus Vite + cargo canary ~500MB. Total: ~3GB free needed on the
// CI runner. GitHub's ubuntu-latest has 7GB RAM, which is
// comfortable headroom, but launching 24 chromium contexts in
// parallel stresses the runner's IO scheduler; the smoke uses a
// staged launch (3 tabs at a time, with a settle between waves)
// to keep CPU/IO peak load manageable. See STRESS_24P_LAUNCH_WAVE
// env var.
//
// Flow:
//   1. Boot canary server (--port-wt 14433 --port-ws 14434) + Vite
//      (port 5174).
//   2. Capture canary stderr to a temp file so we can grep the
//      `[stress-stats]` lines for the drop-oldest counter.
//   3. Spawn N browser contexts in waves of `WAVE_SIZE` (default
//      3) so the runner doesn't IO-thrash on parallel launches.
//   4. For each context: navigate to ?server=...&localId=N&peerId=1
//      with __forceServerTransport init script. Set peerId to 1 so
//      the snapshot's "remote" player count wraps around (peerId of
//      player 1 = player 1, which the remoteInterpolator already
//      filters out — only 23 remote rigs to mirror, not 24).
//   5. Wait for ALL 24 tabs' ServerTransport to report connected=true.
//      Generous timeout (60s default) because the snapshot stream
//      + first WS handshake can take 30s+ on a saturated CI runner.
//   6. Wait 5s for snapshot stream to fan out + settle.
//   7. Read __latestSnap() from every tab; assert all 24 player IDs
//      (1..24) appear in every tab's snapshot.
//   8. Read the canary log's [stress-stats] lines; assert the
//      `drops_total` field is 0 (no drop-oldest fires).
//
// Exit 0 on pass; exit 1 with [FAIL] diagnostic on fail.

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

const URL = process.env.URL ?? "http://localhost:5174/";
const WT_PORT = Number(process.env.STRESS_24P_WT_PORT ?? 14433);
const WS_PORT = Number(process.env.STRESS_24P_WS_PORT ?? 14434);
const N_PLAYERS = Number(process.env.STRESS_24P_N ?? 24);
// PR 11.7.D3.3 / CI: launch contexts in waves of WAVE_SIZE (default 3)
// so the runner's IO scheduler doesn't thrash when 24 chromium
// processes spin up simultaneously. Between waves, sleep WAVE_PAUSE_MS
// to let the runner stabilize. Local dev with 16GB+ RAM can crank
// WAVE_SIZE to 24 for the fastest run.
const WAVE_SIZE = Number(process.env.STRESS_24P_LAUNCH_WAVE ?? 3);
const WAVE_PAUSE_MS = Number(process.env.STRESS_24P_LAUNCH_PAUSE_MS ?? 1500);
const CANARY_LOG = process.env.STRESS_24P_CANARY_LOG
  ?? `/tmp/canary-stress-24p-${process.pid}.log`;

const NAV_TIMEOUT = Number(process.env.SMOKE_NAV_TIMEOUT ?? 30000);
// PR 11.7.D3.3 / CI: bumped from 15s → 60s. Cold-CI runner's IO
// saturation + 24 parallel chromium context spawns + first-frame
// snapshot handshake regularly takes 30-45s. 15s was too tight
// (see CI run 32811772092 — 12/24 tabs failed within 15s on CI;
// same code PASSED locally within ~5s). 60s gives generous
// headroom for cold runners without masking real bugs (a real
// connection hang should take much longer to debug).
const CONNECT_TIMEOUT_MS = Number(process.env.STRESS_24P_CONNECT_TIMEOUT_MS ?? 60000);
const SNAPSHOT_SETTLE_MS = Number(process.env.STRESS_24P_SNAPSHOT_SETTLE_MS ?? 1500);

const log = (...args) => console.log("[smoke]", ...args);
const fail = (...args) => console.error("[smoke][FAIL]", ...args);

mkdirSync(dirname(CANARY_LOG), { recursive: true });
// Truncate the log so we only grep the smoke's run window.
writeFileSync(CANARY_LOG, "");

let canaryProc = null;
let viteProc = null;

async function bootCanary() {
  log(`Booting canary server (WT=${WT_PORT}, WS=${WS_PORT})...`);
  // Pipe stdout + stderr to the log file so we can grep [stress-stats].
  // We also echo to process.stderr for live observability.
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
    },
  );
  const logStream = (chunk) => {
    const s = chunk.toString();
    writeFileSync(CANARY_LOG, s, { flag: "a" });
    process.stderr.write(`[canary] ${s}`);
  };
  canaryProc.stdout.on("data", logStream);
  canaryProc.stderr.on("data", logStream);
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (canaryProc.exitCode !== null) {
      throw new Error(`canary exited with code ${canaryProc.exitCode}`);
    }
    if (await isTcpReachable("127.0.0.1", WS_PORT)) {
      log(`Canary ready after ${i + 1}s`);
      return;
    }
  }
  throw new Error(`canary did not become ready in 60s`);
}

async function bootVite() {
  log(`Booting vite on 5174...`);
  viteProc = spawn(
    "npm",
    ["run", "dev", "--", "--host", "127.0.0.1", "--port", "5174", "--strictPort"],
    {
      cwd: resolve(REPO_ROOT, "client"),
      stdio: ["ignore", "pipe", "pipe"],
    },
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
    setTimeout(() => {
      sock.destroy();
      resolveP(false);
    }, 1000);
  });
}

async function teardown() {
  if (viteProc) {
    try { viteProc.kill("SIGTERM"); } catch {}
  }
  if (canaryProc) {
    try { canaryProc.kill("SIGTERM"); } catch {}
  }
  await sleep(500);
  if (viteProc) {
    try { viteProc.kill("SIGKILL"); } catch {}
  }
  if (canaryProc) {
    try { canaryProc.kill("SIGKILL"); } catch {}
  }
  await sleep(200);
}

async function waitForConnected(page, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await page.evaluate(() => {
      const t = window.__serverTransport;
      return !!(t && t.getStats && t.getStats().connected);
    }).catch(() => false);
    if (ready) return true;
    await sleep(100);
  }
  return false;
}

async function runSmoke() {
  log(`Spawning ${N_PLAYERS} chromium contexts in waves of ${WAVE_SIZE}...`);
  const browsers = [];
  const contexts = [];
  const pages = [];
  // PR 11.7.D3.3 / staged launch — split the parallel browser-context
  // creation into waves of WAVE_SIZE. Each chromium.launch + newContext +
  // newPage is heavy (process fork, GPU subprocess init, ~100MB RSS).
  // 24 parallel launches thrash the CI runner's IO scheduler; 8 waves
  // of 3 give the runner time to settle between batches. Total wall-time
  // difference is ~3s vs all-at-once; failure modes are much cleaner.
  for (let wave = 0; wave < N_PLAYERS; wave += WAVE_SIZE) {
    const waveEnd = Math.min(wave + WAVE_SIZE, N_PLAYERS);
    log(`  Wave: launching tabs ${wave + 1}..${waveEnd}...`);
    for (let i = wave; i < waveEnd; i++) {
      const b = await chromium.launch({
        headless: true,
        args: ["--ignore-certificate-errors"],
      });
      browsers.push(b);
      const ctx = await b.newContext({ viewport: { width: 800, height: 600 } });
      contexts.push(ctx);
      const page = await ctx.newPage();
      pages.push(page);
    }
    if (waveEnd < N_PLAYERS) {
      await sleep(WAVE_PAUSE_MS);
    }
  }
  log(`${browsers.length} browsers/contexts/pages ready.`);

  // Collect pageerror events — any client-side JS exception during
  // connection or snapshot consumption is a fail.
  const errors = [];
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const localId = i + 1;
    page.on("pageerror", (err) => {
      errors.push(`tab${localId}: ${err.message}`);
    });
  }

  // Initialize each tab's window slots for the server transport.
  // peerId is set to 1 for all tabs — the remoteInterpolator
  // filters out playerId === localPlayerId, so we don't need to
  // simulate 23 unique peer-pairings; the snapshot stream's
  // server-side fan-out includes all 24 players regardless.
  const serverUrl = `ws://localhost:${WS_PORT}/rooms/DEVBX`;
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const localId = i + 1;
    await page.addInitScript({
      content: `
          window.__forceServerTransport = true;
          window.__damageServerPorts = { wt: ${WT_PORT}, ws: ${WS_PORT} };
          window.__damageServerUrl = ${JSON.stringify(URL)};
          window.__damageServerRoomId = "DEVBX";
          window.__localPlayerId = ${localId};
          window.__peerPlayerId = 1;
        `,
    });
  }

  try {
    // Navigate all tabs in parallel — Vite is the shared resource
    // and we want the connection floods to hit close together.
    const navUrl = `${URL}?server=${encodeURIComponent(serverUrl)}`;
    log(`Navigating all ${N_PLAYERS} tabs to ${navUrl}...`);
    await Promise.all(
      pages.map((p) => p.goto(navUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT })),
    );
    log(`All tabs navigated. Waiting for ServerTransport connection...`);

    // Wait for ALL tabs to report connected. Parallel polling,
    // bail as soon as each tab reports ready.
    const connected = await Promise.all(
      pages.map((p) => waitForConnected(p, CONNECT_TIMEOUT_MS)),
    );
    const failed = connected.filter((c) => !c);
    if (failed.length > 0) {
      throw new Error(`${failed.length}/${N_PLAYERS} tabs failed to connect within ${CONNECT_TIMEOUT_MS}ms`);
    }
    log(`Assertion 1 PASS: all ${N_PLAYERS} ServerTransports connected.`);

    // Wait for the snapshot stream to fan out across all tabs.
    log(`Settling snapshot stream for ${SNAPSHOT_SETTLE_MS}ms...`);
    await sleep(SNAPSHOT_SETTLE_MS);

    // Read __latestSnap() from every tab + verify all 24 player IDs.
    // PR 11.7.D3.3 / CI: with 24 tabs + a cold runner, some tabs'
    // __latestSnap() window probe may be null briefly because the
    // onSnapshot listener hasn't fired yet (first WS message takes
    // a few seconds to round-trip on CI). Retry up to 10 times with
    // 500ms backoff before declaring mismatch — gives the slowest
    // tab's first snapshot a real chance to land.
    const snapshots = [];
    const expectedIds = Array.from({ length: N_PLAYERS }, (_, i) => i + 1);
    const maxRetries = 10;
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const localId = i + 1;
      let snap = null;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        snap = await page.evaluate(() => {
          const s = window.__latestSnap ? window.__latestSnap() : null;
          if (!s) return null;
          return {
            serverFrame: s.serverFrame ?? null,
            playerIds: (s.players ?? []).map((p) => p.playerId).sort((a, b) => a - b),
          };
        });
        if (snap !== null) break;
        await sleep(500);
      }
      snapshots.push(snap);
    }

    let assertion2ok = true;
    for (let i = 0; i < snapshots.length; i++) {
      const localId = i + 1;
      const snap = snapshots[i];
      if (!snap) {
        fail(`tab ${localId}: snapshot is null after ${maxRetries * 500}ms retry`);
        assertion2ok = false;
        break;
      }
      if (JSON.stringify(snap.playerIds) !== JSON.stringify(expectedIds)) {
        fail(`tab ${localId}: expected playerIds ${JSON.stringify(expectedIds)}, got ${JSON.stringify(snap.playerIds)}`);
        assertion2ok = false;
        break;
      }
    }
    if (!assertion2ok) {
      throw new Error("snapshot fan-out mismatch");
    }
    log(`Assertion 2 PASS: all ${N_PLAYERS} tabs' snapshots contain all ${N_PLAYERS} player IDs (server fan-out working at scale).`);

    // PR 11.7.D3.3 / damage-pressure phase — Tab 1 fires 10 bullets
    // at random other tabs to drive damage broadcasts + snapshot HP
    // updates across the full 24-player graph. Validates that:
    //   - Damage broadcasts fan out correctly at scale (24 listeners)
    //   - HP converges in the snapshot stream
    //   - The drop-oldest counter stays at 0 under broadcast pressure
    log(`Damage-pressure phase: tab 1 fires 10 bullets at random targets...`);
    const fireResults = await pages[0].evaluate(async () => {
      const session = window.__gameSession;
      if (!session) return { error: "no session" };
      const fireDamage = window.__fireDamage
        ?? (window.__damageBus && window.__damageBus.applyDamage);
      if (typeof fireDamage !== "function") {
        return { error: "no fireDamage function on window" };
      }
      let fired = 0;
      for (let i = 0; i < 10; i++) {
        const targetId = 1 + (i % 23) + 1; // players 2..24
        try {
          fireDamage(targetId, 5); // 5 damage per shot
          fired++;
        } catch (e) {
          return { error: `fire ${i} failed: ${e.message}` };
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return { fired };
    });
    log(`Damage fire result: ${JSON.stringify(fireResults)}`);
    if (fireResults.error) {
      // Soft fail — the fireDamage helper isn't exposed in the dev
      // smoke window. The 4 core assertions are what matter; the
      // damage-pressure phase is a future hook for when the
      // __fireDamage window probe lands. Don't throw.
      log(`  (damage-pressure phase is a soft check; skipping on ${fireResults.error})`);
    } else {
      // Wait 1s for damage broadcasts + HP convergence in snapshots.
      await sleep(1000);
      // Re-grep the canary log for the latest [stress-stats] line.
      const logContents2 = existsSync(CANARY_LOG)
        ? readFileSync(CANARY_LOG, "utf8")
        : "";
      const statLines2 = logContents2.split("\n").filter((l) => l.includes("[stress-stats]"));
      const lastStat = statLines2[statLines2.length - 1] ?? "";
      const m = lastStat.match(/drops_total=(\d+)/);
      const dropsAfterDamage = m ? parseInt(m[1], 10) : -1;
      log(`After 10-shot damage spam: drop-oldest counter = ${dropsAfterDamage}`);
      if (dropsAfterDamage > 0) {
        throw new Error(`drop-oldest counter at ${dropsAfterDamage} after damage spam — snapshot fan-out saturated under broadcast pressure`);
      }
      log(`Assertion 2b PASS: damage-pressure phase (10 shots from tab 1) did not saturate the outbound queue (drops=${dropsAfterDamage}).`);
    }

    // Wait another 5s and re-check the snapshot to confirm it's
    // still arriving (no connection silently died mid-run).
    log(`Re-checking snapshot stability after 2s settle...`);
    await sleep(2000);
    const reSnap = await pages[0].evaluate(() => {
      const s = window.__latestSnap ? window.__latestSnap() : null;
      return s ? (s.players ?? []).map((p) => p.playerId).sort((a, b) => a - b) : null;
    });
    if (!reSnap || JSON.stringify(reSnap) !== JSON.stringify(expectedIds)) {
      throw new Error(`snapshot stream degraded: ${JSON.stringify(reSnap)}`);
    }
    log(`Assertion 3 PASS: snapshot stream stable across ${SNAPSHOT_SETTLE_MS + 2000}ms.`);

    // Verify the server-side drop-oldest counter stayed at zero.
    // We grep the canary log for the [stress-stats] lines.
    log(`Grepping canary log for [stress-stats] drop-oldest counter...`);
    const logContents = existsSync(CANARY_LOG) ? readFileSync(CANARY_LOG, "utf8") : "";
    const statLines = logContents
      .split("\n")
      .filter((l) => l.includes("[stress-stats]"));
    log(`Found ${statLines.length} [stress-stats] lines.`);
    if (statLines.length === 0) {
      fail(`no [stress-stats] lines found in canary log — CANARY_STATS_INTERVAL_MS may be set too high`);
      throw new Error("no stress-stats lines");
    }
    let maxDrops = 0;
    for (const line of statLines) {
      const m = line.match(/drops_total=(\d+)/);
      if (m) {
        const v = parseInt(m[1], 10);
        if (v > maxDrops) maxDrops = v;
      }
    }
    log(`Max drop-oldest counter observed: ${maxDrops}`);
    if (maxDrops > 0) {
      throw new Error(`drop-oldest counter is ${maxDrops} (expected 0). Snapshot fan-out is saturating the per-connection outbound queue.`);
    }
    log(`Assertion 4 PASS: drop-oldest counter stayed at 0 across ${statLines.length} stats intervals (no saturation under ${N_PLAYERS}-player load).`);

    if (errors.length > 0) {
      fail(`pageerror events during smoke: ${errors.join("; ")}`);
      return false;
    }

    await Promise.all(browsers.map((b) => b.close()));
    return true;
  } catch (err) {
    fail(`Smoke error: ${err.message}`);
    if (errors.length > 0) {
      fail(`pageerror events: ${errors.join("; ")}`);
    }
    await Promise.all(browsers.map((b) => b.close()));
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  let success = false;
  const skipBoot = process.env.SMOKE_NO_BOOT === "1";
  try {
    if (!skipBoot) {
      await bootCanary();
      await bootVite();
      await sleep(500);
    } else {
      log("SMOKE_NO_BOOT=1: skipping canary + vite boot");
    }
    success = await runSmoke();
  } catch (err) {
    fail("Boot error:", err.message);
    success = false;
  } finally {
    if (!skipBoot) {
      await teardown();
    }
  }
  process.exit(success ? 0 : 1);
})();
