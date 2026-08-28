// PR 11.7.D2.1 / §3.10 — TWO-TAB MANUAL FLOW smoke.
//
// Replicates Kyle's manual 2-tab verification flow on a Tailscale-
// connected pair of tabs. Distinct from `damage-server-hp-convergence`
// (5191) in scope: 5191 only asserts HP convergence via the
// server-authoritative damage path. THIS smoke asserts the
// **manual-flow user-experience**:
//
//   1. Both tabs open at the canonical Tailscale URLs.
//   2. Both tabs connect to the same room (sanity).
//   3. Snapshots arrive on both tabs with [player1, player2] (no
//      ghost entries — clean room state).
//   4. Both rigs render in both tabs (FOV check via mesh-enabled
//      state + mesh-position divergence).
//   5. Tab A fires damage; BOTH tabs' HP chips reflect the drop
//      (cross-tab broadcast routing).
//   6. Tab A walks forward (W key held for ~1.5s); Tab B's
//      view of Tab A's remote rig translates correspondingly.
//
// Run this against the same canary+Vite you've been using manually.
// Screenshots + assertions land in `client/tools/two-tab-manual-flow/`
// (overwritten each run). Exit 0 on pass, exit 1 with `[FAIL]`
// diagnostics on any assertion miss.
//
// Env vars (all optional):
//   TWO_TAB_FLOW_URL_A / URL_B   default http://localhost:5174/
//   TWO_TAB_FLOW_WT_PORT         default 14433
//   TWO_TAB_FLOW_WS_PORT         default 14434
//   TWO_TAB_FLOW_BOOT=1          BOOT own canary+vite (skip = default
//                                behavior is to use a canary+vite the
//                                caller has already booted).
//                                Default: BOOT_OWN=0 — DON'T spawn own servers;
//                                assume the agent has canary+vite running for
//                                manual testing. Setting TWO_TAB_FLOW_BOOT=1
//                                makes the smoke spawn its own canary+vite
//                                (useful for CI without external infra).
//   TWO_TAB_FLOW_ROOM            default "DEVBX" (room id in URL params)
//
// This smoke doesn't boot its own servers unless TWO_TAB_FLOW_BOOT
// is unset, so it pairs cleanly with the canary+vite the agent has
// running manually for Kyle.

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

const ROOM = process.env.TWO_TAB_FLOW_ROOM ?? "DEVBX";
// Default to HTTP for now — local-dev canary serves plain WS, not
// WSS. Production behind a TLS-terminating reverse proxy (Nginx /
// Cloudflare / Tailscale Funnel at the proxy layer) serves the
// page over HTTPS and the WS target becomes wss://. For local
// dev with the dev cert, see tools/dev-https.sh (PR 11.7.D3 follow-on).
const URL_A = process.env.TWO_TAB_FLOW_URL_A ?? "http://localhost:5174/";
const URL_B = process.env.TWO_TAB_FLOW_URL_B ?? "http://localhost:5174/";
const WT_PORT = Number(process.env.TWO_TAB_FLOW_WT_PORT ?? 14433);
const WS_PORT = Number(process.env.TWO_TAB_FLOW_WS_PORT ?? 14434);
const BOOT_OWN = process.env.TWO_TAB_FLOW_BOOT === "1";
const OUT_DIR = resolve(
  REPO_ROOT,
  process.env.TWO_TAB_FLOW_OUT ?? "client/tools/two-tab-manual-flow",
);
const NAV_TIMEOUT = Number(process.env.TWO_TAB_FLOW_NAV_TIMEOUT ?? 30000);
const CONNECT_TIMEOUT_MS = Number(
  process.env.TWO_TAB_FLOW_CONNECT_TIMEOUT_MS ?? 8000,
);

const log = (...args) => console.log("[smoke]", ...args);
const fail = (...args) => console.error("[smoke][FAIL]", ...args);

mkdirSync(OUT_DIR, { recursive: true });

let canaryProc = null;
let viteProc = null;

async function isTcpReachable(host, port, timeoutMs = 500) {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const cleanup = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => cleanup(true));
    socket.once("timeout", () => cleanup(false));
    socket.once("error", () => cleanup(false));
    socket.connect(port, host);
  });
}

