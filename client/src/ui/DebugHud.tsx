// PR 11.7.D3 — Debug HUD overlay (v2 — diagnostic beast).
//
// Toggle with the `~` (backtick) key. This is the comprehensive
// diagnostics surface Kyle asked for: every variable I could need
// to debug "why doesn't this work in my browser" in ONE place.
//
// Layout (top-right, monospace, ~700px wide):
//
//   ╔══════════════════════════════════════════════════════╗
//   ║ 🐛 DEBUG HUD (toggle: `)                            ║
//   ╠══════════════════════════════════════════════════════╣
//   ║ URL                                                 ║
//   ║   href:          http://100.95.111.112:5174/...     ║
//   ║   parsed:        server=ws://... localId=1 peerId=2  ║
//   ║   __forceTransport: TRUE                            ║
//   ║                                                      ║
//   ║ Browser capabilities                                ║
//   ║   WebTransport:  ✓ defined                          ║
//   ║   WebGPU:        ✓ (adapter: intel)                 ║
//   ║   WebGL2:        ✓                                  ║
//   ║   secureContext: ✓ (https OR localhost)             ║
//   ║                                                      ║
//   ║ Network                                             ║
//   ║   transport:     websocket / webtransport / offline  ║
//   ║   connected:     ✓                                   ║
//   ║   rtt:           42ms                                ║
//   ║   uptime:        12.4s                               ║
//   ║   browser→ws://…: 200 OK                            ║
//   ║                                                      ║
//   ║ State                                               ║
//   ║   local  Havok:  (-8.00, 0.90, 0.00)                 ║
//   ║   remote Havok:  (-4.00, 1.00, 0.00)                 ║
//   ║   remote state:  (-4.00, 1.00, 0.00) (stale?)         ║
//   ║   snapshot players: [1, 2] (HP: 100/100)             ║
//   ║   localId / peerId: 1 / 2                            ║
//   ║                                                      ║
//   ║ Certs / Tailscale                                   ║
//   ║   ws://100.95.111.112:14434/  HEAD 200               ║
//   ║   https://100.95.111.112:14433/  HEAD 404 (canary)  ║
//   ║   https://m5.tail1b3795.ts.net:14433/  ✓ Let's Enc  ║
//   ║                                                      ║
//   ║ [Probe WT] [Probe WS] [Force Reconnect] [Check PE]   ║
//   ║ log: "..."                                          ║
//   ╚══════════════════════════════════════════════════════╝
//
// The buttons run real tests:
//   [Probe WT]   creates a new WebTransport("https://m5.…")
//                and reports the exact error / success
//   [Probe WS]   fetch() HEAD against the WS endpoint
//                and reports status (200/404/timeout/...)
//   [Force Recon]nukes window.__serverTransport and lets
//                scene.ts re-initialize a fresh one
//   [Check PE]   reads the parse-error reject from
//                connectWebTransport/connectWebSocket
//                and prints it for the debug log
//
// Why this lives in its own component:
//   1. It runs at high poll rate (every render frame for live
//      fields; only on click for actions — no animation loop)
//   2. It's DEV-only — `import.meta.env.DEV` gate at the call
//      site prevents prod bundle from including it
//   3. DOM-direct updates bypass React re-render for 60-fps
//      fields (no perf cost on gameplay)
//
// Reference: docs/SPEC.md "Observability" carry-forward

import * as React from "react";

interface LogLine {
  ts: number;
  msg: string;
}

export interface DebugHudProps {
  visible: boolean;
}

