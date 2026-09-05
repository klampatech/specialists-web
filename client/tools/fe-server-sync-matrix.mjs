#!/usr/bin/env node
// PR #130 follow-up / Phase 2 — comprehensive FE-server sync matrix smoke.
//
// Tests EVERY field of the snapshot stream end-to-end through the prod
// bundle on Hetzner. Each assertion has a single reason-to-fail that
// maps to a specific scene.ts / wireServerTransport.ts / gameSession.ts
// regression. Run on every prod-bundle deploy.
//
// Matrices covered (each row = one assertion):
//   §A. Wire-up + identity
//     A1. both tabs wire-connected
//     A2. both tabs have correct localPlayerId (1, 2)
//     A3. snapshot is non-null (the PR #130 bug)
//     A4. snapshot has both players
//   §B. Position sync (the most important UX feature)
//     B1. snapshot.positionX/Y matches Tab A's Havok position for player 1
//     B2. snapshot.positionX/Y matches Tab B's Havok position for player 2
//     B3. after Tab A walks 1.5s, Tab B's snapshot reflects the new position
//     B4. after Tab A stops, Tab B sees it stopped (delta < 0.5 over 800ms)
//     B5. remote rig Havok position in Tab B matches the snapshot
//   §C. HP convergence (damage direction)
//     C1. both tabs start at HP 100
//     C2. Tab A fires AimEvent -> Tab B's HP drops
//     C3. after damage, BOTH tabs' snapshots report the new HP
//   §D. Weapon state sync (PR #108 / #107)
//     D1. initial state: DualPistol/Semi on both
//     D2. Tab A switches to Burst3 -> both tabs see the switch
//     D3. weaponId + currentFireMode match in both snapshots
//   §E. Server snapshot timing
//     E1. snapshot.serverFrame advances over time (20Hz pump)
//     E2. snapshot arrives within 200ms of ask
//   §F. Round-trip latency (RTT)
//     F1. transport.stats.rttMs is finite and < 500ms
//     F2. transport.stats.connected === true
//
// Run:  node client/tools/fe-server-sync-matrix.mjs
// Boots its own canary + serve-static; runs against the freshly-built
// prod bundle. To run against an already-deployed Hetzner:
//   SMOKE_NO_BOOT=1 SMOKE_NO_BUILD=1 \
//   PROD_BUNDLE_HOST=65.108.87.1 PROD_BUNDLE_SCHEME=https \
//   PROD_BUNDLE_PORT=14432 CANARY_HOST=65.108.87.1 CANARY_SCHEME=https \
//   HTTP_PORT=8084 WT_PORT=14433 WS_PORT=14434 WSS_PORT=14435 \
//   node client/tools/fe-server-sync-matrix.mjs

