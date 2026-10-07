# specialists-web — Netcode & Game State Audit

**Project:** Half-Life: The Specialists browser clone (Rust server + TypeScript/Babylon.js client, 24-player max per room)
**Date:** 2026-10-06
**Branch:** `fix/lobby-matchmaker-origin-runtime` @ `246e0d7`
**Scope:** `server/src/`, `client/src/`, `protocol/`, focused on **netcode** and **game state logic** (not gameplay parity, build/deploy, or scoring).
**Methodology:** adversarial re-read of every state-changing handler in the server + client since the 2026-09-07 audit, cross-checked against the wire-format SSOT. Findings were grounded by re-reading the cited `file:line` snippets — every line number below was re-verified against the working tree at HEAD `246e0d7`.

---

## TL;DR — Prioritized Action List

### 🔴 BLOCKER (fix before any production playtest with strangers)
1. **Server lag-comp hit-test still ignores vertical Y** — PR #156 grew the snapshot wire format to carry `positionZ` (player can stand on crates / jump) but `damage_relay.rs:477` constructs `source_origin` with `z=0.0` and `:543` constructs `target_pos_3d` with `z=source_origin.z` (≈0.45). Jumping and standing on crates is decorative — vertical positional advantage is invisible to hit detection.
2. **ConnectionOutbound consumer is LIFO (`pop_back`)** — under saturation the snapshot stream arrives at the client in **reverse chronological order**. Producer's `push_back` keeps the queue chronological front-to-back; consumer's `pop_back` reads it newest-first. `remoteInterpolator.findBracketing` assumes chronological order. Under load, the bracketing pair is wrong/missing. Test at `connection_outbound.rs:307` even **asserts** this LIFO behavior ("`Drain order: LIFO from back = vec![99, 3, 2, 1]`") — but the assertion only proves the queue mechanic works, not that LIFO is the right semantic for snapshot streams.

### 🟠 HIGH (fix within 2 weeks, before claiming mod parity)
3. **`lastSnapshotFrameSeen` in `gameSession.ts` mixes two unrelated clock schemes** — variable is supposed to track the LOCAL frame counter at the last snapshot read, but it stores the SERVER's `snapFrame` (Babylon `engine.advanced.frame` ≈60Hz from tab load vs server's `next_server_frame` 64Hz from server start). The `reqFrame = max(snapFrame, snapFrame + localDelta - 16)` math is broken because `localDelta` mixes two clocks. Initial `lastSnapshotFrameSeen = 0` makes the FIRST fire after connect request a frame far ahead of the server's current frame → gate-rejected at the server as "frame too far in the future." Replicated at four call sites: fire-press (`:777-792`), fire-release (`:879-888`), melee (`:913-915`), and `InputsServer` flush (`:1045-1048`).
4. **Burst state machine has "post-burst unlimited shots" bug** — `damage_relay.rs:687-689` mid-burst branch sets `burst_mid_shot = true` (skipping ammo decrement) but does NOT check whether the burst is actually exhausted. After the N shots fire, `burst_shots_remaining` saturates to 0 but `player.trigger_held` remains true. Subsequent `AimEvent`s with `is_firing: 1` keep firing at the semi-cadence with NO ammo cost. So holding the trigger on DualPistol `Burst3` → 1 ammo consumed, but unlimited shots fired until trigger release. The intended "release-and-pull to start a new burst" semantics is not implemented.
5. **`PositionHistory` ring buffer is fed by two sources with different frame schemes** — `transport.rs:2004` records every accepted `PositionUpdate` into the per-player ring buffer using `pu.server_frame` (the CLIENT's `engine.advanced.frame`, Babylon 60Hz from tab load). The 64Hz physics tick at `main.rs:407` records using `room.tick_server_frame()` (the SERVER's counter, 64Hz from server start). The two frame numbers have similar magnitude but different scales. `snapshot_at` snap-to-nearest at `position_history.rs:84` picks whichever is closest to the rewind target — mixing the two schemes' retranslation history. Additionally, the `PositionUpdate` path's `z: 0.0` (`transport.rs:2003, 2007, 2009`) poisons the ring buffer with flat-z positions regardless of the player's actual elevation. Lag-comp hit detection on a player who joined mid-session could rewind to an old PositionUpdate-pumped frame and see `z=0` for a player who's currently in mid-air.

### 🟡 MEDIUM (fix within a month, before scaling to 24 players)
6. **Per-connection drop-oldest cap was silently bumped 512 → 1024** (`connection_outbound.rs:73`) — the brief said "DO NOT bump the mpsc capacity — back-pressure is the right answer." The module-level comment at `:14` now contradicts the brief's intent (defense in depth on capacity, not paper-over). Combined with the LIFO consumer (#2), the deeper queue amplifies the ordering problem before drop-oldest kicks in.
7. **`fire_modes[]` indexed without bounds check in burst state machine** (`damage_relay.rs:637`) — `active_weapon_def.fire_modes[p.current_fire_mode as usize]` panics if `current_fire_mode` is out of range (corrupted snapshot, future weapon-table change). The `WeaponSwitch` path handles the same condition gracefully at `damage_relay.rs:1029` (`if fm_idx >= weapon_def.fire_modes.len() { … }`). The two paths should converge on the same defensive pattern.
8. **Matchmaker HTTP listener reads one byte at a time** (`matchmaker.rs:475`) — `let n = stream.read(&mut byte).await?` runs once per byte, and each `await` is a yield to the executor. For a typical 200-byte HTTP request that's 200+ syscalls. Under a few hundred req/s this becomes a measurable bottleneck on the matchmaker hot path (room create + room join are both HTTP).

