//! Aircraft feeds and the priority scheduler that drives them.
//!
//! The open ADS-B APIs answer "aircraft within 250 nm of this point", so the
//! world is covered by about 1,200 overlapping circles (`tiles`). No free tier
//! allows fetching all of them quickly, so requests are spent by priority:
//!
//! - **Hot** tiles overlap what clients are looking at. They are refreshed
//!   every few seconds and get three request slots out of four.
//! - **Background** tiles keep the rest of the globe filled in. Tiles that
//!   held aircraft last time are revisited as fast as the budget allows;
//!   empty ones back off, up to an hour.
//! - A cold start fetches likely-busy airspace first.
//!
//! Each feed has its own [`Budget`] (rate limit, optional daily quota; see
//! [`super::budget`]). Feeds share one [`Sweep`], so two providers never fetch
//! the same tile twice in a row and their results are merged by ICAO address
//! in the world state.

use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use rustc_hash::{FxHashMap, FxHashSet};

use super::budget::{Allowance, Budget, Now, Quota, Store};
use super::tiles::{self, Tile};
use super::{BoxFuture, Licence, SourceInfo, SourceState, Upstream, UpstreamContext, readsb};
use crate::config::Config;
use crate::describe_http_error;
use crate::hub::Demand;
use crate::model::{Kind, Observation, UpstreamStatus, haversine_km, now_ms};
use crate::protocol::LONLAT_SCALE;

const ODBL: Licence = Licence {
    name: "ODbL 1.0",
    url: "https://opendatacommons.org/licenses/odbl/1-0/",
    display: true,
    redistribution: true,
    commercial: true,
    notes: "Attribution and share-alike: a publicly used derived database stays under ODbL.",
    verified: "2026-11-14",
};

const ADSB_LOL_ATTRIBUTION: &str =
    "Contains information from adsb.lol, which is made available here under the Open Database License (ODbL)";

/// How long an empty tile waits before its first re-check; doubles each time it stays empty.
const EMPTY_BASE_MS: i64 = 5 * 60 * 1000;
const EMPTY_MAX_MS: i64 = 60 * 60 * 1000;
/// A tile whose request failed is left alone for this long.
const RETRY_AFTER_FAILURE_MS: i64 = 30_000;
/// Of every four request slots, three go to hot tiles when any is due.
const HOT_SHARE: u32 = 4;
/// Of every three background slots, one goes to a tile that has never been fetched.
const EXPLORE_SHARE: u32 = 3;

#[derive(Debug, Clone, Default)]
struct TileState {
    /// 0 until the first successful fetch.
    last_fetch_ms: i64,
    /// Time between the last two fetches; 0 when fetched fewer than twice.
    prev_interval_ms: i64,
    not_before_ms: i64,
    count: u32,
    empty_streak: u32,
    in_flight: bool,
    hot: bool,
    /// Feed that fetched it last; "gone" is only inferred between two answers
    /// from the same provider, because coverage differs between them.
    last_feed: u8,
    /// Who was here last time: id and position.
    seen: Vec<(u32, i32, i32)>,
}

/// A tile handed to a feed to fetch.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pick {
    pub index: usize,
    pub lat: f64,
    pub lon: f64,
    pub hot: bool,
}

/// What a finished fetch means for the world state.
#[derive(Debug, Default, PartialEq)]
pub struct Completion {
    /// Aircraft that were inside the circle last time and are not any more.
    pub gone: Vec<u32>,
    /// How long the reported aircraft should be kept, given how slowly this
    /// area is being revisited. Milliseconds.
    pub ttl_ms: u32,
}

/// Progress of the sweep, for `/health`.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct SweepStats {
    pub tiles: usize,
    /// Tiles fetched at least once.
    pub fetched: usize,
    pub hot: usize,
    /// Tiles that held aircraft at their last fetch.
    pub occupied: usize,
    /// Seconds the first pass over every tile took; `None` until it completes.
    pub first_sweep_s: Option<f64>,
    /// Seconds since the least recently fetched occupied tile was fetched.
    pub oldest_occupied_s: Option<f64>,
    /// Typical seconds between two fetches of an occupied background tile.
    pub background_cycle_s: Option<f64>,
}

struct SweepInner {
    tiles: Vec<Tile>,
    state: Vec<TileState>,
    /// Resolution-2 cell to the tiles whose circle contains its centre.
    cell_tiles: FxHashMap<u64, Vec<u16>>,
    /// The demand the hot flags were computed from.
    demand: Option<Arc<Demand>>,
    slot: u32,
    background_slot: u32,
    started_ms: i64,
    fetched: usize,
    first_sweep_ms: Option<i64>,
    /// Smoothed revisit interval of occupied background tiles.
    background_cycle_ms: f64,
}

/// The shared tile scheduler.
pub struct Sweep {
    inner: Mutex<SweepInner>,
    radius_nm: u32,
    radius_km: f64,
    hot_interval_ms: i64,
    background_interval_ms: i64,
}

