#!/usr/bin/env node
// PR 11.7.E / §3.5 — server-authoritative reload smoke.
//
// Boots the canary server (WebTransport + WebSocket) + Vite on port
// 5191, opens TWO headless browser contexts (each with its own
// `?server=` URL param + `__forceServerTransport = true` init script)
// connected to the SAME room (DEVBX), and asserts:
//
//   1. Both tabs' `ServerTransport.connect()` resolve within 5s and
//      the snapshot stream is live (player entries present).
//   2. Tab A fires a few shots (each ammo-decrement requires a hit) and
//      observes its local ammo drop in the snapshot stream
//      (server-authoritative — NOT a local controller field). The
//      smoke does NOT drive ammo to 0: the server's PositionUpdate
//      auto-register path resets `p.ammo = PLAYER_MAX_AMMO` whenever
//      it sees `p.ammo == 0` (transport.rs:843-845), so ammo=0 is only
//      observable for ≤1 snapshot tick before a refill. Instead, the
//      smoke fires 2 shots so ammo drops from 6→4 (well below max,
//      stable against the PositionUpdate reset).
//   3. Tab A's reload DEV-probe (`__gameSession.sendReloadRequest`)
//      sends a ReloadRequest (discriminator 0x09). Server validates
//      via `validate_and_relay_reload` (8 gates: source-in-room,
//      conn-id-match, hp>0, ammo<max, rate-limit, eventId-window,
//      sentinel) and mutates `room.players[source].ammo =
//      PLAYER_MAX_AMMO`. Snapshot fan-out carries the new ammo on
//      the next 20Hz tick.
//   4. After ≤200ms (4 snapshot ticks), Tab A's `__latestSnap()
//      .players[1].ammo === PLAYER_MAX_AMMO` (server-authoritative).
//   5. Tab B's `__latestSnap().players[1].ammo === PLAYER_MAX_AMMO`
//      — proves the snapshot fan-out propagated the new ammo to
//      every connected tab (this is the server-authoritative core
//      assertion: the SAME server-side state machine drives both
//      tabs' HUDs).
//
// The 5 assertions prove the PR 11.7.E / §3.5 contract:
//   - ReloadRequest (0x09) round-trip on the wire (disc + u16 source +
//     u32 eventId, 7 bytes total)
//   - server-side `validate_and_relay_reload` 8 gates
//   - server-side ammo mutation
//   - 20Hz snapshot fan-out carries the new ammo to all tabs
//   - both tabs' HUD reads `__latestSnap` (server-authoritative, NOT
//     local controller)
//
// Designed to mirror `damage-server-hp-convergence-smoke.mjs` so CI
// can wire it with the same canary+vite boot steps.

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

// PR 11.7.E / §3.5 — constant must match `server/src/constants.rs::PLAYER_MAX_AMMO`.
// Smoke reads from the snapshot (server-authoritative) — hardcoding here is fine
// because the snapshot value is asserted literally below.
const PLAYER_MAX_AMMO = 6;
const URL = process.env.RELOAD_SMOKE_URL ?? "http://localhost:5191/";
const WT_PORT = Number(process.env.RELOAD_SMOKE_WT_PORT ?? 14433);
const WS_PORT = Number(process.env.RELOAD_SMOKE_WS_PORT ?? 14434);
const SCREENSHOT = process.env.SMOKE_PNG ?? "client/tools/damage-server-reload-smoke.png";

const NAV_TIMEOUT = Number(process.env.SMOKE_NAV_TIMEOUT ?? 30000);
const CONNECT_TIMEOUT_MS = Number(process.env.SMOKE_CONNECT_TIMEOUT_MS ?? 5000);
// 200ms wait after reload = 4 snapshot ticks @ 20Hz (50ms each). Generous
// for CI localhost (snapshot tick is normally ≤16ms, fan-out is <1ms).
const RELOAD_SETTLE_MS = Number(process.env.RELOAD_SMOKE_SETTLE_MS ?? 200);
// Fire-cooldown-aware shot pacing (server cooldown = 120ms; we pace at
// 200ms to dodge CI clock skew without relying on the warn-retry pattern).
const FIRE_PACE_MS = 200;
const SHOTS_TO_FIRE = 2; // 5 (post-primer) − 2 = 3 ammo after fires

