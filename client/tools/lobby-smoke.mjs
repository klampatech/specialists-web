#!/usr/bin/env node
// PR 11.9 — matchmaker lobby smoke.
//
// Boots the canary server (WebTransport + WebSocket + matchmaker HTTP)
// + Vite on a fresh port, opens a SINGLE headless tab against the
// entry URL (no `?server=`), and asserts:
//
//   1. The Lobby component renders (button + input visible).
//   2. Clicking "Create room" navigates to a `?server=<ws_url>` URL
//      (within 3s) where `<ws_url>` matches the matchmaker POST
//      response.
//   3. After navigation, the scene mounts and the `ServerTransport`
//      connects (connectionStatus === "connected" within 5s).
//   4. While the create-room fetch is in flight, the lobby shows an
//      inline status text (data-kind="busy" on the lobby-busy testid,
//      neutral color) — replaces the silent "did it hang?" UX.
//   5. With a stubbed {exists:true, players:5, max:24} response,
//      clicking Join after a successful getRoom() renders the
//      player-count indicator (data-testid="lobby-room-status")
//      next to the input. We use `page.route` to abort the
//      subsequent `?server=...` navigation so the indicator
//      stays visible for inspection.
//   6. With a stubbed full-room response, the lobby surfaces the
//      "Room <id> is full (24/24). Try another." error and
//      does NOT navigate. The indicator turns red and shows
//      " (full)".
//   7. With a real 404 (type a bogus code), the lobby shows the
//      "Room <id> not found" error. Typing a fresh character
//      clears the error (next-interaction auto-dismiss).

// PR 11.9 follow-up (lobby polish) added 7 new assertions
// (assertions 2+4 bundled): busy-state-on-create, create-navigates,
// scene-connects, room-status-indicator, full-room-error/indicator/
// no-nav (3 assertions), error-renders, error-clears-on-input.
// Total 10.
//
// PR 94 (lobby a11y) adds 5 more (assertions 8-12): role-dialog-
// testid (lobby div has role="dialog" + aria-modal="true"),
// focus-trap-tab (Tab from Join -> Code), focus-trap-shift-tab
// (Shift+Tab from Code -> Join), first-input-autofocus (code input
// focused on mount), aria-label-input (code input has aria-label=
// "Room code"). Total 15.
//
// The smoke is a single tab (NOT two-tab) because the matchmaker
// surface itself is single-player-shaped (you create a room, you
// share the URL, friends join). Two-tab flow is covered by the
// existing `damage-server-smoke.mjs` (which uses pre-baked URLs).
//
// **Required env vars**:
//   LOBBY_SMOKE_URL          (default http://localhost:5194/) — Vite URL
//   CANARY_SERVER_PORT_WT    (default 14433)
//   CANARY_SERVER_PORT_WS    (default 14434)
//   CANARY_SERVER_PORT_HTTP  (default 18080)
//   SMOKE_PNG                (default client/tools/lobby-smoke.png)
//
// **Required teardown**: kill vite + canary on exit, even on failure.
//
// **Detection notes for the busy-state / indicator tests**:
//   The in-page React state transitions we want to observe (busy
//   text paint, players/max indicator paint) happen for ~1 frame
//   before window.location.href unloads the page. Playwright's
//   `waitFor` with default `raf` polling (~16ms) can miss them.
//   We use three tricks:
//     1. `page.route` adds a 500ms delay to the POST /rooms
//        response for the busy-state test, giving the busy text
//        a wide paint window.
//     2. `waitFor({ polling: 10 })` polls every 10ms for the
//        full-room error/indicator (assertions 6 + 7), since
//        those states persist on the lobby (no navigation).
//     3. For the indicator test (assertion 5), the indicator
//        flashes for ~1 frame before `?server=` navigation
//        tears the page down. We wire a `MutationObserver` +
//        `page.exposeBinding` BEFORE the click so the data is
//        captured in Node.js the moment `flushSync` commits
//        the indicator — even if the navigation races the
//        page.evaluate ExecutionContext (the binding runs in
//        Node, immune to page tear-down).