impl Sweep {
    pub fn new(config: &Config) -> Sweep {
        Sweep::with(
            config.aircraft_tile_radius_nm,
            config.aircraft_hot_interval_s as i64 * 1000,
            config.aircraft_background_interval_s as i64 * 1000,
        )
    }

    pub fn with(radius_nm: u32, hot_interval_ms: i64, background_interval_ms: i64) -> Sweep {
        let tiles = tiles::world_tiles(radius_nm);
        Sweep {
            inner: Mutex::new(SweepInner {
                state: vec![TileState::default(); tiles.len()],
                tiles,
                cell_tiles: FxHashMap::default(),
                demand: None,
                slot: 0,
                background_slot: 0,
                started_ms: 0,
                fetched: 0,
                first_sweep_ms: None,
                background_cycle_ms: 0.0,
            }),
            radius_nm,
            radius_km: tiles::radius_km(radius_nm),
            hot_interval_ms,
            background_interval_ms,
        }
    }

    pub fn radius_nm(&self) -> u32 {
        self.radius_nm
    }

    /// Mark the tiles that overlap what clients are looking at.
    pub fn set_demand(&self, demand: &Arc<Demand>) {
        let mut inner = self.inner.lock();
        if inner.demand.as_ref().is_some_and(|d| Arc::ptr_eq(d, demand)) {
            return;
        }
        inner.demand = Some(demand.clone());
        let SweepInner { tiles, state, cell_tiles, .. } = &mut *inner;
        for s in state.iter_mut() {
            s.hot = false;
        }
        for cell in &demand.aircraft_cells {
            let hits = cell_tiles.entry(*cell).or_insert_with(|| match h3o::CellIndex::try_from(*cell) {
                Ok(c) => {
                    let ll = h3o::LatLng::from(c);
                    tiles::tiles_containing(tiles, self.radius_km, ll.lat(), ll.lng())
                }
                Err(_) => Vec::new(),
            });
            for &i in hits.iter() {
                state[usize::from(i)].hot = true;
            }
        }
    }

    fn background_target_ms(&self, s: &TileState) -> i64 {
        if s.count > 0 || s.last_fetch_ms == 0 {
            self.background_interval_ms
        } else {
            (EMPTY_BASE_MS << s.empty_streak.saturating_sub(1).min(8)).min(EMPTY_MAX_MS)
        }
    }

    /// Choose the next tile to fetch, or `None` when nothing is due.
    /// `background` is false when the feed should only serve what clients are watching.
    ///
    /// Three kinds of tile compete for request slots:
    /// - *hot*: overlapping what clients are looking at, due every hot interval;
    /// - *known*: fetched before and due again (sooner if they held aircraft);
    /// - *unexplored*: never fetched, likeliest traffic first.
    ///
    /// Hot tiles get three slots in four. Of the background slots, known tiles
    /// get two in three and unexplored ones the third, so the first pass over
    /// the world keeps moving while the airspace already found stays fresh.
    pub fn pick(&self, now_ms: i64, background: bool) -> Option<Pick> {
        let mut inner = self.inner.lock();
        if inner.started_ms == 0 {
            inner.started_ms = now_ms;
        }
        let mut best_hot: Option<(f64, usize)> = None;
        let mut best_known: Option<(f64, usize)> = None;
        let mut best_unexplored: Option<(f64, usize)> = None;
        let better = |best: &Option<(f64, usize)>, urgency: f64| best.is_none_or(|(u, _)| urgency > u);
        for (i, s) in inner.state.iter().enumerate() {
            if s.in_flight || now_ms < s.not_before_ms {
                continue;
            }
            let never = s.last_fetch_ms == 0;
            let waited = (now_ms - s.last_fetch_ms) as f64;
            if s.hot {
                // A watched tile nobody has fetched yet goes before any refresh.
                let urgency =
                    if never { 1e9 + f64::from(inner.tiles[i].prior) } else { waited / self.hot_interval_ms as f64 };
                if urgency >= 1.0 && better(&best_hot, urgency) {
                    best_hot = Some((urgency, i));
                }
            } else if !background {
                continue;
            } else if never {
                let urgency = f64::from(inner.tiles[i].prior);
                if better(&best_unexplored, urgency) {
                    best_unexplored = Some((urgency, i));
                }
            } else {
                let urgency = waited / self.background_target_ms(s) as f64;
                if urgency >= 1.0 && better(&best_known, urgency) {
                    best_known = Some((urgency, i));
                }
            }
        }
        inner.slot = inner.slot.wrapping_add(1);
        let background_turn = inner.slot.is_multiple_of(HOT_SHARE) || best_hot.is_none();
        let chosen = if background_turn && (best_known.is_some() || best_unexplored.is_some()) {
            inner.background_slot = inner.background_slot.wrapping_add(1);
            if inner.background_slot.is_multiple_of(EXPLORE_SHARE) {
                best_unexplored.or(best_known)
            } else {
                best_known.or(best_unexplored)
            }
        } else {
            best_hot
        };
        let (_, index) = chosen?;
        inner.state[index].in_flight = true;
        let tile = inner.tiles[index];
        Some(Pick { index, lat: tile.lat, lon: tile.lon, hot: inner.state[index].hot })
    }

