#!/usr/bin/env node
// Phase 0 / PR 11.2 — pause / loadout menu smoke.
//
// Verifies the React overlay shown when pointer is unlocked + everLocked:
//   1. Fresh page: menu NOT in DOM (everLocked=false gate)
//   2. After lock: menu NOT in DOM (locked)
//   3. After unlock: menu IS in DOM
//   4. Menu container has pointer-events: auto (HUD-overlay-eats-clicks trap guard)
//   5. Resume button has pointer-events: auto
//   6. Backdrop has cursor: default (visible cursor for clicking)
//   7. Click Resume → pointer re-locks
//   8. Click Disconnect Peer → peer connectionState transitions
//      out of "connected" (or null/closed/failed)
//   9. Loadout + Settings buttons are disabled placeholders
//  10. ESC keydown while menu visible → pointer re-locks (Kyle's spec)
//  11. Resume restores the prior viewMode: lock at mode 1, ESC, click
//      Resume → viewMode === 1 (not 0)
//  12. Screenshot to pause-menu.png for CI artifact upload
//
// The smoke drives the pause menu via the DEV probes + synthetic
// `__pointerLockToggle` calls. Headless Chromium doesn't reliably
// grant pointer-lock for synthetic clicks, so we bypass that layer
// (matches the pattern in pointer-lock-camera-smoke.mjs and
// mouse-look-smoke.mjs).

import { chromium } from "playwright";

const URL = process.env.PAUSE_MENU_SMOKE_URL ?? "http://localhost:5183/";
const SCREENSHOT = process.env.PAUSE_MENU_SMOKE_PNG ?? "pause-menu.png";

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
const errors = [];

page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));

const PASS = (msg) => console.log(`[OK] ${msg}`);
const FAIL = (msg) => {
  console.error(`[FAIL] ${msg}`);
  process.exit(1);
};

