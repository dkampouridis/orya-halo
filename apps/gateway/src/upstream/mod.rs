//! Upstream feeds.
//!
//! Every feed implements [`Upstream`]: it states who it is and under which
//! terms its data may be shown, and runs a loop that pushes normalised
//! [`Observation`]s into the gateway. This is the gateway-side mirror of the
//! app's `SourcePlugin`. Adding a feed means adding a module and one line in
//! [`build`]; the fan-out code never changes.

pub mod aircraft;
pub mod ais;
pub mod aisstream;
pub mod budget;
pub mod digitraffic;
pub mod mock;
pub mod readsb;
pub mod tiles;
pub mod wsclient;

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicI64, AtomicU8, AtomicU64, Ordering::Relaxed};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::{mpsc, watch};

use crate::config::Config;
use crate::hub::Demand;
use crate::model::{Kind, Observation, UpstreamMessage, UpstreamStatus, now_ms};

/// What a provider's terms permit. Mirrors `docs/DATA_LICENCES.md`.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Licence {
    pub name: &'static str,
    pub url: &'static str,
    /// Showing the data to the public in an app.
    pub display: bool,
    /// Passing the data on to third parties through this gateway.
    pub redistribution: bool,
    pub commercial: bool,
    /// Conditions worth knowing.
    pub notes: &'static str,
    /// ISO date the terms were last checked.
    pub verified: &'static str,
}

/// Static description of one feed.
#[derive(Debug, Clone, Copy)]
pub struct SourceInfo {
    /// Unique id, kebab-case. Also the value of the `source` fact on entities.
    pub id: &'static str,
    /// Human name of the provider.
    pub name: &'static str,
    pub kind: Kind,
    pub licence: Licence,
    /// Credit line, ready to show.
    pub attribution: &'static str,
    pub attribution_url: &'static str,
    /// Link to the provider's API documentation.
    pub docs: &'static str,
    /// Environment variable holding the API key, if one is needed.
    pub requires_key: Option<&'static str>,
    /// Where the feed has data, as a short phrase: "worldwide", "the Baltic Sea".
    pub coverage: &'static str,
}

/// Live health and counters of one feed, shared with `/health` and `/metrics`.
pub struct SourceState {
    pub info: SourceInfo,
    /// Index in the registry; stored on entities to say where a fix came from.
    pub index: u8,
    status: AtomicU8,
    pub requests: AtomicU64,
    pub errors: AtomicU64,
    pub rate_limited: AtomicU64,
    pub observations: AtomicU64,
    pub last_ok_ms: AtomicI64,
    pub latency_ms_last: AtomicU64,
    pub latency_ms_sum: AtomicU64,
    pub latency_count: AtomicU64,
    /// One plain sentence about the current state, for `/health`.
    note: Mutex<String>,
    /// A sentence for the people looking at the map, shown with the layer's
    /// credit line while it applies. Empty most of the time.
    public_note: Mutex<String>,
    /// The feed's daily request allowance, if it has one.
    budget: OnceLock<Arc<Mutex<budget::Quota>>>,
}

impl SourceState {
    pub fn new(info: SourceInfo, index: u8) -> SourceState {
        SourceState {
            info,
            index,
            status: AtomicU8::new(UpstreamStatus::Off as u8),
            requests: AtomicU64::new(0),
            errors: AtomicU64::new(0),
            rate_limited: AtomicU64::new(0),
            observations: AtomicU64::new(0),
            last_ok_ms: AtomicI64::new(0),
            latency_ms_last: AtomicU64::new(0),
            latency_ms_sum: AtomicU64::new(0),
            latency_count: AtomicU64::new(0),
            note: Mutex::new(String::new()),
            public_note: Mutex::new(String::new()),
            budget: OnceLock::new(),
        }
    }

    pub fn status(&self) -> UpstreamStatus {
        UpstreamStatus::from_u8(self.status.load(Relaxed))
    }

    pub fn set_status(&self, status: UpstreamStatus, note: impl Into<String>) {
        let previous = self.status.swap(status as u8, Relaxed);
        let note = note.into();
        if previous != status as u8 {
            tracing::info!(source = self.info.id, status = status.name(), note = %note, "upstream status changed");
        }
        *self.note.lock() = note;
    }