    /// Hand back a tile that was picked but not fetched after all.
    pub fn release(&self, index: usize) {
        self.inner.lock().state[index].in_flight = false;
    }

    /// Record a failed fetch: the tile is retried later, not at once.
    pub fn failed(&self, index: usize, now_ms: i64) {
        let mut inner = self.inner.lock();
        let s = &mut inner.state[index];
        s.in_flight = false;
        s.not_before_ms = now_ms + RETRY_AFTER_FAILURE_MS;
    }

    /// Record a successful fetch of a tile and work out what it implies.
    pub fn complete(&self, index: usize, feed: u8, now_ms: i64, observations: &[Observation]) -> Completion {
        let mut inner = self.inner.lock();
        let tile = inner.tiles[index];
        let max_ttl = u32::MAX;

        let s = &mut inner.state[index];
        let first = s.last_fetch_ms == 0;
        let interval = if first { 0 } else { now_ms - s.last_fetch_ms };
        let was_hot_cycle = s.hot;
        let same_feed = s.last_feed == feed;
        let previous = std::mem::take(&mut s.seen);

        s.in_flight = false;
        s.prev_interval_ms = interval;
        s.last_fetch_ms = now_ms;
        s.last_feed = feed;
        s.count = observations.len() as u32;
        s.empty_streak = if observations.is_empty() { s.empty_streak.saturating_add(1) } else { 0 };
        s.seen = observations.iter().filter_map(|o| o.fix.map(|f| (o.id, f.lat_e7, f.lon_e7))).collect();

        // Whoever was well inside the circle last time and is missing now has
        // landed or lost coverage. Near the edge they may simply have flown
        // out, so allow for the distance covered since at airliner speed.
        let mut gone = Vec::new();
        if same_feed && !first && !previous.is_empty() {
            let present: FxHashSet<u32> = s.seen.iter().map(|(id, _, _)| *id).collect();
            let margin_km = 40.0 + 0.28 * (interval as f64 / 1000.0);
            for (id, lat_e7, lon_e7) in previous {
                if present.contains(&id) {
                    continue;
                }
                let d = haversine_km(
                    tile.lat,
                    tile.lon,
                    f64::from(lat_e7) / LONLAT_SCALE,
                    f64::from(lon_e7) / LONLAT_SCALE,
                );
                if d + margin_km < self.radius_km {
                    gone.push(id);
                }
            }
        }

        if first {
            inner.fetched += 1;
            if inner.fetched == inner.tiles.len() {
                inner.first_sweep_ms = Some(now_ms - inner.started_ms);
            }
        }
        if !first && !was_hot_cycle && !observations.is_empty() {
            let sample = interval as f64;
            inner.background_cycle_ms =
                if inner.background_cycle_ms == 0.0 { sample } else { inner.background_cycle_ms * 0.8 + sample * 0.2 };
        }

        // Keep aircraft for one and a half revisits of this area, so they do
        // not blink out between sweeps. Until a revisit time is known, ask for
        // the longest lifetime the world allows; the stale flag tells clients
        // the position is old.
        let cycle = inner.background_cycle_ms.max(interval as f64);
        let ttl_ms =
            if cycle == 0.0 { max_ttl } else { ((cycle * 1.5) as u64 + 30_000).min(u64::from(max_ttl)) as u32 };
        Completion { gone, ttl_ms }
    }

    pub fn stats(&self, now_ms: i64) -> SweepStats {
        let inner = self.inner.lock();
        let occupied = inner.state.iter().filter(|s| s.count > 0);
        SweepStats {
            tiles: inner.tiles.len(),
            fetched: inner.fetched,
            hot: inner.state.iter().filter(|s| s.hot).count(),
            occupied: occupied.clone().count(),
            first_sweep_s: inner.first_sweep_ms.map(|ms| ms as f64 / 1000.0),
            oldest_occupied_s: occupied.map(|s| now_ms - s.last_fetch_ms).max().map(|ms| ms as f64 / 1000.0),
            background_cycle_s: (inner.background_cycle_ms > 0.0).then(|| inner.background_cycle_ms / 1000.0),
        }
    }
}

enum FetchError {
    /// HTTP 429, with the provider's `Retry-After` in seconds if it sent one.
    RateLimited(Option<u64>),
    Other(String),
}

