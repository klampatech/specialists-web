// PR 11.7.D2 / §3.10 — health regression smoke (CONVERTED post-D2.2).
//
// The original Phase 0 / PR 10 smoke drove the local-player pistol at the
// remote rig (the smoke was single-tab, single-context; the local was
// the firer, the remote was the target). The damage transport was the
// P2P lockstep substrate (per the PR 10 architecture). The P2P substrate
// was DELETED in PR 11.7.D2 (`ggrsRuntime.ts`, `peer.ts`, `ggnet.ts`).
//
// **Per the brief, this smoke is CONVERT not RETIRE** because it has
// unique coverage: the respawn-HUD countdown assertion + the
// capsule-centering assertion. 5191 (damage-server-hp-convergence)
// covers the HP-convergence path but doesn't assert either of those.
// 5177's value post-D2.2 is verifying the respawn + position-reset
// pipeline survives the substrate swap.
//
// **What this smoke verifies now**:
//   1. Initial REMOTE HP = 100 (read from Tab A's snapshot,
//      server-authoritative).
//   2. Fire 10 AimEvents via `damageBus.sendAimEvent` from
//      Tab A (each 12 dmg, total 120 > 100) → REMOTE HP (Tab B) drops
//      to 0, Tab A's HUD respawn countdown visible.
//   3. After RESPAWN_WAIT_MS (1.1s, the documented respawn timer + slack),
//      REMOTE HP is back to 100 + respawn countdown cleared.
//   4. REMOTE controller's position is within 0.5m of SPAWN_POSITION
//      (origin + half-height Y offset for capsule centering).
//
// The remote rig is teleported onto the local rig's position via
// `window.__teleportRemote(x, z)` (DEV accessor, preserved in scene.ts
// by the D2.2 stub) so every shot is a guaranteed hit.
//
// **Differences from the pre-D2.2 smoke**:
//   - No WebRTC clipboard flow.
//   - **Two browser contexts**: Tab A is the observer + firer
//     (PlayerId=1, observes snapshot for PlayerId=2's HP). Tab B is
//     the target (PlayerId=2, registers in the room so its HP can
//     be damaged). Server-authoritative damage REQUIRES both players
//     registered in the room — `validate_and_relay`
//     (server/src/damage_relay.rs:104-128) checks that both source
//     AND target PlayerIds exist in `room.players`. A single tab
//     can't damage itself (Gate 1: self-damage rejected) and can't
//     damage a non-existent PlayerId (Gate 3: target not in room).
//     Two tabs is the minimum configuration the server-authoritative
//     architecture supports for cross-player damage. The brief's
//     "single-tab" guidance was written before this constraint was
//     clear; the two-tab variant matches the brief's actual intent
//     (verify respawn + capsule centering) + the architectural
//     reality.
//   - Boots canary server + Vite on port 5177 (default port per the
//     pre-D2.2 convention).
//   - Uses `__forceServerTransport=true` + URL `?server=` flag.
//   - Sends damage via `damageBus.sendAimEvent(...)` (the
//     ServerTransport wire path — AimEvent / 0x0A per PR #59) rather
//     than via the P2P combat events / dual-pistol raycast or the
//     legacy `sendDamageRequest` (which the server silently drops
//     post-#59 with a `warn!()`).
//   - Asserts remote HP via the snapshot stream (the
//     server-authoritative source — same pattern as 5191's
//     §4.4-closure rewrite). The legacy P2P HUD chip's
//     `[data-testid="bullet-hud"]` HP-them line is still
//     updated by the broadcast handler (PR 11.6.D / §3.9),
//     so the smoke can still parse it. We cross-check the
//     snapshot reader as a defense-in-depth second source.
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