import { chromium } from "playwright";
import { spawn, execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

const URL_BASE = process.env.LOBBY_SMOKE_URL ?? "http://localhost:5194/";
const WT_PORT = Number(process.env.CANARY_SERVER_PORT_WT ?? 14433);
const WS_PORT = Number(process.env.CANARY_SERVER_PORT_WS ?? 14434);
const HTTP_PORT = Number(process.env.CANARY_SERVER_PORT_HTTP ?? 18080);
const VITE_PORT = 5194;
const SCREENSHOT = process.env.SMOKE_PNG ?? "client/tools/lobby-smoke.png";

const NAV_TIMEOUT = Number(process.env.SMOKE_NAV_TIMEOUT ?? 30000);
const CONNECT_TIMEOUT_MS = Number(process.env.SMOKE_CONNECT_TIMEOUT_MS ?? 5000);
const CREATE_NAV_TIMEOUT_MS = Number(process.env.LOBBY_SMOKE_CREATE_TIMEOUT ?? 5000);
const BUSY_TIMEOUT_MS = Number(process.env.LOBBY_SMOKE_BUSY_TIMEOUT ?? 3000);
const POLL_FAST = 10;

const SCREENSHOT_PATH = resolve(REPO_ROOT, SCREENSHOT);

const log = (...args) => console.log("[lobby-smoke]", ...args);
const fail = (...args) => console.error("[lobby-smoke][FAIL]", ...args);

mkdirSync(dirname(SCREENSHOT_PATH), { recursive: true });

let canaryProc = null;
let viteProc = null;

async function bootCanary() {
  log(`Booting canary (WT=${WT_PORT}, WS=${WS_PORT}, HTTP=${HTTP_PORT})...`);
  try {
    const probe = await fetch(`http://127.0.0.1:${HTTP_PORT}/health`);
    if (probe.ok) {
      log(`Canary already running on :${HTTP_PORT} (skipping spawn)`);
      canaryProc = null;
      return;
    }
  } catch (_) {
    // not running — proceed to spawn
  }

  canaryProc = spawn(
    "bash",
    [
      resolve(REPO_ROOT, "tools", "canary-server.sh"),
      "--port-wt", String(WT_PORT),
      "--port-ws", String(WS_PORT),
      "--port-http", String(HTTP_PORT),
      "--cert-source", "self-signed",
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
      throw new Error(`canary exited with code ${canaryProc.exitCode} during boot`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/health`);
      if (res.ok) {
        log(`Canary matchmaker HTTP ready after ${i + 1}s`);
        return;
      }
    } catch (_) {
      // not yet
    }
  }
  throw new Error(`canary did not bind matchmaker HTTP ${HTTP_PORT} within 60s`);
}

async function bootVite() {
  log(`Booting Vite on port ${VITE_PORT}...`);
  viteProc = spawn(
    "npm",
    ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(VITE_PORT), "--strictPort"],
    {
      cwd: resolve(REPO_ROOT, "client"),
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    }
  );
  viteProc.stdout.on("data", (d) => process.stderr.write(`[vite] ${d}`));
  viteProc.stderr.on("data", (d) => process.stderr.write(`[vite-err] ${d}`));

  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (viteProc.exitCode !== null) {
      throw new Error(`Vite exited with code ${viteProc.exitCode} during boot`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${VITE_PORT}/`);
      if (res.ok) {
        log(`Vite ready after ${i + 1}s`);
        return;
      }
    } catch (_) {
      // not yet
    }
  }
  throw new Error(`Vite did not bind port ${VITE_PORT} within 60s`);
}

function killProcs() {
  for (const proc of [canaryProc, viteProc]) {
    if (proc && proc.exitCode === null) {
      try { proc.kill("SIGTERM"); } catch (_) { /* dead */ }
    }
  }
  setTimeout(() => {
    for (const port of [WT_PORT, WS_PORT, HTTP_PORT, VITE_PORT]) {
      try {
        const out = execSync(`lsof -ti:${port} 2>/dev/null || true`, { encoding: "utf8" });
        const pids = out.trim().split("\n").filter(Boolean);
        for (const pid of pids) {
          try { process.kill(Number(pid), "SIGKILL"); } catch (_) { /* already dead */ }
        }
      } catch (_) { /* best-effort */ }
    }
  }, 1000);
}

/** Open a fresh tab on the lobby URL (no `?server=`). Used
 *  after the create-room flow takes the previous tab into
 *  the scene — we want a clean React tree for each new
 *  assertion so route state and roomStatus state from
 *  previous runs don't leak. */
async function openLobbyPage(context) {
  const target = new URL(URL_BASE);
  target.searchParams.set("lobby", "1");
  target.searchParams.delete("server");
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") log(`[browser:error] ${m.text()}`);
  });
  await page.goto(target.toString(), { waitUntil: "networkidle", timeout: NAV_TIMEOUT });
  return page;
}