async fn fetch_readsb(
    ctx: &UpstreamContext,
    url: &str,
    api_key: Option<&str>,
    timeout: Duration,
) -> Result<readsb::Parsed, FetchError> {
    let mut request = ctx.http.get(url).timeout(timeout);
    if let Some(key) = api_key {
        request = request.header("x-api-key", key);
    }
    let response = request.send().await.map_err(|e| FetchError::Other(describe_http_error(e)))?;
    let status = response.status();
    if status.as_u16() == 429 {
        let retry_after =
            response.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.trim().parse().ok());
        return Err(FetchError::RateLimited(retry_after));
    }
    if !status.is_success() {
        return Err(FetchError::Other(format!("HTTP {}", status.as_u16())));
    }
    let body = response.bytes().await.map_err(|e| FetchError::Other(describe_http_error(e)))?;
    readsb::parse(&body, now_ms()).map_err(|e| FetchError::Other(format!("unexpected response: {e}")))
}

/// Which provider a [`TileFeed`] talks to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Provider {
    AdsbLol,
    AdsbFi,
}

/// What a feed with a daily allowance is doing about it, so that status and
/// notes are set when that changes rather than on every pass of the loop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Pace {
    Running,
    /// Nobody is watching aircraft: nothing is being spent.
    Idle,
    /// The allowance is used up for now; requests go out as it refills.
    Exhausted,
}

const IDLE_NOTE: &str = "Nobody is watching aircraft, so no requests are being made.";

/// A feed that covers the world one circle at a time.
pub struct TileFeed {
    provider: Provider,
    sweep: Arc<Sweep>,
    budget: Budget,
    api_key: Option<String>,
}

impl TileFeed {
    /// adsb.lol's public API: ODbL, 500 requests a day per IP without a key.
    /// The allowance carries on from the state file, if one is configured.
    pub fn adsb_lol(config: &Config, sweep: Arc<Sweep>) -> TileFeed {
        let store = config.adsblol_budget_file.clone().map(Store::new);
        let quota = Quota::open_with(config.adsblol_daily_quota, store, now_ms(), config.adsblol_first_burst);
        TileFeed {
            provider: Provider::AdsbLol,
            sweep,
            budget: Budget::daily(quota, Duration::from_millis(config.adsblol_min_interval_ms)),
            api_key: config.adsblol_api_key.clone(),
        }
    }

    /// adsb.fi's open data API: one request a second, personal non-commercial use.
    pub fn adsb_fi(config: &Config, sweep: Arc<Sweep>) -> TileFeed {
        let min = Duration::from_millis(config.adsbfi_min_interval_ms);
        TileFeed { provider: Provider::AdsbFi, sweep, budget: Budget::rate(min, min * 4), api_key: None }
    }

    fn url(&self, pick: &Pick) -> String {
        let radius = self.sweep.radius_nm();
        match self.provider {
            Provider::AdsbLol => format!("https://api.adsb.lol/v2/point/{:.4}/{:.4}/{radius}", pick.lat, pick.lon),
            Provider::AdsbFi => {
                format!("https://opendata.adsb.fi/api/v3/lat/{:.4}/lon/{:.4}/dist/{radius}", pick.lat, pick.lon)
            }
        }
    }

    /// Report that the allowance is used up: degraded, with a sentence for
    /// `/health` and one for the people looking at the map.
    fn report_exhausted(&self, state: &SourceState) {
        let Some(budget) = self.budget.status(Now::real()) else { return };
        let name = state.info.name;
        state.set_public_note(format!(
            "The {name} request allowance ({} a day) is used up for now, so aircraft positions refresh slowly. \
             It refills by itself.",
            budget.per_day
        ));
        state.set_status(
            UpstreamStatus::Degraded,
            format!(
                "The allowance of {} requests a day is used up for now. One request goes out every {:.0} seconds \
                 as it refills; {} left today.",
                budget.per_day, budget.refill_every_s, budget.left_today
            ),
        );
    }