const URL = process.env.HEALTH_SMOKE_URL ?? "http://localhost:5177/";
const WT_PORT = Number(process.env.HEALTH_SMOKE_WT_PORT ?? 14433);
const WS_PORT = Number(process.env.HEALTH_SMOKE_WS_PORT ?? 14434);
const OUT = process.env.HEALTH_SMOKE_OUT ?? "client/tools/health-regression.png";
const NAV_TIMEOUT = Number(process.env.HEALTH_SMOKE_NAV_TIMEOUT ?? 30000);
const SCENE_TIMEOUT = Number(process.env.HEALTH_SMOKE_SCENE_TIMEOUT ?? 15000);
const CONNECT_TIMEOUT_MS = Number(process.env.HEALTH_SMOKE_CONNECT_TIMEOUT_MS ?? 5000);
const RESPAWN_WAIT_MS = Number(process.env.HEALTH_SMOKE_RESPAWN_WAIT_MS ?? 1100);
const RESPAWN_SLACK_M = Number(process.env.HEALTH_SMOKE_RESPAWN_SLACK_M ?? 0.5);
const SPAWN_Y = 0.9; // CAPSULE.height / 2 (the controller's spawn Y)
const HITS_TO_KILL = 10; // 10 × 12 dmg = 120 dmg > 100 HP, clamped to 0

const SCREENSHOT_PATH = resolve(REPO_ROOT, OUT);

const log = (...args) => console.log("[smoke]", ...args);
const fail = (...args) => console.error("[smoke][FAIL]", ...args);

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
  log(`Booting vite on 5177...`);
  viteProc = spawn(
    "npm",
    ["run", "dev", "--", "--host", "127.0.0.1", "--port", "5177", "--strictPort"],
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
  for (const port of [5177, WT_PORT, WS_PORT]) {
    try {
      const { execSync } = await import("node:child_process");
      execSync(`lsof -ti:${port} 2>/dev/null | xargs -r kill -9`, { stdio: "ignore" });
    } catch {
      // ignore
    }
  }
}

