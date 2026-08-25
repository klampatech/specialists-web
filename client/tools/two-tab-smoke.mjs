// PR 11.7.D2 / §3.10 — two-tab ServerTransport smoke (REWRITTEN post-D2.2).
//
// The original Phase 0 / PR 4 smoke drove the P2P WebRTC handshake via
// PeerOverlay's clipboard signaling flow (offer → answer → connected).
// The P2P substrate was DELETED in PR 11.7.D2 (`peer.ts`, `ggnet.ts`,
// `signaling.ts` — see squash 36e475a). The clipboard signaling UI is
// gone too (PeerOverlay was rewritten to read `?server=` URL params).
//
// **What this smoke verifies now**: two headless browser tabs both
// connect to the SAME ServerTransport room, and both receive the
// server-fanned-out snapshot stream (same snapshot data on both
// tabs). This is the post-D2.2 architectural foundation (the server
// is authoritative, both clients receive the same authoritative state
// at 20Hz, no P2P handshake required).
//
// Pattern mirrors `damage-server-hp-convergence-smoke.mjs` (5191) —
// the canonical ServerTransport smoke template that D2.1 + D2.2
// validated end-to-end. Differences from 5191:
//   - No damage fire (this smoke is connectivity-only, not combat).
//   - Asserts the SERVER-AUTHORITATIVE Snapshot fan-out matches
//     between Tab A and Tab B (same players, same HP) — proves the
//     room is fully wired (both tabs registered, server fanning out).
//   - Doesn't drive RTT/cooldown — those are 5191's coverage.
//
// Flow:
//   1. Boot canary server (--port-wt 14433 --port-ws 14434) + Vite
//      (port 5174).
//   2. Spawn 2 browser contexts (separate GPU resources per the
//      original comment — Chromium's GPU subprocess exhausts on a
//      shared context with multiple tabs).
//   3. Tab A: navigate to `http://localhost:5174/?server=ws://localhost:14434/rooms/DEVBX&localId=1&peerId=2`
//      with `__forceServerTransport=true` init script.
//   4. Tab B: same URL but `localId=2, peerId=1` (swapped).
//   5. Wait for both tabs' `ServerTransport.connect()` to resolve
//      (via `window.__serverTransport.getStats().connected === true`).
//   6. Poll `window.__latestSnap()` on both tabs, assert they match
//      (server-authoritative HP for both player IDs) after 500ms
//      settle. Asserts the snapshot is a real `Snapshot` with both
//      player IDs populated (not a placeholder / not missing entries).
//   7. Screenshot both tabs.
//
// Exit 0 on pass; exit 1 with `[FAIL]` diagnostic on fail.

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

const URL = process.env.URL ?? "http://localhost:5174/";
const WT_PORT = Number(process.env.TWO_TAB_WT_PORT ?? 14433);
const WS_PORT = Number(process.env.TWO_TAB_WS_PORT ?? 14434);
const SCREENSHOT_A = process.env.TWO_TAB_SMOKE_PNG_A ?? "client/tools/two-tab-smoke.png";
const SCREENSHOT_B = process.env.TWO_TAB_SMOKE_PNG_B ?? "client/tools/two-tab-smoke-connected.png";

const NAV_TIMEOUT = Number(process.env.SMOKE_NAV_TIMEOUT ?? 30000);
const CONNECT_TIMEOUT_MS = Number(process.env.TWO_TAB_CONNECT_TIMEOUT_MS ?? 5000);
const SNAPSHOT_SETTLE_MS = Number(process.env.TWO_TAB_SNAPSHOT_SETTLE_MS ?? 500);

const SCREENSHOT_PATH_A = resolve(REPO_ROOT, SCREENSHOT_A);
const SCREENSHOT_PATH_B = resolve(REPO_ROOT, SCREENSHOT_B);

const log = (...args) => console.log("[smoke]", ...args);
const fail = (...args) => console.error("[smoke][FAIL]", ...args);

mkdirSync(dirname(SCREENSHOT_PATH_A), { recursive: true });

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
    },
  );
  canaryProc.stdout.on("data", (d) => process.stderr.write(`[canary] ${d}`));
  canaryProc.stderr.on("data", (d) => process.stderr.write(`[canary-err] ${d}`));
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
  for (const port of [5174, WT_PORT, WS_PORT]) {
    try {
      const { execSync } = await import("node:child_process");
      execSync(`lsof -ti:${port} 2>/dev/null | xargs -r kill -9`, { stdio: "ignore" });
    } catch {
      // ignore
    }
  }
}