const SCREENSHOT_PATH = resolve(REPO_ROOT, SCREENSHOT);

const log = (...args) => console.log("[reload-smoke]", ...args);
const fail = (...args) => console.error("[reload-smoke][FAIL]", ...args);

// ---------------------------------------------------------------------------
// Step 1: Boot canary server + vite dev server in background.
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
  log(`Booting vite on 5191...`);
  viteProc = spawn(
    "npm",
    ["run", "dev", "--", "--host", "127.0.0.1", "--port", "5191", "--strictPort"],
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
  for (const port of [5191, WT_PORT, WS_PORT]) {
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
    args: ["--ignore-certificate-errors"],
  });
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  const errors = [];
  for (const [page, label] of [[pageA, "A"], [pageB, "B"]]) {
    page.on("pageerror", (err) => errors.push(`page${label}: ${err.message}`));
  }

  // Server URL: the smoke uses ws://localhost:14434 because headless
  // Chromium's QUIC stack rejects self-signed certs even with
  // --ignore-certificate-errors (Chromium QUIC TLS verifier has its own
  // gate). The canary server's WebSocket fallback serves the same wire
  // protocol.
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
    // Navigate both tabs. Pass `?server=...` as a URL param so
    // PeerOverlay's URL-routing side-effect also fires (belt + suspenders).
    const navUrl = `${URL}?server=${encodeURIComponent(serverUrl)}`;
    log(`Navigating Tab A to ${navUrl}...`);
    await pageA.goto(navUrl, { waitUntil: "networkidle", timeout: NAV_TIMEOUT });
    log(`Navigating Tab B to ${navUrl}...`);
    await pageB.goto(navUrl, { waitUntil: "networkidle", timeout: NAV_TIMEOUT });

    // ---- Assertion 1: both ServerTransports connect + snapshot stream live.
    log("Waiting for both ServerTransports to connect...");
    const [connectedA, connectedB] = await Promise.all([
      waitForProbe(pageA, CONNECT_TIMEOUT_MS),
      waitForProbe(pageB, CONNECT_TIMEOUT_MS),
    ]);
    if (!connectedA) throw new Error("Tab A ServerTransport did not connect");
    if (!connectedB) throw new Error("Tab B ServerTransport did not connect");
    log("Both ServerTransports connected.");

    // Verify player-id setup matches expectations (same assertion as the
    // existing 5191 HP-convergence smoke — guards against URL-routing
    // regressions breaking the room-join path).
    const idsA = await pageA.evaluate(() => {
      const session = (window).__gameSession;
      return {
        local: session ? session.localPlayerId : null,
        peer: session ? session.peerPlayerId : null,
        windowLocal: window.__localPlayerId ?? null,
        windowPeer: window.__peerPlayerId ?? null,
      };
    });
    const idsB = await pageB.evaluate(() => {
      const session = (window).__gameSession;
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

    // PR 11.7.D / §4.4 closure — registration primer. Same pattern
    // as the 5191 HP-convergence smoke: PositionUpdates build the
    // position_history ring, then a DamageRequest from each tab
    // promotes both connections from placeholder IDs (1000+) to
    // their real PlayerIds (1, 2). The snapshot iterates
    // room.connections and only shows real PlayerIds after
    // promotion — without the primer, the snapshot may not include
    // both tabs even after PositionUpdates. The primer drops 1 HP +
    // 1 ammo per tab (HP 100→99, ammo 6→5); the smoke then drives
    // ammo from 5 down + back up to test the reload.
    log("Driving PositionUpdates + DamageRequest primer to register both players...")
        // Let Babylon's render loop emit several natural PositionUpdates
        // (the transport's `last_known_player_id` promotion happens lazily on
        // the first DamageRequest; without a settle window, the primer
        // can race the room-discovery and result in one tab seeing an empty
        // snapshot). Mirrors the 5191 HP-convergence smoke's 2s poll loop.
        log("Settling 1.5s to let natural PositionUpdates fire + snapshot stream fan out…")
        await sleep(1500)
        await Promise.all([
      pageA.evaluate(() => {
        const session = (window).__gameSession;
        const t = (window).__serverTransport;
        if (!session || !t) return;
        const pos = session.localController.state.position;
        for (let f = 0; f < 3; f++) {
          t.sendPositionUpdate({
            serverFrame: f,
            playerId: 1,
            positionX: pos.x,
            positionY: pos.z,
          });
        }
      }),
      pageB.evaluate(() => {
        const session = (window).__gameSession;
        const t = (window).__serverTransport;
        if (!session || !t) return;
        const pos = session.localController.state.position;
        for (let f = 0; f < 3; f++) {
          t.sendPositionUpdate({
            serverFrame: f,
            playerId: 2,
            // 5m offset on x to keep both tabs within hitscan range
            // (maxRangeMeters = 50). Lag-comp re-cast needs the
            // target at a known position.
            positionX: pos.x + 5.0,
            positionY: pos.z,
          });
        }
      }),
    ]);
    await sleep(300);
    // DamageRequest primer — both tabs fire 1-damage shots at each
    // other. Forces connection promotion AND populates the snapshot
    // with both playerIds.
    const primerEventA = Math.floor(Math.random() * 0xfffffff0);
    const primerEventB = Math.floor(Math.random() * 0xfffffff0);
    const primerResultA = await pageA.evaluate(async ({eventId}) => {
      const bus = (window).__damageBus;
      const session = (window).__gameSession;
      if (!bus || !session) return {ok: false, reason: "missing bus/session"};
      try {
        bus.sendDamageRequest({
          frame: 0,
          sourcePlayerId: 1,
          targetPlayerId: 2,
          source: 0, // fire (mode 0 = dual-pistol)
          amount: 1, // minimal — 1 HP drop + 1 ammo decrement per tab
          eventId,
        }, session.remoteController, performance.now(), 1, 2);
        return {ok: true};
      } catch (e) {
        return {ok: false, reason: String(e)};
      }
    }, {eventId: primerEventA});
    if (!primerResultA.ok) {
      throw new Error(`Tab A primer fire failed: ${primerResultA.reason}`);
    }
    const primerResultB = await pageB.evaluate(async ({eventId}) => {
      const bus = (window).__damageBus;
      const session = (window).__gameSession;
      if (!bus || !session) return {ok: false, reason: "missing bus/session"};
      try {
        bus.sendDamageRequest({
          frame: 0,
          sourcePlayerId: 2,
          targetPlayerId: 1,
          source: 0,
          amount: 1,
          eventId,
        }, session.remoteController, performance.now(), 2, 1);
        return {ok: true};
      } catch (e) {
        return {ok: false, reason: String(e)};
      }
    }, {eventId: primerEventB});
    if (!primerResultB.ok) {
      throw new Error(`Tab B primer fire failed: ${primerResultB.reason}`);
    }
    // Wait for the snapshot to fan out under the new PlayerIds.
    // 20Hz snapshot = 50ms interval; 200ms is ~4 ticks (safe margin).
    await sleep(200);

    // Verify both tabs now see playerId=1 AND playerId=2 in their
    // snapshots. After the primer, ammo = PLAYER_MAX_AMMO - 1 = 5
    // (one shot dropped per player\'s magazine).
    const initialA = await pageA.evaluate(() => {
      const snap = (window).__latestSnap ? (window).__latestSnap() : null;
      const e1 = snap ? snap.players.find((p) => p.playerId === 1) : null;
      const e2 = snap ? snap.players.find((p) => p.playerId === 2) : null;
      return {
        found1: !!e1, ammo1: e1 ? e1.ammo : null,
        found2: !!e2, ammo2: e2 ? e2.ammo : null,
      };
    });
    const initialB = await pageB.evaluate(() => {
      const snap = (window).__latestSnap ? (window).__latestSnap() : null;
      const e1 = snap ? snap.players.find((p) => p.playerId === 1) : null;
      const e2 = snap ? snap.players.find((p) => p.playerId === 2) : null;
      return {
        found1: !!e1, ammo1: e1 ? e1.ammo : null,
        found2: !!e2, ammo2: e2 ? e2.ammo : null,
      };
    });
    log(`Initial snapshot: Tab A=${JSON.stringify(initialA)}, Tab B=${JSON.stringify(initialB)}`);
    if (!initialA.found1 || !initialA.found2 || !initialB.found1 || !initialB.found2) {
      throw new Error(
        `Pre-fire snapshot primer failed: server did not re-key both connections within 200ms. ` +
        `Expected playerId=1 AND playerId=2 in both tabs\' snapshots. ` +
        `Found Tab A: ${JSON.stringify(initialA)}, Tab B: ${JSON.stringify(initialB)}.`,
      );
    }
    if (initialA.ammo1 !== initialB.ammo1) {
      throw new Error(
        `Initial ammo disagreement on player 1: Tab A=${initialA.ammo1}, Tab B=${initialB.ammo1}. ` +
        `Both tabs read from the same snapshot stream and should agree.`,
      );
    }
    log(
      `Assertion 1 PASS: both tabs connected, snapshot stream live, ` +
      `player 1 ammo=${initialA.ammo1} (Tab A=B agrees; < ${PLAYER_MAX_AMMO} after primer).`,
    );

    // ---- Assertion 2: Tab A fires SHOTS_TO_FIRE shots, ammo drops by N.
    // PR 11.7.E / §3.5 — ammo decrements by 1 on every successful
    // hit (server-side `validate_and_relay` Gate 8 + side-effect at
    // damage_relay.rs:301). The smoke paces shots at FIRE_PACE_MS to
    // dodge the server's 120ms fire-rate cooldown.
    log(`Tab A firing ${SHOTS_TO_FIRE} shots at Tab B (player 2)...`);
    // Monotonic base eventId for the reload chain. The server's
    // bounded-window gate (`eventId + WINDOW < last_event_id` rejects)
    // needs the reload's eventId to be within 64 of the server's
    // last_event_id_for_source[1] — which advances with every fire.
    // Use primerEventA + 1 as the base for fires, then
    // primerEventA + 1 + SHOTS_TO_FIRE + 1 for the reload. Cap at
    // 0xfffffff0 so the chain doesn't overflow u32.
    const baseFireEventId = primerEventA + 1;
    const fireResults = await pageA.evaluate(async ({ count, paceMs, baseEventId }) => {
      const bus = (window).__damageBus;
      const session = (window).__gameSession;
      const t = (window).__serverTransport;
      if (!bus || !session || !t) return { ok: false, reason: "missing bus/session/transport" };
      const sent = [];
      for (let i = 0; i < count; i++) {
        // Re-resolve the target controller on every iteration — under
        // React StrictMode the closure-captured session may be disposed
        // and replaced; the live session is always on window.__gameSession.
        const liveSession = (window).__gameSession;
        const targetController = liveSession ? liveSession.remoteController : null;
        try {
          bus.sendDamageRequest(
            {
              frame: i,
              sourcePlayerId: 1,
              targetPlayerId: 2,
              source: 0, // fire (mode 0 = dual-pistol)
              amount: 12, // DUAL_PISTOL_DAMAGE
              eventId: baseEventId + i,
            },
            targetController,
            performance.now(),
            1,
            2
          );
          sent.push({ i, eventId: baseEventId + i });
        } catch (e) {
          sent.push({ i, error: String(e) });
        }
        await new Promise((r) => setTimeout(r, paceMs));
      }
      return { ok: true, sent };
    }, { count: SHOTS_TO_FIRE, paceMs: FIRE_PACE_MS, baseEventId: baseFireEventId });
    if (!fireResults.ok) {
      throw new Error(`Tab A fires failed: ${fireResults.reason}`);
    }
    log(`Tab A fired ${fireResults.sent.length} shots.`);

    // Wait for the snapshot fan-out to reflect the ammo decrements.
    // Each fire takes ≤120ms cooldown + 1 tick to land; after all fires
    // the snapshot should converge. Poll up to 1s for ammo to drop below max.
    const postFire = await pageA.evaluate(async ({ timeoutMs, maxAmmo, sourceId }) => {
      const start = Date.now();
      let lastAmmo = null;
      while (Date.now() - start < timeoutMs) {
        const snap = (window).__latestSnap ? (window).__latestSnap() : null;
        const entry = snap ? snap.players.find((p) => p.playerId === sourceId) : null;
        const ammo = entry ? entry.ammo : null;
        if (ammo !== null && ammo < maxAmmo) {
          return { ok: true, ammo };
        }
        lastAmmo = ammo;
        await new Promise((r) => setTimeout(r, 20));
      }
      return { ok: false, reason: "snapshot ammo never dropped below max", ammo: lastAmmo };
    }, { timeoutMs: 1500, maxAmmo: PLAYER_MAX_AMMO, sourceId: 1 });
    if (!postFire.ok) {
      throw new Error(
        `Tab A snapshot ammo did not drop below ${PLAYER_MAX_AMMO} within 1500ms ` +
        `(last ammo=${postFire.ammo}). Either fires didn't land as hits, ` +
        `or the snapshot fan-out is broken.`,
      );
    }
    // Tab B should see the same ammo (server-authoritative propagation).
    const postFireB = await pageB.evaluate(({ sourceId }) => {
      const snap = (window).__latestSnap ? (window).__latestSnap() : null;
      const entry = snap ? snap.players.find((p) => p.playerId === sourceId) : null;
      return entry ? entry.ammo : null;
    }, { sourceId: 1 });
    if (postFireB === null) {
      throw new Error(`Tab B snapshot missing playerId=1 post-fire.`);
    }
    if (postFire.ammo !== postFireB) {
      throw new Error(
        `Post-fire ammo mismatch: Tab A=${postFire.ammo} vs Tab B=${postFireB}. ` +
        `Both tabs read from the same snapshot stream and should agree.`,
      );
    }
    log(
      `Assertion 2 PASS: Tab A fired ${SHOTS_TO_FIRE} shots, snapshot ammo dropped ` +
      `to ${postFire.ammo} (Tab B agrees).`,
    );

    // ---- Assertion 3: Tab A triggers reload via the DEV probe.
    // PR 11.7.E / §3.5 — `__gameSession.sendReloadRequest(playerId,
    // eventId)` is the DEV-gated probe on the GameSession handle. It
    // calls into `damageBus.sendReloadRequest` → server transport →
    // wire 7-byte ReloadRequest (0x09 + u16 BE + u32 BE).
    log("Tab A triggering reload via __gameSession.sendReloadRequest...");
    // Reload eventId must be > last_event_id - 64. After SHOTS_TO_FIRE
    // fires, last_event_id >= primerEventA + 1 + SHOTS_TO_FIRE - 1.
    // Using primerEventA + 1 + SHOTS_TO_FIRE + 1 (= 5+ ahead of the
    // last fire's eventId) keeps the reload comfortably inside the
    // server's bounded window.
    const reloadEventId = Math.min(primerEventA + 1 + SHOTS_TO_FIRE + 1, 0xfffffff0);
    const reloadResult = await pageA.evaluate(({ playerId, eventId }) => {
      const session = (window).__gameSession;
      if (!session) return { ok: false, reason: "no __gameSession" };
      if (typeof session.sendReloadRequest !== "function") {
        return { ok: false, reason: "__gameSession.sendReloadRequest is not a function (DEV gate stripped?)" };
      }
      const result = session.sendReloadRequest(playerId, eventId);
      return { ok: true, returned: result };
    }, { playerId: 1, eventId: reloadEventId });
    if (!reloadResult.ok) {
      throw new Error(`Tab A reload probe failed: ${reloadResult.reason}`);
    }
    if (reloadResult.returned !== reloadEventId) {
      throw new Error(
        `__gameSession.sendReloadRequest returned ${reloadResult.returned} ` +
        `(expected ${reloadEventId}). DEV probe should echo the input eventId.`,
      );
    }
    log(`Assertion 3 PASS: Tab A sent ReloadRequest (eventId=${reloadEventId}).`);

    // ---- Assertion 4: Tab A's snapshot reports ammo = PLAYER_MAX_AMMO
    // within RELOAD_SETTLE_MS (well over one 20Hz snapshot tick).
    log(`Waiting ${RELOAD_SETTLE_MS}ms for snapshot fan-out to carry new ammo...`);
    await sleep(RELOAD_SETTLE_MS);
    const postReloadA = await pageA.evaluate(({ sourceId }) => {
      const snap = (window).__latestSnap ? (window).__latestSnap() : null;
      const entry = snap ? snap.players.find((p) => p.playerId === sourceId) : null;
      return entry ? entry.ammo : null;
    }, { sourceId: 1 });
    if (postReloadA === null) {
      throw new Error(`Tab A snapshot missing playerId=1 post-reload.`);
    }
    if (postReloadA !== PLAYER_MAX_AMMO) {
      throw new Error(
        `Tab A snapshot ammo post-reload = ${postReloadA} (expected ${PLAYER_MAX_AMMO}). ` +
        `Server's reload validator may have rejected the request — check ` +
        `validate_and_relay_reload gates (rate-limit, ammo<max, hp>0, eventId-window).`,
      );
    }
    log(`Assertion 4 PASS: Tab A snapshot ammo post-reload = ${postReloadA}.`);

    // ---- Assertion 5: Tab B's snapshot reports the same ammo for
    // player 1. This is the server-authoritative propagation core.
    const postReloadB = await pageB.evaluate(({ sourceId }) => {
      const snap = (window).__latestSnap ? (window).__latestSnap() : null;
      const entry = snap ? snap.players.find((p) => p.playerId === sourceId) : null;
      return entry ? entry.ammo : null;
    }, { sourceId: 1 });
    if (postReloadB === null) {
      throw new Error(`Tab B snapshot missing playerId=1 post-reload.`);
    }
    if (postReloadB !== PLAYER_MAX_AMMO) {
      throw new Error(
        `Tab B snapshot ammo post-reload = ${postReloadB} (expected ${PLAYER_MAX_AMMO}). ` +
        `Snapshot fan-out did not propagate the reload to Tab B.`,
      );
    }
    if (postReloadA !== postReloadB) {
      throw new Error(
        `Post-reload ammo mismatch: Tab A=${postReloadA} vs Tab B=${postReloadB}. ` +
        `Snapshot stream desync — both tabs read from the same server-authoritative fan-out.`,
      );
    }
    log(`Assertion 5 PASS: Tab B snapshot ammo post-reload = ${postReloadB} (matches Tab A).`);

    // Capture screenshot of Tab A (the reloader) for the artifact.
    await pageA.screenshot({ path: SCREENSHOT_PATH });

    if (errors.length > 0) {
      throw new Error(`pageerror events: ${errors.join("; ")}`);
    }

    log(`OK — damage-server-reload-smoke passed (5/5 assertions).`);
    await browser.close();
    return true;
  } catch (err) {
    fail("FAIL:", err.message);
    try {
      await pageA.screenshot({ path: SCREENSHOT_PATH });
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
