//! Outbound WebSocket connections to streaming upstreams.
//!
//! This uses `yawc` rather than the `tungstenite` stack that serves our own
//! clients because some providers (AISStream) expect `permessage-deflate`,
//! which tungstenite does not implement. TLS is rustls with the ring provider.

use std::time::Duration;

use anyhow::{Context, anyhow};
use yawc::{HttpRequestBuilder, Options, WebSocket};

pub use yawc::{Frame, OpCode};

pub type Socket = yawc::TcpWebSocket;

/// Largest message accepted from an upstream.
const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;

/// Open a WebSocket. `headers` are added to the handshake; `compression`
/// offers `permessage-deflate` (the server may still decline).
pub async fn connect(
    url: &str,
    headers: &[(&str, &str)],
    compression: bool,
    timeout: Duration,
) -> anyhow::Result<Socket> {
    crate::install_crypto_provider();
    let parsed = url.parse().map_err(|e| anyhow!("invalid WebSocket URL: {e}"))?;
    let mut options = Options::default().with_limits(MAX_MESSAGE_BYTES, 2 * MAX_MESSAGE_BYTES).with_no_delay();
    options = if compression { options.with_balanced_compression() } else { options.without_compression() };
    let mut request = HttpRequestBuilder::new();
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let connecting = WebSocket::connect(parsed).with_options(options).with_request(request);
    tokio::time::timeout(timeout, connecting)
        .await
        .map_err(|_| anyhow!("timed out connecting"))?
        .context("WebSocket handshake failed")
}