    async fn run_loop(mut self, mut ctx: UpstreamContext) {
        let state = ctx.state.clone();
        state.set_status(UpstreamStatus::Ok, "Starting.");
        if let Some(quota) = self.budget.quota() {
            state.set_budget(quota);
        }
        if let Some(budget) = self.budget.status(Now::real()) {
            tracing::info!(
                source = state.info.id,
                per_day = budget.per_day,
                available_now = budget.available_now,
                spent_today = budget.spent_today,
                persisted = budget.persisted,
                "request budget"
            );
        }
        let mut failures = 0u32;
        let mut pace = Pace::Running;
        loop {
            if ctx.is_shutdown() {
                break;
            }
            let demand = ctx.demand.borrow().clone();
            self.sweep.set_demand(&demand);
            match self.budget.check(Now::real(), demand.aircraft_wanted) {
                Allowance::Go => {}
                Allowance::Wait(wait) => {
                    // Wake at least once a second so a new viewer is noticed promptly.
                    if !ctx.sleep(wait.min(Duration::from_secs(1))).await {
                        break;
                    }
                    continue;
                }
                Allowance::Idle => {
                    // An allowance that ran out stays reported until it has something to give again.
                    let still_out = pace == Pace::Exhausted
                        && self.budget.status(Now::real()).is_some_and(|budget| budget.available_now == 0);
                    if pace != Pace::Idle && !still_out {
                        pace = Pace::Idle;
                        state.set_public_note("");
                        if failures == 0 {
                            state.set_status(UpstreamStatus::Ok, IDLE_NOTE);
                        }
                    }
                    if !ctx.sleep(Duration::from_secs(1)).await {
                        break;
                    }
                    continue;
                }
                Allowance::Exhausted(wait) => {
                    if pace != Pace::Exhausted {
                        pace = Pace::Exhausted;
                        self.report_exhausted(&state);
                    }
                    if !ctx.sleep(wait.min(Duration::from_secs(1))).await {
                        break;
                    }
                    continue;
                }
            }
            let Some(pick) = self.sweep.pick(now_ms(), true) else {
                if !ctx.sleep(Duration::from_millis(500)).await {
                    break;
                }
                continue;
            };
            // The request is counted, and the count saved, before it is sent:
            // a crash in between must not leave it unrecorded.
            if !self.budget.spend(Now::real()).await {
                self.sweep.release(pick.index);
                if !ctx.sleep(Duration::from_secs(1)).await {
                    break;
                }
                continue;
            }
            let started = Instant::now();
            let result = fetch_readsb(&ctx, &self.url(&pick), self.api_key.as_deref(), Duration::from_secs(15)).await;
            match result {
                Ok(mut parsed) => {
                    state.record_request(started.elapsed(), true);
                    self.budget.succeeded();
                    failures = 0;
                    let completion = self.sweep.complete(pick.index, state.index, now_ms(), &parsed.observations);
                    for o in &mut parsed.observations {
                        o.ttl_ms = Some(completion.ttl_ms);
                    }
                    tracing::debug!(
                        source = state.info.id,
                        lat = pick.lat,
                        lon = pick.lon,
                        hot = pick.hot,
                        aircraft = parsed.observations.len(),
                        gone = completion.gone.len(),
                        "tile fetched"
                    );
                    // "Gone" is judged against when the request started: anything
                    // reported since by another tile or feed stays.
                    let request_started_ms = now_ms() - started.elapsed().as_millis() as i64;
                    ctx.push(parsed.observations).await;
                    ctx.gone(completion.gone, request_started_ms).await;
                    // With nothing left after this request the feed is already
                    // on the slow refill: say so now instead of flipping to "ok"
                    // for the moment each request takes.
                    let budget = self.budget.status(Now::real());
                    if budget.as_ref().is_some_and(|budget| budget.available_now == 0) {
                        pace = Pace::Exhausted;
                        self.report_exhausted(&state);
                    } else {
                        pace = Pace::Running;
                        state.set_public_note("");
                        let note = budget.map_or_else(String::new, |budget| {
                            format!(
                                "{} requests available now, {} left today.",
                                budget.available_now, budget.left_today
                            )
                        });
                        state.set_status(UpstreamStatus::Ok, note);
                    }
                }
                Err(FetchError::RateLimited(retry_after)) => {
                    state.record_request(started.elapsed(), false);
                    state.rate_limited.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    self.sweep.failed(pick.index, now_ms());
                    self.budget.pushed_back(Now::real(), retry_after);
                    pace = Pace::Running;
                    let pause = retry_after.unwrap_or(60).clamp(5, 3600);
                    state.set_status(
                        UpstreamStatus::Degraded,
                        format!(
                            "The provider asked us to slow down. Pausing for {pause} seconds, then one request every {} seconds.",
                            self.budget.interval().as_secs()
                        ),
                    );
                    if !ctx.sleep(Duration::from_secs(pause)).await {
                        break;
                    }
                }
                Err(FetchError::Other(reason)) => {
                    state.record_request(started.elapsed(), false);
                    self.sweep.failed(pick.index, now_ms());
                    failures += 1;
                    pace = Pace::Running;
                    let status = if failures >= 5 { UpstreamStatus::Down } else { UpstreamStatus::Degraded };
                    state.set_status(status, format!("Last request failed: {reason}."));
                    // Failed requests count against some providers' abuse limits: back off hard.
                    let pause = Duration::from_secs((2u64 << failures.min(6)).min(120));
                    if !ctx.sleep(pause).await {
                        break;
                    }
                }
            }
        }
    }
}

