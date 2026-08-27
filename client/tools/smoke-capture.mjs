// Smoke harness utilities — capture browser console + server stderr +
// per-page DOM state into /tmp/smoke-{date}-{name}/. Used by every
// smoke from now on so the visuals line up with the data.
// Any smoke can import the helpers below (log/fail/sleep) directly.
// ...
// Usage:
//   import { attachSmokeCapture } from "./smoke-capture.mjs";
//   const cap = attachSmokeCapture(page, { label: "A", outDir });
//   ... do your smoke ...
//   await cap.writeArtifact();
// Artifacts:
//   - browser-console-A.log  (page.console log/warn/error captured live)
//   - dom-A.json             (snapshot of body.innerText + frame counter + HUD chip text)
//   - screenshot-A.png       (last frame before teardown)
// Plus the server-side log goes into /tmp/smoke-{date}-{name}/canary-stderr.log
// (captured by the boot helper).

import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { existsSync, statSync } from "node:fs";

// Shared log/fail/sleep helpers — any smoke can import these without
// going through the full attachSmokeCapture flow.
export function log(msg) {
  console.log(`[smoke] ${msg}`);
}
export function fail(msg) {
  console.error(`[smoke][FAIL] ${msg}`);
}
export function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

export function makeSmokeOutDir(label) {
  const date = new Date();
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const HH = String(date.getHours()).padStart(2, "0");
  const MM = String(date.getMinutes()).padStart(2, "0");
  const SS = String(date.getSeconds()).padStart(2, "0");
  const out = `/tmp/smoke-${yyyy}${mm}${dd}-${HH}${MM}${SS}-${label}`;
  mkdirSync(out, { recursive: true });
  return out;
}

// attachSmokeCapture wires page.on("console") + page.on("pageerror") +
// page.on("requestfailed") to a tee'd log file, AND captures a per-page
// DOM snapshot on demand. Returns an object with .writeArtifact().
//
// page:  Playwright Page
// opts:  { label: "A"|"B"|"host", outDir: "/tmp/..." }
export function attachSmokeCapture(page, opts) {
  const { label, outDir } = opts;
  const consolePath = `${outDir}/browser-console-${label}.log`;
  const errorsPath  = `${outDir}/browser-errors-${label}.log`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(consolePath, `[browser-console-${label}] capture started at ${new Date().toISOString()}\n`);

  // 1. console messages — capture all log/warn/error/info/debug/trace
  page.on("console", (msg) => {
    const ts = new Date().toISOString();
    const type = msg.type();
    const text = msg.text();
    const location = msg.location();
    appendFileSync(
      consolePath,
      `[${ts}] [${type}] ${text}  (${location.url || "?"}:${location.lineNumber || "?"})\n`,
    );
  });

  // 2. page errors (uncaught exceptions)
  page.on("pageerror", (err) => {
    const ts = new Date().toISOString();
    appendFileSync(errorsPath, `[${ts}] ${err.stack || err.message || String(err)}\n`);
  });

  // 3. failed requests (network-level errors that wouldn't surface as pageerror)
  page.on("requestfailed", (req) => {
    const ts = new Date().toISOString();
    appendFileSync(
      errorsPath,
      `[${ts}] requestfailed ${req.method()} ${req.url()} — ${req.failure()?.errorText || "?"}\n`,
    );
  });

  // snapshot the DOM at a point in time — captures HUD chip text + frame counter
  // + HP + ammo + body innerText fragment so we can compare visuals vs data.
  async function snapshotDom(tag) {
    const data = await page.evaluate(() => {
      const text = document.body.innerText || "";
      const m = (re) => text.match(re)?.[0] ?? null;
      return {
        title: document.title,
        url: window.location.href,
        hudChip: m(/Connected \(idle\)|Disconnected|Offline|connecting/i),
        frame: m(/frame[\s:]+(\d+)/i),
        hp: m(/HP\s+me[\s:]*(\d+\/\d+)/i),
        ammo: m(/ammo[\s:]*(\d+\/\d+)/i),
        bodySnippet: text.slice(0, 600),
        rendererHint: m(/webgl|webgpu/i),
        // __latestSnap may be available
        latestSnapFrame: window.__latestSnap?.()?.serverFrame ?? null,
        latestSnapPlayers: window.__latestSnap?.()?.players?.map(p => ({
          playerId: p.playerId, hp: p.hp, ammo: p.ammo, yaw: p.yaw, pitch: p.pitch,
        })) ?? null,
        transportConnected: window.__serverTransport?.connected ?? null,
      };
    });
    const domPath = `${outDir}/dom-${label}-${tag}.json`;
    writeFileSync(domPath, JSON.stringify(data, null, 2));
    return data;
  }

  // Final artifact dump: take a final DOM snapshot + screenshot.
  async function writeArtifact(tag = "final") {
    await snapshotDom(tag);
    await page.screenshot({ path: `${outDir}/screenshot-${label}-${tag}.png` });
  }

  return { snapshotDom, writeArtifact, outDir };
}

// captureServerStderr spawns a process and tee-d its stderr into a file
// at outDir/canary-stderr.log (or whatever the caller names).
// Returns the ChildProcess.
export async function spawnWithStderrCapture(cmd, args, opts, outDir, logName = "process") {
  const proc = await import("node:child_process").then(({ spawn }) =>
    spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] }),
  );
  mkdirSync(outDir, { recursive: true });
  const path = `${outDir}/${logName}-stderr.log`;
  // pre-create the file
  appendFileSync(path, `[${logName}-stderr] capture started at ${new Date().toISOString()}\n`);
  proc.stderr.on("data", (d) => appendFileSync(path, d));
  proc.stdout.on("data", (d) => appendFileSync(path, `[${logName}-stdout] ${d}`));
  return proc;
}