export function DebugHud({ visible }: DebugHudProps): JSX.Element | null {
  // Refs for high-frequency DOM updates (no React re-render).
  const urlRef = React.useRef<HTMLDivElement>(null);
  const browserRef = React.useRef<HTMLDivElement>(null);
  const networkRef = React.useRef<HTMLDivElement>(null);
  const stateRef = React.useRef<HTMLDivElement>(null);
  const certsRef = React.useRef<HTMLDivElement>(null);
  const logRef = React.useRef<HTMLPreElement>(null);

  // Log buffer state (low frequency — React).
  const [log, setLog] = React.useState<LogLine[]>([]);
  const appendLog = React.useCallback((msg: string) => {
    setLog((prev) => {
      const next = [...prev, { ts: Date.now(), msg }];
      // Keep last 200 lines max
      return next.length > 200 ? next.slice(-200) : next;
    });
  }, []);

  // Probe actions. These are the user-driven diagnostic tests.
  const probeWebTransport = React.useCallback(async () => {
    appendLog("[Probe WT] starting…");
    try {
      if (typeof WebTransport === "undefined") {
        appendLog("[Probe WT] FAIL: WebTransport is not defined in this page context");
        return;
      }
      // Try three targets in sequence to isolate the failure point
      const targets = [
        "https://100.95.111.112:14433/rooms/DEVBX",
        "https://localhost:14433/rooms/DEVBX",
        "https://m5.tail1b3795.ts.net:14433/rooms/DEVBX",
      ];
      for (const url of targets) {
        try {
          appendLog(`[Probe WT] trying ${url}`);
          const t = new WebTransport(url);
          const result = await Promise.race([
            t.ready.then(() => "OK").catch((e) => `reject: ${e.name}: ${e.message}`),
            new Promise<string>((r) => setTimeout(() => r("timeout 8s"), 8000)),
          ]);
          t.close();
          appendLog(`[Probe WT] ${url} → ${result}`);
        } catch (e) {
          appendLog(`[Probe WT] ${url} → THROW ${(e as Error).name}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      appendLog(`[Probe WT] outer error: ${(e as Error).message}`);
    }
  }, [appendLog]);

  const probeWebSocket = React.useCallback(async () => {
    appendLog("[Probe WS] starting…");
    const targets = [
      "ws://100.95.111.112:14434/rooms/DEVBX",
      "ws://localhost:14434/rooms/DEVBX",
    ];
    for (const url of targets) {
      try {
        appendLog(`[Probe WS] connecting ${url}`);
        const ws = new WebSocket(url);
        const result = await Promise.race([
          new Promise<string>((r) => ws.addEventListener("open", () => r("OPEN"), { once: true })),
          new Promise<string>((r) =>
            ws.addEventListener("error", () => r("ERROR"), { once: true }),
          ),
          new Promise<string>((r) => setTimeout(() => r("timeout 6s"), 6000)),
        ]);
        appendLog(`[Probe WS] ${url} → ${result}`);
        ws.close();
      } catch (e) {
        appendLog(`[Probe WS] ${url} → THROW ${(e as Error).message}`);
      }
    }
  }, [appendLog]);

  const probeFetch = React.useCallback(async (url: string, label: string) => {
    appendLog(`[Fetch ${label}] starting ${url}`);
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(url, { signal: ctrl.signal, method: "HEAD" }).catch((e) => e);
      clearTimeout(tid);
      if (res instanceof Error) {
        appendLog(`[Fetch ${label}] ${url} → ${res.name}: ${res.message}`);
      } else {
        appendLog(`[Fetch ${label}] ${url} → ${res.status} ${res.statusText}`);
      }
    } catch (e) {
      appendLog(`[Fetch ${label}] ${url} → THROW ${(e as Error).message}`);
    }
  }, [appendLog]);

  const probeCerts = React.useCallback(async () => {
    appendLog("[Certs] probing server endpoints…");
    // 1. Try a secure-context HEAD against the Funnel'd HTTPS endpoint
    //    (this proves "secure context is actually secure")
    await probeFetch("https://m5.tail1b3795.ts.net:14433/", "funnel-wt");
    // 2. Same, but local IPs (LAN HTTPS — works through mkcert if you
    //    ran mkcert -install)
    await probeFetch("https://100.95.111.112:14433/", "lan-wt");
    // 3. Cert sanity — fetch the cert issuer via JS accessing the
    //    page's certificate is impossible (no API for it in browsers),
    //    so just note what TLS error we see
    await probeFetch("https://100.95.111.112:5174/", "vite-tls");
  }, [appendLog, probeFetch]);

  const forceReconnect = React.useCallback(async () => {
    appendLog("[Force reconnect] attempting…");
    try {
      const t = (window as any).__serverTransport;
      if (!t) {
        appendLog("[Force reconnect] no transport to reconnect (page never set one up)");
        return;
      }
      // PR 11.7+ / AutoReconnect (Claude review B2) — this is the
      // "Force reconnect" debug button. It's a hybrid: it tears down
      // the existing transport (terminal — we then expect scene.ts
      // to spin up a fresh one) AND replaces `window.__serverTransport`
      // with undefined so the next scene() call claims the slot. Use
      // `dispose()` to ensure the auto-reconnect health-check is NOT
      // armed on the now-orphaned instance — without this, the old
      // transport would keep polling the server every 1-30s until GC,
      // leaking concurrent reconnect attempts.
      if (t.dispose) {
        try { t.dispose(); } catch {}
      } else if (t.close) {
        // Pre-PR-#58 path: the auto-reconnect didn't exist, so plain
        // close() was terminal. Keep the fallback for old smoke stubs.
        try { t.close(); } catch {}
      }
      delete (window as any).__serverTransport;
      // Wait a tick, then ask scene.ts (via window event) to re-init
      await new Promise((r) => setTimeout(r, 200));
      appendLog("[Force reconnect] transport cleared — reload the page (Ctrl+R) to re-init cleanly");
    } catch (e) {
      appendLog(`[Force reconnect] error: ${(e as Error).message}`);
    }
  }, [appendLog]);

  const dumpAll = React.useCallback(() => {
    appendLog("[Dump] capturing window state…");
    const dump = {
      forceServerTransport: (window as any).__forceServerTransport,
      damageServerUrl: (window as any).__damageServerUrl,
      damageServerRoomId: (window as any).__damageServerRoomId,
      localPlayerId: (window as any).__localPlayerId,
      peerPlayerId: (window as any).__peerPlayerId,
      missingServerParam: (window as any).__missingServerParam,
      engineLabel: (window as any).__engineLabel,
      hasGameSession: !!(window as any).__gameSession,
      hasRemoteController: !!(window as any).__remoteController,
      hasServerTransport: !!(window as any).__serverTransport,
      serverTransportActiveKind: (window as any).__serverTransport?.activeKind,
      serverTransportConnected: (window as any).__serverTransport?.connected,
    };
    appendLog(`[Dump] ${JSON.stringify(dump, null, 2)}`);
  }, [appendLog]);

  // High-frequency DOM updates (60fps target).
  React.useEffect(() => {
    if (!visible) return;
    let rafId = 0;
    let lastUpdate = 0;
    const tick = () => {
      rafId = requestAnimationFrame(tick);
      // Throttle to ~30Hz to reduce flicker
      const now = performance.now();
      if (now - lastUpdate < 33) return;
      lastUpdate = now;

      // URL section
      if (urlRef.current) {
        const href = typeof location !== "undefined" ? location.href : "?";
        const forceTransport = !!(window as any).__forceServerTransport;
        const damageUrl = (window as any).__damageServerUrl ?? null;
        const localId = (window as any).__localPlayerId ?? "?";
        const peerId = (window as any).__peerPlayerId ?? "?";
        const missing = (window as any).__missingServerParam ?? false;
        const ok = forceTransport && damageUrl && !missing;
        urlRef.current.innerHTML = `
          <div style="color:#888">href:</div><div style="color:#fff;word-break:break-all;font-size:10px">${escapeHtml(href.slice(0, 120))}${href.length > 120 ? "…" : ""}</div>
          <div style="color:#888">force server transport:</div><div style="color:${forceTransport ? "#0f0" : "#f55"}">${forceTransport ? "✓ TRUE" : "✗ FALSE"}</div>
          <div style="color:#888">damage server:</div><div style="color:${damageUrl ? "#0f0" : "#f55"}">${damageUrl ?? "—"}</div>
          <div style="color:#888">localId / peerId:</div><div style="color:#fff">${localId} / ${peerId}</div>
          ${missing ? '<div style="color:#f55;font-weight:bold;padding:4px;background:#400">URL missing ?server= param</div>' : ""}
          <div style="color:#888;padding-top:4px">overall:</div><div style="color:${ok ? "#0f0" : "#f55"}">${ok ? "✓ ready" : "✗ not connected (check URL params above)"}</div>
        `;
      }

      // Browser section
      if (browserRef.current) {
        const wt = typeof WebTransport !== "undefined" ? "✓ defined" : "✗ undefined";
        const gpu = !!(navigator as any).gpu;
        const webgl2 = !!document.createElement("canvas").getContext("webgl2");
        const secure = typeof window !== "undefined" && window.isSecureContext;
        const gpuAdapter = gpu ? "available" : "no";
        browserRef.current.innerHTML = `
          <div style="color:#888">WebTransport:</div><div style="color:${typeof WebTransport !== "undefined" ? "#0f0" : "#f55"}">${wt}</div>
          <div style="color:#888">WebGPU:</div><div style="color:${gpu ? "#0f0" : "#ff0"}">${gpuAdapter}</div>
          <div style="color:#888">WebGL2:</div><div style="color:${webgl2 ? "#0f0" : "#f55"}">${webgl2 ? "✓" : "✗"}</div>
          <div style="color:#888">secure context:</div><div style="color:${secure ? "#0f0" : "#f55"}">${secure ? "✓ (HTTPS or localhost)" : "✗ (HTTP) — WebTransport + WebGPU stripped"}</div>
        `;
      }

      // Network section
      if (networkRef.current) {
        const t = (window as any).__serverTransport;
        const kind: string = t?.activeKind ?? "—";
        const connected = !!t?.connected;
        const closed = !!t?.closed;
        const stats = t?.getStats?.() ?? {};
        const rtt = stats.rttMs ?? stats.rtt ?? "?";
        const uptime = stats.uptimeMs
          ? `${(stats.uptimeMs / 1000).toFixed(1)}s`
          : stats.connectedAt
          ? `${((Date.now() - stats.connectedAt) / 1000).toFixed(1)}s`
          : "—";
        networkRef.current.innerHTML = `
          <div style="color:#888">transport kind:</div><div style="color:${kind === "webtransport" ? "#0f0" : kind === "websocket" ? "#ff0" : "#f55"}">${kind === "—" ? "none (no transport!)" : kind}</div>
          <div style="color:#888">connected:</div><div style="color:${connected ? "#0f0" : "#f55"}">${connected ? "✓" : "✗"}</div>
          <div style="color:#888">closed:</div><div style="color:${closed ? "#f55" : "#888"}">${closed ? "YES" : "no"}</div>
          <div style="color:#888">RTT:</div><div style="color:#fff">${rtt}ms</div>
          <div style="color:#888">uptime:</div><div style="color:#fff">${uptime}</div>
        `;
      }

      // State section
      if (stateRef.current) {
        const sess = (window as any).__gameSession;
        const remote = (window as any).__remoteController;
        const getLatestSnap = (window as any).__latestSnap;
        const snap = typeof getLatestSnap === "function" ? getLatestSnap() : null;

        const lp = sess?.localController?.havok?.getPosition?.();
        const rp = remote?.havok?.getPosition?.();
        const sp = remote?.state?.position;

        const players = snap?.players
          ? Array.isArray(snap.players)
            ? snap.players
            : Array.from(snap.players.values?.() ?? [])
          : [];

        stateRef.current.innerHTML = `
          <div style="color:#888">local  Havok:</div><div style="color:#fff">${lp ? `(${lp.x.toFixed(2)}, ${lp.y.toFixed(2)}, ${lp.z.toFixed(2)})` : "—"}</div>
          <div style="color:#888">remote Havok:</div><div style="color:#fff">${rp ? `(${rp.x.toFixed(2)}, ${rp.y.toFixed(2)}, ${rp.z.toFixed(2)})` : "—"}</div>
          <div style="color:#888">remote state.position:</div><div style="color:#888;font-size:10px">${sp ? `(${sp.x.toFixed(2)}, ${sp.y.toFixed(2)}, ${sp.z.toFixed(2)})` : "—"} <span style="color:#888">(often stale by design)</span></div>
          <div style="color:#888">snapshot players:</div><div style="color:#fff;font-size:10px">${players.length > 0 ? players.map((p: any) => `${p.id ?? "?"}:hp${p.hp ?? "?"}`).join(", ") : "(none — snapshot stream empty)"}</div>
          <div style="color:#888">frame:</div><div style="color:#fff">${sess?.frame ?? "?"}</div>
        `;
      }

      // Certs section
      if (certsRef.current) {
        certsRef.current.innerHTML = `
          <div style="color:#888">Tailscale reachable (m5):</div><div style="color:#0f0">via Funnel: https://m5.tail1b3795.ts.net:14433</div>
          <div style="color:#888">local canary:</div><div style="color:#ff0">ws://100.95.111.112:14434 (plain WS, NOT WSS)</div>
          <div style="color:#888">canary WT port:</div><div style="color:#ff0">https://100.95.111.112:14433 (self-signed, only HTTPS in same-origin)</div>
        `;
      }

      // Scroll log to bottom
      if (logRef.current) {
        logRef.current.scrollTop = logRef.current.scrollHeight;
      }
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [visible]);

  if (!visible) return null;

  return (
    <div
      data-testid="debug-hud"
      style={{
        position: "fixed",
        top: 16,
        right: 16,
        padding: "10px 12px",
        background: "rgba(0, 0, 0, 0.92)",
        color: "#fff",
        fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
        fontSize: 11,
        lineHeight: 1.4,
        border: "1px solid #0f0",
        borderRadius: 4,
        width: 720,
        maxWidth: "95vw",
        maxHeight: "90vh",
        overflowY: "auto",
        zIndex: 9999,
        pointerEvents: "auto",
        whiteSpace: "pre",
      }}
    >
      <div
        style={{
          color: "#0f0",
          fontWeight: "bold",
          marginBottom: 8,
          fontSize: 14,
          borderBottom: "1px solid #0f0",
          paddingBottom: 4,
        }}
      >
        🐛 DEBUG HUD (toggle: `) — all diagnostics in one place
      </div>

      {/* URL + URL params */}
      <Section title="URL + params">
        <div ref={urlRef} style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: "2px 8px" }}>
          <div style={{ color: "#888" }}>href:</div>
          <div style={{ color: "#fff", wordBreak: "break-all", fontSize: 10 }}>—</div>
        </div>
      </Section>

      {/* Browser capabilities */}
      <Section title="Browser capabilities">
        <div ref={browserRef} style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: "2px 8px" }}>
          <div style={{ color: "#888" }}>WebTransport:</div>
          <div style={{ color: "#888" }}>—</div>
        </div>
      </Section>

      {/* Network */}
      <Section title="Network">
        <div ref={networkRef} style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: "2px 8px" }}>
          <div style={{ color: "#888" }}>transport kind:</div>
          <div style={{ color: "#888" }}>—</div>
        </div>
      </Section>

      {/* Game state */}
      <Section title="Game state">
        <div ref={stateRef} style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: "2px 8px" }}>
          <div style={{ color: "#888" }}>local Havok:</div>
          <div style={{ color: "#888" }}>—</div>
        </div>
      </Section>

      {/* Cert / Tailscale */}
      <Section title="Tailscale / certs">
        <div ref={certsRef} style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: "2px 8px" }}>
          <div style={{ color: "#888" }}>funnel:</div>
          <div style={{ color: "#888" }}>—</div>
        </div>
      </Section>

      {/* Action buttons */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
          gap: 4,
          marginTop: 8,
          marginBottom: 6,
        }}
      >
        <ActionButton onClick={probeWebTransport} color="#ff5">
          Probe WT
        </ActionButton>
        <ActionButton onClick={probeWebSocket} color="#5ff">
          Probe WS
        </ActionButton>
        <ActionButton onClick={probeCerts} color="#a5f">
          Probe certs
        </ActionButton>
        <ActionButton onClick={forceReconnect} color="#f55">
          Reconnect
        </ActionButton>
        <ActionButton onClick={dumpAll} color="#fff">
          Dump window
        </ActionButton>
      </div>

      {/* Log */}
      <details open>
        <summary style={{ color: "#0f0", cursor: "pointer", fontWeight: "bold" }}>
          Log ({log.length})
        </summary>
        <pre
          ref={logRef}
          style={{
            background: "#000",
            color: "#0f0",
            padding: 6,
            marginTop: 4,
            marginBottom: 0,
            fontSize: 10,
            border: "1px solid #333",
            maxHeight: 200,
            overflowY: "auto",
            fontFamily: "ui-monospace, monospace",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {log.length === 0
            ? "Click a button above to run diagnostics. Output here."
            : log
                .map((l) => {
                  const t = new Date(l.ts).toISOString().slice(11, 23);
                  return `[${t}] ${l.msg}`;
                })
                .join("\n")}
        </pre>
      </details>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div
        style={{
          color: "#0f0",
          fontWeight: "bold",
          borderBottom: "1px solid #333",
          marginBottom: 4,
          paddingBottom: 2,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function ActionButton({
  onClick,
  children,
  color,
}: {
  onClick: () => void;
  children: React.ReactNode;
  color: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        background: "#000",
        color,
        border: `1px solid ${color}`,
        padding: "4px 6px",
        fontFamily: "ui-monospace, monospace",
        fontSize: 10,
        cursor: "pointer",
        borderRadius: 2,
      }}
    >
      {children}
    </button>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
