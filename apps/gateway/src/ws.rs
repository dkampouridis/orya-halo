//! One WebSocket per client: `GET /v1/stream?v=1`.
//!
//! The socket task owns the socket. It forwards frames the engine queues for
//! it, answers pings itself, validates subscriptions before they reach the
//! engine, and enforces the limits: connections in total and per address,
//! message size and rate, and an idle timeout.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::time::{Duration, Instant};

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use tokio::sync::mpsc;

use crate::App;
use crate::engine::Command;
use crate::hub::{Outbound, validate_sub};
use crate::metrics::Metrics;
use crate::model::Kind;
use crate::protocol::{ClientMessage, HelloLayer, HelloLayers, PROTOCOL_VERSION, ServerMessage};

/// A client that cannot take a frame for this long is gone.
const WRITE_TIMEOUT: Duration = Duration::from_secs(20);
/// Window for the client message rate limit.
const RATE_WINDOW: Duration = Duration::from_secs(10);

/// Counts connections in total and per client address.
#[derive(Default)]
pub struct ConnectionLimits {
    total: AtomicUsize,
    per_ip: Mutex<HashMap<IpAddr, usize>>,
}

/// Holds one connection's place in the limits; dropping it gives the place back.
pub struct Slot {
    limits: Arc<ConnectionLimits>,
    ip: IpAddr,
}

/// Why a connection was not admitted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    ServerFull,
    TooManyFromAddress,
}

impl ConnectionLimits {
    pub fn acquire(self: &Arc<Self>, ip: IpAddr, max_total: usize, max_per_ip: usize) -> Result<Slot, Refusal> {
        let mut per_ip = self.per_ip.lock();
        if self.total.load(Relaxed) >= max_total {
            return Err(Refusal::ServerFull);
        }
        let count = per_ip.entry(ip).or_insert(0);
        if *count >= max_per_ip {
            return Err(Refusal::TooManyFromAddress);
        }
        *count += 1;
        self.total.fetch_add(1, Relaxed);
        Ok(Slot { limits: self.clone(), ip })
    }

    pub fn total(&self) -> usize {
        self.total.load(Relaxed)
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut per_ip = self.limits.per_ip.lock();
        if let Some(count) = per_ip.get_mut(&self.ip) {
            *count -= 1;
            if *count == 0 {
                per_ip.remove(&self.ip);
            }
        }
        self.limits.total.fetch_sub(1, Relaxed);
    }
}

/// The address to count a request against. Behind a trusted proxy that is the
/// address the proxy reports, not the proxy's own.
/// `header` is the proxy's own client-address header (`Fly-Client-IP` on
/// Fly.io, `True-Client-IP` on Render); `None` when no proxy is trusted.
pub fn client_ip(headers: &HeaderMap, peer: SocketAddr, header: Option<&str>) -> IpAddr {
    if let Some(header) = header {
        let forwarded = headers
            .get(header)
            .and_then(|v| v.to_str().ok())
            .or_else(|| headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()).and_then(|v| v.split(',').next()));
        if let Some(ip) = forwarded.and_then(|v| v.trim().parse().ok()) {
            return ip;
        }
    }
    peer.ip()
}

fn refuse(app: &App, status: StatusCode, code: &str, message: &str) -> Response {
    Metrics::add(&app.metrics.connections_rejected, 1);
    (status, axum::Json(serde_json::json!({ "error": { "code": code, "message": message } }))).into_response()
}

