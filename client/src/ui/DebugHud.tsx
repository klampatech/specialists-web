// Debug HUD v3 — Hetzner/prod-aware.
//
// Differences from v2:
//   1. Auto-shows in prod when `?debug=1` is in URL OR
//      `localStorage.__debugHudOpen === "1"`. No more "open devtools
//      and figure it out" — Kyle needs this visible when he joins
//      the prod Hetzner room.
//   2. Probe targets derive from `window.location.host` instead of
//      hardcoded m5 IPs / Tailscale hostnames. Works on Hetzner
//      (`65.108.87.1`), m5 Tailscale, or localhost.
//   3. New sections: HP / ammo / yaw / hits / damageBus counters /
//      weapon fire mode. All the game-state stuff I used to read
//      via console.log one variable at a time.
//   4. New `[Copy debug bundle]` button — drops a paste-ready
//      JSON dump (window globals + game state + transport stats)
//      into the clipboard so Kyle can paste a single blob into
//      Discord instead of a screenshot.

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
  const combatRef = React.useRef<HTMLDivElement>(null);
  const serverRef = React.useRef<HTMLDivElement>(null);
  const logRef = React.useRef<HTMLPreElement>(null);

  // Log buffer state (low frequency — React).
  const [log, setLog] = React.useState<LogLine[]>([]);
  const appendLog = React.useCallback((msg: string) => {
    setLog((prev) => {
      const next = [...prev, { ts: Date.now(), msg }];
      return next.length > 200 ? next.slice(-200) : next;
    });
  }, []);

  // Probe actions — use the current page host instead of hardcoded
  // m5 / Tailscale. Operators point this at whatever host the page
  // is on (Hetzner public IP, m5 Funnel, localhost, etc).
  const probeWebTransport = React.useCallback(async () => {
    appendLog("[Probe WT] starting…");
    if (typeof WebTransport === "undefined") {
      appendLog("[Probe WT] FAIL: WebTransport is not defined in this page context");
      return;
    }
    const base = `${window.location.protocol}//${window.location.host}`;
    // WebTransport runs on the same host, port 14433 by default.
    // Strip whatever port the page is on (e.g. 14432 for static) and
    // substitute the WebTransport port (env-configurable in prod).
    const wtPort =
      (window as { __specialistsPorts?: { wt?: number } }).__specialistsPorts?.wt ??
      14433;
    const wtHost = window.location.hostname;
    const url = `${window.location.protocol}//${wtHost}:${wtPort}/rooms/DEVBX`;
    appendLog(`[Probe WT] using ${url} (page base was ${base})`);
    try {
      const t = new WebTransport(url);
      const result = await Promise.race([
        t.ready.then(() => "OK").catch((e) => `reject: ${e.name}: ${e.message}`),
        new Promise<string>((r) => setTimeout(() => r("timeout 8s"), 8000)),
      ]);
      t.close();
      appendLog(`[Probe WT] ${url} → ${result}`);
    } catch (e) {
      appendLog(`[Probe WT] THROW ${(e as Error).name}: ${(e as Error).message}`);
    }
  }, [appendLog]);

  const probeWebSocket = React.useCallback(async () => {
    appendLog("[Probe WS] starting…");
    const wsPort =
      (window as { __specialistsPorts?: { ws?: number } }).__specialistsPorts?.ws ??
      14434;
    const wssPort =
      (window as { __specialistsPorts?: { wss?: number } }).__specialistsPorts?.wss ??
      14435;
    const isHttps = window.location.protocol === "https:";
    const scheme = isHttps ? "wss" : "ws";
    const port = isHttps ? wssPort : wsPort;
    const url = `${scheme}://${window.location.hostname}:${port}/rooms/DEVBX`;
    appendLog(`[Probe WS] connecting ${url}`);
    try {
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
      appendLog(`[Probe WS] THROW ${(e as Error).message}`);
    }
  }, [appendLog]);

  const probeMatchmaker = React.useCallback(async () => {
    appendLog("[Probe matchmaker] starting…");
    const url = `${window.location.origin}/rooms`;
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(url, {
        method: "POST",
        signal: ctrl.signal,
      }).catch((e) => e);
      clearTimeout(tid);
      if (res instanceof Error) {
        appendLog(`[Probe matchmaker] ${url} → ${res.name}: ${res.message}`);
      } else {
        const body = await res.text();
        appendLog(
          `[Probe matchmaker] POST ${url} → ${res.status} ${res.statusText} :: ${body.slice(0, 200)}`,
        );
      }
    } catch (e) {
      appendLog(`[Probe matchmaker] THROW ${(e as Error).message}`);
    }
  }, [appendLog]);

  const copyDebugBundle = React.useCallback(async () => {
    const w = window as unknown as Record<string, unknown>;
    const bundle = {
      ts: new Date().toISOString(),
      href: window.location.href,
      userAgent: navigator.userAgent,
      flags: {
        __forceServerTransport: w.__forceServerTransport,
        __damageServerUrl: w.__damageServerUrl,
        __damageServerRoomId: w.__damageServerRoomId,
        __localPlayerId: w.__localPlayerId,
        __peerPlayerId: w.__peerPlayerId,
        __missingServerParam: w.__missingServerParam,
        __wireServerTransportCalled: w.__wireServerTransportCalled,
      },
      transport:
        (w.__serverTransport as { getStats?: () => unknown } | undefined)?.getStats?.() ?? null,
      gameSession: {
        frame: (w.__gameSession as { frame?: number } | undefined)?.frame,
        health: (
          w.__gameSession as
            | { getHealthSnapshot?: () => unknown }
            | undefined
        )?.getHealthSnapshot?.() ?? null,
        weapon: (
          w.__gameSession as
            | { getLocalWeaponState?: () => unknown }
            | undefined
        )?.getLocalWeaponState?.() ?? null,
      },
      snapshot: (
        w as { __latestSnap?: () => unknown }
      ).__latestSnap?.() ?? null,
      damageBus: w.__damageBus
        ? {
            sendDamageRequest: (
              w.__damageBus as { sendDamageRequest?: unknown }
            ).sendDamageRequest !== undefined,
            sendAimEvent: (w.__damageBus as { sendAimEvent?: unknown }).sendAimEvent !== undefined,
            sendPositionUpdate: (
              w.__damageBus as { sendPositionUpdate?: unknown }
            ).sendPositionUpdate !== undefined,
          }
        : null,
      hits: (w as { __hits?: number }).__hits ?? null,
      dwelcomes: (w as { __dwelcomeCount?: number }).__dwelcomeCount ?? null,
    };
    const json = JSON.stringify(bundle, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      appendLog("[Copy] debug bundle copied to clipboard (" + json.length + " bytes)");
    } catch (e) {
      appendLog(`[Copy] clipboard write failed: ${(e as Error).message}`);
      // Fallback: surface in the log itself so Kyle can copy-paste.
      appendLog("[Copy] bundle follows:");
      for (const line of json.split("\n")) appendLog("  " + line);
    }
  }, [appendLog]);

  const forceReconnect = React.useCallback(async () => {
    appendLog("[Force reconnect] attempting…");
    try {
      const t = (window as unknown as { __serverTransport?: { dispose?: () => void; close?: () => void } })
        .__serverTransport;
      if (!t) {
        appendLog("[Force reconnect] no transport to reconnect");
        return;
      }
      if (t.dispose) {
        try {
          t.dispose();
        } catch (e) {
          appendLog(`[Force reconnect] dispose error: ${(e as Error).message}`);
        }
      } else if (t.close) {
        try {
          t.close();
        } catch {}
      }
      delete (window as unknown as { __serverTransport?: unknown }).__serverTransport;
      appendLog("[Force reconnect] transport cleared — Ctrl+R to re-init cleanly");
    } catch (e) {
      appendLog(`[Force reconnect] error: ${(e as Error).message}`);
    }
  }, [appendLog]);

  // High-frequency DOM updates (~30Hz to reduce flicker).
  React.useEffect(() => {
    if (!visible) return;
    let rafId = 0;
    let lastUpdate = 0;
    const tick = () => {
      rafId = requestAnimationFrame(tick);
      const now = performance.now();
      if (now - lastUpdate < 33) return;
      lastUpdate = now;

      const w = window as unknown as Record<string, unknown>;

      // URL section
      if (urlRef.current) {
        const href = typeof location !== "undefined" ? location.href : "?";
        const forceTransport = !!w.__forceServerTransport;
        const damageUrl = (w.__damageServerUrl as string | undefined) ?? null;
        const localId = (w.__localPlayerId as number | undefined) ?? "?";
        const peerId = (w.__peerPlayerId as number | undefined) ?? "?";
        const missing = !!w.__missingServerParam;
        const ok = forceTransport && damageUrl && !missing;
        urlRef.current.innerHTML = `
          <div style="color:#888">href:</div><div style="color:#fff;word-break:break-all;font-size:10px">${escapeHtml(href.slice(0, 140))}${href.length > 140 ? "…" : ""}</div>
          <div style="color:#888">force server transport:</div><div style="color:${forceTransport ? "#0f0" : "#f55"}">${forceTransport ? "✓ TRUE" : "✗ FALSE"}</div>
          <div style="color:#888">damage server:</div><div style="color:${damageUrl ? "#0f0" : "#f55"}">${damageUrl ?? "—"}</div>
          <div style="color:#888">room:</div><div style="color:#fff">${(w.__damageServerRoomId as string | undefined) ?? "—"}</div>
          <div style="color:#888">localId / peerId:</div><div style="color:#fff">${localId} / ${peerId}</div>
          ${missing ? '<div style="color:#f55;font-weight:bold;padding:4px;background:#400">URL missing ?server= param</div>' : ""}
          <div style="color:#888;padding-top:4px">overall:</div><div style="color:${ok ? "#0f0" : "#f55"}">${ok ? "✓ ready" : "✗ not connected"}</div>
        `;
      }

      // Browser capabilities
      if (browserRef.current) {
        const wt = typeof WebTransport !== "undefined" ? "✓ defined" : "✗ undefined";
        const gpu = !!(navigator as unknown as { gpu?: unknown }).gpu;
        const webgl2 = !!document.createElement("canvas").getContext("webgl2");
        const secure = typeof window !== "undefined" && window.isSecureContext;
        const gpuAdapter = gpu ? "available" : "no";
        browserRef.current.innerHTML = `
          <div style="color:#888">WebTransport:</div><div style="color:${typeof WebTransport !== "undefined" ? "#0f0" : "#f55"}">${wt}</div>
          <div style="color:#888">WebGPU:</div><div style="color:${gpu ? "#0f0" : "#ff0"}">${gpuAdapter}</div>
          <div style="color:#888">WebGL2:</div><div style="color:${webgl2 ? "#0f0" : "#f55"}">${webgl2 ? "✓" : "✗"}</div>
          <div style="color:#888">secure context:</div><div style="color:${secure ? "#0f0" : "#f55"}">${secure ? "✓" : "✗ — WebTransport stripped"}</div>
        `;
      }

      // Network — transport stats
      if (networkRef.current) {
        const t = w.__serverTransport as
          | {
              activeKind?: string;
              connected?: boolean;
              closed?: boolean;
              getStats?: () => Record<string, unknown>;
            }
          | undefined;
        const kind: string = t?.activeKind ?? "—";
        const connected = !!t?.connected;
        const closed = !!t?.closed;
        const stats = t?.getStats?.() ?? {};
        const rtt = (stats.rttMs as number | undefined) ?? "?";
        const uptime = stats.uptimeMs
          ? `${((stats.uptimeMs as number) / 1000).toFixed(1)}s`
          : "—";
        const reconnectAttempts = (stats.reconnectAttempts as number | undefined) ?? 0;
        const lastDisconnectAt = stats.lastDisconnectAt ?? null;
        const reconnectBackoffMs = (stats.reconnectBackoffMs as number | undefined) ?? 0;
        networkRef.current.innerHTML = `
          <div style="color:#888">transport:</div><div style="color:${kind === "webtransport" ? "#0f0" : kind === "websocket" ? "#ff0" : "#f55"}">${kind === "—" ? "none" : kind}</div>
          <div style="color:#888">connected:</div><div style="color:${connected ? "#0f0" : "#f55"}">${connected ? "✓" : "✗"}</div>
          <div style="color:#888">closed:</div><div style="color:${closed ? "#f55" : "#888"}">${closed ? "YES" : "no"}</div>
          <div style="color:#888">RTT:</div><div style="color:#fff">${rtt}ms</div>
          <div style="color:#888">uptime:</div><div style="color:#fff">${uptime}</div>
          <div style="color:#888">reconnect attempts:</div><div style="color:#fff">${reconnectAttempts}</div>
          ${lastDisconnectAt ? `<div style="color:#888">last disconnect:</div><div style="color:#fff">${new Date(lastDisconnectAt as number).toLocaleTimeString()}</div>` : ""}
          <div style="color:#888">backoff:</div><div style="color:#fff">${reconnectBackoffMs}ms</div>
        `;
      }

      // Game state — positions, frame, snapshot players
      if (stateRef.current) {
        const sess = w.__gameSession as
          | {
              localController?: { havok?: { getPosition?: () => unknown } };
              remoteController?: { havok?: { getPosition?: () => unknown } };
              frame?: number;
              getReloadingUntilMs?: () => number | null;
            }
          | undefined;
        const lp = sess?.localController?.havok?.getPosition?.() as
          | { x: number; y: number; z: number }
          | undefined;
        const rp = sess?.remoteController?.havok?.getPosition?.() as
          | { x: number; y: number; z: number }
          | undefined;
        const getLatestSnap = (
          w as { __latestSnap?: () => { players?: unknown; serverFrame?: number } | null }
        ).__latestSnap;
        const snap = typeof getLatestSnap === "function" ? getLatestSnap() : null;
        const players = snap?.players;
        const playersStr = Array.isArray(players)
          ? players
              .map((p: { id?: number; hp?: number }) => `${p.id ?? "?"}:hp${p.hp ?? "?"}`)
              .join(", ")
          : "—";

        const reloadUntil = sess?.getReloadingUntilMs?.();
        const reloadStr =
          reloadUntil && reloadUntil > Date.now()
            ? `${((reloadUntil - Date.now()) / 1000).toFixed(1)}s`
            : "—";

        stateRef.current.innerHTML = `
          <div style="color:#888">local  Havok:</div><div style="color:#fff">${lp ? `(${lp.x.toFixed(2)}, ${lp.y.toFixed(2)}, ${lp.z.toFixed(2)})` : "—"}</div>
          <div style="color:#888">remote Havok:</div><div style="color:#fff">${rp ? `(${rp.x.toFixed(2)}, ${rp.y.toFixed(2)}, ${rp.z.toFixed(2)})` : "—"}</div>
          <div style="color:#888">snapshot players:</div><div style="color:#fff;font-size:10px">${playersStr}</div>
          <div style="color:#888">frame:</div><div style="color:#fff">${sess?.frame ?? "?"} (server: ${snap?.serverFrame ?? "?"})</div>
          <div style="color:#888">reload timer:</div><div style="color:#fff">${reloadStr}</div>
        `;
      }

      // Combat — HP, ammo, hits, weapon
      if (combatRef.current) {
        const sess = w.__gameSession as
          | {
              getHealthSnapshot?: () => {
                local?: { hp?: number; respawningMs?: number };
                remote?: { hp?: number; respawningMs?: number };
              };
              getLocalWeaponState?: () => { weaponId?: number; fireModeIndex?: number };
            }
          | undefined;
        const hp = sess?.getHealthSnapshot?.();
        const weapon = sess?.getLocalWeaponState?.();
        const dmg = w.__damageBus as { __counters?: Record<string, number> } | undefined;
        // Walk common counters — keys depend on what damageBus exposes.
        const counters = dmg?.__counters ?? {};

        const hits = counters.hits ?? counters.accepted ?? "?";
        const rejected = counters.rejected ?? "?";
        const sentAim = counters.aimSent ?? "?";
        const sentPos = counters.posSent ?? "?";

        combatRef.current.innerHTML = `
          <div style="color:#888">HP local:</div><div style="color:${hp?.local?.hp && hp.local.hp < 100 ? "#ff0" : "#0f0"}">${hp?.local?.hp ?? "—"} ${hp?.local?.respawningMs ? `(respawn ${(hp.local.respawningMs / 1000).toFixed(1)}s)` : ""}</div>
          <div style="color:#888">HP remote:</div><div style="color:${hp?.remote?.hp && hp.remote.hp < 100 ? "#ff0" : "#0f0"}">${hp?.remote?.hp ?? "—"} ${hp?.remote?.respawningMs ? `(respawn ${(hp.remote.respawningMs / 1000).toFixed(1)}s)` : ""}</div>
          <div style="color:#888">weapon:</div><div style="color:#fff">${weapon?.weaponId ?? "?"} (mode ${weapon?.fireModeIndex ?? "?"})</div>
          <div style="color:#888">damageBus counters:</div><div style="color:#fff;font-size:10px">hits=${hits} rejected=${rejected} aim=${sentAim} pos=${sentPos}</div>
        `;
      }

      // Server-side: room state from GET /rooms/:id
      if (serverRef.current) {
        const w2 = window as unknown as { __lastRoomState?: { players: number; ts: number } | null };
        const roomState = w2.__lastRoomState;
        serverRef.current.innerHTML = `
          <div style="color:#888">last /rooms check:</div><div style="color:#fff">${roomState ? `${roomState.players} player(s) · ${new Date(roomState.ts).toLocaleTimeString()}` : "— (press 'Refresh room')"}</div>
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
        🐛 DEBUG HUD v3 — toggle: ` — paste [Copy debug] bundle to Discord
      </div>

      <Section title="URL + params">
        <div ref={urlRef} style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: "2px 8px" }}>
          <div style={{ color: "#888" }}>href:</div>
          <div style={{ color: "#888" }}>—</div>
        </div>
      </Section>

      <Section title="Browser capabilities">
        <div ref={browserRef} style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: "2px 8px" }}>
          <div style={{ color: "#888" }}>WebTransport:</div>
          <div style={{ color: "#888" }}>—</div>
        </div>
      </Section>

      <Section title="Network (transport stats)">
        <div ref={networkRef} style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: "2px 8px" }}>
          <div style={{ color: "#888" }}>transport:</div>
          <div style={{ color: "#888" }}>—</div>
        </div>
      </Section>

      <Section title="Game state (positions + frame)">
        <div ref={stateRef} style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: "2px 8px" }}>
          <div style={{ color: "#888" }}>local Havok:</div>
          <div style={{ color: "#888" }}>—</div>
        </div>
      </Section>

      <Section title="Combat (HP / ammo / hits)">
        <div ref={combatRef} style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: "2px 8px" }}>
          <div style={{ color: "#888" }}>HP local:</div>
          <div style={{ color: "#888" }}>—</div>
        </div>
      </Section>

      <Section title="Server room state">
        <div ref={serverRef} style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: "2px 8px" }}>
          <div style={{ color: "#888" }}>last check:</div>
          <div style={{ color: "#888" }}>—</div>
        </div>
      </Section>

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
        <ActionButton onClick={probeMatchmaker} color="#a5f">
          Probe matchmaker
        </ActionButton>
        <ActionButton onClick={forceReconnect} color="#f55">
          Reconnect
        </ActionButton>
        <ActionButton onClick={copyDebugBundle} color="#0f0">
          Copy debug bundle
        </ActionButton>
      </div>

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
            ? "Click a button above to run diagnostics. [Copy debug bundle] → paste into Discord."
            : log.map((l) => `[${new Date(l.ts).toLocaleTimeString()}] ${l.msg}`).join("\n")}
        </pre>
      </details>

      <div style={{ marginTop: 6, color: "#888", fontSize: 10 }}>
        Toggle: ` (backtick) · Auto-show: ?debug=1 or localStorage.__debugHudOpen=1
      </div>
    </div>
  );
}

// ---------- helpers ----------

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div style={{ marginBottom: 8 }}>
      <div
        style={{
          color: "#0f0",
          fontWeight: "bold",
          marginBottom: 2,
          fontSize: 12,
          borderBottom: "1px solid #0a0",
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
  color,
  children,
}: {
  onClick: () => void;
  color: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      style={{
        background: "#000",
        color,
        border: `1px solid ${color}`,
        padding: "4px 8px",
        fontFamily: "inherit",
        fontSize: 11,
        cursor: "pointer",
        borderRadius: 2,
      }}
    >
      {children}
    </button>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
