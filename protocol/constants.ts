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

// =====================================================================
// PR #108 — client-side weapons wire mirror.
//
// The server-side source of truth lives in `server/src/constants.rs`
// (`WEAPONS_TABLE`, `FireMode`, `HEADSHOT_MULTIPLIER`,
// `WEAPON_SWITCH_RATE_LIMIT_MS`, `PLAYER_MAX_AMMO`). The TS mirror
// is needed because the client's `BulletHud` (per-weapon HUD strip),
// `Crosshair` (weapon-aware colors), and `inputListener` (1/2/3 + B
// key handlers) all need read-only access to the same per-weapon
// tunables. Without the mirror, the client would hardcode display
// strings + magazine sizes + spread degrees and they'd drift from the
// server the moment any per-weapon tunable changed.
//
// **Drift guard**: `server/tests/protocol_wire.rs` does not catch
// numeric drift (only wire-format drift). The convention from PR
// 11.7.D2 §3.10 applies here: every PR that touches a per-weapon
// tunable MUST update both files in the same commit.
// =====================================================================

/** PR #108 — weapon-switch rate limit. The `0x0C WeaponSwitch`
 *  server handler rejects any switch within `WEAPON_SWITCH_RATE_LIMIT_MS`
 *  of the player's last switch. 1 switch/sec/player is generous
 *  (TS allowed instant switch); raise in PR #108+ if combat feels
 *  too sluggish.
 *
 *  The client uses this to gate local `WeaponSwitch` emissions —
 *  the server's gate is the canonical authority, but mirroring
 *  it locally avoids emitting packets the server will drop
 *  silently (5-gate #3 rate-limit).
 *
 *  Server-side mirror: `server/src/constants.rs::WEAPON_SWITCH_RATE_LIMIT_MS`. */
export const WEAPON_SWITCH_RATE_LIMIT_MS = 1000;

/** PR #108 — headshot damage multiplier. Multiplied into the
 *  weapon's `damage_per_hit` when the hit-scan identifies a head
 *  hitbox. Per Kyle's call for PR #105 spec §2.6: ship uniform 3×
 *  across all MVP weapons (matches HL1 vanilla behavior). Per-weapon
 *  overrides deferred to a tuning PR.
 *
 *  The client doesn't apply this on its own — the server applies
 *  the multiplier before emitting `DamageBroadcast`. The constant
 *  is mirrored so the HUD can render a "headshot" cue if we add
 *  one later; current PR uses it only for documentation.
 *
 *  Server-side mirror: `server/src/constants.rs::HEADSHOT_MULTIPLIER`. */
export const HEADSHOT_MULTIPLIER = 3;

/** PR #102 — wire-format-stable weapon-id enum. The same `u8`
 *  values appear on the wire (snapshot byte 29 / weapon-switch body
 *  byte 2) and in this enum; adding new weapons is an append + wire
 *  version bump. `0xFF` is reserved for "unknown" so the decoder can
 *  fail loud (anti-cheat pattern — no silent fallback to DualPistol).
 *
 *  Server-side mirror: `server/src/constants.rs::WeaponId`. */
export enum WeaponId {
  DualPistol = 0,
  Shotgun = 1,
  Sniper = 2,
}

/** PR #108 — fire-mode discriminant (matches `server/src/constants.rs::FireMode`).
 *  Encoded as a single u8 with the burst count in the high nibble.
 *  Wire format (per `server/src/constants.rs::FireMode::to_wire`):
 *    - `0x00` = Semi
 *    - `0x1X` = Burst where X = burst shot count (X∈[1,15])
 *    - `0x20` = Auto
 *    - `0xFF` = reserved/unknown (decoder fails loud — no fallback)
 *
 *  Note: this discriminant is what the *server* tracks per player
 *  via `WEAPONS_TABLE[id].fire_modes[current_fire_mode]` (the
 *  `fire_modes` array is the source of truth). The `current_fire_mode`
 *  field on the wire is the *index* into that array, NOT this
 *  discriminant. */
export enum FireMode {
  Semi = 0x00,
  Burst3 = 0x13, // The only Burst variant in MVP.
  Auto = 0x20,
}

/** PR #108 — wire encode helpers for `FireMode`. Mirrors
 *  `server/src/constants.rs::FireMode::{to_wire, from_wire}`. */
export const FireModeToWire: Record<FireMode, number> = {
  [FireMode.Semi]: 0x00,
  [FireMode.Burst3]: 0x13,
  [FireMode.Auto]: 0x20,
};

export function fireModeFromWire(b: number): FireMode | null {
  switch (b) {
    case 0x00: return FireMode.Semi;
    case 0x13: return FireMode.Burst3;
    case 0x20: return FireMode.Auto;
    default: return null;
  }
}

