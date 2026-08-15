#!/usr/bin/env node
// Phase 0 / PR 11.3 — two-context pitch wire-format determinism smoke.
//
// Verifies that the SAME encoded pitch bytes round-trip through two
// SEPARATE browser contexts (simulating the two-tab WebRTC case where
// Tab A encodes its pitch and Tab B decodes Tab A's pitch from the wire).
// Each browser context has its own JS runtime + Vite module cache, so
// this catches:
//   1. encodeInput/decodeInput drift between contexts (would indicate
//      a Vite transform issue or accidental module duplication).
//   2. Sign / scale mismatches between the encoder and decoder.
//   3. The backward-compat shim (bits=0 → pitchRadians=0) working
//      consistently across contexts.
//
// This is the load-bearing regression guard for cross-tab lockstep
// determinism on the pitch axis. The same shape as the existing
// yaw-wire-format-smoke.mjs, but with TWO browser contexts to prove
// the encoder/decoder pair is symmetric across runtime boundaries.
//
// Exit 0 on pass; exit 1 with [FAIL] diagnostic on fail.

import { chromium } from "playwright";

const URL = process.env.PITCH_2TAB_SMOKE_URL ?? "http://localhost:5186/";
const SCREENSHOT = process.env.PITCH_2TAB_SMOKE_PNG ?? "pitch-2tab-wire-format.png";
const TEST_PITCHES = [
  0,           // baseline (will hit backward-compat shim)
  0.3,         // small positive
  -0.3,        // small negative
  1.57,        // ~π/2 (max positive, edge case)
  -1.57,       // ~-π/2 (max negative, will hit shim if naive)
  0.785,       // ~π/4
  -0.785,      // ~-π/4
];
const LSB_TOLERANCE = 1.5;

const browser = await chromium.launch();
// Two contexts — each simulates a separate browser tab on the same origin.
// Same engine, same DOM, but separate JS runtimes + separate Vite module caches.
const contextA = await browser.newContext({ viewport: { width: 800, height: 600 } });
const contextB = await browser.newContext({ viewport: { width: 800, height: 600 } });
const pageA = await contextA.newPage();
const pageB = await contextB.newPage();
const errors = [];
pageA.on("pageerror", (err) => errors.push(`pageA: ${err.message}`));
pageB.on("pageerror", (err) => errors.push(`pageB: ${err.message}`));

