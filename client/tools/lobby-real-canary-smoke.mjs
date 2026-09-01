#!/usr/bin/env node
// Real-canary lobby smoke — PR 94 follow-up.
//
// Difference from `lobby-smoke.mjs`: this smoke drives the lobby
// against a RUNNING canary's real matchmaker HTTP endpoints
// (POST /rooms, GET /rooms/<id>) WITHOUT any `page.route` stubs.
// Catches server/client drift where `matchmaker.rs`'s actual
// response shape diverges from what `matchmakerApi.ts` consumes.
//
// What it asserts (current PR 94 scope):
//   1. POST /rooms (real) returns 200 with {id, ws_url, wss_url, max_players}
//      and the id matches the regex [A-Za-z0-9_-]{1,64}.
//   2. The returned ws_url includes a non-default port (PR 94 fix).
//   3. GET /rooms/<id> (real) returns 404 with {exists:false} for a
//      freshly-created room that has NO connected tabs yet (server
//      does NOT pre-create rooms in the registry — lazy create on
//      first WS/WT connection per server/src/matchmaker.rs:218-223).
//   4. GET /rooms/<bogus> returns 404 with {exists:false} (same path).
//   5. The response shapes match the canned responses in `lobby-smoke.mjs`
//      (catches future drift between the page.route mocks and the
//      real canary — if this fails, both smokes need updating).
//
// What it does NOT cover (covered by lobby-smoke.mjs OR deferred to
// follow-up PRs):
//   - 18 UI-state assertions (focus trap, ARIA, busy text, etc.) —
//     covered by lobby-smoke.mjs with page.route stubs.
//   - Two-tab end-to-end WS connection through the lobby — REQUIRES
//     the Lobby.tsx Join path to be fixed (currently constructs the
//     ws_url from window.location.host which is Vite's port, not the
//     WS listener's port). Tracked as a follow-up — out of scope for
//     PR 94 (which was a11y + deferred Claude nits). Once fixed, this
//     smoke can re-add two-tab + full-room assertions.
//
// **Required env vars** (all default to the existing CI lobby-smoke values):
//   LOBBY_SMOKE_URL              (default http://127.0.0.1:5194/) — Vite URL
//   CANARY_SERVER_PORT_WT        (default 14433) — WebTransport UDP
//   CANARY_SERVER_PORT_WS        (default 14434) — WebSocket TCP
//   CANARY_SERVER_PORT_HTTP      (default 18080) — matchmaker HTTP
//   SMOKE_NO_BOOT=1              — skip canary/vite boot (use already-running)
//   SMOKE_PNG                    (default client/tools/lobby-real-canary-smoke.png)
//
// **Required teardown**: kill canary + vite on exit, even on failure.
// Matches `lobby-smoke.mjs`'s killProcs shape.

import { chromium } from "playwright";
import { spawn, execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

const URL_BASE = process.env.LOBBY_SMOKE_URL ?? "http://127.0.0.1:5194/";
const WT_PORT = Number(process.env.CANARY_SERVER_PORT_WT ?? 14433);
const WS_PORT = Number(process.env.CANARY_SERVER_PORT_WS ?? 14434);
const HTTP_PORT = Number(process.env.CANARY_SERVER_PORT_HTTP ?? 18080);
const VITE_PORT = 5194;
const SCREENSHOT = process.env.SMOKE_PNG ?? "client/tools/lobby-real-canary-smoke.png";

const NAV_TIMEOUT = Number(process.env.SMOKE_NAV_TIMEOUT ?? 30000);
const CONNECT_TIMEOUT_MS = Number(process.env.SMOKE_CONNECT_TIMEOUT_MS ?? 5000);

const SCREENSHOT_PATH = resolve(REPO_ROOT, SCREENSHOT);

const log = (...args) => console.log("[lobby-real-canary]", ...args);
const fail = (...args) => console.error("[lobby-real-canary][FAIL]", ...args);

mkdirSync(dirname(SCREENSHOT_PATH), { recursive: true });

let canaryProc = null;
let viteProc = null;
const results = [];
const recordPass = (name) => { results.push({ name, ok: true }); log(`  ✓ ${name}`); };
const recordFail = (name, why) => { results.push({ name, ok: false, why }); fail(`${name}: ${why}`); };

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
    { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CARGO_PROFILE: "debug" } }
  );
  canaryProc.stdout.on("data", (d) => process.stderr.write(`[canary] ${d}`));
  canaryProc.stderr.on("data", (d) => process.stderr.write(`[canary-err] ${d}`));
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (canaryProc.exitCode !== null) throw new Error(`canary exited with code ${canaryProc.exitCode}`);
    try {
      const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/health`);
      if (res.ok) { log(`Canary ready after ${i + 1}s`); return; }
    } catch (_) {}
  }
  throw new Error(`canary did not bind matchmaker HTTP ${HTTP_PORT} within 60s`);
}

async function bootVite() {
  log(`Booting Vite on port ${VITE_PORT}...`);
  viteProc = spawn(
    "npm",
    ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(VITE_PORT), "--strictPort"],
    { cwd: resolve(REPO_ROOT, "client"), stdio: ["ignore", "pipe", "pipe"], env: process.env }
  );
  viteProc.stdout.on("data", (d) => process.stderr.write(`[vite] ${d}`));
  viteProc.stderr.on("data", (d) => process.stderr.write(`[vite-err] ${d}`));
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (viteProc.exitCode !== null) throw new Error(`Vite exited with code ${viteProc.exitCode}`);
    try {
      const res = await fetch(`http://127.0.0.1:${VITE_PORT}/`);
      if (res.ok) { log(`Vite ready after ${i + 1}s`); return; }
    } catch (_) {}
  }
  throw new Error(`Vite did not bind port ${VITE_PORT} within 60s`);
}

