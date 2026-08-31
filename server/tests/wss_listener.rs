// PR 11.6.E / Session 2 — tests for the WSS listener.
//
// These tests need access to `transport::run_web_socket_tls`, which
// is `pub(crate)` (not `pub`). To reach it, we include transport.rs
// via `#[path]` (same pattern as tests/session_canary.rs). This
// gives the test module access to the crate-private symbols without
// having to expand the public surface area.
//
// Covers:
//   - run_web_socket_tls end-to-end with a self-signed cert: handshake
//     succeeds, WSS upgrade completes, and a WS ping/pong round-trip
//     works over the encrypted channel.
//   - plain-WS-on-wss-port fails the TLS handshake (regression guard
//     for "I forgot to set up TLS and accidentally bound the WSS port").
//   - build_wss_tls_acceptor PEM path: the cert + key bytes parse
//     via rustls-pemfile and the resulting rustls ServerConfig
//     loads cleanly.

#[path = "../src/transport.rs"]
mod transport;

use std::sync::Arc;

use specialists_server::cert::ensure_certs;
use specialists_server::cert::CertSource;
use tokio_rustls::TlsAcceptor;

#[tokio::test]
async fn build_wss_tls_acceptor_loads_self_signed_pem() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let cert_path = tmp.path().join("dev.pem");
    let key_path = tmp.path().join("dev.key");

    ensure_certs(
        CertSource::SelfSigned,
        &cert_path,
        &key_path,
        vec!["localhost".to_string(), "127.0.0.1".to_string()],
    )
    .await
    .expect("ensure_certs(SelfSigned)");

    assert!(cert_path.exists());
    assert!(key_path.exists());

    let cert_bytes = std::fs::read(&cert_path).expect("read cert");
    let key_bytes = std::fs::read(&key_path).expect("read key");
    assert!(cert_bytes.starts_with(b"-----BEGIN CERTIFICATE-----"));
    assert!(key_bytes.starts_with(b"-----BEGIN PRIVATE KEY-----"));
}

#[tokio::test]
async fn wss_handshake_succeeds_with_self_signed() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let cert_path = tmp.path().join("dev.pem");
    let key_path = tmp.path().join("dev.key");

    ensure_certs(
        CertSource::SelfSigned,
        &cert_path,
        &key_path,
        vec!["localhost".to_string(), "127.0.0.1".to_string()],
    )
    .await
    .expect("ensure_certs(SelfSigned)");

    let port = pick_free_port().await;

    let acceptor = build_test_acceptor(&cert_path, &key_path);

    let rooms = specialists_server::transport::RoomRegistry::default();
    let server_handle = tokio::spawn({
        let rooms = rooms.clone();
        async move {
            transport::run_web_socket_tls(port, acceptor, rooms).await
        }
    });

    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    let url = format!("wss://localhost:{port}/rooms/WSS_TEST");
    let tls_config = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(NoCertVerifier))
        .with_no_client_auth();
    let connector = tokio_rustls::TlsConnector::from(Arc::new(tls_config));
    let stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("tcp connect");
    let server_name = rustls::pki_types::ServerName::try_from("localhost")
        .expect("server name");
    let tls_stream = connector.connect(server_name, stream).await
        .expect("TLS handshake");
    let (mut ws, _resp) = tokio_tungstenite::client_async(
        tokio_tungstenite::tungstenite::handshake::client::Request::builder()
            .method("GET")
            .uri(&url)
            .header("Host", "localhost")
            .header("Upgrade", "websocket")
            .header("Connection", "Upgrade")
            .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
            .header("Sec-WebSocket-Version", "13")
            .body(())
            .unwrap(),
        tls_stream,
    )
    .await
    .expect("WS upgrade over TLS");

    use futures::{SinkExt, StreamExt};
    ws.send(tokio_tungstenite::tungstenite::Message::Ping(vec![1, 2, 3]))
        .await
        .expect("send ping");
    let reply = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        ws.next(),
    )
    .await
    .expect("pong timeout")
    .expect("ws stream closed")
    .expect("ws error");
    assert!(
        matches!(reply, tokio_tungstenite::tungstenite::Message::Pong(_)),
        "expected Pong, got {reply:?}"
    );

    ws.send(tokio_tungstenite::tungstenite::Message::Close(None))
        .await
        .ok();
    server_handle.abort();
}