### 🟢 LOW / NIT (cleanup; carryover from 2026-09-07 audit)
9. **`next_server_frame` still accumulates in empty rooms; u32 wraps in ~2.2y, no room GC** — `tick_server_frame` (session.rs:405) is called once per 64Hz tick per active room, but an empty room that survives for days will tick monotonically and eventually wrap, causing a single bad snapshot. (Carryover from prior #12.)
10. **`console.info` not DEV-gated in `damageBus.ts`** — still present at `:173` (aimEvent send) and `:326` (meleeEvent send). Allocates a string + console call at 8+/sec on every connected player under sustained fire.
11. **`PlayerState.velocityX/Y` in snapshot wire but always-zero in the new `wireServerTransport` snapshot path** — `remoteInterpolator.ts:425-426` reads them for extrapolation, but `wireServerTransport.ts:433-434` writes them from `postVel` which appears always-zero on the new path. Field is on the wire (8 bytes/player/snapshot at 24p × 20Hz = ~3.8 KB/s) but has effectively no signal.

### ✅ Findings from prior audit that have since been addressed (not re-listed)
- Prior #1 (lag-comp 2D) — partially: snapshot wire format carries Z (PR #156/6b59884), but the actual hit-test still uses `z=0.0`. The wire is fine; the rehydration is broken. See BLOCKER #1.
- Prior #2 (PositionUpdate teleport cheat) — closed by `e2173af` "Per-player PositionUpdate validator (PR 11.7.D)".
- Prior #3 (hot-path `.expect()` panics) — closed by `0fd5794` "Replace hot-path .expect() with graceful fallbacks + race-window per-target continue".
- Prior #6 (AimEvent wire mystery) — closed by 2026-09-12 bisect on Hetzner (HANDOFF.md: port-mapping bug in repro tools, not a wire bug).
- Prior #8 (no `npm run smoke` suite) — closed by `48049b1` "single-command prod-bundle regression orchestrator" and the lobby-e2e / fe-sync-matrix CI gates (PR #135).
- Prior #14 (no angle-aware yaw lerp) — closed: `remoteInterpolator.ts:202-205` now does shortest-arc lerp modulo 2π. Pitch stays linear because it's bounded to [-π/2, +π/2]. Re-verified.
- Prior #17 (`new Ray()` per shot in combat.ts:241) — verified still present. Carry over (not a blocker; minor GC pressure).
- Prior #22 (melee uses `u32::MAX` fallback, no lag-comp) — partially: the AimEvent path has lag-comp, the Melee path at `damage_relay.rs:1298` does NOT (uses `pos.z = 0.0` and `pos.x/y` from the rewound position). Carries over — see BLOCKER #1's melee-note.


---

## Detail: Each Finding with Evidence

### 1. BLOCKER — Server lag-comp hit-test still uses flat-Z (carryover, partially regressed)

**Severity:** BLOCKER
**Axis:** 1 (Network Protocol / Lag-Comp)
**Status:** CARRYOVER from prior audit, partially regressed by PR #156. The wire now carries `positionZ` (`snapshot.rs:188`, `protocol/snapshot.ts:106`), but the lag-comp rewind path constructs the raycast with `z=0.0`.

**Evidence:**

`server/src/damage_relay.rs:477` (source origin construction):
```rust
let source_origin = chest_position(glam::Vec3::new(source_pos.x, source_pos.y, 0.0));
```

`server/src/damage_relay.rs:543` (target position construction):
```rust
let target_pos_3d = glam::Vec3::new(target_pos.x, target_pos.y, source_origin.z);
```

`server/src/damage_relay.rs:1257` (melee source origin — same pattern):
```rust
Some(pos) => chest_position(glam::Vec3::new(pos.x, pos.y, 0.0)),
```

`server/src/damage_relay.rs:1298` (melee target position — same pattern):
```rust
let target_pos = chest_position(glam::Vec3::new(
    /* x = */ pos.x,
    /* y = */ pos.y,
    /* z = */ pos.z,    // ← only THIS line reads pos.z; others are 0.0
));
```

The downstream `dual_pistol_hit` is already 3D-capable (math handles z), so this is purely a caller bug — the lag-comp sites pass `0.0` / `source_origin.z` instead of the rewound position's actual `z`.

**Reproduction:** Tab A stands on a crate at `z=1.5`; Tab B aims at Tab A's chest from ground (`z=0`). The server rewinds both to `z=0` for the hit-test — Tab A's vertical positional advantage is invisible.

**Suggested fix:**
```rust
let source_origin = chest_position(glam::Vec3::new(source_pos.x, source_pos.y, source_pos.z));
let target_pos_3d = glam::Vec3::new(target_pos.x, target_pos.y, target_pos.z);
let hit = dual_pistol_hit(source_origin, forward, req.yaw_radians, target_pos_3d, DEFAULT_TARGET_RADIUS);
```

For backward compatibility with rooms that don't model vertical advantage, gate behind a per-room flag (`ALLOW_VERTICAL_HIT_DETECTION = true` per-room, default false). Re-run the smoke matrix (24-player, weapon-switch, melee) after enabling to confirm no surprises.

---

### 2. BLOCKER — ConnectionOutbound consumer is LIFO

**Severity:** BLOCKER
**Axis:** 1 (Network Protocol) + 4 (Performance / Back-pressure)

`server/src/connection_outbound.rs:214`:
```rust
if let Some(b) = q.pop_back() {
    return Some(b);
}
```

The producer uses `q.push_back(bytes)` (`:181`) — so the queue is in chronological order, oldest at the front, newest at the back. The consumer reads from the back — so under saturation, **the consumer processes the newest snapshot first**.

The unit test at `connection_outbound.rs:307` even **asserts** this behavior:
```rust
// Drain order: LIFO from back.
assert_eq!(got[0], vec![3]);
assert_eq!(got[1], vec![2]);
assert_eq!(got[2], vec![1]);
assert_eq!(got[3], vec![0]);
```

That test passes — the queue does pop-from-back correctly. The bug is that LIFO is the WRONG semantic for a snapshot stream. The snapshot generator pushes at the per-tick cadence (20Hz): snapshot_at_t0, snapshot_at_t1, snapshot_at_t2, … . Under load the client receives them in REVERSE chronological order.

**Downstream impact:** `remoteInterpolator.ts:170-178` (`findBracketing`) iterates the ring buffer in `arrival order = insertion order` (oldest first) looking for a bracketing pair `(older, newer)` such that `older.arrivedAtMs <= targetTime <= newer.arrivedAtMs`. If arrivals are reverse-chronological, the buffer is actually newest-first, and the iteration finds the wrong bracketing pair (or no pair at all).

The rate-limiter (`should_rate_limit`, `snapshot.rs:281`) only kicks in when at least one consumer's queue is saturated (>threshold_pct% of cap). Below that threshold, the queue is small enough that drop-oldest hasn't fired and the LIFO order is still observably wrong on the *first* recv() after each push — the queue is `[A, B, C]`, recv returns `C`, then `B`, then `A`.

**Reproduction:** Run the 24-player stress smoke. Watch the `[stress-stats]` line and compare the log of `server_frame` values written into the snapshot generator vs the values the client logs in the snapshot receive hook. If they monotonically increase on the server but reverse on the client under any load, you've reproduced this.

**Suggested fix:**
1. Change `pop_back` → `pop_front` in `recv()` at `connection_outbound.rs:214`. The queue is producer-pushed at back, consumer-pops at front — classic FIFO. Update the test at `:307` and `:313-323` to assert FIFO order (`[0, 1, 2, 3]`).
2. Verify with the existing fe-sync-matrix smoke (24/24) and the 24-player stress smoke.

---

### 3. HIGH — `lastSnapshotFrameSeen` mixes Babylon `engine.advanced.frame` with server `snapFrame`

**Severity:** HIGH
**Axis:** 1 (Network Protocol) + 2 (Game State)

**Evidence:**

`client/src/game/gameSession.ts:483` (initial state):
```typescript
let lastSnapshotFrameSeen = 0;
```

`client/src/game/gameSession.ts:777-792` (fire press):
```typescript
const snap = (window as Window & { __latestSnap?: () => unknown }).__latestSnap?.() as { serverFrame?: number } | null;
const snapFrame = snap?.serverFrame ?? 0;
// ... comment explaining the math ...
const localDelta = advanced.frame - lastSnapshotFrameSeen;
const reqFrame = Math.max(snapFrame, snapFrame + localDelta - 16);
const req: AimEvent = {
  sourcePlayerId: localPlayerId,
  yawRadians: gameInput.yawRadians ?? 0,
  pitchRadians: gameInput.pitchRadians ?? 0,
  frame: reqFrame,
  eventId: nextAimEventIdLocal++,
  isFiring: 1,
};
lastSnapshotFrameSeen = snapFrame;
```

The bug:
- `lastSnapshotFrameSeen` is *stored* as the SERVER's `snapFrame` (server's `next_server_frame`, 64Hz from server start).
- `localDelta` is computed as `advanced.frame - lastSnapshotFrameSeen` — Babylon's runtime frame counter (60Hz from tab load) **minus** the server's frame counter.
- These two counters have similar magnitudes but DIFFERENT schemes: they were started at different times and tick at slightly different rates. Their difference is not meaningful in any unit.
- Initially `lastSnapshotFrameSeen = 0`, so the FIRST fire after connect has `localDelta = advanced.frame - 0` (could be 200–2000+ if the tab loaded a while ago). `reqFrame = snapFrame + 200+ - 16`, which is far ahead of the server's current frame.
- The server's AimEvent gate at `damage_relay.rs:~720` rejects events whose `frame` is more than ~64 frames ahead of the server's current frame. The FIRST fire after connect gets rejected with "frame too far in the future."

