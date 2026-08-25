// PR 11.7+ / AutoReconnect — kill helper used by smokes that need
// to SIGTERM / SIGKILL child processes (canary, vite, codex). Wraps
// platform-specific logic so the smoke scripts don't need to know
// about it.
//
// Returns a Promise that resolves once the process has exited (or
// after a 2s hard-kill timeout if it didn't respond to SIGTERM).

import process from "node:process";

const DEFAULT_KILL_TIMEOUT_MS = 2_000;

export async function killProcess(child, opts = {}) {
  if (!child || child.exitCode !== null) return;
  const { signal = "SIGTERM", timeoutMs = DEFAULT_KILL_TIMEOUT_MS } = opts;
  return new Promise((resolve) => {
    let resolved = false;
    const finalize = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };
    child.once("exit", finalize);
    try {
      if (process.platform === "win32") {
        // Windows: child.kill() doesn't reliably deliver signals; use
        // taskkill /T /F to kill the process tree (canary + vite are
        // bash wrappers that need their children killed too).
        try {
          const { spawn } = require("node:child_process");
          spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
          });
        } catch {
          /* swallow */
        }
      } else {
        child.kill(signal);
      }
    } catch {
      /* process might already be dead; ignore */
    }
    // Hard-kill fallback if the process ignores SIGTERM / takes too long
    const hardTimer = setTimeout(() => {
      if (child.exitCode === null) {
        try { child.kill("SIGKILL"); } catch { /* swallow */ }
      }
      finalize();
    }, timeoutMs);
    // Don't keep the event loop alive for the timer if everything
    // has already settled.
    if (hardTimer.unref) hardTimer.unref();
  });
}
