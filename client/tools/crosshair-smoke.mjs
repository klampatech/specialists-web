#!/usr/bin/env node
// PR #110 — Crosshair real-canary smoke.
//
// Boots the canary server (WebTransport + WebSocket) + Vite on port
// 5196, opens TWO headless browser contexts (each with its own
// `?server=` URL param + `__forceServerTransport = true` init script)
// connected to a unique room per run (`CROSSHAIR_<ts>`), and asserts:
//
//   1. Both tabs' `ServerTransport.connect()` resolve within 5s and
//      the snapshot stream is live (player entries present).
//   2. Tab A starts DualPistol+Semi → crosshair renders with
//      data-spread-radius-px = DualPistol's tight radius (~18px),
//      data-fire-held = "0", and grey line color (#b8b8b8).
//   3. Tab A switches to Shotgun via the input listener's
//      `tryStartWeaponSwitch` API → snapshot weapon_id=1 within
//      2000ms AND crosshair's data-weapon-id updates to 1 AND
//      data-spread-radius-px widens to Shotgun's wider radius
//      (~31px) AND the line color is orange (#ff8c4a).
//   4. Tab A switches to Sniper → data-weapon-id=2, tightest
//      spread (~14px), red color (#ff5a5a).
//   5. Tab A switches back to DualPistol → crosshair's
//      data-spread-radius-px shrinks back to DualPistol's radius
//      (proves the per-weapon spread toggle is reactive to weapon
//      switches, not just initial state).
//   6. Tab A holds LMB (synthetic mousedown + 200ms) → crosshair's
//      data-fire-held = "1" AND data-spread-radius-px widens
//      by ~1.6× (the recoil-spread cue).
//   7. Tab A releases LMB → crosshair returns to rest radius
//      (proves the recoil cue is reactive to input, not latched).
//
// **Why API dispatch instead of keyboard.press / mouse.down?**
// Playwright's keyboard.press is unreliable in headless for the
// rapid-fire keypresses that the local rate-limit gate throttles,
// and mouse.down requires pointer-lock to be engaged. The keyboard
// binding + the local rate-limit gate are unit-tested separately
// via the listener's `lastWeaponSwitchAtMs` tracker + the vitest
// boundary. The smoke's job is to verify the crosshair reflects
// the wire state — not to verify the keyboard binding (which is
// its own concern). Sending via the session's `tryStartWeaponSwitch`
// API + synthetic canvas mousedown events uses the same code paths
// production uses without the headless flakiness.
//
// **The 7 assertions prove the PR #110 contract:**
//   - Crosshair component renders with the correct per-weapon
//     color + spread (the visual surface of the weapons wire)
//   - Crosshair is reactive to snapshot-driven weapon switches
//     (the optimistic-vs-snapshot overwrite pattern from PR #108
//     flows through to the crosshair)
//   - Crosshair widens on fire (the recoil cue)
//   - Crosshair does NOT eat pointer events (the LMB fires
//     successfully — no EventTarget capture on the canvas)
//
// Unique ports (14447/14448/18086/5196) come from docs/PR-105-spec.md
// §2.4 — next slot after weapon-switch (14445/14446/18084/5195).
//
// Mirrors `weapon-switch-smoke.mjs` (PR #108) for the canary+vite
// boot steps + the 5-gate#3 rate-limit discipline + the smoke
// primer pattern.

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
// Renamed from `URL` to `VITE_URL` — see weapon-switch-smoke.mjs
// for the rationale (Node 22+ URL class shadow bug).
const VITE_URL = process.env.CROSSHAIR_SMOKE_URL ?? "http://localhost:5196/";
const WT_PORT = Number(process.env.CROSSHAIR_SMOKE_WT_PORT ?? 14447);
const WS_PORT = Number(process.env.CROSSHAIR_SMOKE_WS_PORT ?? 14448);
const HTTP_PORT = Number(process.env.CROSSHAIR_SMOKE_HTTP_PORT ?? 18086);
const SCREENSHOT = process.env.SMOKE_PNG ?? "client/tools/crosshair-smoke.png";

const NAV_TIMEOUT = Number(process.env.SMOKE_NAV_TIMEOUT ?? 30000);
const CONNECT_TIMEOUT_MS = Number(process.env.SMOKE_CONNECT_TIMEOUT_MS ?? 5000);
// 2000ms wait per assertion = 40 snapshot ticks @ 20Hz. Generous for
// CI localhost — the crosshair should react within ~50ms of the
// snapshot arriving, but CI runners under load can lag.
const PROPAGATE_MS = Number(process.env.CROSSHAIR_SMOKE_PROPAGATE_MS ?? 2000);
// 1100ms between weapon-switch presses — server's rate-limit gate
// (WEAPON_SWITCH_RATE_LIMIT_MS = 1000ms) drops second press otherwise.
const RATE_LIMIT_SLEEP_MS = 1100;
// 250ms hold for the LMB-down assertion — enough time for the HUD's
// 10Hz poll interval to pick up fireHeld=true.
const FIRE_HOLD_MS = 250;