/** PR #108 — per-weapon fire-mode set. Mirrors the `fire_modes`
 *  slice on each `WeaponDef` in `server/src/constants.rs`. The
 *  client's `inputListener` uses this to validate the "B cycles
 *  fire modes on DualPistol" key handler — pressing B on a Shotgun
 *  (which only has `[Semi]`) is a no-op. The client's HUD uses this
 *  to render the "SEMI" / "BURST-3" label.
 *
 *  Server-side mirror: `server/src/constants.rs::WEAPONS_TABLE[*].fire_modes`. */
export const WEAPON_FIRE_MODES: Record<WeaponId, readonly FireMode[]> = {
  [WeaponId.DualPistol]: [FireMode.Semi, FireMode.Burst3],
  [WeaponId.Shotgun]: [FireMode.Semi],
  [WeaponId.Sniper]: [FireMode.Semi],
};

/** PR #108 — per-weapon tunables. Mirrors `server/src/constants.rs::WeaponDef`.
 *  Single struct, data-driven (no generics — per-weapon behavior is
 *  data, not type). Used by:
 *    - `BulletHud` (display_name + magazineSize for ammo readout)
 *    - `Crosshair` (accuracyDegrees → spread radius)
 *    - `inputListener` (fireCooldownMs → client-side click-rate gate)
 *    - HUD weapon-icon label / color choice.
 *
 *  **Drift guard**: same as the FireMode mirror above — every PR that
 *  touches a per-weapon tunable MUST update both files in the same
 *  commit. `server/tests/protocol_wire.rs` does not catch this drift.
 *
 *  Server-side mirror: `server/src/constants.rs::WEAPONS_TABLE`. */
export interface WeaponDef {
  readonly weaponId: WeaponId;
  readonly displayName: string;
  readonly damagePerHit: number;
  readonly pellets: number;
  readonly maxRangeMeters: number;
  readonly fireCooldownMs: number;
  readonly magazineSize: number;
  readonly reloadDurationMs: number;
  readonly accuracyDegrees: number;
  readonly damageFalloff: boolean;
  readonly fireModes: readonly FireMode[];
}

/** PR #108 — v1 weapon table. Indexed by `WeaponId`. Same order +
 *  same values as `server/src/constants.rs::WEAPONS_TABLE` (TS 2.0
 *  canonical per `docs/TS2.0-weapon-data.md` + PR #106 update). */
export const WEAPONS_TABLE: readonly WeaponDef[] = [
  {
    weaponId: WeaponId.DualPistol,
    displayName: "Dual Pistol",
    damagePerHit: 8,
    pellets: 1,
    maxRangeMeters: 22.0,
    fireCooldownMs: 120,
    magazineSize: 10,
    reloadDurationMs: 1500,
    accuracyDegrees: 1.5,
    damageFalloff: false,
    fireModes: WEAPON_FIRE_MODES[WeaponId.DualPistol],
  },
  {
    weaponId: WeaponId.Shotgun,
    displayName: "Shotgun",
    damagePerHit: 5,
    pellets: 8,
    maxRangeMeters: 20.0,
    fireCooldownMs: 800,
    magazineSize: 8,
    reloadDurationMs: 2200,
    accuracyDegrees: 8.0,
    damageFalloff: true,
    fireModes: WEAPON_FIRE_MODES[WeaponId.Shotgun],
  },
  {
    weaponId: WeaponId.Sniper,
    displayName: "Sniper",
    damagePerHit: 200,
    pellets: 1,
    maxRangeMeters: 100.0,
    fireCooldownMs: 1500,
    magazineSize: 5,
    reloadDurationMs: 2500,
    accuracyDegrees: 1.0,
    damageFalloff: false,
    fireModes: WEAPON_FIRE_MODES[WeaponId.Sniper],
  },
];

/** PR #108 — `WeaponId` → `WeaponDef` lookup. Returns the DualPistol
 *  def for unknown ids as a defensive default — callers that need
 *  strict validation should check `WeaponId` enum membership first
 *  (anti-cheat prefers loud failures to silent substitutions; see
 *  the pattern in `server/src/constants.rs::weapon_def` which PANICS
 *  on invalid ids after the caller has gated via `WeaponId::from_wire`). */
export function weaponDef(id: WeaponId): WeaponDef {
  return WEAPONS_TABLE[id] ?? WEAPONS_TABLE[WeaponId.DualPistol];
}

/** PR 11.7.E — maximum ammo per magazine. Mirrors
 *  `server/src/constants.rs::PLAYER_MAX_AMMO`. The client's
 *  `BulletHud` uses this for the reload-progress UI's
 *  fill-when-full computation; the snapshot's `ammo` byte carries
 *  the live value. */
export const PLAYER_MAX_AMMO = 6;
