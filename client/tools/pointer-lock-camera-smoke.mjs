#!/usr/bin/env node
// Phase 0 / PR 11.1 — pointer-lock camera-render smoke.
//
// Verifies the camera RENDER path honors the pointer-lock state.
// The mouse-look smoke (separate file) covers the yaw-rotation code
// path; this smoke covers the render path:
//
//   1. When pointerLocked === true:
//      - camera.position === character.position + CAMERA.firstPersonOffset
//      - camera.rotation.y matches the character's yaw (Euler-Y of state.rotation)
//   2. When pointerLocked === false:
//      - camera.position is somewhere OTHER than firstPersonOffset (the
//        lerped chase is happening — the back-off distance is what we
//        assert against)
//   3. After a yaw delta while pointer-locked, camera.rotation.y
//      updates to match the new character yaw.
//
// Bypasses real pointer-lock (headless Chromium won't grant it) by
// calling `chase.setPointerLock(true)` directly via the smoke — the
// camera's render path is the same regardless of whether the lock
// was acquired via the browser API or programmatically.

import { chromium } from "playwright";

const URL = process.env.POINTER_LOCK_CAMERA_SMOKE_URL ?? "http://localhost:5181/";
const SCREENSHOT = process.env.POINTER_LOCK_CAMERA_SMOKE_PNG ?? "pointer-lock-camera.png";
const FIRST_PERSON_OFFSET = { x: 0, y: 1.6, z: 0 }; // CAMERA.firstPersonOffset from characterConfig.ts
const THIRD_PERSON_OFFSET = { x: 0, y: 1.5, z: -2.8 }; // CAMERA.thirdPersonOffset
const POSITION_TOLERANCE = 0.05; // 5cm slack for float drift
const YAW_TOLERANCE = 0.05; // 0.05 rad slack

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
const errors = [];

page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));