/// `GET /v1/stream`: check the request, then upgrade.
pub async fn stream(
    State(app): State<App>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    if let Some(v) = params.get("v")
        && v != "1"
    {
        return refuse(
            &app,
            StatusCode::BAD_REQUEST,
            "unsupported_version",
            "This gateway speaks protocol version 1. Connect with ?v=1.",
        );
    }
    // Browsers always send Origin on a WebSocket handshake and CORS does not
    // apply to it, so the allow-list has to be enforced here.
    if let Some(origin) = headers.get("origin").and_then(|v| v.to_str().ok())
        && !app.config.allowed_origins.allows(origin)
    {
        return refuse(&app, StatusCode::FORBIDDEN, "origin_not_allowed", "This origin may not use this gateway.");
    }
    let ip = client_ip(&headers, peer, app.config.trust_proxy.then_some(app.config.client_ip_header.as_str()));
    let slot = match app.limits.acquire(ip, app.config.max_clients, app.config.max_clients_per_ip) {
        Ok(slot) => slot,
        Err(Refusal::ServerFull) => {
            return refuse(
                &app,
                StatusCode::SERVICE_UNAVAILABLE,
                "server_full",
                "The gateway has no free connections right now. Try again in a moment.",
            );
        }
        Err(Refusal::TooManyFromAddress) => {
            return refuse(
                &app,
                StatusCode::TOO_MANY_REQUESTS,
                "too_many_connections",
                "Too many connections from this address. Close another tab and try again.",
            );
        }
    };
    let compress = params.get("z").is_some_and(|z| z == "1");
    upgrade
        .max_message_size(app.config.max_message_bytes)
        .max_frame_size(app.config.max_message_bytes)
        // Clients send a few small JSON messages; the default 128 KiB read
        // buffer per connection would cost more memory than the whole world state.
        .read_buffer_size(4 * 1024)
        .on_upgrade(move |socket| serve(app, socket, compress, slot))
}

fn hello(app: &App) -> String {
    let layer = |kind: Kind| HelloLayer {
        status: app.registry.layer_status(kind) as u8,
        attribution: app.registry.layer_attribution(kind),
    };
    ServerMessage::Hello {
        v: PROTOCOL_VERSION,
        tick_ms: app.config.tick_ms,
        max_cells: app.config.max_cells,
        density_res: app.config.density_res,
        layers: HelloLayers { aircraft: layer(Kind::Aircraft), ships: layer(Kind::Ship) },
    }
    .to_json()
}