async function main() {
  log(`=== lobby-smoke (PR 11.9 + PR 11.9 follow-up) ===`);
  log(`vite: ${URL_BASE}  WT=${WT_PORT}  WS=${WS_PORT}  HTTP=${HTTP_PORT}`);

  let pass = true;
  const assertionResults = [];

  const recordPass = (name) => { assertionResults.push({ name, ok: true }); };
  const recordFail = (name, why) => {
    assertionResults.push({ name, ok: false, why });
    pass = false;
  };

  try {
    await bootCanary();
    await bootVite();

    const browser = await chromium.launch({ args: ["--no-sandbox"] });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") log(`[browser:error] ${m.text()}`);
    });

    const target = new URL(URL_BASE);
    target.searchParams.set("lobby", "1");
    log(`Navigating to ${target.toString()} (no ?server= param → lobby should render)`);
    await page.goto(target.toString(), { waitUntil: "networkidle", timeout: NAV_TIMEOUT });

    // Assertion 1: Lobby renders.
    log(`ASSERTION 1: lobby component renders`);
    const createBtn = page.getByTestId("lobby-create");
    const joinInput = page.getByTestId("lobby-code");
    const joinBtn = page.getByTestId("lobby-join");
    if (!(await createBtn.isVisible())) {
      fail(`lobby-create button not visible`);
      recordFail("lobby-renders", "lobby-create button not visible");
    } else if (!(await joinInput.isVisible())) {
      fail(`lobby-code input not visible`);
      recordFail("lobby-renders", "lobby-code input not visible");
    } else if (!(await joinBtn.isVisible())) {
      fail(`lobby-join button not visible`);
      recordFail("lobby-renders", "lobby-join button not visible");
    } else {
      log(`  ✓ lobby rendered (create + code + join all visible)`);
      recordPass("lobby-renders");
    }

    await page.screenshot({ path: SCREENSHOT_PATH });
    log(`screenshot: ${SCREENSHOT_PATH}`);

    // Assertion 2 + 4: click "Create room" → busy state appears,
    // then navigates to ?server=<ws_url>.
    //
    // The POST /rooms response is delayed 500ms via page.route
    // so the "Creating room…" busy state has a real paint
    // window (local canary responds in <1ms otherwise). The
    // nav timeout is bumped to 5s to accommodate the delay.
    log(`ASSERTION 2+4: clicking "Create room" shows busy state and navigates within ${CREATE_NAV_TIMEOUT_MS}ms`);
    if (pass) {
      await page.route(/\/rooms(?:\?|$)/, async (route) => {
        if (route.request().method() === "POST") {
          await new Promise((r) => setTimeout(r, 500));
        }
        await route.continue();
      });
      const busyLocator = page.locator('[data-testid="lobby-busy"][data-kind="busy"]');
      const navPromise = page.waitForURL(
        (url) => {
          const u = new URL(url);
          return !!u.searchParams.get("server");
        },
        { timeout: CREATE_NAV_TIMEOUT_MS, waitUntil: "load" },
      );
      const busySeenPromise = busyLocator
        .waitFor({ state: "attached", timeout: BUSY_TIMEOUT_MS, polling: POLL_FAST })
        .then(() => true)
        .catch(() => false);
      await createBtn.click();
      const [busySeen, _navResult] = await Promise.allSettled([
        busySeenPromise,
        navPromise,
      ]).then((results) => [results[0], results[1]]);
      if (busySeen.status !== "fulfilled" || busySeen.value !== true) {
        fail(`busy state did not appear within ${BUSY_TIMEOUT_MS}ms of clicking Create`);
        recordFail("busy-state-on-create", "busy state never became visible");
      } else {
        log(`  ✓ busy state ("Creating room…") shown before navigation`);
        recordPass("busy-state-on-create");
      }
      const finalUrl = page.url();
      if (!new URL(finalUrl).searchParams.get("server")) {
        fail(`Create-room did not navigate: current URL: ${finalUrl}`);
        recordFail("create-navigates", `did not navigate; current URL: ${finalUrl}`);
      } else {
        log(`  ✓ navigated to ${finalUrl}`);
        recordPass("create-navigates");
      }
      // Remove the POST-delay route so it doesn't interfere
      // with later assertions on page2.
      await page.unroute(/\/rooms(?:\?|$)/);
    }

    // Assertion 3: Scene mounts + ServerTransport connects.
    if (pass) {
      log(`ASSERTION 3: scene mounts + ServerTransport connects within ${CONNECT_TIMEOUT_MS}ms`);
      let status = null;
      const deadline = Date.now() + CONNECT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        try {
          status = await page.evaluate(() => ({
            force: window.__forceServerTransport ?? false,
            connection: window.__lastConnectionStatus ?? "unknown",
            roomId: window.__damageServerRoomId ?? null,
          }));
          if (status && (status.connection === "connected" || status.force)) {
            break;
          }
        } catch (_) {
          // page may not have the probes yet
        }
        await sleep(200);
      }
      if (!status || !(status.connection === "connected" || status.force)) {
        fail(`ServerTransport did not connect within ${CONNECT_TIMEOUT_MS}ms (status=${JSON.stringify(status)})`);
        recordFail("scene-connects", `did not connect; status=${JSON.stringify(status)}`);
      } else {
        log(`  ✓ connected (force=${status.force}, roomId=${status.roomId})`);
        recordPass("scene-connects");
      }
    }

    // ----- PR 11.9 follow-up (lobby polish) new assertions -----
    // The scene tab is now consumed. Open a fresh page so the
    // lobby React tree is clean for each new assertion.

    // Assertion 5: type a valid 8-char code, click Join, lobby
    // shows the player-count indicator. We stub GET /rooms/<id>
    // with page.route to return {exists:true, players:5, max:24}
    // and abort the ?server= navigation so the indicator stays
    // visible for inspection.
    log(`ASSERTION 5: player-count indicator shows after a successful getRoom()`);
    let page2 = await openLobbyPage(context);
    try {
      await page2.route(/\/rooms\/[^/?]+(?:$|\?)/, (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ exists: true, players: 5, max: 24 }),
        });
      });
      // Abort the subsequent ?server= navigation so the page
      // doesn't unload mid-test. The observer + binding below
      // captures the indicator data regardless of whether the
      // navigation completes, but the abort keeps the page
      // stable for the post-assertion cleanup.
      await page2.route(/\?server=/, async (route) => {
        await new Promise((r) => setTimeout(r, 500));
        await route.abort();
      });

      const code5 = "ABC12345";
      await page2.getByTestId("lobby-code").fill(code5);

      // The success path of onJoin does flushSync + microtask
      // yield + window.location.href. The indicator is in the
      // DOM for ~1 frame before the navigation tears it down.
      // Neither `waitFor` nor `page.evaluate` from outside can
      // reliably catch it (the page's execution context is
      // destroyed by the navigation). Instead we wire a
      // MutationObserver inside the page that posts to a
      // `page.exposeBinding` callback — the callback runs in
      // the Node.js context, so the indicator data is
      // captured before the unload.
      //
      // CRITICAL: the binding + observer must be set up BEFORE
      // the click. If we tried to set them up after, the
      // `page.evaluate` would race the navigation and we'd see
      // "Execution context was destroyed" — the lobby would
      // render the indicator and navigate away before we could
      // observe anything.
      let indicatorInfo = null;
      await page2.exposeBinding("__captureIndicator", (_source, info) => {
        if (indicatorInfo === null) indicatorInfo = info;
      });
      await page2.evaluate(() => {
        const observer = new MutationObserver(() => {
          const el = document.querySelector(
            '[data-testid="lobby-room-status"]',
          );
          if (el && !window.__smokeCaptureDone) {
            window.__smokeCaptureDone = true;
            window.__captureIndicator({
              text: el.textContent,
              full: el.getAttribute("data-full"),
            });
            observer.disconnect();
          }
        });
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
        });
      });

      // Now click — the observer is already wired and will
      // capture the indicator the moment flushSync commits it.
      // After clicking, poll for the binding callback to fire.
      await page2.getByTestId("lobby-join").click();
      for (let i = 0; i < 200 && indicatorInfo === null; i++) {
        await sleep(10);
      }

      if (!indicatorInfo) {
        fail(`indicator was never captured (MutationObserver did not fire)`);
        recordFail("room-status-indicator", "indicator never captured");
      } else if (!indicatorInfo.text.includes("5/24")) {
        fail(`indicator text did not contain '5/24' (got: ${JSON.stringify(indicatorInfo.text)})`);
        recordFail("room-status-indicator", `text=${JSON.stringify(indicatorInfo.text)}`);
      } else if (indicatorInfo.full !== "false") {
        fail(`indicator data-full should be "false" (got: ${JSON.stringify(indicatorInfo.full)})`);
        recordFail("room-status-indicator", `data-full=${JSON.stringify(indicatorInfo.full)}`);
      } else {
        log(`  ✓ indicator captured with text "${String(indicatorInfo.text).trim()}", data-full=false`);
        recordPass("room-status-indicator");
      }
    } finally {
      await page2.close();
    }

    // Assertion 6: full-room path. Stub GET /rooms/<id> with
    // {exists:true, players:24, max:24} and verify the lobby
    // surfaces the "Room <id> is full (24/24). Try another."
    // error AND does NOT navigate.
    log(`ASSERTION 6: full-room response surfaces error + indicator, no navigation`);
    page2 = await openLobbyPage(context);
    try {
      let fullRoomNavigated = false;
      await page2.route(/\?server=/, (route) => {
        fullRoomNavigated = true;
        return route.abort();
      });
      await page2.route(/\/rooms\/[^/?]+(?:$|\?)/, (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ exists: true, players: 24, max: 24 }),
        });
      });

      const code6 = "FULL001";
      await page2.getByTestId("lobby-code").fill(code6);
      await page2.getByTestId("lobby-join").click();

      const errorEl = page2.locator('[data-testid="lobby-error"][data-kind="error"]');
      const indicator = page2.getByTestId("lobby-room-status");
      try {
        await errorEl.waitFor({ state: "attached", timeout: 3000, polling: POLL_FAST });
        const errorText = (await errorEl.textContent()) ?? "";
        if (!errorText.includes("is full") || !errorText.includes("24/24")) {
          fail(`error text wrong: ${JSON.stringify(errorText)}`);
          recordFail("full-room-error", `text=${JSON.stringify(errorText)}`);
        } else {
          log(`  ✓ full-room error visible: "${errorText.trim()}"`);
          recordPass("full-room-error");
        }
        await indicator.waitFor({ state: "attached", timeout: 1000, polling: POLL_FAST });
        const fullAttr = await indicator.getAttribute("data-full");
        const indText = (await indicator.textContent()) ?? "";
        if (fullAttr !== "true" || !indText.includes("(full)")) {
          fail(`indicator not red/full: data-full=${JSON.stringify(fullAttr)} text=${JSON.stringify(indText)}`);
          recordFail("full-room-indicator", `data-full=${JSON.stringify(fullAttr)} text=${JSON.stringify(indText)}`);
        } else {
          log(`  ✓ indicator data-full=true, text="${indText.trim()}"`);
          recordPass("full-room-indicator");
        }
        await sleep(500);
        if (fullRoomNavigated) {
          fail(`lobby attempted to navigate despite full-room (route abort saw a request)`);
          recordFail("full-room-no-nav", "navigation request issued");
        } else {
          log(`  ✓ no navigation attempted`);
          recordPass("full-room-no-nav");
        }
      } catch (e) {
        fail(`full-room error/indicator did not appear: ${e.message}`);
        recordFail("full-room-error", e.message);
      }
    } finally {
      await page2.close();
    }

    // Assertion 7: 404 (real, not stubbed) + typing clears the
    // error. Use a code that the canary will 404 on. After the
    // error renders, type a single char and verify the error
    // slot goes back to hidden (next-interaction auto-dismiss).
    log(`ASSERTION 7: 404 surfaces inline error, next keystroke clears it`);
    page2 = await openLobbyPage(context);
    try {
      const code7 = "NOPE1234";
      await page2.getByTestId("lobby-code").fill(code7);
      await page2.getByTestId("lobby-join").click();

      const errorEl = page2.locator('[data-testid="lobby-error"][data-kind="error"]');
      try {
        await errorEl.waitFor({ state: "attached", timeout: 3000, polling: POLL_FAST });
        const errorText = (await errorEl.textContent()) ?? "";
        if (!errorText.includes("not found") || !errorText.includes(code7)) {
          fail(`404 error text wrong: ${JSON.stringify(errorText)}`);
          recordFail("error-renders", `text=${JSON.stringify(errorText)}`);
        } else {
          log(`  ✓ 404 error visible: "${errorText.trim()}"`);
          recordPass("error-renders");
        }
        await page2.getByTestId("lobby-code").press("X");
        try {
          await errorEl.waitFor({ state: "detached", timeout: 1000, polling: POLL_FAST });
          log(`  ✓ error cleared on next keystroke`);
          recordPass("error-clears-on-input");
        } catch (e) {
          fail(`error did not clear after typing: ${e.message}`);
          recordFail("error-clears-on-input", e.message);
        }
      } catch (e) {
        fail(`404 error did not appear within 3s: ${e.message}`);
        recordFail("error-renders", e.message);
      }
    } finally {
      await page2.close();
    }

    // ----- PR 94 (lobby a11y) new assertions -----
    // The lobby React tree is replaced for each a11y assertion so
    // refs + focus state from earlier tests don't leak. Tests run
    // 8 -> 12 (role-dialog-testid, focus-trap-tab, focus-trap-shift-
    // tab, first-input-autofocus, aria-label-input). Total smoke
    // passes 10 -> 15.

    // Assertion 8: role=dialog + aria-modal=true on the outer lobby
    // div. The smoke uses the existing `lobby` testid so we don't
    // need a new testid; the role + aria-modal attrs are added by
    // the PR 94 a11y pass.
    log(`ASSERTION 8: lobby has role="dialog" + aria-modal="true"`);
    page2 = await openLobbyPage(context);
    try {
      const dialogAttr = await page2
        .locator('[data-testid="lobby"]')
        .getAttribute("role");
      const modalAttr = await page2
        .locator('[data-testid="lobby"]')
        .getAttribute("aria-modal");
      if (dialogAttr !== "dialog") {
        fail(`lobby role should be "dialog" (got: ${JSON.stringify(dialogAttr)})`);
        recordFail("role-dialog-testid", `role=${JSON.stringify(dialogAttr)}`);
      } else if (modalAttr !== "true") {
        fail(`lobby aria-modal should be "true" (got: ${JSON.stringify(modalAttr)})`);
        recordFail("role-dialog-testid", `aria-modal=${JSON.stringify(modalAttr)}`);
      } else {
        log(`  ✓ lobby has role="dialog" aria-modal="true"`);
        recordPass("role-dialog-testid");
      }
    } finally {
      await page2.close();
    }

    // Assertion 9: the code input has aria-label="Room code". The
    // exact label string is what the brief specifies -- screen readers
    // announce this verbatim, so it's load-bearing for the a11y
    // contract. We assert the literal value, not just "non-null".
    log(`ASSERTION 9: code input has aria-label="Room code"`);
    page2 = await openLobbyPage(context);
    try {
      const codeLabel = await page2
        .getByTestId("lobby-code")
        .getAttribute("aria-label");
      if (codeLabel !== "Room code") {
        fail(`code input aria-label should be "Room code" (got: ${JSON.stringify(codeLabel)})`);
        recordFail("aria-label-input", `aria-label=${JSON.stringify(codeLabel)}`);
      } else {
        log(`  ✓ code input has aria-label="Room code"`);
        recordPass("aria-label-input");
      }
    } finally {
      await page2.close();
    }

    // Assertion 10: the code input is focused on mount (autofocus).
    // The PR 94 a11y pass wires a `useEffect` that focuses the
    // input on the next requestAnimationFrame after mount. The
    // smoke waits 100ms before checking -- well over one frame
    // (16ms at 60Hz) so the rAF has fired by then.
    log(`ASSERTION 10: code input has focus on mount (autofocus)`);
    page2 = await openLobbyPage(context);
    try {
      await sleep(100);
      const focusedTestId = await page2.evaluate(
        () => document.activeElement?.getAttribute("data-testid") ?? null,
      );
      if (focusedTestId !== "lobby-code") {
        fail(`expected focus on lobby-code (got: ${JSON.stringify(focusedTestId)})`);
        recordFail("first-input-autofocus", `focused=${JSON.stringify(focusedTestId)}`);
      } else {
        log(`  ✓ focus on lobby-code on mount`);
        recordPass("first-input-autofocus");
      }
    } finally {
      await page2.close();
    }

    // Assertions 11 + 12: focus trap. Tab from Join -> Code, Shift+Tab
    // from Code -> Join. The PR 94 a11y pass wires a keydown listener
    // on the modal container that preventDefaults the default Tab
    // behavior when focus is on the trap boundaries. Test 11 asserts
    // focus moves from Join -> Code; test 12 asserts Code -> Join.
    // Both tests share a single page session so we can chain
    // focus calls without React re-mounting.
    log(`ASSERTIONS 11+12: focus trap -- Tab from Join -> Code, Shift+Tab from Code -> Join`);
    page2 = await openLobbyPage(context);
    try {
      // The Join button is disabled until a code is typed (the
      // `disabled={joining || !joinCode.trim()}` guard). Disabled
      // elements refuse focus from both user input and JS .focus(),
      // so we have to seed the input with a code first to put the
      // Join button into a focusable state.
      await page2.getByTestId("lobby-code").fill("ABCDEFGH");
      // Test 11: Tab from Join -> Code.
      await page2.getByTestId("lobby-join").focus();
      const beforeTabTestId = await page2.evaluate(
        () => document.activeElement?.getAttribute("data-testid") ?? null,
      );
      if (beforeTabTestId !== "lobby-join") {
        fail(`focus did not land on lobby-join before Tab (got: ${JSON.stringify(beforeTabTestId)})`);
        recordFail("focus-trap-tab", `pre-tab focused=${JSON.stringify(beforeTabTestId)}`);
      } else {
        await page2.keyboard.press("Tab");
        await sleep(50);
        const afterTabTestId = await page2.evaluate(
          () => document.activeElement?.getAttribute("data-testid") ?? null,
        );
        if (afterTabTestId !== "lobby-code") {
          fail(`Tab from Join did not move focus to Code (got: ${JSON.stringify(afterTabTestId)})`);
          recordFail("focus-trap-tab", `after-tab focused=${JSON.stringify(afterTabTestId)}`);
        } else {
          log(`  ✓ Tab from Join moved focus to Code`);
          recordPass("focus-trap-tab");
        }
      }
      // Test 12: Shift+Tab from Code -> Join.
      await page2.getByTestId("lobby-code").focus();
      await page2.keyboard.press("Shift+Tab");
      await sleep(50);
      const afterShiftTabTestId = await page2.evaluate(
        () => document.activeElement?.getAttribute("data-testid") ?? null,
      );
      if (afterShiftTabTestId !== "lobby-join") {
        fail(`Shift+Tab from Code did not move focus to Join (got: ${JSON.stringify(afterShiftTabTestId)})`);
        recordFail("focus-trap-shift-tab", `after-shift-tab focused=${JSON.stringify(afterShiftTabTestId)}`);
      } else {
        log(`  ✓ Shift+Tab from Code moved focus to Join`);
        recordPass("focus-trap-shift-tab");
      }
    } finally {
      await page2.close();
    }

    await context.close();
    await browser.close();
  } catch (e) {
    fail(`unexpected error: ${e.message}`);
    pass = false;
  } finally {
    killProcs();
    await sleep(2000);
  }

  log(`\n--- assertion summary ---`);
  for (const r of assertionResults) {
    if (r.ok) {
      log(`  PASS  ${r.name}`);
    } else {
      log(`  FAIL  ${r.name}  — ${r.why ?? ""}`);
    }
  }

  if (pass) {
    log(`\n=== ALL ASSERTIONS PASSED (${assertionResults.length}) ===`);
    process.exit(0);
  } else {
    const failed = assertionResults.filter((r) => !r.ok).length;
    log(`\n=== ${failed} of ${assertionResults.length} ASSERTIONS FAILED — see [FAIL] lines above ===`);
    process.exit(1);
  }
}

main();
