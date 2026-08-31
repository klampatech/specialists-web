// PR 11.6.E / Session 2 — tests for the WSS URL construction.
//
// Verifies that the ServerTransport constructor picks `wss://` (not
// `ws://`) when the page is loaded over HTTPS, and that the
// `__damageServerPorts.wss` global override works. The
// pre-PR-11.6.E code emitted a console.warn about the
// "mixed-content-blocked" gap; PR 11.6.E closes that gap, and these
// tests guard against regression.

import { describe, it, expect, vi, afterEach } from "vitest";
import { ServerTransport, parseRoomFromUrl } from "./serverTransport";

describe("ServerTransport WSS URL construction (PR 11.6.E)", () => {
  const originalLocation = (globalThis as { location?: unknown }).location;
  const originalPorts = (globalThis as { __damageServerPorts?: unknown }).__damageServerPorts;

  afterEach(() => {
    if (originalLocation === undefined) {
      delete (globalThis as { location?: unknown }).location;
    } else {
      (globalThis as { location?: unknown }).location = originalLocation;
    }
    if (originalPorts === undefined) {
      delete (globalThis as { __damageServerPorts?: unknown }).__damageServerPorts;
    } else {
      (globalThis as { __damageServerPorts?: unknown }).__damageServerPorts = originalPorts;
    }
  });

  function setLocation(protocol: "http:" | "https:") {
    (globalThis as { location?: unknown }).location = { protocol };
  }
  function setPorts(ports: { wt?: number; ws?: number; wss?: number } | undefined) {
    if (ports === undefined) {
      delete (globalThis as { __damageServerPorts?: unknown }).__damageServerPorts;
    } else {
      (globalThis as { __damageServerPorts?: unknown }).__damageServerPorts = ports;
    }
  }

  it("constructor doesn't throw on http: pages (dev canary, no TLS)", () => {
    setLocation("http:");
    setPorts(undefined);
    const t = new ServerTransport("ws://localhost:14434/rooms/TEST", "TEST");
    expect(t).toBeDefined();
  });

  it("uses wss:// with default wss port (ws+1) on https: pages", () => {
    setLocation("https:");
    setPorts({ wt: 14433, ws: 14434 }); // wss unset -> default ws+1 = 14435
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    new ServerTransport("https://localhost:14433/rooms/TEST", "TEST");
    const wssLog = consoleSpy.mock.calls.find((c: unknown[]) =>
      String(c[0] ?? "").includes("WSS fallback URL"),
    );
    expect(wssLog).toBeDefined();
    expect(String(wssLog?.[0])).toContain("wss://localhost:14435/rooms/TEST");
    consoleSpy.mockRestore();
  });

  it("uses wss:// with overridden wss port on https: pages", () => {
    setLocation("https:");
    setPorts({ wt: 14433, ws: 14434, wss: 24435 }); // explicit wss override
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    new ServerTransport("https://localhost:14433/rooms/TEST", "TEST");
    const wssLog = consoleSpy.mock.calls.find((c: unknown[]) =>
      String(c[0] ?? "").includes("WSS fallback URL"),
    );
    expect(String(wssLog?.[0])).toContain("wss://localhost:24435/rooms/TEST");
    consoleSpy.mockRestore();
  });

  it("parseRoomFromUrl accepts wss:// URLs", () => {
    // PR 11.6.E doesn't change parseRoomFromUrl's regex (the URL
    // scheme is irrelevant to room extraction), but verify the
    // helper still works for wss:// URLs because ServerTransport
    // now constructs them.
    expect(parseRoomFromUrl("wss://host:14435/rooms/AIMEVENT_12345")).toBe(
      "AIMEVENT_12345",
    );
    expect(parseRoomFromUrl("wss://host:14435/rooms/DEVBX")).toBe("DEVBX");
  });
});
