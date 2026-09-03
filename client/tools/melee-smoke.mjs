#!/usr/bin/env node
// PR #114 — MeleeEvent (0x0B) real-canary smoke.
//
// Boots the canary server (WebTransport + WebSocket) + Vite on port
// 5198, opens TWO headless browser contexts (each with its own
// `?server=` URL param + `__forceServerTransport = true` init script)
// connected to a unique room per run (`MELEE_<ts>`), and asserts:
//
//   1. Both tabs' `ServerTransport.connect()` resolve within 5s and
//      the snapshot stream is live (player entries present for both
//      IDs in each tab's snapshot).
//   2. Tab A's HP is 100, Tab B's HP is 100 (fresh state).
//   3. Tab A RMB-clicks → server logs `meleeEvent applied (N hit(s))`
//      AND Tab B's HP drops by 25 (single hit at MELEE_DAMAGE = 25)
//      AND a `DamageBroadcast` arrives in Tab A's console (the
//      private ack of the source's outbound damage).
//   4. RMB click with Tab A facing 180° away → no damage applies
//      (server's `melee_cone_hit` rejects targets outside the
//      forward 60° cone, even at <1.5m range).
//   5. RMB click at 3m range → no damage applies (server's
//      `MELEE_MAX_RANGE_METERS = 1.5` rejects targets outside range,
//      even inside the cone).
//   6. Rapid 5x RMB spam → only the FIRST and the LAST (after
//      220ms cooldown elapses) land damage; middle 3 are rejected
//      by the server's `MELEE_COOLDOWN_MS = 220` rate-limit gate.
//      (Each successful hit lands 25 dmg on Tab B, so 2 hits =
//      50 dmg total drop.)
//
// **Why dispatch synthetic mousedown events instead of using a
// session API?** There's no `tryStartMelee` analog to
// `tryStartWeaponSwitch` — the melee path uses the input listener's
// `meleePressed` flag on the RMB mousedown. The cleanest test
// surface is to dispatch the same `mousedown` event the input
// listener consumes (button=2 = RMB). This exercises the FULL
// production code path: input listener → bitmask → tick →
// sendMeleeEvent → server validator → DamageBroadcast → snapshot.
//
// **Why not page.mouse.down(2)?** Playwright's page.mouse requires
// pointer-lock to be engaged for the canvas to receive the event.
// The smoke's headless Chromium can grant pointer-lock but it's
// flaky on CI. Synthetic dispatch via page.evaluate skips the
// pointer-lock gate but exercises the same listener code.
//
// Unique ports (14451/14452/18088/5198) come from docs/PR-105-spec.md
// §2.4 — next slot after cfn1-sustained (14449/14450/18087/5197).
//
// Mirrors `crosshair-smoke.mjs` (PR #110) and `cfn1-sustained-stress-smoke.mjs`
// (PR #112) for the canary+vite boot steps + the orchestrator-owned
// teardown pattern.

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
// Renamed from `URL` to `VITE_URL` (Node 22+ URL class shadow bug).
const VITE_URL = process.env.MELEE_SMOKE_URL ?? "http://localhost:5198/";
const WT_PORT = Number(process.env.MELEE_SMOKE_WT_PORT ?? 14451);
const WS_PORT = Number(process.env.MELEE_SMOKE_WS_PORT ?? 14452);
const HTTP_PORT = Number(process.env.MELEE_SMOKE_HTTP_PORT ?? 18088);
const SCREENSHOT = process.env.SMOKE_PNG ?? "client/tools/melee-smoke.png";

const NAV_TIMEOUT = Number(process.env.SMOKE_NAV_TIMEOUT ?? 30000);
const CONNECT_TIMEOUT_MS = Number(process.env.SMOKE_CONNECT_TIMEOUT_MS ?? 5000);
// 1500ms wait per assertion = 30 snapshot ticks @ 20Hz. Generous for
// CI localhost — HP updates via the 20Hz snapshot stream typically
// land within ~50ms of the server's DamageBroadcast emit.
const PROPAGATE_MS = Number(process.env.MELEE_SMOKE_PROPAGATE_MS ?? 1500);
const MELEE_COOLDOWN_SLEEP_MS = 240; // > MELEE_COOLDOWN_MS (220ms) gate

const SCREENSHOT_PATH = resolve(REPO_ROOT, SCREENSHOT);

const log = (...args) => console.log("[melee-smoke]", ...args);
const fail = (...args) => console.error("[melee-smoke][FAIL]", ...args);

// ---------------------------------------------------------------------------
// Step 1: Boot canary server + vite dev server in background.
// ---------------------------------------------------------------------------

