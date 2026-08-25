// PR 11.6.C / §3.3 — client-side transport for the server-auth damage
// architecture.
//
// **Primary transport**: browser `WebTransport` (HTTP/3 over QUIC).
// **Fallback transport**: native `WebSocket` on TCP. `connect()`
// tries WebTransport first; on any failure (constructor exception,
// `ready` rejection, session error), falls back to WebSocket. Only
// rejects the returned Promise if BOTH transports fail.
//
// **Multiplexing**: every wire packet carries a discriminator byte as
// its first byte. Inbound packets are dispatched on the discriminator
// to the matching `onX` listener list (multiple listeners per type are
// allowed — the transport fans out internally).
//
// **Send shape (PR 11.6.C review fix B2)**: every TS encoder produces
// the full on-the-wire bytes (discriminator + body). `sendRaw` is a
// pure pass-through — no heuristic to strip a duplicate discriminator,
// no byte-order ambiguity. Every packet that leaves the client is
// `disc + body` exactly as encoded.
//
// On WebTransport we open a new bi-directional stream per packet
// (simple, low overhead). The server's `handle_binary` dispatcher
// reads the discriminator as `payload[0]` and decodes the body from
// `payload[1..]`. Inbound server-initiated broadcasts (PR 11.6.D's
// DamageBroadcast fan-out to other tabs) flow over either
// `incomingUnidirectionalStreams` (server pushes a stream the client
// reads) or `datagrams` (one-shot datagrams for tiny messages like
// Pong) — see `installWebTransportInboundLoop`.
//
// On WebSocket we send a single Binary frame; inbound frames go
// through `handleInbound`.
//
// **RTT tracking**: every Ping/Pong round-trip updates a rolling
// median of recent samples. `getStats().rttMs` returns the current
// median (or 0 if no samples yet). The window size is small (last 8
// samples) so the number reacts quickly to network changes.
//
// **§1.2 seam**: `sendInputs(p)` sends a discriminator-prefixed
// `InputsServer` packet. PR 11.6.C's smoke exercises it directly;
// PR 11.6.D wires `gameSession.submitLocalInput` to call it
// (the §1.2 seam that PR 11.6.B added to gameSession.ts).
//
// **Browser WebTransport caveat**: headless Chromium won't honor
// `WebTransport` requests to a self-signed cert unless we pass
// `--ignore-certificate-errors` to the Playwright launcher. The
// smoke does this; real-browser dev uses the system trust store.

import {
  DISCRIMINATOR_DAMAGE_BROADCAST,
  DISCRIMINATOR_DAMAGE_REJECT,
  DISCRIMINATOR_DAMAGE_REQUEST,
  DISCRIMINATOR_INPUTS,
  DISCRIMINATOR_INPUTS_SERVER,
  DISCRIMINATOR_PING,
  DISCRIMINATOR_PONG,
  DISCRIMINATOR_POSITION_UPDATE,
  encodeDamageRequest,
  encodeInputsServer,
  encodePing,
  encodePositionUpdate,
} from "../../../protocol/damage";
// PR 11.7.E / §3.5 — ReloadRequest wire type. The client only
// SENDS ReloadRequests (no inbound 0x09 dispatch — the server is
// the sole source of post-reload state, carried by the next 20Hz
// Snapshot fan-out). Encoder mirrors Rust `encode_reload_request`.
import { encodeReloadRequest } from "../../../protocol/reload";
import type { ReloadRequest } from "../../../protocol/reload";
import { DISCRIMINATOR_SNAPSHOT } from "../../../protocol/snapshot";
import type {
  DamageRequest,
  InputsServer,
  Ping,
  PositionUpdate,
 } from "../../../protocol/damage";

/** Underlying transport type reported by `getStats()`. */
export type TransportKind = "webtransport" | "websocket";

/** Stats reported by `getStats()`. */
export interface ServerTransportStats {
  /** Rolling-median RTT in milliseconds. `0` if no Ping/Pong samples yet. */
  rttMs: number;
  /** Which transport is currently active. */
  transport?: TransportKind;
  /** True once `connect()` has resolved. */
  connected: boolean;
}

/** Listener registry. Multiple listeners per channel. */
type ListenerMap = {
  inputs: Array<(p: Uint8Array) => void>;
  damageBroadcast: Array<(p: Uint8Array) => void>;
  /** PR 11.6.D FIX 4: private server-to-source-tab reject signals.
   *  Wire-format stable since PR 11.6.D (server `ca9f177`); the
   *  client just didn't dispatch them before fix4. */
  damageReject: Array<(p: Uint8Array) => void>;
  /** PR 11.7.C / §3.7 + §3.8: server → client authoritative-state
   *  broadcast at 20Hz (`SNAPSHOT_RATE_HZ`). The predictor (LOCAL
   *  player reconciliation) + the interpolator (REMOTE player
   *  buffer) both consume this. The body bytes are the post-
   *  discriminator payload — listener calls `decodeSnapshot` to
   *  parse the typed `Snapshot`. */
  snapshot: Array<(p: Uint8Array) => void>;
  pong: Array<(p: Uint8Array) => void>;
  disconnect: Array<() => void>;
};

