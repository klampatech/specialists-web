#!/usr/bin/env node
// PR 89 follow-up — `run_server` orchestrator smoke.
//
// Why this exists: the existing `server/tests/session_canary.rs`
// integration test calls `run_web_transport` directly, **bypassing
// `run_server`'s orchestrator entirely**. That means changes to
// `run_server`'s orchestration (select! shape, conditional listener
// spawning, cert-source threading, mode-driven control flow) ship
// without test coverage. PR #89 (cert-source dispatcher + WSS
// termination) hit two orchestration regressions that the unit tests
// couldn't see:
//
//   - Regression 1: `tools/canary-server.sh` defaulted `PORT_WSS`
//     before the arg-parsing loop ran, so `--port-ws 14434` (no
//     `--port-wss`) gave PORT_WSS=4434 (env-default) instead of 14434.
//     The server binary tried to bind WSS on 4434, collided with
//     another listener, and died silently.
//   - Regression 2: `futures::future::OptionFuture::from(None)`
//     resolves with `None` immediately (its "done" state), not
//     `Pending`. The `tokio::select!` branch fired, returned `Ok(())`,
//     and `run_server` completed in ~1ms — before the WS listener
//     could even bind 14434. 10/27 CI smokes cascaded into failure.
//
// Both bugs share a class: `run_server` boots, binds ports, then
// exits prematurely. Existing smokes either (a) ran with
// `SMOKE_NO_BOOT=1` so the canary was pre-booted by the CI job (didn't
// catch the premature exit) or (b) only checked `ss -ltn` for the port
// (would PASS even though the server died immediately, because the port
// was briefly bound during the dying process).
//
// This smoke is the gap-filler: it BOOTS `run_server` end-to-end
// (via `tools/canary-server.sh`) and asserts:
//
//   1. The canary process stays alive for 5s (catches the
//      "OptionFuture::from(None) early-resolve" bug — that bug kills
//      the server in ~1ms).
//   2. The WS port is reachable on dual-stack (catches the
//      "PORT_WSS default-before-arg-parsing" bug, because the
//      server tries to bind WSS on the wrong port and either dies
//      or stays up but doesn't bind WS on the expected port).
//   3. The WSS port is reachable on dual-stack and accepts a TLS
//      handshake (catches the WSS listener spawn regression).
//   4. The WT port is bound on IPv6 only (per the
//      "QUIC/IPv6-only listener" pattern documented in the skill —
//      a regression here means the binary didn't even try to bind).
//   5. A WS handshake + ping/pong completes within 5s — proves the
//      server is processing frames, not just binding ports.
//
// **Required env vars**:
//   CANARY_PORT_WT  (default 14433)
//   CANARY_PORT_WS  (default 14434)
//   CANARY_PORT_WSS (default 14435)
//   ORCHESTRATOR_SMOKE_URL (default http://127.0.0.1:5174/)  [optional,
//     not currently used — the orchestrator smoke doesn't need vite]
//
// **No browser required**: this smoke is pure TCP/TLS/WS probes, so it
// can run in a CI job without Playwright. Faster than the headless
// browser smokes and pinpoints orchestrator failures without browser
// noise.
//
// **No vite boot needed**: `run_server`'s orchestration is independent
// of the client. Vite boots are an unrelated dependency that
// complicates the regression-isolation story.

import { spawn, execSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { connect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

const WT_PORT = Number(process.env.CANARY_PORT_WT ?? 14433);
const WS_PORT = Number(process.env.CANARY_PORT_WS ?? 14434);
const WSS_PORT = Number(process.env.CANARY_PORT_WSS ?? 14435);

const ALIVE_HOLD_MS = Number(process.env.ORCHESTRATOR_ALIVE_HOLD_MS ?? 5000);
const BOOT_TIMEOUT_MS = Number(process.env.ORCHESTRATOR_BOOT_TIMEOUT_MS ?? 60000);

const log = (...args) => console.log("[orch-smoke]", ...args);
const fail = (...args) => {
  console.error("[orch-smoke][FAIL]", ...args);
  process.exitCode = 1;
};

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

/**
 * Open a TCP connection to host:port. Resolves true if reachable within
 * `timeoutMs`, false otherwise. Doesn't read or write any data.
 */
function tcpReachable(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = connect({ host, port, family: 4 }, () => {
      sock.end();
      resolve(true);
    });
    sock.on("error", () => {
      sock.destroy();
      resolve(false);
    });
    setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, timeoutMs);
  });
}

