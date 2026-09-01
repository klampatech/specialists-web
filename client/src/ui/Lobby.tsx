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
//     found" error. On `exists:true, players>=max`, surfaces a
//     "Room full" error and stays put.
//
// The matchmaker HTTP origin is derived from the page's own origin
// in dev (`http://localhost:5174/`) or from a hard-coded production
// URL (`https://m5.<tailnet>.ts.net:8080/`). For v1, hard-code the
// dev origin (matches the canary's `port_http = 8080` default).
// Production will pass this via env / build-time var.
//
// PR 11.9 follow-up (lobby polish):
//   - Per-action busy state (`creating` vs `joining`) so the other
//     button stays clickable while one is in-flight.
//   - Inline "Creating room…" / "Checking room…" status text in
//     neutral color (sharing the error slot — the same data-testid
//     carries both kinds of message but the color differs).
//   - Player-count indicator (`N/M`) appears next to the input ONLY
//     after a successful getRoom — never pre-fetched.
//   - Network-layer errors (fetch() itself rejected) are special-
//     cased with "Matchmaker unreachable" via
//     `isMatchmakerNetworkError(err)` from matchmakerApi.
//   - Errors clear on the next user interaction (typing or
//     clicking either button) — cleanest UX without a timer.

import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  isMatchmakerNetworkError,
  roomApi,
} from "../net/matchmakerApi";

const DEV_MATCHMAKER_ORIGIN = "http://127.0.0.1:18080";
// Production (Tailscale Funnel) — will be wired in PR 11.11.
// Matches `tools/specialists-server.service`'s Funnel-served URL.
const PROD_MATCHMAKER_ORIGIN = "https://m5.tail1b3795.ts.net";

/** After a successful getRoom(), the player-count indicator has
 *  one of three states: not-yet-checked (roomStatus is null), the
 *  room has space (green), or the room is full (red). */
