// PR 11.9 follow-up (lobby polish) — matchmaker HTTP client tests.
//
// Locks the `cause: "network" | "http"` discriminator on thrown
// errors so the Lobby can render "Matchmaker unreachable" without
// parsing the message string. Pure-logic, no DOM / WebGL surface
// needed — runs in node (vitest environment = "node", see
// vitest.config.ts).
//
// Also locks the helper `isMatchmakerNetworkError(err)` used by
// Lobby.tsx to switch the error message.

import { describe, expect, it, afterEach, vi } from "vitest";
import {
  isMatchmakerNetworkError,
  roomApi,
} from "./matchmakerApi";

describe("matchmakerApi — error cause discriminator", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("createRoom wraps fetch() TypeError as cause: 'network'", async () => {
    // Simulate fetch() itself rejecting — happens when the
    // matchmaker is offline, CORS is misconfigured, DNS fails,
    // or the Funnel cert expired.
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new TypeError("Failed to fetch")) as unknown as typeof fetch;

    let caught: unknown = null;
    try {
      await roomApi.createRoom("http://127.0.0.1:1");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(isMatchmakerNetworkError(caught)).toBe(true);
    // The message should still be useful for logs even if the
    // lobby never shows it (lobby substitutes "unreachable").
    expect((caught as Error).message).toMatch(/POST \/rooms/);
    expect((caught as Error).message).toMatch(/Failed to fetch/);
  });

  it("getRoom wraps fetch() TypeError as cause: 'network'", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new TypeError("Failed to fetch")) as unknown as typeof fetch;

    let caught: unknown = null;
    try {
      await roomApi.getRoom("http://127.0.0.1:1", "ABC12345");
    } catch (e) {
      caught = e;
    }
    expect(isMatchmakerNetworkError(caught)).toBe(true);
    expect((caught as Error).message).toMatch(/GET \/rooms\/ABC12345/);
  });

  it("createRoom marks 5xx responses as cause: 'http'", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("boom", { status: 500, statusText: "Internal Server Error" }),
    ) as unknown as typeof fetch;

    let caught: unknown = null;
    try {
      await roomApi.createRoom("http://127.0.0.1:18080");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(isMatchmakerNetworkError(caught)).toBe(false);
    // Verbose format kept per the brief (operator-actionable).
    expect((caught as Error).message).toMatch(
      /POST \/rooms → 500 Internal Server Error: boom/,
    );
  });

  it("getRoom marks 4xx (non-404) responses as cause: 'http'", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("invalid room id", { status: 400, statusText: "Bad Request" }),
    ) as unknown as typeof fetch;

    let caught: unknown = null;
    try {
      await roomApi.getRoom("http://127.0.0.1:18080", "BAD/ID");
    } catch (e) {
      caught = e;
    }
    expect(isMatchmakerNetworkError(caught)).toBe(false);
    // Error message must mirror the URL the request actually went
    // to (encodeURIComponent applied to the id). Otherwise operator
    // logs show "BAD/ID" but the server saw "BAD%2FID" — confusing.
    expect((caught as Error).message).toMatch(
      /GET \/rooms\/BAD%2FID → 400 Bad Request/,
    );
  });

  it("getRoom treats 404 as the normal {exists:false} path (no throw)", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response('{"exists":false}', {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      ) as unknown as typeof fetch;

    const r = await roomApi.getRoom("http://127.0.0.1:18080", "MISSING1");
    expect(r).toEqual({ exists: false });
  });

  it("getRoom returns {exists:true,players,max,ws_url} on 200", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{"exists":true,"players":3,"max":24,"ws_url":"ws://127.0.0.1:14934/rooms/ABC12345"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const r = await roomApi.getRoom("http://127.0.0.1:18080", "ABC12345");
    expect(r).toEqual({ exists: true, players: 3, max: 24, ws_url: "ws://127.0.0.1:14934/rooms/ABC12345" });
  });
});

describe("isMatchmakerNetworkError", () => {
  it("returns false for plain Errors (no cause field)", () => {
    expect(isMatchmakerNetworkError(new Error("boom"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isMatchmakerNetworkError(null)).toBe(false);
    expect(isMatchmakerNetworkError(undefined)).toBe(false);
    expect(isMatchmakerNetworkError("network error")).toBe(false);
    expect(isMatchmakerNetworkError(42)).toBe(false);
  });

  it("returns true for Errors with cause: 'network'", () => {
    const e = new Error("x") as Error & { cause?: string };
    e.cause = "network";
    expect(isMatchmakerNetworkError(e)).toBe(true);
  });

  it("returns false for Errors with cause: 'http'", () => {
    const e = new Error("x") as Error & { cause?: string };
    e.cause = "http";
    expect(isMatchmakerNetworkError(e)).toBe(false);
  });
});
