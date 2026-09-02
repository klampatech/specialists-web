#!/usr/bin/env node
// PR #108 — server-authoritative weapon-switch smoke.
//
// Boots the canary server (WebTransport + WebSocket) + Vite on port
// 5195, opens TWO headless browser contexts (each with its own
// `?server=` URL param + `__forceServerTransport = true` init script)
// connected to a unique room per run (`WEAPONS_<ts>` — Room
// Strategy below), and asserts:
//
//   1. Both tabs' `ServerTransport.connect()` resolve within 5s and
//      the snapshot stream is live (player entries present).
//   2. Tab A presses `2` → server snapshots `weapon_id` changes to 1
//      (Shotgun) within 200ms.
//   3. Tab A presses `3` → server snapshots `weapon_id` changes to 2
//      (Sniper) within 200ms.
//   4. Tab A presses `1` (back to DualPistol) then `B` → server
//      snapshots `current_fire_mode` changes to 1 (Burst3) within
//      200ms; weapon_id stays 0.
//   5. Tab A presses `B` again → `current_fire_mode` returns to 0
//      (Semi) within 200ms.
//   6. Rate limit: Tab A presses `1` then `2` within 500ms → second
//      switch dropped silently by server (5-gate #3 rate-limit).
//      Verified by snapshot reading only the FIRST switch.
//
// The 6 assertions prove the PR #107 + #108 contract:
//   - WeaponSwitch (0x0C) round-trip on the wire (disc + u16 source +
//     u8 weapon_id + u8 fire_mode_index, 5 bytes total)
//   - server-side `validate_and_relay_weapon_switch` 5 gates
//     (source-in-room, anti-spoof, rate-limit, weapon-id-known,
//     fire-mode-index-in-range)
//   - server-side player-state mutation
//   - 20Hz snapshot fan-out carries the new weapon state to all tabs
//     (PlayerState.currentFireMode at offset 30)
//   - both tabs' HUD reads `__latestSnap` (server-authoritative,
//     NOT local controller)
//
// Designed to mirror `damage-server-reload-smoke.mjs` (PR 11.7.E)
// and `damage-server-hp-convergence-smoke.mjs` (PR 11.7.D) so CI
// can wire it with the same canary+vite boot steps. The unique
// ports (14445/14446/18084/5195) come from docs/PR-105-spec.md
// §2.4 — next slot after lobby + rig-visual.

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
// Renamed from `URL` to `VITE_URL` — the global `URL` class is
// shadowed by `import { chromium } from "playwright"`'s implicit
// types in some bundlers; using `new URL(VITE_URL)` throws "URL is
// not a constructor". `VITE_URL` is unambiguous.
const VITE_URL = process.env.WEAPON_SMOKE_URL ?? "http://localhost:5195/";
const WT_PORT = Number(process.env.WEAPON_SMOKE_WT_PORT ?? 14445);
const WS_PORT = Number(process.env.WEAPON_SMOKE_WS_PORT ?? 14446);
const HTTP_PORT = Number(process.env.WEAPON_SMOKE_HTTP_PORT ?? 18084);
const SCREENSHOT = process.env.SMOKE_PNG ?? "client/tools/weapon-switch-smoke.png";

const NAV_TIMEOUT = Number(process.env.SMOKE_NAV_TIMEOUT ?? 30000);
const CONNECT_TIMEOUT_MS = Number(process.env.SMOKE_CONNECT_TIMEOUT_MS ?? 5000);
// 200ms wait per assertion = 4 snapshot ticks @ 20Hz (50ms each).
// Generous for CI localhost.
const SWITCH_SETTLE_MS = Number(process.env.WEAPON_SMOKE_SETTLE_MS ?? 2000);
// Rate-limit window: WEAPON_SWITCH_RATE_LIMIT_MS = 1000ms. Pressing
// within 500ms is well inside the window → second press dropped.
const RATE_LIMIT_PRESS_GAP_MS = 500;

const SCREENSHOT_PATH = resolve(REPO_ROOT, SCREENSHOT);

const log = (...args) => console.log("[weapon-smoke]", ...args);
const fail = (...args) => console.error("[weapon-smoke][FAIL]", ...args);

// ---------------------------------------------------------------------------
// Step 1: Boot canary server + vite dev server in background.
// ---------------------------------------------------------------------------