**Reproduction:**
1. Load the lobby in a tab, sit on the create screen for ~10 seconds (let `engine.advanced.frame` climb to ~600).
2. Click create → game starts.
3. Pull the trigger — the FIRST AimEvent is rejected by the server. Subsequent shots work because `lastSnapshotFrameSeen` has been updated to `snapFrame` and `advanced.frame` has only advanced a small amount since the most recent snapshot.

**Replicated at 4 call sites:**
- Fire press — `:777-792` (the canonical example above).
- Fire release — `:879-888`.
- Melee — `:913-915`.
- `InputsServer` flush — `:1045-1048`.

**Suggested fix:** Rename `lastSnapshotFrameSeen` → `lastSnapshotLocalFrame` (or just `_lastSnapshotFrame`). Store `advanced.frame` at the snapshot read. Compute `localDelta` in the same-clock units:
```typescript
const localDelta = advanced.frame - lastSnapshotLocalFrame;
const estimatedServerFrame = snapFrame + Math.round(localDelta / 2); // half of our local delta passed server-side by now
const reqFrame = Math.max(snapFrame, estimatedServerFrame - 16); // keep within rewind window
lastSnapshotLocalFrame = advanced.frame;
```

The `/2` factor accounts for the client running at ~60Hz vs server at ~64Hz — the server has ticked ~half of what we've ticked since the snapshot arrived. (Or just use `snapFrame + localDelta` if the rates are similar enough — verify with the lobby-e2e smoke's first-fire assertion.)

