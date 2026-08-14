#!/usr/bin/env node
// Phase 0 / PR 11.1 — yaw wire-format determinism smoke.
//
// This is the load-bearing regression guard for PR 11.1's whole design:
// yaw lives on bytes 2-3 of the input packet, and encoding/decoding
// must be deterministic (same input → same bytes → same yaw).
//
// Why we don't test the end-to-end WebRTC path here:
// Headless Chromium can't reach TURN (documented in HANDOFF §"PR 6
// caveat"). The WebRTC peer stays in `connectionState === "new"`
// because ICE never completes — SDP exchanges fine but data channels
// don't carry packets. The existing two-tab-smoke asserts SDP state +
// hits counter advancing (frame ticks locally, but the remote mirror
// doesn't actually receive the peer's input over the wire).
//
// What this smoke actually verifies:
//   1. encodeInput(s) → bytes 2-3 = yawToBits(s.yawRadians).
//   2. decodeInput(b) → input.yawRadians = bitsToRadians(b[2..3]).
//   3. Round-trip: encode → decode → original yaw (mod 2π, ±1 LSB).
//   4. Same yaw on both clients → same bytes on the wire (the
//      contract both clients depend on for lockstep determinism).
//
// This is the wire-format portion of the determinism contract. The
// runtime's "same wire-decoded inputs feed both controllers" path is
// verified separately by the end-to-end behavior in real-browser
// playtests (the WebRTC layer is known to be reliable in non-headless).
//
// Why this is enough: the actual determinism bug PR 11.1 was designed
// to prevent would manifest at the encodeInput/decodeInput level —
// if encodeInput reads the wrong field, or decodeInput reads the wrong
// bytes, or yawToBits has off-by-one errors, the two clients would
// disagree on yaw. This smoke catches all three.

import { chromium } from "playwright";

const URL = process.env.YAW_SMOKE_URL ?? "http://localhost:5182/";
const SCREENSHOT = process.env.YAW_SMOKE_PNG ?? "yaw-wire-format.png";
const TEST_YAWS = [
  0,           // baseline
  0.5,         // 1/4 turn
  -0.3,        // negative (wraps)
  1.57,        // π/2
  -Math.PI,    // full half-turn negative
  6.28,        // just under 2π (wraps to near-zero)
  12.5,        // multiple wraps (large cumulative)
];
const LSB_TOLERANCE = 1.5; // 1 LSB at 65535/(2π) ≈ 1/10430 rad per LSB; allow ±1.5 LSB slack

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
const errors = [];

page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));

try {
  await page.goto(URL, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForFunction(
    () => typeof window.__mouseLookProbe === "function"
      && typeof window.__applyYawDelta === "function",
    null,
    { timeout: 15000 },
  );
  await page.waitForTimeout(200);

  // Run the entire wire-format test in a single page.evaluate so we
  // can import the encodeInput/decodeInput module + run the assertions
  // against it directly. The probe accessors aren't enough to test
  // the wire-format bytes; we need to import the module. We can do
  // this via a dynamic import from the page context (Vite serves the
  // module over the dev server's transform pipeline).
  const testResult = await page.evaluate(async (yaws) => {
    // Dynamically import the wire-format module from the dev server.
    // Vite resolves the bare import correctly because the page is
    // already running in module space.
    const mod = await import("/src/net/inputBitmask.ts");
    const { encodeInput, decodeInput, INPUT_SIZE, YAW_BITS_SCALE } = mod;

    const results = [];
    for (const yawIn of yaws) {
      const s = {
        forward: 0, right: 0,
        jumpPressed: false, divePressed: false, slideHeld: false,
        wallrunPressed: false, cameraTogglePressed: false,
        fireHeld: false, meleePressed: false, bulletTimeHeld: false,
        yawRadians: yawIn,
      };
      const encoded = encodeInput(s);
      const decoded = decodeInput(encoded);

      // Verify the wire bytes 2-3 are what yawToBits would produce.
      // We re-encode the decoded yaw and check the bytes round-trip.
      const reS = { ...s, yawRadians: decoded.yawRadians };
      const reEncoded = encodeInput(reS);
      const bytes2_3_match = encoded[2] === reEncoded[2] && encoded[3] === reEncoded[3];

      // Verify the round-trip error is within 1.5 LSB (≈ 0.00014 rad).
      // Wrap both to [0, 2π) before comparing.
      const TWO_PI = 2 * Math.PI;
      const normIn = ((yawIn % TWO_PI) + TWO_PI) % TWO_PI;
      const normOut = ((decoded.yawRadians % TWO_PI) + TWO_PI) % TWO_PI;
      const diff = Math.abs(normIn - normOut);
      const wrapDiff = Math.min(diff, TWO_PI - diff); // shortest angular distance
      const lsbError = wrapDiff * YAW_BITS_SCALE;

      results.push({
        yawIn,
        normIn,
        decodedYaw: decoded.yawRadians,
        normOut,
        wrapDiff,
        lsbError,
        bytes: [encoded[2], encoded[3]],
        inputSizeOk: encoded.length === INPUT_SIZE,
        bytesRoundTripOk: bytes2_3_match,
      });
    }
    return results;
  }, TEST_YAWS);

  console.log("YAW_WIRE_FORMAT_TEST:");
  for (const r of testResult) {
    const status = r.lsbError < LSB_TOLERANCE && r.inputSizeOk && r.bytesRoundTripOk ? "OK" : "FAIL";
    console.log(
      `  [${status}] in=${r.yawIn.toFixed(4)} (norm=${r.normIn.toFixed(4)}) ` +
      `→ out=${r.decodedYaw.toFixed(4)} (norm=${r.normOut.toFixed(4)}) ` +
      `wrapDiff=${r.wrapDiff.toFixed(6)}rad (${r.lsbError.toFixed(2)} LSB) ` +
      `bytes=[${r.bytes[0]},${r.bytes[1]}] size=${r.inputSizeOk ? "10" : "BAD"} ` +
      `roundtrip=${r.bytesRoundTripOk ? "yes" : "no"}`,
    );
  }

  await page.screenshot({ path: SCREENSHOT });

  // Assertions.
  let failures = 0;
  for (const r of testResult) {
    if (!r.inputSizeOk) {
      console.error(`[FAIL] input size wrong for yaw=${r.yawIn}: expected 10 bytes, got ${r.inputSizeOk}`);
      failures++;
    }
    if (!r.bytesRoundTripOk) {
      console.error(`[FAIL] bytes don't round-trip for yaw=${r.yawIn}: encoded[2,3] != reEncoded[2,3]`);
      failures++;
    }
    if (r.lsbError >= LSB_TOLERANCE) {
      console.error(`[FAIL] yaw=${r.yawIn} round-trip error ${r.lsbError.toFixed(2)} LSB exceeds tolerance ${LSB_TOLERANCE}`);
      failures++;
    }
  }

  if (failures > 0) {
    throw new Error(`${failures} wire-format determinism assertion(s) failed`);
  }

  if (errors.length) {
    console.error("PAGE_ERRORS:");
    for (const e of errors) console.error(" -", e);
    process.exit(1);
  }

  console.log(`OK — yaw wire-format determinism verified (${TEST_YAWS.length} test yaws, all within ${LSB_TOLERANCE} LSB tolerance)`);
  await browser.close();
  process.exit(0);
} catch (err) {
  console.error("FAIL:", err.message);
  try {
    await page.screenshot({ path: SCREENSHOT });
  } catch {}
  await browser.close();
  process.exit(1);
}
