#!/usr/bin/env node
// Tier-3 Mac keyboard-only lobby test (PR #94 follow-up).
//
// MANUAL RECIPE — not run in CI yet. Vivaldi CDP on Kyle's Mac requires
// launching Vivaldi with `--remote-debugging-port=N` BEFORE Playwright
// can connect. Kyle's running Vivaldi doesn't have CDP enabled, so this
// smoke currently fails to connect. To run manually:
//
//   # 1. SSH-launch Vivaldi with CDP on Kyle's Mac (one-time per session):
//   ssh -i ~/.ssh/id_macbook kylelampa@100.79.235.118 \
//     '"/Applications/Vivaldi.app/Contents/MacOS/Vivaldi" --remote-debugging-port=9224 \
//      --user-data-dir=/tmp/vivaldi-pr94 --no-first-run --no-default-browser-check \
//      --new-window about:blank >/tmp/vivaldi-pr94.log 2>&1 </dev/null & disown; \
//      sleep 4'
//
//   # 2. Tunnel MacBook CDP → m5 (background):
//   ssh -i ~/.ssh/id_macbook -L 9224:localhost:9224 -N -f kylelampa@100.79.235.118
//
//   # 3. Boot canary + vite on m5 (PR #94 dev environment):
//   bash tools/canary-server.sh --port-wt 14933 --port-ws 14934 --port-http 19980
//   cd client && VITE_MATCHMAKER_ORIGIN=http://127.0.0.1:19980 \
//     npx vite --port 5194 --host 0.0.0.0 --strictPort
//
//   # 4. Run this smoke:
//   node client/tools/lobby-tier3-keyboard-smoke.mjs
//
// What it asserts (when runnable):
//   - Lobby renders in Vivaldi (real browser, not headless Chromium)
//   - Autofocus lands on Code input on mount
//   - Tab from Code → Join (default browser focus order)
//   - Tab from Join → Code (focus trap redirects)
//   - Shift+Tab from Code → Join (focus trap redirects)
//   - Enter on Join triggers a fetch (real keyboard, not synthetic click)
//
// Catches:
//   - Vivaldi-specific quirks (the stub-CDP gap pattern documented in
//     references/v1.30-pr11.7.e-tier-3-vivaldi-gap.md — Playwright
//     connectOverCDP hangs on Vivaldi's stub-CDP. The launch recipe above
//     uses --remote-debugging-port=9224 to get the FULL CDP, not stub.)
//   - Real keyboard timing vs synthetic Playwright presses
//   - Tab/Shift+Tab behavior on macOS (different focus order than Linux/Windows)
//
// CAVEAT: the recipe above is known to work in principle (Playwright +
// Chrome-via-CDP is the standard pattern) but **failed on the 2026-08-31
// PR #94 dispatch attempt** — Kyle's existing Vivaldi (running for
// hours before the dispatch) absorbed the new `--remote-debugging-port`
// flag and kept the OLD config (no CDP). The new Vivaldi instance
// either failed to launch in a separate window or attached to the
// existing session without bringing up the CDP listener. Future
// dispatches should:
//   - Ask Kyle to launch Vivaldi with the CDP flag from his own session
//   - Or use a fresh user-data-dir + a fresh window with explicit CDP
//   - Or document as a manual-only check in the PR description
//
// See `references/tier-3-real-browser-recipe.md` in the project skill
// for the canonical CDP tunnel + Playwright connectOverCDP recipe.

import { chromium } from "playwright";
import { setTimeout as sleep } from "node:timers/promises";

const CDP_URL = process.env.CDP_URL ?? "http://127.0.0.1:9224";
const VITE_URL = process.env.VITE_URL ?? "http://127.0.0.1:5194/";
const MATCHMAKER_ORIGIN = process.env.MATCHMAKER_ORIGIN ?? "http://127.0.0.1:19980";

const log = (...a) => console.log("[lobby-tier3-keyboard]", ...a);
const fail = (...a) => console.error("[lobby-tier3-keyboard][FAIL]", ...a);

const results = [];
const recordPass = (name) => { results.push({ name, ok: true }); log(`  ✓ ${name}`); };
const recordFail = (name, why) => { results.push({ name, ok: false, why }); fail(`${name}: ${why}`); };

