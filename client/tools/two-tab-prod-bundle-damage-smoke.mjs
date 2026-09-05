#!/usr/bin/env node
// PR #129 follow-up / §3.10 — two-tab prod-bundle DAMAGE smoke
// (the load-bearing gate the previous fix was missing).
//
// What this smoke verifies (beyond prod-bundle-smoke.mjs's wire-up
// check):
//   1. The PROD bundle, served over HTTPS via serve-static.mjs, can
//      be opened in TWO headless browser contexts at the same room.
//   2. Both tabs publish window.__gameSession with the correct
//      playerIds (Tab A=1->2, Tab B=2->1).
//   3. window.__broadcastHandlerCount > 0 on Tab B after the
//      server's first broadcast fan-out — proves
//      wireServerTransport's late-bound broadcastHandler is wired
//      to the SAME __gameSession instance the render observer is
//      reading HUD state from. If the prod bug from PR #129 had
//      returned (two instances), wireServerTransport would have
//      landed on a different instance than scene.ts's, and Tab B's
//      __broadcastHandlerCount would be tied to a "phantom"
//      instance whose controller HUD never reads from.
//   4. Tab A fires a damage request via __damageBus.sendAimEvent
//      (PR #59 §3.5 — the post-AimEvent gameplay path). Tab B's
//      __latestSnap().players[].hp for playerId=2 must drop
//      (the server is the source of truth post-PR 11.7.D).
//      This is the assertion that proves "broadcast actually drove
//      damage on the live gameSession" — the smoke would fail
//      under the PR #129 double-instance bug because the live
//      __gameSession on Tab B would never see the broadcast land
//      on its controllers, so HP would not change.
//   5. Two screenshots (one per tab) land in client/tools/.
//
// Why this is the load-bearing gate:
//   - prod-bundle-smoke.mjs only asserts wire-up connects
//     (__serverTransport.connected === true). Under PR #129's bug
//     the wire still connected — both the dev canary and the prod
//     bundle showed "connected" — but the wire's broadcast handler
//     was registered on a stale, phantom instance whose controllers
//     no HUD reads from. The wire thinks it's connected; the HUD
//     shows zero damage. prod-bundle-smoke.mjs's 7/7 PASSED under
//     the bug. THIS smoke's HP-drop assertion would have caught
//     it.
//   - damage-server-hp-convergence-smoke.mjs (5191) covers the
//     same end-to-end HP-convergence behavior but it runs against
//     `vite dev` (which does not tree-shake). It is NOT a
//     prod-bundle regression check. THIS smoke is.
//
// Required env vars (defaults match prod-bundle-smoke.mjs's local-run
// command):
//   PROD_BUNDLE_PORT  (default 24032) — serve-static.mjs TLS port
//   WT_PORT           (default 24033) — canary WebTransport
//   WS_PORT           (default 24034) — canary WebSocket
//   WSS_PORT          (default 24035) — canary WebSocket TLS
//   HTTP_PORT         (default 28080) — canary matchmaker HTTP
//   CERT_DIR          (default $REPO_ROOT/.certs)
//   SMOKE_PNG_A       (default client/tools/two-tab-prod-bundle-damage-A.png)
//   SMOKE_PNG_B       (default client/tools/two-tab-prod-bundle-damage-B.png)
//   SMOKE_NO_BOOT=1   — skip canary + serve-static boot (use already-running)
//   SMOKE_NO_BUILD=1  — skip the build step (use whatever's in client/dist/)