try {
  await page.goto(URL, { waitUntil: "networkidle", timeout: 30000 });

  // Wait for scene + DEV probes.
  await page.waitForFunction(
    () =>
      typeof window.__pointerLockToggle === "function" &&
      typeof window.__chaseCameraProbe === "function" &&
      typeof window.__peer === "object",
    null,
    { timeout: 15000 },
  );
  await page.waitForTimeout(200); // let React mount + first HUD poll run

  // ── 1. Fresh page: menu NOT in DOM (everLocked gate) ─────────────────────
  const menu1 = await page.$('[data-testid="pause-menu"]');
  if (menu1 !== null) {
    FAIL("Fresh page should NOT render the pause menu (everLocked=false)");
  }
  PASS("Fresh page: pause menu not rendered (everLocked gate)");

  // ── 2. Lock: menu NOT in DOM ─────────────────────────────────────────────
  await page.evaluate(() => window.__pointerLockToggle(true));
  await page.waitForTimeout(200); // wait for HUD poll to re-render
  const menu2 = await page.$('[data-testid="pause-menu"]');
  if (menu2 !== null) {
    FAIL("Locked page should NOT render the pause menu");
  }
  PASS("Locked: pause menu not rendered");

  // ── 3. Unlock: menu IS in DOM ────────────────────────────────────────────
  await page.evaluate(() => window.__pointerLockToggle(false));
  await page.waitForTimeout(200);
  const menu3 = await page.$('[data-testid="pause-menu"]');
  if (menu3 === null) {
    FAIL("Unlocked + everLocked should render the pause menu");
  }
  PASS("Unlocked + everLocked: pause menu rendered");

  // ── 4. Backdrop pointer-events: auto (HUD-overlay-eats-clicks guard) ────
  const backdropPointerEvents = await page.$eval(
    '[data-testid="pause-menu"]',
    (el) => getComputedStyle(el).pointerEvents,
  );
  if (backdropPointerEvents !== "auto") {
    FAIL(`Backdrop pointer-events should be 'auto', got '${backdropPointerEvents}'`);
  }
  PASS(`Backdrop pointer-events: ${backdropPointerEvents}`);

  // ── 5. Resume button pointer-events: auto ───────────────────────────────
  const resumePointerEvents = await page.$eval(
    '[data-testid="pause-menu-resume"]',
    (el) => getComputedStyle(el).pointerEvents,
  );
  if (resumePointerEvents !== "auto") {
    FAIL(`Resume button pointer-events should be 'auto', got '${resumePointerEvents}'`);
  }
  PASS(`Resume button pointer-events: ${resumePointerEvents}`);

  // ── 6. Backdrop cursor: default (visible for clicking) ───────────────────
  const backdropCursor = await page.$eval(
    '[data-testid="pause-menu"]',
    (el) => getComputedStyle(el).cursor,
  );
  if (backdropCursor !== "default") {
    FAIL(`Backdrop cursor should be 'default', got '${backdropCursor}'`);
  }
  PASS(`Backdrop cursor: ${backdropCursor}`);

  // ── Screenshot before clicking (capture the visible menu) ────────────────
  await page.screenshot({ path: SCREENSHOT });
  PASS(`Screenshot saved to ${SCREENSHOT}`);

  // ── 7. Click Resume → pointer re-locks ──────────────────────────────────
  await page.click('[data-testid="pause-menu-resume"]');
  await page.waitForTimeout(300); // wait for HUD poll to update
  const s7 = await page.evaluate(() => window.__chaseCameraProbe());
  if (!s7.isPointerLocked) {
    FAIL(`Click Resume should re-lock pointer; isPointerLocked=${s7.isPointerLocked}`);
  }
  PASS("Click Resume: pointer re-locked");

  // ── 10. ESC-equals-resume (Kyle's spec) ─────────────────────────────────
  // Unlock again, then dispatch ESC keydown, assert re-locks.
  await page.evaluate(() => window.__pointerLockToggle(false));
  await page.waitForTimeout(200);
  // Sanity check: menu is visible.
  const menuBeforeEsc = await page.$('[data-testid="pause-menu"]');
  if (menuBeforeEsc === null) {
    FAIL("Menu should be visible after unlock (ESC test setup)");
  }
  // Dispatch ESC via page.keyboard.press. The PauseMenu's useEffect
  // attaches a window-level keydown listener that calls onResume.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const s10 = await page.evaluate(() => window.__chaseCameraProbe());
  if (!s10.isPointerLocked) {
    FAIL(`ESC while menu visible should re-lock pointer; isPointerLocked=${s10.isPointerLocked}`);
  }
  PASS("ESC while menu visible: pointer re-locked (ESC-equals-resume)");

  // ── 11. Resume restores prior viewMode (Kyle's spec) ────────────────────
  // Currently viewMode should be 0 (the resume just landed at mode 0).
  // Lock, V-toggle to mode 1, unlock, click Resume → assert viewMode === 1.
  await page.evaluate(() => {
    window.__pointerLockToggle(false); // ensure unlocked for clean state
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__pointerLockToggle(true));
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__chaseCameraToggle()); // V → mode 1
  await page.waitForTimeout(100);
  const s11pre = await page.evaluate(() => window.__chaseCameraProbe());
  if (s11pre.viewMode !== 1) {
    FAIL(`Setup failed: viewMode should be 1 after V-toggle, got ${s11pre.viewMode}`);
  }
  // Now ESC + Resume: viewMode should restore to 1.
  await page.evaluate(() => window.__pointerLockToggle(false));
  await page.waitForTimeout(200);
  await page.click('[data-testid="pause-menu-resume"]');
  await page.waitForTimeout(300);
  const s11 = await page.evaluate(() => window.__chaseCameraProbe());
  if (s11.viewMode !== 1) {
    FAIL(`Resume should restore prior viewMode; expected 1, got ${s11.viewMode}`);
  }
  PASS(`Resume restored viewMode: ${s11.viewMode} (last-camera preservation)`);

  // ── 8. Disconnect Peer → peer closes ────────────────────────────────────
  // Setup: unlock to see the menu, then click Disconnect Peer, then
  // assert the peer's connection state has changed.
  await page.evaluate(() => window.__pointerLockToggle(false));
  await page.waitForTimeout(200);
  const peerStateBefore = await page.evaluate(() => {
    const peer = window.__peer;
    return {
      hasPeer: !!peer,
      connectionState: peer?.connection?.connectionState ?? null,
    };
  });
  // Click Disconnect. The handle may be `closed` already (peer.close() is
  // idempotent), but a non-null connectionState at this point means the
  // click should either change it to 'closed' or set connection.closed.
  await page.click('[data-testid="pause-menu-disconnect"]');
  await page.waitForTimeout(300);
  const peerStateAfter = await page.evaluate(() => {
    const peer = window.__peer;
    return {
      hasPeer: !!peer,
      connectionState: peer?.connection?.connectionState ?? null,
      signState: peer?.connection?.signalingState ?? null,
      connectionClosed: peer?.connection ? peer.connection.connectionState === "closed" : true,
    };
  });
  if (peerStateBefore.hasPeer && !peerStateAfter.connectionClosed) {
    FAIL(
      `Disconnect Peer click should close the connection; ` +
      `before=${peerStateBefore.connectionState} after=${peerStateAfter.connectionState}`,
    );
  }
  PASS(
    `Disconnect Peer: connectionState ${peerStateBefore.connectionState} → ${peerStateAfter.connectionState} ` +
    `(closed=${peerStateAfter.connectionClosed})`,
  );

  // ── 9. Loadout + Settings are disabled placeholders ─────────────────────
  const loadoutDisabled = await page.$eval(
    '[data-testid="pause-menu-loadout"]',
    (el) => el.disabled,
  );
  if (!loadoutDisabled) {
    FAIL("Loadout button should be disabled");
  }
  const settingsDisabled = await page.$eval(
    '[data-testid="pause-menu-settings"]',
    (el) => el.disabled,
  );
  if (!settingsDisabled) {
    FAIL("Settings button should be disabled");
  }
  PASS("Loadout + Settings buttons disabled (placeholders)");

  // ── Final check: no JS errors during the run ────────────────────────────
  if (errors.length > 0) {
    console.error("Page errors observed during smoke:");
    for (const e of errors) console.error(`  ${e}`);
    FAIL(`${errors.length} pageerror(s) during run`);
  }
  PASS("No page errors during smoke");

  console.log("\nOK — pause menu smoke passed (visibility + pointer-events + ESC + viewMode restoration + disconnect)");
} catch (err) {
  console.error("[FAIL] Unexpected error:", err);
  process.exit(1);
} finally {
  await browser.close();
}