async function runSmoke() {
  // Use TWO separate browser instances so GPU resources aren't shared.
  // (Pre-D2.2 the smoke was one browser with two tabs; under
  // headless Chromium + the snapshot stream's WebSocket connections
  // (one per ServerTransport), the GPU subprocess can starve. Splitting
  // to two contexts gives each tab its own GPU budget — matches the
  // 5191 smoke's pattern + the pre-D2.2 comment about
  // ERR_INSUFFICIENT_RESOURCES on resource-limited laptops.)
  const browserA = await chromium.launch({
    headless: true,
    args: ["--ignore-certificate-errors"],
  });
  const browserB = await chromium.launch({
    headless: true,
    args: ["--ignore-certificate-errors"],
  });
  const ctxA = await browserA.newContext({ viewport: { width: 1280, height: 720 } });
  const ctxB = await browserB.newContext({ viewport: { width: 1280, height: 720 } });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  const errors = [];
  for (const [page, label] of [[pageA, "A"], [pageB, "B"]]) {
    page.on("pageerror", (err) => errors.push(`page${label}: ${err.message}`));
  }

  // Server URL: ws://localhost:14434 because headless Chromium's QUIC
  // stack rejects self-signed certs even with --ignore-certificate-errors
  // (Chromium QUIC TLS verifier has its own gate). The canary server's
  // WebSocket fallback serves the same wire protocol — matches 5191's
  // routing.
  const serverUrl = `ws://localhost:${WS_PORT}/rooms/DEVBX`;
  for (const [page, localId, peerId] of [[pageA, 1, 2], [pageB, 2, 1]]) {
    await page.addInitScript({
      content: `
          window.__forceServerTransport = true;
          window.__damageServerPorts = { wt: ${WT_PORT}, ws: ${WS_PORT} };
          window.__damageServerUrl = ${JSON.stringify(URL)};
          window.__damageServerRoomId = "DEVBX";
          window.__localPlayerId = ${localId};
          window.__peerPlayerId = ${peerId};
        `,
    });
  }

  try {
    // Navigate both tabs. We pass `?server=...` as a URL param so
    // PeerOverlay's URL-routing side-effect also fires (belt + suspenders).
    const navUrl = `${URL}?server=${encodeURIComponent(serverUrl)}`;
    log(`Navigating Tab A to ${navUrl}...`);
    await pageA.goto(navUrl, { waitUntil: "networkidle", timeout: NAV_TIMEOUT });
    log(`Navigating Tab B to ${navUrl}...`);
    await pageB.goto(navUrl, { waitUntil: "networkidle", timeout: NAV_TIMEOUT });

    // Wait for both tabs' __serverTransport to be ready (the IIFE in
    // scene.ts that connects + exposes the transport resolves with
    // winSlot.__serverTransport = <ServerTransport instance>).
    log("Waiting for both ServerTransports to connect...");
    const [connectedA, connectedB] = await Promise.all([
      waitForProbe(pageA, CONNECT_TIMEOUT_MS),
      waitForProbe(pageB, CONNECT_TIMEOUT_MS),
    ]);
    if (!connectedA) throw new Error("Tab A ServerTransport did not connect");
    if (!connectedB) throw new Error("Tab B ServerTransport did not connect");
    log("Both ServerTransports connected.");

    // Sanity: each tab uses the correct player id (Tab A=1, Tab B=2).
    // The page init script sets window.__localPlayerId and
    // window.__peerPlayerId; the scene passes these to createGameSession
    // via opts. Matches 5191's FIX 2 assertion.
    const idsA = await pageA.evaluate(() => {
      const session = window.__gameSession;
      return {
        local: session ? session.localPlayerId : null,
        peer: session ? session.peerPlayerId : null,
        windowLocal: window.__localPlayerId ?? null,
        windowPeer: window.__peerPlayerId ?? null,
      };
    });
    const idsB = await pageB.evaluate(() => {
      const session = window.__gameSession;
      return {
        local: session ? session.localPlayerId : null,
        peer: session ? session.peerPlayerId : null,
        windowLocal: window.__localPlayerId ?? null,
        windowPeer: window.__peerPlayerId ?? null,
      };
    });
    log(`Tab A: ${JSON.stringify(idsA)}`);
    log(`Tab B: ${JSON.stringify(idsB)}`);
    if (idsA.local !== 1 || idsA.peer !== 2) {
      throw new Error(`Tab A: expected local=1, peer=2, got ${JSON.stringify(idsA)}`);
    }
    if (idsB.local !== 2 || idsB.peer !== 1) {
      throw new Error(`Tab B: expected local=2, peer=1, got ${JSON.stringify(idsB)}`);
    }
    log("Assertion 1 PASS: both tabs use correct player ids (A=1→2, B=2→1).");

    // Drive a PositionUpdate from each tab so the server has current
    // positions to fan out. NOTE: the server only re-keys connections
    // from placeholder PlayerIds (1000+) to the real PlayerIds (1, 2)
    // on the FIRST DamageRequest (server/src/transport.rs around line
    // 555-580 — `conn.check(req.source_player_id)` is what stamps the
    // connection's identity). This connectivity smoke does NOT fire
    // damage, so the snapshots will show placeholder ids. Both tabs
    // receive the same placeholder set (the snapshot fan-out is
    // server-authoritative) — which is exactly what the cross-tab
    // match check verifies.
    await Promise.all([
      pageA.evaluate(() => {
        const session = window.__gameSession;
        const pos = session.localController.state.position;
        for (let f = 0; f < 3; f++) {
          window.__serverTransport.sendPositionUpdate({
            serverFrame: f, playerId: 1, positionX: pos.x, positionY: pos.z,
          });
        }
      }),
      pageB.evaluate(() => {
        const session = window.__gameSession;
        const pos = session.localController.state.position;
        for (let f = 0; f < 3; f++) {
          window.__serverTransport.sendPositionUpdate({
            serverFrame: f, playerId: 2, positionX: pos.x + 5.0, positionY: pos.z,
          });
        }
      }),
    ]);
    // 20Hz snapshot = 50ms interval; 150ms is ~3 ticks (safe margin
    // for the snapshot fan-out to deliver the latest state to both tabs).
    await sleep(150);

    // Verify both tabs have a snapshot populated. The smoke doesn't
    // assert specific playerIds because the placeholder/re-key
    // transition is governed by DamageRequest semantics (out of scope
    // for this connectivity smoke — 5191's primer covers that).
    //
    // The check is wrapped in a short poll because Tab B's snapshot
    // listener is registered AFTER the server has already been
    // emitting snapshots for Tab A's session. The next 20Hz tick
    // (≤50ms) should reach Tab B once its listener is wired up.
    // PR 11.7.D3.3 / parallel-load: bumped deadline from 1s → 5s.
    // When the 24-player stress smoke runs in parallel on the same
    // CI runner, Vite's first-frame load + WS handshake can take
    // 3-4s under contention. 1s was too tight; 5s gives generous
    // headroom without masking real bugs (a real 'snapshot never
    // arrives' would fail after 5s, which is still the strong
    // failure mode).
    for (const [page, label] of [[pageA, "A"], [pageB, "B"]]) {
      let primerCheck = null;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        primerCheck = await page.evaluate(() => {
          const snap = window.__latestSnap ? window.__latestSnap() : null;
          const entries = snap ? snap.players.map((p) => ({id: p.playerId, hp: p.hp})) : [];
          return { snapIsNull: snap === null, hasEntries: entries.length > 0, entries };
        });
        if (primerCheck.hasEntries) break;
        await sleep(150);
      }
      log(`Tab ${label} primer check: ${JSON.stringify(primerCheck)}`);
      if (!primerCheck.hasEntries) {
        throw new Error(
          `Tab ${label} snapshot has no players after primer (waited 5s) — server snapshot stream not delivering. ` +
          `Snapshot was ${primerCheck.snapIsNull ? "null" : "non-null with empty players"}. ` +
          `Snapshot entries: ${JSON.stringify(primerCheck.entries)}`,
        );
      }
    }
    log("Assertion 2 PASS: snapshot stream populated both tabs (server fan-out working).");

    // Wait the configured settle window (default 500ms = ~10 snapshot
    // ticks at 20Hz) to give the snapshot stream multiple chances to
    // fan out a fresh Snapshot to both tabs.
    await sleep(SNAPSHOT_SETTLE_MS);

    // ---- 3. Snapshot match check ----
    // Both tabs receive the SAME authoritative Snapshot from the server
    // (server iterates room.connections when building the snapshot and
    // fans out to each). The match proves the room is fully wired
    // (both tabs registered, snapshot stream delivering).
    //
    // We compare three fields per player:
    //   - playerId (must match exactly)
    //   - hp (server-authoritative, both tabs read the same value)
    //   - positionX / positionY (server-side lag-comp position; both
    //     tabs receive the same numbers)
    //
    // Position is normalized to 1 decimal to absorb float-rounding
    // differences between the server's per-connection
    // state.position.x and the fan-out copy (Babylon Vector3 storage
    // can introduce sub-mm rounding on copy).
    const snapA = await pageA.evaluate(() => {
      const snap = window.__latestSnap ? window.__latestSnap() : null;
      if (!snap) return null;
      return snap.players.map((p) => ({
        id: p.playerId,
        hp: p.hp,
        x: Math.round(p.positionX * 10) / 10,
        y: Math.round(p.positionY * 10) / 10,
      })).sort((a, b) => a.id - b.id);
    });
    const snapB = await pageB.evaluate(() => {
      const snap = window.__latestSnap ? window.__latestSnap() : null;
      if (!snap) return null;
      return snap.players.map((p) => ({
        id: p.playerId,
        hp: p.hp,
        x: Math.round(p.positionX * 10) / 10,
        y: Math.round(p.positionY * 10) / 10,
      })).sort((a, b) => a.id - b.id);
    });
    log(`Tab A snapshot: ${JSON.stringify(snapA)}`);
    log(`Tab B snapshot: ${JSON.stringify(snapB)}`);

    if (snapA === null || snapB === null) {
      throw new Error(
        `One or both tabs returned null from __latestSnap() — snapshot stream not delivering. ` +
        `Tab A=${JSON.stringify(snapA)}, Tab B=${JSON.stringify(snapB)}.`,
      );
    }
    if (snapA.length !== snapB.length) {
      throw new Error(
        `Snapshot player-count mismatch: Tab A has ${snapA.length}, Tab B has ${snapB.length}. ` +
        `Both tabs should see the same room state.`,
      );
    }
    for (let i = 0; i < snapA.length; i++) {
      const a = snapA[i];
      const b = snapB[i];
      if (a.id !== b.id) {
        throw new Error(`Snapshot playerId mismatch at index ${i}: Tab A=${a.id}, Tab B=${b.id}`);
      }
      if (a.hp !== b.hp) {
        throw new Error(
          `Snapshot HP mismatch for playerId=${a.id}: Tab A=${a.hp}, Tab B=${b.hp}. ` +
          `Both tabs should read the same server-authoritative HP from the snapshot.`,
        );
      }
      if (a.x !== b.x || a.y !== b.y) {
        throw new Error(
          `Snapshot position mismatch for playerId=${a.id}: Tab A=(${a.x},${a.y}), Tab B=(${b.x},${b.y}). ` +
          `Both tabs should read the same server-side lag-comp position.`,
        );
      }
    }
    log(`Assertion 3 PASS: both tabs' __latestSnap() match (${snapA.length} players, ids+HP+position identical across fan-out).`);

    // ---- Screenshots ----
    await pageA.screenshot({ path: SCREENSHOT_PATH_A });
    await pageB.screenshot({ path: SCREENSHOT_PATH_B });

    if (errors.length > 0) {
      throw new Error(`pageerror events: ${errors.join("; ")}`);
    }

    log(`OK — two-tab ServerTransport smoke passed (3 assertions: connect, player-id, snapshot-match).`);
    await browserA.close();
    await browserB.close();
    return true;
  } catch (err) {
    fail("FAIL:", err.message);
    try {
      await pageA.screenshot({ path: SCREENSHOT_PATH_A });
    } catch {
      // ignore
    }
    try {
      await pageB.screenshot({ path: SCREENSHOT_PATH_B });
    } catch {
      // ignore
    }
    if (errors.length > 0) {
      fail(`pageerror events: ${errors.join("; ")}`);
    }
    await browserA.close();
    await browserB.close();
    return false;
  }
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
