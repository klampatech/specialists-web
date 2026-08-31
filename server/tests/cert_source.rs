// PR 11.6.E / §3.3 — tests for the cert-source dispatcher.
//
// Covers:
//   - CertSource::from_str parses both accepted values + rejects garbage
//   - ensure_letsencrypt_certs fails loud when the cert OR key is missing
//     (production mode never silently falls back to self-signed)
//   - ensure_certs dispatcher routes SelfSigned → ensure_dev_certs
//     (which generates a self-signed cert when files are missing)
//
// These tests don't exercise the Funnel flow itself (that's a real-cert
// integration test in `client-tools-funnel-smoke`); they cover the
// fail-loud behavior at the cert-loader layer so a regression in the
// dispatcher surface is caught at `cargo test` time instead of at
// boot-in-prod time.

use std::path::PathBuf;

use specialists_server::cert::{ensure_certs, ensure_letsencrypt_certs, CertSource};

#[test]
fn cert_source_parses_self_signed_variants() {
    for raw in ["self-signed", "selfsigned", "self_signed"] {
        assert_eq!(
            CertSource::from_str(raw).unwrap(),
            CertSource::SelfSigned,
            "{raw:?} should parse as SelfSigned"
        );
    }
}

#[test]
fn cert_source_parses_letsencrypt_variants() {
    for raw in ["letsencrypt", "lets-encrypt", "lets_encrypt"] {
        assert_eq!(
            CertSource::from_str(raw).unwrap(),
            CertSource::LetsEncrypt,
            "{raw:?} should parse as LetsEncrypt"
        );
    }
}

#[test]
fn cert_source_rejects_unknown_value() {
    let err = CertSource::from_str("auto-detect").unwrap_err();
    let msg = format!("{err:?}");
    assert!(
        msg.contains("auto-detect") && msg.contains("self-signed") && msg.contains("letsencrypt"),
        "error message should mention the bad value AND the accepted set, got: {msg}"
    );
}

#[tokio::test]
async fn ensure_letsencrypt_certs_fails_when_cert_missing() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let cert_path = tmp.path().join("missing.pem");
    let key_path = tmp.path().join("present.key");

    // Create ONLY the key — cert missing.
    tokio::fs::write(&key_path, b"dummy").await.unwrap();

    let err = ensure_letsencrypt_certs(&cert_path, &key_path)
        .await
        .expect_err("must fail when cert is missing");
    let msg = format!("{err:?}");
    assert!(
        msg.contains("letsencrypt cert not found") && msg.contains("missing.pem"),
        "error should point at the missing cert path, got: {msg}"
    );
}

#[tokio::test]
async fn ensure_letsencrypt_certs_fails_when_key_missing() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let cert_path = tmp.path().join("present.pem");
    let key_path = tmp.path().join("missing.key");

    // Create ONLY the cert — key missing.
    tokio::fs::write(&cert_path, b"dummy").await.unwrap();

    let err = ensure_letsencrypt_certs(&cert_path, &key_path)
        .await
        .expect_err("must fail when key is missing");
    let msg = format!("{err:?}");
    assert!(
        msg.contains("letsencrypt key not found") && msg.contains("missing.key"),
        "error should point at the missing key path, got: {msg}"
    );
}

#[tokio::test]
async fn ensure_letsencrypt_certs_fails_when_both_missing() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let cert_path = tmp.path().join("nope.pem");
    let key_path = tmp.path().join("nope.key");

    let err = ensure_letsencrypt_certs(&cert_path, &key_path)
        .await
        .expect_err("must fail when both files are missing");
    let msg = format!("{err:?}");
    // Cert is checked first; we should see the cert error.
    assert!(
        msg.contains("cert not found"),
        "cert is checked first; error should mention the cert, got: {msg}"
    );
}

#[tokio::test]
async fn ensure_certs_self_signed_generates_when_missing() {
    // The dispatcher for SelfSigned delegates to ensure_dev_certs,
    // which generates a self-signed cert when both files are missing.
    // Verify the dispatcher doesn't accidentally short-circuit.
    let tmp = tempfile::tempdir().expect("tempdir");
    let cert_path: PathBuf = tmp.path().join("dev.pem");
    let key_path: PathBuf = tmp.path().join("dev.key");

    ensure_certs(
        CertSource::SelfSigned,
        &cert_path,
        &key_path,
        vec!["localhost".to_string()],
    )
    .await
    .expect("SelfSigned dispatcher must generate cert + key");

    assert!(cert_path.exists(), "self-signed cert should exist after generate");
    assert!(key_path.exists(), "self-signed key should exist after generate");
}

#[tokio::test]
async fn ensure_certs_letsencrypt_fails_loud() {
    // The dispatcher for LetsEncrypt delegates to ensure_letsencrypt_certs,
    // which fails loud when files are missing. Verify the dispatcher
    // doesn't accidentally fall back to self-signed in production mode.
    let tmp = tempfile::tempdir().expect("tempdir");
    let cert_path: PathBuf = tmp.path().join("lets-encrypt.pem");
    let key_path: PathBuf = tmp.path().join("lets-encrypt.key");

    let err = ensure_certs(
        CertSource::LetsEncrypt,
        &cert_path,
        &key_path,
        vec![], // SANs ignored in letsencrypt mode
    )
    .await
    .expect_err("LetsEncrypt dispatcher must fail loud when files missing");

    let msg = format!("{err:?}");
    assert!(
        msg.contains("letsencrypt") || msg.contains("lets-encrypt"),
        "error should reference the letsencrypt source, got: {msg}"
    );

    // Critical: the dispatcher must NOT have generated a self-signed cert
    // as a fallback. The files should still be missing.
    assert!(!cert_path.exists(), "LetsEncrypt must NOT generate a self-signed fallback");
    assert!(!key_path.exists(), "LetsEncrypt must NOT generate a self-signed fallback");
}
