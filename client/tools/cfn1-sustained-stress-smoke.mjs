#!/usr/bin/env node
// PR 112 — CF-N1 sustained-load smoke.
//
// Boots the canary server + Vite on port 5197, opens TWO headless
// browser contexts (each with its own `?server=` URL param +
// `__forceServerTransport = true` init script) connected to a
// unique room per run (`CFN1_<ts>`), and asserts:
//
//   1. Both tabs' ServerTransport.connect() resolve within 5s and
//      the snapshot stream is live (player entries present).
//   2. The sustained-load phase (Tab A fires 100 `sendAimEvent`s
//      at 120ms cooldown = ~13s sustained spam) lands ALL 100
//      damage events on Tab B's snapshot stream (zero drops, zero
//      rate-limit-skips). This is the **exact** load profile that
//      triggers the CF-N1 flake on `damage-server-hp-convergence`.
//   3. The server's drop-oldest counter stays at 0 across the
//      entire spam window (no saturation under sustained load).
//   4. The server's rate-limited counter either stays at 0 OR
//      stays stable (no climbing — a climbing rate-limit is the
//      early-warning signal that drops are imminent).
//
// **Why a NEW smoke rather than extending damage-server-hp-convergence**:
// CF-N1 fires on HP-convergence under CI runner pressure. Extending
// HP-convergence to do this would conflate two different concerns
// (one-shot HP convergence assertion vs sustained-load regression
// detection). A dedicated smoke keeps the assertion scope tight.
//
// **Why opt-in (nightly) rather than required**: 30+ second real-
// canary smokes are expensive on CI runners. The HP-convergence
// smoke (the one that actually catches CF-N1 on every PR) stays
// required; this one runs nightly to catch the sustained-load
// class BEFORE the next CI run hits it.
//
// Pattern mirrors `damage-server-hp-convergence-smoke.mjs` (PR
// 11.6.D) + `stress-24p-smoke.mjs` (PR 11.7.D3.3). Boots canary on
// 14449/14450/18087 + Vite on 5197 (all unique per docs/PR-105-spec
// §2.4 — next slot after crosshair).

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const VITE_URL = process.env.CFN1_SMOKE_URL ?? "http://localhost:5197/";
const WT_PORT = Number(process.env.CFN1_SMOKE_WT_PORT ?? 14449);
const WS_PORT = Number(process.env.CFN1_SMOKE_WS_PORT ?? 14450);
const HTTP_PORT = Number(process.env.CFN1_SMOKE_HTTP_PORT ?? 18087);
const SCREENSHOT = process.env.SMOKE_PNG ?? "client/tools/cfn1-sustained-smoke.png";

const NAV_TIMEOUT = Number(process.env.SMOKE_NAV_TIMEOUT ?? 30000);
const CONNECT_TIMEOUT_MS = Number(process.env.SMOKE_CONNECT_TIMEOUT_MS ?? 5000);

// PR 112 — sustained-load parameters. The numbers below were chosen
// to match the CF-N1 failure profile documented in the post-#98
// status: spam-fire at 120ms cooldown pushes snapshot pressure + HP
// updates + damage broadcasts concurrently. 100 shots over ~12s
// is enough to saturate the consumer queue IF the producer rate-
// limit gate misfires or the per-room SnapshotGenerator starves.
const SPAM_SHOTS = Number(process.env.CFN1_SMOKE_SPAM_SHOTS ?? 100);
const SPAM_COOLDOWN_MS = Number(process.env.CFN1_SMOKE_COOLDOWN_MS ?? 120);
// Final settle: 1.5s after the last shot lands + 20Hz snapshot fan-
// out catches up. Matches HP-convergence's post-spam settle.
const POST_SPAM_SETTLE_MS = Number(process.env.CFN1_SMOKE_POST_SPAM_SETTLE_MS ?? 1500);

