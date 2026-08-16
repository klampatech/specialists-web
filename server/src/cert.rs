// PR 11.6.B / §3.3 — self-signed cert handling for WebTransport.
//
// WebTransport (HTTP/3 + QUIC) requires TLS. In dev / CI we use a
// self-signed cert generated at runtime (not committed — see
// `.gitignore`'s `server/certs/*.pem|*.key` entries). In production
// (PR 11.11) this is replaced with Let's Encrypt.
//
// `wtransport` 0.5 ships a built-in self-signed generator (the
// `self-signed` cargo feature) — we use it instead of pulling in
// `rcgen` directly. The brief allows either ("rcgen or equivalent")
// and wtransport's builder is the path of least resistance: same
// library, no extra dep, PEM output via `store_pemfile()`.

use std::path::Path;

use anyhow::{Context, Result};
use wtransport::Identity;

/// Default Subject Alternative Names for the dev cert.
///
/// Why three: localhost (most browser dev), 127.0.0.1 (IP-literal URLs
/// bypass the DNS SAN check), and ::1 (IPv6 loopback). The Tailscale
/// dev-box IP (100.x.x.x) is added by `tools/canary-server.sh` via the
/// `--sans` CLI flag when Kyle boots from a non-loopback host — see
/// `main.rs` for the CLI handling.
pub const DEFAULT_SANS: &[&str] = &["localhost", "127.0.0.1", "::1"];

/// If both files exist, do nothing. Otherwise generate a self-signed
/// identity with the given SANs and write PEM-encoded cert + key to
/// `cert_path` / `key_path` (creating the parent directory if needed).
///
/// Idempotent — safe to call on every server boot.
pub async fn ensure_dev_certs<S, I>(
    cert_path: &Path,
    key_path: &Path,
    subject_alt_names: I,
) -> Result<()>
where
    S: AsRef<str>,
    I: IntoIterator<Item = S>,
{
    if cert_path.exists() && key_path.exists() {
        tracing::info!(
            "reusing existing dev cert at {} (delete to regenerate)",
            cert_path.display()
        );
        return Ok(());
    }

    let sans: Vec<String> = subject_alt_names
        .into_iter()
        .map(|s| s.as_ref().to_string())
        .collect();

    tracing::info!(
        "generating self-signed cert with SANs {:?} -> {}, {}",
        sans,
        cert_path.display(),
        key_path.display()
    );

    let identity = Identity::self_signed(sans)
        .context("Identity::self_signed failed — invalid SAN list?")?;

    if let Some(parent) = cert_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("create_dir_all({})", parent.display()))?;
    }

    identity
        .certificate_chain()
        .store_pemfile(cert_path)
        .await
        .with_context(|| format!("store_pemfile({})", cert_path.display()))?;

    identity
        .private_key()
        .store_secret_pemfile(key_path)
        .await
        .with_context(|| format!("store_secret_pemfile({})", key_path.display()))?;

    Ok(())
}

/// Convenience wrapper around `wtransport::Identity::load_pemfiles`.
pub async fn load_identity(
    cert_path: &Path,
    key_path: &Path,
) -> Result<Identity, wtransport::tls::error::PemLoadError> {
    Identity::load_pemfiles(cert_path, key_path).await
}