function emptyListeners(): ListenerMap {
  return {inputs: [], damageBroadcast: [], damageReject: [], snapshot: [], pong: [], disconnect: []};
}

/** Window of recent RTT samples (ms). */
const RTT_WINDOW = 8;
/** Initial ping delay — the first ping fires after this delay on connect. */
const INITIAL_PING_DELAY_MS = 250;
/** Ping interval after the first (1Hz per §3.10). */
const PING_INTERVAL_MS = 1000;
/** Inbound WebTransport stream read timeout — guards against the
 *  server hanging mid-stream. 5s matches the server-side heartbeat. */
const WT_INBOUND_STREAM_READ_TIMEOUT_MS = 5000;

// PR 11.7+ / AutoReconnect — health-check + reconnect-backoff constants.
// Reconnect triggers when `this.connected` is false for at least
// STALE_THRESHOLD_MS (server may be mid-restart). After the first
// failed retry, RECONNECT_BACKOFF_MS doubles per attempt up to
// RECONNECT_BACKOFF_MAX_MS, then stays at the cap. This bounds
// retry pressure when the server is genuinely down.
const RECONNECT_STALE_THRESHOLD_MS = 2_000;
const RECONNECT_BACKOFF_MS = 1_000;
const RECONNECT_BACKOFF_MAX_MS = 30_000;

export class ServerTransport {
  private readonly wtUrl: string;
  private readonly wsUrl: string;
  private listeners: ListenerMap = emptyListeners();
  private wt: WebTransport | null = null;
  private ws: WebSocket | null = null;
  private activeKind: TransportKind | null = null;
  private connected = false;
  private rttSamples: number[] = [];
  private lastPingSentAt: number | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  // PR 11.7+ / AutoReconnect — separates the two reasons `close()` may
  // have flipped `this.closed`:
  //   - `closed` (the existing field) stays true after `close()` runs.
  //   - `userClosed` is set ONLY when the caller invoked `close()` as
  //     a terminal teardown (e.g., page unload, smoke teardown). The
  //     auto-reconnect health-check skips retry attempts when this is
  //     true. For server-initiated drops (`wt.closed` resolves,
  //     `ws.onclose` fires) `userClosed` remains false and the
  //     health-check will retry.
  // Also tracks the timestamp of the last disconnect so the
  // health-check can apply RECONNECT_STALE_THRESHOLD_MS grace before
  // the first retry (avoids hammering a server that's mid-restart).
  private userClosed = false;
  private lastDisconnectAt: number | null = null;
  // Backoff state: doubles after each failed attempt up to the cap.
  // Reset to RECONNECT_BACKOFF_MS on a successful reconnect.
  private reconnectBackoffMs = RECONNECT_BACKOFF_MS;
  private reconnectHealthCheckTimer: ReturnType<typeof setInterval> | null = null;
  // Tracks an in-flight reconnect attempt so the health-check doesn't
  // stack multiple parallel `connect()` calls (the connect path
  // already rejects on re-entry, but a second microtask-scheduled
  // attempt before the first resolves would lose the race).
  private reconnecting = false;
  // PR 11.7+ / AutoReconnect — the health-check uses a single
  // `setTimeout` whose period is `reconnectBackoffMs` (which doubles
  // after failed attempts). The function is reassigned in
  // `startAutoReconnect` so it can close over the `tick` closure;
  // declared here as a no-op default so TypeScript sees the field
  // shape before `startAutoReconnect` runs.
  private scheduleNextHealthCheckTick: () => void = () => {
    /* replaced in startAutoReconnect on first disconnect */
  };
  // Cache the visibility listener so we can remove it on `close()`.
  private onVisibilityChange: (() => void) | null = null;
  private onWsMessage: ((ev: MessageEvent) => void) | null = null;
  private onWsClose: (() => void) | null = null;

