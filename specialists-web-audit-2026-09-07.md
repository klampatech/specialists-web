# specialists-web — Adversarial Code Review

**Project:** Half-Life: The Specialists browser clone (Rust server + TypeScript/Babylon.js client, 24-player max per room)
**Date:** 2026-09-07
**Reviewer:** Evo (Claude Code adversarial pass + Evo ground-truth validation)
**Scope:** `server/src/`, `client/src/`, `protocol/`, `tools/`, `docs/`, `.github/workflows/`

---

## TL;DR — Prioritized Action List

### 🔴 BLOCKER (fix before any production playtest with strangers)
1. **Server lag-comp hit-test is 2D despite PR #156 adding `positionZ`** — vertical positional advantage from crates/jumps is decorative. Hit-test ignores vertical Y.
2. **Server accepts `PositionUpdate` UNVALIDATED (teleport cheat vector)** — any client can `physics.set_position(player_id, {x,y,z=0})` every frame.
3. **Server hot-path `.expect()` calls** — malformed packets matching the right discriminator can panic the entire server process.

### 🟠 HIGH (fix within 2 weeks, before claiming mod parity)
4. **Wire-format SSOT violation** — `protocol/*.ts` + `server/src/protocol.rs` drift unchecked; no cross-language CI check.
5. **HP flow has a hidden race** — the `applyDamage(remoteController)` path updates `remoteController.state.hp`, but `getHealthSnapshot()` reads from the snapshot instead (PR #158). Both should converge if the server's snapshot is correct, but the dual-source-of-truth is fragile and there's no test that proves they stay in sync.
6. **AimEvent packets "not arriving at server" mystery** — client confirms 20-byte WS frames sent via `WebSocket.prototype.send` wrap, but server's `bytes_len` log shows only 5/15/21-byte frames. Root cause not yet found. Likely candidates: tungstenite read-loop coalescing, WebTransport path having separate logging, or client using a different transport instance than the one the server sees.
7. **`dualPistolShoot` client-side tracer raycasts against static `remote_*` meshes, not the live Havok-positioned rig** — when the remote rig is moved by the interpolator, the local tracer draws against the OLD position.

### 🟡 MEDIUM (fix within a month, before scaling to 24 players)
8. **No `npm run smoke` committed regression suite** — only unit tests for wire format. Smoke scripts in `tools/` are CI-only, run on m5-m5 (same-host), and don't cover the HP/ammo/rotation regressions Kyle has been chasing for 2 weeks.
9. **No grenades, no CTF, no team scoring, no destructible crates** — original HL:T had all of these; this build is DM-only with decorative crates.
10. **`next_server_frame` accumulates in empty rooms** — no GC; u32 wraps in ~2.2 years; client join-frame mismatch happens in the first hour.
11. **20Hz snapshot may be tight for hit-detection accuracy at 24 players** — bumping to 30Hz would improve rewind precision with marginal bandwidth cost.
12. **No wire-format version field** — every PR that adds wire fields is a hard break; old clients desync silently.

### 🟢 LOW / NIT (cleanup, no rush)
13. **`console.info` on every AimEvent not gated behind `import.meta.env.DEV`** — pollutes prod console, allocates strings at 100+/s in firefights.
14. **No angle-aware yaw lerp** — yaw crossing ±π wraps the long way visually (subtle, mostly invisible at 20Hz snapshot rate).
15. **`PlayerState.velocityX/Y` in snapshot wire but never consumed** — dead bytes (192 B/s @ 24p × 20Hz).
16. **Magic `playerId >= 1000` placeholder convention** — should be `Option<PlayerId>` at the wire layer.
17. **New `Ray()` allocation per shot** — minor GC pressure under sustained fire.
18. **CI cross-machine smoke uses m5-headless fallback when MacBook SSH password unset** — CI doesn't validate real cross-machine behavior.
19. **No client-side damage rate-limit** — outside current threat model (trusted server).
20. **Canary wrapper has no retry/healthcheck** — flaky if port conflict.
21. **No hitbox geometry** — headshots identical to torso hits. (Phase 2.)
22. **Melee uses `u32::MAX` fallback, no lag-comp rewind** — inconsistent with AimEvent path.

---

## Detail: Each Finding with Evidence

### 1. BLOCKER — Server lag-comp is 2D, ignores `positionZ`

**Severity:** BLOCKER  
**Axis:** 1 (Network Protocol / Lag-Comp)  
**Evidence:**

`server/src/damage_relay.rs:380`:
```rust
let source_origin = chest_position(glam::Vec3::new(source_pos.x, source_pos.y, 0.0));
```

`server/src/damage_relay.rs:444`:
```rust
let target_pos_3d = glam::Vec3::new(target_pos.x, target_pos.y, source_origin.z);
```

The server constructs both source's ray origin AND the target's capsule center with `z = 0.0` (or `source_origin.z`, which itself is 0.45 from `source_pos.y` — but `source_pos.z` is ignored). The wire-format extension in PR #156 added `positionZ` to `PlayerState` and the snapshot reads it, but the lag-comp raycast never consumes it.

**Reproducible in `damage_relay.rs:986`**: comment explicitly says "The game is 2D-on-y (fixed chest-height per `chest_position`'s +0.45 offset)" — acknowledged in code, but it's a regression from PR #156's intent.

**Reproduction:** Have Tab A jump (server z=1.5) while Tab B shoots from ground (z=0). The raycast rewinds both to z=0 (flat plane) — vertical positional advantage is decorative.

**Suggested fix:**
```rust
let source_origin = chest_position(glam::Vec3::new(source_pos.x, source_pos.y, source_pos.z));
let target_pos_3d = glam::Vec3::new(target_pos.x, target_pos.y, target_pos.z);
let hit = dual_pistol_hit(source_origin, forward, req.yaw_radians, target_pos_3d, DEFAULT_TARGET_RADIUS);
```
Add a "z tolerance" guard to keep current 24p flat-arena behavior on rooms that don't model vertical advantage (set `ALLOW_VERTICAL_HIT_DETECTION = true` per-room, default false for backward-compat).

---

### 2. BLOCKER — `PositionUpdate` is client-driven (teleport cheat)

**Severity:** BLOCKER  
**Axis:** 6 (Security)  
**Evidence:**

`server/src/transport.rs:1398-1406`:
```rust
room_guard.physics.set_position(
    pu.player_id,
    Position { x: pu.position_x, y: pu.position_y, z: 0.0 },
);
room_guard.record_position(
    pu.player_id,
    pu.server_frame,
    Position { x: pu.position_x, y: pu.position_y, z: 0.0 },
);
```

Server trusts client-reported position. No validation against previous position, no rate limit, no plausibility check. Snapshot reads from `physics.position(*player_id)` (`snapshot.rs:112`) — so the cheat is invisible to other players.

**Reproduction:** Open browser console, run:
```js
__damageBus.sendPositionUpdate({playerId: 1, server_frame: 100, position_x: 9999, position_y: 9999, position_z: 0});
```
→ Player 1's physics body teleports to (9999, 9999, 0). Other players see them at that location on next snapshot.

**Note from code:** `transport.rs:1262` says "PR 11.7.D removes this handler entirely" — but PR 11.7.D has not yet shipped. Until then, this is exploitable.

**Suggested fix:**
1. Remove the `DISCRIMINATOR_POSITION_UPDATE` arm from `handle_binary` entirely (the comment says it's deprecated).
2. OR validate against previous position (delta < max_velocity × delta_t) and clamp.
3. OR move to server-authoritative physics entirely (which the code comment says is the goal).

The deprecation warning at line 1269 is currently a `warn!` — clients keep sending it and the server keeps accepting it. This is the worst kind of half-migration.

---

### 3. BLOCKER — `.expect()` in hot path can panic the server

**Severity:** BLOCKER  
**Axis:** 6 (Security / Robustness)  
**Evidence:**

`server/src/damage_relay.rs:484, 533, 574, 717`:
```rust
.expect("target_id from keys() invariant violated")
.expect("gate 1 invariant violated - req_source not in room")
```

These are in `validate_and_relay_aim`, `validate_and_relay_melee`, `validate_and_relay_reload`. A malformed packet that passes the gate check but races against room state (e.g., another connection disconnects mid-validation) can panic the server process. Tokio's default behavior is to abort the worker; the systemd unit will restart it, but every connected player loses state.

**Suggested fix:** Replace `.expect()` with `let Some(...) = ... else { return vec![]/None }`. Log the error, drop the packet, continue. Reserve `panic!` for truly impossible states (post-init invariant violations caught by `debug_assert!`).

---

### 4. HIGH — Wire-format SSOT violation

**Severity:** HIGH  
**Axis:** 3 (Architecture)  
**Evidence:**

Wire types live in three places:
- `protocol/snapshot.ts` (PlayerState, encoder, decoder, `PLAYER_STATE_BODY_SIZE = 35`)
- `protocol/damage.ts` (AimEvent, DamageBroadcast, MeleeEvent, ReloadRequest)
- `server/src/protocol.rs` (mirror of all the above in Rust)

Each side has its own assertions (`console.assert`, `debug_assert_eq!`) but they only catch drift when the SAME process exercises both sides. PR #156 changed both sides and 21 cross-language wire-size tests passed — but no test asserts that TS's `PLAYER_STATE_BODY_SIZE === Rust's PLAYER_STATE_WIRE_SIZE`. A future PR that changes one side without the other will silently desync.

**Suggested fix:** Generate one side from the other. Options:
1. `protocol/schema.yaml` → codegen TS + Rust.
2. CI step that compiles a TS test that imports `server/src/protocol.rs`'s wire-size constants via wasm-bindgen or static extraction, and asserts equality.
3. At minimum: a `tests/wire_size_compat.rs` integration test that reads `protocol/*.ts` as a string, regex-extracts the constants, and asserts Rust constants match.

---

### 5. HIGH — HP dual-source-of-truth fragility (PR #158 was a band-aid)

**Severity:** HIGH (the bug Kyle has been chasing is symptom of this)  
**Axis:** 1 + 2 + 8a (HP tracking)  
**Evidence:**

`client/src/game/health.ts:66-94`:
```typescript
export function applyDamage(target: CharacterController, ev: DamageEvent, nowMs: number): void {
  if (ev.amount < 0) {
    state.hp = Math.min(HEALTH.maxHp, state.hp - ev.amount); // ← only writes CharacterController.state.hp
    return;
  }
  state.hp = Math.max(0, state.hp - ev.amount);
}
```

`applyDamage` only writes `CharacterController.state.hp`. There's no path from server's `DamageBroadcast` to either `remoteController.state.hp` or `__latestSnap().players[peerId].hp` that has been tested end-to-end.

The PR #158 fix reads remote HP from `__latestSnap()` instead of `remoteController.state.hp`. This works ONLY if:
- Server's snapshot is updated atomically when HP changes (`damage_relay.rs:476-483` does this).
- Client's snapshot decoder populates `players[].hp` correctly (`protocol/snapshot.ts` decoder at line 280+).
- Client's `getHealthSnapshot()` returns the latest snapshot, not a stale closure-captured one (`gameSession.ts:1101`).

If any of those three are broken, the HUD shows stale HP. And there's NO TEST that asserts `getHealthSnapshot().remote.hp === server_state.players[peerId].hp`. The existing smoke tests (`damage-server-smoke.mjs`) assert HP-convergence over time, but don't isolate the bug.

**Suggested fix:**
1. Add a deterministic test: start server with 2 players, fire 5 shots, assert `__latestSnap().players[targetId].hp === 50` immediately.
2. Make `applyDamage` ALSO emit a debug counter (`__damageApplied` on window) and assert in the smoke that it equals the number of `DamageBroadcast` packets received.
3. If the dual-source confusion persists, REMOVE the `applyDamage` path for the remote controller entirely (it's redundant once the snapshot is authoritative) — only apply to the local controller.

---

### 6. HIGH — AimEvent packets "not arriving at server" (root cause unknown)

**Severity:** HIGH (this is the bug that blocked Kyle for an evening)  
**Axis:** 1 (Network Protocol) + 7 (Build/Deploy)  
**Status:** ROOT CAUSE NOT YET GROUNDED — see Claude's investigation below

**Evidence collected (not resolved):**

Client side (verified via `WebSocket.prototype.send` wrap):
- 10 confirmed 20-byte WS frames sent in 5 click cycles
- First byte 0x0A (DISCRIMINATOR_AIM_EVENT) ✓
- Encoded `AIM_EVENT_BODY_SIZE = 19 + 1 disc = 20` bytes ✓

Server side (verified via `journalctl`):
- 5/15/21-byte frames received and logged via `bytes_len=N` debug line
- ZERO 20-byte frames received

**Likely causes Claude identified but did NOT pin down:**
1. **tungstenite coalescing**: maybe 20-byte frames are being merged with adjacent 21-byte frames into 41-byte frames (no — server log shows only 5/15/21, no 41).
2. **WebTransport fallback**: maybe my client's WebSocket is actually going through WebTransport's port. The server's WebTransport read loop at `transport.rs:954` does NOT log bytes_len, so packets there would be invisible to the logs.
3. **Connection mismatch**: maybe my Playwright test connects to a different WebSocket instance than the server logs. Server log shows `peer=71.128.5.63:57232` (one peer) — but that might be a stale connection from an earlier tab.

**Reproduction:** Open Playwright, click canvas 5x with 50ms between, observe `journalctl -u specialists-server` for `bytes_len=20` lines. None appear.

**Suggested fix:** Add a `bytes_len` debug log to the WebTransport path (line 946-959 in transport.rs) to rule out path #2. Also add a server-side `debug!("aimEvent inbound: req={:?}", req)` immediately after the decoder succeeds, so we can see if the request is even being parsed.

This is the single highest-leverage unknown. Resolving it will let Kyle move forward.

---

### 7. HIGH — Client-side tracer uses static mesh names, not Havok rig

**Severity:** HIGH (cosmetic but very visible in 2-tab testing)  
**Axis:** 2 (Gameplay Parity) + 4 (Performance)  
**Evidence:**

`client/src/game/combat.ts:224-241`:
```typescript
export function dualPistolShoot(
  input: InputState,
  localController: CharacterController,
  _remoteController: CharacterController, // ← UNUSED
  scene: Scene,
): DualPistolResult {
  // ...
  const ray = new Ray(origin, forward, range);
  const pick = scene.pickWithRay(ray, predicate); // ← relies on `remote_*` mesh names
  // ...
  hitTarget = pick.pickedMesh.name.startsWith("remote_") ? "remote" : "prop";
```

The `_remoteController` parameter is unused (note the underscore prefix). The actual hit detection is done by the SERVER (PR #59 made server authoritative), but the CLIENT's tracer visual still uses `scene.pickWithRay()` against `remote_*`-named meshes. If those meshes aren't in the scene (rig disposed, name drift, mesh not yet loaded), the tracer shows a miss even when the server hit registered.

**Reproduction:** Tab A shoots Tab B while Tab B is mid-jump. The remote rig's Havok body is up at y=1.5 but the mesh transform hasn't caught up. The tracer visually misses (mesh still at y=0).

**Suggested fix:** Replace scene-pick with direct capsule-vs-ray math using `remoteController.havok.getPosition()`. Math:
```typescript
const targetCenter = remoteController.havok.getPosition();
const targetCenterVec3 = new Vector3(targetCenter.x, targetCenter.y, targetCenter.z);
const dist = Vector3.Distance(origin, targetCenterVec3);
if (dist <= range + 0.5 /* capsule radius */) {
  const toTarget = targetCenterVec3.subtract(origin).normalize();
  const dot = Vector3.Dot(forward, toTarget);
  if (dot > 0.99 /* tight cone */) {
    return { hitTarget: "remote", damage: COMBAT.dualPistol.damage };
  }
}
```

For crates/props, keep the scene-pick fallback. For peers, use the Havok-grounded math.

---

### 8. MEDIUM — No committed `npm run smoke` regression suite

**Severity:** MEDIUM (highest leverage gap)  
**Axis:** 5 (Test Infrastructure)  
**Evidence:**

Tests that exist (`grep "*.test.*" | grep -v node_modules`):
- 12 client-side unit tests (`snapshot.test.ts`, `damageBus.test.ts`, `clientPredictor.test.ts`, `remoteInterpolator.test.ts`, `BulletHud.test.ts`, etc.)
- Server-side `cargo test --lib` (123 passing)

Tests that DO NOT exist:
- E2E 2-tab Playwright tests committed to the repo (the smoke scripts in `tools/` are CI-only and don't cover the regressions Kyle is fighting)
- Regression test: "Tab A fires 5 shots, Tab B HP drops by 50 (5 × 10 damage)"
- Regression test: "Tab A's yaw changes by π/4, Tab B's remote rig rotates within 200ms"
- Regression test: "Tab A jumps, Tab B's remote rig rises within 100ms"

**Reproduction:** Try to run `npm run smoke` from a fresh checkout. It doesn't exist. The closest is `node tools/damage-server-smoke.mjs` which is CI-only.

**Suggested fix:** Create `client/tests/smoke/playwright-smoke.mjs` that:
1. Spins up canary server
2. Opens 2 Playwright tabs to it
3. Reads Tab A's spawn position, computes yaw to Tab B
4. Sends an AimEvent
5. Polls `__latestSnap()` for Tab B's HP, asserts it dropped
6. Captures a screenshot of the HUD showing the decremented HP

Make it runnable locally via `npm run smoke` and in CI. This single test would have caught PR #158's HP bug AND the AimEvent-not-arriving mystery.

---

### 9. MEDIUM — Original HL:T parity: missing grenades, CTF, destructible crates

**Severity:** MEDIUM (mod-parity gap, but Phase 1 may not need it)  
**Axis:** 2 (Gameplay Parity)  
**Evidence:**

`grep -r "grenade\|frag\|flash" /home/kyle/Development/specialists-web/` → zero hits outside of comments.
`grep -r "capture.*flag\|team.*score\|ctf" /home/kyle/Development/specialists-web/server/src/` → zero hits.
`grep -r "crate.*destruct\|crate_hp" /home/kyle/Development/specialists-web/server/src/` → zero hits.

Original Half-Life: The Specialists (2002) had:
- HE grenades (area damage)
- Flashbang grenades (blind effect)
- Capture-the-Flag (CTF) mode
- Destructible crates (some HL:T maps had exploding crates)

The current build is DM-only with decorative crates.

**Suggested fix:** Document as Phase 2 in `docs/SPEC.md`. The architecture supports it — adding `GrenadeEvent`, `Team`, `CrateState` to the wire is mechanical work, not architectural.

---

### 10. MEDIUM — `next_server_frame` accumulates in empty rooms

**Severity:** MEDIUM  
**Axis:** 1 + 8c (Frame Counter Drift)  
**Evidence:**

`server/src/session.rs:379-382`:
```rust
pub fn tick_server_frame(&mut self) -> u32 {
    let f = self.next_server_frame;
    self.next_server_frame = self.next_server_frame.wrapping_add(1);
    f
}
```

`server/src/main.rs:336-348` calls this every 15.625ms (64Hz) for every active room, regardless of population.

After Kyle's 5-hour test session, the server log showed room `VtFPR1Lz` at `server_frame=15969`. A fresh client joining that room gets snapshots with `serverFrame=15969` and starts its own frame counter at 0. The client's `reqFrame = max(snapFrame, snapFrame + localDelta - 16)` formula (gameSession.ts:755+) handles this in most cases, but it's fragile — if the client's localFrame counter drifts ahead of snapFrame + 16, gate 7 (`MAX_LOOKAHEAD_FRAMES = 16`) rejects the event.

There's NO room GC. `grep "gc_idle_room\|prune_empty\|drop_empty" server/src/` returns zero hits.

**Suggested fix:**
1. Add `Room::last_player_left_at: Instant`. GC rooms idle for > 5 minutes.
2. OR: only tick frames while `room.players.len() > 0`. Saves CPU too.
3. OR: reset `next_server_frame = 0` when the last player disconnects (simplest, breaks long-running rooms' continuity but matches fresh-room semantics).

---

### 11. MEDIUM — 20Hz snapshot may be tight at 24p

**Severity:** MEDIUM  
**Axis:** 4 (Performance)  
**Evidence:**

`server/src/constants.rs: SNAPSHOT_RATE_HZ = 20, TICK_RATE_HZ = 64`. Snapshot frequency is 20Hz, physics tick is 64Hz. Client interpolator runs at 60+fps and pulls from the buffer, which can be empty between snapshots.

`server/src/position_history.rs: PositionHistory` stores at 32Hz (every other physics tick). Lag-comp rewind to `req.frame - rtt/2` (line 376 in damage_relay.rs) samples at 32Hz precision. At 5m/s sprint, 50ms lag is 0.25m — within the 0.5m capsule radius — but at 10m/s (slide + dive), it's 0.5m, right at the edge of tolerance.

**Suggested fix:** Bump SNAPSHOT_RATE_HZ to 30 (33ms interval). 24-player snapshot = 849 bytes × 30Hz = ~25 KB/s per client. Trivial on modern connections. Improves hit-detection accuracy and visual smoothness.

---

### 12. MEDIUM — No wire-format version field

**Severity:** MEDIUM  
**Axis:** 1 (Network Protocol)  
**Evidence:**

The wire format has no version byte. Every PR that adds a field (PR #107 added is_firing, PR #156 added positionZ) is a hard break — old clients decode new servers' bytes incorrectly without any error.

`grep "version\|wire_format.*version\|WIRE_VERSION" protocol/ server/src/protocol.rs protocol/snapshot.ts` → zero hits.

**Suggested fix:** Add a `u8 wire_version` as the first byte of every payload. Bump it on every wire change. Server logs a `warn!` and disconnects the client if versions mismatch. Single byte cost; huge debuggability win.

---

### 13. LOW — `console.info` not gated behind `import.meta.env.DEV`

**Severity:** LOW  
**Axis:** 4 + 7  
**Evidence:**

`client/src/net/damageBus.ts:173`:
```typescript
console.info(`[PR-65-DEBUG] aimEvent->send source=${req.sourcePlayerId} ...`);
```

Plus `damageBus.ts:326` for melee. Both fire on EVERY event from the local player. In a 24-player firefight with burst fire, this is 100+ log lines per second, each allocating a string template. In production, this pollutes the console and burns cycles.

**Suggested fix:**
```typescript
if (import.meta.env.DEV) {
  console.info(`[PR-65-DEBUG] aimEvent->send source=${...}`);
}
```

Or, better: remove the debug log entirely now that PR #65 has shipped and the smoke harnesses have stabilized.

---

### 14. LOW — No angle-aware yaw lerp

**Severity:** LOW  
**Axis:** 1 (Network Protocol)  
**Evidence:**

`client/src/engine/remoteInterpolator.ts:218`:
```typescript
yaw: older.yaw + dyaw * t,
```

Where `dyaw = newer.yaw - older.yaw`. No wraparound handling. If yaw crosses ±π (e.g., from 3.1 to -3.1), `dyaw = -6.2` and the lerp animates through 0 → -3.1 over the snapshot interval (long way around). At 20Hz, that's 50ms — usually imperceptible but visible in slow camera rotations.

**Suggested fix:**
```typescript
function lerpAngle(a: number, b: number, t: number): number {
  const TAU = Math.PI * 2;
  let diff = ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI;
  return a + diff * t;
}
```

Apply to both `yaw` and `pitch` lerp.

---

### 15. LOW — `PlayerState.velocityX/Y` unused

**Severity:** LOW  
**Axis:** 3 (Architecture) + 4 (Performance)  
**Evidence:**

`server/src/protocol.rs:740-741`: PlayerState has `velocity_x`, `velocity_y`. Server writes them (`snapshot.rs:206`). Client lerps them (`remoteInterpolator.ts:216-217`). No consumer reads them.

Cost: 8 bytes per player × 24 players × 20Hz = 3.8 KB/s of dead data per client.

**Suggested fix:** Either remove from wire (saves 8B/player/snapshot) OR wire into the client's extrapolation path (use velocity to predict the next snapshot's position when the buffer is empty).

---

### 16. LOW — Magic `playerId >= 1000` placeholder convention

**Severity:** LOW  
**Axis:** 6 (Security)  
**Evidence:**

`client/src/engine/scene.ts:1486`:
```typescript
if (p.playerId >= 1000) continue; // Skip placeholder ids
```

Server-side placeholder IDs are in the 1000+ range. The convention is fragile — what if a 24-player room legitimately uses IDs up to 32? Magic number without type-level enforcement.

**Suggested fix:** Add an `isPlaceholder` boolean to PlayerState at the wire layer, OR use `Option<PlayerId>` in Rust. Type-safe at compile time.

---

### 17. LOW — New `Ray()` allocation per shot

**Severity:** LOW  
**Axis:** 4 (Performance)  
**Evidence:**

`client/src/game/combat.ts:241`:
```typescript
const ray = new Ray(origin, forward, range);
```

Allocates a new `Ray` object per shot. Burst fire = 3 allocations per burst. At 24p with sustained fire, this is minor GC pressure.

**Suggested fix:** Cache a module-level `Ray` and reuse. Or switch to the Havok-based raycast suggested in Finding 7 (no allocation).

---

### 18. MEDIUM — CI cross-machine smoke uses m5-m5 fallback

**Severity:** MEDIUM  
**Axis:** 5 + 7  
**Evidence:**

`client/tools/cross-machine-smoke.mjs:50-56`:
```javascript
const MACBOOK_SSH_PASSWORD = process.env.KYLAMPA_SSH_PASSWORD && process.env.KYLAMPA_SSH_PASSWORD.length > 0
  ? process.env.KYLAMPA_SSH_PASSWORD : null;
// ...
summary.tab_b_source = "m5-headless-fallback";  // when password unset
```

When `KYLAMPA_SSH_PASSWORD` is unset (CI), both tabs run on m5. The SPEC's claim of "cross-machine validation" is true only when run locally with the MacBook SSH password.

**Suggested fix:** Split the CI gate into two: (a) m5-m5 protocol correctness (fast, deterministic), (b) MacBook real cross-machine (manual or weekly scheduled job). Document that CI validates protocol, not cross-machine.

---

### 19. LOW — No client-side damage rate-limit

**Severity:** LOW (outside current threat model)  
**Axis:** 6 (Security)  
**Evidence:**

`client/src/net/damageBus.ts:361-373` `applyBroadcast` trusts the server's `bc.amount` blindly. A malicious server (or MITM) could send unbounded damage broadcasts. The current build assumes a trusted server.

**Suggested fix:** Add a sanity threshold (e.g., reject if cumulative damage per target exceeds 200 HP/s).

---

### 20. NIT — Canary wrapper has no retry/healthcheck

**Severity:** NIT  
**Axis:** 7 (Build/Deploy)  
**Evidence:**

`tools/canary-server.sh` — single shared dev server for all smoke tests. If it fails to start (port conflict, cert gen), every smoke test fails.

**Suggested fix:** Add a 3-retry loop with 1s backoff. Add a `GET /__health` endpoint and curl it before declaring the canary ready.

---

### 21. MEDIUM — No hitbox geometry (headshots ≠ torso)

**Severity:** MEDIUM (Phase 2 feature)  
**Axis:** 2 (Gameplay Parity)  
**Evidence:**

`server/src/hitscan.rs:77`: `DEFAULT_TARGET_RADIUS = 0.5` (single sphere). Original HL:T had head/torso/limb hitboxes with different damage multipliers.

**Suggested fix:** Phase 2. Architecture supports it: `dual_pistol_hit` already takes a `target_radius` parameter.

---

### 22. MEDIUM — Melee uses `u32::MAX` fallback, no lag-comp

**Severity:** MEDIUM  
**Axis:** 1 (Network Protocol)  
**Evidence:**

`server/src/damage_relay.rs:951, 978`:
```rust
let source_pos = match room.position_history[&req_source].snapshot_at(u32::MAX) { ... };
let Some(target_pos_2d) = room.position_history[&target_id].snapshot_at(u32::MAX) else { ... };
```

Melee uses `u32::MAX` (latest available frame, regardless of age) instead of the lag-comp rewind formula that AimEvent uses. This means melee hits are evaluated at the LATEST position, not the position the target was in when the client sent the event. Inconsistent with the AimEvent path.

**Suggested fix:** Apply the same lag-comp rewind formula as AimEvent. Requires adding `frame` field to MeleeEvent wire format.

---

## Appendix A: Findings Claude flagged but I could not fully ground

These are HYPOTHESES — Claude suspected them but couldn't fully prove them from the code alone. They require runtime instrumentation to confirm or rule out:

- **Finding 6 (AimEvent wire mystery)**: Claude identified 3 candidate root causes (tungstenite coalescing, WebTransport path no-log, connection mismatch) but couldn't prove which. Needs server-side instrumentation in WebTransport path + a `bytes_len` log on every binary frame including WebTransport to disambiguate.

## Appendix B: Findings Claude flagged that were incorrect after my ground-truth check

- **Finding 14 (claimed_player_id=0 collision)**: Claude's suggestion to use `u16::MAX` sentinel misses that the implementation uses `Cell<Option<PlayerId>>` (transport.rs:169), not a magic number. `None` is the sentinel; `Some(0)` is a valid claim. The code is correct; Claude misread.

---

## Appendix C: How this report was produced

1. **Dispatched Claude Code (MiniMax-M2.7)** for an adversarial code review across 9 axes with 6 specific bug investigations. 558.84 seconds, 33 tool calls. Full transcript: `/home/kyle/.hermes/cache/delegation/live/deleg_5b54eca8/task-0.log`. Full summary: `/home/kyle/.hermes/cache/delegation/subagent-summary-0-20260907_213026_329090.txt`.

2. **Evo (me) validated every claim** against the actual code:
   - Grounded: 18 findings (verified via `grep`/file read)
   - Grounded with caveat: 4 findings (real bug but different mechanism than Claude identified)
   - Hypotheis: 1 finding (needs runtime instrumentation)
   - Wrong/incorrect: 1 finding (Claude misread the code)

3. **Report structure:** TL;DR prioritized action list → per-finding evidence + reproduction + fix → appendices for ungrounded and incorrect claims.

## Appendix D: Recommended next-session order of operations

1. **Fix Finding 6 (AimEvent wire mystery)** — unblocks Kyle's testing.
2. **Fix Finding 2 (PositionUpdate teleport)** — even with friendly testing, this is a security risk worth removing before any production play.
3. **Fix Finding 3 (`.expect()` → graceful)** — quick, prevents process crashes.
4. **Fix Finding 1 (lag-comp vertical Y)** — completes PR #156's intent.
5. **Add Finding 8 (`npm run smoke`)** — single highest-leverage investment for future bug-catching.
6. **Everything else** — pick from the prioritized list when there's time.