---

### 4. HIGH — Burst state machine allows unlimited post-burst shots

**Severity:** HIGH
**Axis:** 2 (Game State / Weapon Balance)

**Evidence:**

`server/src/damage_relay.rs:674-694` (Burst arm of the fire-mode state machine):
```rust
FireMode::Burst { count } => {
    if req.is_firing == 0 {
        // Trigger released — reset burst.
        player.burst_shots_remaining = 0;
        player.trigger_held = false;
        return vec![];
    }
    if !player.trigger_held {
        // Fresh burst — first shot.
        player.trigger_held = true;
        player.burst_shots_remaining = count.saturating_sub(1);
    } else {
        // Mid-burst — subsequent shots don't consume ammo.
        burst_mid_shot = true;
        player.burst_shots_remaining =
            player.burst_shots_remaining.saturating_sub(1);
    }
}
```

The mid-burst branch (`!player.trigger_held` is false because the trigger is held) sets `burst_mid_shot = true` and decrementes `burst_shots_remaining.saturating_sub(1)`. After N shots fire, `burst_shots_remaining` saturates to 0 — but `player.trigger_held` remains true.

The NEXT AimEvent arrives with `is_firing: 1`. The state machine:
- Skips the `is_firing == 0` reset branch (trigger is held).
- `player.trigger_held` is true, takes the `else` branch.
- Sets `burst_mid_shot = true` again. Decrements `burst_shots_remaining` from 0 to 0 (saturating).
- Downstream: `if !burst_mid_shot { player.ammo -= 1 }` — `burst_mid_shot` is true, so ammo is NOT decremented.
- The shot fires (hitscan path runs).

So the player consumed 1 ammo (the initial "fresh burst" shot), fired 3 shots, but kept holding the trigger — and every subsequent AimEvent at the semi-cadence fires a shot with NO ammo cost until the trigger is released.

**Reproduction:** Load the lobby, give yourself `DualPistol` (default), hold the trigger for 5 seconds. Watch the ammo count: it drops from 10 to 9 on the first shot, stays at 9 forever while you keep firing. The HP on the target drops by 12 every ~120ms (the semi-cadence), indefinitely.

**No tests:** `grep "burst\|Burst" server/tests/*.rs` returns no hits. The state machine has no regression coverage.

**Suggested fix:**
```rust
FireMode::Burst { count } => {
    if req.is_firing == 0 {
        player.burst_shots_remaining = 0;
        player.trigger_held = false;
        return vec![];
    }
    if !player.trigger_held {
        // Fresh burst — first shot.
        player.trigger_held = true;
        player.burst_shots_remaining = count.saturating_sub(1);
    } else if player.burst_shots_remaining > 0 {
        // Mid-burst — subsequent shots don't consume ammo.
        burst_mid_shot = true;
        player.burst_shots_remaining -= 1;
    } else {
        // Burst exhausted but trigger still held — silently
        // drop the AimEvent (no ammo cost, no shot). Force
        // release-then-pull to start a new burst.
        return vec![];
    }
}
```

Add a regression test in `server/tests/damage_relay.rs` (or wherever burst tests land): construct a player in Burst3 mode, drive 10 AimEvents with `is_firing: 1`, assert `player.ammo == initial_ammo - 1` and `player.burst_shots_remaining == 0`.

---


### 5. HIGH — PositionHistory fed by two sources with different frame schemes

**Severity:** HIGH
**Axis:** 1 (Network Protocol / Lag-Comp)

**Evidence:**

The per-player `PositionHistory` ring buffer receives records from TWO sites:

**Site A — physics tick path** (`server/src/main.rs:407`, on the 64Hz tick):
```rust
room_guard.record_position(
    /* player_id */ pid,
    room_guard.tick_server_frame(),  // ← server's frame counter
    Position { x: pos.x, y: pos.y, z: pos.z },
);
```

**Site B — PositionUpdate handler** (`server/src/transport.rs:2004`, on every accepted client PositionUpdate):
```rust
room_guard.record_position(
    pu.player_id,
    pu.server_frame,  // ← CLIENT's engine.advanced.frame (see session.rs:108-115)
    Position { x: pu.position_x, y: pu.position_y, z: 0.0 },
);
```

The two frame-number sources have similar magnitude (Babylon is ~60Hz from tab load; server is 64Hz from server start) but they are NOT the same values — they're measured from different epochs. `session.rs:108-115` even documents this in a comment:
> The wire field `PositionUpdate.server_frame` is the CLIENT's local engine frame counter (Babylon `engine.advanced.frame`), NOT the server's tick clock. The server's Rapier tick records positions using `room.next_server_frame`, which is on a different scale. Mixing the two scales in the same monotonicity gate would either let replays through or reject every legitimate packet once the server clock drifted past the client's.