    pub fn note(&self) -> String {
        self.note.lock().clone()
    }

    /// Set or clear (with an empty string) the sentence shown to map users.
    pub fn set_public_note(&self, note: impl Into<String>) {
        *self.public_note.lock() = note.into();
    }

    pub fn public_note(&self) -> String {
        self.public_note.lock().clone()
    }

    /// Share the feed's daily allowance so `/health` and `/metrics` can report it.
    pub fn set_budget(&self, quota: Arc<Mutex<budget::Quota>>) {
        let _ = self.budget.set(quota);
    }

    /// The daily request allowance right now, for feeds that have one.
    pub fn budget_status(&self) -> Option<budget::BudgetStatus> {
        self.budget.get().map(|quota| quota.lock().status(now_ms()))
    }

    /// Record one finished request or connection attempt.
    pub fn record_request(&self, latency: Duration, ok: bool) {
        self.requests.fetch_add(1, Relaxed);
        let ms = latency.as_millis() as u64;
        self.latency_ms_last.store(ms, Relaxed);
        self.latency_ms_sum.fetch_add(ms, Relaxed);
        self.latency_count.fetch_add(1, Relaxed);
        if ok {
            self.last_ok_ms.store(now_ms(), Relaxed);
        } else {
            self.errors.fetch_add(1, Relaxed);
        }
    }
}

/// What a running feed can do: push data, report health, see demand, notice shutdown.
#[derive(Clone)]
pub struct UpstreamContext {
    pub state: Arc<SourceState>,
    sink: mpsc::Sender<UpstreamMessage>,
    /// What clients are currently looking at.
    pub demand: watch::Receiver<Arc<Demand>>,
    pub shutdown: watch::Receiver<bool>,
    pub http: reqwest::Client,
    pub config: Arc<Config>,
}

impl UpstreamContext {
    pub fn new(
        state: Arc<SourceState>,
        sink: mpsc::Sender<UpstreamMessage>,
        demand: watch::Receiver<Arc<Demand>>,
        shutdown: watch::Receiver<bool>,
        http: reqwest::Client,
        config: Arc<Config>,
    ) -> UpstreamContext {
        UpstreamContext { state, sink, demand, shutdown, http, config }
    }

    /// Hand a batch of observations to the gateway. Waits if the engine is
    /// behind, which is the back-pressure that keeps memory bounded.
    pub async fn push(&self, observations: Vec<Observation>) {
        if observations.is_empty() {
            return;
        }
        self.state.observations.fetch_add(observations.len() as u64, Relaxed);
        let message = UpstreamMessage::Batch { kind: self.state.info.kind, source: self.state.index, observations };
        let _ = self.sink.send(message).await;
    }

    /// Report entities this feed positively no longer sees.
    pub async fn gone(&self, ids: Vec<u32>, unless_seen_after_ms: i64) {
        if ids.is_empty() {
            return;
        }
        let _ = self.sink.send(UpstreamMessage::Gone { kind: self.state.info.kind, ids, unless_seen_after_ms }).await;
    }

    pub fn is_shutdown(&self) -> bool {
        *self.shutdown.borrow()
    }

    /// Sleep, returning `false` if the gateway began shutting down meanwhile.
    pub async fn sleep(&mut self, duration: Duration) -> bool {
        if self.is_shutdown() {
            return false;
        }
        tokio::select! {
            _ = tokio::time::sleep(duration) => true,
            _ = self.shutdown.changed() => false,
        }
    }
}

pub type BoxFuture = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;

/// One upstream feed.
pub trait Upstream: Send + 'static {
    /// Who the provider is and what its terms allow.
    fn info(&self) -> SourceInfo;

    /// Run until shutdown, pushing observations through `ctx`. Reconnects and
    /// rate limiting are the feed's own business.
    fn run(self: Box<Self>, ctx: UpstreamContext) -> BoxFuture;
}

/// Every feed the gateway knows about in this run, with its live state.
#[derive(Default)]
pub struct Registry {
    pub sources: Vec<Arc<SourceState>>,
}