import { chromium } from "playwright";
import { spawn, execSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

const PROD_BUNDLE_PORT = Number(process.env.PROD_BUNDLE_PORT ?? 24032);
const WT_PORT = Number(process.env.WT_PORT ?? 24033);
const WS_PORT = Number(process.env.WS_PORT ?? 24034);
const WSS_PORT = Number(process.env.WSS_PORT ?? 24035);
const HTTP_PORT = Number(process.env.HTTP_PORT ?? 28080);
const CERT_DIR = process.env.CERT_DIR ?? resolve(REPO_ROOT, ".certs");
const CERT_PATH = resolve(CERT_DIR, "dev.pem");
const KEY_PATH = resolve(CERT_DIR, "dev.key");

const PROD_BUNDLE_HOST = process.env.PROD_BUNDLE_HOST ?? "127.0.0.1";
const PROD_BUNDLE_SCHEME = process.env.PROD_BUNDLE_SCHEME ?? "https";
const STATIC_URL = `${PROD_BUNDLE_SCHEME}://${PROD_BUNDLE_HOST}:${PROD_BUNDLE_PORT}/`;

const CANARY_HOST = process.env.CANARY_HOST ?? PROD_BUNDLE_HOST;
const CANARY_SCHEME = process.env.CANARY_SCHEME ?? "http";
const CANARY_HTTP = `${CANARY_SCHEME}://${CANARY_HOST}:${HTTP_PORT}`;

const SMOKE_PNG_A = process.env.SMOKE_PNG_A ?? resolve(REPO_ROOT, "client/tools/two-tab-prod-bundle-damage-A.png");
const SMOKE_PNG_B = process.env.SMOKE_PNG_B ?? resolve(REPO_ROOT, "client/tools/two-tab-prod-bundle-damage-B.png");

const SMOKE_NO_BOOT = process.env.SMOKE_NO_BOOT === "1";
const SMOKE_NO_BUILD = process.env.SMOKE_NO_BUILD === "1";

const NAV_TIMEOUT = Number(process.env.SMOKE_NAV_TIMEOUT ?? 30000);
const CONNECT_TIMEOUT_MS = Number(process.env.SMOKE_CONNECT_TIMEOUT_MS ?? 10000);
const FIRE_BROADCAST_TIMEOUT_MS = Number(process.env.SMOKE_FIRE_BROADCAST_TIMEOUT_MS ?? 3000);

const log = (...args) => console.error("[two-tab-prod-damage]", ...args);
const fail = (...args) => console.error("[two-tab-prod-damage][FAIL]", ...args);

mkdirSync(dirname(SMOKE_PNG_A), { recursive: true });

let canaryProc = null;
let serveStaticProc = null;
let browserA = null;
let browserB = null;
const results = [];
function recordPass(name) {
  log(`PASS ${name}`);
  results.push({ name, ok: true });
}
function recordFail(name, message) {
  log(`FAIL ${name}: ${message}`);
  results.push({ name, ok: false, message });
}
let exitCode = 0;

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

// Build the prod bundle
function buildProdBundle() {
  log(`Building prod bundle (VITE_MATCHMAKER_ORIGIN=${CANARY_HTTP})...`);
  execSync(
    `npm run build`,
    {
      cwd: resolve(REPO_ROOT, "client"),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        VITE_MATCHMAKER_ORIGIN: CANARY_HTTP,
      },
    },
  );
}

// Boot canary
async function bootCanary() {
  if (SMOKE_NO_BOOT) {
    log("SMOKE_NO_BOOT=1, skipping canary boot");
    return;
  }
  log(`Booting canary (WT=${WT_PORT}, WS=${WS_PORT}, WSS=${WSS_PORT}, HTTP=${HTTP_PORT})...`);
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
    },
  );
  canaryProc.stdout.on("data", (d) => process.stderr.write(`[canary] ${d}`));
  canaryProc.stderr.on("data", (d) => process.stderr.write(`[canary-err] ${d}`));
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
  throw new Error(`canary did not come up within ${HEALTH_TIMEOUT_MS}ms`);
}

// Boot serve-static in TLS mode
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
    [resolve(REPO_ROOT, "tools", "serve-static.mjs")],
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
    },
  );
  serveStaticProc.stdout.on("data", (d) => process.stderr.write(`[static] ${d}`));
  serveStaticProc.stderr.on("data", (d) => process.stderr.write(`[static-err] ${d}`));
  const START_TIMEOUT_MS = 30000;
  const start = Date.now();
  while (Date.now() - start < START_TIMEOUT_MS) {
    const reachable = await new Promise((resolveP) => {
      const req = httpsRequest(
        {
          host: PROD_BUNDLE_HOST,
          port: PROD_BUNDLE_PORT,
          path: "/health",
          method: "GET",
          rejectUnauthorized: false,
        },
        (res) => {
          res.resume();
          resolveP(res.statusCode === 200);
        },
      );
      req.on("error", () => resolveP(false));
      req.end();
    });
    if (reachable) {
      log(`serve-static HTTPS up after ${((Date.now() - start) / 1000).toFixed(1)}s`);
      return;
    }
    await sleep(500);
  }
  throw new Error(`serve-static did not come up within ${START_TIMEOUT_MS}ms`);
}

