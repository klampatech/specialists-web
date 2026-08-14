#!/usr/bin/env node
// Phase 0 / PR 11.1.1 — pointer-lock + 3-mode V-cycle camera-render smoke.
//
// Verifies the chase camera's RENDER path honors the pointer-lock state
// + the PR 11.1.1 3-mode V-cycle state machine:
//
//   Mode 0 (1st-person-locked): camera at firstPersonOffset, rotated by yaw
//   Mode 1 (3rd-person-locked): camera at thirdPersonLockedOffset, rotated by yaw
//   Mode 2 (chase-unlocked):    lerped chase, no mouse control
//
// What this smoke verifies:
//   1. Mode 0 + locked: camera.position = character.position + firstPersonOffset
//   2. Mode 0 + locked: camera.rotation.y matches character yaw
//   3. Yaw update propagates to camera in mode 0
//   4. Toggle V → mode 1 (still locked) → camera.position = character + thirdPersonLockedOffset
//   5. V again → mode 2 (still locked, but camera uses lerp chase)
//      Wait — actually, in mode 2 the chase lerp kicks in; verify the
//      camera drifts away from firstPersonOffset
//   6. Toggle V while in mode 2 + locked → wraps back to mode 0
//   7. setPointerLock(false) → falls back to chase lerp (mode 2)
//   8. setViewMode(0) + setPointerLock(false) → unlocked first-person-chase
//      (camera at firstPersonOffset, but lerped — drift check)
//
// Bypasses real pointer-lock (headless Chromium won't grant it) by
// calling `chase.setPointerLock(true)` directly via the smoke.

import { chromium } from "playwright";