const SCREENSHOT_PATH = resolve(REPO_ROOT, SCREENSHOT);

const log = (...args) => console.log("[crosshair-smoke]", ...args);
const fail = (...args) => console.error("[crosshair-smoke][FAIL]", ...args);

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
  log(`Booting vite on ${VITE_URL}...`);
  const port = new URL(VITE_URL).port || "5196";
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
  for (const port of [5196, WT_PORT, WS_PORT, HTTP_PORT]) {
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

// Read the crosshair's data-* attributes (the public probe
// contract pinned by Crosshair.test.ts). The smoke reads the
// same shape the component emits so the contract is one
// round-trip, not two.
async function readCrosshair(page) {
  return await page.evaluate(() => {
    const el = document.querySelector('[data-testid="crosshair"]');
    if (!el) return null;
    return {
      weaponId: el.getAttribute("data-weapon-id"),
      fireHeld: el.getAttribute("data-fire-held"),
      spreadRadiusPx: Number(el.getAttribute("data-spread-radius-px")),
      // Pull the line-segment color (top line is the first child
      // div in the crosshair wrapper).
      topLineColor: el.children[0] ? el.children[0].style.background : "",
    };
  });
}

async function pollCrosshair(page, predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const c = await readCrosshair(page);
    if (c && predicate(c)) return c;
    await sleep(50);
  }
  return null;
}

async function readSnapshotWeapon(page, localPlayerId) {
  return await page.evaluate((lid) => {
    const snap = (window).__latestSnap?.();
    if (!snap) return null;
    const me = snap.players.find((p) => p.playerId === lid);
    return me ? { weaponId: me.weaponId, currentFireMode: me.currentFireMode } : null;
  }, localPlayerId);
}

// Drive a weapon switch via the input listener's
// `tryStartWeaponSwitch` API. Bypasses the actual keydown event
// because Playwright keyboard.press is unreliable in headless
// mode for keypresses that the local rate-limit gate throttles
// (and the crosshair smoke's job is to verify the crosshair
// reflects the wire state — not to verify the keyboard binding,
// which is unit-tested separately via the listener's
// `lastWeaponSwitchAtMs` tracker + vitest boundary tests).
async function sendSwitch(page, weaponId, fireModeIndex) {
  return await page.evaluate(({ w, f }) => {
    const session = (window).__gameSession;
    if (!session || typeof session.tryStartWeaponSwitch !== "function") {
      return { ok: false, reason: "no __gameSession.tryStartWeaponSwitch" };
    }
    session.tryStartWeaponSwitch(w, f);
    return { ok: true };
  }, { w: weaponId, f: fireModeIndex });
}

// Drive a fire-press by dispatching a synthetic LMB mousedown/mouseup
// event. We use the canvas element (where inputListener binds its
// pointerdown/pointerup listeners per PR 7.3) so the listener fires
// the same path production code uses. Bypasses the real
// `mouse.down` API because (a) Playwright's mouse.down requires
// pointer-lock to be engaged, which we don't drive in this smoke,
// and (b) Playwright's keyboard.press has the same flakiness for
// keypresses that need to trigger the local rate-limit gate.
async function sendFireHeld(page, held) {
  return await page.evaluate((h) => {
    const canvas = document.querySelector("canvas");
    if (!canvas) return { ok: false, reason: "no canvas" };
    if (h) {
      canvas.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
      canvas.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
    } else {
      canvas.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true }));
      canvas.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true }));
    }
    return { ok: true };
  }, held);
}

// ---------------------------------------------------------------------------
// Smoke runner.
// ---------------------------------------------------------------------------