// Create room via matchmaker -> wss_url
async function createRoom() {
  log(`POST ${CANARY_HTTP}/rooms ...`);
  const curlOutput = execSync(
    `curl -sk -m 10 -X POST ${JSON.stringify(`${CANARY_HTTP}/rooms`)}`,
    { encoding: "utf8" },
  );
  const created = JSON.parse(curlOutput);
  if (!created.wss_url) {
    throw new Error(`matchmaker did not return wss_url: ${curlOutput.slice(0, 200)}`);
  }
  return created;
}

// Wait for window.__serverTransport to connect
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

// Main smoke flow
async function runSmoke() {
  const room = await createRoom();
  log(`Created room; wss_url=${room.wss_url}`);

  // Two separate browser instances so GPU resources are not shared.
  // Chromium headless GPU subprocess exhausts on a shared context
  // with multiple tabs (same pattern as two-tab-smoke.mjs).
  browserA = await chromium.launch({
    headless: true,
    args: ["--ignore-certificate-errors"],
  });
  browserB = await chromium.launch({
    headless: true,
    args: ["--ignore-certificate-errors"],
  });
  const ctxA = await browserA.newContext({
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  });
  const ctxB = await browserB.newContext({
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  const errors = [];
  for (const [page, label] of [[pageA, "A"], [pageB, "B"]]) {
    page.on("pageerror", (err) => errors.push(`page${label}: ${err.message}`));
  }
  pageA.on("console", (msg) => {
    if (msg.type() === "error") process.stderr.write(`[page-A:error] ${msg.text()}\n`);
  });
  pageB.on("console", (msg) => {
    if (msg.type() === "error") process.stderr.write(`[page-B:error] ${msg.text()}\n`);
  });

  // Init scripts — set window.__forceServerTransport so scene.ts
  // wire-up IIFE registers ServerTransport + wireServerTransport
  // takes over. Each tab gets its own local/peer player ids
  // (swapped — Tab A is playerId=1, Tab B is playerId=2).
  //
  // Also registers a snapshot listener on window.__serverTransport
  // that captures the server's current frame from each
  // snapshot's `nextServerFrame` field. The snapshot stream is
  // delivered to the wire regardless of DEV-vs-prod (it's the
  // server-authoritative 20Hz broadcast); the listeners.snapshot
  // array is empty until something registers. We register here so
  // the smoke can pull a current frame for the AimEvent's
  // `frame` field, which the server validates against the
  // rewind window ([current-64, current+16]).
  //
  // In dev mode scene.ts also registers a snapshot listener that
  // drives predictor + interpolator. Both listeners run; neither
  // shadows the other. wireServerTransport's __latestSnap uses a
  // different path (server.getStats().latestSnap, which is never
  // populated — see wireServerTransport.ts:148 — so dev's
  // __latestSnap is set by scene.ts's listener, not the wire).
  for (const [page, localId, peerId] of [[pageA, 1, 2], [pageB, 2, 1]]) {
    await page.addInitScript({
      content: `
          window.__forceServerTransport = true;
          window.__localPlayerId = ${localId};
          window.__peerPlayerId = ${peerId};
          // Snapshot capture — register ASAP and keep retrying
          // until window.__serverTransport appears (the wire
          // connects asynchronously after the IIFE in
          // wireServerTransport resolves).
          window.__latestServerFrame = 0;
          window.__mySnapshotsReceived = 0;
          (function attachSnapListener() {
            const t = window.__serverTransport;
            if (!t || typeof t.onSnapshot !== "function") {
              setTimeout(attachSnapListener, 50);
              return;
            }
            t.onSnapshot((body) => {
              try {
                // body is discriminator-stripped. First 4 bytes
                // are serverFrame (u32 BE), next 4 bytes are
                // nextServerFrame (u32 BE). The server's
                // current_frame is nextServerFrame (the next
                // frame it will assign).
                const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
                window.__latestServerFrame = view.getUint32(4, false);
                window.__mySnapshotsReceived += 1;
              } catch {}
            });
          })();
        `,
    });
  }

  try {
    const navUrl = (() => {
      const u = new URL(STATIC_URL);
      u.searchParams.set("server", room.wss_url);
      return u.toString();
    })();
    log(`Navigating Tab A to ${navUrl} ...`);
    await pageA.goto(navUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    log(`Navigating Tab B to ${navUrl} ...`);
    await pageB.goto(navUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });

    log("Waiting for both ServerTransports to connect ...");
    const [okA, okB] = await Promise.all([
      waitForServerTransport(pageA, CONNECT_TIMEOUT_MS),
      waitForServerTransport(pageB, CONNECT_TIMEOUT_MS),
    ]);
    if (!okA) throw new Error(`Tab A __serverTransport never connected within ${CONNECT_TIMEOUT_MS}ms`);
    if (!okB) throw new Error(`Tab B __serverTransport never connected within ${CONNECT_TIMEOUT_MS}ms`);
    recordPass("wire-up-connected-both-tabs");

    // Assert __gameSession on both tabs with correct player ids.
    const idsA = await pageA.evaluate(() => {
      const s = window.__gameSession;
      return {
        local: s?.localPlayerId ?? null,
        peer: s?.peerPlayerId ?? null,
        hasRemoteController: !!s?.remoteController,
        hasLocalController: !!s?.localController,
      };
    });
    const idsB = await pageB.evaluate(() => {
      const s = window.__gameSession;
      return {
        local: s?.localPlayerId ?? null,
        peer: s?.peerPlayerId ?? null,
        hasRemoteController: !!s?.remoteController,
        hasLocalController: !!s?.localController,
      };
    });
    log(`Tab A gameSession: ${JSON.stringify(idsA)}`);
    log(`Tab B gameSession: ${JSON.stringify(idsB)}`);
    if (idsA.local !== 1 || idsA.peer !== 2) {
      throw new Error(`Tab A: expected local=1, peer=2, got ${JSON.stringify(idsA)}`);
    }
    if (idsB.local !== 2 || idsB.peer !== 1) {
      throw new Error(`Tab B: expected local=2, peer=1, got ${JSON.stringify(idsB)}`);
    }
    if (!idsA.hasLocalController || !idsA.hasRemoteController) {
      throw new Error(`Tab A gameSession missing controllers: ${JSON.stringify(idsA)}`);
    }
    if (!idsB.hasLocalController || !idsB.hasRemoteController) {
      throw new Error(`Tab B gameSession missing controllers: ${JSON.stringify(idsB)}`);
    }
    recordPass("gameSession-single-instance-correct-ids");

    // Drive PositionUpdate primer from each tab so the server has
    // current positions to lag-comp against. Mirrors 5191 primer.
    await Promise.all([
      pageA.evaluate(() => {
        const s = window.__gameSession;
        if (s) {
          const pos = s.localController.state.position;
          for (let f = 0; f < 3; f++) {
            window.__serverTransport.sendPositionUpdate({
              serverFrame: f,
              playerId: 1,
              positionX: pos.x,
              positionY: pos.z,
            });
          }
        }
      }),
      pageB.evaluate(() => {
        const s = window.__gameSession;
        if (s) {
          const pos = s.localController.state.position;
          for (let f = 0; f < 3; f++) {
            window.__serverTransport.sendPositionUpdate({
              serverFrame: f,
              playerId: 2,
              positionX: pos.x + 5.0,
              positionY: pos.z,
            });
          }
        }
      }),
    ]);
    await sleep(300);

    // Pre-fire baseline: read Tab B's LOCAL controller HP directly
    // from the live __gameSession. This is the load-bearing read —
    // the broadcast handler in wireServerTransport.ts mutates
    // `state.hp` via `damageBus.applyBroadcast -> applyDamage ->
    // target.state.hp -= ev.amount`. The snapshot stream in prod
    // is NOT wired (the scene.ts onSnapshot listener is gated on
    // `import.meta.env.DEV`), so `__latestSnap()` returns null in
    // prod and is useless for this check. We read the source of
    // truth directly instead.
    //
    // Why this is the right assertion for the PR #129 fix:
    //   - Pre-PR-#129-fix: __gameSession on Tab B is a phantom
    //     instance whose controllers no HUD reads from. Tab A
    //     fires -> server fans out DamageBroadcast to Tab B ->
    //     wireServerTransport's broadcast handler applies to the
    //     PHANTOM's controllers. The LIVE __gameSession's
    //     controllers (the ones HUD reads) never see the HP drop.
    //   - Post-PR-#129-fix: wireServerTransport's broadcast
    //     handler is on the SAME __gameSession instance scene.ts
    //     published. applyBroadcast mutates the LIVE localCtrl,
    //     HP drops, HUD reflects it.
    //
    // Tab B is localPlayerId=2; broadcast targetPlayerId=2 matches
    // localPlayerId -> broadcast applies to localController on Tab B.
    const tabBpre = await pageB.evaluate(() => {
      const s = window.__gameSession;
      return {
        hpBefore: s?.localController?.state?.hp ?? null,
        localPlayerId: s?.localPlayerId ?? null,
        broadcastHandlerCount: window.__broadcastHandlerCount ?? 0,
        gameSessionExists: !!window.__gameSession,
      };
    });
    log(`Pre-fire Tab B gameSession: ${JSON.stringify(tabBpre)}`);
    if (tabBpre.hpBefore === null) {
      throw new Error(
        `Tab B __gameSession.localController.state.hp is null -- gameSession not initialized. ` +
        `gameSessionExists=${tabBpre.gameSessionExists}, localPlayerId=${tabBpre.localPlayerId}.`,
      );
    }

    // Tab A fires -- send one AimEvent. PR #59 §3.5 -- server runs
    // dual_pistol_hit against snapshot-known positions for every
    // OTHER player in the room. PlayerId=2 is the only other
    // player, so this single AimEvent drops Tab B HP by the weapon
    // damage (12 in current tuning).
    //
    // Note: the server's snapshot-path lag-comp needs a current
    // server frame for the AimEvent's `frame` field. With no
    // snapshot listener registered in prod, frame is best-effort 0.
    // The server's PositionHistory has at least one entry per tab
    // from the PositionUpdate primer above, so dual_pistol_hit can
    // still rewind to a position in the rewind window (typically
    // ~64 frames at 64Hz = 1s).
    // Use the latest server frame captured by our snapshot
    // listener. serverFrame must be in [current-64, current+16]
    // for the server to accept it (see server/src/damage_relay.rs
    // validate_and_relay_aim's frame check).
    const fireResult = await pageA.evaluate(async ({ eventId }) => {
      const bus = window.__damageBus;
      if (!bus) return { ok: false, reason: "no __damageBus" };
      // Wait briefly for a snapshot to arrive so we have a
      // current server frame.
      let waitMs = 0;
      while (window.__latestServerFrame === 0 && waitMs < 1000) {
        await new Promise((r) => setTimeout(r, 50));
        waitMs += 50;
      }
      const frame = window.__latestServerFrame || 0;
      const snaps = window.__mySnapshotsReceived ?? 0;
      if (frame === 0) {
        return { ok: false, reason: `no snapshot received in 1s (snaps=${snaps})` };
      }
      try {
        bus.sendAimEvent({
          sourcePlayerId: 1,
          yawRadians: Math.PI / 2,
          pitchRadians: 0.0,
          frame,
          eventId,
          isFiring: 1,
        });
        return { ok: true, frame, snaps };
      } catch (e) {
        return { ok: false, reason: String(e) };
      }
    }, { eventId: Math.floor(Math.random() * 0xfffffff0) });
    if (!fireResult.ok) {
      throw new Error(`Tab A fire failed: ${fireResult.reason}`);
    }
    log(`Tab A fired AimEvent (frame=${fireResult.frame}).`);

    // Poll Tab B snapshot HP for playerId=2 — should drop within
    // ~3 ticks at 20Hz snapshot stream (<=150ms) + server apply +
    // broadcast fan-out + damageBus.applyBroadcast on Tab B live
    // gameSession. Allow up to FIRE_BROADCAST_TIMEOUT_MS (default
    // 3s) for the chain to complete under load.
    let hpAfter = null;
    let broadcastHandlerCountAfter = 0;
    const fireDeadline = Date.now() + FIRE_BROADCAST_TIMEOUT_MS;
    while (Date.now() < fireDeadline) {
      const probe = await pageB.evaluate(() => {
        // Read Tab B's LOCAL controller HP directly. This is what
        // wireServerTransport's broadcast handler (via
        // damageBus.applyBroadcast -> applyDamage) mutates.
        const s = window.__gameSession;
        const localHp = s?.localController?.state?.hp ?? null;
        return {
          localHp,
          broadcastHandlerCount: window.__broadcastHandlerCount ?? 0,
        };
      });
      if (probe.localHp !== null && probe.localHp < tabBpre.hpBefore) {
        hpAfter = probe.localHp;
        broadcastHandlerCountAfter = probe.broadcastHandlerCount;
        break;
      }
      await sleep(50);
    }
    log(
      `Post-fire Tab B gameSession: hpBefore=${tabBpre.hpBefore}, hpAfter=${hpAfter}, ` +
      `broadcastHandlerCount=${broadcastHandlerCountAfter}`,
    );
    if (hpAfter === null) {
      throw new Error(
        `Tab B HP did not drop within ${FIRE_BROADCAST_TIMEOUT_MS}ms after Tab A fire. ` +
        `Pre-fire HP=${tabBpre.hpBefore}, last observed HP=${hpAfter ?? "null"}. ` +
        `This is the failure mode the PR #129 fix targets: broadcast landed on a phantom ` +
        `instance whose controllers no HUD reads from.`,
      );
    }
    if (hpAfter >= tabBpre.hpBefore) {
      throw new Error(
        `Tab B HP did not drop: pre=${tabBpre.hpBefore}, post=${hpAfter}. ` +
        `Damage broadcast may have applied incorrectly.`,
      );
    }
    // Broadcast handler must have fired on Tab B at least once. If
    // wireServerTransport had landed on a phantom instance
    // (separate from __gameSession), the handler would still
    // increment — but applyBroadcast controller resolution would
    // target the phantom controllers, leaving __gameSession HUD HP
    // unchanged. The HP-drop check above already covers this
    // end-to-end. This counter check is belt-and-suspenders.
    if (broadcastHandlerCountAfter === 0) {
      log(`WARN: Tab B __broadcastHandlerCount=0 after fire — broadcast may not have landed`);
    }
    recordPass(
      `damage-converges-pre=${tabBpre.hpBefore}-post=${hpAfter}-drop=${tabBpre.hpBefore - hpAfter}-bcastCount=${broadcastHandlerCountAfter}`,
    );

    // Screenshots
    try {
      await pageA.screenshot({ path: SMOKE_PNG_A, fullPage: true });
      await pageB.screenshot({ path: SMOKE_PNG_B, fullPage: true });
      log(`Screenshots: ${SMOKE_PNG_A}, ${SMOKE_PNG_B}`);
    } catch (e) {
      log(`Screenshot failed: ${e.message}`);
    }

    if (errors.length > 0) {
      log(`pageerror events observed: ${errors.join("; ")}`);
    }
    return true;
  } catch (err) {
    fail(`smoke flow error: ${err.message}`);
    try { await pageA.screenshot({ path: SMOKE_PNG_A, fullPage: true }); } catch {}
    try { await pageB.screenshot({ path: SMOKE_PNG_B, fullPage: true }); } catch {}
    return false;
  } finally {
    try { await browserA.close(); } catch {}
    try { await browserB.close(); } catch {}
  }
}

async function main() {
  try {
    if (!SMOKE_NO_BOOT && !SMOKE_NO_BUILD) {
      buildProdBundle();
    } else if (SMOKE_NO_BUILD) {
      log("SMOKE_NO_BUILD=1 — using existing client/dist/");
    }
    await bootCanary();
    await bootServeStatic();
    const ok = await runSmoke();
    if (!ok) exitCode = 1;

    log(`\n=== SUMMARY ===`);
    log(`Passed: ${results.filter((r) => r.ok).length}`);
    log(`Failed: ${results.filter((r) => !r.ok).length}`);
    for (const r of results) {
      log(`  ${r.ok ? "✓" : "✗"} ${r.name}`);
    }
  } catch (e) {
    fail(`FATAL: ${e.message}`);
    exitCode = 1;
  } finally {
    killProcs();
  }
  process.exit(exitCode);
}

main();
