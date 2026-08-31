// PR 11.9 — matchmaker HTTP client.
//
// Thin wrapper around the 3 matchmaker endpoints (`POST /rooms`,
// `GET /rooms/<id>`, `GET /health`). Each call returns a typed
// payload; the caller is responsible for navigation.
//
// Errors: throws on non-2xx with the status code + body in the
// message. Caller catches and surfaces to the user (Lobby.tsx).

export type CreateRoomResponse = {
  id: string;
  ws_url: string;
  wss_url: string;
  max_players: number;
};

export type GetRoomResponse =
  | { exists: false }
  | { exists: true; players: number; max: number };

export const roomApi = {
  async createRoom(origin: string): Promise<CreateRoomResponse> {
    const res = await fetch(`${origin}/rooms`, { method: "POST" });
    if (!res.ok) {
      throw new Error(`POST /rooms → ${res.status} ${res.statusText}: ${await res.text()}`);
    }
    return (await res.json()) as CreateRoomResponse;
  },

  async getRoom(origin: string, id: string): Promise<GetRoomResponse> {
    const res = await fetch(`${origin}/rooms/${encodeURIComponent(id)}`);
    if (res.status === 404) {
      return { exists: false };
    }
    if (!res.ok) {
      throw new Error(`GET /rooms/${id} → ${res.status} ${res.statusText}: ${await res.text()}`);
    }
    return (await res.json()) as GetRoomResponse;
  },

  async health(origin: string): Promise<boolean> {
    const res = await fetch(`${origin}/health`);
    return res.ok;
  },
};