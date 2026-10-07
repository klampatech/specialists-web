# netcode-audit follow-up — 2026-10-07

**Status**: surfaced during smoke-matrix verification of PR #167 (netcode-audit
2026-10-06 batch). NOT addressed in this PR. Punted because they fall outside
the PR's stated contract (lobby-e2e §L.1–§L.8) and require a separate
investigation. Tracked here so the next session picks up cleanly.

## Context — what passed

After PR #167 (54452e0):

| Smoke | Result | Notes |
|---|---|---|
| `client/tools/smoke-orchestrator.mjs` | PASS | 4/4 damage + 24/24 fe-sync, 13.4s |
| `client/tools/lobby-e2e-smoke.mjs` §L.1–§L.8 | **8/8 PASS** | Lobby UI + wire-up + snapshot fan-out |
| `client/tools/lobby-e2e-smoke.mjs` §L.9 (damage-round-trip-snapshot) | **FAIL** | HP unchanged after Tab A AimEvent |
| `client/tools/lobby-e2e-smoke.mjs` §L.10 (damage-round-trip-controller) | **FAIL** | Controller HP unchanged |

PR #167's contract per its own description is §L.1–§L.8 ("the lobby flow
navigates, wires up, and converges to 2 players"). That contract is met. §L.9
and §L.10 are bonus gameplay-quality probes added in commits `125ffe6` and
`4979539` and have been part of the required CI gate since #135 — they
were passing 10/10 on the Hetzner prod deploy (`3951e22` on
`fix/multi-24p-wireup-race`, 2026-09-12 handoff entry) but fail on this
branch. Worth a regression investigation.

## Finding A — §L.9 / §L.10 damage round-trip fails on this branch

**Symptom** (canary log excerpt, full run at `/tmp/lobby-e2e-*`):

```
[canary] damage_relay: AIM_ACCEPTED source=1 ev=1 frame=448 ammo_after=10 targets=1
[canary] damage_relay: AIM_ACCEPTED source=1 ev=1001 frame=464 ammo_after=9 targets=1
[canary] SNAPSHOT p1:hp100:ammo9:yaw1.57:z0.80 p2:hp100:ammo0:yaw1.57:z0.00 server_frame=665
[lobby-e2e][FAIL] L9.damage-round-trip-snapshot snapshot HP unchanged: A=[{id:1,hp:100},{id:2,hp:100}] B=[{id:1,hp:100},{id:2,hp:100}]
[lobby-e2e][FAIL] L10.damage-round-trip-controller controller HP unchanged
```

The AimEvent IS accepted by the server (ammo decrements 10 → 9), but no
target is hit. The smoke fires with `yaw=π/2` (intended to face Tab B at
`x = -4` from Tab A's `x = -8` per `PLAYER_SPAWN_X_OFFSET`).

**Hypothesis**: the hit-detection math uses the server's view of Tab A's
position. If Tab A's PositionUpdate packets are getting rejected (see
Finding B), the server's snapshot still reflects Tab A's *seed* position
(origin, x=0) rather than the client's reported position (x=-8). With
Tab A at origin and Tab B at x=-4, the bullet direction (yaw=π/2 → +X) is
correct but the hit detection may have a max-range or position-gate that
fails because Tab A's body is at origin.

This needs an investigation into hit-detection at `server/src/damage_relay.rs`
combined with the position-update state when the AimEvent arrives.

**Reproduction**: shift the canary ports off the prod Tailscale IP conflict
(25432–25435 + 18080 instead of 14432–14435 + 8084 — see Finding C) and run:

```bash
cd client && SMOKE_NO_BUILD=1 \
  PROD_BUNDLE_HOST=127.0.0.1 \
  HTTP_PORT=18080 PROD_BUNDLE_PORT=25432 WT_PORT=25433 WS_PORT=25434 WSS_PORT=25435 \
  HOST=127.0.0.1 \
  node tools/lobby-e2e-smoke.mjs
```

**Hetzner 2026-09-12 baseline** (per `HANDOFF.md` 2026-09-12 entry):
lobby-e2e ran 10/10 PASS on Hetzner prod (`3951e22` on
`fix/multi-24p-wireup-race`). The relevant gap between that commit and
this branch (`54452e0`) is the 11 netcode-audit fixes in PR #167. The
most likely culprits in priority order:

1. **Fix 5 (`b65ac4a`)** — "PositionUpdate history stamps server frame,
   not client frame". Changes the server-side stamp from `pu.server_frame`
   to `room.next_server_frame`. Should be transparent for the rejection
   gate, but if `pu.server_frame` semantics also changed in the client,
   the rejection gate at `server/src/transport.rs:1762-1790` could now
   reject most packets.
2. **Fix 3 (`5b92761`)** — "lastSnapshotFrameSeen mixes two clock schemes
   — rename + repurpose". Renames a client-side frame tracker. Could
   affect what `frame` value is sent on AimEvent. Less likely to affect
   PositionUpdate but worth ruling out.
3. **Fix 1 (`1c67787`)** — "lag-comp hit-test uses actual rewound Z when
   Room::allow_vertical_hits=true". Changes the hit-test rewind math.
   Could change whether the shot actually hits.

