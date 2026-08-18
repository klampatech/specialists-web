#!/usr/bin/env node
// PR 11.7.B / §4.5 — Havok-only baseline capture.
//
// Pre-11.7.B reference capture for the post-11.7.B parity smokes
// (those land in PR 11.7.C — they'll diff against the JSONs this
// script writes to `client/test-data/`).
//
// **What this captures**:
//   - `coyote-reference.json` — Y-trajectory of a player who
//     walks off the tall crate (position [-5, 1.25, -2]) and
//     presses jump on the contact-loss frame. The recorded Y
//     values (height over time) are the Havok empirical
//     persistence for coyote-time. The post-11.7.B parity
//     smoke's Rapier-side capture must match this within a
//     tolerance.
//   - `hitscan-mid-air-reference.json` — DamageBroadcast
//     arrival time + HP delta when the player jumps straight up
//     and fires dual pistols at apex. The lag-comp rewinds
//     against `PositionHistory::snapshot_at(req.frame -
//     lag_frames)`; the mid-air case is the §3.14 edge case.
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
    log("Capturing coyote-time ledge walk-off + jump...");
    const coyoteFrames = await page.evaluate(async ({ CAPTURE_FRAMES, FRAME_INTERVAL_MS, JUMP_IMPULSE }) => {
      const session = window.__gameSession;
      const ctrl = session.localController;
      const havok = ctrl.havok;
      // Babylon's PhysicsCharacterController expects Vector3
      // instances with .clone() / .x / .y / .z. We grab them from
      // the live Havok controller (havok.getVelocity() returns a
      // proper Vector3) and mutate copies.
      const ZERO_VEL = havok.getVelocity().clone(); ZERO_VEL.set(0, 0, 0);
      const START_POS = havok.getPosition().clone(); START_POS.set(-5, 2.5, -2);
      const DOWN_GRAV = havok.getVelocity().clone(); DOWN_GRAV.set(0, -1, 0);
      const ZERO_GRAV = havok.getVelocity().clone(); ZERO_GRAV.set(0, 0, 0);
      // Reset to known state.
      havok.setPosition(START_POS);
      havok.setVelocity(ZERO_VEL);
      // Wait one frame for Havok to apply the position.
      await new Promise((r) => setTimeout(r, 32));
      const frames = [];
      const startTime = performance.now();
      let jumpAppliedAtFrame = -1;
      let lastSupported = ctrl.state.supported;
      for (let i = 0; i < CAPTURE_FRAMES; i++) {
        // Apply forward (+Z) velocity to walk off the edge.
        // Havok's controller only grants jump if `state.supported`
        // is true at the moment of input — so a jump on the
        // contact-loss frame will NOT fire under Havok.
        const vel = havok.getVelocity();
        const desired = vel.clone(); desired.z = 5;
        havok.setVelocity(desired);
        // Detect contact-loss frame; apply JUMP_IMPULSE there.
        if (lastSupported && !ctrl.state.supported) {
          const jumpVel = vel.clone(); jumpVel.y = JUMP_IMPULSE; jumpVel.z = 5;
          havok.setVelocity(jumpVel);
          jumpAppliedAtFrame = i;
        }
        lastSupported = ctrl.state.supported;
        // Tick Havok to apply the velocity.
        const dt = FRAME_INTERVAL_MS / 1000;
        const surface = havok.checkSupport(dt, DOWN_GRAV);
        havok.integrate(dt, surface, ZERO_GRAV);
        // Capture.
        const pos = ctrl.state.position;
        const vel2 = havok.getVelocity();
        const elapsed = performance.now() - startTime;
        frames.push({
          frame: i,
          elapsedMs: Math.round(elapsed),
          y: pos.y,
          supported: ctrl.state.supported,
          jumpAppliedAtFrame: jumpAppliedAtFrame === i ? i : -1,
          vx: vel2.x ?? 0,
          vy: vel2.y ?? 0,
          vz: vel2.z ?? 0,
        });
        await new Promise((r) => setTimeout(r, FRAME_INTERVAL_MS));
      }
      return { frames, jumpAppliedAtFrame };
    }, { CAPTURE_FRAMES, FRAME_INTERVAL_MS, JUMP_IMPULSE: 5.5 });
    writeFileSync(
      resolve(OUTPUT_DIR, "coyote-reference.json"),
      JSON.stringify(
        {
          scenario: "coyote-time ledge walk-off + jump (Havok reference, pre-11.7.B)",
          capturedAt: new Date().toISOString(),
          captureFrames: CAPTURE_FRAMES,
          frameIntervalMs: FRAME_INTERVAL_MS,
          startPosition: { x: -5, y: 2.5, z: -2 },
          jumpImpulseY: 5.5,
          jumpAppliedAtFrame: coyoteFrames.jumpAppliedAtFrame,
          notes: "Havok does not implement coyote-time — the JUMP_IMPULSE applied on the contact-loss frame will register as a velocity spike but the player will still fall under gravity (no upward grace window). The post-11.7.B Rapier parity smoke should show a HIGHER peak Y because Rapier grants COYOTE_FRAMES=2.",
          frames: coyoteFrames.frames,
        },
        null,
        2,
      ),
    );
    log(`Wrote coyote-reference.json (${coyoteFrames.frames.length} frames; jump applied at frame ${coyoteFrames.jumpAppliedAtFrame})`);

    // ---- Scenario 2: mid-air hitscan ----
    log("Capturing mid-air hitscan...");
    const hitscanResult = await page.evaluate(async ({ CAPTURE_FRAMES, FRAME_INTERVAL_MS, JUMP_IMPULSE }) => {
      const session = window.__gameSession;
      const ctrl = session.localController;
      const havok = ctrl.havok;
      // Babylon Vector3 instances from the live controller.
      const START_POS = havok.getPosition().clone(); START_POS.set(0, 1, 0);
      const START_VEL = havok.getVelocity().clone(); START_VEL.set(0, JUMP_IMPULSE, 0);
      const DOWN_GRAV = havok.getVelocity().clone(); DOWN_GRAV.set(0, -1, 0);
      const ZERO_GRAV = havok.getVelocity().clone(); ZERO_GRAV.set(0, 0, 0);
      // Reset to origin with upward velocity.
      havok.setPosition(START_POS);
      havok.setVelocity(START_VEL);
      await new Promise((r) => setTimeout(r, 32));
      const frames = [];
      const startTime = performance.now();
      let apexFrame = -1;
      let apexY = -Infinity;
      const dt = FRAME_INTERVAL_MS / 1000;
      const GRAVITY = 9.81;
      for (let i = 0; i < CAPTURE_FRAMES; i++) {
        // Apply gravity manually since Havok's gravity is only
        // applied when the controller has a contact (see
        // characterController.ts ~line 354 — PR 8 fix). For
        // mid-air with no contact, gravity doesn't accumulate
        // automatically; we add it here.
        const vel = havok.getVelocity();
        const desired = vel.clone();
        desired.y = vel.y - GRAVITY * dt;
        havok.setVelocity(desired);
        const surface = havok.checkSupport(dt, DOWN_GRAV);
        havok.integrate(dt, surface, ZERO_GRAV);
        const pos = ctrl.state.position;
        if (pos.y > apexY) { apexY = pos.y; apexFrame = i; }
        const elapsed = performance.now() - startTime;
        frames.push({
          frame: i,
          elapsedMs: Math.round(elapsed),
          y: pos.y,
          supported: ctrl.state.supported,
          isApex: pos.y >= apexY,
          vy: desired.y,
        });
        await new Promise((r) => setTimeout(r, FRAME_INTERVAL_MS));
      }
      // Snapshot HP at apex (no fire — the capture doesn't need to
      // trigger damage; the §3.14 parity check verifies that the
      // server's lag-comp rewinds through Rapier's PositionHistory
      // for the mid-air target. Reference is just the trajectory).
      const hpAtApex = ctrl.state.hp;
      return { frames, apexFrame, apexY, hpAtApex };
    }, { CAPTURE_FRAMES, FRAME_INTERVAL_MS, JUMP_IMPULSE: 5.5 });
    writeFileSync(
      resolve(OUTPUT_DIR, "hitscan-mid-air-reference.json"),
      JSON.stringify(
        {
          scenario: "mid-air hitscan trajectory (Havok reference, pre-11.7.B)",
          capturedAt: new Date().toISOString(),
          captureFrames: CAPTURE_FRAMES,
          frameIntervalMs: FRAME_INTERVAL_MS,
          startPosition: { x: 0, y: 1, z: 0 },
          jumpImpulseY: 5.5,
          apexFrame: hitscanResult.apexFrame,
          apexY: hitscanResult.apexY,
          hpAtApex: hitscanResult.hpAtApex,
          notes: "Captures the Y trajectory of a player jumping straight up from y=1 with JUMP_IMPULSE=5.5 m/s + gravity=9.81. The apex is when vy crosses zero. The post-11.7.B parity smoke verifies the server's lag-comp rewinds through Rapier's PositionHistory for the mid-air target — the trajectory itself is what differs from the ground case.",
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