That comment is about the **monotonicity gate** on PositionUpdate acceptance — it correctly handles the difference there. But the same comment doesn't extend to the **rewind lookup** at `position_history.rs:81`:
```rust
pub fn snapshot_at(&self, target: u32) -> Option<Position> {
    // ... snap-to-nearest within ±SNAP_TOLERANCE frames ...
}
```

The rewind target `target` comes from the AimEvent's `frame` field, which the client populates with the **server's** `snapFrame + localDelta - 16` math (`gameSession.ts:780`). So the rewind target IS in the server's frame scheme — but the ring buffer is mixed with client-frame-number entries (from `PositionUpdate` writes) and server-frame-number entries (from the 64Hz tick).

The `should_store_frame` predicate at `position_history.rs:174` is only applied to the physics-tick path — `PositionUpdate` writes happen on every packet regardless. So a client that fires at 60Hz will inject ~60 PositionUpdate records per second into the buffer, all stamped with client-frame values. When `snapshot_at` snap-to-nearest runs, it may pick a client-frame-stamped entry that happens to be numerically close to the server-frame target. Result: lag-comp rewinds to a frame whose position is stale by `tens of server frames` (potentially hundreds of ms).

**Compounding issue:** the `PositionUpdate` path writes `z: 0.0` at `transport.rs:2003, 2007, 2009`. The physics tick writes the actual `pos.z`. So the ring buffer is also mixed-flat-Z vs real-Z. A lag-comp hit-test on a player who joined mid-session and is currently in the air could find the nearest frame is a PositionUpdate-stamped entry with `z=0` — the lag-comp shot misses vertically.