impl Registry {
    /// Status of a layer: the best any of its feeds can offer. A missing key
    /// only shows when nothing else is delivering.
    pub fn layer_status(&self, kind: Kind) -> UpstreamStatus {
        let statuses: Vec<UpstreamStatus> =
            self.sources.iter().filter(|s| s.info.kind == kind).map(|s| s.status()).collect();
        for wanted in [UpstreamStatus::Ok, UpstreamStatus::Degraded, UpstreamStatus::NeedsKey, UpstreamStatus::Down] {
            if statuses.contains(&wanted) {
                return wanted;
            }
        }
        UpstreamStatus::Off
    }

    pub fn statuses(&self) -> [UpstreamStatus; Kind::COUNT] {
        [self.layer_status(Kind::Aircraft), self.layer_status(Kind::Ship)]
    }

    /// Credit line for a layer: who is supplying data right now, and what
    /// coverage that gives when a wider feed is waiting for a key.
    pub fn layer_attribution(&self, kind: Kind) -> String {
        let of_kind: Vec<&Arc<SourceState>> = self.sources.iter().filter(|s| s.info.kind == kind).collect();
        let running = |s: &&&Arc<SourceState>| !matches!(s.status(), UpstreamStatus::Off | UpstreamStatus::NeedsKey);
        let live: Vec<&&Arc<SourceState>> = of_kind.iter().filter(running).collect();
        let keyless: Vec<&&Arc<SourceState>> =
            of_kind.iter().filter(|s| s.status() == UpstreamStatus::NeedsKey).collect();
        let mut text = live.iter().map(|s| s.info.attribution).collect::<Vec<_>>().join("; ");
        // A feed that is running short says so next to its credit, in words meant for map users.
        let mut noted = false;
        for note in live.iter().map(|s| s.public_note()).filter(|note| !note.is_empty()) {
            text.push_str(". ");
            text.push_str(note.trim_end_matches('.'));
            noted = true;
        }
        if noted && keyless.is_empty() {
            text.push('.');
        }
        if let Some(waiting) = keyless.first() {
            let key = waiting.info.requires_key.unwrap_or("an API key");
            if live.is_empty() {
                text = format!("Needs {key} for {}.", waiting.info.name);
            } else {
                let coverage = live.iter().map(|s| s.info.coverage).collect::<Vec<_>>().join(" and ");
                text.push_str(&format!(
                    ". Live coverage: {coverage}. Set {key} for {} coverage.",
                    waiting.info.coverage
                ));
            }
        }
        text
    }

    pub fn by_index(&self, index: u8) -> Option<&Arc<SourceState>> {
        self.sources.get(usize::from(index))
    }
}

