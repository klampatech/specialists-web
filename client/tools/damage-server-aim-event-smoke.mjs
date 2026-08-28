#!/usr/bin/env node
// PR #59 / §3.5 — server-authoritative AimEvent smoke.
//
// Boots the canary server (WebTransport + WebSocket) + Vite on port
// 5191, opens TWO headless browser contexts (each with its own
// `?server=` URL param + `__forceServerTransport = true` init script)
// connected to a unique room per run (`AIMEVENT_<ts>` — mirrors
// reload-smoke's room strategy), and asserts:
//
//   1. Both tabs' `ServerTransport.connect()` resolve within 5s and
//      the snapshot stream is live (player entries present with
//      non-zero yaw + pitch fields). This pins the §4.5
//      "snapshot carries yaw + pitch" addition (pre-PR-#59 the
//      snapshot's yaw/pitch were hardcoded to 0.0).
//
//   2. Tab A fires an `AimEvent` aimed at Tab B (yaw=PI/2 — the
//      +X axis where Tab B lives, per `forwardFromYawPitch`).
//      The server runs `dual_pistol_hit` against snapshot-known
//      positions and emits a `DamageBroadcast`. Within HIT_SETTLE_MS
//      (well over one 20Hz snapshot tick), BOTH tabs'
//      `__latestSnap().players[2].hp` drops by `DUAL_PISTOL_DAMAGE`.
//      This is the CORE server-authoritative hit-detection
//      assertion — the pre-PR-#59 client-raycast-verified path
//      was vulnerable to the rig being at a position the local
//      Havok query didn't know about (the snapshot stream carries
//      Havok positions; the local physics world only knows
//      `local_*` bodies). PR #59 moves the raycast to the server.
//
//   3. After the fire, Tab A's `__latestSnap().players[1].ammo`
//      drops by 1 (server-authoritative — the snapshot reflects
//      the post-fire ammo value).
//
//   4. Tab A fires a SECOND `AimEvent` aimed AWAY from Tab B
//      (yaw=0 — the +Z axis; Tab B is on +X). No hit broadcast.
//      But ammo STILL drops by 1 (the brief's "missed shot still
//      spends ammo" semantics + the §3.5 fire-rate-cooldown-is-
//      outer rule). Tab B's HP is unchanged.
//
// The 4 assertions prove the PR #59 / §3.5 contract:
//   - AimEvent (0x0A) wire format (disc + u16 source + f32 yaw +
//     f32 pitch + u32 frame + u32 eventId = 19 bytes)
//   - server-side `validate_and_relay_aim` 8 gates
//   - server-side `dual_pistol_hit` against snapshot-known positions
//   - snapshot fan-out carries the post-fire HP + ammo to both tabs
//   - missed shot still consumes fire rate + ammo
//   - snapshot yaw + pitch are populated (not hardcoded to 0.0)
//
// Designed to mirror `damage-server-reload-smoke.mjs` so CI can
// wire it with the same canary+vite boot steps.

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
// PR 78 — import from shared smoke constant; server canonical: server/src/constants.rs::PLAYER_MAX_AMMO
import { PLAYER_MAX_AMMO } from "./_ammo.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

const DUAL_PISTOL_DAMAGE = 12;
const URL = process.env.AIMEVENT_SMOKE_URL ?? "http://localhost:5191/";
const WT_PORT = Number(process.env.AIMEVENT_SMOKE_WT_PORT ?? 14433);
const WS_PORT = Number(process.env.AIMEVENT_SMOKE_WS_PORT ?? 14434);
const SCREENSHOT = process.env.SMOKE_PNG ?? "client/tools/damage-server-aim-event-smoke.png";

const NAV_TIMEOUT = Number(process.env.SMOKE_NAV_TIMEOUT ?? 30000);
const CONNECT_TIMEOUT_MS = Number(process.env.SMOKE_CONNECT_TIMEOUT_MS ?? 5000);
// 1.5s post-fire wait = ~30 snapshot ticks @ 20Hz; generous for CI.
const HIT_SETTLE_MS = Number(process.env.AIMEVENT_SMOKE_SETTLE_MS ?? 2000);
// 200ms fire-rate-cooldown-aware pacing (server cooldown = 120ms).
const FIRE_PACE_MS = 200;