impl Upstream for TileFeed {
    fn info(&self) -> SourceInfo {
        match self.provider {
            Provider::AdsbLol => SourceInfo {
                id: "adsb-lol",
                name: "adsb.lol",
                kind: Kind::Aircraft,
                licence: Licence {
                    notes: "Attribution and share-alike. Without a key: 500 requests a day per IP, 250 nm per request.",
                    ..ODBL
                },
                attribution: ADSB_LOL_ATTRIBUTION,
                attribution_url: "https://www.adsb.lol/",
                docs: "https://www.adsb.lol/docs/open-data/api/",
                requires_key: None,
                coverage: "areas being viewed first, the rest of the world as the daily quota allows",
            },
            Provider::AdsbFi => SourceInfo {
                id: "adsb-fi",
                name: "adsb.fi",
                kind: Kind::Aircraft,
                licence: Licence {
                    name: "adsb.fi open data terms",
                    url: "https://github.com/adsbfi/opendata",
                    display: false,
                    redistribution: false,
                    commercial: false,
                    notes: "Personal, non-commercial use only; must cite adsb.fi with a link. Off by default: enable \
                            only on a private instance or with adsb.fi's permission.",
                    verified: "2026-11-14",
                },
                attribution: "Aircraft data from adsb.fi",
                attribution_url: "https://adsb.fi/",
                docs: "https://github.com/adsbfi/opendata",
                requires_key: None,
                coverage: "worldwide, swept at one request a second",
            },
        }
    }

    fn run(self: Box<Self>, ctx: UpstreamContext) -> BoxFuture {
        Box::pin(self.run_loop(ctx))
    }
}

/// A feed that fetches the whole world in one request: adsb.lol's re-api,
/// which is served only to stations that feed the network.
pub struct SnapshotFeed {
    url: String,
    interval: Duration,
}

impl SnapshotFeed {
    pub fn adsb_lol_reapi(config: &Config) -> SnapshotFeed {
        SnapshotFeed {
            url: config.adsblol_reapi_url.clone(),
            interval: Duration::from_secs(config.adsblol_reapi_interval_s),
        }
    }

    async fn run_loop(self, mut ctx: UpstreamContext) {
        let state = ctx.state.clone();
        state.set_status(UpstreamStatus::Ok, "Starting.");
        let mut failures = 0u32;
        loop {
            if ctx.is_shutdown() {
                break;
            }
            let started = Instant::now();
            let mut pause = self.interval;
            match fetch_readsb(&ctx, &self.url, None, Duration::from_secs(25)).await {
                Ok(parsed) => {
                    state.record_request(started.elapsed(), true);
                    failures = 0;
                    let count = parsed.observations.len();
                    ctx.push(parsed.observations).await;
                    state.set_status(UpstreamStatus::Ok, format!("Last snapshot held {count} aircraft."));
                }
                Err(FetchError::RateLimited(retry_after)) => {
                    state.record_request(started.elapsed(), false);
                    state.rate_limited.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    pause = Duration::from_secs(retry_after.unwrap_or(60).clamp(30, 3600));
                    state.set_status(UpstreamStatus::Degraded, "The provider asked us to slow down.");
                }
                Err(FetchError::Other(reason)) => {
                    state.record_request(started.elapsed(), false);
                    failures += 1;
                    let status = if failures >= 3 { UpstreamStatus::Down } else { UpstreamStatus::Degraded };
                    state.set_status(
                        status,
                        format!("Last request failed: {reason}. The re-api only answers stations that feed adsb.lol."),
                    );
                    pause = self.interval * failures.min(8);
                }
            }
            if !ctx.sleep(pause.saturating_sub(started.elapsed()).max(Duration::from_secs(1))).await {
                break;
            }
        }
    }
}

impl Upstream for SnapshotFeed {
    fn info(&self) -> SourceInfo {
        SourceInfo {
            id: "adsb-lol-reapi",
            name: "adsb.lol re-api",
            kind: Kind::Aircraft,
            licence: Licence {
                notes: "Feeders only: answered for the IP address of a station that feeds adsb.lol. Two whole-world \
                        snapshots a minute. Attribution and share-alike.",
                ..ODBL
            },
            attribution: ADSB_LOL_ATTRIBUTION,
            attribution_url: "https://www.adsb.lol/",
            docs: "https://www.adsb.lol/docs/feeders-only/re-api",
            requires_key: None,
            coverage: "worldwide",
        }
    }

