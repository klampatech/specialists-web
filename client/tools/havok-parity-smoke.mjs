#!/usr/bin/env node
// PR 82 — Havok empirical-behavior parity smoke.
//
// Compares current Havok WASM physics trajectories against the
// committed reference captures in `client/test-data/`. Catches
// regressions where a Havok update (or scene.ts change) silently
// shifts the empirical trajectory enough that gameplay features
// relying on coyote-time, mid-air hitscan, or jump physics break.
//
// **Two scenarios** (matching the references):
//   1. coyote-time ledge walk-off + jump (§3.13 / §4.5)
//   2. mid-air hitscan trajectory (§3.14 / §4.5)
//
// **Tolerance**: 0.20m per-frame Y-trajectory difference; ≤20/60
// frames may differ before the smoke fails. The committed
// references were captured with the Havok WASM binary from
// PR 11.7.B; per-frame timing noise (wall-clock `setTimeout(16)`
// drift) produces 5-15 frame shifts per scenario even when the
// physics is identical, so a strict threshold would flake. A real
// Havok regression (wrong gravity, missing contact, broken jump
// impulse) diverges by 5-30m sustained over 30+ frames, which
// still fails the frame-count gate at this tolerance.
//
// **What this is NOT**:
//   - Not a Rapier-vs-Havok parity check (Rapier runs server-side
//     in PR 11.7.B; Havok is client-side). This validates the
//     CLIENT Havok against its own committed reference — i.e. it
//     detects when Havok behavior shifts unexpectedly.
//   - Not a wire-format smoke (that's `damage-server-aim-event-smoke`).
//
// **CI wiring**: see `.github/workflows/ci.yml::client-havok-parity-smoke`.
// Set `SMOKE_NO_BOOT=1` to skip the canary+vite boot (the CI job
// pre-boots them on ports 5191/14433/14434 before this script runs).
//
// **Reference source-of-truth**: `client/test-data/coyote-reference.json`
// and `client/test-data/hitscan-mid-air-reference.json` (committed in
// PR 11.7.B). To regenerate after a deliberate Havok update:
//   1. run `node tools/capture-havok-reference.mjs` locally
//   2. visually inspect the new trajectories
//   3. commit the regenerated `*-reference.json` files
//   4. the parity smoke automatically uses the new reference

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

const URL = process.env.HAVOK_PARITY_URL ?? "http://localhost:5191/";
const WT_PORT = Number(process.env.HAVOK_PARITY_WT_PORT ?? 14433);
const WS_PORT = Number(process.env.HAVOK_PARITY_WS_PORT ?? 14434);

// SMOKE_NO_BOOT: when set, the smoke skips its own canary+vite boot
// (CI pre-boots them on the same ports). When unset, the smoke is
// self-contained for local runs.
const SMOKE_NO_BOOT = process.env.SMOKE_NO_BOOT === "1";

const NAV_TIMEOUT = Number(process.env.HAVOK_PARITY_NAV_TIMEOUT ?? 30000);
const CAPTURE_FRAMES = Number(process.env.HAVOK_PARITY_CAPTURE_FRAMES ?? 60);
const FRAME_INTERVAL_MS = Number(process.env.HAVOK_PARITY_FRAME_INTERVAL_MS ?? 16);
// Per-frame Y tolerance (meters). See file header for rationale.
// Default 0.20m — absorbs micro-timing nondeterminism between
// runs (wall-clock `setTimeout(16)` drifts ~1-2 frames even when
// the physics is identical). A real Havok regression (wrong
// gravity, missing contact, broken jump impulse) diverges by
// 5-30m sustained over many frames, which still fails the
// `maxDiffFrames` gate below even at this tolerance.
const Y_TOLERANCE_M = Number(process.env.HAVOK_PARITY_Y_TOLERANCE_M ?? 0.20);
// Allow up to N frames of difference before failing. The reference
// captures were generated on the same Havok WASM binary, so the
// trajectory shape is identical; per-frame timing noise produces
// ~5-15 frame shifts per scenario at 60 frames total. Real
// regressions diverge on 20+ frames. Default 20/60 (33%).
const MAX_DIFF_FRAMES = Number(process.env.HAVOK_PARITY_MAX_DIFF_FRAMES ?? 20);