  /**
   * @param urlBase Base URL for the server, e.g. `http://localhost:5190`
   *   (vite proxy) or `http://192.168.1.10:5190`. The transport derives
   *   the WebTransport URL as `https://<host>:4433/rooms/<roomId>` and
   *   the WebSocket URL as `ws://<host>:4434/rooms/<roomId>`.
   * @param roomId The room to join (PR 11.6.C hard-codes `"DEVBX"`).
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(urlBase: string, roomId: string) {
    const u = new URL(urlBase);
    const host = u.hostname;
    // WebTransport: HTTPS + UDP/4433. We need the TLS port; the
    // canary server's `--port-wt` flag determines this. The smoke
    // uses 14433 by default — but for the proxy-mounted case (vite
    // proxies `/rooms/...` to the server) we'd need different
    // routing. For PR 11.6.C the smoke uses the direct port (no
    // proxy), so the WebTransport URL is `https://<host>:14433`.
    // The transport reads the WT port from a global probe the smoke
    // sets (`window.__damageServerPorts`), defaulting to 14433.
    const ports = (globalThis as unknown as {__damageServerPorts?: {wt?: number; ws?: number}}).__damageServerPorts;
    const wtPort = ports?.wt ?? 14433;
    const wsPort = ports?.ws ?? 14434;
    this.wtUrl = `https://${host}:${wtPort}/rooms/${roomId}`;
    this.wsUrl = `ws://${host}:${wsPort}/rooms/${roomId}`;
    // PR 11.7.D3 / known-issue — if the page is loaded over HTTPS, this
    // ws:// URL is mixed-content-blocked. The local-dev canary serves
    // plain WS only (not WSS); production must terminate TLS at a
    // reverse proxy layer that flips ws:// → wss:// based on the page
    // protocol. Tracked as a known issue.
    if (typeof location !== "undefined" && location.protocol === "https:") {
      console.warn(
        `[ServerTransport] page is HTTPS but ws://${host}:${wsPort}/rooms/${roomId} is mixed-content-blocked. ` +
        `Production needs a TLS-terminating reverse proxy; local-dev needs HTTP.`,
      );
    }
  }

  /**
   * Open the transport. Tries WebTransport first, falls back to
   * WebSocket on any failure. Resolves when EITHER transport is ready
   * for send/receive. Rejects only if BOTH fail.
   *
   * PR 11.7+ / AutoReconnect — `connect()` is now idempotent across
   * server-initiated disconnects. After a drop the field
   * `this.closed` is true; on retry the health-check calls `connect()`
   * again, which now resets `this.closed = false` (NOT when the caller
   * invoked `close()` deliberately — that's gated on `userClosed`,
   * which throws here as before).
   */
  async connect(): Promise<void> {
    if (this.connected) {
      // Already connected (e.g., the health-check fired while a sibling
      // mount reconnected via `connect()` directly). Treat as success.
      return;
    }
    if (this.userClosed) {
      throw new Error("ServerTransport: already closed (userClosed=true; use a new instance to reconnect)");
    }
    // PR 11.7+ / AutoReconnect — reset the `closed` flag for retry.
    // The auto-reconnect health-check is the only legitimate caller
    // here after a server-initiated drop; resetting is safe.
    if (this.closed) this.closed = false;
    // PR 11.7+ / AutoReconnect — guard against stacked parallel
    // `connect()` calls. A microtask race could fire this twice before
    // the first resolves; without this guard the second call would
    // spawn a duplicate WebTransport constructor (which throws
    // synchronously on URL parse failure, but only after we've already
    // leaked `wt.ready` listeners). The flag flips back to false in
    // the success/failure branches below.
    if (this.reconnecting) return;
    this.reconnecting = true;
    try {
      // Try WebTransport first. If it fails (constructor exception or
      // ready rejection), fall back to WebSocket. We catch and swallow
      // the WT failure here so the caller sees a single resolution (or
      // a single rejection if BOTH transports fail).
      try {
        await this.connectWebTransport();
        // PR 11.7+ / AutoReconnect (Claude review B1) — if the user
        // invoked dispose() while this connect was awaiting, do NOT
        // flip `this.connected = true`. The fresh transport handle is
        // already torn down by close()/dispose() — re-opening state
        // here would create the inconsistent
        // `{closed:true, userClosed:true, connected:true}` triple.
        if (this.userClosed || this.closed) return;
        this.activeKind = "webtransport";
        this.connected = true;
        this.startPingTimer();
        this.onReconnectSucceeded();
        return;
      } catch (wtErr) {
        // eslint-disable-next-line no-console
        console.warn(`[ServerTransport] WebTransport failed, falling back to WebSocket: ${wtErr}`);
      }
      try {
        await this.connectWebSocket();
        // PR 11.7+ / AutoReconnect (Claude review B1) — same guard
        // as the WT success path: a user-initiated dispose() that
        // landed during the WS handshake must not flip connected=true.
        if (this.userClosed || this.closed) return;
        this.activeKind = "websocket";
        this.connected = true;
        this.startPingTimer();
        this.onReconnectSucceeded();
      } catch (wsErr) {
        this.onReconnectFailed();
        throw new Error(
          `ServerTransport.connect: both WebTransport (see warn above) and WebSocket (${wsErr}) failed`,
        );
      }
    } finally {
      this.reconnecting = false;
    }
  }