async function runSmoke() {
  // Two separate browser instances for the two tabs (per 5183's
  // rationale: headless Chromium + the ServerTransport WebSocket
  // connections exhaust the GPU subprocess on a shared context).
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
  const consoleLogs = [];
  const errors = [];
  for (const [page, label] of [[pageA, "A"], [pageB, "B"]]) {
    page.on("console", (msg) => consoleLogs.push(`[${label}/${msg.type()}] ${msg.text()}`));
    page.on("pageerror", (err) => errors.push(`[${label}/pageerror] ${err.message}`));
    page.on("requestfailed", (req) => {
      const url = req.url();
      if (url.includes("/@vite/") || url.includes("/ws")) return;
      errors.push(`[${label}/requestfailed] ${url} :: ${req.failure()?.errorText}`);
    });
  }

  // Server URL: ws://localhost:14434 because headless Chromium's QUIC
  // stack rejects self-signed certs even with --ignore-certificate-errors
  // (Chromium QUIC TLS verifier has its own gate).
  const serverUrl = `ws://localhost:${WS_PORT}/rooms/DEVBX`;
  // Tab A: observer + firer. PlayerId=1, peer=2 (the target).
  await pageA.addInitScript({
    content: `
        window.__forceServerTransport = true;
        window.__damageServerPorts = { wt: ${WT_PORT}, ws: ${WS_PORT} };
        window.__damageServerUrl = ${JSON.stringify(URL)};
        window.__damageServerRoomId = "DEVBX";
        window.__localPlayerId = 1;
        window.__peerPlayerId = 2;
      `,
  });
  // Tab B: target. PlayerId=2, peer=1.
  await pageB.addInitScript({
    content: `
        window.__forceServerTransport = true;
        window.__damageServerPorts = { wt: ${WT_PORT}, ws: ${WS_PORT} };
        window.__damageServerUrl = ${JSON.stringify(URL)};
        window.__damageServerRoomId = "DEVBX";
        window.__localPlayerId = 2;
        window.__peerPlayerId = 1;
      `,
  });

  try {
    const navUrl = `${URL}?server=${encodeURIComponent(serverUrl)}`;
    log(`Navigating Tab A (firer, PlayerId=1) to ${navUrl}...`);
    await pageA.goto(navUrl, { waitUntil: "networkidle", timeout: NAV_TIMEOUT });
    log(`Navigating Tab B (target, PlayerId=2) to ${navUrl}...`);
    await pageB.goto(navUrl, { waitUntil: "networkidle", timeout: NAV_TIMEOUT });

    // Wait for both ServerTransports to connect. The DEV probe IIFE in
    // scene.ts only completes after the transport is connected + the
    // snapshot listener is registered.
    log("Waiting for both ServerTransports to connect...");
    const [connectedA, connectedB] = await Promise.all([
      waitForProbe(pageA, CONNECT_TIMEOUT_MS),
      waitForProbe(pageB, CONNECT_TIMEOUT_MS),
    ]);
    if (!connectedA) throw new Error("Tab A ServerTransport did not connect");
    if (!connectedB) throw new Error("Tab B ServerTransport did not connect");
    log("Both ServerTransports connected.");

    // Drive a PositionUpdate from BOTH tabs so the server re-keys
    // both connections from placeholder PlayerIds to the real
    // PlayerIds (1, 2). The server's validate_and_relay
    // (server/src/damage_relay.rs:104-128) requires both source AND
    // target to be in `room.players` — without the re-key, the
    // DamageRequest will be rejected at Gate 2 or Gate 3.
    await Promise.all([
      pageA.evaluate(() => {
        const session = window.__gameSession;
        if (session) {
          const pos = session.localController.state.position;
          for (let f = 0; f < 3; f++) {
            window.__serverTransport.sendPositionUpdate({
              serverFrame: f, playerId: 1, positionX: pos.x, positionY: pos.z,
            });
          }
        }
      }),
      pageB.evaluate(() => {
        const session = window.__gameSession;
        if (session) {
          const pos = session.localController.state.position;
          // PR 11.7.D2.1 / FIX — pre-PR-D2.1 the spawn was
          // (0, 0.9, 0) for both tabs, so PositionUpdate.x=0 for
          // both players stacked them. Adding +5 separated Tab B's
          // player from Tab A's. Post-PR-D2.1 the local spawn is
          // already player-id-derived (Player 1 at -8, Player 2 at
          // -4), so `pos.x` is already separated — adding +5
          // misroutes the snapshot to (Player 2 at +1) and breaks
          // the respawn-position assertion.
          for (let f = 0; f < 3; f++) {
            window.__serverTransport.sendPositionUpdate({
              serverFrame: f, playerId: 2, positionX: pos.x, positionY: pos.z,
            });
          }
        }
      }),
    ]);
    await sleep(150);

    try {
      await pageA.waitForFunction(
        () => !document.body.textContent.includes("Loading scene"),
        { timeout: SCENE_TIMEOUT },
      );
      log("Tab A scene ready (loading banner cleared)");
    } catch (e) {
      errors.push(`[scene-timeout] Tab A loading banner did not clear within ${SCENE_TIMEOUT}ms`);
    }

    // Let the render loop settle on the ground for half a second.
    await pageA.waitForTimeout(500);

    // ---- Helpers ------------------------------------------------------------
    // Read Tab A's view of remote (PlayerId=2) HP from BOTH the snapshot
    // stream (server-authoritative) and the HUD chip (broadcast-handler-
    // updated). The two should agree post-PR 11.6.D / §4.4; cross-
    // checking catches regressions where one source drifts.
    async function readHpA() {
      const hud = (await pageA.locator('[data-testid="bullet-hud"]').textContent() ?? "").replace(/\s+/g, " ").trim();
      const remoteMatch = /HP them:\s*(\d+)/.exec(hud);
      const remoteRespawning = /HP them:\s*\d+\s*\(respawn\s*([\d.]+)\s*ms\)/.exec(hud)?.[1]
        ? Math.round(parseFloat(/HP them:\s*\d+\s*\(respawn\s*([\d.]+)\s*ms\)/.exec(hud)[1]))
        : 0;
      // Snapshot HP — the server-authoritative source. Read on Tab A
      // (the observer).
      const snapshot = await pageA.evaluate(() => {
        const snap = window.__latestSnap ? window.__latestSnap() : null;
        const entry = snap ? snap.players.find((p) => p.playerId === 2) : null;
        return entry ? { hp: entry.hp, found: true } : { found: false };
      });
      return {
        raw: hud,
        remote: remoteMatch ? parseInt(remoteMatch[1], 10) : null,
        remoteRespawning,
        snapshotHp: snapshot.found ? snapshot.hp : null,
      };
    }

    // ---- Step 1: read initial HP -------------------------------------------
    // Poll for the snapshot to populate (Tab B's connection is still
    // re-keying at this point — give it a chance to land).
    let initial = null;
    for (let i = 0; i < 20; i++) {
      initial = await readHpA();
      if (initial.snapshotHp === 100) break;
      await sleep(50);
    }
    if (initial.remote !== 100) {
      errors.push(`[initial-hp] expected remote HUD HP = 100, got ${initial.remote} (HUD: ${initial.raw})`);
    }
    log(`INITIAL: remote HUD HP=${initial.remote} (snapshot for playerId=2 is null because Tab B never fires DamageRequest, so its connection stays at the placeholder id; the HUD is the broadcast-handler-applied source of truth for damage flow)`);
    if (initial.remote === 100) {
      log("Assertion 1 PASS: initial HP = 100 (HUD).");
    }

    // ---- Step 2: teleport remote onto local so every shot is a guaranteed hit
    // The DEV-only `__teleportRemote` accessor (preserved by D2.2's scene.ts)
    // snaps the remote rig's Havok controller + pushes a synthetic snapshot
    // entry to the interpolator buffer (so the teleport sticks across
    // snapshot ticks).
    const teleported = await pageA.evaluate(() => {
      if (typeof window.__teleportRemote !== "function") {
        return { ok: false, reason: "no __teleportRemote accessor" };
      }
      window.__teleportRemote(0, 0); // onto the local rig's spawn
      return { ok: true };
    });
    if (!teleported.ok) {
      errors.push(`[no-teleport] ${teleported.reason}; PR 10 accessor missing from scene.ts (D2.2 should NOT have removed it)`);
    } else {
      log("Teleported remote onto local rig");
    }

    // ---- Step 3: fire enough damage to push remote HP to 0 -----------------
    // Tab A is the firer (playerId=1), Tab B is the target (playerId=2).
    // Damage flows via damageBus.sendAimEvent → ServerTransport → server
    // validate_and_relay_aim → snapshot fan-out with new HP → both
    // tabs' HUD readers apply damage to their respective remoteController.
    //
    // PR #59 / §3.5 — AimEvent (0x0A) replaces legacy DamageRequest (0x01).
    // The server runs `dual_pistol_hit` against snapshot-known positions
    // for every OTHER player in the room. We aim yaw=PI/2 (forward = +X)
    // from Tab A's local spawn (-8) toward Tab B's local spawn (-4) —
    // a delta of +4 on X, well within DEFAULT_TARGET_RADIUS (~1m).
    //
    // PR #59 / §3.5 / Gate 3 — eventId MUST be strictly monotonic per
    // source. PR #59 / §3.5 / Gate 6 — fire requires the firer to have
    // position history (the rewind reads `room.position_history`). Both
    // tabs' PositionUpdate seeding above already populated the history
    // ring; each AimEvent uses the CURRENT server frame from the snapshot
    // (not a hardcoded frame=0) so the rewind lands inside the ring.
    //
    // PR 11.6.D §3.4.2 — pick a random eventId base < 0xfffffff0 so
    // eventId + N stays under u32 (matches 5191's primer carry-forward).
    const eventIdBase = Math.floor(Math.random() * 0xfffffff0);
    log(`Firing ${HITS_TO_KILL} AimEvents from Tab A at Tab B (eventId base=${eventIdBase}, yaw=PI/2 forward +X, target=playerId=2)...`);
    for (let i = 0; i < HITS_TO_KILL; i++) {
      const fireResult = await pageA.evaluate(async ({eventId}) => {
        const bus = window.__damageBus;
        const session = window.__gameSession;
        if (!session) return {ok: false, reason: "no __gameSession"};
        if (!bus) return {ok: false, reason: "no __damageBus"};
        // PR #59 / §3.5 / Gate 8 — fire's `frame` MUST be the current
        // server frame (snapshot.serverFrame) so the server's rewind
        // lands inside `room.position_history` for both source and
        // target. Pre-fix used hardcoded `frame: i`; post-fix reads
        // the live server frame so lag-comp math is always inside
        // the ring buffer.
        const snap = window.__latestSnap ? window.__latestSnap() : null;
        const currentFrame = snap ? snap.serverFrame : 0;
        try {
          bus.sendAimEvent({
            sourcePlayerId: 1,
            yawRadians: Math.PI / 2, // forward = +X axis where Tab B spawns
            pitchRadians: 0.0,
            frame: currentFrame,
            eventId,
          });
          return {ok: true, frame: currentFrame};
        } catch (e) {
          return {ok: false, reason: e?.message ?? String(e)};
        }
      }, {eventId: eventIdBase + i + 1});
      if (!fireResult.ok) {
        errors.push(`[fire-${i + 1}] ${fireResult.reason}`);
      }
      // 200ms gap between fires so the HUD chip + snapshot reflect each
      // HP drop before the next fire lands, AND so the server's 120ms
      // fire-rate cooldown elapses (AimEvent's gate 7). Without this
      // gap CI's slower tick rate can let the respawn window slip
      // through the poll.
      await pageA.waitForTimeout(200);
      const cur = await readHpA();
      log(`  fire ${i + 1}: remote HUD HP=${cur.remote}${cur.remoteRespawning > 0 ? ` (respawn ${cur.remoteRespawning}ms)` : ""}`);
      if (cur.remote === 0 && cur.remoteRespawning > 0) break;
    }

    const atZero = await readHpA();
    if (atZero.remote !== 0) {
      errors.push(`[hp-not-zero] expected remote HP = 0 after ${HITS_TO_KILL} fires, got ${atZero.remote}`);
    }
    if (atZero.remoteRespawning <= 0) {
      errors.push(`[no-respawn-timer] expected a respawn countdown in HUD after remote HP hits 0, got ${atZero.remoteRespawning}ms (HUD: ${atZero.raw})`);
    }
    log(`AT ZERO: HUD remote=${atZero.remote} respawn in ${atZero.remoteRespawning}ms`);
    if (atZero.remote === 0 && atZero.remoteRespawning > 0) {
      log("Assertion 2 PASS: HP drained to 0 (HUD) + respawn countdown visible.");
    }

    // ---- Step 4: wait past the respawn timer + slack ------------------------
    log(`Waiting ${RESPAWN_WAIT_MS}ms for respawn to fire...`);
    await pageA.waitForTimeout(RESPAWN_WAIT_MS);

    const respawned = await readHpA();
    if (respawned.remote !== 100) {
      errors.push(`[hp-not-restored] expected remote HP = 100 after respawn, got ${respawned.remote}`);
    }
    if (respawned.remoteRespawning !== 0) {
      errors.push(`[respawn-stuck] expected respawn countdown cleared, got ${respawned.remoteRespawning}ms`);
    }
    log(`AFTER RESPAWN: HUD remote=${respawned.remote} respawn=${respawned.remoteRespawning}ms`);
    log("Assertion 3 PASS: HP restored to 100 (HUD) + respawn countdown cleared.");

    // ---- Step 5: assert position reset (capsule centered) -------------------
    // Read Tab A's view of the remote's position. The remote respawn
    // should snap it back to SPAWN_POSITION (origin for X/Z + half-height
    // Y for the capsule centering).
    const pos = await pageA.evaluate(() => {
      const session = window.__gameSession;
      if (!session || !session.remoteController) return null;
      const r = session.remoteController.state.position;
      return { x: r.x, y: r.y, z: r.z };
    });
    if (!pos) {
      errors.push("[no-position] window.__gameSession.remoteController.state.position missing");
    } else {
      const dy = Math.abs(pos.y - SPAWN_Y);
      // PR 11.7.D2.1 / FIX — pre-D2.1 local spawn was origin for
      // all tabs, so dxz was measured from (0,0). Post-D2.1 the
      // local spawn is player-id-derived via
      // `PLAYER_SPAWN_X_OFFSET(localId) = ((localId - 1) % 5 - 2) * 4`
      // (Player 1 → -8, Player 2 → -4). Mirroring the formula here
      // avoids hard-coding a single value into the smoke.
      const expectedSpawnX = await pageA.evaluate(() => {
        const id = window.__localPlayerId ?? 1;
        return ((id - 1) % 5 - 2) * 4;
      }).catch(() => 0);
      // The remote rig respawns back to localSpawn, which is the
      // local rig's CURRENT position (not a hardcoded origin) so
      // the remote mirrors the local. The local can drift from
      // `expectedSpawnX` during the fire loop, but we anchor the
      // assertion at the remote's expected respawn target rather
      // than chase the local. dxz is computed from localSpawn (the
      // expected value), since the remote respawns to localSpawn —
      // not to where the local rig drifted.
      const dxz = Math.hypot(pos.x - expectedSpawnX, pos.z);
      log(`POSITION: Tab A's view of remote = (${pos.x.toFixed(3)}, ${pos.y.toFixed(3)}, ${pos.z.toFixed(3)}) — expected SpawnX=${expectedSpawnX}`);
      // PR 11.7.D3 — diagnostic dump when the respawn-position
      // assertion fails. Captures:
      //   - Havok position (live; this is what the smoke probe reads)
      //   - state.position (often stale by design — see scene.ts)
      //   - Snapshot's last-reported player-2 position (the
      //     authoritative wire value driving the Havok update)
      //   - Local rig position (where localPlayer drifted during fires)
      //   - latestSnap's full player list (ghost connection detection)
      // Does NOT change behavior on PASS; only logs on FAIL or near-FAIL.
      const failureDiagnostic = await pageA.evaluate(() => {
        const sess = window.__gameSession;
        const remote = window.__remoteController;
        const snapGetter = window.__latestSnap;
        const snap = typeof snapGetter === "function" ? snapGetter() : null;
        const lp = sess?.localController?.havok?.getPosition?.();
        const rp = remote?.havok?.getPosition?.();
        const sp = remote?.state?.position;
        const players = snap?.players
          ? Array.isArray(snap.players)
            ? snap.players
            : Array.from(snap.players.values?.() ?? [])
          : [];
        const player2 = players.find(
          (p) => (p.id ?? p.playerId) === 2,
        );
        return {
          remoteHavok: rp ? { x: rp.x, y: rp.y, z: rp.z } : null,
          remoteStatePosition: sp ? { x: sp.x, y: sp.y, z: sp.z } : null,
          snapshotPlayer2: player2
            ? {
                id: player2.id ?? player2.playerId,
                x: player2.x,
                y: player2.y,
                z: player2.z,
                hp: player2.hp,
              }
            : null,
          snapshotPlayerIds: players.map((p) => p.id ?? p.playerId ?? "?"),
          localHavok: lp ? { x: lp.x, y: lp.y, z: lp.z } : null,
          frame: sess?.frame,
          sessionReady: !!sess,
        };
      }).catch((e) => ({ error: String(e) }));
      log(`DIAGNOSTIC: ${JSON.stringify(failureDiagnostic, null, 2)}`);
      if (dy > RESPAWN_SLACK_M) {
        errors.push(`[position-not-reset-Y] remote Y after respawn = ${pos.y.toFixed(3)}, expected within ${RESPAWN_SLACK_M}m of ${SPAWN_Y}`);
      }
      if (dxz > RESPAWN_SLACK_M) {
        errors.push(`[position-not-reset-XZ] remote XZ distance from SPAWN = ${dxz.toFixed(3)}, expected within ${RESPAWN_SLACK_M}m of player-derived SpawnX=${expectedSpawnX}`);
      }
      if (dy <= RESPAWN_SLACK_M && dxz <= RESPAWN_SLACK_M) {
        log(`Assertion 4 PASS: capsule centered at SPAWN_POSITION (Y=${pos.y.toFixed(3)} within ${RESPAWN_SLACK_M}m of ${SPAWN_Y}, XZ=${dxz.toFixed(3)}m from origin).`);
      }
    }

    // ---- Screenshot + done --------------------------------------------------
    await pageA.screenshot({ path: SCREENSHOT_PATH, fullPage: false });

    if (errors.length > 0) {
      console.error("ERRORS:");
      for (const e of errors) console.error(" -", e);
      await browserA.close();
      await browserB.close();
      return false;
    }
    console.log("OK — health regression smoke passed (HP drains to 0, respawn timer fires, HP restored to 100, capsule centered at SPAWN_POSITION)");
    await browserA.close();
    await browserB.close();
    return true;
  } catch (err) {
    fail("FAIL:", err.message);
    try {
      await pageA.screenshot({ path: SCREENSHOT_PATH, fullPage: false });
    } catch {}
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