const REF_DIR = resolve(REPO_ROOT, "client/test-data");
const COYOTE_REF = resolve(REF_DIR, "coyote-reference.json");
const HITSCAN_REF = resolve(REF_DIR, "hitscan-mid-air-reference.json");
const OUTPUT_PATH = resolve(__dirname, "havok-parity-smoke.json");

const log = (...args) => console.log("[havok-parity]", ...args);
const fail = (...args) => console.error("[havok-parity][FAIL]", ...args);

mkdirSync(REF_DIR, { recursive: true });

// -- Step 1: Boot (optional, CI provides canary+vite) -------------------

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
    { cwd: resolve(REPO_ROOT, "client"), stdio: ["ignore", "pipe", "pipe"] }
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

// -- Step 2: Load references + run capture + diff -----------------------

async function loadReference(path, scenarioName) {
  const { readFileSync } = await import("node:fs");
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(
      `failed to load reference ${scenarioName} from ${path}: ${err.message}. ` +
      `Regenerate via 'node tools/capture-havok-reference.mjs' if the Havok ` +
      `trajectory legitimately changed.`,
    );
  }
}

// Havok capsule dims — must match `client/src/engine/characterConfig.ts::CAPSULE`.
const CAPSULE_RADIUS = 0.5;
const CAPSULE_HEIGHT = 1.8;
const CAPSULE_HALF_HEIGHT = CAPSULE_HEIGHT / 2;

async function captureCoyote(page) {
  return await page.evaluate(async ({
    CAPTURE_FRAMES, FRAME_INTERVAL_MS,
  }) => {
    const session = window.__gameSession;
    const ctrl = session.localController;
    const havok = ctrl.havok;
    const crateTop = 2.5; // = 1.25 + 2.5/2 (scene.ts tall crate)
    const startY = crateTop + 0.5 + 0.9; // CAPSULE_RADIUS + CAPSULE_HALF_HEIGHT
    const START_POS = havok.getPosition().clone();
    START_POS.set(-5, startY, -2);
    havok.setPosition(START_POS);
    havok.setVelocity(new (havok.getVelocity().constructor)(0, 0, 0));
    const settleDt = 1 / 60;
    const settleStart = performance.now();
    while (performance.now() - settleStart < 200) {
      ctrl.update({
        forward: 0, right: 0, jumpPressed: false, divePressed: false,
        slideHeld: false, wallrunPressed: false, cameraTogglePressed: false,
        fireHeld: false, meleePressed: false, bulletTimeHeld: false,
      }, settleDt, performance.now());
      await new Promise((r) => setTimeout(r, 16));
    }
    const frames = [];
    const startTime = performance.now();
    let jumpAppliedAtFrame = -1;
    let lastSupported = ctrl.state.supported;
    const dt = FRAME_INTERVAL_MS / 1000;
    for (let i = 0; i < CAPTURE_FRAMES; i++) {
      const nowMs = performance.now();
      const inputState = {
        forward: 1, right: 0, jumpPressed: false,
        divePressed: false, slideHeld: false, wallrunPressed: false,
        cameraTogglePressed: false, fireHeld: false, meleePressed: false,
        bulletTimeHeld: false,
      };
      ctrl.update(inputState, dt, nowMs);
      const isContactLoss = lastSupported && !ctrl.state.supported;
      if (isContactLoss && jumpAppliedAtFrame === -1) {
        inputState.jumpPressed = true;
        jumpAppliedAtFrame = i;
        ctrl.update(inputState, dt, nowMs);
      }
      lastSupported = ctrl.state.supported;
      const pos = ctrl.state.position;
      const elapsed = performance.now() - startTime;
      frames.push({
        frame: i,
        elapsedMs: Math.round(elapsed),
        y: pos.y,
        supported: ctrl.state.supported,
        jumpAppliedAtFrame: jumpAppliedAtFrame === i ? i : -1,
      });
      await new Promise((r) => setTimeout(r, FRAME_INTERVAL_MS));
    }
    return { frames, jumpAppliedAtFrame };
  }, { CAPTURE_FRAMES, FRAME_INTERVAL_MS });
}