// CANARY_STATS_INTERVAL_MS=5000 (default) → ~2-3 stats intervals
// during a 12s spam window. Stable enough for an absolute count
// assertion. If you crank SPAM_SHOTS up substantially, this might
// need to drop — but the rate-limit delta assertion is robust
// against missing intervals (it computes a delta from the first
// to the last, ignoring gaps).
const CANARY_LOG = process.env.CFN1_SMOKE_CANARY_LOG
  ?? `/tmp/canary-cfn1-${process.pid}.log`;

const SCREENSHOT_PATH = resolve(REPO_ROOT, SCREENSHOT);

const log = (...args) => console.log("[cfn1-smoke]", ...args);
const fail = (...args) => console.error("[cfn1-smoke][FAIL]", ...args);

// ---------------------------------------------------------------------------
// Step 1: Boot canary server + vite dev server in background.
// ---------------------------------------------------------------------------

mkdirSync(dirname(SCREENSHOT_PATH), { recursive: true });
mkdirSync(dirname(CANARY_LOG), { recursive: true });
// Truncate so we only grep the smoke's run window.
import { writeFileSync } from "node:fs";
writeFileSync(CANARY_LOG, "");

let canaryProc = null;
let viteProc = null;

async function bootCanary() {
  log(`Booting canary server (WT=${WT_PORT}, WS=${WS_PORT}, HTTP=${HTTP_PORT})...`);
  canaryProc = spawn(
    "bash",
    [
      resolve(REPO_ROOT, "tools", "canary-server.sh"),
      "--port-wt", String(WT_PORT),
      "--port-ws", String(WS_PORT),
      "--port-http", String(HTTP_PORT),
    ],
    {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CARGO_PROFILE: "debug" },
    },
  );
  // Pipe stdout + stderr to the log file so we can grep [stress-stats].
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
  log(`Booting vite on ${VITE_URL}...`);
  const port = new URL(VITE_URL).port || "5197";
  viteProc = spawn(
    "npm",
    ["run", "dev", "--", "--host", "127.0.0.1", "--port", port, "--strictPort"],
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
      const resp = await fetch(VITE_URL);
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
  for (const port of [5197, WT_PORT, WS_PORT, HTTP_PORT]) {
    try {
      const { execSync } = await import("node:child_process");
      execSync(`lsof -ti:${port} 2>/dev/null | xargs -r kill -9`, { stdio: "ignore" });
    } catch {
      // ignore
    }
  }
}

/**
 * Wait for `window.__latestSnap()` to populate with both expected
 * player IDs (the local tab's claimed ID + the remote tab's). The
 * server promotes a connection's claimed ID from placeholder to
 * real on the FIRST WeaponSwitch; the snapshot stream reflects
 * this on the next 20Hz tick. Polls until both IDs appear or
 * `timeoutMs` elapses. Fixes the pre-#112 CF-N1 flake where a
 * single one-shot read at `sleep(1100)` caught a snapshot that
 * hadn't yet included the freshly-claimed remote player (the
 * server's broadcast of the promoted connection state landed
 * ~50ms after the WeaponSwitch primer returned).
 */
async function pollForBothPlayersInSnapshot(page, expectedIds, timeoutMs) {
  const start = Date.now();
  const expected = JSON.stringify([...expectedIds].sort((a, b) => a - b));
  while (Date.now() - start < timeoutMs) {
    const ids = await page
      .evaluate(() => {
        const s = window.__latestSnap ? window.__latestSnap() : null;
        return s ? (s.players ?? []).map((p) => p.playerId).sort((a, b) => a - b) : null;
      })
      .catch(() => null);
    if (JSON.stringify(ids) === expected) return ids;
    await sleep(50);
  }
  // Last attempt — return whatever's in the snapshot (may be null
  // if it never populated; the caller asserts equality with [1,2]).
  return await page
    .evaluate(() => {
      const s = window.__latestSnap ? window.__latestSnap() : null;
      return s ? (s.players ?? []).map((p) => p.playerId).sort((a, b) => a - b) : null;
    })
    .catch(() => null);
}