  /** Send an InputsServer packet (PR 11.6.C: smoke drives this directly;
   *  PR 11.6.D: `gameSession.submitLocalInput` calls this). */
  sendInputs(p: Uint8Array | InputsServer): void {
    const bytes = p instanceof Uint8Array ? p : encodeInputsServer(p);
    this.sendRaw(bytes);
  }

  /** Register an `onInputs` listener. Multiple listeners are allowed. */
  onInputs(f: (p: Uint8Array) => void): void {
    this.listeners.inputs.push(f);
  }

  /** Send a DamageRequest. */
  sendDamageRequest(p: Uint8Array | DamageRequest): void {
    const bytes = p instanceof Uint8Array ? p : encodeDamageRequest(p);
    this.sendRaw(bytes);
  }

  /**
   * PR 11.7.E / §3.5 — send a typed `ReloadRequest` over the
   * transport. The server validates (`damage_relay::
   * validate_and_relay_reload`, 8 gates paralleling
   * `validate_and_relay`) and on success mutates
   * `room.players[source].ammo = PLAYER_MAX_AMMO`. The next 20Hz
   * Snapshot broadcast (discriminator 0x07) carries the new ammo
   * to every connected tab — no private ack packet.
   *
   * The caller is responsible for the `eventId` monotonicity
   * (use `nextReloadEventId` from `net/damageBus.ts` for the
   * canonical counter). Server-side `RELOAD_EVENT_ID_WINDOW = 64`
   * allows tab reloads to recover without invalidating subsequent
   * requests.
   */
  sendReloadRequest(p: Uint8Array | ReloadRequest): void {
    const bytes = p instanceof Uint8Array ? p : encodeReloadRequest(p);
    this.sendRaw(bytes);
  }

  /** Register an `onDamageBroadcast` listener. */
  onDamageBroadcast(f: (p: Uint8Array) => void): void {
    this.listeners.damageBroadcast.push(f);
  }

  /**
   * PR 11.6.D FIX 4: register an `onDamageReject` listener. The
   * body is the raw 5-byte DamageReject body (discriminator 0x0C
   * already stripped by `handleInbound`). The listener is
   * responsible for decoding — typically `decodeDamageReject`
   * from `protocol/damage.ts`. PR 11.6.D smoke wires this to
   * `damageBus.applyReject(localPlayerId, r.eventId, now)` so
   * the source tab reverts the optimistic apply when the
   * validator rejects a `DamageRequest` (fire-rate, ammo,
   * eventId, lag-miss, no-history). Without this, the source tab
   * would have to wait for the 500ms timeout sweep to roll back
   * the rejected applies — and the sweep over-reverts in the
   * spam phase (each pending entry's actualDelta gets re-added,
   * clamped at maxHp).
   */
  onDamageReject(f: (p: Uint8Array) => void): void {
    this.listeners.damageReject.push(f);
  }

  /**
   * PR 11.7.C / §3.7 + §3.8 — register an `onSnapshot` listener.
   * The body is the post-discriminator bytes from the server's
   * 20Hz authoritative-state broadcast (8-byte header +
   * `player_count * 29` bytes). The listener typically calls
   * `decodeSnapshot` from `protocol/snapshot.ts` and routes the
   * typed `Snapshot` to the predictor (LOCAL reconciliation) +
   * the interpolator (REMOTE buffer). Multiple listeners are
   * allowed (the transport fans out internally).
   *
   * `decodeSnapshot` returns `null` on any size / discriminator
   * mismatch — listeners should silently drop (the transport
   * already logs a warn for a malformed snapshot).
   */
  onSnapshot(f: (p: Uint8Array) => void): void {
    this.listeners.snapshot.push(f);
  }

  /** Send a PositionUpdate. */
  sendPositionUpdate(p: Uint8Array | PositionUpdate): void {
    const bytes = p instanceof Uint8Array ? p : encodePositionUpdate(p);
    this.sendRaw(bytes);
  }

  /** Send a Ping. The server echoes with a Pong; the listener updates
   *  the RTT sample. */
  sendPing(p: Uint8Array | Ping): void {
    const bytes = p instanceof Uint8Array ? p : encodePing(p);
    this.lastPingSentAt = performance.now();
    this.sendRaw(bytes);
  }

  /** Register an `onPong` listener. */
  onPong(f: (p: Uint8Array) => void): void {
    this.listeners.pong.push(f);
  }

  /** Snapshot of current connection state. */
  getStats(): ServerTransportStats {
    return {
      rttMs: this.medianRtt(),
      transport: this.activeKind ?? undefined,
      connected: this.connected,
    };
  }

  /** Register a disconnect listener. Fires exactly once per `close()` call. */
  onDisconnect(f: () => void): void {
    this.listeners.disconnect.push(f);
  }