type RoomStatus =
  | { kind: "ok"; id: string; players: number; max: number }
  | { kind: "full"; id: string; players: number; max: number };

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
  // Per-action busy: "creating" and "joining" are independent so
  // clicking one doesn't disable the other. A user who started
  // Create can still type a code and click Join (and vice versa).
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  // Monotonic counter for in-flight getRoom() fetches. Stored
  // as a ref (not state) because we need to read the LATEST
  // value synchronously in the post-await check — React state
  // updates are async, so a state read inside the same event
  // tick would return the stale value. Suppresses the stale-
  // fetch race where the user types a new code while a
  // previous fetch is still in flight (caught by Claude Code
  // review, 2026-08-31).
  const joinSeqRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  // Inline status text shown while a fetch is in flight. Lives
  // in the same data-testid slot as `error` but with a neutral
  // color (not red) so the user knows the action is progressing.
  const [status, setStatus] = useState<string | null>(null);
  // Player-count indicator state. Set only after a successful
  // getRoom() that returned `exists:true`. Cleared on input
  // change so the user can re-type a fresh code without the
  // stale indicator lingering.
  const [roomStatus, setRoomStatus] = useState<RoomStatus | null>(null);

  /** Clear the error slot on the next user interaction (typing
   *  into the input, or clicking either button). Wired into
   *  onChange/onClick instead of a setTimeout — cleanest UX per
   *  the brief. */
  const clearError = () => {
    if (error !== null) setError(null);
  };

  const onCreate = async () => {
    // `flushSync` forces the "Creating room…" + disabled-button
    // state into the DOM BEFORE the await yields. Without it,
    // React 18 batches the update and the navigation triggered
    // after the fetch resolves can race the re-render — the
    // busy state would never paint. flushSync is the one
    // documented escape hatch for "I need the DOM to reflect
    // state before the next line runs."
    flushSync(() => {
      clearError();
      setStatus("Creating room…");
      setCreating(true);
    });
    try {
      const { ws_url } = await roomApi.createRoom(origin);
      // Navigate to the same page with `?server=<ws_url>`. PeerOverlay
      // picks up the flag on module re-evaluation and wires the
      // ServerTransport. (No need to reset `creating` — the page
      // navigates away on the next tick.)
      const target = new URL(window.location.href);
      target.searchParams.set("server", ws_url);
      // Popup-blocker / sandboxed-frame / etc. recovery (NB #3). The
      // browser can throw on `window.location.href = ...` if it
      // refuses the navigation. Without this try/catch, a blocked
      // nav would leave `creating: true` forever with no error —
      // the button would just sit greyed out. Reset state + surface
      // a friendly message so the user can retry.
      try {
        window.location.href = target.toString();
      } catch (navErr) {
        setStatus(null);
        setError(
          "Navigation blocked. Click again or allow popups for this site.",
        );
        setCreating(false);
      }
    } catch (e) {
      setStatus(null);
      if (isMatchmakerNetworkError(e)) {
        setError("Matchmaker unreachable — check your connection and try again.");
      } else {
        setError(`Failed to create room: ${(e as Error).message}`);
      }
      setCreating(false);
    }
  };

  const onJoin = async () => {
    const id = joinCode.trim();
    if (!id) {
      setError("Enter a room code");
      setStatus(null);
      return;
    }
    // See the matching `flushSync` in onCreate — same rationale:
    // we want the "Checking room…" status to paint before the
    // GET /rooms/<id> fetch yields. The post-await flushSync
    // below covers the success path (the roomStatus indicator
    // must be in the DOM before the page navigates away).
    flushSync(() => {
      clearError();
      setRoomStatus(null);
      setStatus("Checking room…");
      setJoining(true);
    });
    // Stamp this fetch with a monotonic seq (via ref, not state, so
    // the post-await check sees the latest value synchronously). If
    // the user types a new code while we're awaiting, the latest
    // ref value will differ from this captured one and we'll skip
    // the stale roomStatus write below. Caught by Claude Code review.
    joinSeqRef.current += 1;
    const seq = joinSeqRef.current;
    try {
      const r = await roomApi.getRoom(origin, id);
      // got a definitive response — drop the in-flight status.
      setStatus(null);
      if (seq !== joinSeqRef.current) {
        // A newer fetch has started (user retyped). Drop this
        // stale response silently — the latest fetch will paint
        // its own status + roomStatus when it resolves.
        return;
      }
      if (!r.exists) {
        // flushSync parity with the full-room branch directly below:
        // the 3 setStates here are the "not found" path's terminal
        // state write, and we want them committed to the DOM BEFORE
        // the function returns (so the smoke's 10ms polling catches
        // them deterministically). Without flushSync, React 18 batches
        // them and a fast click race can leave the DOM stale for a
        // frame — caught by Claude Code cross-vendor review (Nit #1).
        flushSync(() => {
          setError(`Room "${id}" not found. Ask the host to share a fresh link.`);
          setRoomStatus(null);
          setJoining(false);
        });
        return;
      }
      if (r.players >= r.max) {
        // Room is real but full — show the indicator + a clear
        // error and DO NOT navigate. Better UX than the old
        // behavior (silently navigate then disconnect on join).
        flushSync(() => {
          setError(
            `Room "${id}" is full (${r.players}/${r.max} players). Try another.`,
          );
          setRoomStatus({
            kind: "full",
            id,
            players: r.players,
            max: r.max,
          });
          setJoining(false);
        });
        return;
      }
      // Room exists with space — record the indicator (green)
      // and proceed to navigate.
      // flushSync so the players/max indicator is in the DOM
      // before window.location.href triggers navigation — the
      // smoke (and a real user) needs the indicator to be
      // visible, not stranded in a pending React update.
      flushSync(() => {
        setRoomStatus({
          kind: "ok",
          id,
          players: r.players,
          max: r.max,
        });
      });
      // Yield one microtask so the post-flushSync DOM is
      // observably committed before we tear it down with a
      // navigation. Without this, a real user would see the
      // indicator for ~1 frame and the lobby smoke can't
      // catch it at all (the navigation races the
      // requestAnimationFrame poll). The yield is invisible
      // to the user (sub-millisecond) but enough for the
      // browser to commit the React-driven DOM update. We
      // use Promise.resolve() (a microtask) instead of
      // setTimeout(0) (a macrotask) because React's
      // concurrent renderer + MutationObserver callbacks
      // both run as microtasks — setTimeout(0) would
      // over-yield into a 4ms+ idle window the smoke
      // didn't need. Caught by Claude Code cross-vendor
      // review (NB #4).
      await Promise.resolve();
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
      // Same popup-blocker recovery shape as onCreate above:
      // a throw here means the browser refused the navigation
      // (popup blocker, sandboxed iframe, etc.) and we need to
      // unwind the joining=true state + surface a clear error.
      try {
        window.location.href = target.toString();
      } catch (navErr) {
        setStatus(null);
        setError(
          "Navigation blocked. Click again or allow popups for this site.",
        );
        setJoining(false);
      }
    } catch (e) {
      setStatus(null);
      setRoomStatus(null);
      if (isMatchmakerNetworkError(e)) {
        setError("Matchmaker unreachable — check your connection and try again.");
      } else {
        setError(`Failed to check room: ${(e as Error).message}`);
      }
      setJoining(false);
    }
  };

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setJoinCode(e.target.value);
    // Reset transient UI state on any keystroke. The error
    // clears per the brief; the room-status indicator also
    // clears because the user is clearly starting over.
    clearError();
    if (roomStatus !== null) setRoomStatus(null);
  };

  /** Combined "inline message" renderer. The lobby uses a
   *  single DOM slot for both the in-flight `status` text
   *  (neutral color) and the persistent `error` text (red).
   *  `status` takes precedence while the user is waiting,
   *  because the fetch is still in flight and the error is
   *  stale. Both share the `data-testid="lobby-error"`
   *  attribute so existing smoke selectors keep working
   *  (the brief locks that testid in). */
  const renderInlineMessage = () => {
    if (status) {
      return (
        <p
          data-testid="lobby-busy"
          data-kind="busy"
          style={{
            color: "#a9b3c7",
            margin: "0.4rem 0 0",
            fontSize: "0.9rem",
          }}
        >
          {status}
        </p>
      );
    }
    if (error) {
      return (
        <p
          data-testid="lobby-error"
          data-kind="error"
          style={{
            color: "#e07b7b",
            margin: "0.4rem 0 0",
            fontSize: "0.9rem",
          }}
        >
          {error}
        </p>
      );
    }
    return null;
  };

  /** The player-count indicator. Shown only after a successful
   *  getRoom() — never pre-fetched, never fabricated from the
   *  input alone. Green if the room has space, red if full. */
  const renderRoomStatus = () => {
    if (!roomStatus) return null;
    const isFull = roomStatus.kind === "full";
    return (
      <p
        data-testid="lobby-room-status"
        data-full={isFull ? "true" : "false"}
        style={{
          color: isFull ? "#e07b7b" : "#7bd17b",
          margin: "0.4rem 0 0",
          fontSize: "0.85rem",
          fontFamily: "monospace",
        }}
      >
        Room {roomStatus.id}: {roomStatus.players}/{roomStatus.max} players
        {isFull ? " (full)" : ""}
      </p>
    );
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
          disabled={creating}
          style={{
            padding: "0.8rem 1rem",
            background: creating ? "#444" : "#3563d3",
            color: "#fff",
            border: 0,
            borderRadius: "6px",
            cursor: creating ? "default" : "pointer",
            fontSize: "1rem",
          }}
        >
          Create room
        </button>
        <div style={{ display: "flex", gap: "0.4rem" }}>
          <input
            data-testid="lobby-code"
            value={joinCode}
            onChange={onInputChange}
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
            disabled={joining || !joinCode.trim()}
            style={{
              padding: "0.8rem 1rem",
              background: joining || !joinCode.trim() ? "#444" : "#2c8c4d",
              color: "#fff",
              border: 0,
              borderRadius: "6px",
              cursor: joining || !joinCode.trim() ? "default" : "pointer",
              fontSize: "1rem",
            }}
          >
            Join
          </button>
        </div>

        {renderRoomStatus()}
        {renderInlineMessage()}
      </div>

      <p style={{ marginTop: "2rem", fontSize: "0.75rem", opacity: 0.5 }}>
        Matchmaker: <code>{origin}</code>
      </p>
    </div>
  );
}
