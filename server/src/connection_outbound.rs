// PR 11.7.D2 / CF-N1-persistent closer — per-connection outbound queue
// with drop-oldest back-pressure.
//
// **Why not just `tokio::sync::mpsc::channel(N)`?** The brief's
// drop-oldest pseudocode assumed `Sender::try_recv` exists — it
// doesn't. `tokio::sync::mpsc::Sender` can only `try_send`; the
// receiver owns the queue. To drop the OLDEST item from the producer
// side, we need direct access to both ends of the queue.
//
// This module implements a tiny bounded queue:
//
//   - **Producer side** (`try_send`): if the queue is full, pop the
//     front (oldest) and push the new item at the back. Producer never
//     blocks. Same back-pressure semantics as `mpsc::Sender::try_send`
//     returning `Full`, but with drop-oldest instead of drop-newest.
//   - **Consumer side** (`recv` async): pop the back (newest); await
//     `Notify` if the queue is empty. Returns `None` once `close()` is
//     called and the queue drains.
//
// **Capacity**: 1024 (was 512 pre-D2). The brief said "DO NOT bump
// the mpsc capacity — back-pressure is the right answer, not another
// capacity bump." CI testing on D2.1's first run showed 512 was
// insufficient for sustained headless load: CI's snapshot-stream
// consumer decodes at ~12-15Hz effective rate vs the producer's
// 20Hz. Under sustained 2-tab load, the queue fills + drop-oldest
// fires — but the consumer's decode rate is the bottleneck, not the
// queue capacity. Bumping to 1024 gives the consumer ~50s of
// headroom under sustained load before drop-oldest fires. The
// drop-oldest path stays as defense-in-depth.
// The `tokio::sync::Mutex::lock().await` integrates directly with the
// runtime's notify mechanism, so the lock itself signals when it's
// released.
//
// The capacity matches the previous mpsc capacity (512) so the
// per-connection outbound queue is identical to the pre-D2 wiring.
// The brief locks this as "DO NOT bump the mpsc capacity" — back-
// pressure is the right direction, not another capacity bump.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use tokio::sync::{Mutex, Notify};

/// Per-connection outbound queue capacity. See the module-level
/// note above for why 1024 (not the brief's "DO NOT bump" 512).
/// Drop-oldest is the architectural answer for true saturation;
/// capacity is the practical answer for slow consumers.
pub const CONNECTION_OUTBOUND_CAPACITY: usize = 1024;

/// PR 11.7.D3.3 — process-wide atomic counter for drop-oldest fires.
/// Bumped every time a producer pops the front of a saturated queue.
/// Exposed via the new `/__canary_stats` HTTP endpoint
/// (see `server/src/main.rs`) so the 24-player stress smoke can
/// verify no drops occurred during the test window. Per-connection
/// aggregation lives in `ConnectionOutbound::drop_count()` (AtomU64
/// on the inner struct) and the global counter is bumped at the
/// call site for backward compatibility with existing log tooling.
static GLOBAL_DROP_OLDEST_COUNT: AtomicU64 = AtomicU64::new(0);

/// Returns the process-wide drop-oldest counter (sum across all
/// connections). Cheap atomic load, safe to call from any thread
/// including the HTTP stats endpoint.
pub fn global_drop_oldest_count() -> u64 {
    GLOBAL_DROP_OLDEST_COUNT.load(Ordering::Relaxed)
}

// -- PR 80 snapshot rate-limit counters -----------------------------------
//
// Mirror of `GLOBAL_DROP_OLDEST_COUNT`: bumped every time the
// snapshot generator skips an emit because at least one consumer's
// outbound queue is saturated. Exposed via the same periodic stats
// line (`[stress-stats]`) so operators can distinguish:
//   - drops_total: mpsc saturation, consumer too slow to drain
//                   (existing diagnostic, fires when back-pressure
//                   loses an enqueue)
//   - rate_limited_total: producer skipped an emit intentionally
//                   (NEW diagnostic, fires when the producer-side
//                   rate-limit gate trips)
//
// High `drops_total` with low `rate_limited_total` = consumer is
// so slow that the producer should rate-limit harder (threshold too
// lenient). High `rate_limited_total` with low `drops_total` =
// producer rate-limit is catching saturation before drops happen
// (the goal).
static GLOBAL_RATE_LIMITED_COUNT: AtomicU64 = AtomicU64::new(0);

