// PR 11.6.B / §3.3 — cert handling for WebTransport.
//
// WebTransport (HTTP/3 + QUIC) requires TLS. Two cert sources:
//
// - `self-signed` (default for dev/CI): generated at runtime via
//   `wtransport`'s built-in `self-signed` cargo feature. Not
//   committed — see `.gitignore`'s `server/certs/*.pem|*.key`
//   entries.
// - `letsencrypt` (production / cloud deploy): loaded from
//   `server/certs/lets-encrypt.pem` + `.key` on disk, where the
//   systemd unit in `tools/specialists-server.service` writes the
//   Funnel-provisioned cert via Tailscale's built-in ACME flow.
//
// The cert source is selected by the `--cert-source` CLI flag in
// `main.rs` and threaded through `run_server`. SANs come from the
// cert itself in `letsencrypt` mode (no `--sans` flag needed); in
// `self-signed` mode SANs default to `DEFAULT_SANS` plus any
// user-supplied entries.
//
// `wtransport` 0.5's `Identity::self_signed` is used for dev
// generation (no extra `rcgen` dep, same library, PEM output via
// `store_pemfile()`).

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use wtransport::Identity;

/// Where the server's TLS cert + key come from.
///
/// `SelfSigned` is the dev / CI default: cert is generated at runtime
/// by `ensure_dev_certs` and the cert files live in
/// `server/certs/dev.{pem,key}`. SANs come from the `--sans` CLI flag
/// (default `DEFAULT_SANS`).
///
/// `LetsEncrypt` is the production / cloud-deploy path: cert is
/// loaded from disk by `ensure_letsencrypt_certs` and the cert files
/// live in `server/certs/lets-encrypt.{pem,key}`. SANs come from the
/// cert itself (no `--sans` needed in this mode) — the Tailscale
/// Funnel provisioning flow bakes the Funnel hostname SAN
/// (e.g. `m5.tail1b3795.ts.net`) into the cert at issuance time.
///
/// Selecting the source at startup (rather than auto-detecting by
/// "if file exists, use it") keeps the operator in control. The
/// systemd unit in `tools/specialists-server.service` is responsible
/// for writing the Let's Encrypt cert to disk before the server
/// boots; if the files don't exist, we fail loud instead of silently
/// falling back to self-signed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CertSource {
    SelfSigned,
    LetsEncrypt,
}

impl CertSource {
    /// Parse the `--cert-source` CLI value. Defaults to `SelfSigned`.
    pub fn from_str(s: &str) -> Result<Self> {
        match s {
            "self-signed" | "selfsigned" | "self_signed" => Ok(Self::SelfSigned),
            "letsencrypt" | "lets-encrypt" | "lets_encrypt" => Ok(Self::LetsEncrypt),
            other => Err(anyhow!(
                "unknown --cert-source value: {other:?} (expected 'self-signed' or 'letsencrypt')"
            )),
        }
    }
}

/// Default cert file paths for the Let's Encrypt source. Matches the
/// systemd unit's `ExecStartPost` in `tools/specialists-server.service`.
pub const LETS_ENCRYPT_CERT: &str = "server/certs/lets-encrypt.pem";
pub const LETS_ENCRYPT_KEY: &str = "server/certs/lets-encrypt.key";

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
///
/// Used by both cert sources — `self-signed` mode generates the PEM
/// first via `ensure_dev_certs` and then loads it here; `letsencrypt`
/// mode skips the generation step and goes straight to load.
pub async fn load_identity(
    cert_path: &Path,
    key_path: &Path,
) -> Result<Identity, wtransport::tls::error::PemLoadError> {
    Identity::load_pemfiles(cert_path, key_path).await
}

/// Production / cloud-deploy cert loader. Fails loud if either file
/// is missing — we never silently fall back to a self-signed cert in
/// production mode, because that would defeat the entire purpose of
/// this PR (real domain, real cert, no dev-cert browser warning).
///
/// Unlike `ensure_dev_certs`, this function does NOT generate
/// anything. The Tailscale Funnel provisioning flow (wired up by
/// `tools/specialists-server.service`'s `ExecStartPost`) is the
/// single source of the PEM files. If they aren't on disk when the
/// server boots, the systemd unit failed and the operator needs to
/// see the error, not have the server silently start with a
/// self-signed cert.
///
/// Returns the canonical paths used (handy for the `info!` log
/// line so the operator can verify the expected file was loaded).
pub async fn ensure_letsencrypt_certs(
    cert_path: &Path,
    key_path: &Path,
) -> Result<(PathBuf, PathBuf)> {
    if !cert_path.exists() {
        return Err(anyhow!(
            "letsencrypt cert not found at {} — run `tailscale funnel --https=14433 on` \
             and verify the systemd unit's ExecStartPost wrote the cert",
            cert_path.display()
        ));
    }
    if !key_path.exists() {
        return Err(anyhow!(
            "letsencrypt key not found at {} — run `tailscale funnel --https=14433 on` \
             and verify the systemd unit's ExecStartPost wrote the key",
            key_path.display()
        ));
    }

    tracing::info!(
        "loading production cert from {} (letsencrypt / Tailscale Funnel)",
        cert_path.display()
    );

    Ok((cert_path.to_path_buf(), key_path.to_path_buf()))
}

/// Single entry-point that takes the `CertSource` and dispatches to
/// the right loader. Used by `run_server` in `transport.rs`.
pub async fn ensure_certs(
    source: CertSource,
    cert_path: &Path,
    key_path: &Path,
    sans: Vec<String>,
) -> Result<()> {
    match source {
        CertSource::SelfSigned => ensure_dev_certs(cert_path, key_path, sans).await,
        CertSource::LetsEncrypt => ensure_letsencrypt_certs(cert_path, key_path)
            .await
            .map(|_| ()),
    }
}
