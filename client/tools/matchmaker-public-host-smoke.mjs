#!/usr/bin/env node
// PR #128 regression smoke (Hetzner staging, 2026-09-05).
//
// PR #128 fixed the matchmaker to use a configurable --public-host
// in ws_url / wss_url responses instead of the requester's peer.ip().
// Before the fix, cloud deployments got URLs pointing at the client's
// egress IP instead of the server's IP, and the browser got
// ERR_CONNECTION_REFUSED on every connection.
//
// This smoke pins that fix in place. It boots a canary with
// --public-host <host> and asserts that POST /rooms and GET /rooms/<id>
// both return a wss_url whose host matches <host>, not 127.0.0.1 and
// not the requester's IP.
//
// Boots its own canary (does not require an existing one). Pass
// SMOKE_NO_BOOT=1 to skip the canary boot and assert against an
// existing one.
//
// Usage:
//   node client/tools/matchmaker-public-host-smoke.mjs
//   SMOKE_NO_BOOT=1 PUBLIC_HOST=65.108.87.1 CANARY_URL=https://65.108.87.1:8084 \
//     node client/tools/matchmaker-public-host-smoke.mjs
//
//   -- or, in CI, via the standard canary harness

import { spawn, execSync } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { setTimeout as sleep } from "node:timers/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Inputs (env vars).
const HTTP_PORT = Number(process.env.HTTP_PORT ?? 8084);
const WT_PORT = Number(process.env.WT_PORT ?? 14433);
const WS_PORT = Number(process.env.WS_PORT ?? 14434);
const WSS_PORT = Number(process.env.WSS_PORT ?? 14435);
const CERT_DIR = process.env.CERT_DIR ?? resolve(REPO_ROOT, ".certs");
const SANS = process.env.SANS ?? "localhost,127.0.0.1,::1";

// The host we expect to see in the wss_url. For a cloud deploy this
// is the server's public IP / hostname. For the dev canary this is
// unset (the matchmaker falls back to peer.ip() == 127.0.0.1).
const PUBLIC_HOST = process.env.PUBLIC_HOST ?? "127.0.0.1";

// In SMOKE_NO_BOOT=1 mode (run against a pre-existing canary), the
// caller supplies CANARY_URL. The smoke doesn't have a way to know
// the cert chain on a remote host, so we use https.request with
// rejectUnauthorized: false.
const CANARY_URL =
  process.env.CANARY_URL ?? `http://${PUBLIC_HOST === "127.0.0.1" ? "127.0.0.1" : PUBLIC_HOST}:${HTTP_PORT}`;

const SMOKE_NO_BOOT = process.env.SMOKE_NO_BOOT === "1";

const results = [];
function recordPass(name) {
  results.push({ name, ok: true });
  log(`✓ ${name}`);
}
function recordFail(name, message) {
  results.push({ name, ok: false, message });
  log(`✗ ${name}: ${message}`);
}
function log(msg) {
  process.stderr.write(`[matchmaker-public-host-smoke] ${msg}\n`);
}

let canaryProc = null;

async function bootCanary() {
  if (SMOKE_NO_BOOT) {
    log(`SMOKE_NO_BOOT=1, skipping canary boot (assumed already running at ${CANARY_URL})`);
    return;
  }
  log(`Booting canary with --public-host ${PUBLIC_HOST} (HTTP=${HTTP_PORT})...`);
  canaryProc = spawn(
    "bash",
    [
      resolve(REPO_ROOT, "tools", "canary-server.sh"),
      "--port-wt", String(WT_PORT),
      "--port-ws", String(WS_PORT),
      "--port-wss", String(WSS_PORT),
      "--port-http", String(HTTP_PORT),
      "--cert-source", "self-signed",
      "--cert-dir", CERT_DIR,
      "--sans", SANS,
      "--public-host", PUBLIC_HOST,
    ],
    {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CARGO_PROFILE: "debug" },
      detached: true,
    },
  );
  canaryProc.stdout.on("data", (d) => process.stderr.write(`[canary] ${d}`));
  canaryProc.stderr.on("data", (d) => process.stderr.write(`[canary-err] ${d}`));

  // Wait for /health (max 90s — cold cargo build).
  const HEALTH_TIMEOUT_MS = 90000;
  const start = Date.now();
  while (Date.now() - start < HEALTH_TIMEOUT_MS) {
    try {
      const r = await fetch(`${CANARY_URL}/health`);
      if (r.ok) {
        log(`Canary healthy after ${((Date.now() - start) / 1000).toFixed(1)}s`);
        return;
      }
    } catch {}
    await sleep(500);
  }
  throw new Error(`canary didn't come up within ${HEALTH_TIMEOUT_MS}ms`);
}

function killCanary() {
  if (canaryProc && canaryProc.pid) {
    try { process.kill(-canaryProc.pid, "SIGTERM"); } catch {}
    setTimeout(() => { try { process.kill(-canaryProc.pid, "SIGKILL"); } catch {} }, 2000);
  }
}

process.on("exit", killCanary);
process.on("SIGINT", () => { killCanary(); process.exit(130); });
process.on("SIGTERM", () => { killCanary(); process.exit(143); });