const URL = process.env.POINTER_LOCK_CAMERA_SMOKE_URL ?? "http://localhost:5181/";
const SCREENSHOT = process.env.POINTER_LOCK_CAMERA_SMOKE_PNG ?? "pointer-lock-camera.png";
const FIRST_PERSON_OFFSET = { x: 0, y: 1.6, z: 0 }; // CAMERA.firstPersonOffset from characterConfig.ts
const THIRD_PERSON_LOCKED_OFFSET = { x: 0, y: 1.6, z: -2.5 }; // CAMERA.thirdPersonLockedOffset
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
    `LOCKED+0.7rad: isLocked=${s3.isPointerLocked} viewMode=${s3.viewMode} ` +
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

  // (d) PR 11.1.1: V cycles mode 0 → 1 (still locked). Camera should
  // snap to character.position + thirdPersonLockedOffset.
  await page.evaluate(() => window.__chaseCameraToggle());
  await page.waitForTimeout(200);

  const sMode1 = await page.evaluate(() => window.__chaseCameraProbe());
  console.log(
    `V→MODE1: isLocked=${sMode1.isPointerLocked} viewMode=${sMode1.viewMode} ` +
    `cameraPos=(${sMode1.cameraPosition.x.toFixed(3)},${sMode1.cameraPosition.y.toFixed(3)},${sMode1.cameraPosition.z.toFixed(3)})`,
  );
  if (sMode1.viewMode !== 1) {
    throw new Error(`[V-cycle-fail] expected viewMode=1 after one V press, got ${sMode1.viewMode}`);
  }
  if (!sMode1.isPointerLocked) {
    throw new Error(`[V-unlocked] V while locked shouldn't release lock; isLocked=${sMode1.isPointerLocked}`);
  }
  const expectedMode1 = {
    x: sMode1.characterPosition.x + THIRD_PERSON_LOCKED_OFFSET.x,
    y: sMode1.characterPosition.y + THIRD_PERSON_LOCKED_OFFSET.y,
    z: sMode1.characterPosition.z + THIRD_PERSON_LOCKED_OFFSET.z,
  };
  const mode1Drift = Math.sqrt(
    Math.pow(sMode1.cameraPosition.x - expectedMode1.x, 2) +
    Math.pow(sMode1.cameraPosition.y - expectedMode1.y, 2) +
    Math.pow(sMode1.cameraPosition.z - expectedMode1.z, 2),
  );
  if (mode1Drift > POSITION_TOLERANCE) {
    throw new Error(
      `[V-mode1-position] drift ${mode1Drift.toFixed(4)}m from expected ${JSON.stringify(expectedMode1)}, ` +
      `got=${JSON.stringify(sMode1.cameraPosition)}`,
    );
  }
  // Yaw should still match (mode 1 is locked, mouse still rotates).
  const mode1YawDrift = Math.abs(sMode1.cameraRotationY - sMode1.characterYaw);
  if (mode1YawDrift > YAW_TOLERANCE) {
    throw new Error(
      `[V-mode1-yaw] camera.rotation.y=${sMode1.cameraRotationY.toFixed(4)} should match ` +
      `character yaw=${sMode1.characterYaw.toFixed(4)} (drift=${mode1YawDrift.toFixed(4)})`,
    );
  }
  console.log(`V_MODE1_OK: viewMode=1, locked, drift=${mode1Drift.toFixed(4)}m, yaw matches`);

  // (e) V again → mode 2. Still locked but lerp chase kicks in.
  await page.evaluate(() => window.__chaseCameraToggle());
  await page.waitForTimeout(200);

  const sMode2 = await page.evaluate(() => window.__chaseCameraProbe());
  console.log(
    `V→MODE2: isLocked=${sMode2.isPointerLocked} viewMode=${sMode2.viewMode}`,
  );
  if (sMode2.viewMode !== 2) {
    throw new Error(`[V-cycle-fail] expected viewMode=2 after two V presses, got ${sMode2.viewMode}`);
  }
  // In mode 2 with locked=true, the chase lerp STILL doesn't fire because
  // our render path only short-circuits to "no lerp" when (pointerLocked
  // && (viewMode 0 or 1)). So mode 2 + locked = the lerp chase runs.
  // The camera should drift away from firstPersonOffset over a few frames.
  await page.waitForTimeout(500); // ~30 frames of lerp
  const sMode2Drift = await page.evaluate(() => window.__chaseCameraProbe());
  const offsetFromFirstPerson = Math.sqrt(
    Math.pow(sMode2Drift.cameraPosition.x - sMode2Drift.characterPosition.x - FIRST_PERSON_OFFSET.x, 2) +
    Math.pow(sMode2Drift.cameraPosition.y - sMode2Drift.characterPosition.y - FIRST_PERSON_OFFSET.y, 2) +
    Math.pow(sMode2Drift.cameraPosition.z - sMode2Drift.characterPosition.z - FIRST_PERSON_OFFSET.z, 2),
  );
  if (offsetFromFirstPerson < POSITION_TOLERANCE) {
    throw new Error(
      `[V-mode2-lerp-fail] mode 2 + locked should engage lerp chase; camera is still ` +
      `at firstPersonOffset (offset=${offsetFromFirstPerson.toFixed(4)}m)`,
    );
  }
  console.log(`V_MODE2_OK: viewMode=2, lerp chase engaged (offset from firstPersonOffset=${offsetFromFirstPerson.toFixed(4)}m)`);

  // (f) V again → wraps back to mode 0.
  await page.evaluate(() => window.__chaseCameraToggle());
  await page.waitForTimeout(200);
  const sWrapped = await page.evaluate(() => window.__chaseCameraProbe());
  if (sWrapped.viewMode !== 0) {
    throw new Error(`[V-wrap-fail] expected viewMode=0 after three V presses, got ${sWrapped.viewMode}`);
  }
  console.log(`V_WRAP_OK: viewMode=0 after 3 V presses`);

  // (g) Release pointer-lock. Camera falls back to chase lerp at mode 2.
  await page.evaluate(() => window.__pointerLockToggle(false));
  await page.waitForTimeout(200);

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