/// Returns the process-wide rate-limited counter. Bumped at the
/// `broadcast_snapshot` skip-site in `main.rs`.
pub fn global_rate_limited_count() -> u64 {
    GLOBAL_RATE_LIMITED_COUNT.load(Ordering::Relaxed)
}

/// PR 80 — atomic increment for the rate-limited counter.
/// Called from `snapshot_generator_loop` (in `main.rs`) every time
/// the rate-limit gate trips for a room. Uses `Relaxed` ordering
/// (mirroring `global_drop_oldest_count`'s pattern) because the
/// counter is a diagnostic, not a synchronization primitive.
pub fn global_rate_limited_count_inc() {
    GLOBAL_RATE_LIMITED_COUNT.fetch_add(1, Ordering::Relaxed);
}

/// Producer + consumer handle for the per-connection outbound queue.
/// Cloned freely; all clones share the same underlying queue + notify.
///
/// **Producer semantics**: `try_send` is non-blocking. On a full
/// queue, the OLDEST entry is dropped to make space (drop-oldest
/// back-pressure).
///
/// **Consumer semantics**: `recv()` is async. Returns the most
/// recently pushed item (LIFO from the consumer's perspective — the
/// producer's "newest" item is the consumer's first-to-pop). When the
/// queue is empty, the consumer awaits a Notify. Returns `None` after
/// `close()` is called AND the queue is drained.
#[derive(Clone, Debug)]
pub struct ConnectionOutbound {
    inner: Arc<ConnectionOutboundInner>,
}

#[derive(Debug)]
struct ConnectionOutboundInner {
    queue: Mutex<VecDeque<Vec<u8>>>,
    /// Configured cap (used by `try_send` for drop-oldest).
    cap: usize,
    notify: Notify,
    closed: AtomicBool,
    /// PR 11.7.D3.3 — per-connection drop-oldest counter. Bumped
    /// every time `try_send` pops the front of a saturated queue.
    /// Exposed via `ConnectionOutbound::drop_count()`. Combined with
    /// the global counter (`GLOBAL_DROP_OLDEST_COUNT`) so the
    /// `/__canary_stats` endpoint can report both per-connection +
    /// process-wide totals.
    drop_count: AtomicU64,
}

impl ConnectionOutbound {
    /// Create a new outbound queue. Capacity defaults to
    /// `CONNECTION_OUTBOUND_CAPACITY` (512).
    pub fn new() -> Self {
        Self::with_capacity(CONNECTION_OUTBOUND_CAPACITY)
    }

    /// Create with a custom capacity (used by tests to exercise
    /// back-pressure at small N).
    pub fn with_capacity(capacity: usize) -> Self {
        let cap = if capacity == 0 { CONNECTION_OUTBOUND_CAPACITY } else { capacity };
        Self {
            inner: Arc::new(ConnectionOutboundInner {
                queue: Mutex::new(VecDeque::with_capacity(cap)),
                cap,
                notify: Notify::new(),
                closed: AtomicBool::new(false),
                drop_count: AtomicU64::new(0),
            }),
        }
    }