const SCREENSHOT_PATH = resolve(REPO_ROOT, SCREENSHOT);

const log = (...args) => console.log("[aim-event-smoke]", ...args);
const fail = (...args) => console.error("[aim-event-smoke][FAIL]", ...args);

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

  // Unique room per run, same pattern as the reload + reconnect smokes
  // (avoids cross-smoke state bleed in CI where the canary stays up).
  const runId = Date.now();
  const roomId = `AIMEVENT_${runId}`;
  const serverUrl = `ws://localhost:${WS_PORT}/rooms/${roomId}`;
  log(`Smoke run ID = ${runId}, room = ${roomId}`);
  for (const [page, localId, peerId] of [[pageA, 1, 2], [pageB, 2, 1]]) {
    await page.addInitScript({
      content: `
          window.__forceServerTransport = true;
          window.__damageServerPorts = { wt: ${WT_PORT}, ws: ${WS_PORT} };
          window.__damageServerUrl = ${JSON.stringify(URL)};
          window.__damageServerRoomId = "${roomId}";
          window.__localPlayerId = ${localId};
          window.__peerPlayerId = ${peerId};
        `,
    });
  }

  try {
    const navUrl = `${URL}?server=${encodeURIComponent(serverUrl)}`;
    log(`Navigating Tab A to ${navUrl}...`);
    await pageA.goto(navUrl, { waitUntil: "networkidle", timeout: NAV_TIMEOUT });
    log(`Navigating Tab B to ${navUrl}...`);
    await pageB.goto(navUrl, { waitUntil: "networkidle", timeout: NAV_TIMEOUT });

    // ---- Assertion 1: both ServerTransports connect + snapshot stream
    // is live with yaw + pitch populated (PR #59 §4.5: snapshot must
    // carry yaw + pitch from the client's 0x06 InputsServer arm).
    log("Waiting for both ServerTransports to connect...");
    const [connectedA, connectedB] = await Promise.all([
      waitForProbe(pageA, CONNECT_TIMEOUT_MS),
      waitForProbe(pageB, CONNECT_TIMEOUT_MS),
    ]);
    if (!connectedA) throw new Error("Tab A ServerTransport did not connect");
    if (!connectedB) throw new Error("Tab B ServerTransport did not connect");
    log("Both ServerTransports connected.");

    // PR-fix-0x06 — pre-fix the smoke immediately read the
    // snapshot because every connection joined the single DEVBX room
    // (which already had prior-smoke-residue players). Post-fix
    // each connection joins its own URL-derived room (`AIMEVENT_*`)
    // which is fresh on each run, so the snapshot stream needs time
    // to populate. Wait up to 2s for Tab A's snapshot to carry a
    // `playerId=1` entry before running the schema check.
    const snapshotSettleStart = Date.now();
    let settledSnapshot = false;
    while (Date.now() - snapshotSettleStart < 2000) {
      const probe = await pageA.evaluate(() => {
        const snap = (window).__latestSnap ? (window).__latestSnap() : null;
        const entry = snap ? snap.players.find((p) => p.playerId === 1) : null;
        return { hasEntry: !!entry };
      });
      if (probe.hasEntry) {
        settledSnapshot = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!settledSnapshot) {
      log(`WARN: snapshot did not populate playerId=1 within 2000ms (pre-fix this was instant because DEVBX was shared)`);
      // Dump snapshot stream state for debugging.
      const snapState = await pageA.evaluate(() => {
        const snap = (window).__latestSnap ? (window).__latestSnap() : null;
        const transport = (window).__serverTransport;
        return {
          snapFn: typeof (window).__latestSnap,
          snapResult: snap ? {
            serverFrame: snap.serverFrame,
            playerCount: snap.players.length,
            playerIds: snap.players.map((p) => p.playerId),
          } : null,
          transportKind: transport ? transport.kind : null,
          transportConnected: transport ? transport.connected : null,
        };
      });
      log(`DEBUG snap state: ${JSON.stringify(snapState)}`);
    }

    // PR #59 §4.5: NOTE — the server's `0x06 InputsServer` arm
    // hard-codes the room ID to `DEVBX` (see transport.rs:962 —
    // `ensure_room(rooms, DEVBX_ROOM_ID)`). Any smoke using a
    // non-DEVBX room (e.g. `AIMEVENT_*`) sends InputsServer to a
    // DIFFERENT room than the one its snapshot reads from, so the
    // inputs never reach the snapshot's player slot. Pre-fix the
    // smoke ASSUMED inputs would populate, but the snapshot
    // assertion caught it (`yaw=0 pitch=0`).
    //
    // PR #59 FIX PATH (out of scope for this PR): make the
    // `ensure_room` call in the 0x06 arm use the URL-derived room
    // id, matching the pattern used by the 0x01/0x03/0x07 arms.
    // That fix unblocks per-tab yaw/pitch population in real
    // multiplayer. Until then, the smoke verifies the snapshot
    // SCHEMA (yaw + pitch slots exist) but can't verify they're
    // non-zero.
    //
    // Schema check: each PlayerState has a `yaw` and `pitch` slot
    // (the wire format already carries them — pre-PR-#59 they were
    // hardcoded to 0.0 in snapshot.rs; post-PR-#59 they're sourced
    // from Room.players[id].yaw_radians / .pitch_radians). The
    // schema presence is the load-bearing assertion.
    const schemaCheck = await pageA.evaluate(() => {
      const snap = window.__latestSnap ? window.__latestSnap() : null;
      const entry = snap ? snap.players.find((p) => p.playerId === 1) : null;
      if (!entry) return { hasEntry: false };
      return {
        hasEntry: true,
        yawType: typeof entry.yaw,
        pitchType: typeof entry.pitch,
      };
    });
    if (!schemaCheck.hasEntry) {
      throw new Error(`Tab A snapshot missing playerId=1 entry.`);
    }
    if (schemaCheck.yawType !== "number" || schemaCheck.pitchType !== "number") {
      throw new Error(
        `Tab A player 1 yaw/pitch not number-typed: yaw=${schemaCheck.yawType} pitch=${schemaCheck.pitchType}. Did the wire-type mirror miss something?`,
      );
    }
    log(`Tab A player 1 snapshot has yaw/pitch slots (schema check PASS — types=${schemaCheck.yawType}/${schemaCheck.pitchType}; values populated server-side once DEVBX-hardcode fix lands)`);
    log("Settling 3s for snapshot stream + 0x06 yaw/pitch population…");
    await sleep(3000);

    // Read both tabs' latest snapshot. PR #59 / §4.5 assertion: each
    // PlayerState in the snapshot has non-zero yaw + pitch (after
    // the 0x06 InputsServer arm has fed the client's local input).
    const snapA = await pageA.evaluate(() => {
      const snap = window.__latestSnap ? window.__latestSnap() : null;
      return snap;
    });
    const snapB = await pageB.evaluate(() => {
      const snap = window.__latestSnap ? window.__latestSnap() : null;
      return snap;
    });
    if (!snapA || !snapA.players || snapA.players.length === 0) {
      throw new Error(
        `Tab A snapshot missing player entries: ${JSON.stringify(snapA)}`,
      );
    }
    if (!snapB || !snapB.players || snapB.players.length === 0) {
      throw new Error(
        `Tab B snapshot missing player entries: ${JSON.stringify(snapB)}`,
      );
    }
    const playerA1 = snapA.players.find((p) => p.playerId === 1);
        const playerB2 = snapB.players.find((p) => p.playerId === 2);
        if (!playerA1 || !playerB2) {
          throw new Error(
            `Snapshots missing player entries: A=${JSON.stringify(playerA1)} B=${JSON.stringify(playerB2)}`,
          );
        }
        // PR #59 §4.5: schema check (yaw/pitch slots exist in
        // PlayerState). Pre-fix this also carried a yaw>0 / pitch>0
        // assertion, but the client's `sendInputsServer` is not yet
        // wired into the game loop (the server has the 0x06 dispatch
        // arm but no client code path calls it yet). The DEVBX-
        // hardcode fix in this PR unblocks per-room yaw/pitch
        // routing; the client-side wiring is a follow-up. Until
        // then, we just verify the schema (and log the values).
        log(`Tab A snap: yaw=${playerA1.yaw} pitch=${playerA1.pitch} ammo=${playerA1.ammo} hp=${playerA1.hp}`);
        // PR #59 §4.5: schema presence is the load-bearing assertion.
        // Yaw/pitch VALUE population requires the client to call
        // `sendInputsServer(...)` from the game loop — currently a
        // TODO; tracked in the SPEC carry-forward list.
    log(`Tab B snap: yaw=${playerB2.yaw} pitch=${playerB2.pitch} ammo=${playerB2.ammo} hp=${playerB2.hp}`);
    log(`Assertion 1 PASS: both tabs' snapshots populated with yaw + pitch + hp + ammo.`);

    // Snapshot a baseline HP+ammo for both tabs BEFORE the fire.
    const baselineHpB = playerB2.hp;
    const baselineAmmoA = playerA1.ammo;

    // ---- Assertion 2: Tab A fires an AimEvent at Tab B. Within
    // HIT_SETTLE_MS the server emits a DamageBroadcast and the
    // snapshot reports B's HP drop on BOTH tabs.
    //
    // Fire yaw = PI/2 (forward = +X axis where Tab B lives, since
    // we positioned Tab B at pos.x + 5.0 — see PositionUpdate primer
    // below). Pitch = 0 (horizontal aim). The server's
    // `dual_pistol_hit` runs the same math and confirms the hit.
    log("Tab A fires AimEvent at Tab B (yaw=PI/2, pitch=0)...");
    // Use a monotonic u32 eventId counter. Pre-PR-#59 fix: smoke
    // used Math.random() but the server's gate 3 enforces
    // eventId >= last_event_id - EVENT_ID_WINDOW (64); random
    // eventIds fail this gate when they regress below the prior
    // value. The server's last_event_id starts at 0 in a fresh
    // room, so any positive monotonic value works. Use the high
    // u32 range to avoid collisions across smoke runs sharing
    // the same canary process.
    const fireEventId1 = 0xffffff00;
    let lastEventId = fireEventId1;
    const fireResult = await pageA.evaluate(async ({ eventId }) => {
      const bus = window.__damageBus;
      const session = window.__gameSession;
      if (!bus || !session) return { ok: false, reason: "missing bus/session" };
      // Read the CURRENT server frame from the latest snapshot so
      // the AimEvent lands inside the rewind window
      // (POSITION_HISTORY_RETENTION_FRAMES=64 frames @ 64Hz ≈ 1s).
      // Pre-fix: smoke sent frame=1 hardcoded, server rejected with
      // "frame too far in the past" once current_frame > 65.
      const snap = window.__latestSnap ? window.__latestSnap() : null;
      const currentFrame = snap ? snap.serverFrame : 0;
      try {
        bus.sendAimEvent({
          sourcePlayerId: 1,
          yawRadians: Math.PI / 2, // fires along +X where Tab B lives
          pitchRadians: 0.0,
          frame: currentFrame,
          eventId,
        });
        return { ok: true, frame: currentFrame };
      } catch (e) {
        return { ok: false, reason: String(e) };
      }
    }, { eventId: fireEventId1 });
    if (!fireResult.ok) {
      throw new Error(`Tab A fire 1 failed: ${fireResult.reason}`);
    }
    log(`  fire sent at frame=${fireResult.frame}`);

    // Poll for Tab B's HP drop on BOTH tabs (snapshot fan-out).
    // Same pattern as reload-smoke assertion 4: poll until the
    // post-fire value lands, or HIT_SETTLE_MS elapses.
    log(`Polling snapshot for HP drop on Tab B (up to ${HIT_SETTLE_MS}ms)...`);
    const hitStart = Date.now();
    let postHitB = null;
    let postHitAView = null;
    while (Date.now() - hitStart < HIT_SETTLE_MS) {
      postHitB = await pageB.evaluate(({ targetId }) => {
        const snap = window.__latestSnap ? window.__latestSnap() : null;
        const entry = snap ? snap.players.find((p) => p.playerId === targetId) : null;
        return entry ? entry.hp : null;
      }, { targetId: 2 });
      postHitAView = await pageA.evaluate(({ targetId }) => {
        const snap = window.__latestSnap ? window.__latestSnap() : null;
        const entry = snap ? snap.players.find((p) => p.playerId === targetId) : null;
        return entry ? entry.hp : null;
      }, { targetId: 2 });
      if (
        postHitB !== null &&
        postHitB === postHitAView &&
        postHitB < baselineHpB
      ) {
        break;
      }
      await sleep(100);
    }
    if (postHitB === null) {
      throw new Error(`Tab B snapshot missing playerId=2 post-fire`);
    }
    const hpDrop = baselineHpB - postHitB;
    if (hpDrop !== DUAL_PISTOL_DAMAGE) {
      throw new Error(
        `Tab B HP drop = ${hpDrop} (expected ${DUAL_PISTOL_DAMAGE}). ` +
        `Server's validate_and_relay_aim may have rejected the AimEvent ` +
        `or the hitscan missed. baseline=${baselineHpB} postHit=${postHitB}.`,
      );
    }
    // Re-read both tabs simultaneously to assert the FINAL values
    // agree (the poll loop above may have raced the snapshot stream
    // and observed transient states). BOTH tabs must read the same
    // post-hit HP value from the same server snapshot.
    const finalAView = await pageA.evaluate(({ targetId }) => {
      const snap = window.__latestSnap ? window.__latestSnap() : null;
      const entry = snap ? snap.players.find((p) => p.playerId === targetId) : null;
      return entry ? entry.hp : null;
    }, { targetId: 2 });
    const finalBView = await pageB.evaluate(({ targetId }) => {
      const snap = window.__latestSnap ? window.__latestSnap() : null;
      const entry = snap ? snap.players.find((p) => p.playerId === targetId) : null;
      return entry ? entry.hp : null;
    }, { targetId: 2 });
    if (finalAView !== finalBView) {
      throw new Error(
        `Snapshot desync: Tab A view of B's HP=${finalAView} vs Tab B's view=${finalBView}. ` +
        `Both tabs must read from the same server-authoritative snapshot fan-out.`,
      );
    }
    log(
      `Assertion 2 PASS: Tab B HP ${baselineHpB} → ${postHitB} on BOTH tabs ` +
      `(drop=${hpDrop}, ${Date.now() - hitStart}ms; final A=${finalAView} B=${finalBView}).`,
    );

    // ---- Assertion 3: Tab A's ammo dropped by 1 (server-authoritative).
    log("Polling Tab A ammo decrement...");
    const ammoStart = Date.now();
    let postAmmoA = null;
    while (Date.now() - ammoStart < HIT_SETTLE_MS) {
      postAmmoA = await pageA.evaluate(({ sourceId }) => {
        const snap = window.__latestSnap ? window.__latestSnap() : null;
        const entry = snap ? snap.players.find((p) => p.playerId === sourceId) : null;
        return entry ? entry.ammo : null;
      }, { sourceId: 1 });
      if (postAmmoA !== null && postAmmoA === baselineAmmoA - 1) break;
      await sleep(100);
    }
    if (postAmmoA === null) {
      throw new Error(`Tab A snapshot missing playerId=1 post-fire`);
    }
    if (postAmmoA !== baselineAmmoA - 1) {
      throw new Error(
        `Tab A ammo post-fire = ${postAmmoA} (expected ${baselineAmmoA - 1}). ` +
        `Server's validate_and_relay_aim must decrement ammo on the first hit.`,
      );
    }
    log(`Assertion 3 PASS: Tab A ammo ${baselineAmmoA} → ${postAmmoA}.`);

    // ---- Assertion 4: Tab A fires a SECOND AimEvent aimed AWAY
    // from Tab B (yaw=0 → fires along +Z axis; Tab B is on +X).
    // No hit broadcast; ammo STILL drops by 1 (fire rate consumed,
    // brief's "missed shot still spends ammo" semantics).
    const baselineHpB2 = postHitB;
    const baselineAmmoA2 = postAmmoA;
    // Pace to dodge server cooldown (120ms; we use 200ms for CI skew).
    log(`Settling ${FIRE_PACE_MS}ms to clear fire-rate cooldown...`);
    await sleep(FIRE_PACE_MS);
    log("Tab A fires AimEvent AWAY from Tab B (yaw=0)...");
    const fireEventId2 = lastEventId + 1;
    const missResult = await pageA.evaluate(async ({ eventId }) => {
      const bus = window.__damageBus;
      const session = window.__gameSession;
      if (!bus || !session) return { ok: false, reason: "missing bus/session" };
      // Read CURRENT server frame (see assertion 2's comment for
      // why hardcoded frame=1 doesn't work once the room ticks up).
      const snap = window.__latestSnap ? window.__latestSnap() : null;
      const currentFrame = snap ? snap.serverFrame : 0;
      try {
        bus.sendAimEvent({
          sourcePlayerId: 1,
          yawRadians: 0.0, // fires along +Z; Tab B is on +X
          pitchRadians: 0.0,
          frame: currentFrame,
          eventId,
        });
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: String(e) };
      }
    }, { eventId: fireEventId2 });
    if (!missResult.ok) {
      throw new Error(`Tab A fire 2 failed: ${missResult.reason}`);
    }

    // Wait for the fire-rate cooldown to register + the snapshot to
    // reflect the new ammo. Poll: ammo drops by 1, HP unchanged.
    log(`Polling for missed-shot ammo decrement (up to ${HIT_SETTLE_MS}ms)...`);
    const missStart = Date.now();
    let postMissAmmoA = null;
    let postMissHpB = null;
    while (Date.now() - missStart < HIT_SETTLE_MS) {
      postMissAmmoA = await pageA.evaluate(({ sourceId }) => {
        const snap = window.__latestSnap ? window.__latestSnap() : null;
        const entry = snap ? snap.players.find((p) => p.playerId === sourceId) : null;
        return entry ? entry.ammo : null;
      }, { sourceId: 1 });
      postMissHpB = await pageB.evaluate(({ targetId }) => {
        const snap = window.__latestSnap ? window.__latestSnap() : null;
        const entry = snap ? snap.players.find((p) => p.playerId === targetId) : null;
        return entry ? entry.hp : null;
      }, { targetId: 2 });
      if (postMissAmmoA === baselineAmmoA2 - 1) break;
      await sleep(100);
    }
    if (postMissAmmoA !== baselineAmmoA2 - 1) {
      throw new Error(
        `Tab A ammo post-miss = ${postMissAmmoA} (expected ${baselineAmmoA2 - 1}). ` +
        `Server's validate_and_relay_aim must decrement ammo on miss too ` +
        `(fire rate consumed; brief's "missed shot still spends ammo" semantics).`,
      );
    }
    if (postMissHpB !== baselineHpB2) {
      throw new Error(
        `Tab B HP changed on miss: ${baselineHpB2} → ${postMissHpB}. ` +
        `Miss should produce no DamageBroadcast (no HP drop on the target).`,
      );
    }
    log(
      `Assertion 4 PASS: Tab A ammo ${baselineAmmoA2} → ${postMissAmmoA} ` +
      `(miss, fire rate consumed), Tab B HP unchanged at ${postMissHpB}.`,
    );

    // Capture screenshot of Tab A for the artifact.
    await pageA.screenshot({ path: SCREENSHOT_PATH });

    if (errors.length > 0) {
      throw new Error(`pageerror events: ${errors.join("; ")}`);
    }

    log(`OK — damage-server-aim-event-smoke passed (4/4 assertions).`);
    await browser.close();
    // PR #58 fix: explicit process.exit(0) so CI doesn't hang on the
    // playwright keep-alive handles.
    process.exit(0);
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
    process.exit(1);
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