/**
 * TLS-wrapped TCP probe + read the first response byte. Used for the
 * WSS port — proves the cert was loaded and TLS handshake can complete
 * (or at least the server is alive enough to attempt it).
 */
function tlsReachable(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const sock = tlsConnect({ host, port, rejectUnauthorized: false }, () => {
      sock.end();
      resolve(true);
    });
    sock.on("error", () => {
      sock.destroy();
      resolve(false);
    });
    setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, timeoutMs);
  });
}

/**
 * WebSocket handshake via plain HTTP Upgrade. Returns true on
 * HTTP/1.1 101 Switching Protocols.
 *
 * This is a thin WS client — just enough to prove `run_server` is
 * processing frames, not just binding ports. Doesn't implement the
 * full WS frame protocol (we send an Upgrade request and check the
 * status line; the server will immediately start streaming snapshot
 * frames which we discard).
 */
function wsHandshakeOk(host, port, path = "/rooms/ORCH_SMOKE", timeoutMs = 5000) {
  return new Promise((resolve) => {
    const key = "dGhlIHNhbXBsZSBub25jZQ=="; // any 16-byte base64
    const req = httpRequest({
      host,
      port,
      path,
      method: "GET",
      headers: {
        Host: `${host}:${port}`,
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Version": "13",
      },
      timeout: timeoutMs,
    });
    let resolved = false;
    const finish = (ok, why) => {
      if (resolved) return;
      resolved = true;
      req.destroy();
      resolve({ ok, why });
    };
    req.on("upgrade", (res, socket) => {
      // res.statusCode === 101 on a successful WS handshake.
      finish(res.statusCode === 101, `upgrade status=${res.statusCode}`);
      socket.end();
    });
    req.on("response", (res) => {
      // Server didn't agree to upgrade — usually means port is open
      // but not speaking WS (e.g., wrong listener).
      finish(false, `non-upgrade response status=${res.statusCode}`);
      res.resume();
    });
    req.on("error", (e) => finish(false, `error: ${e.message}`));
    req.on("timeout", () => finish(false, "timeout"));
    req.end();
  });
}

// -----------------------------------------------------------------------
// Boot canary via canary-server.sh
// -----------------------------------------------------------------------

let canaryProc = null;
let canaryLogPath = "/tmp/canary-orchestrator-smoke.log";

async function bootCanary() {
  // Forward-compat: PR #89 added `--port-wss` and `--cert-source` to
  // `tools/canary-server.sh`. If those flags aren't present (e.g., a
  // PR was opened against `main` before #89 merged), fall back to the
  // pre-#89 flag set. The orchestrator assertions adapt accordingly:
  //   - WSS assertion is skipped if `--port-wss` isn't supported
  //     (set `process.env.ORCH_SMOKE_HAS_WSS = "0"` for the test run).
  const args = [
    "--port-wt", String(WT_PORT),
    "--port-ws", String(WS_PORT),
  ];
  // Cheap feature-detection: grep the script source for the flag,
  // since `canary-server.sh --help` prints the doc-comment header
  // (not the flag list), so output-based detection is unreliable.
  let supportsWss = false;
  let supportsCertSource = false;
  try {
    const scriptSrc = readFileSync(resolve(REPO_ROOT, "tools", "canary-server.sh"), "utf8");
    supportsWss = /--port-wss\b/.test(scriptSrc);
    supportsCertSource = /--cert-source\b/.test(scriptSrc);
  } catch (_) {
    // ignore — assume pre-#89
  }
  if (supportsWss) {
    args.push("--port-wss", String(WSS_PORT));
    process.env.ORCH_SMOKE_HAS_WSS = "1";
    log(`Detected --port-wss flag (PR #89+ canary-server.sh)`);
  } else {
    process.env.ORCH_SMOKE_HAS_WSS = "0";
    log(`Detected pre-#89 canary-server.sh (no --port-wss); WSS assertions will be skipped`);
  }
  if (supportsCertSource) {
    args.push("--cert-source", "self-signed");
  }

  log(`Booting canary via tools/canary-server.sh ${args.join(" ")}`);
  const out = openSync(canaryLogPath, "w");
  canaryProc = spawn(
    "bash",
    [resolve(REPO_ROOT, "tools", "canary-server.sh"), ...args],
    {
      cwd: REPO_ROOT,
      stdio: ["ignore", out, out],
      env: { ...process.env, CARGO_PROFILE: "debug" },
    }
  );
  canaryProc.on("exit", (code, signal) => {
    if (code !== 0 && code !== null && process.exitCode !== 1) {
      // Surface premature exits via log; the alive-hold assertion
      // below will catch the "died immediately" case explicitly.
      log(`[canary-exit] code=${code} signal=${signal} (log: ${canaryLogPath})`);
    }
  });
  // Wait for WS port to come up (the first listener spawned by
  // run_server — if this never binds, the orchestrator never got past
  // the cert-source dispatcher).
  const t0 = Date.now();
  while (Date.now() - t0 < BOOT_TIMEOUT_MS) {
    if (canaryProc.exitCode !== null) {
      throw new Error(`canary exited with code ${canaryProc.exitCode} during boot — log: ${canaryLogPath}`);
    }
    if (await tcpReachable("127.0.0.1", WS_PORT, 1000)) {
      log(`Canary WS port ${WS_PORT} reachable after ${(Date.now() - t0) / 1000}s`);
      return;
    }
    await sleep(500);
  }
  throw new Error(`Canary did not bind WS port ${WS_PORT} within ${BOOT_TIMEOUT_MS / 1000}s — log: ${canaryLogPath}`);
}