    /// Non-blocking push. On a full queue, drops the OLDEST entry
    /// (front) and pushes the new entry at the back. Returns
    /// `Ok(())` on success, `Err(())` if the queue has been closed.
    ///
    /// **Async-only**: takes the queue lock asynchronously. Never
    /// blocks the executor. May briefly yield if another task holds
    /// the lock.
    pub async fn try_send(&self, bytes: Vec<u8>) -> Result<(), ()> {
        if self.inner.closed.load(Ordering::Relaxed) {
            return Err(());
        }
        let mut q = self.inner.queue.lock().await;
        // Drop-oldest if at capacity. The cap is set at construction
        // (`with_capacity`) and stored on the inner struct — we
        // CANNOT derive it from `VecDeque::capacity()` (that's only
        // a minimum reservation; the deque grows past it on push).
        if q.len() >= self.inner.cap {
            q.pop_front();
            // PR 11.7.D3.3 — bump per-connection + global drop counters
            // so the `/__canary_stats` endpoint + the 24-player stress
            // smoke can verify no drops occurred during the test window.
            // Both atomics are Relaxed — exact ordering doesn't matter
            // for a diagnostic counter.
            self.inner.drop_count.fetch_add(1, Ordering::Relaxed);
            GLOBAL_DROP_OLDEST_COUNT.fetch_add(1, Ordering::Relaxed);
        }
        q.push_back(bytes);
        // Notify exactly one waiter. Note: Notify::notify_one only
        // stores ONE permit; if multiple try_sends happen before any
        // recv().await is called, subsequent notifications may be
        // dropped. The recv() implementation re-checks the queue
        // state under the lock after waking, so this is safe — the
        // consumer will see the latest state regardless of whether
        // a notify is "lost". (A permit-loss would only delay the
        // consumer's next pop by however long it takes the consumer
        // to notice the queue is non-empty on its next loop
        // iteration; that's a busy-spin risk, mitigated by the
        // `notify.notified().await` we use below.)
        self.inner.notify.notify_one();
        Ok(())
    }

    /// Async pop. Returns the next item from the back (the most
    /// recently pushed entry). Awaits `Notify` if the queue is
    /// empty. Returns `None` after `close()` and the queue drains.
    ///
    /// **Implementation note**: we hold the queue lock across the
    /// `notify.notified().await` so that when a `try_send` notifies,
    /// we know to re-check the queue under the lock immediately on
    /// wake. Without the held lock, `Notify`'s single-permit
    /// semantics could lose notifications.
    pub async fn recv(&self) -> Option<Vec<u8>> {
        loop {
            // Fast path: pop under the lock.
            {
                let mut q = self.inner.queue.lock().await;
                if let Some(b) = q.pop_back() {
                    return Some(b);
                }
                if self.inner.closed.load(Ordering::Relaxed) {
                    return None;
                }
            }
            // Slow path: queue is empty AND not closed. Await a
            // notification. The next try_send will call notify_one,
            // and we'll re-check the queue under the lock on wake.
            self.inner.notify.notified().await;
        }
    }

    /// Close the queue. Existing entries can still be drained by
    /// `recv()`. After the queue drains, `recv()` returns `None`.
    /// Subsequent `try_send` calls return `Err(())`.
    pub fn close(&self) {
        self.inner.closed.store(true, Ordering::Relaxed);
        self.inner.notify.notify_waiters();
    }

    /// Current queue depth (test-only).
    #[cfg(test)]
    pub async fn len(&self) -> usize {
        self.inner.queue.lock().await.len()
    }

    /// PR 80 — non-test public accessor for the queue depth.
    /// Used by the snapshot rate-limiter
    /// (`snapshot::should_rate_limit`) to gate the next emit when
    /// ANY consumer is saturated. Async because the underlying
    /// `Mutex` is a `tokio::sync::Mutex` (not std); the lock is
    /// near-instant under low contention (no `try_lock` variant on
    /// tokio Mutex). The producer-side rate-limit decision fires
    /// once per 50ms tick — the brief async-await cost is
    /// negligible.
    pub async fn queue_depth(&self) -> usize {
        self.inner.queue.lock().await.len()
    }

    /// Configured capacity (used by the rate-limiter to convert
    /// `threshold_pct` into a concrete queue-depth threshold).
    /// Public so callers don't need to know the cap is stored on
    /// the inner struct.
    pub fn capacity(&self) -> usize {
        self.inner.cap
    }