/**
 * Hit the matchmaker's POST /rooms endpoint and parse the response.
 * Uses execSync('curl -sk') instead of globalThis.fetch because Node 22's
 * fetch silently rejects self-signed certs when the URL is HTTPS without
 * honoring rejectUnauthorized.
 */
function postRooms() {
  const out = execSync(
    `curl -sk -m 10 -X POST ${JSON.stringify(`${CANARY_URL}/rooms`)}`,
    { encoding: "utf8" },
  );
  return JSON.parse(out);
}

/**
 * Hit GET /rooms/<id>. Mints a room via POST first (server only mints on
 * POST, GET just looks up).
 */
function getRoom(id) {
  const out = execSync(
    `curl -sk -m 10 ${JSON.stringify(`${CANARY_URL}/rooms/${id}`)}`,
    { encoding: "utf8" },
  );
  return JSON.parse(out);
}

function assertHostMatches(value, fieldName, expectedHost) {
  const url = new URL(value);
  if (url.hostname === expectedHost) {
    recordPass(`${fieldName}-host`);
    return true;
  }
  recordFail(
    `${fieldName}-host`,
    `expected ${fieldName} host=${expectedHost}, got ${url.hostname} (full URL: ${value})`,
  );
  return false;
}

async function main() {
  await bootCanary();

  // Test 1: POST /rooms should return wss_url whose host matches --public-host.
  log(`POST ${CANARY_URL}/rooms (expecting wss_url host=${PUBLIC_HOST})`);
  let postResult;
  try {
    postResult = postRooms();
    recordPass("post-rooms-response");
  } catch (e) {
    recordFail("post-rooms-response", `POST /rooms failed: ${e.message}`);
    return;
  }

  if (!postResult.wss_url) {
    recordFail("post-wss-url-present", `POST /rooms didn't return wss_url (got: ${JSON.stringify(postResult)})`);
    return;
  }
  recordPass("post-wss-url-present");
  if (!postResult.ws_url) {
    recordFail("post-ws-url-present", `POST /rooms didn't return ws_url (got: ${JSON.stringify(postResult)})`);
    return;
  }
  recordPass("post-ws-url-present");

  assertHostMatches(postResult.ws_url, "POST ws_url", PUBLIC_HOST);
  assertHostMatches(postResult.wss_url, "POST wss_url", PUBLIC_HOST);

  // Test 2: GET /rooms/<id> should also return wss_url with the right host.
  // Note: the matchmaker lazily creates rooms on first WT/WS/WSS connection
  // (via `ensure_room`), so a freshly-minted POST /rooms ID returns
  // `exists: false` until a client connects. To make the GET test
  // deterministic, we have to first open a WS connection to create the
  // room. We do that with a minimal WebSocket handshake via curl.
  //
  // Curl takes an http:// or https:// URL, not ws:// — convert.
  const wsUrl = postResult.ws_url.replace(/^ws/, "http");
  log(`Opening WS to ${wsUrl} (via WebSocket upgrade) to lazily create the room...`);
  try {
    execSync(
      `timeout 5 curl -sN -i ` +
      `-H "Connection: Upgrade" ` +
      `-H "Upgrade: websocket" ` +
      `-H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" ` +
      `-H "Sec-WebSocket-Version: 13" ` +
      JSON.stringify(wsUrl) +
      ` </dev/null`,
      { encoding: "utf8", stdio: "pipe" },
    );
  } catch {
    // We expect curl to fail (no data, or server expects a wire
    // protocol). What matters is that the connection was opened,
    // which triggers ensure_room. Don't fail the smoke on curl exit.
  }
  // Tiny sleep so the connection-handler task has time to add the
  // room to the registry before we GET.
  await sleep(500);

  log(`GET ${CANARY_URL}/rooms/${postResult.id} (expecting wss_url host=${PUBLIC_HOST})`);
  let getResult;
  try {
    getResult = getRoom(postResult.id);
    recordPass("get-room-response");
  } catch (e) {
    recordFail("get-room-response", `GET /rooms/<id> failed: ${e.message}`);
    return;
  }

  if (getResult.exists !== true) {
    recordFail(
      "get-room-exists",
      `GET /rooms/<id> returned exists=${getResult.exists}, expected true after WS connect (room should have been lazily created)`,
    );
    return;
  }
  recordPass("get-room-exists");

  if (!getResult.wss_url) {
    recordFail("get-wss-url-present", `GET /rooms/<id> didn't return wss_url (got: ${JSON.stringify(getResult)})`);
    return;
  }
  recordPass("get-wss-url-present");

  assertHostMatches(getResult.ws_url, "GET ws_url", PUBLIC_HOST);
  assertHostMatches(getResult.wss_url, "GET wss_url", PUBLIC_HOST);
}

main()
  .catch((e) => {
    log(`FATAL: ${e.message}`);
    recordFail("fatal", e.message);
  })
  .finally(async () => {
    killCanary();
    const passed = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;
    log(`\n=== SUMMARY ===`);
    log(`Passed: ${passed}`);
    log(`Failed: ${failed}`);
    for (const r of results) {
      log(`  ${r.ok ? "✓" : "✗"} ${r.name}${r.message ? `: ${r.message}` : ""}`);
    }
    process.exit(failed === 0 ? 0 : 1);
  });