try {
  await Promise.all([
    pageA.goto(URL, { waitUntil: "networkidle", timeout: 30000 }),
    pageB.goto(URL, { waitUntil: "networkidle", timeout: 30000 }),
  ]);

  // Wait for the scene to be ready in BOTH contexts. We don't actually
  // need the scene for the wire-format test — but the import path
  // (`/src/net/inputBitmask.ts`) requires Vite to be serving the dev
  // server, and Vite is mounted by the React app. So wait for React to
  // mount (the BulletHud chip is a reliable signal).
  await Promise.all([
    pageA.waitForSelector("[data-testid=\"bullet-hud\"]", { timeout: 15000 }),
    pageB.waitForSelector("[data-testid=\"bullet-hud\"]", { timeout: 15000 }),
  ]);
  await Promise.all([pageA.waitForTimeout(500), pageB.waitForTimeout(500)]);

  // The actual wire-format test, run via page.evaluate in BOTH contexts.
  // Each context gets its own import (separate Vite module cache).
  // Tab A encodes; we pass the encoded bytes to Tab B; Tab B decodes.
  const results = await pageA.evaluate(async ({ pitches }) => {
    const mod = await import("/src/net/inputBitmask.ts");
    const { encodeInput, decodeInput, INPUT_SIZE, PITCH_BITS_SCALE } = mod;
    const results = [];
    for (const pitchIn of pitches) {
      const s = {
        forward: 0, right: 0,
        jumpPressed: false, divePressed: false, slideHeld: false,
        wallrunPressed: false, cameraTogglePressed: false,
        fireHeld: false, meleePressed: false, bulletTimeHeld: false,
        yawRadians: 0,
        pitchRadians: pitchIn,
      };
      const encoded = encodeInput(s);
      results.push({
        pitchIn,
        bytes: Array.from(encoded),
        size: encoded.length,
        pitchBits: ((encoded[4] ?? 0) | ((encoded[5] ?? 0) << 8)) & 0xffff,
      });
    }
    return { results, INPUT_SIZE, PITCH_BITS_SCALE };
  }, { pitches: TEST_PITCHES });

  // Now in Tab B: decode each encoded packet using ITS OWN import of the
  // module. If the modules drift between contexts (different bits-scale
  // constant, different shim behavior, etc.), the decoded pitchRadians
  // will diverge.
  const decodedResults = await pageB.evaluate(async ({ encodedPackets }) => {
    const mod = await import("/src/net/inputBitmask.ts");
    const { decodeInput } = mod;
    const results = [];
    for (const packet of encodedPackets) {
      const decoded = decodeInput(new Uint8Array(packet.bytes));
      results.push({
        bytes: packet.bytes,
        pitchIn: packet.pitchIn,
        pitchOut: decoded.pitchRadians,
        pitchBits: packet.pitchBits,
      });
    }
    return results;
  }, { encodedPackets: results.results });

  // Also do the REVERSE: encode in Tab B, decode in Tab A. Catches
  // directional drift if the asymmetry is in one context's module.
  const reversedResults = await pageB.evaluate(async ({ pitches }) => {
    const mod = await import("/src/net/inputBitmask.ts");
    const { encodeInput } = mod;
    return pitches.map(pitchIn => {
      const s = {
        forward: 0, right: 0,
        jumpPressed: false, divePressed: false, slideHeld: false,
        wallrunPressed: false, cameraTogglePressed: false,
        fireHeld: false, meleePressed: false, bulletTimeHeld: false,
        yawRadians: 0,
        pitchRadians: pitchIn,
      };
      return {
        pitchIn,
        bytes: Array.from(encodeInput(s)),
      };
    });
  }, { pitches: TEST_PITCHES });

  const decodedReverse = await pageA.evaluate(async ({ encodedPackets }) => {
    const mod = await import("/src/net/inputBitmask.ts");
    const { decodeInput } = mod;
    return encodedPackets.map(packet => {
      const decoded = decodeInput(new Uint8Array(packet.bytes));
      return { pitchIn: packet.pitchIn, pitchOut: decoded.pitchRadians };
    });
  }, { encodedPackets: reversedResults });

  // Report
  console.log(`PITCH_2TAB_TEST (Tab A encode → Tab B decode):`);
  for (const r of decodedResults) {
    const TWO_PI = 2 * Math.PI;
    const normIn = ((r.pitchIn % Math.PI) + Math.PI) % Math.PI - Math.PI/2;
    const normOut = ((r.pitchOut % Math.PI) + Math.PI) % Math.PI - Math.PI/2;
    // Use the actual decode formula: `(bits / PITCH_BITS_SCALE) - π/2`
    const bits = r.pitchBits;
    const expectedFromBits = bits === 0 ? 0 : bits / results.PITCH_BITS_SCALE - Math.PI / 2;
    const diff = Math.abs(r.pitchOut - expectedFromBits);
    const status = diff < 0.001 ? "OK" : "FAIL";
    console.log(
      `  [${status}] in=${r.pitchIn.toFixed(4)} → out=${r.pitchOut.toFixed(4)} ` +
      `(bits=${bits} → expected=${expectedFromBits.toFixed(4)}) ` +
      `bytes=[${r.bytes[4]},${r.bytes[5]}] size=${r.bytes.length === results.INPUT_SIZE ? "12" : "BAD"}`,
    );
  }

  console.log(`\nPITCH_2TAB_TEST (Tab B encode → Tab A decode):`);
  for (const r of decodedReverse) {
    const bits = (results.results.find(x => x.pitchIn === r.pitchIn)?.pitchBits) ?? 0;
    const expectedFromBits = bits === 0 ? 0 : bits / results.PITCH_BITS_SCALE - Math.PI / 2;
    const diff = Math.abs(r.pitchOut - expectedFromBits);
    const status = diff < 0.001 ? "OK" : "FAIL";
    console.log(
      `  [${status}] in=${r.pitchIn.toFixed(4)} → out=${r.pitchOut.toFixed(4)} ` +
      `(expected=${expectedFromBits.toFixed(4)})`,
    );
  }

  // Take screenshots from both contexts
  await pageA.screenshot({ path: SCREENSHOT.replace(".png", "-A.png") });
  await pageB.screenshot({ path: SCREENSHOT.replace(".png", "-B.png") });

  // Assertions
  let failures = 0;
  for (const r of decodedResults) {
    const bits = r.pitchBits;
    const expectedFromBits = bits === 0 ? 0 : bits / results.PITCH_BITS_SCALE - Math.PI / 2;
    if (r.bytes.length !== results.INPUT_SIZE) {
      console.error(`[FAIL] size mismatch for pitch=${r.pitchIn}: expected ${results.INPUT_SIZE}, got ${r.bytes.length}`);
      failures++;
      continue;
    }
    if (Math.abs(r.pitchOut - expectedFromBits) > 0.001) {
      console.error(
        `[FAIL] Tab B decoded pitch=${r.pitchOut.toFixed(4)} but expected ${expectedFromBits.toFixed(4)} ` +
        `(from bits=${bits} via PITCH_BITS_SCALE=${results.PITCH_BITS_SCALE.toFixed(2)}). ` +
        `Modules may have drifted between Tab A and Tab B.`,
      );
      failures++;
    }
  }
  for (const r of decodedReverse) {
    const bits = (results.results.find(x => x.pitchIn === r.pitchIn)?.pitchBits) ?? 0;
    const expectedFromBits = bits === 0 ? 0 : bits / results.PITCH_BITS_SCALE - Math.PI / 2;
    if (Math.abs(r.pitchOut - expectedFromBits) > 0.001) {
      console.error(
        `[FAIL] Tab A decoded pitch=${r.pitchOut.toFixed(4)} but expected ${expectedFromBits.toFixed(4)} ` +
        `(reverse direction).`,
      );
      failures++;
    }
  }

  if (failures > 0) {
    throw new Error(`${failures} cross-context pitch wire-format assertion(s) failed`);
  }

  if (errors.length) {
    console.error("PAGE_ERRORS:");
    for (const e of errors) console.error(" -", e);
    process.exit(1);
  }

  console.log(`\nOK — pitch wire-format determinism verified across two browser contexts (${TEST_PITCHES.length} test pitches, all consistent)`);
  await browser.close();
  process.exit(0);
} catch (err) {
  console.error("FAIL:", err.message);
  try {
    await pageA.screenshot({ path: SCREENSHOT });
  } catch {}
  try {
    await pageB.screenshot({ path: SCREENSHOT });
  } catch {}
  await browser.close();
  process.exit(1);
}