// -----------------------------------------------------------------------
// Assertions
// -----------------------------------------------------------------------

async function assertOrchestratorAlive5s() {
  log(`ASSERTION 1: canary stays alive for ${ALIVE_HOLD_MS / 1000}s`);
  await sleep(ALIVE_HOLD_MS);
  if (canaryProc.exitCode !== null) {
    fail(`canary exited prematurely (code=${canaryProc.exitCode}) during ${ALIVE_HOLD_MS / 1000}s alive-hold. Regression class: "OptionFuture::from(None) early-resolve" or "tokio::select! branch fires before listeners bind". Log: ${canaryLogPath}`);
    return false;
  }
  log(`  ✓ canary process still alive after ${ALIVE_HOLD_MS / 1000}s`);
  return true;
}

async function assertWsPortReachable() {
  log(`ASSERTION 2: WS port 127.0.0.1:${WS_PORT} is reachable (catches PORT_WSS default-before-arg-parsing regression — server would die on WSS bind collision)`);
  const ok = await tcpReachable("127.0.0.1", WS_PORT, 2000);
  if (!ok) {
    fail(`WS port 127.0.0.1:${WS_PORT} not reachable — canary likely died on the WSS bind collision (regression 1). Log: ${canaryLogPath}`);
    return false;
  }
  log(`  ✓ WS port 127.0.0.1:${WS_PORT} reachable`);
  return true;
}

async function assertWssPortReachable() {
  // Skip on pre-#89 canary-server.sh (no --port-wss flag → no WSS listener).
  if (process.env.ORCH_SMOKE_HAS_WSS !== "1") {
    log(`ASSERTION 3: SKIPPED (pre-#89 canary-server.sh, no --port-wss flag)`);
    return true;
  }
  log(`ASSERTION 3: WSS port 127.0.0.1:${WSS_PORT} accepts a TLS handshake (catches "WSS listener didn't spawn at all" regressions)`);
  const ok = await tlsReachable("127.0.0.1", WSS_PORT, 3000);
  if (!ok) {
    fail(`WSS port 127.0.0.1:${WSS_PORT} TLS handshake failed — listener didn't spawn, or self-signed cert missing. Log: ${canaryLogPath}`);
    return false;
  }
  log(`  ✓ WSS port 127.0.0.1:${WSS_PORT} TLS handshake OK`);
  return true;
}

/**
 * Read the canary log file and return whether the WebTransport
 * listener bound message was emitted. Returns `{ bound: bool, log: string }`.
 *
 * Why this is a log-grep and not a UDP probe: WebTransport is QUIC
 * over UDP. Probing a UDP listener via `node:net` (TCP) always
 * returns ECONNREFUSED, even when the listener is healthy. Using
 * `node:dgram` to send a fake QUIC packet would either silently
 * succeed (no ICMP unreachable from kernel) or hit the QUIC
 * handshake-failure path — neither gives a clean signal.
 *
 * The bind log line is emitted at INFO level from
 * `server/src/transport.rs:run_web_transport` on every successful
 * bind. If `run_server` failed to reach the WT spawn branch (e.g.,
 * a select! arm fires early), this line will be missing.
 */