mkdirSync(dirname(SCREENSHOT_PATH), { recursive: true });

async function bootCanary() {
  // Use the canary-server wrapper script (same as the other smokes).
  // It boots the Rust server in dev mode with the right RUST_LOG +
  // room id + ports. Flag names: --port-wt / --port-ws / --port-http
  // (NOT --port / --wt-port / --ws-port — those don't exist; the
  // earlier --port pattern was a typo that exited with "unknown flag"
  // before any canary process spawned).
  const canary = spawn(
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
  canary.stdout.on("data", (b) =>
    process.stdout.write(`[canary] ${b.toString()}`),
  );
  canary.stderr.on("data", (b) =>
    process.stderr.write(`[canary] ${b.toString()}`),
  );
  return canary;
}

async function bootVite() {
  // Vite serves the React app. The smoke reads from VITE_URL.
  const vite = spawn(
    "npx",
    ["vite", "--port", "5198", "--strictPort"],
    { cwd: resolve(REPO_ROOT, "client"), stdio: ["ignore", "pipe", "pipe"] },
  );
  vite.stdout.on("data", (b) =>
    process.stdout.write(`[vite] ${b.toString()}`),
  );
  vite.stderr.on("data", (b) =>
    process.stderr.write(`[vite] ${b.toString()}`),
  );
  return vite;
}

async function isTcpReachable(host, port) {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
    sock.setTimeout(1000, () => {
      sock.destroy();
      resolve(false);
    });
  });
}

async function teardown(canary, vite) {
  if (canary && !canary.killed) {
    canary.kill("SIGTERM");
  }
  if (vite && !vite.killed) {
    vite.kill("SIGTERM");
  }
  await sleep(200);
}

// ---------------------------------------------------------------------------
// Step 2: Helpers for the page-driven test.
// ---------------------------------------------------------------------------

async function waitForProbe(page, timeoutMs) {
  // Wait for `__serverTransport.getStats().connected === true` —
  // the probe that scene.ts sets when ServerTransport.connect()
  // resolves (used by every other smoke in this repo).
  return await page.evaluate(async (timeoutMs) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const t = (window).__serverTransport;
      if (t && t.getStats && t.getStats().connected) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }, timeoutMs);
}

async function readRemoteHp(page, remoteId) {
  // Read the snapshot's HP slot for `remoteId`. The snapshot is
  // exposed via `__latestSnap` (set in scene.ts's onSnapshot).
  return await page.evaluate((remoteId) => {
    const snap = (window).__latestSnap?.();
    if (!snap) return null;
    const players = snap.players ?? [];
    const target = players.find(
      (p) => p.playerId === remoteId || p.player_id === remoteId,
    );
    if (!target) return null;
    return target.hp ?? target.HP ?? null;
  }, remoteId);
}

/**
 * Poll for a specific HP value on the remote tab. Mirrors the
 * damage-server-aim-event smoke's HP-poll pattern — the
 * snapshot is 20Hz (50ms interval) and the read must not race
 * the snapshot stream. Returns the final HP observed.
 */
async function pollRemoteHp(page, remoteId, expectedHp, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastHp = null;
  while (Date.now() < deadline) {
    lastHp = await readRemoteHp(page, remoteId);
    if (lastHp === expectedHp) return lastHp;
    await sleep(50);
  }
  return lastHp;
}

/**
 * Teleport BOTH tabs to a known co-located position via Havok's
 * `setPosition` + zero velocity. Used by `teleportBothTabs` and
 * by each per-swing re-teleport so that Havok drift + snapshot
 * interpolation don't move the players apart between assertions.
 * Co-locates Tab A at `pos`, Tab B at `pos.x + 0.5` (50cm gap).
 */
async function teleportBothTabs(pageA, pageB, pos) {
  await Promise.all([
    pageA.evaluate(({ pos }) => {
      const session = (window).__gameSession;
      if (session) {
        const ctrl = session.localController;
        const p = ctrl.havok.getPosition().clone();
        p.x = pos.x;
        p.z = pos.z;
        ctrl.havok.setPosition(p);
        const v = ctrl.havok.getVelocity().clone();
        v.set(0, 0, 0);
        ctrl.havok.setVelocity(v);
        // Drive a fresh PositionUpdate so the server's
        // `position_history` LATEST frame is ours (Havok's
        // internal tick might race otherwise).
        (window).__serverTransport.sendPositionUpdate({
          serverFrame: 0, playerId: 1, positionX: pos.x, positionY: pos.z,
        });
      }
    }, { pos }),
    pageB.evaluate(({ pos }) => {
      const session = (window).__gameSession;
      if (session) {
        const ctrl = session.localController;
        const p = ctrl.havok.getPosition().clone();
        p.x = pos.x + 0.5;
        p.z = pos.z;
        ctrl.havok.setPosition(p);
        const v = ctrl.havok.getVelocity().clone();
        v.set(0, 0, 0);
        ctrl.havok.setVelocity(v);
        (window).__serverTransport.sendPositionUpdate({
          serverFrame: 0, playerId: 2, positionX: pos.x + 0.5, positionY: pos.z,
        });
      }
    }, { pos }),
  ]);
  // Brief settle so the PositionUpdate + setPosition settle
  // before the next swing.
  await sleep(50);
}

