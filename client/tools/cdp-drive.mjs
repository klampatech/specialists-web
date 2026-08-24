// Direct CDP driver — bypasses Playwright. Connects to a specific
// target's WebSocket URL (each tab has its own). This avoids the
// session/routing complexity of the browser-level wsEndpoint.

import WebSocket from "ws";

const NAV_URL = "http://100.95.111.112:5174/?server=ws://100.95.111.112:14434/rooms/DEVBX&localId=1&peerId=2";

class CDPSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`CDP ${msg.method}: ${msg.error.message}`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const cb of this.events) cb(msg.method, msg.params);
      }
    });
  }
  send(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params ?? {} }));
    });
  }
  on(cb) { this.events.push(cb); }
}

async function main() {
  // Get list of targets
  const targets = await fetch("http://localhost:9223/json/list").then(r => r.json());
  const pageTargets = targets.filter(t => t.type === "page");
  console.log(`Found ${pageTargets.length} page targets`);

  // Prefer a fresh target or create one via a tab
  let target = pageTargets.find(t => t.url === "about:blank") || pageTargets[0];

  if (!target) {
    console.log("No page target available — opening one via /json/new");
    const newTarget = await fetch("http://localhost:9223/json/new?" + encodeURIComponent("about:blank"), {
      method: "PUT",
    }).then(r => r.json());
    target = newTarget;
  }

  console.log("Using target:", target.url.slice(0, 80), target.title);
  console.log("WebSocket:", target.webSocketDebuggerUrl);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  const cdp = new CDPSession(ws);

  // Capture events
  cdp.on((method, params) => {
    if (method === "Network.webSocketCreated") {
      console.log(`[WS-CREATED] ${params.url} initator=${params.initiator?.type ?? "?"}`);
    } else if (method === "Network.webSocketHandshakeResponseReceived") {
      console.log(`[WS-HANDSHAKE-RESP] status=${params.response.status} ${params.response.statusText} headers=${JSON.stringify(params.response.headers).slice(0, 200)}`);
    } else if (method === "Network.webSocketClosed") {
      console.log(`[WS-CLOSED] ${JSON.stringify(params).slice(0, 200)}`);
    } else if (method === "Network.webSocketFrameError") {
      console.log(`[WS-FRAME-ERR] ${JSON.stringify(params).slice(0, 300)}`);
    } else if (method === "Network.webSocketFrameSent") {
      const p = params.response.payloadData;
      console.log(`[WS-FRAME-OUT] ${(p ?? "").toString().slice(0, 100)}`);
    } else if (method === "Network.webSocketFrameReceived") {
      const p = params.response.payloadData;
      console.log(`[WS-FRAME-IN] ${(p ?? "").toString().slice(0, 100)}`);
    } else if (method === "Network.loadingFailed") {
      console.log(`[NET-FAIL] ${params.errorText} ${params.blockedReason ?? ""} ${params.request?.url ?? params.requestId}`);
    } else if (method === "Network.responseReceived") {
      const r = params.response;
      if (r.url.includes("100.95.111.112") || r.url.includes("m5.tail1b3795")) {
        console.log(`[NET-RESP] ${r.status} ${r.url}`);
      }
    } else if (method === "Console.messageAdded") {
      const m = params.message;
      console.log(`[CONSOLE-${m.level}] ${m.text.slice(0, 200)}`);
    } else if (method === "Runtime.consoleAPICalled") {
      const args = (params.args ?? []).map(a => a.value ?? a.description ?? "?").join(" ");
      console.log(`[JS-${params.type}] ${args.slice(0, 200)}`);
    } else if (method === "Runtime.exceptionThrown") {
      console.log(`[JS-EXC] ${params.exceptionDetails.text} @ ${params.exceptionDetails.url}:${params.exceptionDetails.lineNumber}`);
    } else if (method === "Log.entryAdded") {
      const e = params.entry;
      console.log(`[LOG-${e.level}] ${e.source ?? ""} ${e.text.slice(0, 200)}`);
    }
  });

  // Enable event domains — try one at a time
  for (const m of ["Runtime.enable", "Page.enable", "Network.enable", "Log.enable"]) {
    try {
      await cdp.send(m);
      console.log(`[ok] ${m}`);
    } catch (e) {
      console.log(`[fail] ${m}: ${e.message}`);
    }
  }

  // Capture raw network request info via getRequestPostData-style approach.
  // We use Network.requestWillBeSent + getRequestHeaders-style via interception.
  cdp.on((method, params) => {
    if (method === "Network.requestWillBeSent") {
      const r = params.request;
      if (r.url.includes(":14434") || r.url.includes(":14433")) {
        console.log(`[REQ] ${r.method} ${r.url}`);
        if (r.headers) {
          for (const [k, v] of Object.entries(r.headers)) {
            console.log(`  ${k}: ${v}`);
          }
        }
      }
    }
  });

  // Enable network interception for the canary ports so we can
  // capture the actual WS request headers. This intercepts the
  // raw HTTP request Chrome sends before it gets a WS upgrade.
  try {
    await cdp.send("Network.setRequestInterception", {
      patterns: [
        { urlPattern: "ws://*", resourceType: "WebSocket" },
      ],
    });
    console.log("[ok] Network interception enabled");
  } catch (e) {
    console.log(`[fail] interception: ${e.message}`);
  }

  // When the request is intercepted, capture them
  cdp.on((method, params) => {
    if (method === "Network.requestIntercepted") {
      const r = params.request;
      if (r.url.includes(":14434") || r.url.includes(":14433")) {
        console.log(`[INTERCEPTED] ${r.method} ${r.url}`);
        if (r.headers) {
          for (const [k, v] of Object.entries(r.headers)) {
            console.log(`  ${k}: ${v}`);
          }
        }
      }
      // Pass through
      cdp.send("Network.continueInterceptedRequest", {
        interceptionId: params.interceptionId,
      }).catch(() => {});
    }
  });

  // Navigate
  console.log(`\n=== Navigating to ${NAV_URL.slice(0, 80)}… ===`);
  try {
    await cdp.send("Page.navigate", { url: NAV_URL });
    console.log("navigated");
  } catch (e) {
    console.log(`navigation failed: ${e.message}`);
  }

  // Wait for connect attempts
  await new Promise(r => setTimeout(r, 8000));

  // Read state
  try {
    const evalResult = await cdp.send("Runtime.evaluate", {
      expression: `JSON.stringify({
        forceTransport: window.__forceServerTransport,
        hasST: !!window.__serverTransport,
        connected: window.__serverTransport?.connected,
        kind: window.__serverTransport?.activeKind,
        rtt: window.__serverTransport?.getStats?.(),
        gameSession: !!window.__gameSession,
        missingServerParam: window.__missingServerParam,
        href: location.href,
        wsDefined: typeof WebSocket !== "undefined",
        wtDefined: typeof WebTransport !== "undefined",
        gpu: !!navigator.gpu,
        peerOverlayStatus: window.__peerOverlayStatus,
      })`,
      returnByValue: true,
    });
    console.log("\n=== PAGE STATE ===");
    console.log(evalResult.result?.value);
  } catch (e) {
    console.log("eval failed:", e.message);
  }

  ws.close();
  console.log("\n=== done ===");
}

main().catch(e => {
  console.error("CAUGHT:", e);
  process.exit(1);
});