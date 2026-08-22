// PR 11.7.D2 / §3.10 — wire/turn constants for client + server.
//
// Single source of truth for both sides. Replaces the inlined
// constants that lived in:
//   - client/src/engine/remoteInterpolator.ts (SNAPSHOT_RATE_HZ,
//     INTERPOLATION_DELAY_MS, MAX_SNAPSHOT_AGE_MS)
//   - client/src/engine/clientPredictor.ts (SNAPSHOT_RATE_HZ,
//     RECONCILIATION_THRESHOLD_M, MAX_RECONCILIATION_SNAP_DISTANCE_M)
//   - protocol/damage.ts (the INPUTS_SERVER_WIRE_SIZE constant,
//     bumped 17→18 to add the last_inputs_seq_per_source trailer)
//   - server/src/constants.rs (mirrors SNAPSHOT_RATE_HZ,
//     RECONCILIATION_THRESHOLD_M, MAX_RECONCILIATION_SNAP_DISTANCE_M,
//     INTERPOLATION_DELAY_MS, MAX_SNAPSHOT_AGE_MS)
//
// Naming convention: ALL_CAPS. Pure data — no runtime logic, no
// type-level machinery. Server-side Rust code references the same
// values via `server/src/constants.rs` (a separate copy; this file
// is the TS source of truth — the rust file MUST stay in lockstep
// with it; the existing `server/tests/protocol_wire.rs` size
// assertions catch the wire-format drift but not constant drift).
//
// Wire-format constants (DISCRIMINATOR_*, *_WIRE_SIZE, *_BODY_SIZE)
// live in `protocol/damage.ts` + `protocol/snapshot.ts` because they
// need to track the encoder/decoder surface — co-locating them with
// the codec avoids drift. The constants in THIS file are non-wire
// (turn rate, threshold, delay) so they don't need to co-locate with
// the codecs.

/** PR 11.7.B / §3.10 — snapshot broadcast cadence (Hz). The server
 *  emits a Snapshot every `1000 / SNAPSHOT_RATE_HZ` ms. 20Hz is the
 *  industry floor (CS2 / Valorant bare snapshots). */
export const SNAPSHOT_RATE_HZ = 20;

/** PR 11.7.B / §3.9 — remote-player interpolation delay (ms). The
 *  client renders remote-player positions from `renderTime - delay`
 *  ago, smoothing the inter-snapshot position lerp. 100ms = 2
 *  snapshots at 20Hz. Matches the Valorant default. */
export const INTERPOLATION_DELAY_MS = 100;

/** PR 11.7.B / §2.4 — max age of a snapshot the client will accept
 *  without requesting a full-state resync (ms). 500ms = 10 snapshots
 *  at 20Hz. Beyond this the client is too far behind and re-syncing
 *  is cheaper than lerping through a 500ms gap. The `0x0B
 *  StateResyncRequest` wire type is the request mechanism (deferred
 *  to PR 11.7+). */
export const MAX_SNAPSHOT_AGE_MS = 500;

/** PR 11.7.B / §3.10 — server physics tick rate (Hz). The
 *  server's tick loop increments `room.next_server_frame` once per
 *  tick. 64Hz ≈ 16ms per tick. Aligns with the industry floor
 *  (CS2/Valorant are 128Hz, Overwatch 60Hz). */
export const TICK_RATE_HZ = 64;

/** PR 11.7.B / §2.4 + §3.7 — client-side reconciliation drift
 *  threshold (meters). Drift above this triggers re-simulation from
 *  the last server-confirmed frame forward. 10cm is the CS2/Valorant
 *  default. The server-side authoritative simulation drifts by less
 *  than this in normal play — the threshold exists so sub-10cm Havok
 *  vs Rapier numerical noise doesn't constantly trigger
 *  reconciliation. */
export const RECONCILIATION_THRESHOLD_M = 0.1;

/** PR 11.7.B / §2.4 — max visual snap distance on a reconciliation
 *  (meters). Beyond this the predictor hard-snaps to server position
 *  + drops the buffered inputs. 2m prevents the player from
 *  teleporting across the map when the client falls > 1s behind. */
export const MAX_RECONCILIATION_SNAP_DISTANCE_M = 2.0;

/** PR 11.7.D2 — wire size for the 0x06 `InputsServer` packet AFTER
 *  the InputSeq trailer was added. The trailer is a u32 BE carrying
 *  the sender's last `inputs_seq` (per source: 0 = self, 1 = peer).
 *  Total wire packet is now 21 bytes:
 *    byte 0        discriminator 0x06
 *    byte 1..4     frame (u32 BE)
 *    byte 5..16    encoded input (12 bytes — INPUT_SIZE)
 *    byte 17..20   last_inputs_seq (u32 BE)  ← NEW trailer
 *
 *  Math: 1 (disc) + 4 (frame) + 12 (input) + 4 (trailer) = 21.
 *  Pre-D2 wire was 17 bytes (1 + 4 + 12 = 17). The brief
 *  originally specified 18 — that's a brief-level off-by-3 in the
 *  math (same class as the original PR 11.6.A `DamageRequest`
 *  8 → 14 error). The actual wire size is 21.
 *
 *  Server uses the trailer to drop stale inputs (replay
 *  protection; PR 11.7 handoff relies on the server-side lag-comp
 *  receiving the freshest input per frame).
 *
 *  Server-side mirror: `server/src/protocol.rs::INPUTS_SERVER_WIRE_SIZE`.
 */
export const WIRE_SIZE_INPUTS_SERVER_WITH_SEQ = 21;