async fn serve(app: App, socket: WebSocket, compress: bool, _slot: Slot) {
    let id = app.next_conn_id.fetch_add(1, Relaxed);
    Metrics::add(&app.metrics.connections_total, 1);
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<Outbound>(app.config.client_queue);

    // Every write goes through here so a stalled client cannot park the task forever.
    macro_rules! send {
        ($message:expr) => {
            matches!(tokio::time::timeout(WRITE_TIMEOUT, sink.send($message)).await, Ok(Ok(())))
        };
    }

    if !send!(Message::text(hello(&app))) {
        return;
    }
    if app.commands.send(Command::Connect { id, tx, compress }).await.is_err() {
        return;
    }

    let idle_timeout = Duration::from_secs(app.config.idle_timeout_s);
    let mut ping = tokio::time::interval(Duration::from_secs(app.config.ping_interval_s.max(1)));
    ping.reset();
    let mut shutdown = app.shutdown.clone();
    let mut last_heard = Instant::now();
    let mut window_start = Instant::now();
    let mut window_count = 0u32;

    let close: Option<(u16, &'static str)> = loop {
        tokio::select! {
            outbound = rx.recv() => {
                let message = match outbound {
                    Some(Outbound::Frame(bytes)) => Message::Binary(bytes),
                    Some(Outbound::Text(text)) => Message::text(text),
                    None => break Some((1001, "The gateway is shutting down.")),
                };
                if !send!(message) {
                    break None;
                }
            }
            incoming = stream.next() => {
                let text = match incoming {
                    Some(Ok(Message::Text(text))) => text,
                    Some(Ok(Message::Binary(_))) => {
                        last_heard = Instant::now();
                        Metrics::add(&app.metrics.client_errors, 1);
                        let error = ServerMessage::error("bad_request", "Send JSON text messages, not binary.");
                        if !send!(Message::text(error.to_json())) {
                            break None;
                        }
                        continue;
                    }
                    // The WebSocket layer answers pings itself.
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {
                        last_heard = Instant::now();
                        continue;
                    }
                    Some(Ok(Message::Close(_))) => {
                        // The reply to a close frame is queued by the WebSocket layer;
                        // flush it so the client sees a clean close, not a dropped line.
                        let _ = tokio::time::timeout(Duration::from_secs(2), sink.close()).await;
                        break None;
                    }
                    Some(Err(_)) | None => break None,
                };
                last_heard = Instant::now();
                Metrics::add(&app.metrics.client_messages, 1);
                if window_start.elapsed() > RATE_WINDOW {
                    window_start = Instant::now();
                    window_count = 0;
                }
                window_count += 1;
                let reply = if window_count > app.config.max_messages_per_10s {
                    Some(ServerMessage::error("rate_limited", "Too many messages. Wait a few seconds."))
                } else {
                    match serde_json::from_str::<ClientMessage>(text.as_str()) {
                        Ok(ClientMessage::Ping { id }) => Some(ServerMessage::Pong { id }),
                        Ok(ClientMessage::Sub { layers, res, cells, points, density }) => {
                            match validate_sub(&layers, res, &cells, points, density, app.config.max_cells) {
                                Ok(shape) => {
                                    if app.commands.send(Command::Subscribe { id, shape }).await.is_err() {
                                        break Some((1001, "The gateway is shutting down."));
                                    }
                                    None
                                }
                                // The previous subscription stays in force.
                                Err(e) => Some(ServerMessage::error(e.code, e.message)),
                            }
                        }
                        Err(_) => Some(ServerMessage::error(
                            "bad_request",
                            "Message not understood. Send {\"t\":\"sub\",...} or {\"t\":\"ping\",\"id\":1}.",
                        )),
                    }
                };
                if let Some(reply) = reply {
                    if matches!(reply, ServerMessage::Error { .. }) {
                        Metrics::add(&app.metrics.client_errors, 1);
                    }
                    if !send!(Message::text(reply.to_json())) {
                        break None;
                    }
                }
            }
            _ = ping.tick() => {
                if last_heard.elapsed() > idle_timeout {
                    break Some((1001, "Closed after a long silence. Reconnect to resume."));
                }
                if !send!(Message::Ping(bytes::Bytes::new())) {
                    break None;
                }
            }
            _ = shutdown.changed() => break Some((1001, "The gateway is shutting down.")),
        }
    };

    if let Some((code, reason)) = close {
        let frame = CloseFrame { code, reason: reason.into() };
        let _ = tokio::time::timeout(Duration::from_secs(2), sink.send(Message::Close(Some(frame)))).await;
    }
    let _ = app.commands.send(Command::Disconnect { id }).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_are_enforced_and_released() {
        let limits = Arc::new(ConnectionLimits::default());
        let a: IpAddr = "10.0.0.1".parse().unwrap();
        let b: IpAddr = "10.0.0.2".parse().unwrap();
        let s1 = limits.acquire(a, 3, 2).unwrap();
        let _s2 = limits.acquire(a, 3, 2).unwrap();
        assert_eq!(limits.acquire(a, 3, 2).err(), Some(Refusal::TooManyFromAddress));
        let _s3 = limits.acquire(b, 3, 2).unwrap();
        assert_eq!(limits.acquire(b, 3, 2).err(), Some(Refusal::ServerFull));
        assert_eq!(limits.total(), 3);
        drop(s1);
        assert_eq!(limits.total(), 2);
        assert!(limits.acquire(a, 3, 2).is_ok());
        assert!(limits.per_ip.lock().contains_key(&a));
    }

    #[test]
    fn the_client_address_comes_from_the_proxy_only_when_trusted() {
        let peer: SocketAddr = "172.16.0.9:5555".parse().unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "203.0.113.7, 10.0.0.1".parse().unwrap());
        assert_eq!(client_ip(&headers, peer, None), peer.ip());
        assert_eq!(client_ip(&headers, peer, Some("fly-client-ip")).to_string(), "203.0.113.7");
        headers.insert("fly-client-ip", "198.51.100.4".parse().unwrap());
        assert_eq!(client_ip(&headers, peer, Some("fly-client-ip")).to_string(), "198.51.100.4");
        assert_eq!(client_ip(&HeaderMap::new(), peer, Some("fly-client-ip")), peer.ip());
        // Render: Cloudflare's True-Client-IP wins over a forwarded chain a client could have started.
        headers.insert("true-client-ip", "192.0.2.33".parse().unwrap());
        assert_eq!(client_ip(&headers, peer, Some("true-client-ip")).to_string(), "192.0.2.33");
    }
}