/// Decide which feeds run, from the configuration. A feed that needs a key it
/// does not have is still listed, so its layer can say so; its `run` returns
/// at once. Also returns the aircraft tile scheduler when a feed uses it.
pub fn build(config: &Arc<Config>) -> (Vec<Box<dyn Upstream>>, Option<Arc<aircraft::Sweep>>) {
    let mut feeds: Vec<Box<dyn Upstream>> = Vec::new();
    if let Some(mock) = config.mock {
        if mock.aircraft > 0 {
            feeds.push(Box::new(mock::MockAircraft::new(mock.aircraft)));
        }
        if mock.ships > 0 {
            feeds.push(Box::new(mock::MockShips::new(mock.ships)));
        }
        return (feeds, None);
    }

    // Aircraft. Tile-polling feeds share one sweep so they never fetch the same area twice.
    let tiled = config.source_enabled("adsb-lol", true) || config.source_enabled("adsb-fi", false);
    let sweep = Arc::new(aircraft::Sweep::new(config));
    if config.source_enabled("adsb-lol", true) {
        feeds.push(Box::new(aircraft::TileFeed::adsb_lol(config, sweep.clone())));
    }
    // Off unless asked for: adsb.lol only serves the whole-world snapshot to feeders.
    if config.source_enabled("adsb-lol-reapi", false) {
        feeds.push(Box::new(aircraft::SnapshotFeed::adsb_lol_reapi(config)));
    }
    // Off unless asked for: adsb.fi's open data is for personal, non-commercial use.
    if config.source_enabled("adsb-fi", false) {
        feeds.push(Box::new(aircraft::TileFeed::adsb_fi(config, sweep.clone())));
    }

    // Ships.
    if config.source_enabled("digitraffic", true) {
        feeds.push(Box::new(digitraffic::Digitraffic::new(config)));
    }
    if config.source_enabled("aisstream", true) {
        feeds.push(Box::new(aisstream::AisStream::new(config)));
    }
    (feeds, tiled.then_some(sweep))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(id: &'static str, kind: Kind, key: Option<&'static str>, coverage: &'static str) -> Arc<SourceState> {
        Arc::new(SourceState::new(
            SourceInfo {
                id,
                name: id,
                kind,
                licence: Licence {
                    name: "Test",
                    url: "https://example.org",
                    display: true,
                    redistribution: true,
                    commercial: true,
                    notes: "",
                    verified: "2026-11-14",
                },
                attribution: id,
                attribution_url: "https://example.org",
                docs: "https://example.org",
                requires_key: key,
                coverage,
            },
            0,
        ))
    }

    #[test]
    fn a_missing_key_shows_only_when_nothing_else_delivers() {
        let open = state("Open AIS", Kind::Ship, None, "the Baltic Sea");
        let keyed = state("Keyed AIS", Kind::Ship, Some("AIS_KEY"), "worldwide");
        let registry = Registry { sources: vec![open.clone(), keyed.clone()] };
        assert_eq!(registry.layer_status(Kind::Aircraft), UpstreamStatus::Off);

        keyed.set_status(UpstreamStatus::NeedsKey, "");
        assert_eq!(registry.layer_status(Kind::Ship), UpstreamStatus::NeedsKey);
        assert_eq!(registry.layer_attribution(Kind::Ship), "Needs AIS_KEY for Keyed AIS.");

        open.set_status(UpstreamStatus::Ok, "");
        assert_eq!(registry.layer_status(Kind::Ship), UpstreamStatus::Ok);
        assert_eq!(
            registry.layer_attribution(Kind::Ship),
            "Open AIS. Live coverage: the Baltic Sea. Set AIS_KEY for worldwide coverage."
        );

        open.set_status(UpstreamStatus::Degraded, "");
        assert_eq!(registry.layer_status(Kind::Ship), UpstreamStatus::Degraded);
        open.set_status(UpstreamStatus::Down, "");
        assert_eq!(registry.layer_status(Kind::Ship), UpstreamStatus::NeedsKey);

        keyed.set_status(UpstreamStatus::Ok, "");
        assert_eq!(registry.layer_status(Kind::Ship), UpstreamStatus::Ok);
        assert_eq!(registry.layer_attribution(Kind::Ship), "Open AIS; Keyed AIS");
    }

    #[test]
    fn a_feed_running_short_says_so_next_to_its_credit() {
        let open = state("Open ADS-B", Kind::Aircraft, None, "worldwide");
        let keyed = state("Keyed ADS-B", Kind::Aircraft, Some("ADSB_KEY"), "worldwide");
        let registry = Registry { sources: vec![open.clone(), keyed.clone()] };
        open.set_status(UpstreamStatus::Degraded, "for the operator");
        open.set_public_note("The allowance is used up for now. It refills by itself.");
        assert_eq!(
            registry.layer_attribution(Kind::Aircraft),
            "Open ADS-B. The allowance is used up for now. It refills by itself."
        );
        // The note sits between the credit and the hint about a missing key.
        keyed.set_status(UpstreamStatus::NeedsKey, "");
        assert_eq!(
            registry.layer_attribution(Kind::Aircraft),
            "Open ADS-B. The allowance is used up for now. It refills by itself. Live coverage: worldwide. \
             Set ADSB_KEY for worldwide coverage."
        );
        open.set_public_note("");
        keyed.set_status(UpstreamStatus::Off, "");
        assert_eq!(registry.layer_attribution(Kind::Aircraft), "Open ADS-B");
        assert!(open.budget_status().is_none());
    }
}