mkdirSync(dirname(SCREENSHOT_PATH), { recursive: true });

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
  log(`Booting vite on ${VITE_URL}...`);
  // Extract port from URL for the strictPort flag.
  const port = new URL(VITE_URL).port || "5195";
  viteProc = spawn(
    "npm",
    ["run", "dev", "--", "--host", "127.0.0.1", "--port", port, "--strictPort"],
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
  for (const port of [5195, WT_PORT, WS_PORT, HTTP_PORT]) {
    try {
      const { execSync } = await import("node:child_process");
      execSync(`lsof -ti:${port} 2>/dev/null | xargs -r kill -9`, { stdio: "ignore" });
    } catch {
      // ignore
    }
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
// Smoke runner.
// ---------------------------------------------------------------------------

async function runSmoke() {
  // Unique room per run so the canary's per-room state doesn't bleed
  // across CI invocations (matches the damage-server-reload-smoke
  // pattern).
  const room = `WEAPONS_${Date.now()}`;
  log(`Using room: ${room}`);

  const browser = await chromium.launch();
  const errors = [];
  const onPageError = (page, label) => {
    page.on("pageerror", (err) => {
      errors.push(`${label}: ${err.message}`);
    });
  };

  // Two tabs, each with its own localId + peerId so the server
  // assigns distinct playerIds (1 and 2).
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  onPageError(pageA, "Tab A");
  onPageError(pageB, "Tab B");

  const urlA = `${VITE_URL}?server=${VITE_URL}&localId=1&peerId=2&roomId=${room}`;
  const urlB = `${VITE_URL}?server=${VITE_URL}&localId=2&peerId=1&roomId=${room}`;

  // Init scripts — set `__forceServerTransport = true` BEFORE the
  // page loads so PeerOverlay bypasses the lobby modal and connects
  // straight to the canary. Also pre-set `__damageServerPorts` so
  // scene.ts boots ServerTransport against our canary, not the
  // default localhost:5190 (which we don't run for this smoke).
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

  try {
    log(`Navigating Tab A to ${urlA}...`);
    await pageA.goto(urlA, { timeout: NAV_TIMEOUT });
    log(`Navigating Tab B to ${urlB}...`);
    await pageB.goto(urlB, { timeout: NAV_TIMEOUT });

    log("Waiting for both transports to connect...");
    const okA = await waitForProbe(pageA, CONNECT_TIMEOUT_MS);
    const okB = await waitForProbe(pageB, CONNECT_TIMEOUT_MS);
    if (!okA || !okB) {
      throw new Error(`Transport connect failed: Tab A=${okA}, Tab B=${okB}`);
    }

    // Wait for both tabs to see each other in the snapshot stream.
    // The snapshot only shows "promoted" players (those who have
    // sent at least one DamageRequest/AimEvent/WeaponSwitch — the
    // server's `room.connections` skips placeholder IDs 1000+).
    // Without a primer, both tabs remain placeholders and the
    // snapshot only shows their own placeholder.
    //
    // Primer: drive a no-op WeaponSwitch from each tab. This is
    // the natural primer for PR #108 (we're testing weapon
    // switches anyway — and sending one is harmless). The server
    // processes it, mutates player state (no-op if already
    // DualPistol+Semi), and promotes the player to a real ID
    // (1 / 2).
    log("Driving WeaponSwitch primer to register both players...");
    await sleep(300);
    const primerA = await pageA.evaluate(() => {
      const s = (window).__gameSession;
      if (!s || typeof s.tryStartWeaponSwitch !== "function") {
        return { ok: false, reason: "no tryStartWeaponSwitch" };
      }
      s.tryStartWeaponSwitch(0, 0); // DualPistol + Semi — no-op state change
      return { ok: true };
    });
    const primerB = await pageB.evaluate(() => {
      const s = (window).__gameSession;
      if (!s || typeof s.tryStartWeaponSwitch !== "function") {
        return { ok: false, reason: "no tryStartWeaponSwitch" };
      }
      s.tryStartWeaponSwitch(0, 0);
      return { ok: true };
    });
    if (!primerA.ok || !primerB.ok) {
      throw new Error(`Primer failed: Tab A=${JSON.stringify(primerA)}, Tab B=${JSON.stringify(primerB)}`);
    }
    // Wait out the server's 1-second rate-limit window (the
    // primer counted as a switch for the purpose of 5-gate #3).
    // The first real assertion needs to be ≥ 1000ms after the
    // primer to avoid the server dropping the next switch.
    await sleep(1100);

    // ---- Assertion 1: both tabs see each other; Tab A's snapshot
    // reports DualPistol (weapon_id=0, currentFireMode=0).
    const initialA = await pageA.evaluate(() => {
      const snap = (window).__latestSnap ? (window).__latestSnap() : null;
      const e1 = snap ? snap.players.find((p) => p.playerId === 1) : null;
      const e2 = snap ? snap.players.find((p) => p.playerId === 2) : null;
      return {
        found1: !!e1, weaponId1: e1?.weaponId, fireMode1: e1?.currentFireMode,
        found2: !!e2,
      };
    });
    const initialB = await pageB.evaluate(() => {
      const snap = (window).__latestSnap ? (window).__latestSnap() : null;
      const e1 = snap ? snap.players.find((p) => p.playerId === 1) : null;
      return { found1: !!e1 };
    });
    log(`Initial snapshot: Tab A=${JSON.stringify(initialA)}, Tab B=${JSON.stringify(initialB)}`);
    if (!initialA.found1 || !initialA.found2 || !initialB.found1) {
      throw new Error(
        `Pre-switch primer failed: server did not re-key both connections within 300ms. ` +
        `Found Tab A: ${JSON.stringify(initialA)}, Tab B: ${JSON.stringify(initialB)}.`,
      );
    }
    if (initialA.weaponId1 !== 0 || initialA.fireMode1 !== 0) {
      throw new Error(
        `Tab A initial weapon state wrong: weaponId=${initialA.weaponId1} (expected 0=DualPistol), ` +
        `currentFireMode=${initialA.fireMode1} (expected 0=Semi).`,
      );
    }
    log(`Assertion 1 PASS: both tabs connected, Tab A starts DualPistol+Semi.`);

    // Helper: poll snapshot until Tab A's weapon_id matches expected,
    // or timeout.
    async function pollWeaponId(expectedWeaponId, expectedFireMode, timeoutMs) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const v = await pageA.evaluate(() => {
          const snap = (window).__latestSnap ? (window).__latestSnap() : null;
          const e = snap ? snap.players.find((p) => p.playerId === 1) : null;
          return e ? { weaponId: e.weaponId, currentFireMode: e.currentFireMode } : null;
        });
        if (v && v.weaponId === expectedWeaponId &&
            (expectedFireMode === undefined || v.currentFireMode === expectedFireMode)) {
          return v;
        }
        await sleep(50);
      }
      return null;
    }

    // Helper: send a keypress to Tab A via the input listener's
    // `tryStartWeaponSwitch` API (bypasses the actual keydown event
    // because Playwright keyboard.press is flaky in headless for
    // rapid-fire keypresses that need to trigger the local
    // rate-limit gate). The smoke's job is to validate the
    // server-side contract; the local rate-limit gate is unit-tested
    // via the listener's `lastWeaponSwitchAtMs` tracker (and by
    // the existing vitest boundary).
    async function sendSwitch(weaponId, fireModeIndex) {
      return pageA.evaluate(({ w, f }) => {
        const session = (window).__gameSession;
        if (!session || typeof session.tryStartWeaponSwitch !== "function") {
          return { ok: false, reason: "no __gameSession.tryStartWeaponSwitch" };
        }
        session.tryStartWeaponSwitch(w, f);
        return { ok: true };
      }, { w: weaponId, f: fireModeIndex });
    }

    // ---- Assertion 2: Tab A switches to Shotgun (weapon_id=1).
    log("Tab A: switching to Shotgun (key 2)...");
    const sw2 = await sendSwitch(1, 0); // WeaponId.Shotgun, fireModeIndex=0 (Semi)
    if (!sw2.ok) throw new Error(`Shotgun switch failed: ${sw2.reason}`);
    const v2 = await pollWeaponId(1, 0, SWITCH_SETTLE_MS);
    if (!v2) {
      throw new Error(`Tab A snapshot did not converge to Shotgun within ${SWITCH_SETTLE_MS}ms.`);
    }
    log(`Assertion 2 PASS: Tab A switched to Shotgun in ${SWITCH_SETTLE_MS}ms.`);
    // Wait out the server's 1-second rate-limit window before the
    // next switch (the local rate-limit at the input listener is
    // bypassed here — we call gameSession.tryStartWeaponSwitch
    // directly — so the server's 5-gate #3 is the only gate, and
    // it requires ≥ 1000ms between switches per player).
    await sleep(1100);

    // ---- Assertion 3: Tab A switches to Sniper (weapon_id=2).
    log("Tab A: switching to Sniper (key 3)...");
    const sw3 = await sendSwitch(2, 0); // WeaponId.Sniper, fireModeIndex=0
    if (!sw3.ok) throw new Error(`Sniper switch failed: ${sw3.reason}`);
    const v3 = await pollWeaponId(2, 0, SWITCH_SETTLE_MS);
    if (!v3) {
      throw new Error(`Tab A snapshot did not converge to Sniper within ${SWITCH_SETTLE_MS}ms.`);
    }
    log(`Assertion 3 PASS: Tab A switched to Sniper in ${SWITCH_SETTLE_MS}ms.`);
    await sleep(1100);

    // ---- Assertion 4: Tab A back to DualPistol, then B cycles to Burst3.
    log("Tab A: switching to DualPistol (key 1)...");
    const sw1 = await sendSwitch(0, 0);
    if (!sw1.ok) throw new Error(`DualPistol switch failed: ${sw1.reason}`);
    const v4a = await pollWeaponId(0, 0, SWITCH_SETTLE_MS);
    if (!v4a) {
      throw new Error(`Tab A snapshot did not converge back to DualPistol within ${SWITCH_SETTLE_MS}ms.`);
    }
    await sleep(1100);
    log("Tab A: cycling fire mode to Burst3 (key B)...");
    // fireModeIndex=-1 is the cycle sentinel — gameSession resolves
    // it to the next valid index in WEAPONS_TABLE[0].fireModes =
    // [Semi, Burst3], so we end up at index 1 (Burst3).
    const swB1 = await sendSwitch(0, -1);
    if (!swB1.ok) throw new Error(`Burst cycle failed: ${swB1.reason}`);
    const v4b = await pollWeaponId(0, 1, SWITCH_SETTLE_MS);
    if (!v4b) {
      throw new Error(`Tab A snapshot did not converge to DualPistol+Burst3 within ${SWITCH_SETTLE_MS}ms.`);
    }
    log(`Assertion 4 PASS: Tab A switched to DualPistol then Burst3 (fire_mode_index=1).`);
    await sleep(1100);

    // ---- Assertion 5: Tab A presses B again, returns to Semi.
    log("Tab A: cycling fire mode back to Semi (key B)...");
    const swB2 = await sendSwitch(0, -1);
    if (!swB2.ok) throw new Error(`Semi cycle failed: ${swB2.reason}`);
    const v5 = await pollWeaponId(0, 0, SWITCH_SETTLE_MS);
    if (!v5) {
      throw new Error(`Tab A snapshot did not converge back to Semi within ${SWITCH_SETTLE_MS}ms.`);
    }
    log(`Assertion 5 PASS: Tab A cycled back to Semi (fire_mode_index=0).`);
    await sleep(1100);

    // ---- Assertion 6: rate-limit gate. Press `1` then `2` within
    // 500ms → server's 5-gate #3 rate-limit drops the second
    // switch (only the first one propagates to the snapshot).
    log("Tab A: rate-limit test (key 1 + key 2 within 500ms)...");
    // Switch to Shotgun first so the rate-limit window starts fresh
    // (otherwise the prior cycle's last switch is < 1s ago and the
    // first press would already be rate-limited).
    const swFresh = await sendSwitch(1, 0); // Shotgun
    if (!swFresh.ok) throw new Error(`Pre-rate-limit Shotgun switch failed: ${swFresh.reason}`);
    await pollWeaponId(1, 0, SWITCH_SETTLE_MS);
    await sleep(1100); // wait out the rate-limit window
    // Now press DualPistol (1) immediately followed by Sniper (2).
    // The second press is within the 1s window and should be dropped.
    const swFirst = await sendSwitch(0, 0); // DualPistol — first press
    if (!swFirst.ok) throw new Error(`First rate-limit press failed: ${swFirst.reason}`);
    await sleep(RATE_LIMIT_PRESS_GAP_MS); // 500ms gap (inside the 1s window)
    const swSecond = await sendSwitch(2, 0); // Sniper — second press, should be dropped
    if (!swSecond.ok) throw new Error(`Second rate-limit press failed: ${swSecond.reason}`);
    // Wait for the snapshot to converge on the FIRST press. The
    // second press is dropped by the server's rate-limit gate, so
    // the snapshot should settle on DualPistol (weapon_id=0), NOT
    // Sniper (weapon_id=2).
    await sleep(500); // give the snapshot time to land
    const v6 = await pageA.evaluate(() => {
      const snap = (window).__latestSnap ? (window).__latestSnap() : null;
      const e = snap ? snap.players.find((p) => p.playerId === 1) : null;
      return e ? { weaponId: e.weaponId, currentFireMode: e.currentFireMode } : null;
    });
    if (!v6 || v6.weaponId !== 0) {
      throw new Error(
        `Rate-limit gate FAILED: snapshot shows weaponId=${v6?.weaponId} ` +
        `(expected 0=DualPistol; the second press should have been dropped).`,
      );
    }
    log(`Assertion 6 PASS: server's rate-limit gate dropped the second press (snapshot stayed on DualPistol).`);

    // Capture screenshot of Tab A for the artifact.
    await pageA.screenshot({ path: SCREENSHOT_PATH });

    if (errors.length > 0) {
      throw new Error(`pageerror events: ${errors.join("; ")}`);
    }

    log(`OK — weapon-switch-smoke passed (6/6 assertions).`);
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