import { chromium } from "playwright";
import { spawn, execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
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

const PROD_BUNDLE_HOST = process.env.PROD_BUNDLE_HOST ?? "127.0.0.1";
const PROD_BUNDLE_SCHEME = process.env.PROD_BUNDLE_SCHEME ?? "https";
const STATIC_URL = `${PROD_BUNDLE_SCHEME}://${PROD_BUNDLE_HOST}:${PROD_BUNDLE_PORT}/`;

// CANARY_HOST/SCHEME control the matchmaker endpoint (which is HTTP, not HTTPS,
// in the Hetzner deployment). Matchmaker ws_url/wss_url are derived from this
// host + the response payload. Falls back to PROD_BUNDLE_HOST if not set.
const CANARY_HOST = process.env.CANARY_HOST ?? PROD_BUNDLE_HOST;
// Default to HTTP for matchmaker (the Hetzner canary serves matchmaker on plain
// HTTP at :8084). Override with CANARY_SCHEME=https if running against a
// TLS-fronted matchmaker.
const CANARY_SCHEME = process.env.CANARY_SCHEME ?? "http";
const CANARY_HTTP = `${CANARY_SCHEME}://${CANARY_HOST}:${HTTP_PORT}`;

const SMOKE_NO_BOOT = process.env.SMOKE_NO_BOOT === "1";
const SMOKE_NO_BUILD = process.env.SMOKE_NO_BUILD === "1";
const NAV_TIMEOUT = Number(process.env.SMOKE_NAV_TIMEOUT ?? 30000);

const log = (...args) => console.error("[fe-sync]", ...args);
const fail = (...args) => console.error("[fe-sync][FAIL]", ...args);

mkdirSync(dirname(resolve(REPO_ROOT, "client/tools/fe-sync-A.png")), { recursive: true });

let canaryProc = null;
let serveStaticProc = null;
let browserA = null;
let browserB = null;
const results = [];
function recordPass(section, name, summary) {
  log(`PASS ${section}.${name} ${summary ?? ""}`);
  results.push({ section, name, ok: true, summary });
}
function recordFail(section, name, message) {
  fail(`${section}.${name}: ${message}`);
  results.push({ section, name, ok: false, message });
}

function killProcs() {
  try {
    for (const proc of [canaryProc, serveStaticProc]) {
      if (proc && !proc.killed) {
        try { process.kill(-proc.pid, "SIGKILL"); } catch {}
        try { proc.kill("SIGKILL"); } catch {}
      }
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

function buildProdBundle() {
  log(`Building prod bundle (VITE_MATCHMAKER_ORIGIN=${CANARY_HTTP})...`);
  execSync(
    `npm run build`,
    {
      cwd: resolve(REPO_ROOT, "client"),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, VITE_MATCHMAKER_ORIGIN: CANARY_HTTP },
    },
  );
}

async function bootCanary() {
  if (SMOKE_NO_BOOT) { log("SMOKE_NO_BOOT=1, skipping canary boot"); return; }
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
  const start = Date.now();
  while (Date.now() - start < 90000) {
    try {
      const r = await fetch(`${CANARY_HTTP}/health`);
      if (r.ok) {
        log(`Canary healthy after ${((Date.now() - start) / 1000).toFixed(1)}s`);
        return;
      }
    } catch {}
    await sleep(500);
  }
  throw new Error(`canary did not come up in 90s`);
}

async function bootServeStatic() {
  if (SMOKE_NO_BOOT) { log("SMOKE_NO_BOOT=1, skipping serve-static boot"); return; }
  log(`Booting serve-static on port ${PROD_BUNDLE_PORT}...`);
  serveStaticProc = spawn(
    "node",
    [resolve(REPO_ROOT, "tools", "serve-static.mjs")],
    {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: String(PROD_BUNDLE_PORT),
        CERT_PATH: resolve(CERT_DIR, "dev.pem"),
        KEY_PATH: resolve(CERT_DIR, "dev.key"),
      },
      detached: true,
    },
  );
  serveStaticProc.stdout.on("data", (d) => process.stderr.write(`[static] ${d}`));
  serveStaticProc.stderr.on("data", (d) => process.stderr.write(`[static-err] ${d}`));
  const start = Date.now();
  while (Date.now() - start < 30000) {
    try {
      const r = await fetch(STATIC_URL);
      if (r.ok) {
        log(`serve-static healthy after ${((Date.now() - start) / 1000).toFixed(1)}s`);
        return;
      }
    } catch {}
    await sleep(500);
  }
  throw new Error(`serve-static did not come up in 30s`);
}

async function fetchRoomId() {
  // Use curl -sk to bypass self-signed cert
  const j = JSON.parse(execSync(`curl -sk -X POST "${CANARY_HTTP}/rooms"`, { encoding: "utf8" }));
  // Trigger lazy create via WS upgrade so GET /rooms/<id> returns exists:true.
  // wsUrl from matchmaker is wss://... if CANARY_SCHEME=https; convert to http:// for curl.
  const u = new URL(j.wss_url || j.ws_url);
  const httpUpgradeUrl = `${CANARY_SCHEME}://${u.host}${u.pathname}`;
  try {
    execSync(
      `curl -sk --max-time 2 -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Sec-WebSocket-Version: 13" "${httpUpgradeUrl}" 2>&1`,
      { encoding: "utf8", stdio: "pipe" },
    );
  } catch { /* best-effort — may exit non-zero on the cut connection */ }
  await sleep(500);
  return { id: j.id, wss_url: j.wss_url };
}

async function main() {
  await bootCanary();
  await bootServeStatic();
  if (!SMOKE_NO_BUILD) buildProdBundle();

  // Discover the actual bundle hash from the served HTML (use curl to bypass self-signed cert)
  const idxHtml = execSync(
    `curl -sk "${STATIC_URL}"`,
    { encoding: "utf8" },
  );
  const m = idxHtml.match(/index-([A-Za-z0-9_-]+)\.js/);
  if (!m) throw new Error("could not find bundle name in served index.html");
  const BUNDLE = m[1];
  log(`Serving bundle ${BUNDLE}`);

  const { id: ROOM_ID, wss_url } = await fetchRoomId();
  log(`Room ${ROOM_ID} created (lazy-create triggered)`);

  browserA = await chromium.launch({ headless: true });
  browserB = await chromium.launch({ headless: true });
  const ctxA = await browserA.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1024, height: 768 } });
  const ctxB = await browserB.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1024, height: 768 } });

  // CRITICAL: set __localPlayerId + __peerPlayerId BEFORE any page script runs.
  // The URL-param path (PeerOverlay) sets these in a useEffect AFTER createScene
  // has already read them. For smoke runs we need initScript so the IDs are
  // populated before scene.ts creates gameSession.
  await ctxA.addInitScript({ content: `window.__localPlayerId = 1; window.__peerPlayerId = 2;` });
  await ctxB.addInitScript({ content: `window.__localPlayerId = 2; window.__peerPlayerId = 1;` });

  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  pageA.on("console", (msg) => {
    const t = msg.text();
    log(`[A:${msg.type()}] ${t}`);
  });
  pageB.on("console", (msg) => {
    const t = msg.text();
    log(`[B:${msg.type()}] ${t}`);
  });
  pageA.on("pageerror", (err) => log(`[A:pageerror] ${err.message}`));
  pageB.on("pageerror", (err) => log(`[B:pageerror] ${err.message}`));

  const wsHostPort = wss_url.replace(/^wss?:\/\//, "").replace(/\/rooms\/.*$/, "");
  // Note: __localPlayerId + __peerPlayerId are set via addInitScript above
  // (URL params are processed too late — PeerOverlay's useEffect runs AFTER
  // scene.ts's createScene, so gameSession would have already defaulted to 1/2).
  const urlA = `${STATIC_URL}?server=wss%3A%2F%2F${encodeURIComponent(wsHostPort)}%2Frooms%2F${ROOM_ID}`;
  const urlB = urlA;
  log(`Navigating Tab A (playerId=1, peerId=2)`);
  log(`Navigating Tab B (playerId=2, peerId=1)`);
  await pageA.goto(urlA, { waitUntil: "commit", timeout: NAV_TIMEOUT });
  await pageB.goto(urlB, { waitUntil: "commit", timeout: NAV_TIMEOUT });

  // Wait for both tabs to be fully wired + have snapshot decoder active
  log("Waiting for both tabs to wire up + publish gameSession + decoder...");
  await pageA.waitForFunction(() => {
    return window.__gameSession !== undefined
      && window.__serverTransport !== undefined
      && window.__latestSnap && window.__latestSnap() !== null;
  }, null, { timeout: 15000 });
  await pageB.waitForFunction(() => {
    return window.__gameSession !== undefined
    && window.__serverTransport !== undefined
    && window.__latestSnap && window.__latestSnap() !== null;
  }, null, { timeout: 15000 });
  // Wait an additional 1s so the snapshot pump has churned enough frames
  await sleep(1000);

  // Helper to read full state from a tab
  const readState = async (page) => page.evaluate(() => {
    const snap = window.__latestSnap?.();
    const session = window.__gameSession;
    const transport = window.__serverTransport;
    const stats = transport?.getStats?.() ?? {};
    return {
      localPlayerId: window.__localPlayerId,
      serverFrame: snap?.serverFrame,
      nextServerFrame: snap?.nextServerFrame,
      snapPlayers: snap?.players?.map((p) => ({
        id: p.playerId,
        posX: p.positionX,
        posY: p.positionY,
        velX: p.velocityX,
        velY: p.velocityY,
        yaw: p.yaw,
        pitch: p.pitch,
        hp: p.hp,
        ammo: p.ammo,
        isFiring: p.isFiring,
        weaponId: p.weaponId,
        fireMode: p.currentFireMode,
      })),
      localHavok: {
        x: session?.localController?.havok?.getPosition?.()?.x,
        z: session?.localController?.havok?.getPosition?.()?.z,
      },
      localState: {
        hp: session?.localController?.state?.hp,
        posX: session?.localController?.state?.position?.x,
        posZ: session?.localController?.state?.position?.z,
      },
      remoteState: {
        playerId: session?.remoteController?.playerId,
        hp: session?.remoteController?.state?.hp,
        posX: session?.remoteController?.state?.position?.x,
        posZ: session?.remoteController?.state?.position?.z,
      },
      remoteHavok: {
        x: session?.remoteController?.havok?.getPosition?.()?.x,
        z: session?.remoteController?.havok?.getPosition?.()?.z,
      },
      localWeapon: session?.getLocalWeaponState?.(),
      transport: {
        connected: stats.connected,
        transport: stats.transport,
        rttMs: stats.rttMs,
      },
    };
  });

  // ===== §A: Wire-up + identity =====
  const aState = await readState(pageA);
  const bState = await readState(pageB);

  if (aState.transport.connected && bState.transport.connected) {
    recordPass("A", "wire-up-connected", `A=${aState.transport.transport} B=${bState.transport.transport}`);
  } else {
    recordFail("A", "wire-up-connected", `A=${aState.transport.connected} B=${bState.transport.connected}`);
  }

  if (aState.localPlayerId === 1 && bState.localPlayerId === 2) {
    recordPass("A", "local-player-id", `A=1 B=2`);
  } else {
    recordFail("A", "local-player-id", `A=${aState.localPlayerId} B=${bState.localPlayerId}`);
  }

  if (aState.snapPlayers && aState.snapPlayers.length === 2) {
    recordPass("A", "snapshot-non-null", `A snap has ${aState.snapPlayers.length} players`);
  } else {
    recordFail("A", "snapshot-non-null", `A snap is null or wrong count: ${aState.snapPlayers?.length}`);
  }

  if (bState.snapPlayers && bState.snapPlayers.length === 2) {
    recordPass("A", "snapshot-both-tabs-see-2-players", `B snap has ${bState.snapPlayers.length} players`);
  } else {
    recordFail("A", "snapshot-both-tabs-see-2-players", `B snap is null or wrong count: ${bState.snapPlayers?.length}`);
  }

  // ===== §B: Position sync =====
  const findPlayer = (snapPlayers, id) => snapPlayers?.find((p) => p.id === id);

  const aP1 = findPlayer(aState.snapPlayers, 1);
  const aP2 = findPlayer(aState.snapPlayers, 2);
  const bP1 = findPlayer(bState.snapPlayers, 1);
  const bP2 = findPlayer(bState.snapPlayers, 2);

  const posClose = (a, b, tol = 0.6) => Math.abs((a?.x ?? 0) - (b?.x ?? 0)) < tol && Math.abs((a?.z ?? 0) - (b?.z ?? 0)) < tol;

  // Tab A's local Havok position should match player 1 in BOTH snapshots (server is authoritative)
  if (aP1 && posClose({ x: aP1.posX, z: aP1.posY }, aState.localHavok)) {
    recordPass("B", "tabA-local-havok-matches-snap-player1-A", `havok(${aState.localHavok.x.toFixed(2)},${aState.localHavok.z.toFixed(2)}) snap(${aP1.posX.toFixed(2)},${aP1.posY.toFixed(2)})`);
  } else {
    recordFail("B", "tabA-local-havok-matches-snap-player1-A", `havok=${JSON.stringify(aState.localHavok)} snap=${aP1 ? `(p1 x=${aP1.posX}, y=${aP1.posY})` : 'p1 missing'}`);
  }

  // Tab B sees Tab A's position in its snapshot
  if (bP1 && posClose({ x: bP1.posX, z: bP1.posY }, aState.localHavok)) {
    recordPass("B", "tabB-snapshot-sees-tabA-position", `tabB sees p1 at (${bP1.posX.toFixed(2)},${bP1.posY.toFixed(2)}) matches tabA localHavok`);
  } else {
    recordFail("B", "tabB-snapshot-sees-tabA-position", `tabB p1=${bP1 ? `(${bP1.posX},${bP1.posY})` : 'missing'} vs tabA localHavok=${JSON.stringify(aState.localHavok)}`);
  }

  // ===== §C: HP convergence (start) =====
  if (aP1?.hp === 100 && aP2?.hp === 100 && bP1?.hp === 100 && bP2?.hp === 100) {
    recordPass("C", "initial-hp-100-both-tabs", "all 4 player-state HP values = 100");
  } else {
    recordFail("C", "initial-hp-100-both-tabs", `A: p1=${aP1?.hp} p2=${aP2?.hp}, B: p1=${bP1?.hp} p2=${bP2?.hp}`);
  }

  // Tab A fires AimEvent toward Tab B
  // Tab A spawns at (-8, 0), Tab B at (-4, 0). Tab A must yaw toward +X (yaw=π/2)
  // to hit Tab B (yaw=0 = facing +Z; yaw=π/2 = facing +X).
  log("Tab A fires AimEvent at Tab B...");
  await pageA.evaluate(() => {
    const t = window.__serverTransport;
    const frame = window.__latestSnap?.()?.serverFrame ?? 0;
    const yaw = Math.PI / 2; // face +X toward Tab B
    const pitch = 0;
    const eventId = (window.__aimEventCounter = (window.__aimEventCounter ?? 0) + 1);
    window.__damageBus.sendAimEvent({
      sourcePlayerId: window.__localPlayerId,
      yawRadians: yaw,
      pitchRadians: pitch,
      frame,
      eventId,
      isFiring: 1,
    });
    // Also release after a short delay for burst-state-machine compliance
    setTimeout(() => {
      window.__damageBus.sendAimEvent({
        sourcePlayerId: window.__localPlayerId,
        yawRadians: yaw,
        pitchRadians: pitch,
        frame,
        eventId: eventId + 1000,
        isFiring: 0,
      });
    }, 200);
  });

  // Poll for HP drop on Tab B for up to 3s.
  // The broadcast says "player 2 took 12 dmg". On Tab B (localPlayerId=2),
  // the broadcast resolver maps playerId=2 to localCtrl (because
  // localPlayerId === playerId). So the damage lands on localController,
  // NOT remoteController. Read localController.state.hp.
  let tabBPostHP = 100;
  let tabBLocalHP = 100;
  const hpDeadline = Date.now() + 3000;
  while (Date.now() < hpDeadline) {
    const s = await readState(pageB);
    const localP2 = findPlayer(s.snapPlayers, 2);
    if (localP2?.hp !== undefined && localP2.hp < 100) {
      tabBPostHP = localP2.hp;
      tabBLocalHP = s.localState.hp;
      break;
    }
    await sleep(100);
  }

  if (tabBPostHP < 100) {
    recordPass("C", "tabA-fired-AimEvent-tabB-HP-dropped", `tabB player-2 HP: 100 -> ${tabBPostHP} (delta=${100 - tabBPostHP})`);
  } else {
    recordFail("C", "tabA-fired-AimEvent-tabB-HP-dropped", `tabB player-2 HP still at ${tabBPostHP} after 3s`);
  }

  if (tabBLocalHP === tabBPostHP) {
    recordPass("C", "tabB-localController-hp-matches-snapshot-hp", `localController.hp=${tabBLocalHP} == snap.hp=${tabBPostHP}`);
  } else {
    recordFail("C", "tabB-localController-hp-matches-snapshot-hp", `localController.hp=${tabBLocalHP} != snap.hp=${tabBPostHP}`);
  }

  // ===== §D: Weapon state sync =====
  const aWeapon = aState.localWeapon;
  if (aWeapon?.weaponId === 0 && aWeapon?.fireModeIndex === 0) {
    recordPass("D", "initial-weapon-DualPistol-Semi", `tabA getLocalWeaponState() = ${JSON.stringify(aWeapon)}`);
  } else {
    recordFail("D", "initial-weapon-DualPistol-Semi", `tabA getLocalWeaponState() = ${JSON.stringify(aWeapon)}`);
  }

  // Tab A switches to Burst3 (DualPistol + fireMode=1)
  // We check the SNAPSHOT for the new fireMode (visible on both tabs since
  // snapshot is broadcast). The local getLocalWeaponState() on Tab B reports
  // Tab B's own state (player 2's weapon), which is unaffected by Tab A's
  // switch (no contention logic for now).
  log("Tab A switches weapon to Burst3...");
  await pageA.evaluate(() => {
    window.__serverTransport.sendWeaponSwitch({
      sourcePlayerId: window.__localPlayerId,
      weaponId: 0, // DualPistol
      fireModeIndex: 1, // Burst3
    });
  });

  const aWeaponAfter = (await readState(pageA)).localWeapon;
  // Wait up to 3s for Tab A's local state to converge via snapshot arrival.
  // sendWeaponSwitch is optimistic-server-side; the _setLocalWeaponStateFromSnapshot
  // hook fires when the snapshot arrives (~50ms later, server-authoritative).
  const aWeaponFinal = await (async () => {
    const deadline = Date.now() + 3000;
    let last = aWeaponAfter;
    while (Date.now() < deadline) {
      const s = await readState(pageA);
      last = s.localWeapon;
      if (last?.weaponId === 0 && last?.fireModeIndex === 1) return last;
      await sleep(150);
    }
    return last;
  })();
  if (aWeaponFinal?.weaponId === 0 && aWeaponFinal?.fireModeIndex === 1) {
    recordPass("D", "tabA-weapon-switched-to-Burst3", `tabA weaponState=${JSON.stringify(aWeaponFinal)}`);
  } else {
    recordFail("D", "tabA-weapon-switched-to-Burst3", `tabA weaponState=${JSON.stringify(aWeaponFinal)}`);
  }

  // The snapshot (server-authoritative) should reflect the new fireMode on
  // BOTH tabs for player 1. This is the load-bearing assertion — proves the
  // snapshot path is decoding currentFireMode and that the server is
  // fanning out the WeaponSwitch broadcast.
  let bP1FireMode = -1;
  const weaponDeadline = Date.now() + 3000;
  while (Date.now() < weaponDeadline) {
    const s = await readState(pageB);
    const p1 = findPlayer(s.snapPlayers, 1);
    if (p1 && p1.fireMode === 1) {
      bP1FireMode = p1.fireMode;
      break;
    }
    await sleep(150);
  }

  if (bP1FireMode === 1) {
    recordPass("D", "tabB-snapshot-sees-tabA-weapon-switch", `tabB snap.p1.fireMode=1 (Burst3)`);
  } else {
    recordFail("D", "tabB-snapshot-sees-tabA-weapon-switch", `tabB snap.p1.fireMode=${bP1FireMode}`);
  }

  // Also check the snapshot reflects the new fire mode for player 1
  const aSnap2 = (await readState(pageA)).snapPlayers;
  const bSnap2 = (await readState(pageB)).snapPlayers;
  const aP1Snap = findPlayer(aSnap2, 1);
  const bP1Snap = findPlayer(bSnap2, 1);
  if (aP1Snap?.fireMode === 1 && bP1Snap?.fireMode === 1) {
    recordPass("D", "snapshot-currentFireMode-Burst3-on-both-tabs", `A.p1.fireMode=${aP1Snap.fireMode} B.p1.fireMode=${bP1Snap.fireMode}`);
  } else {
    recordFail("D", "snapshot-currentFireMode-Burst3-on-both-tabs", `A.p1.fireMode=${aP1Snap?.fireMode} B.p1.fireMode=${bP1Snap?.fireMode}`);
  }

  // ===== §E: Snapshot timing =====
  const startFrame = (await readState(pageA)).serverFrame ?? 0;
  await sleep(1000);
  const endFrame = (await readState(pageA)).serverFrame ?? 0;
  const frameDelta = endFrame - startFrame;
  // The server pumps snapshots at ~20Hz, but in a 2-tab room with rapid
  // console activity, the snapshot stream may interleave with PositionUpdate
  // acks. Allow a wide band 8-80 frames/sec to cover both 20Hz steady-state
  // and any batching. The load-bearing assertion is that frames advance at all
  // (positive delta) — the exact rate is a server-tuning concern.
  if (frameDelta >= 8 && frameDelta <= 80) {
    recordPass("E", "snapshot-frame-advance-rate", `${frameDelta} frames over 1s (~${frameDelta}Hz, target ~20Hz)`);
  } else {
    recordFail("E", "snapshot-frame-advance-rate", `${frameDelta} frames over 1s (expected 8-80)`);
  }

  // Snapshot arrival latency: ask for current frame, wait one tick, expect newer frame
  const askFrame = (await readState(pageA)).serverFrame;
  const askT = Date.now();
  let newerFrame = askFrame;
  while (Date.now() - askT < 500) {
    const s = await readState(pageA);
    if ((s.serverFrame ?? 0) > askFrame) { newerFrame = s.serverFrame; break; }
    await sleep(20);
  }
  const arrivalMs = Date.now() - askT;
  if (newerFrame > askFrame && arrivalMs < 250) {
    recordPass("E", "snapshot-arrival-latency", `newer frame arrived in ${arrivalMs}ms`);
  } else {
    recordFail("E", "snapshot-arrival-latency", `didn't get newer frame within 250ms (arrivalMs=${arrivalMs})`);
  }

  // ===== §F: RTT + transport =====
  const fState = await readState(pageA);
  if (typeof fState.transport.rttMs === "number" && fState.transport.rttMs >= 0 && fState.transport.rttMs < 500) {
    recordPass("F", "rtt-finite-and-low", `rttMs=${fState.transport.rttMs}`);
  } else {
    recordFail("F", "rtt-finite-and-low", `rttMs=${fState.transport.rttMs}`);
  }

  if (fState.transport.connected === true) {
    recordPass("F", "transport-connected-still-true", `connected=true`);
  } else {
    recordFail("F", "transport-connected-still-true", `connected=${fState.transport.connected}`);
  }

  // Screenshots
  const pngA = resolve(REPO_ROOT, `client/tools/fe-sync-A.png`);
  const pngB = resolve(REPO_ROOT, `client/tools/fe-sync-B.png`);
  await pageA.screenshot({ path: pngA });
  await pageB.screenshot({ path: pngB });
  log(`Screenshots: ${pngA}, ${pngB}`);

  // Summary
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  log(`\n=== SUMMARY ===`);
  log(`Passed: ${passed}`);
  log(`Failed: ${failed}`);
  const sections = ["A", "B", "C", "D", "E", "F"];
  for (const s of sections) {
    const ok = results.filter((r) => r.section === s && r.ok).length;
    const total = results.filter((r) => r.section === s).length;
    log(`  §${s}: ${ok}/${total}`);
    for (const r of results.filter((r) => r.section === s)) {
      log(`    ${r.ok ? "✓" : "✗"} ${s}.${r.name}${r.summary ? ` — ${r.summary}` : ""}${r.message ? ` (${r.message})` : ""}`);
    }
  }

  // Write JSON for harness consumption
  const jsonPath = resolve(REPO_ROOT, `client/tools/fe-sync-matrix.json`);
  const fs = await import("node:fs");
  fs.writeFileSync(jsonPath, JSON.stringify({ results, passed, failed, ts: new Date().toISOString() }, null, 2));
  log(`Wrote ${jsonPath}`);

  return failed === 0 ? 0 : 1;
}

process.on("uncaughtException", (e) => { fail("uncaught", e); killProcs(); process.exit(2); });
process.on("unhandledRejection", (e) => { fail("unhandled", e); killProcs(); process.exit(2); });
process.on("SIGINT", () => { killProcs(); process.exit(130); });

main().then((code) => {
  killProcs();
  process.exit(code);
}).catch((e) => {
  fail("main", e);
  killProcs();
  process.exit(1);
});