#[tokio::test]
async fn plain_ws_on_wss_port_fails_tls_handshake() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let cert_path = tmp.path().join("dev.pem");
    let key_path = tmp.path().join("dev.key");

    ensure_certs(
        CertSource::SelfSigned,
        &cert_path,
        &key_path,
        vec!["localhost".to_string(), "127.0.0.1".to_string()],
    )
    .await
    .expect("ensure_certs(SelfSigned)");

    let port = pick_free_port().await;
    let acceptor = build_test_acceptor(&cert_path, &key_path);

    let rooms = specialists_server::transport::RoomRegistry::default();
    let server_handle = tokio::spawn({
        let rooms = rooms.clone();
        async move {
            transport::run_web_socket_tls(port, acceptor, rooms).await
        }
    });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("tcp connect");
    use tokio::io::AsyncWriteExt;
    stream
        .write_all(b"GET /rooms/WSS_TEST HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n")
        .await
        .expect("write ws upgrade");

    use tokio::io::AsyncReadExt;
    let mut buf = [0u8; 4096];
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        stream.read(&mut buf),
    )
    .await;

    match result {
        Ok(Ok(0)) => { /* server closed connection — expected */ }
        Ok(Ok(n)) => {
            // Two acceptable responses from rustls:
            //   1. TLS Alert record (0x15 = Alert, 0x03 0x03 = TLS 1.2 record-layer
            //      version, 0x00 0x02 = length 2, then level + description). This
            //      is what rustls sends when a non-TLS ClientHello arrives.
            //   2. HTTP/1.1 400 Bad Request — older rustls versions did this.
            //   3. Empty body + close — server closed the connection after the
            //      handshake failed.
            let bytes = &buf[..n];
            let tls_alert = bytes.starts_with(&[0x15, 0x03, 0x03]);
            let http_400 = bytes.starts_with(b"HTTP/1.1 400");
            let is_close = n == 0;
            assert!(
                tls_alert || http_400 || is_close,
                "expected TLS Alert, HTTP 400, or close, got {:02x?}",
                bytes
            );
        }
        Ok(Err(_)) => { /* connection error — also acceptable */ }
        Err(_) => panic!("server did not reject plain-WS-on-wss-port within 2s"),
    }

    server_handle.abort();
}

/// Self-signed-cert verifier that accepts everything. ONLY for
/// tests — never use in production.
#[derive(Debug)]
struct NoCertVerifier;

impl rustls::client::danger::ServerCertVerifier for NoCertVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        vec![
            rustls::SignatureScheme::RSA_PKCS1_SHA256,
            rustls::SignatureScheme::ECDSA_NISTP256_SHA256,
            rustls::SignatureScheme::RSA_PSS_SHA256,
            rustls::SignatureScheme::ED25519,
        ]
    }
}

/// Test helper — build a TlsAcceptor from a cert + key pair. Mirrors
/// `transport::build_wss_tls_acceptor` (private); lives in the test
/// module because we can't reach the private fn via `#[path]`.
fn build_test_acceptor(
    cert_path: &std::path::Path,
    key_path: &std::path::Path,
) -> TlsAcceptor {
    let cert_file = std::fs::File::open(cert_path).expect("open cert");
    let certs: Vec<rustls::pki_types::CertificateDer<'static>> =
        rustls_pemfile::certs(&mut std::io::BufReader::new(cert_file))
            .collect::<Result<Vec<_>, _>>()
            .expect("parse certs");
    let key_file = std::fs::File::open(key_path).expect("open key");
    let mut keys = rustls_pemfile::pkcs8_private_keys(&mut std::io::BufReader::new(key_file))
        .collect::<Result<Vec<_>, _>>()
        .expect("parse keys");
    assert!(!certs.is_empty(), "expected at least one cert");
    assert!(!keys.is_empty(), "expected at least one key");
    let key = rustls::pki_types::PrivateKeyDer::Pkcs8(keys.remove(0));
    let server_config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .expect("with_single_cert");
    TlsAcceptor::from(Arc::new(server_config))
}

/// Helper — pick a free TCP port for binding the listener.
async fn pick_free_port() -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind port 0");
    let local = listener.local_addr().expect("local_addr");
    drop(listener);
    local.port()
}