    fn run(self: Box<Self>, ctx: UpstreamContext) -> BoxFuture {
        Box::pin(self.run_loop(ctx))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Fix;

    fn obs(id: u32, lat: f64, lon: f64) -> Observation {
        Observation { id, fix: Some(Fix::from_si(lon, lat, 0.0, None, 0.0, 0.0, 0, 0)), ..Default::default() }
    }

    fn demand_at(lat: f64, lon: f64) -> Arc<Demand> {
        let cell = h3o::LatLng::new(lat, lon).unwrap().to_cell(h3o::Resolution::Two);
        Arc::new(Demand {
            clients: 1,
            aircraft_wanted: true,
            aircraft_world: false,
            aircraft_cells: vec![u64::from(cell)],
        })
    }

    #[test]
    fn a_cold_start_fetches_busy_airspace_first() {
        let sweep = Sweep::with(250, 5_000, 30_000);
        let first = sweep.pick(1_000, true).unwrap();
        assert!(!first.hot);
        let nearest_hub = tiles::HUBS
            .iter()
            .map(|(lat, lon)| haversine_km(first.lat, first.lon, *lat, *lon))
            .fold(f64::MAX, f64::min);
        assert!(nearest_hub < 500.0, "first pick ({}, {}) is not near a hub", first.lat, first.lon);
        // The same tile is not handed out twice while in flight.
        let second = sweep.pick(1_000, true).unwrap();
        assert_ne!(first.index, second.index);
    }

    #[test]
    fn watched_tiles_are_refreshed_first_and_often() {
        let sweep = Sweep::with(250, 5_000, 30_000);
        sweep.set_demand(&demand_at(-40.0, 100.0)); // open ocean: low prior, so only demand explains a pick
        let stats = sweep.stats(0);
        assert!((1..=4).contains(&stats.hot), "{} hot tiles", stats.hot);

        // Hot tiles go first, though every fourth slot is kept for the background.
        let mut now = 1_000;
        let mut hot_indexes = Vec::new();
        let first = sweep.pick(now, true).unwrap();
        assert!(first.hot, "the first request goes to what is being watched");
        sweep.complete(first.index, 0, now, &[obs(1, first.lat, first.lon)]);
        hot_indexes.push(first.index);
        while hot_indexes.len() < stats.hot {
            let pick = sweep.pick(now, true).unwrap();
            if pick.hot {
                assert!(haversine_km(pick.lat, pick.lon, -40.0, 100.0) < 700.0);
                hot_indexes.push(pick.index);
            }
            sweep.complete(pick.index, 0, now, &[obs(1, pick.lat, pick.lon)]);
        }
        // Nothing hot is due again yet: the background gets the slot.
        assert!(!sweep.pick(now, true).unwrap().hot);
        // Without background work allowed, nothing is due until the hot interval passes.
        assert_eq!(sweep.pick(now + 4_000, false), None);
        now += 5_000;
        let again = sweep.pick(now, false).unwrap();
        assert!(again.hot && hot_indexes.contains(&again.index));

        // Demand moves away: the tile is no longer hot.
        sweep.set_demand(&Arc::new(Demand::default()));
        assert_eq!(sweep.stats(now).hot, 0);
        assert_eq!(sweep.pick(now + 10_000, false), None);
    }

    #[test]
    fn hot_tiles_cannot_starve_the_background() {
        let sweep = Sweep::with(250, 5_000, 30_000);
        sweep.set_demand(&demand_at(51.5, -0.5));
        let mut hot = 0;
        let mut background = 0;
        let mut now = 0;
        // One request a second for two minutes: hot tiles are always due again.
        for _ in 0..120 {
            now += 1_000;
            let pick = sweep.pick(now, true).unwrap();
            if pick.hot {
                hot += 1
            } else {
                background += 1
            }
            sweep.complete(pick.index, 0, now, &[]);
        }
        assert!(background >= 30, "background got {background} of 120 slots");
        assert!(hot >= 20, "hot got {hot} of 120 slots");
    }

    #[test]
    fn empty_tiles_back_off_and_occupied_ones_do_not() {
        let sweep = Sweep::with(250, 5_000, 30_000);
        let a = sweep.pick(1_000, true).unwrap();
        let b = sweep.pick(1_000, true).unwrap();
        sweep.complete(a.index, 0, 1_000, &[obs(1, a.lat, a.lon)]);
        sweep.complete(b.index, 0, 1_000, &[]);
        // Mark everything else as freshly fetched and occupied so only a and b matter.
        while let Some(p) = sweep.pick(1_000, true) {
            sweep.complete(p.index, 0, 1_000, &[obs(2, p.lat, p.lon)]);
        }
        assert_eq!(sweep.stats(1_000).fetched, sweep.stats(1_000).tiles);
        assert_eq!(sweep.stats(1_000).first_sweep_s, Some(0.0));

        // After 30 s occupied tiles are due; the empty one waits 5 minutes.
        let mut due = Vec::new();
        while let Some(p) = sweep.pick(32_000, true) {
            due.push(p.index);
        }
        assert!(due.contains(&a.index));
        assert!(!due.contains(&b.index));
        for i in due {
            sweep.complete(i, 0, 32_000, &[obs(2, 0.0, 0.0)]);
        }
        let p = sweep.pick(1_000 + EMPTY_BASE_MS, true);
        assert!(p.is_some());
        // Still empty: the next wait doubles.
        let mut picked_b = false;
        let mut now = 1_000 + EMPTY_BASE_MS;
        if let Some(p) = p {
            picked_b |= p.index == b.index;
            sweep.complete(p.index, 0, now, &[]);
        }
        while let Some(p) = sweep.pick(now, true) {
            picked_b |= p.index == b.index;
            sweep.complete(p.index, 0, now, if p.index == b.index { &[] } else { std::slice::from_ref(&OBS) });
        }
        assert!(picked_b, "the empty tile is re-checked after five minutes");
        now += EMPTY_BASE_MS + 1_000;
        let mut again = false;
        while let Some(p) = sweep.pick(now, true) {
            again |= p.index == b.index;
            sweep.complete(p.index, 0, now, std::slice::from_ref(&OBS));
        }
        assert!(!again, "after two empty answers it waits ten minutes, not five");
    }

    static OBS: Observation = Observation { id: 5, fix: None, category: None, meta: Vec::new(), ttl_ms: None };

    #[test]
    fn missing_aircraft_are_gone_only_when_well_inside_the_circle() {
        let sweep = Sweep::with(250, 5_000, 30_000);
        let pick = sweep.pick(1_000, true).unwrap();
        let centre = obs(1, pick.lat, pick.lon);
        let edge = obs(2, pick.lat + 3.9, pick.lon); // about 434 km out of 463
        let staying = obs(3, pick.lat - 1.0, pick.lon);
        let first = sweep.complete(pick.index, 0, 1_000, &[centre.clone(), edge, staying.clone()]);
        assert!(first.gone.is_empty());
        assert_eq!(first.ttl_ms, u32::MAX, "no revisit time known yet: ask for the longest lifetime");

        // Keep the tile hot so it comes round again every few seconds.
        sweep.set_demand(&demand_at(pick.lat, pick.lon));
        let wait_for = |now: i64| loop {
            let next = sweep.pick(now, false).expect("the watched tile is due");
            if next.index == pick.index {
                break;
            }
            sweep.complete(next.index, 0, now, &[]);
        };

        // A different provider answering does not prove anything about the first one's aircraft.
        wait_for(11_000);
        let other = sweep.complete(pick.index, 1, 11_000, std::slice::from_ref(&staying));
        assert!(other.gone.is_empty());

        wait_for(21_000);
        let same = sweep.complete(pick.index, 1, 21_000, &[staying.clone(), centre.clone()]);
        assert!(same.gone.is_empty());
        wait_for(31_000);
        let done = sweep.complete(pick.index, 1, 31_000, &[staying]);
        assert_eq!(done.gone, vec![1], "the one at the centre has landed");
        assert_eq!(done.ttl_ms, 45_000, "one and a half ten-second revisits plus thirty seconds");
    }

    #[test]
    fn a_long_run_explores_the_world_and_keeps_busy_airspace_fresh() {
        // One request a second for two and a half hours of simulated time, nobody watching
        // anywhere in particular. Tiles near a hub hold aircraft; the rest are empty.
        let sweep = Sweep::with(250, 5_000, 30_000);
        let total = sweep.stats(0).tiles;
        let busy = |lat: f64, lon: f64| {
            tiles::HUBS.iter().any(|(hub_lat, hub_lon)| haversine_km(lat, lon, *hub_lat, *hub_lon) < 1500.0)
        };
        let plane = obs(1, 0.0, 0.0);
        let mut last_fetch: FxHashMap<usize, i64> = FxHashMap::default();
        let mut worst_gap_after_warmup = 0i64;
        let mut first_sweep_at = None;
        let mut now = 0i64;
        for _ in 0..9_000 {
            now += 1_000;
            let Some(pick) = sweep.pick(now, true) else { continue };
            let occupied = busy(pick.lat, pick.lon);
            if occupied
                && let Some(previous) = last_fetch.insert(pick.index, now)
                && now > 3_600_000
            {
                worst_gap_after_warmup = worst_gap_after_warmup.max(now - previous);
            }
            sweep.complete(pick.index, 0, now, if occupied { std::slice::from_ref(&plane) } else { &[] });
            if first_sweep_at.is_none() && sweep.stats(now).fetched == total {
                first_sweep_at = Some(now);
            }
        }
        let busy_tiles = last_fetch.len();
        assert!(busy_tiles > 150, "{busy_tiles} busy tiles in the simulation");
        // Exploration gets a third of the slots until it is done: about three times the tile count.
        let first_sweep_min = first_sweep_at.expect("every tile is fetched") as f64 / 60_000.0;
        assert!((40.0..75.0).contains(&first_sweep_min), "first sweep took {first_sweep_min:.0} minutes");
        // Once warm, no busy tile waits anywhere near the 15 minute lifetime of its aircraft.
        let worst_min = worst_gap_after_warmup as f64 / 60_000.0;
        assert!(worst_min < 10.0, "a busy tile went {worst_min:.1} minutes without a refresh");
        // And the cycle the lifetime is derived from has been measured.
        let cycle = sweep.stats(now).background_cycle_s.expect("a background cycle");
        assert!(cycle > 30.0 && cycle < 600.0, "{cycle}");
    }

    #[test]
    fn a_failed_tile_is_left_alone_for_a_while() {
        let sweep = Sweep::with(250, 5_000, 30_000);
        let pick = sweep.pick(1_000, true).unwrap();
        sweep.failed(pick.index, 1_000);
        let next = sweep.pick(2_000, true).unwrap();
        assert_ne!(next.index, pick.index);
    }
}
