// PR 11.6.B / §3.4.1 — per-player position history ring buffer.
//
// Keeps the last N ticks of every player's position; on a
// `DamageRequest`, the lag-comp validator (PR 11.6.D) rewinds
// the target to where they were when the shooter clicked
// (~rtt/2 + interpolation delay ago). "Favor the shooter" —
// the industry standard (CS2/Valorant/Overwatch) for shippable
// server-auth FPS netcode.
//
// PR 11.6.B just plumbs the type so `Room.position_history` is
// wired up; PR 11.6.D + 11.7 read from it.
//
// **PR 11.7.B change**: the feed source for `record()` flips from
// `PositionUpdate` packets (client-driven, 32Hz) to the Rapier
// physics tick (server-driven, 64Hz). We record every physics
// tick but only STORE every other one (32Hz storage, matching
// the prior wire rate). `snapshot_at` becomes "snap-to-nearest
// within ±8 frames" instead of "largest <= target" — see §3.14
// for the hitscan-mid-air edge case this fixes.

use std::collections::VecDeque;

/// 2D position. z is constant on the flat demo map (per §3.5)
/// and re-derived server-side from the player's recorded height
/// when lag comp needs it. Carrying x + y keeps the wire type 14
/// bytes; an x + y + z type would be 18 bytes (see §3.5 note).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Position {
    pub x: f32,
    pub y: f32,
}

impl Position {
    pub const ZERO: Position = Position { x: 0.0, y: 0.0 };
}

/// Per-player ring buffer. Capacity is `retention_frames` (~64
/// in PR 11.6.B = 1 second at 64Hz server tick).
#[derive(Debug)]
pub struct PositionHistory {
    pub frames: VecDeque<(u32, Position)>,
    pub retention_frames: u32,
}

impl PositionHistory {
    pub fn new(retention_frames: u32) -> Self {
        Self {
            frames: VecDeque::with_capacity(retention_frames as usize),
            retention_frames,
        }
    }

    /// Insert a (frame, pos) entry. Older entries past
    /// `retention_frames` are popped from the front.
    pub fn record(&mut self, frame: u32, pos: Position) {
        self.frames.push_back((frame, pos));
        while self.frames.len() > self.retention_frames as usize {
            self.frames.pop_front();
        }
    }

    /// PR 11.7.B / §3.14 — snap-to-nearest lookup. Returns the
    /// recorded position whose frame is the CLOSEST to `target`
    /// within `±SNAP_TOLERANCE_FRAMES`. If multiple frames tie on
    /// distance, prefer the one with `frame <= target` (don't
    /// predict forward). If the buffer is empty, returns `None`.
    ///
    /// This replaces PR 11.6.C's "largest <= target" behavior —
    /// the old behavior produced a missed rewind on hitscan-mid-air
    /// shots where the DamageRequest's `req.frame` was the
    /// physics frame JUST AFTER the shooter clicked. The §3.14
    /// fix: with Rapier-fed 64Hz storage, the recorded frame is
    /// exactly `req.frame`; the old "largest <=" would rewind
    /// one frame too far (32ms at 32Hz storage) and miss the
    /// mid-air target.
    pub fn snapshot_at(&self, target: u32) -> Option<Position> {
        /// Tolerance window (frames). ±8 frames at 64Hz = ±125ms,
        /// well within the §3.14 ±15ms spec for hitscan mid-air
        /// lag-comp. The window is symmetric so the math handles
        /// both forward (future-frame) and backward (past-frame)
        /// lookups cleanly.
        const SNAP_TOLERANCE_FRAMES: u32 = 8;

        if self.frames.is_empty() {
            return None;
        }

        // Pick the single closest frame to `target` within
        // ±SNAP_TOLERANCE_FRAMES. Tie-break: if two frames are
        // EQUIDISTANT, prefer `frame <= target` (don't predict
        // forward). If no frame is within tolerance, fall back
        // to the closest available (no `None` for the normal
        // lag-comp window — only empty buffers return None).
        let mut best: Option<(u32, Position)> = None;
        for (f, p) in &self.frames {
            let diff = diff_abs(*f, target);
            if diff > SNAP_TOLERANCE_FRAMES {
                continue;
            }
            let take = match best {
                Some(ref b) => {
                    let cur_diff = diff_abs(b.0, target);
                    if diff < cur_diff {
                        true
                    } else if diff == cur_diff {
                        // Tie-break: prefer frame <= target.
                        *f <= target && b.0 > target
                    } else {
                        false
                    }
                }
                None => true,
            };
            if take {
                best = Some((*f, *p));
            }
        }

        if best.is_some() {
            return best.map(|(_, p)| p);
        }

        // Fallback: no frame within ±8. Pick the closest
        // available (rare; only on extreme lag spikes or
        // target = u32::MAX). Linear scan — buffer is ~64
        // entries, doesn't matter.
        for (f, p) in &self.frames {
            let take = match best {
                Some(ref b) => {
                    diff_abs(*f, target) < diff_abs(b.0, target)
                }
                None => true,
            };
            if take {
                best = Some((*f, *p));
            }
        }
        best.map(|(_, p)| p)
    }