async function bootCanary() {
  log(`Booting canary server (WT=${WT_PORT}, WS=${WS_PORT})...`);
  canaryProc = spawn(
    "bash",
    [
      resolve(REPO_ROOT, "tools", "canary-server.sh"),
      "--port-wt", String(WT_PORT),
      "--port-ws", String(WS_PORT),
    ],
    { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  canaryProc.stdout.on("data", (d) => process.stderr.write(`[canary] ${d}`));
  canaryProc.stderr.on("data", (d) => process.stderr.write(`[canary-err] ${d}`));
  for (let i = 0; i < 180; i++) {
    await sleep(1000);
    if (canaryProc.exitCode !== null) {
      throw new Error(`canary exited with code ${canaryProc.exitCode}`);
    }
    if (await isTcpReachable("127.0.0.1", WS_PORT)) {
      log(`Canary ready after ${i + 1}s`);
      return;
    }
  }
  throw new Error(`canary didn't bind WS=${WS_PORT} in 180s`);
}

async function bootVite() {
  log(`Booting Vite on 5174...`);
  viteProc = spawn(
    "npx", ["vite", "--port", "5174", "--host", "0.0.0.0", "--strictPort"],
    { cwd: resolve(REPO_ROOT, "client"), stdio: ["ignore", "pipe", "pipe"] },
  );
  viteProc.stdout.on("data", (d) => process.stderr.write(`[vite] ${d}`));
  viteProc.stderr.on("data", (d) => process.stderr.write(`[vite-err] ${d}`));
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (viteProc.exitCode !== null) {
      throw new Error(`vite exited with code ${viteProc.exitCode}`);
    }
    try {
      const res = await fetch(URL_A);
      if (res.ok) {
        log(`Vite ready after ${i + 1}s`);
        return;
      }
    } catch {}
  }
  throw new Error("vite didn't serve HTTP 200 in 30s");
}

async function teardown() {
  if (viteProc) {
    try { viteProc.kill("SIGTERM"); } catch {}
    viteProc = null;
  }
  if (canaryProc) {
    try { canaryProc.kill("SIGTERM"); } catch {}
    canaryProc = null;
  }
}

async function readHp(page) {
  return page.evaluate(() => {
    // The HUD chip exposes HP via DOM. Try a few selectors
    // (post-PR-11.7.D2 layout uses data-testid; pre-PR uses inline text).
    const meEl = document.querySelector('[data-testid="hp-me"]') ||
      [...document.querySelectorAll("div")].find((d) => /HP me\s*:/i.test(d.textContent ?? ""));
    const themEl = document.querySelector('[data-testid="hp-them"]') ||
      [...document.querySelectorAll("div")].find((d) => /HP them\s*:/i.test(d.textContent ?? ""));
    function grab(el) {
      if (!el) return null;
      const m = el.textContent.match(/(\d+)/);
      return m ? Number(m[1]) : null;
    }
    return { me: grab(meEl), them: grab(themEl) };
  });
}

async function readSnapshotPlayers(page) {
  return page.evaluate(() => {
    const snap = window.__latestSnap?.();
    if (!snap || !Array.isArray(snap.players)) return null;
    return snap.players.map((p) => ({
      id: p.playerId,
      x: p.positionX,
      z: p.positionY,
      hp: p.hp,
    }));
  });
}

async function readRigPositions(page) {
  return page.evaluate(() => {
    const sess = window.__gameSession;
    if (!sess) return null;
    const lp = sess.localController?.state?.position;
    // PR 11.7.D2.1 — read Havok position directly. The Havok
    // body is the source of truth post-substrate-retirement; the
    // controller's `state.position` is updated by `update()`,
    // which the remote controller's update() was retired (PR
    // 11.7.D2 / §3.10). `state.position` therefore reflects the
    // LAST update() call's Havok position — stale between
    // interpolator ticks. `havok.getPosition()` reads the live
    // Rapier body, which is what `setPosition` writes.
    const lpHavok = sess.localController?.havok?.getPosition?.();
    const rpHavok = sess.remoteController?.havok?.getPosition?.();
    return {
      local: lp ? { x: lp.x, y: lp.y, z: lp.z } : null,
      remote: rpHavok ? { x: rpHavok.x, y: rpHavok.y, z: rpHavok.z } : null,
      localHavok: lpHavok ? { x: lpHavok.x, y: lpHavok.y, z: lpHavok.z } : null,
      localEnabled: sess.localModel?.root?.isEnabled?.() ?? null,
      remoteEnabled: sess.remoteModel?.root?.isEnabled?.() ?? null,
      // PR 11.7.D2.1 / debug — what the interpolator last wrote to
      // remoteController.havok. If null, interpolatorTickHook never
      // fired (or never reached the setPosition branch).
      lastSetPos: window.__lastInterpolatorSetPosition ?? null,
      lastTick: window.__lastInterpolatorTick ?? null,
      // PR 11.7.D2.1 / debug — PeerOverlay sets __forceServerTransport
      // from the ?server= URL flag. If false, scene.ts skips the
      // server-transport branch and interpolatorTickHook stays null.
      serverForced: window.__forceServerTransport ?? false,
      positionSends: window.__positionUpdateSends ?? 0,
      positionSkips: window.__positionUpdateSkips ?? 0,
    };
  });
}

async function waitForSnapshot(page, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const players = await readSnapshotPlayers(page);
    if (players && players.length >= 2) return players;
    await sleep(200);
  }
  return null;
}

