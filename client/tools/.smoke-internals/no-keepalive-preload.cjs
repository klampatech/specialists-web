// Injected via NODE_OPTIONS=--require=... when the orchestrator spawns
// a canonical smoke. Disables HTTP/HTTPS default-agent keep-alive so
// the smoke does not leave a lingering ESTABLISHED socket on
// PROD_BUNDLE_PORT (24032/24132). Without this, the smoke's own
// killProcs() — which does `lsof -ti:PROD_BUNDLE_PORT | kill -9` —
// races against the smoke's own PID and SIGKILLs the smoke just as
// the smoke is about to call process.exit(0). Symptom: the
// orchestrator's stage exits with code=null signal=SIGKILL even
// though every assertion passed.
//
// This is a pure additive preload — it only flips default-agent
// keep-alive off. It does not change the smoke's logic, env, or
// argument forwarding (those remain the orchestrator's
// responsibility).
//
// We intentionally patch the https/http module-level agents here
// rather than monkey-patching https.request, because Node's
// https.request uses https.globalAgent by default and the smoke's
// httpsRequest({ ... }, cb) call does not pass an explicit agent.
// Flipping globalAgent.keepAlive = false before the smoke imports
// https is enough.
//
// Not loaded outside `node tools/smoke-orchestrator.mjs` runs —
// regular `vitest`, `vite build`, and `node tools/<smoke>.mjs`
// invocations do not set NODE_OPTIONS and are unaffected.

(function disableDefaultAgentKeepAlive() {
  try {
    const http = require("node:http");
    const https = require("node:https");
    if (http?.globalAgent) http.globalAgent.keepAlive = false;
    if (https?.globalAgent) https.globalAgent.keepAlive = false;
  } catch {
    // best-effort — failure to patch should never abort the smoke
  }
})();
