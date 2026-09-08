#!/usr/bin/env node
// PR-4 follow-up — single-command local smoke orchestrator.
//
// Purpose: one developer command (`npm run smoke` from client/) to
// run the two load-bearing canonical smokes against a freshly built
// prod bundle and a local canary, with correct cleanup and nonzero
// exit on failure.
//
// Canonical smokes orchestrated (unchanged):
//   1. tools/two-tab-prod-bundle-damage-smoke.mjs
//      — proves the PRODUCTION BUNDLE's __gameSession receives an
//        AimEvent and HP converges in TWO tabs.
//   2. tools/fe-server-sync-matrix.mjs
//      — proves snapshot fields, position, HP, weapon state, frame
//        advancement, and RTT all converge in the PRODUCTION BUNDLE.
//
// Why isolated port bundles per stage:
//   The two canonical smokes each spawn canary + static server in
//   their own detached process groups. Running them back-to-back on
//   the same ports risks teardown races (the canonical smoke's
//   killProcs() runs in the finally block and uses `kill -9` via
//   execSync, but a smoke that crashes mid-execution skips its
//   teardown). Isolating ports per stage makes stage 1's leaked
//   canary/static irrelevant to stage 2.
//
// Why one build:
//   The prod bundle is hardcoded with VITE_MATCHMAKER_ORIGIN at
//   build time (client/src/ui/Lobby.tsx imports `import.meta.env.
//   VITE_MATCHMAKER_ORIGIN`). Both canonical smokes bypass the
//   lobby via `?server=<wss_url>` (PeerOverlay picks the flag up
//   at module load and connects directly), so the bundle's match-
//   maker origin is irrelevant to the smoke flow — but a stale
//   build with the wrong origin would still be a hazard. We pin
//   VITE_MATCHMAKER_ORIGIN to http://127.0.0.1:28080 so a fresh
//   checkout never inherits the dead m5 Funnel default (skill
//   pitfall: the prod build silently points at a dead host when
//   the env var is omitted).
//
// Why --no-boot exists:
//   For debugging against an already-running deploy (e.g., Hetzner
//   staging). The user is responsible for the canary/static life-
//   cycle in that mode — the canonical smoke's killProcs() still
//   runs even when SMOKE_NO_BOOT=1, so running both stages under
//   --no-boot against a single shared canary/static will kill the
//   shared processes after stage 1. Use --no-boot only when you're
//   OK with that, or boot two canary/static pairs manually on the
//   per-stage ports.
//
// What this orchestrator deliberately does NOT do:
//   - Reimplement the canonical smokes
//   - Modify the canonical smokes
//   - Touch CI (.github/workflows/ci.yml)
//   - Add a new test framework