/**
 * Wait for a snapshot to settle — i.e. contains the expected player
 * ids [1, 2] and no ghost ids. The placeholder→claimed promotion
 * runs on the first PositionUpdate after the connection's first
 * message lands in `handle_binary`; this can take 200-500ms in the
 * smoke depending on how fast the render loop fires the first
 * PositionUpdate. Without the settle wait, the assertion below can
 * catch the brief pre-promotion window where Tab A sees its peer
 * still under the placeholder id (e.g., 1001).
 */
async function waitForSettledSnapshot(page, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const players = await readSnapshotPlayers(page);
    if (players && players.length >= 2) {
      const ids = new Set(players.map((p) => p.id));
      const hasGhost = [...ids].some((id) => id > 100);
      const hasBoth = ids.has(1) && ids.has(2);
      if (hasBoth && !hasGhost) return players;
    }
    await sleep(200);
  }
  return null;
}

async function main() {
  const errors = [];
  if (BOOT_OWN) {
    log("TWO_TAB_FLOW_BOOT=1: spawning own canary+vite...");
    await bootCanary();
    await bootVite();
  } else {
    log("Caller already booted canary+vite; using those.");
  }
  // Spawn browser. PR 11.7.D3 — use Playwright's bundled Chromium
  // (default), not the m5's google-chrome which is headless by
  // default and lacks WebTransport anyway. The HTTP page works with
  // either browser; this just keeps the walk-fire input behavior
  // consistent with the rest of the smoke matrix.
  const browser = await chromium.launch({ headless: true });
  const ctxA = await browser.newContext({
    viewport: { width: 1024, height: 768 },
  });
  const ctxB = await browser.newContext({
    viewport: { width: 1024, height: 768 },
  });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  pageA.on("pageerror", (e) => log(`[pageA error] ${e.message}`));
  pageB.on("pageerror", (e) => log(`[pageB error] ${e.message}`));

  // URL params — match the manual flow Kyle uses on Tailscale.
  // Override host with TWO_TAB_FLOW_URL_* if set (useful for non-local
  // testing — e.g. running the smoke from a different host against a
  // remote canary).
  const urlA = `${URL_A}?server=ws://${new URL(URL_A).host.split(":")[0] === "localhost" ? `localhost:${WS_PORT}` : `${new URL(URL_A).host.split(":")[0]}:${WS_PORT}`}/rooms/${ROOM}&localId=1&peerId=2`;
  const urlB = `${URL_B}?server=ws://${new URL(URL_B).host.split(":")[0] === "localhost" ? `localhost:${WS_PORT}` : `${new URL(URL_B).host.split(":")[0]}:${WS_PORT}`}/rooms/${ROOM}&localId=2&peerId=1`;
  log(`Tab A URL: ${urlA}`);
  log(`Tab B URL: ${urlB}`);

  // ---- Connect both tabs ----
  log("Navigating Tab A...");
  await pageA.goto(urlA, { timeout: NAV_TIMEOUT });
  await pageA.waitForFunction(
    () => window.__localPlayerId !== undefined,
    { timeout: CONNECT_TIMEOUT_MS },
  ).catch(() => {});
  log("Navigating Tab B...");
  await pageB.goto(urlB, { timeout: NAV_TIMEOUT });
  await pageB.waitForFunction(
    () => window.__localPlayerId !== undefined,
    { timeout: CONNECT_TIMEOUT_MS },
  ).catch(() => {});

  // ---- Wait for snapshots on both tabs ----
  // Use waitForSettledSnapshot (not waitForSnapshot) so the assertion
  // doesn't catch the brief pre-promotion window where the placeholder
  // (id > 100) is still in the room map. The promotion happens on the
  // first PositionUpdate from the second tab, which can land 200-500ms
  // after Tab B navigates.
  log("Waiting for settled snapshots on Tab A (no ghosts, [1, 2] only)...");
  const playersA = await waitForSettledSnapshot(pageA, 8000);
  if (!playersA || playersA.length < 2) {
    errors.push(`[connect-A] Tab A snapshot never settled to [1, 2] (last seen: ${JSON.stringify(playersA)})`);
  } else {
    log(`Tab A settled: ${JSON.stringify(playersA)}`);
  }
  log("Waiting for settled snapshots on Tab B (no ghosts, [1, 2] only)...");
  const playersB = await waitForSettledSnapshot(pageB, 8000);
  if (!playersB || playersB.length < 2) {
    errors.push(`[connect-B] Tab B snapshot never settled to [1, 2] (last seen: ${JSON.stringify(playersB)})`);
  } else {
    log(`Tab B settled: ${JSON.stringify(playersB)}`);
  }
  await pageA.screenshot({ path: resolve(OUT_DIR, "01-initial-tab-a.png") });
  await pageB.screenshot({ path: resolve(OUT_DIR, "01-initial-tab-b.png") });
  // Sanity probe — does the interpolatorTickHook even fire on each tab?
  const initialTickA = await pageA.evaluate(() => ({
    tick: window.__lastInterpolatorTick ?? null,
    forced: window.__forceServerTransport ?? false,
    gameSession: !!window.__gameSession,
  }));
  const initialTickB = await pageB.evaluate(() => ({
    tick: window.__lastInterpolatorTick ?? null,
    forced: window.__forceServerTransport ?? false,
    gameSession: !!window.__gameSession,
  }));
  log(`Initial probe Tab A: ${JSON.stringify(initialTickA)}`);
  log(`Initial probe Tab B: ${JSON.stringify(initialTickB)}`);

  // ---- Assertion 1: snapshot integrity ----
  if (playersA && playersB) {
    const idsA = new Set(playersA.map((p) => p.id));
    const idsB = new Set(playersB.map((p) => p.id));
    for (const wantId of [1, 2]) {
      if (!idsA.has(wantId)) errors.push(`[snapshot-A] Tab A snapshot missing playerId=${wantId}; saw [${[...idsA].join(",")}]`);
      if (!idsB.has(wantId)) errors.push(`[snapshot-B] Tab B snapshot missing playerId=${wantId}; saw [${[...idsB].join(",")}]`);
    }
    // Ghost-connection heuristic: any tab with playerId > 100 in snapshot
    // suggests stale placeholders from reconnected browser tabs.
    for (const p of playersA) {
      if (p.id > 100) errors.push(`[snapshot-A] Tab A has ghost playerId=${p.id} in snapshot — likely reconnected browser tab`);
    }
    for (const p of playersB) {
      if (p.id > 100) errors.push(`[snapshot-B] Tab B has ghost playerId=${p.id} in snapshot — likely reconnected browser tab`);
    }
    if (errors.length === 0) log("Assertion 1 PASS: both tabs see clean snapshots with [1, 2].");
  }

  // ---- Assertion 2: rig positions diverge (no spawn overlap) ----
  const rigsA = await readRigPositions(pageA);
  const rigsB = await readRigPositions(pageB);
  log(`Tab A rigs: ${JSON.stringify(rigsA)}`);
  log(`Tab B rigs: ${JSON.stringify(rigsB)}`);
  if (!rigsA?.local || !rigsA?.remote) {
    errors.push(`[rig-pos-A] Tab A rig positions unavailable`);
  }
  if (!rigsB?.local || !rigsB?.remote) {
    errors.push(`[rig-pos-B] Tab B rig positions unavailable`);
  }
  if (rigsA?.local && rigsA?.remote) {
    const dx = Math.abs(rigsA.local.x - rigsA.remote.x);
    const dz = Math.abs(rigsA.local.z - rigsA.remote.z);
    if (Math.hypot(dx, dz) < 0.5) {
      errors.push(`[rig-overlap-A] Tab A local + remote rigs overlap (Δ=${Math.hypot(dx, dz).toFixed(2)}m) — both spawning at same point`);
    } else {
      log(`Assertion 2 PASS: Tab A rigs separated by ${Math.hypot(dx, dz).toFixed(2)}m (local at ${rigsA.local.x.toFixed(2)}, remote at ${rigsA.remote.x.toFixed(2)}).`);
    }
  }

  // ---- Assertion 3: rig meshes enabled ----
  if (rigsA?.localEnabled === false || rigsA?.remoteEnabled === false) {
    errors.push(`[rig-enabled-A] Tab A: localEnabled=${rigsA?.localEnabled}, remoteEnabled=${rigsA?.remoteEnabled} — mesh hidden`);
  } else {
    log(`Assertion 3 PASS: Tab A rig meshes enabled (local=${rigsA?.localEnabled}, remote=${rigsA?.remoteEnabled}).`);
  }
  if (rigsB?.localEnabled === false || rigsB?.remoteEnabled === false) {
    errors.push(`[rig-enabled-B] Tab B: localEnabled=${rigsB?.localEnabled}, remoteEnabled=${rigsB?.remoteEnabled} — mesh hidden`);
  } else {
    log(`Assertion 3 PASS: Tab B rig meshes enabled (local=${rigsB?.localEnabled}, remote=${rigsB?.remoteEnabled}).`);
  }
  await pageA.screenshot({ path: resolve(OUT_DIR, "02-rig-positions-tab-a.png") });
  await pageB.screenshot({ path: resolve(OUT_DIR, "02-rig-positions-tab-b.png") });

  // ---- Step: Walk Tab A forward (W key) ----
  // PR-scene-smoke precedent: click the canvas first so the input
  // listener attaches focus, then keyboard.down("KeyW").
  // The character controller consumes W via `held.forward` and applies
  // movement via Havok. PositionUpdate sends the new position at
  // 32Hz; Tab B's interpolator buffers it; Tab B's remote rig moves
  // correspondingly.
  log("Tab A: walking forward (W key) for 1500ms...");
  await pageA.locator("canvas").first().click();
  await pageA.keyboard.down("KeyW");
  await sleep(1500);
  await pageA.keyboard.up("KeyW");
  await sleep(500); // let snapshots settle
  await pageA.screenshot({ path: resolve(OUT_DIR, "03-after-walk-tab-a.png") });
  await pageB.screenshot({ path: resolve(OUT_DIR, "03-after-walk-tab-b.png") });

  // ---- Assertion 4: Tab B's remote rig translated ----
  const rigsAAfter = await readRigPositions(pageA);
  const rigsBAfter = await readRigPositions(pageB);
  log(`Tab A rigs after walk: ${JSON.stringify(rigsAAfter)}`);
  log(`Tab B rigs after walk: ${JSON.stringify(rigsBAfter)}`);
  if (!rigsAAfter?.local || !rigsBAfter?.remote) {
    errors.push(`[walk-read] post-walk rig positions unavailable`);
  } else {
    // PR 70 / CF-2026-08-27.A — measure walk distance as magnitude
    // (√(Δx² + Δz²)) instead of `Δx` alone. Babylon's W key moves
    // the rig in +Z (forward in the standard scene), not +X —
    // the previous `Δx`-only check caused a false-positive "W key
    // not reaching input handler" on every CI run. The smoke is
    // opt-in (`continue-on-error: true`), so the failure didn't
    // block PRs, but it wasted ~2 minutes per CI run AND could mask
    // a real walk regression if the rig happened to move only in Z.
    // The fix ungates the smoke to required.
    const dx = rigsAAfter.local.x - rigsA.local.x;
    const dz = rigsAAfter.local.z - rigsA.local.z;
    const walkedBy = Math.sqrt(dx * dx + dz * dz);
    if (walkedBy < 0.3) {
      errors.push(`[walk] Tab A's local rig didn't translate (Δ=${walkedBy.toFixed(2)}m) — W key not reaching input handler`);
    } else {
      log(`Tab A walked ${walkedBy.toFixed(2)}m forward.`);
      // Did Tab B's view of Tab A's remote rig follow?
      const remoteDx = rigsBAfter.remote.x - rigsB.remote.x;
      const remoteDz = rigsBAfter.remote.z - rigsB.remote.z;
      const tabBRemoteMovedBy = Math.sqrt(remoteDx * remoteDx + remoteDz * remoteDz);
      if (tabBRemoteMovedBy < 0.2) {
        const lastSet = rigsBAfter.lastSetPos;
        const lastTick = rigsBAfter.lastTick;
        errors.push(
          `[walk-mirror] Tab B's remote rig didn't mirror Tab A's walk (Tab A Δ=${walkedBy.toFixed(2)}m, Tab B remote Δ=${tabBRemoteMovedBy.toFixed(2)}m). ` +
          `Last interpolator tick: ${JSON.stringify(lastTick)}, last setPosition: ${JSON.stringify(lastSet)}`,
        );
      } else {
        log(`Assertion 4 PASS: Tab B's remote rig mirrored ${tabBRemoteMovedBy.toFixed(2)}m of Tab A's walk.`);
      }
    }
  }

  // ---- Step: Tab A fires damage (5 shots) ----
  log("Tab A: firing 5 shots via damageBus...");
  for (let i = 0; i < 5; i++) {
    const fired = await pageA.evaluate(({ eventId, frame }) => {
      const bus = window.__damageBus;
      const session = window.__gameSession;
      if (!bus || !session) return { ok: false, reason: "missing __damageBus/__gameSession" };
      bus.sendDamageRequest({
        frame,
        sourcePlayerId: 1,
        targetPlayerId: 2,
        source: 0,
        amount: 12,
        eventId,
      }, session.remoteController, performance.now(), 1, 2);
      return { ok: true };
    }, { eventId: 1000 + i, frame: i });
    if (!fired.ok) errors.push(`[fire-${i + 1}] ${fired.reason}`);
    await sleep(200);
  }
  await sleep(500);
  await pageA.screenshot({ path: resolve(OUT_DIR, "04-after-fire-tab-a.png") });
  await pageB.screenshot({ path: resolve(OUT_DIR, "04-after-fire-tab-b.png") });

  // ---- Assertion 5: HP drops on BOTH tabs (cross-tab propagation) ----
  const hpA = await readHp(pageA);
  const hpB = await readHp(pageB);
  log(`HP after fire — Tab A: me=${hpA.me} them=${hpA.them}; Tab B: me=${hpB.me} them=${hpB.them}`);
  if (hpA.them === null || hpA.them === 100) {
    errors.push(`[hp-tab-a] Tab A's "HP them" didn't drop (still ${hpA.them}) — broadcast handler not firing or resolver routed wrong`);
  }
  if (hpB.me === null || hpB.me === 100) {
    errors.push(`[hp-tab-b] Tab B's "HP me" didn't drop (still ${hpB.me}) — broadcast not reaching Tab B or resolver routed wrong`);
  }
  if (hpA.them !== null && hpA.them < 100 && hpB.me !== null && hpB.me < 100) {
    // Convergence: the two tabs should agree on Player 2's HP within
    // one broadcast-round-trip (typically <100ms).
    const drift = Math.abs(hpA.them - hpB.me);
    if (drift > 4) {
      errors.push(`[hp-drift] Tab A "HP them" (${hpA.them}) ≠ Tab B "HP me" (${hpB.me}); drift=${drift} — cross-tab state desynced`);
    } else {
      log(`Assertion 5 PASS: HP cross-tab converged within ${drift} (Tab A them=${hpA.them}, Tab B me=${hpB.me}).`);
    }
  }

  // ---- Final screenshots ----
  await pageA.screenshot({ path: resolve(OUT_DIR, "05-final-tab-a.png") });
  await pageB.screenshot({ path: resolve(OUT_DIR, "05-final-tab-b.png") });

  await browser.close();
  await teardown();

  if (errors.length > 0) {
    fail(`two-tab-manual-flow FAILED (${errors.length} assertion${errors.length === 1 ? "" : "s"}):`);
    for (const e of errors) fail(`  - ${e}`);
    fail(`Screenshots: ${OUT_DIR}`);
    process.exit(1);
  } else {
    log(`OK — two-tab manual flow passed. Screenshots: ${OUT_DIR}`);
    process.exit(0);
  }
}

main().catch(async (e) => {
  fail(`two-tab-manual-flow crashed: ${e?.stack ?? e}`);
  await teardown();
  process.exit(1);
});