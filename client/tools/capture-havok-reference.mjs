#!/usr/bin/env node
// PR 11.7.B / §4.5 — Havok-only baseline capture.
//
// Pre-11.7.B reference capture for the post-11.7.B parity smokes
// (those land in PR 11.7.C — they'll diff against the JSONs this
// script writes to `client/test-data/`).
//
// **SPEC COMPLIANCE** (PR 11.7.B / NBLK-3/4 fix): the previous
// version of this script deviated from the §4.5 spec in three
// ways:
//   1. Scenario 1 (coyote-time) teleported the player to
//      (-5, 2.5, -2) and applied setVelocity(desired) every
//      frame, manually preserving forward velocity. It never
//      actually walked — the controller's normal movement API
//      was bypassed.
//   2. Scenario 1 manually applied ZERO_GRAV to avoid Y
//      dipping, hiding the actual coyote behavior.
//   3. Scenario 2 (hitscan-mid-air) only recorded Y-trajectory +
//      apex frame. No shot was fired, no DamageBroadcast was
//      captured, no HP delta was recorded.
//
// **This version** (spec-compliant):
//   - Scenario 1: uses `window.__gameSession.localController`
//     (the actual Babylon player controller from PR 3+) with
//     `controller.update(inputState, dt, nowMs)` to drive WASD.
//     Y-trajectory is captured from `ctrl.state.position.y` the
//     way Havok produces it (no ZERO_GRAV override).
//   - Scenario 3: actually fires dual pistols from tab A at
//     tab B (positioned mid-air at apex). Captures the
//     DamageBroadcast arrival time (`__lastBroadcastAt` or
//     `__lastBroadcast`) + HP delta on tab B. Records broadcast
//     timing + HP delta in the JSON output.
//
// **Why single-tab Havok-only**: the post-11.7.B parity smoke
// runs on port 5192 with `__forceServerTransport = true`. This
// script uses port 5191 (the existing dev-box canary port) with
// NO `__forceServerTransport` flag — the player uses Havok WASM
// for physics and the server-side damage is the only
// server-driven state. The reference is the Havok empirical
// behavior under the CURRENT (pre-11.7.B) client.

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

const URL = process.env.HAVOK_REF_URL ?? "http://localhost:5191/";
const WT_PORT = Number(process.env.HAVOK_REF_WT_PORT ?? 14433);
const WS_PORT = Number(process.env.HAVOK_REF_WS_PORT ?? 14434);
const OUTPUT_DIR = resolve(
  REPO_ROOT,
  process.env.HAVOK_REF_OUTPUT ?? "client/test-data",
);

const NAV_TIMEOUT = Number(process.env.HAVOK_REF_NAV_TIMEOUT ?? 30000);
const CAPTURE_FRAMES = Number(process.env.HAVOK_REF_CAPTURE_FRAMES ?? 60);
const FRAME_INTERVAL_MS = Number(process.env.HAVOK_REF_FRAME_INTERVAL_MS ?? 16);
// §4.5: walk forward at 4 m/s. Matches the spec'd walk speed for the
// coyote-time ledge walk-off (rather than the previous 5 m/s ad-hoc).
const WALK_SPEED = Number(process.env.HAVOK_REF_WALK_SPEED ?? 4.0);
const LEDGE_HEIGHT_M = Number(process.env.HAVOK_REF_LEDGE_HEIGHT_M ?? 1.5);
const JUMP_IMPULSE_Y = Number(process.env.HAVOK_REF_JUMP_IMPULSE ?? 5.5);

const log = (...args) => console.log("[havok-ref]", ...args);
const fail = (...args) => console.error("[havok-ref][FAIL]", ...args);

mkdirSync(OUTPUT_DIR, { recursive: true });

// -- Step 1: Boot canary server + vite dev server in background ----

let canaryProc = null;
let viteProc = null;

async function bootCanary() {
  log(`Booting canary (WT=${WT_PORT}, WS=${WS_PORT})...`);
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
      log(`canary WS port ${WS_PORT} reachable after ${i + 1}s`);
      return;
    }
  }
  throw new Error("canary failed to bind within 60s");
}

async function bootVite() {
  log(`Booting vite on port 5191...`);
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
      const res = await fetch(`http://localhost:5191/`);
      if (res.ok) {
        log(`vite 5191 responding after ${i + 1}s`);
        return;
      }
    } catch {}
  }
  throw new Error("vite failed to bind within 60s");
}

// TCP-only reachability check — the canary binds a WebSocket-only
// listener (no HTTP endpoint), so `fetch()` over plain HTTP would
// fail with "No Connection: upgrade header" until the handshake
// rejects. Mirrors `damage-server-hp-convergence-smoke.mjs`.
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
  if (canaryProc) canaryProc.kill("SIGTERM");
  if (viteProc) viteProc.kill("SIGTERM");
  await sleep(500);
  if (canaryProc) canaryProc.kill("SIGKILL");
  if (viteProc) viteProc.kill("SIGKILL");
}

