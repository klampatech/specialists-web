/**
 * PR 75 — extracted `PeerOverlay` status-string → `connectionStatus` enum
 * mapping to a pure helper so vitest (Node, no jsdom) can cover the
 * state-machine surface directly.
 *
 * The bug being closed: PeerOverlay polled every 200ms and mapped its own
 * `status: string` to the four-state union with inline string-prefix
 * checks inline. The default branch (`let s = "offline"` when no prefix
 * matches) collided semantically with the offline branch (`else if
 * (status.startsWith("Server: offline")) s = "disconnected"`) — and the
 * state-machine drift was untestable because the mapping was inlined
 * inside a React effect.
 *
 * Mapping contract (canonical — change here only):
 *   "Server: connected …"      → "connected"
 *   "Server: connecting …"     → "waiting-ice"  // legacy ICE-phase tag
 *   "Server: offline …"        → "disconnected" // transport gone
 *   anything else              → "offline"      // unknown / pre-mount
 */

export type ConnectionStatus =
  | "offline"
  | "waiting-ice"
  | "connected"
  | "disconnected";

/**
 * Map a PeerOverlay `status` string to the four-state `connectionStatus`
 * union consumed by `BulletHud`'s chip. Pure function — no React, no DOM,
 * no module-level state. Safe to call from a render or an effect; safe
 * to test under Node.
 *
 * `status` is whatever `PeerOverlay`'s local `useState<string>` holds;
 * see `client/src/ui/PeerOverlay.tsx` for the producer side.
 */
export function mapStatusToConnectionStatus(status: string): ConnectionStatus {
  if (status.startsWith("Server: connected")) return "connected";
  if (status.startsWith("Server: connecting")) return "waiting-ice";
  if (status.startsWith("Server: offline")) return "disconnected";
  return "offline";
}