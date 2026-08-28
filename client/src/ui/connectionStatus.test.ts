import { describe, it, expect } from "vitest";
import {
  mapStatusToConnectionStatus,
  type ConnectionStatus,
} from "./connectionStatus";

describe("mapStatusToConnectionStatus (PR 75 — PeerOverlay state machine)", () => {
  it("connected: 'Server: connected (websocket)'", () => {
    expect(mapStatusToConnectionStatus("Server: connected (websocket)")).toBe(
      "connected",
    );
  });

  it("connected: 'Server: connected (webtransport)'", () => {
    expect(
      mapStatusToConnectionStatus("Server: connected (webtransport)"),
    ).toBe("connected");
  });

  it("connected: transport name 'unknown' (transport getter returned undefined)", () => {
    expect(mapStatusToConnectionStatus("Server: connected (unknown)")).toBe(
      "connected",
    );
  });

  it("connecting: 'Server: connecting (websocket)' → waiting-ice (legacy ICE-phase tag)", () => {
    // PR 11.7.D2 / §3.10 collapsed the WebRTC ICE-phase and the
    // WebTransport connecting phase into a single "transport is
    // opening" state; the existing type union still names it
    // "waiting-ice" for backward compat.
    expect(
      mapStatusToConnectionStatus("Server: connecting (websocket)"),
    ).toBe("waiting-ice");
  });

  it("offline-no-transport: 'Server: offline (no __serverTransport)' → disconnected", () => {
    // PeerOverlay's poller hits the `!t || !t.getStats` arm when the
    // DEV probe hasn't mounted yet; that string is the producer of
    // "disconnected" — semantically the transport is unreachable.
    expect(
      mapStatusToConnectionStatus("Server: offline (no __serverTransport)"),
    ).toBe("disconnected");
  });

  it("offline: 'Server: offline (websocket)' → disconnected", () => {
    // Transport exists but `stats.connected === false` — the poller's
    // "transport closing / dropped" path.
    expect(mapStatusToConnectionStatus("Server: offline (websocket)")).toBe(
      "disconnected",
    );
  });

  it("initial state: 'Server: waiting' → offline (the default branch)", () => {
    // PeerOverlay's `useState<string>("Server: waiting")` initializer.
    // No prefix matches any known state, so we land in the default
    // branch and emit "offline".
    expect(mapStatusToConnectionStatus("Server: waiting")).toBe("offline");
  });

  it("unknown / future status strings fall through to offline (defensive)", () => {
    expect(mapStatusToConnectionStatus("")).toBe("offline");
    expect(mapStatusToConnectionStatus("Server: foo")).toBe("offline");
    expect(mapStatusToConnectionStatus("garbage")).toBe("offline");
  });

  it("mid-frame transition: connected → offline → connected all classify correctly", () => {
    // The drift bug surfaces when the WebTransport connection drops
    // mid-session and reconnects. Verify the mapping holds for the
    // three states without any state carried between calls — the
    // function is pure.
    const transitions: Array<[string, ConnectionStatus]> = [
      ["Server: connected (websocket)", "connected"],
      ["Server: offline (websocket)", "disconnected"],
      ["Server: connected (webtransport)", "connected"],
    ];
    for (const [input, expected] of transitions) {
      expect(mapStatusToConnectionStatus(input)).toBe(expected);
    }
  });

  it("prefix-match is order-sensitive: 'Server: offline' must NOT match the 'connected' branch", () => {
    // Defensive — confirms the prefix checks are evaluated in order
    // and a future refactor doesn't accidentally reorder them.
    expect(
      mapStatusToConnectionStatus("Server: offline").startsWith("connected"),
    ).toBe(false);
  });
});