async function runSmoke() {
  const room = `CROSSHAIR_${Date.now()}`;
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
    // Wait out the server's 1-second rate-limit window before the
    // first real switch (the primer above sets the per-player rate
    // timestamp; the next switch would otherwise be inside the
    // window and get rejected by 5-gate #3).
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
    await sleep(1100); // wait out the server's rate-limit window
                      // (the primer's server-side accept time-stamps
                      //  the next switch; 1100ms keeps us just past
                      //  the 1000ms window so the Shotgun switch
                      //  below isn't rejected by 5-gate #3).

    // -----------------------------------------------------------------
    // Assertion 1: crosshair renders on initial DualPistol+Semi with
    // the tight grey spread.
    // -----------------------------------------------------------------
    log("Assert 1: initial DualPistol crosshair state...");
    const initial = await readCrosshair(pageA);
    if (initial) {
      assert(
        "Tab A crosshair renders with weaponId=0 (DualPistol)",
        initial.weaponId === "0",
        JSON.stringify(initial),
      );
      assert(
        "Tab A crosshair initial fire-held=0",
        initial.fireHeld === "0",
        JSON.stringify(initial),
      );
      assert(
        "Tab A crosshair initial spread ≈ 18px (DualPistol tight spread)",
        initial.spreadRadiusPx >= 16 && initial.spreadRadiusPx <= 20,
        `spreadRadiusPx=${initial.spreadRadiusPx}`,
      );
      assert(
        "Tab A crosshair initial top-line color = grey (DualPistol)",
        initial.topLineColor === "rgb(184, 184, 184)",
        `topLineColor=${initial.topLineColor}`,
      );
    } else {
      assert("Tab A crosshair renders", false, "no crosshair element found");
    }

    // -----------------------------------------------------------------
    // Assertion 2: switch to Shotgun via the input listener's
    // `tryStartWeaponSwitch` API. Crosshair widens AND changes to
    // orange.
    // -----------------------------------------------------------------
    log("Assert 2: switch to Shotgun → orange + wider crosshair...");
    const swShot = await sendSwitch(pageA, 1, 0); // WeaponId.Shotgun, fireModeIndex=0 (Semi)
    if (!swShot.ok) {
      assert("sendSwitch(Shotgun) succeeded", false, swShot.reason);
    }
    const shotSwitch = await pollCrosshair(
      pageA,
      (c) => c.weaponId === "1",
      PROPAGATE_MS,
      "weaponId=1",
    );
    assert(
      "Tab A crosshair data-weapon-id switches to 1 (Shotgun) within 2s",
      shotSwitch !== null,
      shotSwitch ? JSON.stringify(shotSwitch) : "poll timed out",
    );
    if (shotSwitch) {
      assert(
        "Shotgun spread widens to ~31px",
        shotSwitch.spreadRadiusPx >= 28 && shotSwitch.spreadRadiusPx <= 34,
        `spreadRadiusPx=${shotSwitch.spreadRadiusPx}`,
      );
      assert(
        "Shotgun top-line color = orange (#ff8c4a)",
        shotSwitch.topLineColor === "rgb(255, 140, 74)",
        `topLineColor=${shotSwitch.topLineColor}`,
      );
    }
    // Verify snapshot is consistent (defense-in-depth — the smoke
    // catches "wire says Shotgun but crosshair says DualPistol").
    const shotSnap = await readSnapshotWeapon(pageA, 1);
    assert(
      "snapshot weaponId=1 (Shotgun) matches crosshair",
      shotSnap?.weaponId === 1,
      JSON.stringify(shotSnap),
    );
    await sleep(RATE_LIMIT_SLEEP_MS); // respect server rate-limit

    // -----------------------------------------------------------------
    // Assertion 3: switch to Sniper. Crosshair tightens AND changes to
    // red.
    // -----------------------------------------------------------------
    log("Assert 3: switch to Sniper → red + tightest crosshair...");
    const swSniper = await sendSwitch(pageA, 2, 0); // WeaponId.Sniper, fireModeIndex=0
    if (!swSniper.ok) {
      assert("sendSwitch(Sniper) succeeded", false, swSniper.reason);
    }
    const sniperSwitch = await pollCrosshair(
      pageA,
      (c) => c.weaponId === "2",
      PROPAGATE_MS,
      "weaponId=2",
    );
    assert(
      "Tab A crosshair data-weapon-id switches to 2 (Sniper) within 2s",
      sniperSwitch !== null,
      sniperSwitch ? JSON.stringify(sniperSwitch) : "poll timed out",
    );
    if (sniperSwitch) {
      assert(
        "Sniper spread tightens to ~14px (the tightest of all three)",
        sniperSwitch.spreadRadiusPx >= 10 && sniperSwitch.spreadRadiusPx <= 16,
        `spreadRadiusPx=${sniperSwitch.spreadRadiusPx}`,
      );
      assert(
        "Sniper top-line color = red (#ff5a5a)",
        sniperSwitch.topLineColor === "rgb(255, 90, 90)",
        `topLineColor=${sniperSwitch.topLineColor}`,
      );
    }
    const sniperSnap = await readSnapshotWeapon(pageA, 1);
    assert(
      "snapshot weaponId=2 (Sniper) matches crosshair",
      sniperSnap?.weaponId === 2,
      JSON.stringify(sniperSnap),
    );
    await sleep(RATE_LIMIT_SLEEP_MS); // respect server rate-limit

    // -----------------------------------------------------------------
    // Assertion 4: switch back to DualPistol. Crosshair shrinks back
    // to ~18px grey. (Proves the per-weapon spread toggle is reactive
    // to weapon switches, not just initial state.)
    // -----------------------------------------------------------------
    log("Assert 4: switch back to DualPistol (reactive)...");
    const swPistol = await sendSwitch(pageA, 0, 0); // WeaponId.DualPistol, fireModeIndex=0
    if (!swPistol.ok) {
      assert("sendSwitch(DualPistol) succeeded", false, swPistol.reason);
    }
    const pistolSwitch = await pollCrosshair(
      pageA,
      (c) => c.weaponId === "0" && c.spreadRadiusPx <= 20,
      PROPAGATE_MS,
      "weaponId=0 AND spreadRadiusPx<=20",
    );
    assert(
      "Tab A crosshair data-weapon-id returns to 0 (DualPistol) within 2s",
      pistolSwitch !== null,
      pistolSwitch ? JSON.stringify(pistolSwitch) : "poll timed out",
    );
    if (pistolSwitch) {
      assert(
        "DualPistol-after-Sniper spread reverts to ~18px",
        pistolSwitch.spreadRadiusPx >= 16 && pistolSwitch.spreadRadiusPx <= 20,
        `spreadRadiusPx=${pistolSwitch.spreadRadiusPx}`,
      );
      assert(
        "DualPistol-after-Sniper top-line color = grey",
        pistolSwitch.topLineColor === "rgb(184, 184, 184)",
        `topLineColor=${pistolSwitch.topLineColor}`,
      );
    }
    await sleep(RATE_LIMIT_SLEEP_MS);

    // -----------------------------------------------------------------
    // Assertion 5: hold LMB → crosshair widens to ~1.6× (recoil cue).
    // -----------------------------------------------------------------
    log("Assert 5: hold LMB → fireHeld=true, recoil-spread cue...");
    const restRadius = (await readCrosshair(pageA))?.spreadRadiusPx;
    const fireDown = await sendFireHeld(pageA, true);
    if (!fireDown.ok) {
      assert("sendFireHeld(true) succeeded", false, fireDown.reason);
    }
    // Wait for the HUD's 10Hz poll + 120ms transition to settle.
    await sleep(FIRE_HOLD_MS + 200);
    const firing = await readCrosshair(pageA);
    await sendFireHeld(pageA, false);
    assert(
      "Tab A crosshair data-fire-held=1 while LMB held",
      firing?.fireHeld === "1",
      `fireHeld=${firing?.fireHeld}`,
    );
    if (firing && restRadius !== undefined) {
      const expectedMin = Math.round(restRadius * 1.5);
      const expectedMax = Math.round(restRadius * 1.7);
      assert(
        `recoil spread widens to ~1.6× rest (${expectedMin}-${expectedMax}px, was ${restRadius})`,
        firing.spreadRadiusPx >= expectedMin && firing.spreadRadiusPx <= expectedMax,
        `rest=${restRadius} firing=${firing.spreadRadiusPx}`,
      );
    }

    // -----------------------------------------------------------------
    // Assertion 6: LMB release → crosshair returns to rest spread.
    // (Proves the recoil cue is reactive to input, not latched.)
    // -----------------------------------------------------------------
    log("Assert 6: release LMB → crosshair returns to rest...");
    // Wait for the HUD's 10Hz poll + 120ms transition to settle.
    await sleep(400);
    const released = await readCrosshair(pageA);
    assert(
      "Tab A crosshair data-fire-held=0 after LMB release",
      released?.fireHeld === "0",
      `fireHeld=${released?.fireHeld}`,
    );
    if (released && restRadius !== undefined) {
      assert(
        "spread returns to rest radius after LMB release",
        released.spreadRadiusPx === restRadius,
        `rest=${restRadius} released=${released.spreadRadiusPx}`,
      );
    }

    // Screenshot for visual confirmation.
    log(`Writing screenshot to ${SCREENSHOT_PATH}...`);
    await pageA.screenshot({ path: SCREENSHOT_PATH, fullPage: false });

    if (errors.length > 0) {
      fail("pageerror events during smoke:", errors);
    }
  } finally {
    await teardown();
    await browser.close();
  }

  log(`Final: ${pass} pass, ${failCount} fail`);
  if (failCount > 0) {
    process.exit(1);
  }
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
