//! Orya Halo gateway: connects to public aircraft and ship feeds once,
//! normalises them and fans out to browsers over WebSocket, sending each
//! client only what its viewport needs. See `docs/PROTOCOL.md`.
//!
//! Layout:
//! - [`protocol`]: the wire codec, byte for byte the same as the TypeScript one.
//! - [`world`]: entity tables indexed by H3 cell, expiry, tracks, search.
//! - [`hub`]: subscriptions and per-tick fan-out.
//! - [`engine`]: the single task that owns the world and the hub.
//! - [`upstream`]: one module per feed, all behind the `Upstream` trait.
//! - [`ws`], [`http`]: the client-facing WebSocket and HTTP endpoints.
//! - [`firms`]: the wildfire proxy, a shared cache in front of NASA FIRMS.
//! - [`celestrak`]: the satellite element cache in front of CelesTrak.

pub mod celestrak;
pub mod config;
pub mod engine;
pub mod enrich;
pub mod firms;
pub mod http;
pub mod hub;
pub mod metrics;
pub mod model;
pub mod protocol;
pub mod upstream;
pub mod world;
pub mod ws;

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::time::Duration;

use anyhow::Context;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use crate::celestrak::CelestrakProxy;
use crate::config::Config;
use crate::engine::{Command, Engine};
use crate::enrich::Routes;
use crate::firms::FirmsProxy;
use crate::hub::Demand;
use crate::metrics::Metrics;
use crate::upstream::aircraft::Sweep;
use crate::upstream::{Registry, SourceState, UpstreamContext};
use crate::ws::ConnectionLimits;

/// Where per-callsign route files are fetched from. See [`enrich`].
const ROUTES_BASE: &str = "https://vrs-standing-data.adsb.lol/routes";

/// Everything a request handler needs. Cheap to clone.
#[derive(Clone)]
pub struct App {
    pub config: Arc<Config>,
    pub metrics: Arc<Metrics>,
    pub registry: Arc<Registry>,
    pub commands: mpsc::Sender<Command>,
    pub limits: Arc<ConnectionLimits>,
    pub next_conn_id: Arc<AtomicU64>,
    pub shutdown: watch::Receiver<bool>,
    /// The aircraft tile scheduler, when a tile-polling feed is running.
    pub sweep: Option<Arc<Sweep>>,
    pub routes: Arc<Routes>,
    pub firms: Arc<FirmsProxy>,
    pub celestrak: Arc<CelestrakProxy>,
}

/// Make rustls use the ring provider process-wide. Safe to call repeatedly.
pub fn install_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

/// An HTTP client for upstreams: rustls with ring and the bundled Mozilla
/// roots, so it behaves the same in a container with no system certificates.
pub fn http_client(user_agent: &str) -> anyhow::Result<reqwest::Client> {
    http_client_with(user_agent, true)
}

/// [`http_client`], optionally refusing to follow redirects: for providers
/// that answer a wrong or outdated URL with a redirect and ask clients to stop.
pub fn http_client_with(user_agent: &str, follow_redirects: bool) -> anyhow::Result<reqwest::Client> {
    install_crypto_provider();
    let roots = rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let tls = rustls::ClientConfig::builder().with_root_certificates(roots).with_no_client_auth();
    reqwest::Client::builder()
        .user_agent(user_agent)
        .tls_backend_preconfigured(tls)
        .gzip(true)
        .connect_timeout(Duration::from_secs(10))
        .pool_idle_timeout(Duration::from_secs(60))
        .redirect(if follow_redirects {
            reqwest::redirect::Policy::default()
        } else {
            reqwest::redirect::Policy::none()
        })
        .build()
        .context("building the HTTP client")
}

/// A request error with its causes, without the URL (which may carry a key).
pub fn describe_http_error(error: reqwest::Error) -> String {
    let error = error.without_url();
    let mut text = error.to_string();
    let mut cause = std::error::Error::source(&error);
    while let Some(inner) = cause {
        text.push_str(": ");
        text.push_str(&inner.to_string());
        cause = inner.source();
    }
    text
}