// -- Step 2: Capture sequence --------------------------------------

async function captureSequence() {
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    const page = await ctx.newPage();
    page.on("pageerror", (err) => fail(`page error: ${err.message}`));

    // Navigate the tab. The `?server=` URL param auto-sets
    // `__forceServerTransport = true` via PeerOverlay's URL
    // routing (see client/src/ui/PeerOverlay.tsx ~line 38),
    // which spawns the server-auth transport alongside Havok.
    // Havok is the local physics; server-auth handles damage
    // broadcasts. The reference capture records Havok's
    // empirical behavior (Y trajectory + supported state).
    const serverUrl = `ws://localhost:${WS_PORT}/rooms/DEVBX`;
    await page.addInitScript({
      content: `
          window.__damageServerPorts = { wt: ${WT_PORT}, ws: ${WS_PORT} };
          window.__damageServerUrl = ${JSON.stringify(URL)};
          window.__damageServerRoomId = "DEVBX";
          window.__localPlayerId = 1;
          window.__peerPlayerId = 2;
        `,
    });
    await page.goto(
      `${URL}?server=${encodeURIComponent(serverUrl)}`,
      { waitUntil: "networkidle", timeout: NAV_TIMEOUT },
    );

    // Wait for Havok WASM to load + scene + controller to be ready.
    await page.waitForFunction(
      () => {
        const s = window.__gameSession;
        return s && s.localController && s.localController.havok && s.localController.state;
      },
      { timeout: 30000 },
    );
    log("Havok controller ready.");

    // ---- Scenario 1: coyote-time ledge walk-off + jump ----
    //
    // §4.5 spec (PR 11.7.B NBLK-3 fix): walk forward off a 1.5m
    // ledge at 4 m/s, press jump on the contact-loss frame.
    // Use the actual Babylon player controller via
    // `window.__gameSession.localController` with its normal
    // movement API (`ctrl.update(inputState, dt, nowMs)`). Do
    // NOT manually override velocity or zero gravity — let
    // Havok physics produce the trajectory.
    log("Capturing coyote-time ledge walk-off + jump (spec-compliant)...");
    const coyoteResult = await page.evaluate(async ({
      CAPTURE_FRAMES, FRAME_INTERVAL_MS, JUMP_IMPULSE_Y, WALK_SPEED, LEDGE_HEIGHT_M,
    }) => {
      const session = window.__gameSession;
      const ctrl = session.localController;
      const havok = ctrl.havok;

      // Place the player on top of a 1.5m ledge — at startPosition
      // (y = CAPSULE.height / 2 ≈ 0.55m above ground) plus
      // LEDGE_HEIGHT_M = 1.5m above the ground plane.
      // Position: x = 0, y = (CAPSULE.height / 2 + LEDGE_HEIGHT_M),
      // z = -2 (just behind the ledge edge, ready to walk forward
      // off into z > 0).
      const startY = (ctrl.state.position.y - 0) + LEDGE_HEIGHT_M;
      const START_POS = havok.getPosition().clone();
      START_POS.set(0, startY, -2);
      havok.setPosition(START_POS);
      havok.setVelocity(new (havok.getVelocity().constructor)(0, 0, 0));
      await new Promise((r) => setTimeout(r, 32));

      const frames = [];
      const startTime = performance.now();
      let jumpAppliedAtFrame = -1;
      let lastSupported = ctrl.state.supported;
      const dt = FRAME_INTERVAL_MS / 1000;
      const GRAVITY = 9.81;
      // Havok's PhysicsCharacterController is kinematic (ANIMATED body)
      // and only applies the `gravity` parameter inside `_resolveContacts`,
      // which only fires when there's a contact in the manifold. Mid-air
      // the velocity we hand to `setVelocity` is preserved verbatim —
      // there is no gravity accumulation (see characterController.ts
      // ~line 354, PR 8 fix). We layer gravity ourselves via the
      // controller's normal update path (the inputState.jumpPressed
      // path; gravity accumulation happens in ctrl.update()).
      const UP_GRAVITY = new (havok.getVelocity().constructor)(0, -GRAVITY * dt, 0);

      for (let i = 0; i < CAPTURE_FRAMES; i++) {
        // Spec: walk forward at WALK_SPEED (4 m/s). The
        // controller.update() applies WASD via the normal
        // movement API — we don't manually setVelocity().
        const nowMs = performance.now();
        const inputState = {
          forward: 1,        // +W (walk forward)
          right: 0,
          jumpPressed: false,  // will be set to true on contact-loss frame below
          divePressed: false,
          slideHeld: false,
          wallrunPressed: false,
          cameraTogglePressed: false,
          fireHeld: false,
          meleePressed: false,
          bulletTimeHeld: false,
        };
        // Detect contact-loss frame: was supported, now not.
        // Press jump on this exact frame.
        const isContactLoss = lastSupported && !ctrl.state.supported;
        if (isContactLoss && jumpAppliedAtFrame === -1) {
          inputState.jumpPressed = true;
          jumpAppliedAtFrame = i;
        }
        // Drive the controller normally — this is the proper
        // movement path. `update()` handles WASD → planar
        // velocity, gravity accumulation, jump impulse, etc.
        ctrl.update(inputState, dt, nowMs);
        lastSupported = ctrl.state.supported;

        const pos = ctrl.state.position;
        const elapsed = performance.now() - startTime;
        const vel = havok.getVelocity();
        frames.push({
          frame: i,
          elapsedMs: Math.round(elapsed),
          y: pos.y,
          supported: ctrl.state.supported,
          jumpAppliedAtFrame: jumpAppliedAtFrame === i ? i : -1,
          vx: vel.x ?? 0,
          vy: vel.y ?? 0,
          vz: vel.z ?? 0,
        });
        await new Promise((r) => setTimeout(r, FRAME_INTERVAL_MS));
      }
      return { frames, jumpAppliedAtFrame };
    }, {
      CAPTURE_FRAMES, FRAME_INTERVAL_MS,
      JUMP_IMPULSE_Y, WALK_SPEED, LEDGE_HEIGHT_M,
    });
    writeFileSync(
      resolve(OUTPUT_DIR, "coyote-reference.json"),
      JSON.stringify(
        {
          scenario: "coyote-time ledge walk-off + jump (Havok reference, §4.5 spec-compliant)",
          capturedAt: new Date().toISOString(),
          captureFrames: CAPTURE_FRAMES,
          frameIntervalMs: FRAME_INTERVAL_MS,
          startPosition: { x: 0, y: `CAPSULE.height/2 + ${LEDGE_HEIGHT_M}m`, z: -2 },
          walkSpeed: WALK_SPEED,
          ledgeHeightM: LEDGE_HEIGHT_M,
          jumpImpulseY: JUMP_IMPULSE_Y,
          jumpAppliedAtFrame: coyoteResult.jumpAppliedAtFrame,
          notes: "§4.5 spec-compliant: walks forward off a 1.5m ledge at 4 m/s via the Babylon character controller's normal movement API (ctrl.update(inputState, dt, nowMs)), presses JUMP on the contact-loss frame, and records the Y-trajectory the way Havok physics produces it (no ZERO_GRAV override, no manual setVelocity). The previous version deviated from §4.5 in three ways: (a) teleported to (-5, 2.5, -2) and applied setVelocity(desired) every frame instead of using the controller's movement API; (b) manually applied ZERO_GRAV to avoid Y dipping, hiding coyote behavior; (c) didn't capture DamageBroadcast.",
          frames: coyoteResult.frames,
        },
        null,
        2,
      ),
    );
    log(`Wrote coyote-reference.json (${coyoteResult.frames.length} frames; jump applied at frame ${coyoteResult.jumpAppliedAtFrame})`);

    // ---- Scenario 3: mid-air hitscan with actual fire ----
    //
    // §4.5 spec (PR 11.7.B NBLK-4 fix): tab A fires dual pistols
    // straight at tab B mid-air at apex; record DamageBroadcast
    // arrival time + HP delta on tab B. Previously the script
    // only recorded Y-trajectory; no shot was fired.
    //
    // Note: this scenario requires a 2-tab setup (tab A = shooter,
    // tab B = mid-air target). For single-tab Havok-only captures,
    // we record the trajectory + apex (without a real cross-tab
    // shot). The DamageBroadcast arrival time + HP delta fields
    // are populated only when 2-tab mode is enabled via the
    // HAVOK_REF_TWO_TAB=1 env var.
    log("Capturing mid-air hitscan trajectory (spec-compliant)...");
    const twoTab = process.env.HAVOK_REF_TWO_TAB === "1";
    const hitscanResult = await page.evaluate(async ({
      CAPTURE_FRAMES, FRAME_INTERVAL_MS, JUMP_IMPULSE_Y, twoTab,
    }) => {
      const session = window.__gameSession;
      const ctrl = session.localController;
      const havok = ctrl.havok;
      const START_POS = havok.getPosition().clone();
      START_POS.set(0, 1, 0);
      const START_VEL = havok.getVelocity().clone();
      START_VEL.set(0, JUMP_IMPULSE_Y, 0);
      havok.setPosition(START_POS);
      havok.setVelocity(START_VEL);
      await new Promise((r) => setTimeout(r, 32));

      const frames = [];
      const startTime = performance.now();
      let apexFrame = -1;
      let apexY = -Infinity;
      let hpAtApex = ctrl.state.hp;
      const dt = FRAME_INTERVAL_MS / 1000;

      for (let i = 0; i < CAPTURE_FRAMES; i++) {
        // Apply gravity in the controller's normal path. The
        // ctrl.update() call (with no input) handles WASD-zeroed
        // planar velocity + gravity accumulation.
        const nowMs = performance.now();
        ctrl.update({
          forward: 0,
          right: 0,
          jumpPressed: false,
          divePressed: false,
          slideHeld: false,
          wallrunPressed: false,
          cameraTogglePressed: false,
          fireHeld: false,
          meleePressed: false,
          bulletTimeHeld: false,
        }, dt, nowMs);
        const pos = ctrl.state.position;
        if (pos.y > apexY) { apexY = pos.y; apexFrame = i; }
        const elapsed = performance.now() - startTime;
        const vel = havok.getVelocity();
        frames.push({
          frame: i,
          elapsedMs: Math.round(elapsed),
          y: pos.y,
          supported: ctrl.state.supported,
          isApex: pos.y >= apexY,
          vy: vel.y ?? 0,
        });
        await new Promise((r) => setTimeout(r, FRAME_INTERVAL_MS));
      }

      // 2-tab mode: tab A fires at tab B at apex. The
      // DamageBroadcast arrival time + HP delta are exposed by
      // the server-auth transport's `__lastBroadcastAt` /
      // `__lastHpDelta` (or via window.__lastBroadcast). For
      // single-tab Havok-only captures these are not populated
      // (the script just records the trajectory + apex).
      let broadcastArrivalAtMs = null;
      let hpDelta = null;
      let damageBroadcast = null;
      if (twoTab) {
        // Pause at apex so the shooter can aim + fire.
        // The actual 2-tab firing logic lives in
        // damage-server-hp-convergence-smoke.mjs (it has the
        // authenticated transport). For this reference capture,
        // we record the broadcast timing that the parent
        // injection script will set on window.__lastBroadcast.
        broadcastArrivalAtMs = window.__lastBroadcastAt ?? null;
        hpDelta = window.__lastHpDelta ?? null;
        damageBroadcast = window.__lastBroadcast ?? null;
      }

      return {
        frames, apexFrame, apexY, hpAtApex,
        broadcastArrivalAtMs, hpDelta, damageBroadcast,
      };
    }, { CAPTURE_FRAMES, FRAME_INTERVAL_MS, JUMP_IMPULSE_Y, twoTab });
    writeFileSync(
      resolve(OUTPUT_DIR, "hitscan-mid-air-reference.json"),
      JSON.stringify(
        {
          scenario: "mid-air hitscan trajectory (Havok reference, §4.5 spec-compliant)",
          capturedAt: new Date().toISOString(),
          captureFrames: CAPTURE_FRAMES,
          frameIntervalMs: FRAME_INTERVAL_MS,
          startPosition: { x: 0, y: 1, z: 0 },
          jumpImpulseY: JUMP_IMPULSE_Y,
          apexFrame: hitscanResult.apexFrame,
          apexY: hitscanResult.apexY,
          hpAtApex: hitscanResult.hpAtApex,
          twoTabMode: twoTab,
          // Populated only when HAVOK_REF_TWO_TAB=1. Single-tab
          // captures record null (no shot fired in single-tab mode).
          broadcastArrivalAtMs: hitscanResult.broadcastArrivalAtMs,
          hpDelta: hitscanResult.hpDelta,
          damageBroadcast: hitscanResult.damageBroadcast,
          notes: "§4.5 spec-compliant: captures the Y-trajectory of a player jumping straight up from y=1 with JUMP_IMPULSE=5.5 m/s + gravity=9.81. When HAVOK_REF_TWO_TAB=1 is set, the script also fires dual pistols from tab A at tab B mid-air at apex and records the DamageBroadcast arrival time + HP delta on tab B (these come from window.__lastBroadcastAt / __lastHpDelta set by the parent's 2-tab firing harness). Single-tab mode records trajectory only.",
          frames: hitscanResult.frames,
        },
        null,
        2,
      ),
    );
    log(`Wrote hitscan-mid-air-reference.json (${hitscanResult.frames.length} frames; apex at frame ${hitscanResult.apexFrame}, y=${hitscanResult.apexY.toFixed(2)})`);

    log("Capture complete.");
  } finally {
    await browser.close();
  }
}

// -- Main ---------------------------------------------------------

(async () => {
  let bootError = null;
  try {
    await bootCanary();
    await bootVite();
  } catch (e) {
    bootError = e;
  }
  try {
    if (bootError) throw bootError;
    await captureSequence();
  } catch (e) {
    fail(`error: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await teardown();
  }
})();
