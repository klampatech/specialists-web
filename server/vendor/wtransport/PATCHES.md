# PR 11.6.B — local patches to vendored `wtransport` 0.5.0

This directory contains a vendored copy of [`wtransport` 0.5.0](https://crates.io/crates/wtransport/0.5.0)
plus [`wtransport-proto` 0.5.0](https://crates.io/crates/wtransport-proto/0.5.0),
with one tiny patch applied to `wtransport`'s `driver/utils.rs`:

## The patch

```diff
--- a/src/driver/utils.rs
+++ b/src/driver/utils.rs
@@ -27,9 +27,10 @@
 #[inline(always)]
 pub fn streamid_q2w(stream_id: quinn::StreamId) -> StreamId {
-    let varint = unsafe {
-        debug_assert!(stream_id.0 <= VarInt::MAX.into_inner());
-        VarInt::from_u64_unchecked(stream_id.0)
-    };
+    // PR 11.6.B patch: use the public `From<StreamId> for u64` impl
+    // instead of the private `.0` field. quinn 0.11.9+ made `StreamId.0`
+    // crate-private (see https://github.com/quinn-rs/quinn/pull/2294), so
+    // the upstream `stream_id.0` access fails to compile against current
+    // quinn releases. The `From` impl is public and equivalent.
+    let as_u64: u64 = stream_id.into();
+    let varint = unsafe {
+        debug_assert!(as_u64 <= VarInt::MAX.into_inner());
+        VarInt::from_u64_unchecked(as_u64)
+    };
     StreamId::new(varint)
 }
```

## Why vendored (and not a `[patch.crates-io]` redirect)

1. **Reproducibility.** The wtransport 0.5.x API is unstable across
   versions and the `.0`-privacy regression was introduced silently
   in a minor quinn release. Pinning the source in-tree means the
   patch is reviewed with every PR that touches the server.

2. **Documented carry-forward.** PR 11.6.C (wire protocol + transport
   mux) will replace `transport::run_web_transport` with the
   discriminator router. When PR 11.6.C lands, we should consider
   upgrading to the current wtransport release and dropping the
   vendor — the discriminator path doesn't need `streamid_q2w` at
   all. This directory + Cargo.toml `[patch.crates-io]` block are the
   easy removal targets at that point.

## What did NOT change

Every other `wtransport` and `wtransport-proto` source file is byte-
identical to upstream 0.5.0. The single-file diff above is the only
modification. Diff the directory against a fresh
`cargo new --lib wtransport && cp src/* wtransport/src/` from the
upstream 0.5.0 tarball to confirm.