try {
  await page.goto(URL, { waitUntil: "networkidle", timeout: 30000 });

  // Wait for scene + the new chase-camera probe + the existing yaw probe.
  await page.waitForFunction(
    () => typeof window.__chaseCameraProbe === "function"
      && typeof window.__mouseLookProbe === "function"
      && typeof window.__applyYawDelta === "function",
    null,
    { timeout: 15000 },
  );
  await page.waitForTimeout(200); // one frame for scene to settle

  // ── Snapshot 1: initial state (not pointer-locked) ────────────────────────
  const s1 = await page.evaluate(() => window.__chaseCameraProbe());
  console.log(
    `INITIAL: isLocked=${s1.isPointerLocked} ` +
    `cameraPos=(${s1.cameraPosition.x.toFixed(3)},${s1.cameraPosition.y.toFixed(3)},${s1.cameraPosition.z.toFixed(3)}) ` +
    `charPos=(${s1.characterPosition.x.toFixed(3)},${s1.characterPosition.y.toFixed(3)},${s1.characterPosition.z.toFixed(3)}) ` +
    `camRotY=${s1.cameraRotationY.toFixed(4)} charYaw=${s1.characterYaw.toFixed(4)}`,
  );

  if (s1.isPointerLocked) {
    throw new Error("[bad-initial] Pointer-lock should start as false");
  }

  // ── Engage pointer-lock via the chase camera's setPointerLock method ─────
  // We don't have a direct __setPointerLock probe, but we can call it via
  // the chase camera handle. The scene's createScene wraps the chase
  // camera in a closure, so we need a probe. Quick: simulate the canvas
  // click flow via the DEV __applyYawDelta path doesn't trigger lock
  // (that's a separate concern), so instead we expose a tiny helper.
  // Simpler: use the chase camera's applyYawDelta + manually toggle
  // pointer-lock via the input listener's onPointerLockChange. The
  // cleanest way: add a tiny __pointerLockToggle probe in scene.ts.

  // We need a way to call chase.setPointerLock from the smoke. Since the
  // DEV probes already include __applyYawDelta which the input listener
  // uses, and __pointerLockState which mirrors the chase camera state,
  // the simplest cross-version approach is to dispatch a synthetic
  // pointerlockchange event. Headless Chromium listens to this.
  // But that's complex. Instead, use the chase camera's setPointerLock
  // via a new probe — we already have __chaseCameraProbe; let me expose
  // setPointerLock via a __setPointerLock dev hook.

  // Actually — simpler: the inputListener already wires onPointerLockChange
  // to chase.setPointerLock. We just need to trigger the hook. Easiest:
  // dispatch a synthetic 'pointerlockchange' event. The browser event
  // for pointer-lock is not directly dispatchable, but we can call the
  // hook via the chase camera's setPointerLock accessor. We need to
  // expose it.
  //
  // For this smoke, we add a `__pointerLockToggle` probe in scene.ts
  // that calls chase.setPointerLock(true|false) and updates the probe.
  // Documented inline.

  // Step 1: engage pointer-lock programmatically.
  await page.evaluate(() => window.__pointerLockToggle(true));
  await page.waitForTimeout(200); // a few frames for the camera render path to update

  const s2 = await page.evaluate(() => window.__chaseCameraProbe());
  console.log(
    `LOCKED: isLocked=${s2.isPointerLocked} ` +
    `cameraPos=(${s2.cameraPosition.x.toFixed(3)},${s2.cameraPosition.y.toFixed(3)},${s2.cameraPosition.z.toFixed(3)}) ` +
    `charPos=(${s2.characterPosition.x.toFixed(3)},${s2.characterPosition.y.toFixed(3)},${s2.characterPosition.z.toFixed(3)}) ` +
    `camRotY=${s2.cameraRotationY.toFixed(4)} charYaw=${s2.characterYaw.toFixed(4)}`,
  );

  if (!s2.isPointerLocked) {
    throw new Error("[lock-toggle-failed] __pointerLockToggle(true) didn't update probe");
  }

  // (a) camera.position should be character.position + firstPersonOffset.
  const expectedPos = {
    x: s2.characterPosition.x + FIRST_PERSON_OFFSET.x,
    y: s2.characterPosition.y + FIRST_PERSON_OFFSET.y,
    z: s2.characterPosition.z + FIRST_PERSON_OFFSET.z,
  };
  const posDrift = Math.sqrt(
    Math.pow(s2.cameraPosition.x - expectedPos.x, 2) +
    Math.pow(s2.cameraPosition.y - expectedPos.y, 2) +
    Math.pow(s2.cameraPosition.z - expectedPos.z, 2),
  );
  if (posDrift > POSITION_TOLERANCE) {
    throw new Error(
      `[locked-position] camera.position drift ${posDrift.toFixed(4)}m from expected ` +
      `(char+firstPersonOffset=${JSON.stringify(expectedPos)}, got=${JSON.stringify(s2.cameraPosition)})`,
    );
  }
  console.log(`LOCKED_POSITION_OK: drift=${posDrift.toFixed(4)}m ≤ ${POSITION_TOLERANCE}m`);

  // (b) camera.rotation.y should match the character yaw (initial = 0
  // since neither client has moved).
  const initialYawDrift = Math.abs(s2.cameraRotationY - s2.characterYaw);
  if (initialYawDrift > YAW_TOLERANCE) {
    throw new Error(
      `[locked-yaw] camera.rotation.y=${s2.cameraRotationY.toFixed(4)} differs from ` +
      `character yaw=${s2.characterYaw.toFixed(4)} by ${initialYawDrift.toFixed(4)} rad`,
    );
  }
  console.log(`LOCKED_YAW_OK: |camRotY-charYaw|=${initialYawDrift.toFixed(4)} ≤ ${YAW_TOLERANCE}`);

  // (c) Apply a yaw delta + assert camera.rotation.y updates to match.
  await page.evaluate(() => window.__applyYawDelta(0.7));
  // The applyYawDelta updates chase.getYaw() but the camera's rotation
  // is derived from character.state.rotation (set via setYaw, called
  // in the render loop after decodeInput). For the smoke we need to
  // also update the character's yaw. The simplest path: directly call
  // the chase camera's setPointerLock + applyYawDelta + manually update
  // the character yaw. But character is owned by scene.ts.
  //
  // For the camera-render test, we just need to verify the camera
  // updates when the character yaw updates. The chase camera reads
  // character.state.rotation in its update() — so if the character yaw
  // changes, the camera rotation will follow.
  //
  // We can simulate character yaw change via a direct call. Add a
  // __setCharacterYaw probe. (Documented inline.)
  await page.evaluate((r) => window.__setCharacterYaw(r), 0.7);
  await page.waitForTimeout(200);

  const s3 = await page.evaluate(() => window.__chaseCameraProbe());
  console.log(
    `LOCKED+0.7rad: isLocked=${s3.isPointerLocked} ` +
    `camRotY=${s3.cameraRotationY.toFixed(4)} charYaw=${s3.characterYaw.toFixed(4)}`,
  );
  const afterYawDrift = Math.abs(s3.cameraRotationY - s3.characterYaw);
  if (afterYawDrift > YAW_TOLERANCE) {
    throw new Error(
      `[locked-yaw-update] after +0.7 rad, camera.rotation.y=${s3.cameraRotationY.toFixed(4)} ` +
      `should match character yaw=${s3.characterYaw.toFixed(4)} by ≤ ${YAW_TOLERANCE} rad ` +
      `(drift=${afterYawDrift.toFixed(4)})`,
    );
  }
  console.log(`LOCKED_YAW_UPDATE_OK: |camRotY-charYaw|=${afterYawDrift.toFixed(4)} ≤ ${YAW_TOLERANCE}`);

  // (d) Release pointer-lock + assert the camera drifts back to the
  // third-person chase position over the next few frames.
  await page.evaluate(() => window.__pointerLockToggle(false));
  await page.waitForTimeout(500); // ~30 frames for the lerp to catch up

  const s4 = await page.evaluate(() => window.__chaseCameraProbe());
  console.log(
    `RELEASED: isLocked=${s4.isPointerLocked} ` +
    `cameraPos=(${s4.cameraPosition.x.toFixed(3)},${s4.cameraPosition.y.toFixed(3)},${s4.cameraPosition.z.toFixed(3)}) ` +
    `charPos=(${s4.characterPosition.x.toFixed(3)},${s4.characterPosition.y.toFixed(3)},${s4.characterPosition.z.toFixed(3)})`,
  );

  if (s4.isPointerLocked) {
    throw new Error("[release-failed] __pointerLockToggle(false) didn't update probe");
  }

  // After release, the camera should NOT be at firstPersonOffset — it
  // should be lerping back toward the third-person chase offset.
  // Initial V-toggle state defaults to firstPerson=false (third-person
  // chase), so the target is thirdPersonOffset = (0, 1.5, -2.8).
  // The current camera.position should NOT match firstPersonOffset
  // (we just left that state).
  const releasedOffset = {
    x: s4.cameraPosition.x - s4.characterPosition.x,
    y: s4.cameraPosition.y - s4.characterPosition.y,
    z: s4.cameraPosition.z - s4.characterPosition.z,
  };
  const distFromFirstPerson = Math.sqrt(
    Math.pow(releasedOffset.x - FIRST_PERSON_OFFSET.x, 2) +
    Math.pow(releasedOffset.y - FIRST_PERSON_OFFSET.y, 2) +
    Math.pow(releasedOffset.z - FIRST_PERSON_OFFSET.z, 2),
  );
  if (distFromFirstPerson < POSITION_TOLERANCE) {
    throw new Error(
      `[release-position] After releasing lock, camera is still at firstPersonOffset ` +
      `(distance=${distFromFirstPerson.toFixed(4)}m). Lerp fallback not engaging.`,
    );
  }
  console.log(`RELEASE_POSITION_OK: dist from firstPersonOffset=${distFromFirstPerson.toFixed(4)}m > ${POSITION_TOLERANCE}m`);

  await page.screenshot({ path: SCREENSHOT });

  if (errors.length) {
    console.error("PAGE_ERRORS:");
    for (const e of errors) console.error(" -", e);
    process.exit(1);
  }

  console.log("OK — pointer-lock camera render path verified");
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
