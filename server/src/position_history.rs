// PR 11.6.B / §3.4.1 — per-player position history ring buffer.
//
// Keeps the last N ticks of every player's position; on a
// `DamageRequest`, the lag-comp validator (PR 11.6.D) rewinds the
// target to where they were when the shooter clicked (~rtt/2 +
// interpolation delay ago). "Favor the shooter" — the industry
// standard (CS2/Valorant/Overwatch) for shippable server-auth FPS
// netcode.
//
// PR 11.6.B just plumbs the type so `Room.position_history` is wired
// up; no consumer reads from it yet (PR 11.6.D + 11.7).

use std::collections::VecDeque;

/// 2D position. z is constant on the flat demo map (per §3.5) and
/// re-derived server-side from the player's recorded height when lag
/// comp needs it. Carrying x + y keeps the wire type 14 bytes; an x +
/// y + z type would be 18 bytes (see §3.5 note).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Position {
    pub x: f32,
    pub y: f32,
}

impl Position {
    pub const ZERO: Position = Position { x: 0.0, y: 0.0 };
}

/// Per-player ring buffer. Capacity is `retention_frames` (~64 in
/// PR 11.6.B = 1 second at 64Hz server tick).
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

    /// Insert a (frame, pos) entry. Older entries past `retention_frames`
    /// are popped from the front.
    pub fn record(&mut self, frame: u32, pos: Position) {
        self.frames.push_back((frame, pos));
        while self.frames.len() > self.retention_frames as usize {
            self.frames.pop_front();
        }
    }

    /// Returns the recorded position whose frame is the largest `<= target`.
    /// Linear scan — the buffer is ~64 entries, doesn't matter.
    ///
    /// Returns `None` if no entry satisfies `frame <= target` (e.g., the
    /// target frame predates any recorded position).
    pub fn snapshot_at(&self, target: u32) -> Option<Position> {
        let mut best: Option<(u32, Position)> = None;
        for (f, p) in &self.frames {
            if *f <= target && (best.is_none() || *f > best.unwrap().0) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_then_snapshot_returns_inserted_position() {
        let mut h = PositionHistory::new(4);
        h.record(0, Position { x: 0.0, y: 0.0 });
        h.record(1, Position { x: 1.0, y: 1.0 });
        assert_eq!(h.snapshot_at(0), Some(Position { x: 0.0, y: 0.0 }));
        assert_eq!(h.snapshot_at(1), Some(Position { x: 1.0, y: 1.0 }));
        // Asking for a future frame returns the most recent <= target.
        assert_eq!(h.snapshot_at(999), Some(Position { x: 1.0, y: 1.0 }));
    }

    #[test]
    fn retention_caps_buffer_size() {
        let mut h = PositionHistory::new(2);
        h.record(0, Position { x: 0.0, y: 0.0 });
        h.record(1, Position { x: 1.0, y: 1.0 });
        h.record(2, Position { x: 2.0, y: 2.0 });
        h.record(3, Position { x: 3.0, y: 3.0 });
        assert_eq!(h.len(), 2);
        // The first two should have been popped.
        assert_eq!(h.snapshot_at(0), None);
        assert_eq!(h.snapshot_at(2), Some(Position { x: 2.0, y: 2.0 }));
        assert_eq!(h.snapshot_at(3), Some(Position { x: 3.0, y: 3.0 }));
    }

    #[test]
    fn snapshot_at_picks_largest_frame_leq_target() {
        let mut h = PositionHistory::new(8);
        h.record(5, Position { x: 5.0, y: 5.0 });
        h.record(10, Position { x: 10.0, y: 10.0 });
        h.record(15, Position { x: 15.0, y: 15.0 });
        // Target = 12: largest <= 12 is 10.
        assert_eq!(h.snapshot_at(12), Some(Position { x: 10.0, y: 10.0 }));
        // Target = 14: still 10.
        assert_eq!(h.snapshot_at(14), Some(Position { x: 10.0, y: 10.0 }));
        // Target = 15: 15.
        assert_eq!(h.snapshot_at(15), Some(Position { x: 15.0, y: 15.0 }));
    }
}