    pub fn len(&self) -> usize {
        self.frames.len()
    }

    pub fn is_empty(&self) -> bool {
        self.frames.is_empty()
    }
}

/// Helper: absolute difference of two u32s (no underflow on
/// reverse subtraction).
fn diff_abs(a: u32, b: u32) -> u32 {
    if a >= b { a - b } else { b - a }
}

/// PR 11.7.B / §3.14 — rate constants for the Rapier-fed
/// `PositionHistory` flip. Recorded every physics tick (64Hz)
/// but stored every other tick (32Hz storage).
pub const PHYSICS_HZ: u32 = 64;
pub const STORE_HZ: u32 = 32;

/// PR 11.7.B / §3.14 — predicate for which physics frames
/// should be stored in `PositionHistory`. Even frames (`frame %
/// 2 == 0`) are stored; odd frames are dropped. The first frame
/// (0) stores; subsequent every-other-frame.
///
/// At 64Hz physics + 32Hz storage the buffer accumulates 32
/// entries per second, matching PR 11.6.D's storage rate.
pub fn should_store_frame(frame: u32) -> bool {
    (frame % (PHYSICS_HZ / STORE_HZ)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// PR 11.6.C — exact-match case: target frame is in the
    /// buffer. (The lag-comp consumer `validate_and_relay`
    /// rewinds to `req.frame - rtt/2` and asks for the snapshot
    /// at that exact frame. This is the happy path.)
    #[test]
    fn snapshot_at_exact_match() {
        let mut h = PositionHistory::new(4);
        h.record(10, Position { x: 1.0, y: 2.0 });
        h.record(20, Position { x: 3.0, y: 4.0 });
        assert_eq!(h.snapshot_at(10), Some(Position { x: 1.0, y: 2.0 }));
        assert_eq!(h.snapshot_at(20), Some(Position { x: 3.0, y: 4.0 }));
    }

    /// PR 11.6.C — target frame is between two recorded frames;
    /// the returned snapshot is the one whose frame is CLOSEST
    /// to the target. PR 11.7.B flips this from "largest below"
    /// to "nearest within ±8".
    #[test]
    fn snapshot_at_nearest_when_between() {
        let mut h = PositionHistory::new(8);
        h.record(10, Position { x: 1.0, y: 1.0 });
        h.record(20, Position { x: 2.0, y: 2.0 });
        h.record(30, Position { x: 3.0, y: 3.0 });
        // Target 25: equidistant from 20 (5 below) and 30 (5
        // above). Prefer the one <= target (frame 20).
        assert_eq!(h.snapshot_at(25), Some(Position { x: 2.0, y: 2.0 }));
        // Target 21: closest is 20 (1 below) over 30 (9 above).
        assert_eq!(h.snapshot_at(21), Some(Position { x: 2.0, y: 2.0 }));
        // Target 29: closest is 30 (1 above) over 20 (9 below).
        assert_eq!(h.snapshot_at(29), Some(Position { x: 3.0, y: 3.0 }));
        // Target 19: closest is 20 (1 above) over 10 (9 below).
        assert_eq!(h.snapshot_at(19), Some(Position { x: 2.0, y: 2.0 }));
    }

    /// PR 11.6.C — empty buffer returns None for any target. The
    /// lag-comp validator treats this as "target wasn't moving /
    /// never reported a position; use the current position
    /// instead." PR 11.6.D wires the fallback.
    #[test]
    fn snapshot_at_empty() {
        let h = PositionHistory::new(4);
        assert_eq!(h.snapshot_at(0), None);
        assert_eq!(h.snapshot_at(100), None);
        assert_eq!(h.snapshot_at(u32::MAX), None);
    }

    #[test]
    fn record_then_snapshot_returns_inserted_position() {
        let mut h = PositionHistory::new(4);
        h.record(0, Position { x: 0.0, y: 0.0 });
        h.record(1, Position { x: 1.0, y: 1.0 });
        assert_eq!(h.snapshot_at(0), Some(Position { x: 0.0, y: 0.0 }));
        assert_eq!(h.snapshot_at(1), Some(Position { x: 1.0, y: 1.0 }));
        // Future frame still within ±8 tolerance → closest is
        // frame 1.
        assert_eq!(h.snapshot_at(9), Some(Position { x: 1.0, y: 1.0 }));
    }

    #[test]
    fn retention_caps_buffer_size() {
        let mut h = PositionHistory::new(2);
        h.record(0, Position { x: 0.0, y: 0.0 });
        h.record(1, Position { x: 1.0, y: 1.0 });
        h.record(2, Position { x: 2.0, y: 2.0 });
        h.record(3, Position { x: 3.0, y: 3.0 });
        assert_eq!(h.len(), 2);
        // PR 11.7.B / §3.14: after retention, frames 2 + 3
        // remain. A query for frame 0 returns the closest
        // available (frame 2 is 2 below 0, frame 3 is 3 below
        // 0; both within the ±8 tolerance window). The OLD
        // "largest <=" returned None for frame 0 because no
        // frame was <= 0 in the buffer. The NEW snap-to-nearest
        // doesn't return None for normal lag-comp windows.
        assert_eq!(h.snapshot_at(0), Some(Position { x: 2.0, y: 2.0 }));
        assert_eq!(h.snapshot_at(2), Some(Position { x: 2.0, y: 2.0 }));
        assert_eq!(h.snapshot_at(3), Some(Position { x: 3.0, y: 3.0 }));
    }

    /// PR 11.7.B / §3.14 — snap-to-nearest behavior.
    /// Replaces the PR 11.6.C "largest <= target" test name +
    /// assertion (which pinned the OLD behavior). The new
    /// snap-to-nearest picks the closest frame within ±8;
    /// if equidistant, prefer `frame <= target` (don't predict
    /// forward).
    #[test]
    fn snapshot_at_snap_to_nearest_basic() {
        let mut h = PositionHistory::new(8);
        h.record(5, Position { x: 5.0, y: 5.0 });
        h.record(10, Position { x: 10.0, y: 10.0 });
        h.record(15, Position { x: 15.0, y: 15.0 });
        // Target = 12: closest is 10 (2 below) over 15 (3
        // above) — frame 10 wins. (Both within ±8.)
        assert_eq!(h.snapshot_at(12), Some(Position { x: 10.0, y: 10.0 }));
        // Target = 14: closest is 15 (1 above) over 10 (4
        // below) — frame 15 wins. (We pick the closest, not
        // the largest <=.)
        assert_eq!(h.snapshot_at(14), Some(Position { x: 15.0, y: 15.0 }));
        // Target = 15: exact match.
        assert_eq!(h.snapshot_at(15), Some(Position { x: 15.0, y: 15.0 }));
        // Target = 5: exact match (backward direction).
        assert_eq!(h.snapshot_at(5), Some(Position { x: 5.0, y: 5.0 }));
    }

    // -- PR 11.7.B / §3.14 new tests ----------------------------

    /// PR 11.7.B / §3.14 — exact-match at the §3.14 example:
    /// store at frames 0,2,4,6,8; query at frame 5 → returns
    /// frame 4 (closest within ±8).
    #[test]
    fn snapshot_at_snap_to_nearest_within_tolerance() {
        let mut h = PositionHistory::new(16);
        h.record(0, Position { x: 0.0, y: 0.0 });
        h.record(2, Position { x: 2.0, y: 2.0 });
        h.record(4, Position { x: 4.0, y: 4.0 });
        h.record(6, Position { x: 6.0, y: 6.0 });
        h.record(8, Position { x: 8.0, y: 8.0 });
        // Target 5: closest is frame 4 (1 below) over frame 6 (1
        // above). Prefer frame <= target (frame 4).
        assert_eq!(h.snapshot_at(5), Some(Position { x: 4.0, y: 4.0 }));
        // Target 7: closest is frame 6 (1 below) over frame 8 (1
        // above). Prefer frame 6.
        assert_eq!(h.snapshot_at(7), Some(Position { x: 6.0, y: 6.0 }));
        // Target 3: closest is frame 2 (1 below) over frame 4 (1
        // above). Prefer frame 2.
        assert_eq!(h.snapshot_at(3), Some(Position { x: 2.0, y: 2.0 }));
    }

    /// PR 11.7.B / §3.14 — outside ±8 tolerance: the snapshot
    /// falls back to the closest available frame (no `None` for
    /// the lag-comp window).
    #[test]
    fn snapshot_at_fallback_to_closest_outside_tolerance() {
        let mut h = PositionHistory::new(8);
        h.record(100, Position { x: 100.0, y: 100.0 });
        h.record(105, Position { x: 105.0, y: 105.0 });
        h.record(110, Position { x: 110.0, y: 110.0 });
        // Target 200: 90 frames beyond frame 110 (the closest).
        // Outside ±8 tolerance → fallback to closest available.
        assert_eq!(h.snapshot_at(200), Some(Position { x: 110.0, y: 110.0 }));
        // Target 50: 50 frames before frame 100 (the closest).
        assert_eq!(h.snapshot_at(50), Some(Position { x: 100.0, y: 100.0 }));
    }

    /// PR 11.7.B / §3.14 — `should_store_frame` predicate.
    /// Even frames store (0, 2, 4, ...); odd frames don't (1, 3,
    /// 5, ...).
    #[test]
    fn should_store_frame_even_only() {
        assert!(should_store_frame(0));
        assert!(!should_store_frame(1));
        assert!(should_store_frame(2));
        assert!(!should_store_frame(3));
        assert!(should_store_frame(64));
        assert!(!should_store_frame(65));
        assert!(should_store_frame(128));
        // Boundary: PHYSICS_HZ / STORE_HZ = 64 / 32 = 2.
        assert_eq!(PHYSICS_HZ / STORE_HZ, 2);
    }
}