import { execFileSync, spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(CLIENT_ROOT, "..");

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const HELP = `Usage: node tools/smoke-orchestrator.mjs [--no-build] [--no-boot]

Runs the two load-bearing local smokes against a freshly built
prod bundle on isolated ports. Build is skipped with --no-build;
canary + serve-static boot is skipped with --no-boot (use only when
the user has already booted a canary + static server reachable on
the dedicated ports — the orchestrator does NOT own their lifecycle
in --no-boot mode).

Options:
  --no-build  Skip the client build (use existing client/dist/)
  --no-boot   Use already-running canary + static server
  --help      Show this help and exit

Exit codes:
  0  build + both smokes passed
  1  build or any smoke failed (Stage 2 not launched on Stage 1 fail)
  2  usage / environment error (unknown flag, missing tool, etc.)

Per-stage port overrides (defaults shown in DEFAULT_PORTS):
  SMOKE_DAMAGE_BUNDLE_PORT / SMOKE_DAMAGE_WT_PORT / SMOKE_DAMAGE_WS_PORT
  SMOKE_DAMAGE_WSS_PORT    / SMOKE_DAMAGE_HTTP_PORT
  SMOKE_MATRIX_BUNDLE_PORT / SMOKE_MATRIX_WT_PORT / SMOKE_MATRIX_WS_PORT
  SMOKE_MATRIX_WSS_PORT    / SMOKE_MATRIX_HTTP_PORT

Environment:
  VITE_MATCHMAKER_ORIGIN   Build-time matchmaker origin (default
                            http://127.0.0.1:28080). Skill pitfall:
                            the prod build silently points at a
                            dead m5 Funnel host when this is unset.
`;

const KNOWN_FLAGS = new Set(["--no-build", "--no-boot", "--help", "-h"]);

function parseArgs(argv) {
  const out = { noBuild: false, noBoot: false, help: false, unknown: [] };
  for (const a of argv) {
    if (a === "--no-build") out.noBuild = true;
    else if (a === "--no-boot") out.noBoot = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else out.unknown.push(a);
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (opts.unknown.length > 0) {
  console.error(`[smoke] unknown flag(s): ${opts.unknown.join(" ")}`);
  console.error(`Run with --help for usage.`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Per-stage port bundles
// ---------------------------------------------------------------------------

// Defaults match the canonical smokes' own defaults — Stage 1 uses the
// two-tab-prod-bundle-damage-smoke defaults, Stage 2 uses a parallel-but-
// distinct bundle so stage 1's leaked canary/static (if any) cannot collide
// with stage 2's boot.
const DEFAULT_DAMAGE_PORTS = {
  PROD_BUNDLE_PORT: 24032,
  WT_PORT: 24033,
  WS_PORT: 24034,
  WSS_PORT: 24035,
  HTTP_PORT: 28080,
};
const DEFAULT_MATRIX_PORTS = {
  PROD_BUNDLE_PORT: 24132,
  WT_PORT: 24133,
  WS_PORT: 24134,
  WSS_PORT: 24135,
  HTTP_PORT: 28180,
};

function readPorts(prefix, defaults) {
  return {
    PROD_BUNDLE_PORT: Number(process.env[`SMOKE_${prefix}_BUNDLE_PORT`] ?? defaults.PROD_BUNDLE_PORT),
    WT_PORT: Number(process.env[`SMOKE_${prefix}_WT_PORT`] ?? defaults.WT_PORT),
    WS_PORT: Number(process.env[`SMOKE_${prefix}_WS_PORT`] ?? defaults.WS_PORT),
    WSS_PORT: Number(process.env[`SMOKE_${prefix}_WSS_PORT`] ?? defaults.WSS_PORT),
    HTTP_PORT: Number(process.env[`SMOKE_${prefix}_HTTP_PORT`] ?? defaults.HTTP_PORT),
  };
}

// Per-stage screenshot paths so Stage 1 and Stage 2 don't clobber each
// other's failure artifacts.
const TOOLS_DIR = resolve(CLIENT_ROOT, "tools");

// Path to a tiny CJS preload that disables the default `http` /
// `https` agent's keep-alive flag in the spawned smoke's process.
// The canonical smokes boot the serve-static TLS listener and then
// httpsRequest() it for a /health probe. Node 19+ defaults the
// globalAgent to keepAlive=true, which leaves an ESTABLISHED
// socket on PROD_BUNDLE_PORT owned by the smoke's PID. The smoke's
// own killProcs() then runs `lsof -ti:PROD_BUNDLE_PORT | kill -9`
// and SIGKILLs the smoke itself just as it would otherwise exit 0
// (orchestrator stage exit: code=null, signal=SIGKILL). Flipping
// globalAgent.keepAlive=false before any user code runs removes
// the smoke-owned ESTABLISHED socket from lsof's view and the race
// resolves cleanly. See
// client/tools/.smoke-internals/no-keepalive-preload.cjs for the
// 7-line patch.
const NO_KEEPALIVE_PRELOAD = resolve(TOOLS_DIR, ".smoke-internals/no-keepalive-preload.cjs");
const DAMAGE_PNG_A = process.env.SMOKE_DAMAGE_PNG_A ?? resolve(TOOLS_DIR, "smoke-orchestrator-damage-A.png");
const DAMAGE_PNG_B = process.env.SMOKE_DAMAGE_PNG_B ?? resolve(TOOLS_DIR, "smoke-orchestrator-damage-B.png");
const MATRIX_PNG_A = process.env.SMOKE_MATRIX_PNG_A ?? resolve(TOOLS_DIR, "smoke-orchestrator-matrix-A.png");
const MATRIX_PNG_B = process.env.SMOKE_MATRIX_PNG_B ?? resolve(TOOLS_DIR, "smoke-orchestrator-matrix-B.png");

// VITE_MATCHMAKER_ORIGIN must be set at build time so the prod bundle
// never falls back to the dead m5 Funnel host. The default below points
// at Stage 1's HTTP port — Stage 2 bypasses the lobby via ?server=<wss_url>
// so its HTTP port can differ (the bundle's matchmaker origin is unused
// during the smoke flow).
const MATCHMAKER_ORIGIN = process.env.VITE_MATCHMAKER_ORIGIN ?? "http://127.0.0.1:28080";

const log = (...a) => console.error("[smoke]", ...a);

// ---------------------------------------------------------------------------
// Tooling checks
// ---------------------------------------------------------------------------

function ensureTooling() {
  for (const tool of ["node", "npm", "curl", "lsof"]) {
    try {
      execFileSync("bash", ["-c", `command -v ${tool}`], { stdio: "pipe" });
    } catch {
      console.error(`[smoke] FATAL: required tool missing on PATH: ${tool}`);
      process.exit(2);
    }
  }
  const distDir = resolve(CLIENT_ROOT, "dist");
  if (!existsSync(distDir)) {
    console.error(`[smoke] FATAL: client/dist/ missing — run without --no-build, or run \`npm run build\` first.`);
    process.exit(2);
  }
  const damage = resolve(CLIENT_ROOT, "tools/two-tab-prod-bundle-damage-smoke.mjs");
  const matrix = resolve(CLIENT_ROOT, "tools/fe-server-sync-matrix.mjs");
  for (const p of [damage, matrix]) {
    if (!existsSync(p)) {
      console.error(`[smoke] FATAL: canonical smoke missing: ${p}`);
      process.exit(2);
    }
  }
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function buildBundle() {
  log(`Building prod bundle (VITE_MATCHMAKER_ORIGIN=${MATCHMAKER_ORIGIN})...`);
  execFileSync("npm", ["run", "build"], {
    cwd: CLIENT_ROOT,
    stdio: "inherit",
    env: { ...process.env, VITE_MATCHMAKER_ORIGIN: MATCHMAKER_ORIGIN },
  });
}

// ---------------------------------------------------------------------------
// Stage runner
// ---------------------------------------------------------------------------

// Run one canonical smoke with the supplied env. Returns the stage's
// exit code (0 = pass, non-zero = fail). On failure, the orchestrator
// kills the stage's detached process group as a safety net and the
// caller (main) is expected to abort before launching the next stage.
function runStage({ label, scriptRelPath, ports, pngA, pngB }) {
  const scriptPath = resolve(CLIENT_ROOT, scriptRelPath);
  const env = {
    ...process.env,
    SMOKE_NO_BUILD: "1",
    SMOKE_NO_BOOT: opts.noBoot ? "1" : "0",
    PROD_BUNDLE_HOST: "127.0.0.1",
    PROD_BUNDLE_SCHEME: "https",
    CANARY_HOST: "127.0.0.1",
    CANARY_SCHEME: "http",
    PROD_BUNDLE_PORT: String(ports.PROD_BUNDLE_PORT),
    WT_PORT: String(ports.WT_PORT),
    WS_PORT: String(ports.WS_PORT),
    WSS_PORT: String(ports.WSS_PORT),
    HTTP_PORT: String(ports.HTTP_PORT),
    SMOKE_PNG_A: pngA,
    SMOKE_PNG_B: pngB,
    // Keep the bundle's baked origin consistent with whichever HTTP port
    // the canary actually listens on. This is belt-and-suspenders — the
    // smoke flow bypasses the lobby — but a future change that routes
    // through Lobby.tsx won't silently point at the wrong host.
    VITE_MATCHMAKER_ORIGIN: `http://127.0.0.1:${ports.HTTP_PORT}`,
    // NODE_OPTIONS preload: disable default-agent keep-alive in the
    // child so its `lsof -ti:PROD_BUNDLE_PORT` cleanup does not
    // SIGKILL the smoke itself. See the NO_KEEPALIVE_PRELOAD
    // declaration above for the full explanation.
    NODE_OPTIONS: `--require=${NO_KEEPALIVE_PRELOAD}`,
  };

  log(`Spawning ${label} (node ${scriptRelPath}) on ports ${JSON.stringify(ports)}...`);
  const start = Date.now();
  const child = spawn("node", [scriptPath], {
    cwd: CLIENT_ROOT,
    env,
    stdio: "inherit",
    detached: true, // see PR-4 §B — process group separation
  });
  activeChild = child;

  return new Promise((resolveP) => {
    let resolved = false;
    const finish = (code) => {
      if (resolved) return;
      resolved = true;
      activeChild = null;
      const dur = ((Date.now() - start) / 1000).toFixed(1);
      if (code === 0) {
        log(`PASS ${label} (${dur}s)`);
        resolveP({ ok: true, code: 0, dur, pid: child.pid });
      } else {
        killProcessGroup(child.pid, `${label} (exit ${code})`);
        log(`FAILED ${label} (exit ${code}, ${dur}s)`);
        resolveP({ ok: false, code, dur, pid: child.pid });
      }
    };
    child.on("exit", (code, signal) => {
      // signal = terminated by us (safety net). Treat as failure.
      finish(signal ? 1 : (code ?? 1));
    });
    child.on("error", (err) => {
      log(`spawn error: ${err.message}`);
      finish(1);
    });
  });
}

// Safety net: SIGTERM the entire stage process group, wait 1s, then
// SIGKILL anything left. Mirrors the canonical smokes' killProcs()
// shape but targets ONLY the process group we spawned (no `kill -9` on
// pids we don't own — see PR-4 §E pitfall).
function killProcessGroup(pgid, reason) {
  if (!pgid) return;
  log(`safety-net kill of process group ${pgid} (${reason})`);
  try { process.kill(-pgid, "SIGTERM"); } catch {}
  setTimeout(() => {
    try { process.kill(-pgid, "SIGKILL"); } catch {}
  }, 1000);
}

// ---------------------------------------------------------------------------
// Final safety-net cleanup
// ---------------------------------------------------------------------------

// After all stages, SIGTERM the orchestrator's own process groups
// (each smoke's PG, identified by its child PID) and escalate to
// SIGKILL after 1s. We deliberately do NOT lsof + kill on the
// dedicated ports here — per PR-4 §E pitfall, the orchestrator must
// only kill process groups it spawned. Canary/static leak cleanup
// is the canonical smoke's responsibility (killProcs() in the
// finally block); this is a belt-and-suspenders net for the case
// where the orchestrator itself was about to exit while a stage's
// process group was still alive.
async function safetyNetCleanup(childPids) {
  const pids = childPids.filter(Boolean);
  if (pids.length === 0) return;
  log(`safety-net cleanup: SIGTERM process groups ${pids.join(", ")}`);
  for (const pid of pids) {
    try { process.kill(-pid, "SIGTERM"); } catch {}
  }
  await new Promise((r) => setTimeout(r, 1000));
  for (const pid of pids) {
    try { process.kill(-pid, "SIGKILL"); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  ensureTooling();

  // Per-stage port bundles. When --no-boot, both stages target the same
  // ports (the user has booted a shared canary/static). When the default
  // path (each stage boots its own), Stage 1 uses DAMAGE_PORTS and Stage
  // 2 uses MATRIX_PORTS — distinct bundles so Stage 1's leaked canary
  // cannot collide with Stage 2's boot.
  const damagePorts = readPorts("DAMAGE", DEFAULT_DAMAGE_PORTS);
  const matrixPorts = opts.noBoot
    ? readPorts("MATRIX", damagePorts) // shared with stage 1 in --no-boot
    : readPorts("MATRIX", DEFAULT_MATRIX_PORTS);

  // 1. Build once (unless --no-build).
  if (opts.noBuild) {
    log("--no-build: using existing client/dist/");
  } else {
    buildBundle();
  }

  // 2. Stage 1 — two-tab prod bundle damage.
  const stage1Label = "Stage 1/2 — two-tab prod bundle damage";
  log("");
  log("=".repeat(60));
  log(`[smoke] ${stage1Label}`);
  log("=".repeat(60));
  const stage1 = await runStage({
    label: stage1Label,
    scriptRelPath: "tools/two-tab-prod-bundle-damage-smoke.mjs",
    ports: damagePorts,
    pngA: DAMAGE_PNG_A,
    pngB: DAMAGE_PNG_B,
  });
  if (!stage1.ok) {
    // Fail-fast: do NOT launch Stage 2.
    await safetyNetCleanup([stage1.pid]);
    log(`orchestrator exiting 1 (Stage 1 failed, Stage 2 not launched)`);
    process.exit(1);
  }

  // 3. Stage 2 — FE/server sync matrix.
  const stage2Label = "Stage 2/2 — FE/server sync matrix";
  log("");
  log("=".repeat(60));
  log(`[smoke] ${stage2Label}`);
  log("=".repeat(60));
  const stage2 = await runStage({
    label: stage2Label,
    scriptRelPath: "tools/fe-server-sync-matrix.mjs",
    ports: matrixPorts,
    pngA: MATRIX_PNG_A,
    pngB: MATRIX_PNG_B,
  });

  // 4. Final safety-net cleanup.
  await safetyNetCleanup([stage1.pid, stage2.pid]);

  if (!stage2.ok) {
    log(`orchestrator exiting 1 (Stage 2 failed)`);
    process.exit(1);
  }
  log("");
  log("ALL SMOKE STAGES PASSED");
  process.exit(0);
}

// Honor Ctrl+C by killing the active stage's process group. The
// detached child is in its own process group, so without this hook
// Ctrl+C would only kill the orchestrator and orphan the canary +
// static servers.
let activeChild = null;
process.on("SIGINT", () => {
  if (activeChild && activeChild.pid) {
    try { process.kill(-activeChild.pid, "SIGTERM"); } catch {}
    setTimeout(() => {
      try { process.kill(-activeChild.pid, "SIGKILL"); } catch {}
      process.exit(130);
    }, 1000);
  } else {
    process.exit(130);
  }
});

main().catch((e) => {
  console.error(`[smoke] FATAL: ${e.stack ?? e.message ?? e}`);
  process.exit(1);
});