  /** Close the transport + emit `disconnect` listeners.
   *
   * PR 11.7+ / AutoReconnect — `close()` is no longer strictly
   * terminal when called from a server-initiated drop path. The two
   * call sites that fire it (`wt.closed` resolves, `ws.onclose`
   * fires) are server-driven; they leave `userClosed=false` so the
   * auto-reconnect health-check will retry. To permanently tear
   * down, callers should pass `{user: true}` OR call the new
   * `dispose()` method.
   */
  close(opts: {user?: boolean} = {}): void {
    if (this.closed) return;
    this.closed = true;
    this.userClosed = opts.user === true;
    this.lastDisconnectAt = performance.now();
    // Reset transport-specific state so the next `connect()` doesn't
    // operate on stale handles. `activeKind` is intentionally NOT
    // cleared here — the health-check reads it to decide which
    // transport to prefer (currently it just tries both, but the
    // activeKind field stays meaningful for `getStats().transport`).
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.wt) {
      try {
        this.wt.close();
      } catch {
        // ignore
      }
      this.wt = null;
    }
    if (this.ws && this.onWsClose) {
      try {
        this.ws.removeEventListener("close", this.onWsClose);
      } catch {
        // ignore
      }
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.connected = false;
    for (const f of this.listeners.disconnect) f();
    // PR 11.7+ / AutoReconnect — start the health check + visibility
    // listener ONLY for server-initiated drops (userClosed=false).
    // User-initiated close is terminal; the page is unloading or the
    // smoke is tearing down.
    if (!this.userClosed) {
      this.startAutoReconnect();
    }
  }

  /**
   * PR 11.7+ / AutoReconnect — explicit user-initiated terminal
   * teardown. Equivalent to pre-AutoReconnect `close()`. Use this
   * on page unload (`beforeunload`) or when the smoke is tearing
   * down the test fixtures. Calling `close()` directly after a
   * server drop will also flip `userClosed=true` (the default for
   * explicit closes); only the wt.closed / ws.onclose paths leave
   * `userClosed=false`.
   */
  dispose(): void {
    this.close({user: true});
  }

  // -- Private helpers --------------------------------------------------

  private async connectWebTransport(): Promise<void> {
    // The browser `WebTransport` constructor throws synchronously on
    // URL parse failure, and the `.ready` promise rejects on session
    // setup failure. We await both to surface the right error.
    const wt = new WebTransport(this.wtUrl);
    await wt.ready;
    this.wt = wt;
    // When the session closes (network failure, server shutdown,
    // etc.), emit `disconnect`.
    wt.closed
      .then(() => {
        if (!this.closed) this.close();
      })
      .catch(() => {
        if (!this.closed) this.close();
      });
    // PR 11.6.C review fix B3: install the inbound read loops AFTER
    // `wt.ready` resolves (the streams / datagrams queues are only
    // available once the session is established). Each loop runs in
    // its own un-awaited task so a slow peer can't stall the connect
    // promise.
    void this.runWebTransportInboundLoop(wt);
  }

  /**
   * PR 11.6.C review fix B3: drain inbound WebTransport unidirectional
   * streams + datagrams. Each iteration of `for await…of` blocks until
   * the next stream arrives; the read loop for an individual stream
   * runs in its own async task so a slow stream can't stall the loop
   * (the loop continues accepting new streams while the slow one
   * drains).
   *
   * Inbound payloads are full wire-format packets (disc + body) and
   * are dispatched via `handleInbound` exactly like WebSocket
   * `message` events. This is the path server-initiated broadcasts
   * (PR 11.6.D's DamageBroadcast fan-out) take to reach WebTransport
   * clients.
   */
  private async runWebTransportInboundLoop(wt: WebTransport): Promise<void> {
    try {
      // Inbound unidirectional streams. The server pushes one of these
      // when it has a broadcast to deliver (or any other one-way
      // notification in a future PR).
      const uniLoop = (async () => {
        try {
          // The streams queue is a `ReadableStream` whose values are
          // `ReadableStream` instances (the inbound unidirectional
          // streams themselves). We use `getReader` + `read()` in a
          // tight loop (matches the MDN pattern) — lib.dom does not
          // declare `[Symbol.asyncIterator]` on `ReadableStream`, so
          // `for await...of` won't typecheck cleanly here.
          const reader = wt.incomingUnidirectionalStreams.getReader();
          try {
            while (true) {
              const {value, done} = await reader.read();
              if (done) break;
              if (value) {
                // Each stream gets its own task so the outer loop can
                // accept the next stream while this one drains.
                void this.drainWebTransportUniStream(value);
              }
            }
          } finally {
            try { reader.releaseLock(); } catch { /* ignore */ }
          }
        } catch (err) {
          // The streams queue rejects when the session closes; that's
          // the normal shutdown path. Anything else is a real bug.
          if (!this.closed) {
            // eslint-disable-next-line no-console
            console.warn(`[ServerTransport] incomingUnidirectionalStreams loop ended: ${err}`);
          }
        }
      })();
      // Inbound datagrams. Smaller / latency-sensitive payloads (Pong,
      // urgent notifications) can use datagrams instead of streams.
      const datagramLoop = (async () => {
        try {
          const reader = wt.datagrams.readable.getReader();
          try {
            while (true) {
              const {value, done} = await reader.read();
              if (done) break;
              if (value) this.handleInbound(new Uint8Array(value));
            }
          } finally {
            try { reader.releaseLock(); } catch { /* ignore */ }
          }
        } catch (err) {
          if (!this.closed) {
            // eslint-disable-next-line no-console
            console.warn(`[ServerTransport] datagrams loop ended: ${err}`);
          }
        }
      })();
      // Wait for either loop to finish (both will only resolve when
      // the session closes). We don't surface their errors — the
      // disconnect listener on `wt.closed` handles session teardown.
      await Promise.all([uniLoop, datagramLoop]);
    } catch (err) {
      if (!this.closed) {
        // eslint-disable-next-line no-console
        console.warn(`[ServerTransport] inbound loop setup failed: ${err}`);
      }
    }
  }