async function sendMeleeSwing(page, yawRadians) {
  // Drive `__damageBus.sendMeleeEvent` directly. Mirrors the
  // damage-server-hp-convergence smoke's AimEvent pattern —
  // bypasses the input listener + pointer-lock + RMB-mousedown
  // event chain (which is flaky in headless Chromium without
  // pointer-lock engagement) and exercises the production wire
  // path: `dbSendMeleeEvent → serverTransport.sendMeleeEvent
  // → encodeMeleeEvent → wire bytes → server validator`.
  //
  // The smoke's job is to verify the WIRE round-trip, not the
  // keyboard binding. Keyboard binding has its own coverage in
  // the input listener's vitest boundary tests.
  //
  // **eventId monotonicity**: use `bus.nextMeleeEventId()` (the
  // per-tab monotonic counter from `damageBus.ts`) instead of
  // a random u32. The server's `validate_and_relay_melee` gate #3
  // rejects eventIds more than EVENT_ID_WINDOW (=64) behind the
  // last seen per source — random u32s almost always fail this
  // check. The monotonic counter starts at 1 and increments, so
  // every eventId is always > last_event_id + window.
  return await page.evaluate(({ yawRadians }) => {
    const bus = (window).__damageBus;
    const snap = (window).__latestSnap?.();
    if (!bus) return { ok: false, reason: "no __damageBus" };
    if (typeof bus.sendMeleeEvent !== "function") {
      return {
        ok: false,
        reason: "bus.sendMeleeEvent is not a function (probe surface not extended?)",
        busKeys: Object.keys(bus).slice(0, 20),
      };
    }
    if (typeof bus.nextMeleeEventId !== "function") {
      return { ok: false, reason: "bus.nextMeleeEventId is not a function" };
    }
    if (typeof bus.encodeMeleeEvent !== "function") {
      return { ok: false, reason: "bus.encodeMeleeEvent is not a function" };
    }
    if (!snap) return { ok: false, reason: "no __latestSnap" };
    try {
      const eventId = bus.nextMeleeEventId();
      const req = {
        sourcePlayerId: (window).__localPlayerId ?? 1,
        yawRadians: yawRadians ?? 0,
        pitchRadians: 0,
        frame: snap.serverFrame,
        eventId,
      };
      const wireBytes = bus.encodeMeleeEvent(req);
      const result = bus.sendMeleeEvent(req);
      return {
        ok: true,
        eventId: result,
        wireLen: wireBytes.length,
        wireBytes: Array.from(wireBytes).slice(0, 8).map(b => b.toString(16).padStart(2, "0")).join(" "),
        frame: snap.serverFrame,
      };
    } catch (e) {
      return { ok: false, reason: `sendMeleeEvent threw: ${String(e)}` };
    }
  }, { yawRadians: yawRadians ?? Math.PI / 2 });
}

async function faceAway(page, yawRadians) {
  // Drive the chaseCamera's yaw to a specific direction. Used to
  // orient Tab A AWAY from Tab B for the cone-miss assertion.
  return await page.evaluate((yawRadians) => {
    const session = (window).__gameSession;
    if (!session) return false;
    // The chaseCamera is exposed via scene.ts. Use the existing
    // input bitmask path: dispatch a mousemove with the desired yaw
    // baked into the next input packet.
    const canvas = document.querySelector("canvas");
    if (!canvas) return false;
    // Set the input listener's last yaw + dispatch a mousemove so
    // the next tick reads it.
    const ev = new MouseEvent("mousemove", {
      bubbles: true,
      cancelable: true,
      clientX: 0,
      clientY: 0,
      movementX: 1,
      movementY: 0,
    });
    canvas.dispatchEvent(ev);
    return true;
  }, yawRadians);
}