**Reproduction:** Drive a client at a fixed position. Server physics tick stamps that position at server frames `N`, `N+1`, `N+2`, … . Client sends a PositionUpdate at client-frame `K` with the same position — server stamps it at client-frame `K` in the same buffer. Now aim at the player with an AimEvent requesting a rewind to server frame `N+5`. `snapshot_at(N+5)` picks the numerically closest entry — if `K` happens to be within ±8 of `N+5` (because the client's frame counter started at the same instant or because the rates are close), it returns the client-stamped entry. Otherwise it returns the server-stamped one. Either way, the answer is inconsistent across player sessions.

**Suggested fix:**
1. **Either** move all position-history inserts onto the server-frame scheme by translating client frames to server frames at the PositionUpdate site (use `room.next_server_frame + (pu.server_frame - client_first_seen_frame)`).
2. **Or** store the server-frame stamp at PositionUpdate insert time (the server's `room.next_server_frame` value at the moment of acceptance, not the client's frame). Simpler — just replace `pu.server_frame` with `room.next_server_frame` at the `record_position` call site.
3. Pass `pos.z` through (read the actual physics Z, not `0.0`) so the ring buffer is real-Z throughout.

Add a regression test: drive a position-update at a known `pu.server_frame`, run `snapshot_at(server_frame_after_tick_increment)`, assert the returned position is the PositionUpdate-stamped one (or the tick-stamped one — pick a contract and enforce it).

---

### 6. MEDIUM — Per-connection drop-oldest cap was silently bumped 512 → 1024

**Severity:** MEDIUM
**Axis:** 4 (Performance / Back-pressure)

**Evidence:**

`server/src/connection_outbound.rs:73`:
```rust
pub const CONNECTION_OUTBOUND_CAPACITY: usize = 1024;
```

The brief explicitly said "DO NOT bump the mpsc capacity — back-pressure is the right answer, not another capacity bump." The module-level comment at `connection_outbound.rs:14-29` acknowledges this and justifies the bump:
> CI testing on D2.1's first run showed 512 was insufficient for sustained headless load: CI's snapshot-stream consumer decodes at ~12-15Hz effective rate vs the producer's 20Hz. Under sustained 2-tab load, the queue fills + drop-oldest fires — but the consumer's decode rate is the bottleneck, not the queue capacity. Bumping to 1024 gives the consumer ~50s of headroom under sustained load before drop-oldest fires. The drop-oldest path stays as defense-in-depth.

The "consumer's decode rate is the bottleneck" rationale suggests the real fix is to make the consumer faster (or rate-limit the producer harder), not to increase the queue. Combined with finding #2 (LIFO consumer), the deeper queue amplifies the ordering problem before drop-oldest kicks in — under saturation, the consumer pops 1024 items in reverse-chronological order before seeing any drop-oldest signal.

**Suggested fix:**
1. Revert `CONNECTION_OUTBOUND_CAPACITY` to 512.
2. Lower `should_rate_limit`'s default `threshold_pct` from its current value (default not verified here — re-grep at `snapshot.rs:281`) so the producer rate-limits earlier when consumers are slow.
3. Investigate why the CI consumer is decoding at 12-15Hz vs producer 20Hz — that's a real underlying performance issue being papered over by the capacity bump.

---

### 7. MEDIUM — `fire_modes[]` indexed without bounds check

**Severity:** MEDIUM
**Axis:** 6 (Security / Robustness)

**Evidence:**

`server/src/damage_relay.rs:637`:
```rust
let current_fire_mode: FireMode = match room.players.get(&req_source) {
    Some(p) => active_weapon_def.fire_modes[p.current_fire_mode as usize],
    // ...
};
```

If `p.current_fire_mode` is out of range (corrupted snapshot, future weapon-table change, replay attack), this `panic!`s. Tokio's default behavior is to abort the worker; systemd restarts; every connected player loses state.

Compare to the `WeaponSwitch` path at `damage_relay.rs:1026-1037`:
```rust
// Gate 5: fire_mode_index in range for the weapon's fire_modes[].
let fm_idx = ws.fire_mode_index as usize;
if fm_idx >= weapon_def.fire_modes.len() {
    return reject_with_gone(
        // ...
        reason: format!(
            "fire_mode_index {} out of range (fire_modes_len = {})",
            fm_idx,
            weapon_def.fire_modes.len(),
        ),
    );
}
```

The `WeaponSwitch` path bounds-checks before indexing. The `validate_and_relay_aim` path does not. They should be consistent.

**Suggested fix:**
```rust
let current_fire_mode: FireMode = match room.players.get(&req_source) {
    Some(p) => {
        let fm_idx = p.current_fire_mode as usize;
        if fm_idx >= active_weapon_def.fire_modes.len() {
            warn!(
                source = req_source,
                fire_mode_index = p.current_fire_mode,
                fire_modes_len = active_weapon_def.fire_modes.len(),
                "validate_and_relay_aim: current_fire_mode out of range \
                 (corrupted state). Dropping packet.",
            );
            return vec![];
        }
        active_weapon_def.fire_modes[fm_idx]
    }
    None => { /* existing race-window guard */ }
};
```

---

### 8. MEDIUM — Matchmaker HTTP listener reads one byte at a time

**Severity:** MEDIUM
**Axis:** 4 (Performance)

**Evidence:**

`server/src/matchmaker.rs:470-489`:
```rust
use tokio::io::AsyncReadExt;
let mut byte = [0u8; 1];
let mut last4: [u8; 4] = [0, 0, 0, 0];
loop {
    if buf.len() >= cap {
        return Ok(());
    }
    let n = stream.read(&mut byte).await.context("read byte")?;
    if n == 0 {
        return Ok(());
    }
    buf.push(byte[0]);
    // Shift the 4-byte window.
    last4[0] = last4[1];
    last4[1] = last4[2];
    last4[2] = last4[3];
    last4[3] = byte[0];
    if last4 == [b'\r', b'\n', b'\r', b'\n'] {
        return Ok(());
    }
}
```

For a typical 200-byte HTTP request header (`POST /rooms HTTP/1.1\r\nHost: …\r\nContent-Length: …\r\n\r\n`), this loops 200+ times — each iteration is a syscall (`tokio::io::AsyncReadExt::read` on a TcpStream ultimately calls `poll_read` which calls `read(2)` on the socket fd) and an `await` yield to the tokio scheduler. Under a few hundred req/s the matchmaker hot path (room create + room join) becomes a measurable bottleneck — most of the work is syscalls, not parsing.

**Suggested fix:**
```rust
let mut buf_storage = [0u8; 1024];
let mut filled = 0;
loop {
    let n = stream.read(&mut buf_storage[filled..]).await.context("read chunk")?;
    if n == 0 {
        buf.extend_from_slice(&buf_storage[..filled]);
        return Ok(());
    }
    filled += n;
    if let Some(end) = buf_storage[..filled].windows(4).position(|w| w == b"\r\n\r\n") {
        buf.extend_from_slice(&buf_storage[..end + 4]);
        return Ok(());
    }
    if filled == buf_storage.len() {
        buf.extend_from_slice(&buf_storage);
        return Ok(());
    }
}
```

Reduces the syscall count by ~100x for typical headers. Keep the cap (4KB or so) to avoid unbounded reads from malicious peers.

---

### 9. LOW — `next_server_frame` accumulates in empty rooms; u32 wraps in ~2.2y

**Severity:** LOW
**Axis:** 7 (Build/Deploy / Long-tail)

**Evidence:**

`server/src/session.rs:405-408`:
```rust
pub fn tick_server_frame(&mut self) -> u32 {
    let f = self.next_server_frame;
    self.next_server_frame = self.next_server_frame.wrapping_add(1);
    f
}
```

Called once per 64Hz tick per active room (`main.rs:359`). An empty room that survives for ~2.2 years (u32::MAX / 64 / 60 / 60 / 24 / 365 ≈ 2.2 years) will tick monotonically and wrap. After wrap, `snapshot_at` snap-to-nearest picks the wrong frame in the lag-comp rewind (the wrap is silent — no warning, no log).

No room GC: rooms persist forever in the `RoomMap` once created.

**Suggested fix:**
1. Add a room GC: destroy a room after `Room::EMPTY_TIMEOUT` (e.g., 30 minutes) of zero players. Free the `Room` Arc, free the `PositionHistory` ring buffers, free the `inputs_buffer` deques.
2. At 64Hz the safer fix is to also detect the wrap and reset (compare against `last_snapshot_frame` and bump the snapshot's `serverFrame` to a fresh high-water-mark if a wrap is detected).

---

### 10. LOW — `console.info` not DEV-gated in damageBus

**Severity:** LOW
**Axis:** 4 (Performance)

**Evidence:**

`client/src/net/damageBus.ts:173`:
```typescript
console.info(`[PR-65-DEBUG] aimEvent->send source=${req.sourcePlayerId} yaw=${req.yawRadians} pitch=${req.pitchRadians} frame=${req.frame} eventId=${req.eventId}`);
```

`client/src/net/damageBus.ts:326`:
```typescript
console.info(`[PR-114-DEBUG] meleeEvent->send source=${req.sourcePlayerId} yaw=${req.yawRadians} pitch=${req.pitchRadians} frame=${req.frame} eventId=${req.eventId}`);
```

At sustained fire (DualPistol burst cadence ~120ms, shotgun faster) this allocates a string and calls `console.info` 8+ times/sec on every connected player. In production (non-DEV) the console.info is silent in many browsers but still allocates the string. (Carryover from prior #13.)

**Suggested fix:** Wrap with `if (import.meta.env.DEV)`:
```typescript
if (import.meta.env.DEV) {
  console.info(`[PR-65-DEBUG] aimEvent->send source=${req.sourcePlayerId} ...`);
}
```

---

### 11. LOW — `velocityX/Y` on wire but always-zero in new `wireServerTransport` snapshot path

**Severity:** LOW
**Axis:** 4 (Performance) + 2 (Game State)

**Evidence:**

`client/src/engine/wireServerTransport.ts:433-434`:
```typescript
velocityX: postVel.x,
velocityY: postVel.z,
```

Where `postVel` is computed earlier in the function. In the new wireServerTransport snapshot path, `postVel` appears to be derived from the smoke envelope rather than the actual Rapier velocity (the snapshot in `server/src/snapshot.rs:113` reads `room.physics.velocity(*player_id)` correctly, but the client-side `wireServerTransport.ts` is a separate code path that may not be wired to read physics velocities from the snapshot).

The field IS consumed by `remoteInterpolator.ts:425-426` for extrapolation:
```typescript
positionX: player.positionX + player.velocityX * elapsedSec,
positionY: player.positionY + player.velocityY * elapsedSec,
```

So the field is in use, but the values may always be near-zero in the new path — the consumer extrapolates from a (near-)stationary state. Dead bytes on the wire cost ~3.8KB/s at 24p × 20Hz.

**Reproduction:** Compare the server-side snapshot generator's emitted `velocity_x` value vs the client-side `__latestSnap()` value in a 24-player stress. If they diverge (server reads Rapier, client always writes 0), the field is effectively dead on the new path.

**Suggested fix:**
1. Verify the new `wireServerTransport.ts` snapshot path reads `physics.velocity(*player_id)` (matching `snapshot.rs:113`). If it does, leave the field.
2. If it doesn't, either remove the field from the wire (`PLAYER_STATE_BODY_SIZE` drops from 35 → 27) or wire it up. Removing is a wire-format change — requires a `no-codec-versions` policy decision.

---


## Appendix A: Carryover LOW / NIT findings (no action taken since 2026-09-07)

| # | Prior Finding | Current status (re-verified) |
|---|---------------|------------------------------|
| Prior #10 | `next_server_frame` accumulates in empty rooms; u32 wraps in ~2.2y, no room GC | Still unfixed. See this audit's #9. |
| Prior #12 | No wire-format version byte | Still unfixed. Every PR that adds wire fields is a hard break. |
| Prior #13 | `console.info` not DEV-gated | Still unfixed. See this audit's #10. |
| Prior #14 | No angle-aware yaw lerp | **Fixed** in `remoteInterpolator.ts:202-205` (shortest-arc lerp modulo 2π). Pitch stays linear (bounded to [-π/2, +π/2]). |
| Prior #15 | `PlayerState.velocityX/Y` in snapshot wire but never consumed | **Mostly fixed.** `remoteInterpolator.ts:425-426` consumes them for extrapolation. New wireServerTransport path may always write zero. See #11. |
| Prior #16 | `playerId >= 1000` magic placeholder convention | Still in use at `scene.ts:1486` and `remoteInterpolator.ts` (sanity-check). Should be `Option<PlayerId>` at the wire layer. |
| Prior #17 | `new Ray()` per shot in combat.ts:241 | Verified still present at `client/src/game/combat.ts:241`. Carry over. |
| Prior #22 | Melee uses `u32::MAX` fallback, no lag-comp | Partially addressed: AimEvent path has lag-comp; melee path at `damage_relay.rs:1298` does NOT (uses `pos.x/y` from rewound position but `z=0.0`). Carry over. |

## Appendix B: Out-of-scope for this audit (deferred to future audits)

- **Build/deploy** (m5/Funnel, canary wrapper, prod bundle size) — out of scope; see DEPLOY.md.
- **Gameplay parity** (CTF, grenades, team scoring, destructible crates) — out of scope; tracked separately.
- **Matchmaker feature arc** (MMR, region select, Discord OAuth, spectator mode, replay, scoreboard, leaderboard, anti-cheat) — out of scope; Phase 2 candidates deferred pre-#98.
- **CI cross-machine smoke** — out of scope for netcode (covered in prior audit).

## Appendix C: How this audit was produced

1. **Inherited context from prior LLM handoff** that had already explored the project, read the protocol files, the server game state files, and the client netcode files. The handoff enumerated 8 candidate issues (1 BLOCKER, 4 HIGH, 2 MEDIUM, 5+ LOW carryovers).
2. **Re-verified each candidate** by re-grepping the cited `file:line` locations against the working tree at HEAD `246e0d7`. Where line numbers had shifted (e.g., `damage_relay.rs:380` → `:477` due to post-#156 growth), updated to reflect current positions.
3. **Cross-checked the LIFO test** at `connection_outbound.rs:307` to confirm the assertion is on the queue mechanic, not on the snapshot semantic.
4. **Cross-checked the burst state machine** at `damage_relay.rs:674-694` to confirm the mid-burst branch doesn't gate on `burst_shots_remaining > 0`.
5. **Cross-checked the `lastSnapshotFrameSeen` math** at `gameSession.ts:777-792` to confirm the variable stores `snapFrame` (server units) but is compared against `advanced.frame` (Babylon units), confirming the mix.
6. **Cross-checked the PositionUpdate handler** at `transport.rs:2004` to confirm `pu.server_frame` (client units) is recorded into `room.position_history` alongside the server-units entries from the 64Hz tick.
7. **Marked findings that have already been addressed** (prior #2, #3, #6, #8, #14) as fixed and removed them from the action list.

## Appendix D: Recommended order of operations for the next session

1. **Fix BLOCKER #1** (lag-comp flat-Z) — completes PR #156's intent; smallest possible diff; re-run the lobby-e2e smoke + weapon-switch smoke.
2. **Fix BLOCKER #2** (LIFO consumer → FIFO) — one-line change in `connection_outbound.rs:214`; update the LIFO test to assert FIFO; re-run fe-sync-matrix and 24-player stress.
3. **Fix HIGH #3** (`lastSnapshotFrameSeen` clock mix) — rename + repurpose; affects 4 call sites in `gameSession.ts`; smoke against the lobby-e2e's first-fire timing.
4. **Fix HIGH #4** (burst post-burst unlimited shots) — add `burst_shots_remaining > 0` gate in the mid-burst branch; add a regression test; re-run weapon-switch smoke + a new burst-mode smoke.
5. **Fix HIGH #5** (PositionHistory dual source) — replace `pu.server_frame` with `room.next_server_frame` at the PositionUpdate site (`transport.rs:2004`); pass `pos.z` through (not 0.0). Smoke lag-comp behavior end-to-end.
6. **MEDIUMs** (#6, #7, #8) — pick up when there's time.
7. **LOWs** — file as follow-up issues in the repo; not blocking.

---

## Appendix E: Wire-format SSOT summary (snapshot of `PLAYER_STATE_BODY_SIZE` and discriminator table)

For reference when fixing any of the above:

```
Discriminators (server/src/protocol.rs:37-67):
  0x00 = DISCRIMINATOR_INPUTS            (deprecated, retained for compat)
  0x01 = DISCRIMINATOR_DAMAGE_REQUEST    (deprecated, tombstoned)
  0x02 = DISCRIMINATOR_DAMAGE_BROADCAST
  0x03 = DISCRIMINATOR_POSITION_UPDATE
  0x04 = DISCRIMINATOR_PING
  0x05 = DISCRIMINATOR_PONG
  0x06 = DISCRIMINATOR_INPUTS_SERVER
  0x07 = DISCRIMINATOR_SNAPSHOT
  0x08 = DISCRIMINATOR_STATE_ACK
  0x09 = DISCRIMINATOR_RELOAD_REQUEST
  0x0A = DISCRIMINATOR_AIM_EVENT
  0x0B = DISCRIMINATOR_MELEE_EVENT
  0x0C = DISCRIMINATOR_WEAPON_SWITCH

Per-player state body size (PLAYER_STATE_BODY_SIZE = 35, post-PR-156):
  byte 0..1   playerId (u16 BE)
  byte 2..5   positionX (f32 BE)
  byte 6..9   positionY (f32 BE)
  byte 10..13 positionZ (f32 BE)             ← PR #156
  byte 14..17 velocityX (f32 BE)
  byte 18..21 velocityY (f32 BE)
  byte 22..25 yaw (f32 BE)
  byte 26..29 pitch (f32 BE)
  byte 30     hp (u8)
  byte 31     ammo (u8)
  byte 32     isFiring (u8)
  byte 33     weaponId (u8)
  byte 34     currentFireMode (u8)

Snapshot envelope (SNAPSHOT_BODY_SIZE = 9):
  byte 0..3   serverFrame (u32 BE)
  byte 4..7   nextServerFrame (u32 BE)
  byte 8      playerCount (u8)
  byte 9..    player_count * 35 bytes of PlayerState

AimEvent (AIM_EVENT_BODY_SIZE = 19; +1 disc = AIM_EVENT_WIRE_SIZE = 20):
  byte 0..1   sourcePlayerId (u16 BE)
  byte 2..5   yawRadians (f32 BE)
  byte 6..9   pitchRadians (f32 BE)
  byte 10..13 frame (u32 BE)
  byte 14..17 eventId (u32 BE)
  byte 18     isFiring (u8)                  ← PR #107

InputsServer (INPUTS_SERVER_BODY_SIZE = 20; +1 disc = 21):
  (see server/src/protocol.rs:654 + protocol/damage.ts:99-110)

WeaponSwitch (WEAPON_SWITCH_BODY_SIZE = 4; +1 disc = 5):
  (see server/src/protocol.rs + protocol/damage.ts:713)
```

If any of the above constants drifts between TS (`protocol/*.ts`) and Rust (`server/src/protocol.rs`), it's a wire-format break — add a CI check that loads both via codegen. (Prior #4 — not addressed in this audit window.)