## Finding B — PositionUpdate "stale client_frame" rejections

**Symptom** (every PositionUpdate after the first ~85 in the lobby-e2e run):

```
WARN specialists_server::transport: positionUpdate rejected: stale client_frame (replay / out-of-order)
  player_id=1 server_frame=2 last_client_frame=170
WARN ... player_id=1 server_frame=4 last_client_frame=172
WARN ... player_id=1 server_frame=6 last_client_frame=174
WARN ... player_id=1 server_frame=8 last_client_frame=176
```

The pattern: `server_frame` increments by 2 each time (2, 4, 6, 8, ...)
while `last_client_frame` increments by 2 from 170 (170, 172, 174, ...).
The two clocks are locked-step but ~168 frames apart.

The server's rejection gate at `server/src/transport.rs:1762-1790`:

```rust
let last_client_frame: Option<u32> = room_guard.players.get(&pu.player_id)
    .and_then(|p| p.last_position_update_frame);
if let Some(prev_frame) = last_client_frame {
    if pu.server_frame == prev_frame { /* idempotent allow */ }
    else if pu.server_frame < prev_frame {
        warn!("positionUpdate rejected: stale client_frame (replay / out-of-order)");
        return vec![];
    }
    ...
}
```

So `pu.server_frame` (wire value) < `last_position_update_frame` (stored) →
rejected. The server's `last_position_update_frame` was seeded to a high
number (170+), and the wire field comes in at a low number (2, 4, 6, ...).

**Most likely cause** (NOT yet root-caused): the wire `server_frame` is
somehow smaller than the server's stored value. The audit doc claimed
Fix 5 is transparent to the rejection gate; that claim needs to be
re-checked against the live smoke run.

Possible mechanisms:

1. **Field-name collision**: the wire field is called `serverFrame` in the
   client (`protocol/damage.ts:233`) but the field name on the server is
   `server_frame`. Both encode/decode at the same byte position (u32 BE
   at offset 0 in the body), so this should be aligned — but if the
   server-side decode drifted (e.g., now reads 2 bytes and shifts), the
   value would appear smaller.

2. **Counter reset somewhere between gameSession.ts:991 and the wire**:
   `gameSession.ts:991` passes `advanced.frame` to `dbSendPositionUpdateThrottled`.
   `advanced.frame` is `runtime.advanceFrame().frame` which is
   `LockstepState.localFrame` (starts at 0, increments by 1 per tick).
   After throttling every-other, wire values should be 0, 2, 4, 6, ...
   The canary log shows wire values 2, 4, 6, ... which matches the
   throttle pattern, but `last_client_frame=170` suggests an EARLIER
   PositionUpdate had a high wire value. The only way the wire value gets
   to 170 is if the client ran for ~170 engine ticks before that
   PositionUpdate. After ~85 sends, the throttle would have sent 170
   (even). Then something RESET the throttle pattern.

3. **Two clients hitting the same player slot**: if both Tab A and Tab B
   were sending PositionUpdate with `player_id=1`, the server would see
   the latest value from either tab, and the `last_client_frame` would
   track whichever tab sent last. With Tab A and Tab B having different
   localFrame states, this could cause the "stale" rejections. But the
   log shows `player_id=1` consistently, so probably not — Tab B should
   be `player_id=2`.

**Reproduction**: same as Finding A — the rejections appear in the same
smoke run. The rate is ~30 per second for the first 12 seconds, then
tapers off as the client stops sending (engine paused / browser
backgrounding).

**Suggested next step**: open a follow-up PR with a debug log on the
client that prints the `advanced.frame` value AND the wire `serverFrame`
value before send. Run the smoke. Diff the two — if they match, the
bug is in the server's decode. If they differ, the bug is in the client
between `advanced.frame` and the wire.

## Finding C — Production canary port conflict (operational)

**Symptom**: `tools/canary-server.sh` binds WT/WS/WSS/HTTP to `0.0.0.0`
(see `server/src/transport.rs:496,543` and `server/src/matchmaker.rs:83`).
On the m5 prod box, the prod canary occupies 14432–14434 on the Tailscale
IP `100.95.111.112`. Local smoke runs trying to bind `0.0.0.0:14434` get
`EADDRINUSE` because Linux rejects wildcard binds that overlap with a
specific-IP bind on the same port. The canary process dies (only WS
listener fails → entire supervisor exits). The smoke then sits in its
90s `/health` retry loop and eventually aborts with no useful error.

**Fix**: shift the canary ports off the prod range when running smoke
locally:

```bash
HTTP_PORT=18080 PROD_BUNDLE_PORT=25432 WT_PORT=25433 WS_PORT=25434 WSS_PORT=25435
```

**Long-term fix** (out of scope for this PR): either (a) make the canary
honor a `--bind-address` flag and bind to `127.0.0.1` in smoke mode, or
(b) refactor `tools/canary-server.sh` to spawn the canary with
`SO_REUSEPORT` set on the listeners. Both are easy but require careful
testing against the systemd prod unit (which would NOT want REUSEPORT).

## Audit reference

This doc is paired with `netcode-issues-2026-10-06.md` (the original
audit). Findings A and B should be triaged as a single batch — they're
likely the same root cause.
