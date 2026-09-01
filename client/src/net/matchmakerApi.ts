// PR 11.9 — matchmaker HTTP client.
//
// Thin wrapper around the 3 matchmaker endpoints (`POST /rooms`,
// `GET /rooms/<id>`, `GET /health`). Each call returns a typed
// payload; the caller is responsible for navigation.
//
// Errors: throws on non-2xx with the status code + body in the
// message. Caller catches and surfaces to the user (Lobby.tsx).
//
// PR 11.9 follow-up (lobby polish): the thrown Error carries a
// `cause: "network" | "http"` discriminator. "network" means
// `fetch()` itself threw (DNS, CORS, offline, Funnel cert
// expired, etc.) — caller renders a friendly "Matchmaker
// unreachable" message. "http" means the server responded with
// a 4xx/5xx — caller surfaces the existing verbose
// `VERB /path → STATUS STATUS: body` because that's operator-
// actionable.

export type CreateRoomResponse = {
  id: string;
  ws_url: string;
  wss_url: string;
  max_players: number;
};

export type GetRoomResponse =
  | { exists: false }
  // PR 95 follow-up: when exists:true, the matchmaker includes the
  // ws_url so the lobby's Join path can navigate to the correct WS
  // server without constructing it from `window.location.host`
  // (which is the lobby page's host:port — Vite in dev, not the WS
  // listener's port). Same shape as POST /rooms' `ws_url` field.
  | { exists: true; players: number; max: number; ws_url: string };

/** Error categories the matchmaker API can throw. Mirrored on
 *  the `cause` field of the thrown Error instance so the
 *  lobby can render a user-friendly message for network
 *  failures without changing the verbose HTTP error format. */
export type MatchmakerErrorCause = "network" | "http";

/** Runtime check: is the thrown value a network-layer failure
 *  (fetch() itself rejected — e.g., DNS, offline, CORS, Funnel
 *  cert expired)? Used by Lobby.tsx to swap the operator-
 *  friendly "unreachable" message in. */
export function isMatchmakerNetworkError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as Error & { cause?: MatchmakerErrorCause }).cause === "network"
  );
}

export const roomApi = {
  async createRoom(origin: string): Promise<CreateRoomResponse> {
    let res: Response;
    try {
      res = await fetch(`${origin}/rooms`, { method: "POST" });
    } catch (e) {
      // `fetch()` itself rejecting = network unreachable / CORS / DNS /
      // TLS handshake failure. Wrap so the message is still useful if
      // anyone logs it, but mark `cause: "network"` for UI branching.
      const wrapped = new Error(
        `POST /rooms: ${(e as Error).message || "fetch failed"}`,
      );
      (wrapped as Error & { cause: MatchmakerErrorCause }).cause = "network";
      throw wrapped;
    }
    if (!res.ok) {
      const err = new Error(
        `POST /rooms → ${res.status} ${res.statusText}: ${await res.text()}`,
      );
      (err as Error & { cause: MatchmakerErrorCause }).cause = "http";
      throw err;
    }
    return (await res.json()) as CreateRoomResponse;
  },

  async getRoom(origin: string, id: string): Promise<GetRoomResponse> {
    const encodedId = encodeURIComponent(id);
    let res: Response;
    try {
      res = await fetch(`${origin}/rooms/${encodedId}`);
    } catch (e) {
      const wrapped = new Error(
        `GET /rooms/${encodedId}: ${(e as Error).message || "fetch failed"}`,
      );
      (wrapped as Error & { cause: MatchmakerErrorCause }).cause = "network";
      throw wrapped;
    }
    if (res.status === 404) {
      return { exists: false };
    }
    if (!res.ok) {
      const err = new Error(
        `GET /rooms/${encodedId} → ${res.status} ${res.statusText}: ${await res.text()}`,
      );
      (err as Error & { cause: MatchmakerErrorCause }).cause = "http";
      throw err;
    }
    return (await res.json()) as GetRoomResponse;
  },

  async health(origin: string): Promise<boolean> {
    try {
      const res = await fetch(`${origin}/health`);
      return res.ok;
    } catch (_) {
      return false;
    }
  },
};