async function captureHitscan(page) {
  return await page.evaluate(async ({
    CAPTURE_FRAMES, FRAME_INTERVAL_MS,
  }) => {
    const session = window.__gameSession;
    const ctrl = session.localController;
    const havok = ctrl.havok;
    const START_POS = havok.getPosition().clone();
    START_POS.set(0, 1, 0);
    const START_VEL = havok.getVelocity().clone();
    START_VEL.set(0, 5.5, 0); // JUMP_IMPULSE_Y
    havok.setPosition(START_POS);
    havok.setVelocity(START_VEL);
    await new Promise((r) => setTimeout(r, 32));
    const frames = [];
    const startTime = performance.now();
    let apexFrame = -1;
    let apexY = -Infinity;
    const dt = FRAME_INTERVAL_MS / 1000;
    for (let i = 0; i < CAPTURE_FRAMES; i++) {
      const nowMs = performance.now();
      ctrl.update({
        forward: 0, right: 0, jumpPressed: false,
        divePressed: false, slideHeld: false, wallrunPressed: false,
        cameraTogglePressed: false, fireHeld: false, meleePressed: false,
        bulletTimeHeld: false,
      }, dt, nowMs);
      const pos = ctrl.state.position;
      if (pos.y > apexY) { apexY = pos.y; apexFrame = i; }
      const elapsed = performance.now() - startTime;
      frames.push({
        frame: i,
        elapsedMs: Math.round(elapsed),
        y: pos.y,
        supported: ctrl.state.supported,
      });
      await new Promise((r) => setTimeout(r, FRAME_INTERVAL_MS));
    }
    return { frames, apexFrame, apexY };
  }, { CAPTURE_FRAMES, FRAME_INTERVAL_MS });
}

// Diff current vs reference, frame-by-frame Y trajectory.
// Returns { passes: bool, worstFrame: {idx, refY, curY, deltaY}, totalDiffFrames, scenario }.
function diffTrajectory(scenarioName, refFrames, curFrames, toleranceM, maxDiffFrames) {
  if (refFrames.length !== curFrames.length) {
    return {
      passes: false,
      scenario: scenarioName,
      totalDiffFrames: Infinity,
      worstFrame: null,
      error: `frame count mismatch: ref=${refFrames.length}, cur=${curFrames.length}`,
    };
  }
  let totalDiffFrames = 0;
  let worstFrame = null;
  let worstDelta = 0;
  for (let i = 0; i < refFrames.length; i++) {
    const deltaY = Math.abs(refFrames[i].y - curFrames[i].y);
    if (deltaY > toleranceM) {
      totalDiffFrames++;
      if (deltaY > worstDelta) {
        worstDelta = deltaY;
        worstFrame = {
          idx: i,
          refY: refFrames[i].y,
          curY: curFrames[i].y,
          deltaY,
        };
      }
    }
  }
  return {
    passes: totalDiffFrames <= maxDiffFrames,
    scenario: scenarioName,
    totalDiffFrames,
    worstFrame,
    toleranceM,
    maxDiffFrames,
  };
}