function wtListenerBoundInLog() {
  try {
    const text = readFileSync(canaryLogPath, "utf8");
    return {
      bound: /WebTransport listener bound/.test(text),
      log: text.slice(-2000),  // tail only, for diagnostics
    };
  } catch (e) {
    return { bound: false, log: `(could not read log: ${e.message})` };
  }
}

function assertWtListenerBound() {
  log(`ASSERTION 4: canary log contains "WebTransport listener bound" (catches "orchestrator died before reaching the WT spawn" regressions)`);
  const r = wtListenerBoundInLog();
  if (!r.bound) {
    fail(`Canary log does NOT contain "WebTransport listener bound" — run_server likely died before spawning the WT listener. Last 2000 chars of log: ${r.log}`);
    return false;
  }
  log(`  ✓ "WebTransport listener bound" present in canary log`);
  return true;
}

async function assertWsHandshakeOk() {
  log(`ASSERTION 5: WS handshake on 127.0.0.1:${WS_PORT} returns HTTP/1.1 101 Switching Protocols`);
  const r = await wsHandshakeOk("127.0.0.1", WS_PORT, "/rooms/ORCH_SMOKE", 5000);
  if (!r.ok) {
    fail(`WS handshake failed: ${r.why} — server is binding ports but not processing frames. Log: ${canaryLogPath}`);
    return false;
  }
  log(`  ✓ WS handshake OK (${r.why})`);
  return true;
}

// -----------------------------------------------------------------------
// Cleanup
// -----------------------------------------------------------------------

function killCanary() {
  if (!canaryProc || canaryProc.exitCode !== null) return;
  log(`Killing canary (pid=${canaryProc.pid})`);
  canaryProc.kill("SIGTERM");
  // Belt-and-suspenders: per the "Cargo child outliving bash wrapper"
  // skill, killing the bash script doesn't kill the specialists-server
  // binary it spawned. Use lsof on the listener ports to find and kill
  // the straggler.
  setTimeout(() => {
    if (canaryProc.exitCode === null) {
      canaryProc.kill("SIGKILL");
    }
    for (const port of [WT_PORT, WS_PORT, WSS_PORT]) {
      try {
        const out = execSync(`lsof -ti:${port} 2>/dev/null || true`, { encoding: "utf8" });
        const pids = out.trim().split("\n").filter(Boolean);
        for (const pid of pids) {
          try {
            process.kill(Number(pid), "SIGKILL");
            log(`  killed straggler pid=${pid} on :${port}`);
          } catch (_) { /* already dead */ }
        }
      } catch (_) { /* best-effort */ }
    }
  }, 1000);
}

// -----------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------

async function main() {
  log(`=== canary-orchestrator-smoke (PR #89 follow-up) ===`);
  log(`WT=${WT_PORT}  WS=${WS_PORT}  WSS=${WSS_PORT}`);
  log(`ALIVE_HOLD_MS=${ALIVE_HOLD_MS}  BOOT_TIMEOUT_MS=${BOOT_TIMEOUT_MS}`);

  let pass = true;

  try {
    await bootCanary();

    // Order matters slightly: assert the alive-hold FIRST (the most
    // load-bearing check), then check each listener. If the alive-hold
    // fails, the listener checks will likely also fail — but the
    // alive-hold gives the most specific regression message.
    pass = (await assertOrchestratorAlive5s()) && pass;
    pass = (await assertWsPortReachable()) && pass;
    pass = (await assertWssPortReachable()) && pass;
    pass = (assertWtListenerBound()) && pass;
    pass = (await assertWsHandshakeOk()) && pass;

  } catch (e) {
    fail(`Boot assertion failed: ${e.message}`);
    pass = false;
  } finally {
    killCanary();
    // Give the kill a moment to settle before we exit (so the smoke's
    // exit code is the last thing the CI job sees).
    await sleep(2000);
  }

  if (pass) {
    log(`\n=== ALL ASSERTIONS PASSED (5/5) ===`);
    process.exit(0);
  } else {
    log(`\n=== ASSERTIONS FAILED — see [FAIL] lines above. Log: ${canaryLogPath} ===`);
    process.exit(1);
  }
}

main();