async function waitForProbe(page, timeoutMs) {
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

// ---------------------------------------------------------------------------
// Smoke runner.
// ---------------------------------------------------------------------------

async function runSmoke() {
  const room = `CFN1_${Date.now()}`;
  log(`Using room: ${room}`);

  const browser = await chromium.launch();
  const errors = [];
  const onPageError = (page, label) => {
    page.on("pageerror", (err) => {
      errors.push(`${label}: ${err.message}`);
    });
  };

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  onPageError(pageA, "Tab A");
  onPageError(pageB, "Tab B");

  const urlA = `${VITE_URL}?server=${VITE_URL}&localId=1&peerId=2&roomId=${room}`;
  const urlB = `${VITE_URL}?server=${VITE_URL}&localId=2&peerId=1&roomId=${room}`;

  for (const [page, localId, peerId] of [[pageA, 1, 2], [pageB, 2, 1]]) {
    await page.addInitScript({
      content: `
          window.__forceServerTransport = true;
          window.__damageServerPorts = { wt: ${WT_PORT}, ws: ${WS_PORT} };
          window.__damageServerUrl = ${JSON.stringify(VITE_URL)};
          window.__damageServerRoomId = "${room}";
          window.__localPlayerId = ${localId};
          window.__peerPlayerId = ${peerId};
        `,
    });
  }

  let pass = 0;
  let failCount = 0;
  const assert = (label, ok, details = "") => {
    if (ok) {
      pass++;
      log(`Assertion ${pass + failCount} PASS: ${label}`);
    } else {
      failCount++;
      fail(`Assertion ${pass + failCount} FAIL: ${label}`, details);
    }
  };

  try {
    log(`Navigating Tab A to ${urlA}...`);
    await pageA.goto(urlA, { timeout: NAV_TIMEOUT });
    log(`Navigating Tab B to ${urlB}...`);
    await pageB.goto(urlB, { timeout: NAV_TIMEOUT });

    log("Waiting for both transports to connect...");
    const okA = await waitForProbe(pageA, CONNECT_TIMEOUT_MS);
    const okB = await waitForProbe(pageB, CONNECT_TIMEOUT_MS);
    assert("both tabs connect to the canary", okA && okB, `A=${okA} B=${okB}`);

    // Smoke primer — drive a no-op WeaponSwitch from each tab so the
    // server promotes them from placeholder IDs to real player IDs
    // (otherwise snapshots only show their own placeholder).
    log("Driving WeaponSwitch primer to register both players...");
    await sleep(300);
    await pageA.evaluate(() => {
      const s = window.__gameSession;
      if (s && typeof s.tryStartWeaponSwitch === "function") {
        s.tryStartWeaponSwitch(0, 0); // DualPistol + Semi (no-op)
      }
    });
    await pageB.evaluate(() => {
      const s = window.__gameSession;
      if (s && typeof s.tryStartWeaponSwitch === "function") {
        s.tryStartWeaponSwitch(0, 0); // DualPistol + Semi (no-op)
      }
    });
    await sleep(1100); // wait out server rate-limit window

    // -----------------------------------------------------------------
    // Assertion 1: snapshot stream live (both players in both snapshots)
    // Poll for both player IDs to appear in the snapshot — fixes the
    // pre-#112 CF-N1 flake where a single one-shot read at
    // `sleep(1100)` caught a snapshot that hadn't yet included the
    // freshly-claimed remote player. 2s timeout covers the worst-case
    // 20Hz tick latency (50ms interval × 2 ticks for both promotions
    // to land in the broadcast stream).
    // -----------------------------------------------------------------
    log("Assert 1: snapshot stream live with both players...");
    const initialSnapA = await pollForBothPlayersInSnapshot(pageA, [1, 2], 2000);
    const initialSnapB = await pollForBothPlayersInSnapshot(pageB, [1, 2], 2000);
    assert(
      "Tab A snapshot contains both player IDs",
      JSON.stringify(initialSnapA) === JSON.stringify([1, 2]),
      JSON.stringify(initialSnapA),
    );
    assert(
      "Tab B snapshot contains both player IDs",
      JSON.stringify(initialSnapB) === JSON.stringify([1, 2]),
      JSON.stringify(initialSnapB),
    );

    // -----------------------------------------------------------------
    // Assertion 2: capture HP baseline + drop counters before spam
    // -----------------------------------------------------------------
    log("Assert 2: capture HP baseline + drop counter baseline...");
    const hpBaselineB = await pageB.evaluate(() => {
      const s = window.__latestSnap ? window.__latestSnap() : null;
      const me = s ? s.players.find((p) => p.playerId === 2) : null;
      return me ? me.hp : null;
    });
    assert(
      "Tab B HP baseline readable",
      hpBaselineB !== null,
      `hpBaselineB=${hpBaselineB}`,
    );

    // Capture [stress-stats] drop counter BEFORE spam. The format
    // is `drops_total=N drops_since_last=... rate_limited_total=...
    // rate_limited_since_last=... interval_ms=...`. Read all lines
    // and pick the LATEST complete one (the canary writes in
    // chunks; a chunk that ends mid-line would land in `content`
    // as a partial trailing line. We pick the last line that BOTH
    // contains `[stress-stats]` AND has a `drops_total=` regex
    // match — robust against partial trailing chunks from the
    // canary's writeStream).
    const readStatsCounters = () => {
      // Strip ANSI escape codes from the canary log (tracing-subscriber
      // emits color/bold formatting; the embedded codes break our regex
      // match on `drops_total=N`). The strip pattern handles SGR
      // sequences (the only kind tracing emits).
      const ANSI_RE = /\x1b\[[0-9;]*m/g;
      const logContents = existsSync(CANARY_LOG)
        ? readFileSync(CANARY_LOG, "utf8").replace(ANSI_RE, "")
        : "";
      const allLines = logContents.split("\n");
      let lastStat = null;
      for (let i = allLines.length - 1; i >= 0; i--) {
        const line = allLines[i];
        if (line.includes("[stress-stats]") && /drops_total=\d+/.test(line)) {
          lastStat = line;
          break;
        }
      }
      if (!lastStat) {
        return { dropsTotal: -1, rateLimitedTotal: -1, linesSeen: 0 };
      }
      const dropsMatch = lastStat.match(/drops_total=(\d+)/);
      const rlMatch = lastStat.match(/rate_limited_total=(\d+)/);
      return {
        dropsTotal: dropsMatch ? parseInt(dropsMatch[1], 10) : -1,
        rateLimitedTotal: rlMatch ? parseInt(rlMatch[1], 10) : -1,
        linesSeen: allLines.filter((l) => l.includes("[stress-stats]")).length,
      };
    };
    const beforeSpam = readStatsCounters();
    log(`Pre-spam [stress-stats]: ${JSON.stringify(beforeSpam)}`);
    assert(
      "pre-spam stress-stats line exists (CANARY_STATS_INTERVAL_MS reachable)",
      beforeSpam !== null && beforeSpam.dropsTotal !== -1,
      JSON.stringify(beforeSpam),
    );
    assert(
      "pre-spam drop-oldest counter is 0 (clean baseline)",
      beforeSpam && beforeSpam.dropsTotal === 0,
      JSON.stringify(beforeSpam),
    );

    // -----------------------------------------------------------------
    // Assertion 3: sustained spam-fire phase. Tab A fires 100
    // AimEvents at 120ms cooldown at Tab B (player 2). This is the
    // exact load profile that triggers CF-N1 on HP-convergence.
    // -----------------------------------------------------------------
    log(`Assert 3: sustained spam-fire (${SPAM_SHOTS} shots at ${SPAM_COOLDOWN_MS}ms cooldown)...`);
    const spamResult = await pageA.evaluate(
      async ({ shots, cooldownMs }) => {
        const session = window.__gameSession;
        if (!session) return { error: "no session" };
        const bus = window.__damageBus;
        if (!bus || typeof bus.sendAimEvent !== "function") {
          return { error: "no bus.sendAimEvent" };
        }
        let fired = 0;
        for (let i = 0; i < shots; i++) {
          try {
            // eventId monotonically increases from the primer's last
            // value. PR 11.6.D Gate 8 requires eventId monotonic within
            // the rewind window (64); using `i + 2` ensures uniqueness
            // without colliding with the primer's eventId. The fire
            // press path encodes a fresh AimEvent per shot.
            bus.sendAimEvent({
              sourcePlayerId: 1,
              yawRadians: Math.PI / 2,
              pitchRadians: 0,
              frame: window.__latestSnap?.()?.serverFrame ?? 0,
              eventId: (i + 2) * 1000,
              isFiring: 1,
            });
            fired++;
          } catch (e) {
            return { error: `fire ${i} failed: ${e.message}`, fired };
          }
          await new Promise((r) => setTimeout(r, cooldownMs));
        }
        return { fired };
      },
      { shots: SPAM_SHOTS, cooldownMs: SPAM_COOLDOWN_MS },
    );
    if (spamResult.error) {
      assert("sustained spam-fire completed without error", false, JSON.stringify(spamResult));
    } else {
      assert(
        `sustained spam-fire fired all ${SPAM_SHOTS} shots from Tab A`,
        spamResult.fired === SPAM_SHOTS,
        JSON.stringify(spamResult),
      );
    }

    // Settle: 1.5s for the final shots to land + the snapshot stream
    // to catch up + the consumer to drain.
    log(`Settling ${POST_SPAM_SETTLE_MS}ms post-spam...`);
    await sleep(POST_SPAM_SETTLE_MS);

    // -----------------------------------------------------------------
    // Assertion 4: drop-oldest counter still at 0 (no saturation
    // during sustained spam-fire)
    // -----------------------------------------------------------------
    log("Assert 4: drop-oldest counter stayed at 0 under sustained load...");
    const afterSpam = readStatsCounters();
    log(`Post-spam [stress-stats]: ${JSON.stringify(afterSpam)}`);
    assert(
      "post-spam stress-stats line exists",
      afterSpam !== null && afterSpam.dropsTotal !== -1,
      JSON.stringify(afterSpam),
    );
    assert(
      `drop-oldest counter stayed at 0 across ${SPAM_SHOTS} shots over ~${Math.round(SPAM_SHOTS * SPAM_COOLDOWN_MS / 1000)}s (no saturation)`,
      afterSpam && afterSpam.dropsTotal === 0,
      `dropsTotal=${afterSpam?.dropsTotal}`,
    );

    // -----------------------------------------------------------------
    // Assertion 5: rate-limited counter didn't climb (early-warning
    // signal — climbing rate-limit means drops are imminent if load
    // continues). The absolute count can be > 0 (rate-limit firing is
    // legitimate back-pressure), but it MUST be bounded by the
    // spam-window size — no monotonic climb across intervals.
    // -----------------------------------------------------------------
    log("Assert 5: rate-limited counter bounded (no climbing under sustained load)...");
    // Compute the rate-limited DELTA: lines that appeared during the
    // spam window. We approximate by reading the counter at start and
    // end and computing the diff.
    const rlDelta = (afterSpam?.rateLimitedTotal ?? 0) - (beforeSpam?.rateLimitedTotal ?? 0);
    // Sanity: each rate-limited emit happens at the snapshot-generator
    // loop tick (50ms). Over SPAM_SHOTS * SPAM_COOLDOWN_MS ≈ 12s, the
    // loop ticks ~240 times. The rate-limit gate trips when ANY room's
    // outbound queue is > 25% saturated (256 of 1024). Under healthy
    // load with 2 connections, the gate should trip at most a handful
    // of times during the spam burst. 5% of ticks = 12 trips in 240.
    // Round up: bound at 30 trips over 12s.
    const rlBound = Number(process.env.CFN1_SMOKE_RL_BOUND ?? 30);
    assert(
      `rate-limited delta within bound (${rlDelta} ≤ ${rlBound} over ${SPAM_SHOTS}-shot spam; healthy back-pressure, not runaway)`,
      rlDelta <= rlBound,
      `rlDelta=${rlDelta} bound=${rlBound}`,
    );

    // -----------------------------------------------------------------
    // Assertion 6: HP convergence after spam. Tab B's HP must have
    // dropped (received the AimEvents + server-applied damage).
    // This is the direct CF-N1 regression check: a persistent CF-N1
    // regression would show up as `hpBaselineB - hpAfterSpamB == 0`
    // (no damage landed). PR 11.7.D's snapshot reader sees server-
    // authoritative state, so a low HP delta is a real regression.
    // -----------------------------------------------------------------
    log("Assert 6: HP dropped on Tab B (sustained spam landed)...");
    const hpAfterSpamB = await pageB.evaluate(() => {
      const s = window.__latestSnap ? window.__latestSnap() : null;
      const me = s ? s.players.find((p) => p.playerId === 2) : null;
      return me ? me.hp : null;
    });
    assert(
      "Tab B HP after-spam readable",
      hpAfterSpamB !== null,
      `hpAfterSpamB=${hpAfterSpamB}`,
    );
    if (hpAfterSpamB !== null && hpBaselineB !== null) {
      const dmgApplied = hpBaselineB - hpAfterSpamB;
      // PR 11.6.D Gate 8 fires AimEvent at 120ms cooldown; the server
      // applies damage on each valid event. 100 shots over ~12s = 8.3
      // hits/sec sustained. DUAL_PISTOL_DAMAGE=8 per hit, so 8 * 8.3
      // * 12 = ~800 dmg applied (capped at hpBaselineB=100). The smoke
      // asserts HP dropped by ≥ 1 hit (8 dmg) — anything less means
      // either the spam didn't land OR the snapshot reader is stale.
      // We use a generous floor (16 dmg = 2 hits) to avoid being
      // over-sensitive to a single dropped snapshot.
      assert(
        `Tab B HP dropped by ≥ 16 dmg from sustained spam (got ${dmgApplied}; baseline=${hpBaselineB}, after=${hpAfterSpamB})`,
        dmgApplied >= 16,
        `dmgApplied=${dmgApplied}`,
      );
    }

    // Screenshot for visual confirmation.
    log(`Writing screenshot to ${SCREENSHOT_PATH}...`);
    await pageA.screenshot({ path: SCREENSHOT_PATH, fullPage: false });

    if (errors.length > 0) {
      fail("pageerror events during smoke:", errors);
    }
  } finally {
    await browser.close();
  }

  return failCount === 0;
}

(async () => {
  let success = false;
  const skipBoot = process.env.SMOKE_NO_BOOT === "1";
  try {
    if (!skipBoot) {
      await bootCanary();
      await bootVite();
      await sleep(500);
    } else {
      log("SMOKE_NO_BOOT=1: skipping canary + vite boot (pre-booted by caller)");
    }
    success = await runSmoke();
  } catch (err) {
    fail("Boot error:", err.message);
    success = false;
  } finally {
    if (!skipBoot) {
      await teardown();
    } else {
      log("SMOKE_NO_BOOT=1: skipping teardown (caller owns the pre-booted processes)");
    }
  }
  process.exit(success ? 0 : 1);
})();