async function main() {
  if (!SMOKE_NO_BOOT) {
    await bootCanary();
    await bootVite();
  } else {
    log("SMOKE_NO_BOOT=1 — assuming canary + vite are already running");
  }

  // Load references
  const coyoteRef = await loadReference(COYOTE_REF, "coyote-time");
  const hitscanRef = await loadReference(HITSCAN_REF, "hitscan-mid-air");
  log(
    `references loaded: coyote ${coyoteRef.frames.length} frames, ` +
    `hitscan ${hitscanRef.frames.length} frames`,
  );

  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    const page = await ctx.newPage();
    page.on("pageerror", (err) => fail(`page error: ${err.message}`));

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
    await page.waitForFunction(
      () => {
        const s = window.__gameSession;
        return s && s.localController && s.localController.havok && s.localController.state;
      },
      { timeout: 30000 },
    );
    log("Havok controller ready.");

    // Scenario 1: coyote-time
    log("Capturing coyote-time trajectory...");
    const coyoteCur = await captureCoyote(page);
    const coyoteDiff = diffTrajectory(
      "coyote-time",
      coyoteRef.frames,
      coyoteCur.frames,
      Y_TOLERANCE_M,
      MAX_DIFF_FRAMES,
    );
    if (coyoteDiff.passes) {
      log(`coyote PASS: ${coyoteDiff.totalDiffFrames}/${coyoteCur.frames.length} frames differ (≤ ${MAX_DIFF_FRAMES} allowed)`);
    } else {
      fail(`coyote FAIL: ${coyoteDiff.totalDiffFrames}/${coyoteCur.frames.length} frames differ (≤ ${MAX_DIFF_FRAMES} allowed)`);
      if (coyoteDiff.worstFrame) {
        fail(`  worst frame ${coyoteDiff.worstFrame.idx}: refY=${coyoteDiff.worstFrame.refY.toFixed(4)} curY=${coyoteDiff.worstFrame.curY.toFixed(4)} delta=${coyoteDiff.worstFrame.deltaY.toFixed(4)}m`);
      }
      if (coyoteDiff.error) {
        fail(`  ${coyoteDiff.error}`);
      }
    }

    // Scenario 2: hitscan-mid-air
    log("Capturing hitscan-mid-air trajectory...");
    const hitscanCur = await captureHitscan(page);
    const hitscanDiff = diffTrajectory(
      "hitscan-mid-air",
      hitscanRef.frames,
      hitscanCur.frames,
      Y_TOLERANCE_M,
      MAX_DIFF_FRAMES,
    );
    if (hitscanDiff.passes) {
      log(`hitscan PASS: ${hitscanDiff.totalDiffFrames}/${hitscanCur.frames.length} frames differ (≤ ${MAX_DIFF_FRAMES} allowed)`);
    } else {
      fail(`hitscan FAIL: ${hitscanDiff.totalDiffFrames}/${hitscanCur.frames.length} frames differ (≤ ${MAX_DIFF_FRAMES} allowed)`);
      if (hitscanDiff.worstFrame) {
        fail(`  worst frame ${hitscanDiff.worstFrame.idx}: refY=${hitscanDiff.worstFrame.refY.toFixed(4)} curY=${hitscanDiff.worstFrame.curY.toFixed(4)} delta=${hitscanDiff.worstFrame.deltaY.toFixed(4)}m`);
      }
      if (hitscanDiff.error) {
        fail(`  ${hitscanDiff.error}`);
      }
    }

    // Write results artifact
    const result = {
      smoke: "havok-parity",
      runAt: new Date().toISOString(),
      toleranceM: Y_TOLERANCE_M,
      maxDiffFrames: MAX_DIFF_FRAMES,
      scenarios: [coyoteDiff, hitscanDiff],
      allPassed: coyoteDiff.passes && hitscanDiff.passes,
    };
    writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2));
    log(`wrote ${OUTPUT_PATH}`);

    if (!result.allPassed) {
      process.exit(1);
    }
    log("=== ALL PARITY ASSERTIONS PASSED ===");
  } finally {
    await browser.close();
    if (!SMOKE_NO_BOOT) {
      await teardown();
    }
  }
}

main().catch((err) => {
  fail(`unhandled error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});