  /**
   * Drain a single inbound unidirectional stream: read bytes until the
   * stream closes, then dispatch. Each stream is one logical packet
   * from the server. A timeout on `read()` guards against a stuck
   * stream; we close the stream and move on.
   */
  private async drainWebTransportUniStream(
    stream: ReadableStream<Uint8Array>,
  ): Promise<void> {
    const reader = stream.getReader();
    try {
      // Read chunks until done. Most packets fit in one chunk, but the
      // stream API is chunked — we accumulate.
      const chunks: Uint8Array[] = [];
      let totalLen = 0;
      while (true) {
        const {value, done} = await this.readWithTimeout(reader);
        if (done) break;
        if (value) {
          chunks.push(value);
          totalLen += value.length;
        }
      }
      if (totalLen === 0) return;
      // Concat.
      const out = new Uint8Array(totalLen);
      let offset = 0;
      for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
      }
      this.handleInbound(out);
    } catch (err) {
      if (!this.closed) {
        // eslint-disable-next-line no-console
        console.warn(`[ServerTransport] inbound stream drain failed: ${err}`);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
  }

  /** `reader.read()` with a guard timeout so a stuck server can't pin
   *  the inbound loop forever. */
  private async readWithTimeout(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    return await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
        setTimeout(
          () => resolve({value: undefined, done: true}),
          WT_INBOUND_STREAM_READ_TIMEOUT_MS,
        );
      }),
    ]);
  }

  private connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      ws.binaryType = "arraybuffer";
      this.onWsMessage = (ev: MessageEvent) => {
        const data = ev.data as ArrayBuffer;
        if (data instanceof ArrayBuffer) {
          this.handleInbound(new Uint8Array(data));
        }
      };
      this.onWsClose = () => {
        if (!this.closed) this.close();
      };
      ws.addEventListener("message", this.onWsMessage);
      ws.addEventListener("close", this.onWsClose);
      ws.addEventListener("error", (ev) => {
        // eslint-disable-next-line no-console
        console.warn("[ServerTransport] WebSocket error", ev);
      });
      const onOpen = () => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
        resolve();
      };
      const onError = () => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
        reject(new Error(`WebSocket failed to connect to ${this.wsUrl}`));
      };
      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
      this.ws = ws;
    });
  }

  /**
   * PR 11.6.C review fix B2: the encoder already produced the full
   * on-the-wire bytes (disc + body). `sendRaw` is a pure pass-through
   * — no discriminator byte to prepend, no heuristic to strip a
   * duplicate. The caller (`sendInputs` / `sendDamageRequest` / etc.)
   * is responsible for the discriminator; the wire bytes are
   * guaranteed to start with the matching discriminator byte.
   */
  private sendRaw(wireBytes: Uint8Array): void {
    if (!this.connected) {
      // eslint-disable-next-line no-console
      console.warn("[ServerTransport] sendRaw before connect — dropping packet");
      return;
    }
    if (this.activeKind === "webtransport" && this.wt) {
      // Open a new bi-directional stream per packet. The server's
      // dispatcher reads + replies on the same stream.
      this.sendWebTransportBi(wireBytes).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(`[ServerTransport] WT bi send failed: ${err}`);
      });
    } else if (this.activeKind === "websocket" && this.ws) {
      this.ws.send(wireBytes);
    }
  }

  private async sendWebTransportBi(payload: Uint8Array): Promise<void> {
    const wt = this.wt;
    if (!wt) return;
    const stream = await wt.createBidirectionalStream();
    const writer = stream.writable.getWriter();
    await writer.write(payload);
    await writer.close();
    // Read the reply (if any). We don't block on this — the inbound
    // dispatch fires from a separate read loop. But for the simple
    // per-packet request/response pattern (ping → pong), we read
    // here to keep the stream close from blocking.
    try {
      const reader = stream.readable.getReader();
      // Read up to a small buffer; the server's replies are tiny
      // (< 64 bytes for ping/pong). Time out quickly.
      const readPromise = reader.read();
      const timeout = new Promise<{value: undefined; done: true}>((resolve) => {
        setTimeout(() => resolve({value: undefined, done: true}), 1000);
      });
      const result = await Promise.race([readPromise, timeout]);
      if (!result.done && result.value) {
        this.handleInbound(new Uint8Array(result.value));
      }
      reader.releaseLock();
    } catch {
      // ignore
    }
  }

  private handleInbound(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    const disc = bytes[0];
    const body = bytes.subarray(1);
    switch (disc) {
      case DISCRIMINATOR_INPUTS:
      case DISCRIMINATOR_INPUTS_SERVER:
        for (const f of this.listeners.inputs) f(body);
        return;
      case DISCRIMINATOR_DAMAGE_REQUEST:
        // DamageRequest is client → server; ignore if it arrives inbound.
        // eslint-disable-next-line no-console
        console.warn("[ServerTransport] inbound damageRequest — discarding");
        return;
      case DISCRIMINATOR_DAMAGE_BROADCAST:
        for (const f of this.listeners.damageBroadcast) f(body);
        return;
      case DISCRIMINATOR_DAMAGE_REJECT:
        // PR 11.6.D FIX 4: dispatch private server-to-source-tab
        // reject signals. Wire-format stable since PR 11.6.D —
        // pre-fix4 this branch fell through to the default
        // unknown-discriminator warning and the body was dropped.
        for (const f of this.listeners.damageReject) f(body);
        return;
      case DISCRIMINATOR_SNAPSHOT:
        // PR 11.7.C / §3.7 + §3.8 — dispatch the 20Hz authoritative-
        // state broadcast. Body is the 8-byte header + player
        // payload (already discriminator-stripped). Listeners call
        // `decodeSnapshot` to parse the typed `Snapshot`. Pre-11.7.C
        // this branch fell through to the default unknown-
        // discriminator warning and the body was dropped.
        for (const f of this.listeners.snapshot) f(body);
        return;
      case DISCRIMINATOR_POSITION_UPDATE:
        // PositionUpdate is client → server; ignore if it arrives inbound.
        return;
      case DISCRIMINATOR_PING:
        // Pings are client → server; ignore inbound.
        return;
      case DISCRIMINATOR_PONG: {
        const rtt = this.recordPongRtt();
        for (const f of this.listeners.pong) f(body);
        // Track our own RTT update (the Pong body carries the
        // clientTimestamp echo + serverTimestamp; we don't decode it
        // here — the listener handles that if it cares).
        if (rtt !== null) {
          this.rttSamples.push(rtt);
          if (this.rttSamples.length > RTT_WINDOW) this.rttSamples.shift();
        }
        return;
      }
      default:
        // eslint-disable-next-line no-console
        console.warn(`[ServerTransport] unknown discriminator 0x${disc.toString(16)} — discarding`);
        return;
    }
  }

  private recordPongRtt(): number | null {
    if (this.lastPingSentAt === null) return null;
    const rtt = performance.now() - this.lastPingSentAt;
    this.lastPingSentAt = null;
    return rtt;
  }

  private medianRtt(): number {
    if (this.rttSamples.length === 0) return 0;
    const sorted = [...this.rttSamples].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    if (sorted.length % 2 === 1) return sorted[mid];
    return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }

  private startPingTimer(): void {
    // Fire one ping almost immediately to seed the RTT measurement,
    // then a slow tick (1Hz per §3.10).
    setTimeout(() => this.firePing(), INITIAL_PING_DELAY_MS);
    this.pingTimer = setInterval(() => this.firePing(), PING_INTERVAL_MS);
  }

  private firePing(): void {
    if (!this.connected) return;
    const ping: Ping = {clientTimestamp: Math.floor(performance.now())};
    this.sendPing(ping);
  }

  // PR 11.7+ / AutoReconnect — health-check + visibility-API helpers.
  //
  // The health-check is a single `setInterval` that fires every
  // RECONNECT_BACKOFF_MS (note: the interval period doubles after
  // each failed attempt via `reconnectBackoffMs`). On each tick, if
  // we're not connected AND not currently retrying AND the disconnect
  // is older than RECONNECT_STALE_THRESHOLD_MS, call `connect()`.
  //
  // The visibility listener is an immediate retry trigger when the
  // tab refocuses — typically the user just switched back from another
  // tab, so the page has been backgrounded long enough that the
  // connection may have been idle-killed by a NAT/router, and we want
  // the snapshot stream live again before the user notices.
  private startAutoReconnect(): void {
    if (this.reconnectHealthCheckTimer !== null) return;
    // eslint-disable-next-line no-console
    console.info(
      `[ServerTransport] auto-reconnect armed ` +
      `(stale-threshold=${RECONNECT_STALE_THRESHOLD_MS}ms, backoff=${RECONNECT_BACKOFF_MS}ms)`,
    );
    // Health-check tick: at most once per `reconnectBackoffMs` (which
    // doubles after failed attempts). We schedule the next tick at
    // the END of the current one (rather than the natural interval)
    // so a slow `connect()` doesn't stack calls. Inside the tick we
    // also re-arm the visibility listener (idempotent — the listener
    // is a single closure).
    const tick = () => {
      if (this.connected || this.userClosed || this.reconnecting) {
        // Already recovered (or the user closed in the meantime). Stop
        // the health-check; the next disconnect will re-arm it.
        this.stopAutoReconnect();
        return;
      }
      const now = performance.now();
      const sinceDisconnect = this.lastDisconnectAt
        ? now - this.lastDisconnectAt
        : Infinity;
      if (sinceDisconnect < RECONNECT_STALE_THRESHOLD_MS) {
        // Too soon — the server may be mid-restart. Skip this tick.
        this.scheduleNextHealthCheckTick();
        return;
      }
      // eslint-disable-next-line no-console
      console.info(`[ServerTransport] attempting auto-reconnect (backoff=${this.reconnectBackoffMs}ms)`);
      this.connect().then(
        () => {
          // eslint-disable-next-line no-console
          console.info(`[ServerTransport] auto-reconnect succeeded`);
        },
        (err) => {
          // eslint-disable-next-line no-console
          console.warn(`[ServerTransport] auto-reconnect attempt failed: ${err}`);
        },
      );
      this.scheduleNextHealthCheckTick();
    };
    // First tick is at the current backoff (1s). On subsequent failed
    // attempts the backoff doubles (capped at RECONNECT_BACKOFF_MAX_MS).
    this.scheduleNextHealthCheckTick = () => {
      if (this.reconnectHealthCheckTimer !== null) {
        clearTimeout(this.reconnectHealthCheckTimer);
      }
      const delay = this.reconnectBackoffMs;
      this.reconnectHealthCheckTimer = setTimeout(() => {
        this.reconnectHealthCheckTimer = null;
        tick();
      }, delay);
    };
    this.scheduleNextHealthCheckTick();
    // Visibility-API hook: when the tab becomes visible again, kick
    // an immediate reconnect attempt (bypassing the backoff). Most
    // users background a tab and then come back expecting things to
    // "just work."
    if (typeof document !== "undefined" && !this.onVisibilityChange) {
      this.onVisibilityChange = () => {
        if (document.visibilityState !== "visible") return;
        if (this.connected || this.userClosed || this.reconnecting) return;
        // eslint-disable-next-line no-console
        console.info(`[ServerTransport] visibility change → triggering reconnect attempt`);
        this.connect().catch(() => {
          // The health-check will pick up the failure on its next tick.
        });
      };
      document.addEventListener("visibilitychange", this.onVisibilityChange);
    }
  }

  private stopAutoReconnect(): void {
    if (this.reconnectHealthCheckTimer !== null) {
      clearTimeout(this.reconnectHealthCheckTimer);
      this.reconnectHealthCheckTimer = null;
    }
    if (this.onVisibilityChange && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
      this.onVisibilityChange = null;
    }
  }

  /** Called from `connect()` on a successful connection (initial OR
   *  reconnect). Resets the backoff so the next failure starts fresh
   *  from RECONNECT_BACKOFF_MS. */
  private onReconnectSucceeded(): void {
    this.reconnectBackoffMs = RECONNECT_BACKOFF_MS;
    this.lastDisconnectAt = null;
    // Successful connect means the health-check no longer needs to
    // tick. `startAutoReconnect` re-arms it on the next disconnect.
    this.stopAutoReconnect();
  }

  /** Called from `connect()` when both WebTransport AND WebSocket
   *  failed to connect. Doubles the backoff up to the cap. The
   *  health-check will fire again at the new (longer) interval. */
  private onReconnectFailed(): void {
    this.reconnectBackoffMs = Math.min(
      this.reconnectBackoffMs * 2,
      RECONNECT_BACKOFF_MAX_MS,
    );
  }
}