function killProcs() {
  for (const proc of [canaryProc, viteProc]) {
    if (proc && proc.exitCode === null) {
      try { proc.kill("SIGTERM"); } catch (_) {}
    }
  }
  setTimeout(() => {
    for (const port of [WT_PORT, WS_PORT, HTTP_PORT, VITE_PORT]) {
      try {
        const out = execSync(`lsof -ti:${port} 2>/dev/null || true`, { encoding: "utf8" });
        const pids = out.trim().split("\n").filter(Boolean);
        for (const pid of pids) {
          try { process.kill(Number(pid), "SIGKILL"); } catch (_) {}
        }
      } catch (_) {}
    }
  }, 1000);
}

process.on("exit", killProcs);
process.on("SIGINT", () => { killProcs(); process.exit(130); });
process.on("SIGTERM", () => { killProcs(); process.exit(143); });

const CANARY_ORIGIN = `http://127.0.0.1:${HTTP_PORT}`;

// ============ ASSERTIONS ============

async function assert1_postRoomsShape() {
  log(`ASSERTION 1: POST ${CANARY_ORIGIN}/rooms returns valid {id, ws_url, wss_url, max_players}`);
  const res = await fetch(`${CANARY_ORIGIN}/rooms`, { method: "POST" });
  if (!res.ok) {
    recordFail("post-rooms-shape", `status=${res.status}`);
    return null;
  }
  const body = await res.json();
  const required = ["id", "ws_url", "wss_url", "max_players"];
  const missing = required.filter((k) => !(k in body));
  if (missing.length > 0) {
    recordFail("post-rooms-shape", `missing fields: ${missing.join(",")}`);
    return null;
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(body.id)) {
    recordFail("post-rooms-shape", `id "${body.id}" doesn't match [A-Za-z0-9_-]{1,64}`);
    return null;
  }
  if (typeof body.max_players !== "number" || body.max_players < 1) {
    recordFail("post-rooms-shape", `max_players not a positive number (got: ${body.max_players})`);
    return null;
  }
  if (!body.ws_url.startsWith("ws://") && !body.ws_url.startsWith("wss://")) {
    recordFail("post-rooms-shape", `ws_url must be ws:// or wss:// (got: ${body.ws_url})`);
    return null;
  }
  recordPass("post-rooms-shape");
  return body;
}

async function assert2_postRoomsWsUrlIncludesPort() {
  log(`ASSERTION 2: POST /rooms ws_url includes a non-default port (PR 94 fix)`);
  const res = await fetch(`${CANARY_ORIGIN}/rooms`, { method: "POST" });
  const body = await res.json();
  try {
    const url = new URL(body.ws_url);
    if (!url.port) {
      recordFail("post-rooms-ws-url-has-port", `ws_url missing port (got: ${body.ws_url}) — pre-#94 bug regression`);
      return;
    }
    recordPass("post-rooms-ws-url-has-port");
  } catch (e) {
    recordFail("post-rooms-ws-url-has-port", `invalid ws_url "${body.ws_url}": ${e.message}`);
  }
}