async function main() {
  log(`CDP_URL=${CDP_URL} VITE_URL=${VITE_URL}`);

  // Connect to Kyle's Vivaldi via CDP. launchPersistentContext-style via
  // connectOverCDP — Playwright attaches to the running browser instead
  // of launching its own.
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (e) {
    fail(`failed to connect to Vivaldi CDP at ${CDP_URL}: ${e.message}`);
    process.exit(2);
  }
  log("connected to Vivaldi via CDP");

  // Open a new context + page for the test (Vivaldi's existing windows are left alone)
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") log(`[browser:error] ${m.text()}`);
  });
  page.on("pageerror", (e) => log(`[pageerror] ${e.message}`));

  try {
    // 1. Navigate to lobby
    const lobbyUrl = new URL(VITE_URL);
    lobbyUrl.searchParams.set("lobby", "1");
    await page.goto(lobbyUrl.toString(), { waitUntil: "networkidle", timeout: 30000 });

    // Wait for lobby to render
    await page.waitForSelector('[data-testid="lobby"]', { timeout: 5000 });
    recordPass("lobby-renders-in-vivaldi");

    // 2. Assert autofocus (real keyboard focus, not synthetic)
    await sleep(200); // let rAF fire
    const initialFocus = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? el.getAttribute("data-testid") : null;
    });
    if (initialFocus !== "lobby-code") {
      recordFail("autofocus", `expected initial focus on lobby-code (got: ${initialFocus})`);
    } else {
      recordPass("autofocus");
    }

    // 3. Test focus trap: type code so Join becomes enabled
    await page.keyboard.type("TIER3TEST");
    await sleep(100);
    // Tab from Code → Join (default browser Tab should land on next focusable)
    await page.keyboard.press("Tab");
    await sleep(100);
    const afterFirstTab = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? el.getAttribute("data-testid") : null;
    });
    if (afterFirstTab !== "lobby-join") {
      recordFail("tab-from-code", `expected Tab from Code to land on Join (got: ${afterFirstTab})`);
    } else {
      recordPass("tab-from-code");
    }

    // 4. Tab from Join → Code (focus trap redirects)
    await page.keyboard.press("Tab");
    await sleep(100);
    const afterSecondTab = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? el.getAttribute("data-testid") : null;
    });
    if (afterSecondTab !== "lobby-code") {
      recordFail("tab-trap-from-join", `expected Tab from Join to land on Code (focus trap) (got: ${afterSecondTab})`);
    } else {
      recordPass("tab-trap-from-join");
    }

    // 5. Shift+Tab from Code → Join (focus trap redirects)
    await page.keyboard.press("Shift+Tab");
    await sleep(100);
    const afterShiftTab = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? el.getAttribute("data-testid") : null;
    });
    if (afterShiftTab !== "lobby-join") {
      recordFail("shift-tab-trap", `expected Shift+Tab from Code to land on Join (got: ${afterShiftTab})`);
    } else {
      recordPass("shift-tab-trap");
    }

    // 6. Press Enter on Join → triggers join (real keyboard, not synthetic click)
    // Clear the input first (Join needs a valid code, will get 404 from real canary)
    await page.keyboard.press("Escape"); // blur Join
    await page.focus('[data-testid="lobby-code"]');
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("TIER3TEST");
    await page.focus('[data-testid="lobby-join"]');
    await page.keyboard.press("Enter");
    await sleep(2000);
    // Should see either a "not found" error or the busy state — both prove Enter key worked
    const errText = await page.evaluate(() => {
      const err = document.querySelector('[data-testid="lobby-error"]');
      const busy = document.querySelector('[data-testid="lobby-busy"]');
      return { err: err?.textContent ?? null, busy: busy?.textContent ?? null };
    });
    if (!errText.err && !errText.busy) {
      recordFail("enter-submits", `Enter on Join didn't surface any error or busy (got: ${JSON.stringify(errText)})`);
    } else {
      recordPass("enter-submits");
      log(`  Enter triggered: err="${errText.err}" busy="${errText.busy}"`);
    }

    // 7. Take screenshot for visual record
    await page.screenshot({ path: "/tmp/lobby-tier3-keyboard-vivaldi.png" });
    log("  screenshot saved to /tmp/lobby-tier3-keyboard-vivaldi.png");
  } catch (e) {
    recordFail("uncaught", e.message);
  } finally {
    await ctx.close();
    // Don't close browser — it's Kyle's Vivaldi
    await browser.close().catch(() => {});
  }

  log("\n--- assertion summary ---");
  for (const r of results) {
    if (r.ok) log(`  PASS  ${r.name}`);
    else fail(`  FAIL  ${r.name} (${r.why})`);
  }
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  log(`\n=== ${failed === 0 ? "ALL" : `${passed}/${results.length}`} ASSERTIONS ${failed === 0 ? "PASSED" : "(some FAILED)"} ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  fail("fatal:", e.message);
  process.exit(2);
});
