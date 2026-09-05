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

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  isMatchmakerNetworkError,
  roomApi,
} from "../net/matchmakerApi";

const DEV_MATCHMAKER_ORIGIN = "http://127.0.0.1:18080";
// Production (Tailscale Funnel) — wired by the Funnel deploy script.
// Matches the static client's URL so the lobby's same-origin POST /rooms
// hits the static server (which proxies to the matchmaker). The static
// URL is `https://m5.tail1b3795.ts.net:14432/` (Funnel + port; see
// tools/deploy-prod.sh + docs/funnel-deploy.md §"Funnel deploy topology").
const PROD_MATCHMAKER_ORIGIN = "https://m5.tail1b3795.ts.net:14432";

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
  // PR 94 (lobby a11y) — DOM refs for focus management. The modal
  // container is the focus-trap boundary (the keydown listener
  // attaches here). The code input + Join button are the two
  // focusable elements we cycle between with Tab/Shift+Tab.
  //
  // **Why Create sits OUTSIDE the focus trap (intentional design)**: the
  // trap exists to keep keyboard-only users from tabbing into the
  // background page while a dialog is open. The modal has exactly two
  // interactive elements (input + Join button); tabbing between them
  // is enough to fill in the room code and join. The Create button is
  // outside the trap so it's reachable via:
  //   1. Direct mouse/touch click (the common path on desktop).
  //   2. Tabbing in from outside the modal (e.g. after restoring focus
  //      to <body> or to a preceding element).
  //   3. Programmatic focus() if a future feature needs it.
  // The trap is "soft" in the sense that it doesn't block
  // document.activeElement from being moved by external code — it only
  // handles Tab/Shift+Tab keydowns. This is the documented
  // WAI-ARIA-1.2 dialog-focus-management pattern (avoid trapping users
  // who want to back out of the modal).
  //
  // The previously-focused ref captures whatever element had focus
  // before the lobby mounted, so we can restore focus when the
  // lobby unmounts.
  const modalRef = useRef<HTMLDivElement>(null);
  const codeInputRef = useRef<HTMLInputElement>(null);
  const joinButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
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
      // PR 11.9 follow-up (Hetzner staging, 2026-09-04): the matchmaker
      // returns BOTH `ws_url` (plain) AND `wss_url` (TLS). Pick the
      // secure variant when the lobby page itself is HTTPS, otherwise
      // the browser's mixed-content blocker silently drops the WSS
      // handshake. (Workaround was `VITE_MATCHMAKER_ORIGIN=https://...`
      // build-time env var on Hetzner; this fix removes it.)
      const { ws_url, wss_url } = await roomApi.createRoom(origin);
      const serverUrl =
        window.location.protocol === "https:" ? wss_url ?? ws_url : ws_url;
      // Navigate to the same page with `?server=<serverUrl>`. PeerOverlay
      // picks up the flag on module re-evaluation and wires the
      // ServerTransport. (No need to reset `creating` — the page
      // navigates away on the next tick.)
      const target = new URL(window.location.href);
      target.searchParams.set("server", serverUrl);
      // PR #134 — append `&localId=<id>` so the lobby is the
      // single source of truth for player identity. The creator
      // is always id=1 (the first connection into a fresh room
      // — the server's per-room `Room::next_player_id` starts at
      // 1, server/src/session.rs). PeerOverlay reads this URL
      // param into `window.__localPlayerId` (see
      // client/src/ui/PeerOverlay.tsx), which wireServerTransport
      // consumes as `claimed_player_id` on the wire. Without
      // this, both tabs defaulted to localId=1, both spawned at
      // the same world position, and the snapshot's playerId
      // lookup mis-routed DamageBroadcasts (the pre-#134 lobby
      // bug). The real-player perspective: a player clicking
      // "Create" expects to be player 1.
      target.searchParams.set("localId", "1");
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
      // Build ws:// URL from the matchmaker's response. The matchmaker
      // knows its own WS listener's host:port (it's the one serving
      // this GET), so it returns `ws_url` in the same shape as
      // POST /rooms. Previously this used `window.location.host` —
      // i.e. the lobby page's host:port — which is Vite's dev-server
      // port (5194) in dev, NOT the WS listener's port (14934). That
      // would have navigated the lobby to a broken URL and the
      // browser would have ERR_CONNECTION_REFUSED on join. The
      // matchmaker's ws_url (PR 95 fix to GET /rooms/<id>) is the
      // authoritative answer. Caught by the real-canary smoke on
      // 2026-09-01 (PR #94 follow-up).
      // PR 11.9 follow-up (Hetzner staging, 2026-09-04): same HTTPS-aware
      // URL pick as onCreate above. The matchmaker already returns
      // both `ws_url` and `wss_url`; use the secure variant when the
      // lobby page is on HTTPS so the WSS handshake isn't blocked by
      // the browser's mixed-content rules.
      const serverUrl =
        window.location.protocol === "https:"
          ? r.wss_url ?? r.ws_url
          : r.ws_url;
      const target = new URL(window.location.href);
      target.searchParams.set("server", serverUrl);
      // PR #134 — append `&localId=<players+1>` so the lobby
      // is the single source of truth for player identity. The
      // matchmaker's `GET /rooms/<id>` returns `players` (the
      // current connection count from `room.connections.len()`),
      // so `players + 1` is the next available per-room id (the
      // server's `Room::next_player_id` allocates 1, 2, 3, ...
      // per connection, server/src/session.rs). This must be set
      // BEFORE the navigation — `window.location.href = ...`
      // tears the page down on the next tick. PeerOverlay reads
      // this URL param into `window.__localPlayerId` (see
      // client/src/ui/PeerOverlay.tsx) which flows through
      // `claimed_player_id` on the wire to the server's
      // collision-safe promotion block (server/src/transport.rs).
      // The real-player perspective: a player joining a
      // friend's room expects to be the next available player.
      target.searchParams.set("localId", String(r.players + 1));
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

  // PR 94 (lobby a11y) — focus management. Three effects:
  //
  //   1. Capture previously-focused element on mount + focus the
  //      code input (the modal's first focusable) on the next
  //      animation frame. requestAnimationFrame defers the focus
  //      until after the modal paints, so focus doesn't land on
  //      <body> before the input is mounted in some browsers.
  //      **Known race in StrictMode (dev-only, no production impact)**:
  //      React 18's StrictMode mounts → unmounts → remounts the
  //      component in dev for invariant-checking. The first mount's
  //      `requestAnimationFrame` callback can fire AFTER the
  //      unmount, focusing a stale node that no longer exists. The
  //      workaround would be to track a mounted ref and bail in the
  //      raf callback. We intentionally do NOT do this because:
  //      (a) it never ships to production (this is dev-only behavior;
  //          import.meta.env.DEV's StrictMode is stripped from
  //          prod bundles by Vite);
  //      (b) Claude Code review (PR #94) explicitly flagged this
  //          race as "no fix needed currently";
  //      (c) the worst-case symptom in dev is a console warning
  //          ("Component is not a focusable element") which doesn't
  //          affect functionality. Tracked in PR #94's review
  //          follow-up section; deferred until a real symptom
  //          appears (e.g. flaky focus state in production smoke).
  //   2. Restore focus to the previously-focused element on
  //      unmount. On successful navigation this is a no-op (the
  //      destination page is a fresh document). On external
  //      `?lobby=1` removal the previously-focused element is
  //      stale (about to unmount) but the .focus() call is still
  //      cheap and safe.
  //   3. Focus trap: Tab from Join → Code, Shift+Tab from Code →
  //      Join. Plain keydown listener on the modal container
  //      (matches the brief's recommended simpler approach vs
  //      <dialog> element + polyfills). The Create button sits
  //      outside the trap — direct click or external tab-in.
  useEffect(() => {
    previouslyFocusedRef.current =
      document.activeElement as HTMLElement | null;
    const raf = requestAnimationFrame(() => {
      codeInputRef.current?.focus();
    });
    return () => {
      cancelAnimationFrame(raf);
      previouslyFocusedRef.current?.focus();
    };
  }, []);

  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const code = codeInputRef.current;
      const join = joinButtonRef.current;
      if (!code || !join) return;
      const active = document.activeElement;
      if (e.shiftKey) {
        // Shift+Tab from Code → Join.
        if (active === code) {
          e.preventDefault();
          join.focus();
        }
      } else {
        // Tab from Join → Code.
        if (active === join) {
          e.preventDefault();
          code.focus();
        }
      }
    };
    modal.addEventListener("keydown", onKey);
    return () => modal.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      data-testid="lobby"
      // PR 94 (lobby a11y) — role=dialog + aria-modal=true tells
      // assistive tech this is a modal surface (focus is trapped,
      // outside content is inert). aria-labelledby points to the
      // <h1> below so screen readers announce "Specialists" as
      // the modal title when it opens.
      role="dialog"
      aria-modal="true"
      aria-labelledby="lobby-title"
      ref={modalRef}
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
      <h1 id="lobby-title" style={{ fontSize: "1.6rem", margin: "0 0 0.4rem" }}>Specialists</h1>
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
          aria-label="Create a new room"
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
            aria-label="Room code"
            aria-describedby="lobby-code-help"
            ref={codeInputRef}
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
            aria-label="Join an existing room by code"
            ref={joinButtonRef}
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

        {/*
         * PR 94 (lobby a11y) — input help text. The code input's
         * `aria-describedby="lobby-code-help"` points here so
         * screen readers announce the hint alongside the input's
         * accessible name ("Room code"). Visible to sighted
         * users too — visible help text is more discoverable than
         * tooltip-only patterns. The brief specifies this exact id.
         */}
        <p
          id="lobby-code-help"
          style={{ margin: 0, opacity: 0.7, fontSize: "0.8rem" }}
        >
          Ask the host for the room code.
        </p>

        {renderRoomStatus()}
        {/*
         * PR 94 (lobby a11y) — aria-live="polite" wrapper around the
         * inline message slot. Screen readers announce status /
         * error changes ("Creating room…", "Matchmaker unreachable")
         * without stealing focus. WCAG 4.1.3 (Status Messages). The
         * wrapper is always present in the DOM; the inner <p>
         * (lobby-busy or lobby-error) mounts/unmounts based on
         * status / error state.
         */}
        <div
          aria-live="polite"
          aria-atomic="true"
          data-testid="lobby-live-region"
        >
          {renderInlineMessage()}
        </div>
      </div>

      <p style={{ marginTop: "2rem", fontSize: "0.75rem", opacity: 0.5 }}>
        Matchmaker: <code>{origin}</code>
      </p>
    </div>
  );
}