/// A running gateway.
pub struct Gateway {
    /// The address actually bound (useful when the configured port is 0).
    pub addr: SocketAddr,
    pub app: App,
    shutdown: watch::Sender<bool>,
    server: JoinHandle<()>,
    engine: JoinHandle<()>,
    feeds: Vec<JoinHandle<()>>,
}

impl Gateway {
    /// Stop accepting connections, close the open ones and stop the feeds.
    pub async fn stop(self) {
        let _ = self.shutdown.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(5), self.server).await;
        let _ = tokio::time::timeout(Duration::from_secs(2), self.engine).await;
        for feed in self.feeds {
            // Feeds watch the shutdown signal; one stuck in a request is cut off.
            let abort = feed.abort_handle();
            if tokio::time::timeout(Duration::from_secs(2), feed).await.is_err() {
                abort.abort();
            }
        }
    }
}

/// Start the gateway: feeds, engine and HTTP server. Returns once it is listening.
pub async fn start(config: Config) -> anyhow::Result<Gateway> {
    let config = Arc::new(config);
    let metrics = Arc::new(Metrics::default());
    metrics.started_ms.store(model::now_ms(), std::sync::atomic::Ordering::Relaxed);
    let http = http_client(&config.user_agent)?;

    let (upstream_tx, upstream_rx) = mpsc::channel(256);
    let (command_tx, command_rx) = mpsc::channel(1024);
    let (demand_tx, demand_rx) = watch::channel(Arc::new(Demand::default()));
    let (shutdown_tx, shutdown_rx) = watch::channel(false);

    let (feeds, sweep) = upstream::build(&config);
    let states: Vec<Arc<SourceState>> =
        feeds.iter().enumerate().map(|(i, feed)| Arc::new(SourceState::new(feed.info(), i as u8))).collect();
    let registry = Arc::new(Registry { sources: states.clone() });
    for state in &states {
        tracing::info!(
            source = state.info.id,
            layer = state.info.kind.layer(),
            licence = state.info.licence.name,
            "upstream enabled"
        );
    }

    let engine = Engine::new(&config, registry.clone(), metrics.clone(), demand_tx);
    let engine = tokio::spawn(engine.run(upstream_rx, command_rx, shutdown_rx.clone(), config.tick_ms));

    let feed_tasks = feeds
        .into_iter()
        .zip(states)
        .map(|(feed, state)| {
            let ctx = UpstreamContext::new(
                state,
                upstream_tx.clone(),
                demand_rx.clone(),
                shutdown_rx.clone(),
                http.clone(),
                config.clone(),
            );
            tokio::spawn(feed.run(ctx))
        })
        .collect();
    drop(upstream_tx);

    let app = App {
        config: config.clone(),
        metrics,
        registry,
        commands: command_tx,
        limits: Arc::new(ConnectionLimits::default()),
        next_conn_id: Arc::new(AtomicU64::new(1)),
        shutdown: shutdown_rx.clone(),
        sweep,
        routes: Arc::new(Routes::new(config.routes_enabled && config.mock.is_none(), ROUTES_BASE, http.clone())),
        firms: Arc::new(FirmsProxy::new(&config, http)),
        celestrak: Arc::new(CelestrakProxy::new(
            &config,
            http_client_with(&format!("{} ({})", config.user_agent, celestrak::USER_AGENT_PURPOSE), false)?,
        )),
    };

    let listener =
        tokio::net::TcpListener::bind(config.bind).await.with_context(|| format!("binding {}", config.bind))?;
    let addr = listener.local_addr()?;
    let router = http::router(app.clone());
    let mut stop = shutdown_rx;
    let server = tokio::spawn(async move {
        let serving = axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>())
            .with_graceful_shutdown(async move {
                let _ = stop.changed().await;
            });
        if let Err(e) = serving.await {
            tracing::error!(error = %e, "HTTP server stopped with an error");
        }
    });
    tracing::info!(%addr, mock = config.mock.is_some(), tick_ms = config.tick_ms, "gateway listening");

    Ok(Gateway { addr, app, shutdown: shutdown_tx, server, engine, feeds: feed_tasks })
}