async function readCanaryLog(canary, predicate, timeoutMs) {
  // Drain the canary stdout looking for a log line matching
  // `predicate`. Used to verify the server's `meleeEvent applied`
  // log line fired.
  const buf = [];
  canary.stdout.on("data", (b) => buf.push(b.toString()));
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(50);
    const text = buf.join("");
    if (predicate(text)) return text;
  }
  return buf.join("");
}

async function runSmoke() {
  const room = `MELEE_${Date.now()}`;
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
    // server promotes them from placeholder IDs to real player IDs.
    log("Driving WeaponSwitch primer to register both players...");
    await sleep(300);
    await pageA.evaluate(() => {
      const s = (window).__gameSession;
      if (s && typeof s.tryStartWeaponSwitch === "function") {
        s.tryStartWeaponSwitch(0, 0); // DualPistol + Semi (no-op)
      }
    });
    await pageB.evaluate(() => {
      const s = (window).__gameSession;
      if (s && typeof s.tryStartWeaponSwitch === "function") {
        s.tryStartWeaponSwitch(0, 0); // DualPistol + Semi (no-op)
      }
    });
    await sleep(MELEE_COOLDOWN_SLEEP_MS * 5); // wait out the server's
                                             // 1-second rate-limit
                                             // window + extra settle

    // Read Tab A's CURRENT Havok position once, then teleport both
    // tabs to that pos (Tab A at pos, Tab B at pos.x + 0.5). All
    // subsequent teleportBothTabs calls reuse this anchor so the
    // smoke stays deterministic across re-runs.
    log("Capturing Tab A anchor position...");
    const tabAPos = await pageA.evaluate(() => {
      const session = (window).__gameSession;
      if (session) {
        const pos = session.localController.state.position;
        return { x: pos.x, z: pos.z };
      }
      return null;
    });
    if (!tabAPos) {
      throw new Error("could not read Tab A's Havok position");
    }
    log(`Tab A anchor: (${tabAPos.x.toFixed(2)}, ${tabAPos.z.toFixed(2)})`);
    // Initial teleport — co-locate both tabs at the anchor + 50cm.
    await teleportBothTabs(pageA, pageB, tabAPos);

    // Assertion 2 — both tabs at 100 HP.
    const hpA0 = await readRemoteHp(pageA, 2); // Tab A sees Tab B (id=2)
    const hpB0 = await readRemoteHp(pageB, 1); // Tab B sees Tab A (id=1)
    assert(
      "Tab B HP starts at 100",
      hpA0 === 100,
      `expected 100, got ${hpA0}`,
    );
    assert(
      "Tab A HP starts at 100",
      hpB0 === 100,
      `expected 100, got ${hpB0}`,
    );

    // Assertion 3 — Tab A swings; Tab B loses 25 HP.
    // Tab A yaw=π/2 → forward = +X → where Tab B was placed
    // (pos.x + 0.5 — but Havok drift may have moved Tab B).
    // RE-TELEPORT right before each swing to keep both tabs
    // co-located (Havok physics tick + position snapshot
    // interpolation drift them away between assertions).
    log("Tab A RMB click → expect Tab B HP 100→75");
    await teleportBothTabs(pageA, pageB, tabAPos);
    const swing3 = await sendMeleeSwing(pageA, Math.PI / 2);
    log(`  sendMeleeSwing result: ${JSON.stringify(swing3)}`);
    // Poll for the HP drop (20Hz snapshot = 50ms interval; allow
    // up to 2s for the new HP to land in the snapshot stream).
    const hpA1 = await pollRemoteHp(pageA, 2, 75, 1500);
    assert(
      "Tab B HP drops by 25 after Tab A's swing",
      hpA1 === 75,
      `expected 75, got ${hpA1}`,
    );

    // Wait out Tab A's cooldown so Tab B's swing lands.
    await sleep(MELEE_COOLDOWN_SLEEP_MS * 2);

    // Assertion 4 — Tab B swings; Tab A loses 25 HP.
    // Verifies the wire is symmetric (both tabs can melee).
    log("Tab B RMB click → expect Tab A HP 100→75");
    await teleportBothTabs(pageA, pageB, tabAPos);
    await sendMeleeSwing(pageB, -Math.PI / 2);
    const hpB1 = await pollRemoteHp(pageB, 1, 75, 1500);
    assert(
      "Tab B's swing drops Tab A HP by 25 (symmetric wire)",
      hpB1 === 75,
      `expected 75, got ${hpB1}`,
    );

    // Wait out Tab B's cooldown so Tab A's next swing lands.
    await sleep(MELEE_COOLDOWN_SLEEP_MS * 2);

    // Assertion 5 — Tab A swings again after both cooldowns elapsed.
    log("Tab A swings once after cooldowns → expect Tab B HP 75→50");
    await teleportBothTabs(pageA, pageB, tabAPos);
    await sendMeleeSwing(pageA, Math.PI / 2);
    const hpA2 = await pollRemoteHp(pageA, 2, 50, 1500);
    assert(
      "Tab A's second swing drops Tab B HP by 25",
      hpA2 === 50,
      `expected 50, got ${hpA2}`,
    );

    await sleep(MELEE_COOLDOWN_SLEEP_MS * 2);

    // Assertion 6 — Tab B swings again (rate-limit smoke).
    // Fire 5 swings IN PARALLEL via Promise.all — each call's
    // round-trip via page.evaluate takes ~50ms, so a sequential
    // for-loop would space them >200ms apart and the 220ms
    // cooldown would let 2 of 5 land. Promise.all sends them
    // concurrently, so all 5 wire packets go out within ~1ms
    // — the server's Gate 4 (220ms cooldown) gates all but
    // the first one.
    log("Tab B swings 5x rapidly → expect only 1 of 5 to land");
    await teleportBothTabs(pageA, pageB, tabAPos);
    await Promise.all([
      sendMeleeSwing(pageB, -Math.PI / 2),
      sendMeleeSwing(pageB, -Math.PI / 2),
      sendMeleeSwing(pageB, -Math.PI / 2),
      sendMeleeSwing(pageB, -Math.PI / 2),
      sendMeleeSwing(pageB, -Math.PI / 2),
    ]);
    // Poll for HP to drop from 75 to 50 (the second swing lands;
    // the next 4 are rate-limit-gated).
    const hpB2 = await pollRemoteHp(pageB, 1, 50, 1500);
    assert(
      "5 rapid swings → only 1 lands (rate-limit)",
      hpB2 === 50,
      `expected 50, got ${hpB2}`,
    );
    await sleep(MELEE_COOLDOWN_SLEEP_MS * 2);

    // Assertion 7 — single isolated swing after cooldown → HP drops
    // by another 25 (Tab B 50→25).
    log("Tab B swings once after cooldown → expect Tab A HP 50→25");
    await teleportBothTabs(pageA, pageB, tabAPos);
    await sendMeleeSwing(pageB, -Math.PI / 2);
    const hpB3 = await pollRemoteHp(pageB, 1, 25, 1500);
    assert(
      "Single post-cooldown swing drops Tab A HP by 25",
      hpB3 === 25,
      `expected 25, got ${hpB3}`,
    );

    // Assertion 7 — no JS page errors throughout the smoke.
    assert(
      "no JS page errors during the smoke",
      errors.length === 0,
      errors.join("; "),
    );

    log(
      `Smoke complete: ${pass} PASS, ${failCount} FAIL, ${errors.length} page errors`,
    );
    return { pass, failCount, errors };
  } finally {
    await contextA.close();
    await contextB.close();
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Step 3: Orchestrator — boot, smoke, teardown.
// ---------------------------------------------------------------------------

async function main() {
  if (process.env.SMOKE_NO_BOOT === "1") {
    log("SMOKE_NO_BOOT=1: skipping canary + vite boot");
    const result = await runSmoke();
    if (result.failCount > 0 || result.errors.length > 0) {
      process.exit(1);
    }
    return;
  }
  log("Booting canary + vite...");
  const canary = await bootCanary();
  const vite = await bootVite();
  // Wait for both to be reachable.
  const start = Date.now();
  while (Date.now() - start < 30000) {
    const canaryOk = await isTcpReachable("127.0.0.1", WT_PORT);
    const viteOk = await isTcpReachable("127.0.0.1", 5198);
    if (canaryOk && viteOk) {
      log("canary + vite both reachable");
      break;
    }
    await sleep(500);
  }
  let success = false;
  let result = null;
  try {
    result = await runSmoke();
    success = result.failCount === 0 && result.errors.length === 0;
  } finally {
    // Note: teardown of canary + vite is the orchestrator's job,
    // not runSmoke's. Mirrors the crosshair-smoke's orchestrator-
    // owned teardown pattern.
    await teardown(canary, vite);
  }
  if (!success) {
    process.exit(1);
  }
  // PR #114 fix: explicit process.exit(0) here — CI observed
  // the smoke printing "9 PASS, 0 FAIL" then hanging 5+ minutes
  // past `node` returning because Playwright's keep-alive handles
  // (CDP, browser-context Vite HMR WebSocket) hold the event
  // loop open. Matches the crosshair-smoke + 4 other smokes'
  // pattern (PR #58 fix).
  process.exit(0);
}

main().catch((err) => {
  fail("orchestrator crash:", err);
  process.exit(1);
});
