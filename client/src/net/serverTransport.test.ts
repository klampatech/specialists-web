/**
 * DEVBX-hardcode-cleanup (2026-08-30): tests for `parseRoomFromUrl`.
 *
 * Symmetry tests for server/src/transport.rs::parse_room_id() — same
 * `[A-Za-z0-9_-]{1,64}` regex, same `/rooms/<id>` extraction, same
 * throw-on-malformed semantics (server-side has a DEVBX_ROOM_ID back-compat
 * fallback for legacy clients, but the client-side parser is stricter:
 * by the time a smoke harness has a URL, the path SHOULD be valid).
 */

import { describe, it, expect } from "vitest";
import { parseRoomFromUrl } from "./serverTransport";

describe("parseRoomFromUrl", () => {
  it("extracts a simple alphanumeric room id", () => {
    expect(parseRoomFromUrl("ws://host:14434/rooms/AIMEVENT_12345")).toBe(
      "AIMEVENT_12345",
    );
  });

  it("extracts DEVBX explicitly (no silent default substitution)", () => {
    expect(parseRoomFromUrl("ws://host:14434/rooms/DEVBX")).toBe("DEVBX");
  });

  it("strips query string before extracting room id", () => {
    expect(parseRoomFromUrl("ws://host:14434/rooms/foo?bar=baz")).toBe("foo");
  });

  it("accepts dashes and underscores in the room id", () => {
    expect(parseRoomFromUrl("ws://host:14434/rooms/foo-bar_baz")).toBe(
      "foo-bar_baz",
    );
  });

  it("throws on empty room id (/rooms/)", () => {
    expect(() => parseRoomFromUrl("ws://host:14434/rooms/")).toThrow(
      /empty room id/,
    );
  });

  it("throws on space in room id (fails [A-Za-z0-9_-] validation)", () => {
    expect(() => parseRoomFromUrl("ws://host:14434/rooms/with space")).toThrow(
      /fails \[A-Za-z0-9_-\] validation/,
    );
  });

  it("throws on URL without /rooms/ prefix", () => {
    expect(() => parseRoomFromUrl("ws://host:14434/something/AIMEVENT")).toThrow(
      /must start with \/rooms\/<id>/,
    );
  });

  it("throws on a room id longer than 64 chars", () => {
    const longId = "A".repeat(65);
    expect(() =>
      parseRoomFromUrl(`ws://host:14434/rooms/${longId}`),
    ).toThrow(/too long/);
  });

  it("throws on a not-a-URL string", () => {
    expect(() => parseRoomFromUrl("not a url")).toThrow(/not a valid URL/);
  });
});
