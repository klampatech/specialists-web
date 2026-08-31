// PR 11.9 — Matchmaker lobby.
//
// Renders when the URL has no `?server=` flag (i.e., the user landed
// on the entry page without being invited to a specific room).
// Provides two actions:
//
//   - **Create room** — POSTs to `${matchmakerHttpOrigin}/rooms`,
//     receives `{id, ws_url, wss_url, max_players}`, and redirects
//     to `?server=<ws_url>` so the existing PeerOverlay/scene.ts
//     flow takes over with the right server.
//
//   - **Join with code** — Lets the user paste a room ID. Hits
//     `GET /rooms/<id>` to verify it exists; on 200, redirects to
//     `?server=<origin>/rooms/<id>`. On 404, shows a "Room not
//     found" error.
//
// The matchmaker HTTP origin is derived from the page's own origin
// in dev (`http://localhost:5174/`) or from a hard-coded production
// URL (`https://m5.<tailnet>.ts.net:8080/`). For v1, hard-code the
// dev origin (matches the canary's `port_http = 8080` default).
// Production will pass this via env / build-time var.

import { useState } from "react";
import { roomApi } from "../net/matchmakerApi";

const DEV_MATCHMAKER_ORIGIN = "http://127.0.0.1:18080";
// Production (Tailscale Funnel) — will be wired in PR 11.11.
// Matches `tools/specialists-server.service`'s Funnel-served URL.
const PROD_MATCHMAKER_ORIGIN = "https://m5.tail1b3795.ts.net";

export function Lobby() {
  // Detect production vs dev at runtime. The canary in dev binds
  // `http://127.0.0.1:18080`; production runs behind Tailscale
  // Funnel and binds to its public URL. We default to dev and let
  // an env-var override drive prod — keep the build simple.
  const origin =
    (import.meta.env.VITE_MATCHMAKER_ORIGIN as string | undefined) ??
    (window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1"
      ? DEV_MATCHMAKER_ORIGIN
      : PROD_MATCHMAKER_ORIGIN);

  const [joinCode, setJoinCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onCreate = async () => {
    setError(null);
    setBusy(true);
    try {
      const { ws_url } = await roomApi.createRoom(origin);
      // Navigate to the same page with `?server=<ws_url>`. PeerOverlay
      // picks up the flag on module re-evaluation and wires the
      // ServerTransport.
      const target = new URL(window.location.href);
      target.searchParams.set("server", ws_url);
      window.location.href = target.toString();
    } catch (e) {
      setError(`Failed to create room: ${(e as Error).message}`);
      setBusy(false);
    }
  };

  const onJoin = async () => {
    const id = joinCode.trim();
    if (!id) {
      setError("Enter a room code");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const r = await roomApi.getRoom(origin, id);
      if (!r.exists) {
        setError(`Room "${id}" not found. Ask the host to share a fresh link.`);
        setBusy(false);
        return;
      }
      // Build ws:// URL. We don't know the server's host:port from
      // the GET response (it intentionally doesn't echo them to
      // keep the API minimal). Default to `${origin}/rooms/<id>` —
      // matchmaker and game server share the same domain in
      // production (PR 11.9 §3.5 architecture).
      const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsHost = window.location.host;
      const ws_url = `${wsProto}//${wsHost}/rooms/${id}`;
      const target = new URL(window.location.href);
      target.searchParams.set("server", ws_url);
      window.location.href = target.toString();
    } catch (e) {
      setError(`Failed to check room: ${(e as Error).message}`);
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="lobby"
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(20, 20, 28, 0.92)",
        color: "#e6e6ea",
        fontFamily: "system-ui, -apple-system, sans-serif",
        zIndex: 100,
      }}
    >
      <h1 style={{ fontSize: "1.6rem", margin: "0 0 0.4rem" }}>Specialists</h1>
      <p style={{ margin: 0, opacity: 0.7, fontSize: "0.9rem" }}>
        Server-authoritative combat · 24-player target
      </p>

      <div
        style={{
          marginTop: "2rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.6rem",
          width: "min(360px, 92vw)",
        }}
      >
        <button
          data-testid="lobby-create"
          onClick={onCreate}
          disabled={busy}
          style={{
            padding: "0.8rem 1rem",
            background: busy ? "#444" : "#3563d3",
            color: "#fff",
            border: 0,
            borderRadius: "6px",
            cursor: busy ? "default" : "pointer",
            fontSize: "1rem",
          }}
        >
          Create room
        </button>
        <div style={{ display: "flex", gap: "0.4rem" }}>
          <input
            data-testid="lobby-code"
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value)}
            placeholder="Room code"
            spellCheck={false}
            autoComplete="off"
            style={{
              flex: 1,
              padding: "0.8rem",
              background: "#181820",
              color: "#e6e6ea",
              border: "1px solid #333",
              borderRadius: "6px",
              fontFamily: "monospace",
              fontSize: "0.95rem",
            }}
          />
          <button
            data-testid="lobby-join"
            onClick={onJoin}
            disabled={busy || !joinCode.trim()}
            style={{
              padding: "0.8rem 1rem",
              background: busy || !joinCode.trim() ? "#444" : "#2c8c4d",
              color: "#fff",
              border: 0,
              borderRadius: "6px",
              cursor: busy || !joinCode.trim() ? "default" : "pointer",
              fontSize: "1rem",
            }}
          >
            Join
          </button>
        </div>

        {error && (
          <p
            data-testid="lobby-error"
            style={{ color: "#e07b7b", margin: "0.4rem 0 0", fontSize: "0.9rem" }}
          >
            {error}
          </p>
        )}
      </div>

      <p style={{ marginTop: "2rem", fontSize: "0.75rem", opacity: 0.5 }}>
        Matchmaker: <code>{origin}</code>
      </p>
    </div>
  );
}