async function assert3_getRoomNotFoundForFreshRoom() {
  log(`ASSERTION 3: GET /rooms/<id> on freshly-created (no-tab) room returns 404 {exists:false}`);
  // The server does NOT pre-create rooms in the registry on POST /rooms
  // (per server/src/matchmaker.rs:218-223 — "we do NOT pre-create the
  // room. The room is created lazily on the first WS/WT connection").
  // So GET on a freshly-minted id returns 404 with {exists:false}.
  const create = await fetch(`${CANARY_ORIGIN}/rooms`, { method: "POST" });
  const created = await create.json();
  const res = await fetch(`${CANARY_ORIGIN}/rooms/${encodeURIComponent(created.id)}`);
  if (res.status !== 404) {
    recordFail("get-room-404-fresh", `expected 404 (no tab yet) (got: ${res.status})`);
    return;
  }
  const body = await res.json();
  if (body.exists !== false) {
    recordFail("get-room-404-fresh", `expected {exists:false} (got: ${JSON.stringify(body)})`);
    return;
  }
  recordPass("get-room-404-fresh");
}

async function assert4_bogusRoomReturns404WithExistsFalse() {
  log(`ASSERTION 4: GET /rooms/<bogus> returns 404 with body {exists:false}`);
  const res = await fetch(`${CANARY_ORIGIN}/rooms/NOPESMOKE123`);
  if (res.status !== 404) {
    recordFail("bogus-room-404", `expected status=404 (got: ${res.status})`);
    return;
  }
  const body = await res.json();
  if (body.exists !== false) {
    recordFail("bogus-room-404", `expected body {exists:false} (got: ${JSON.stringify(body)})`);
    return;
  }
  recordPass("bogus-room-404");
}

async function assert5_realCanaryMatchesSmokeMocksShape() {
  log(`ASSERTION 5: real canary response shape matches lobby-smoke.mjs page.route stub shape`);
  // The lobby-smoke.mjs uses these canned responses (PR #92 contract):
  //   createRoom → { id, ws_url, wss_url, max_players }
  //   getRoom 404 → { exists: false }
  // If this assertion fails, lobby-smoke.mjs and lobby-real-canary-smoke.mjs
  // have drifted — update both.
  const create = await fetch(`${CANARY_ORIGIN}/rooms`, { method: "POST" });
  const createBody = await create.json();
  const createKeys = Object.keys(createBody).sort();
  const expectedCreateKeys = ["id", "max_players", "wss_url", "ws_url"].sort();
  if (JSON.stringify(createKeys) !== JSON.stringify(expectedCreateKeys)) {
    recordFail("shape-matches-mocks", `create keys ${JSON.stringify(createKeys)} != expected ${JSON.stringify(expectedCreateKeys)}`);
    return;
  }
  const get = await fetch(`${CANARY_ORIGIN}/rooms/${encodeURIComponent(createBody.id)}`);
  if (get.status !== 404) {
    recordFail("shape-matches-mocks", `GET on freshly-created room should be 404 until tab connects (got: ${get.status})`);
    return;
  }
  const getBody = await get.json();
  if (getBody.exists !== false) {
    recordFail("shape-matches-mocks", `freshly-created room GET body should be {exists:false} (got: ${JSON.stringify(getBody)})`);
    return;
  }
  recordPass("shape-matches-mocks");
}

async function main() {
  log(`URL_BASE=${URL_BASE} CANARY=${CANARY_ORIGIN} WT=${WT_PORT} WS=${WS_PORT} HTTP=${HTTP_PORT}`);
  if (!process.env.SMOKE_NO_BOOT) {
    await bootCanary();
    await bootVite();
  } else {
    log("SMOKE_NO_BOOT=1 — assuming canary + vite already running");
  }

  try {
    await assert1_postRoomsShape();
    await assert2_postRoomsWsUrlIncludesPort();
    await assert3_getRoomNotFoundForFreshRoom();
    await assert4_bogusRoomReturns404WithExistsFalse();
    await assert5_realCanaryMatchesSmokeMocksShape();
  } finally {
    killProcs();
  }

  // Final summary
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
  killProcs();
  process.exit(2);
});