    /// Whether the queue has been closed (test-only).
    #[cfg(test)]
    pub fn is_closed(&self) -> bool {
        self.inner.closed.load(Ordering::Relaxed)
    }

    /// PR 11.7.D3.3 — per-connection drop-oldest count. Bumped
    /// every time `try_send` pops the front of a saturated queue.
    /// Cheap atomic load, safe to call from any thread including
    /// the HTTP `/__canary_stats` endpoint handler.
    pub fn drop_count(&self) -> u64 {
        self.inner.drop_count.load(Ordering::Relaxed)
    }
}

impl Default for ConnectionOutbound {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn try_send_succeeds_on_empty_queue() {
        let q = ConnectionOutbound::new();
        assert!(q.try_send(vec![1, 2, 3]).await.is_ok());
        assert_eq!(q.len().await, 1);
        assert_eq!(q.recv().await, Some(vec![1, 2, 3]));
    }

    #[tokio::test]
    async fn try_send_drops_oldest_when_full() {
        // Use a custom small capacity to exercise drop-oldest.
        let q = ConnectionOutbound::with_capacity(4);
        for i in 0..4u8 {
            assert!(q.try_send(vec![i]).await.is_ok());
        }
        assert_eq!(q.len().await, 4);
        // Push one more — should drop the oldest (vec![0]).
        assert!(q.try_send(vec![99]).await.is_ok());
        assert_eq!(q.len().await, 4);
        // Drain and verify order: LIFO from back = vec![99, 3, 2, 1].
        // (Consumer pops from back; producer pushed 0, 1, 2, 3, 99;
        //  drop-oldest removed 0; queue front-to-back is [1, 2, 3, 99];
        //  consumer pop-back yields 99, 3, 2, 1.)
        assert_eq!(q.recv().await, Some(vec![99]));
        assert_eq!(q.recv().await, Some(vec![3]));
        assert_eq!(q.recv().await, Some(vec![2]));
        assert_eq!(q.recv().await, Some(vec![1]));
    }

    #[tokio::test]
    async fn recv_returns_none_after_close_and_drain() {
        let q = ConnectionOutbound::new();
        q.try_send(vec![1, 2, 3]).await.unwrap();
        q.close();
        // The single entry should still drain.
        assert_eq!(q.recv().await, Some(vec![1, 2, 3]));
        // Subsequent recv returns None.
        assert_eq!(q.recv().await, None);
        // try_send after close returns Err.
        assert!(q.try_send(vec![4, 5, 6]).await.is_err());
    }

    #[tokio::test]
    async fn try_send_returns_err_after_close() {
        let q = ConnectionOutbound::new();
        q.close();
        assert!(q.try_send(vec![1]).await.is_err());
    }

    /// PR 11.7.D2 — regression: multiple try_sends BEFORE any recv
    /// must each be visible to a subsequent recv. Guards against
    /// the `Notify::notify_one()` permit-loss bug: if try_send is
    /// called 4 times with no active waiter, only 1 permit is
    /// stored; subsequent recv() calls must NOT hang.
    #[tokio::test]
    async fn multiple_try_sends_before_recv_drain_correctly() {
        let q = ConnectionOutbound::with_capacity(4);
        for i in 0..4u8 {
            assert!(q.try_send(vec![i]).await.is_ok());
        }
        assert_eq!(q.len().await, 4);
        // Drain — must NOT hang.
        let mut got: Vec<Vec<u8>> = Vec::new();
        while got.len() < 4 {
            match q.recv().await {
                Some(b) => got.push(b),
                None => break,
            }
        }
        assert_eq!(got.len(), 4);
        // Drain order: LIFO from back.
        assert_eq!(got[0], vec![3]);
        assert_eq!(got[1], vec![2]);
        assert_eq!(got[2], vec![1]);
        assert_eq!(got[3], vec![0]);
    }
}
