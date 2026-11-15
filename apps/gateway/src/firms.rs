//! Wildfire proxy: NASA FIRMS active-fire files, fetched with the gateway's
//! map key and shared by every client.
//!
//! FIRMS sends no CORS headers, and a map key is personal: shipped to browsers
//! it could be used up or revoked by any visitor. So the web app asks the
//! gateway, which asks FIRMS at most once per file per cache lifetime:
//!
//! - one file per (source, days) pair, kept compressed and served to everybody
//!   until it is `FIRMS_CACHE_TTL_S` old;
//! - single flight: while one request refreshes a file, the others wait for
//!   its answer instead of asking FIRMS themselves;
//! - a failed refresh is not retried for a minute (ten when FIRMS refused the
//!   key), and an older copy is served meanwhile if there is one;
//! - a ceiling on requests to FIRMS that no pattern of client traffic can
//!   raise, far inside the key's 5,000 transactions per ten minutes.
//!
//! The key never appears in a log line, an error message or a response.

use std::io::{Read, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering::Relaxed};
use std::time::{Duration, Instant};

use bytes::Bytes;
use parking_lot::Mutex;
use tokio::sync::Mutex as AsyncMutex;

use crate::config::{Config, Secret};
use crate::describe_http_error;
use crate::model::{UpstreamStatus, now_ms};

/// FIRMS near real-time products with worldwide coverage. Nothing else is proxied.
pub const SOURCES: [&str; 4] = ["MODIS_NRT", "VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT", "VIIRS_SNPP_NRT"];
/// FIRMS accepts a day range of 1 to 5.
pub const MAX_DAYS: u8 = 5;
/// The credit NASA asks for, ready to show.
pub const ATTRIBUTION: &str = "Active fire data: NASA FIRMS";

/// A copy past its lifetime may still be served this long when FIRMS cannot
/// be reached. Older than that it would pass off yesterday's fires as today's.
const MAX_STALE: Duration = Duration::from_secs(6 * 3600);
/// A file whose refresh failed is not asked for again this soon.
const RETRY_AFTER_FAILURE: Duration = Duration::from_secs(60);
/// After FIRMS refuses the key (invalid, or over its limit) nothing is asked
/// for this long: its limit is counted over ten minutes.
const RETRY_AFTER_REFUSAL: Duration = Duration::from_secs(600);
/// The gateway's own ceiling: requests to FIRMS per window, whatever clients do.
const WINDOW: Duration = Duration::from_secs(600);
const MAX_REQUESTS_PER_WINDOW: u32 = 60;
/// The largest world files take a while to produce and download.
const TIMEOUT: Duration = Duration::from_secs(90);
/// Compressed bytes kept across all files before the oldest are dropped.
const CACHE_MAX_BYTES: u64 = 48 * 1024 * 1024;

/// One file the proxy serves: a product and a number of days.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FireFile {
    source: usize,
    days: u8,
}

/// Why a request path does not name a file the proxy serves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BadFile {
    Source,
    Days,
}

impl FireFile {
    /// Check the `{source}` and `{days}` path segments against the allow-list.
    pub fn parse(source: &str, days: &str) -> Result<FireFile, BadFile> {
        let source = SOURCES.iter().position(|s| *s == source).ok_or(BadFile::Source)?;
        match days.as_bytes() {
            [digit @ b'1'..=b'9'] if *digit - b'0' <= MAX_DAYS => Ok(FireFile { source, days: *digit - b'0' }),
            _ => Err(BadFile::Days),
        }
    }

    pub fn source(self) -> &'static str {
        SOURCES[self.source]
    }

    pub fn days(self) -> u8 {
        self.days
    }

    fn index(self) -> usize {
        self.source * usize::from(MAX_DAYS) + usize::from(self.days - 1)
    }
}

/// Why the proxy has no file to give.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// Mock mode: the gateway makes no outside requests.
    Off,
    /// `FIRMS_MAP_KEY` is not set.
    NeedsKey,
    /// FIRMS answered "Invalid MAP_KEY".
    KeyRejected,
    /// FIRMS says the key is over its transaction limit.
    Limited,
    /// FIRMS could not be reached, or sent something that is not a fire file.
    Upstream,
    /// The gateway's own ceiling on FIRMS requests was reached.
    Busy,
}

impl Failure {
    /// Error code for the JSON error body.
    pub fn code(self) -> &'static str {
        match self {
            Failure::Off => "unavailable",
            Failure::NeedsKey | Failure::KeyRejected => "needs_key",
            Failure::Limited => "upstream_limited",
            Failure::Upstream | Failure::Busy => "upstream_error",
        }
    }

    /// One plain sentence for the person looking at the map. Never includes
    /// anything FIRMS sent or anything about the key itself.
    pub fn message(self) -> &'static str {
        match self {
            Failure::Off => "The wildfire proxy is off in mock mode.",
            Failure::NeedsKey => {
                "Wildfires need a NASA FIRMS map key. Set FIRMS_MAP_KEY on the gateway and restart it."
            }
            Failure::KeyRejected => {
                "NASA FIRMS rejected the gateway's map key. Check FIRMS_MAP_KEY on the gateway and restart it."
            }
            Failure::Limited => {
                "NASA FIRMS says the gateway's map key is over its request limit. Wildfires will retry in ten minutes."
            }
            Failure::Upstream => {
                "NASA FIRMS could not be reached or sent something unexpected. Wildfires will retry in a minute."
            }
            Failure::Busy => {
                "The gateway has made as many NASA FIRMS requests as it allows itself for now. Try again in a few minutes."
            }
        }
    }

    /// Whether an older copy is a fair answer. A rejected key is a
    /// configuration problem the operator has to see, so it is not papered over.
    fn allows_stale(self) -> bool {
        matches!(self, Failure::Limited | Failure::Upstream | Failure::Busy)
    }
}

/// Where a served file came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheState {
    /// The cached copy, still within its lifetime.
    Hit,
    /// Fetched from FIRMS for this request.
    Miss,
    /// Past its lifetime, served because FIRMS could not be asked.
    Stale,
}

impl CacheState {
    pub fn name(self) -> &'static str {
        match self {
            CacheState::Hit => "hit",
            CacheState::Miss => "miss",
            CacheState::Stale => "stale",
        }
    }
}

/// A fire file ready to send.
#[derive(Debug, Clone)]
pub struct Served {
    /// The CSV, gzip-compressed once when it was fetched.
    pub gzip: Bytes,
    /// Size of the CSV before compression.
    pub raw_len: usize,
    /// Time since it was fetched from FIRMS.
    pub age: Duration,
    /// How much longer this copy will be served without asking FIRMS; zero when stale.
    pub fresh_for: Duration,
    pub cache: CacheState,
}

impl Served {
    /// The CSV itself, for the rare client that does not accept gzip.
    pub async fn unpacked(&self) -> Option<Vec<u8>> {
        let (packed, raw_len) = (self.gzip.clone(), self.raw_len);
        tokio::task::spawn_blocking(move || gunzip(&packed, raw_len)).await.ok().flatten()
    }
}

#[derive(Debug, Clone)]
struct Cached {
    gzip: Bytes,
    raw_len: usize,
    fetched: Instant,
}

#[derive(Debug, Default)]
struct Slot {
    cached: Option<Cached>,
    /// The last refresh failed: do not ask again before this time.
    retry: Option<(Instant, Failure)>,
}

/// What `/health` and `/metrics` report about the proxy.
#[derive(Debug, Clone, PartialEq)]
pub struct FirmsStats {
    pub status: UpstreamStatus,
    pub note: &'static str,
    pub cache_hits: u64,
    pub cache_misses: u64,
    pub upstream_requests: u64,
    pub upstream_errors: u64,
    pub stale_served: u64,
    pub cached_files: u64,
    pub cached_bytes: u64,
    pub last_ok_seconds_ago: Option<i64>,
}

/// The shared cache in front of FIRMS.
pub struct FirmsProxy {
    /// False in mock mode, where no request may leave the machine.
    enabled: bool,
    key: Option<Secret>,
    base: String,
    http: reqwest::Client,
    ttl: Duration,
    max_bytes: usize,
    /// One per file. Holding a slot's lock is what makes a refresh single flight.
    slots: Vec<Arc<AsyncMutex<Slot>>>,
    /// FIRMS refused the key: nothing at all is asked before this time.
    refused: Mutex<Option<(Instant, Failure)>>,
    /// Start of the current window and the requests made in it.
    window: Mutex<(Instant, u32)>,
    last_failure: Mutex<Option<Failure>>,
    cache_hits: AtomicU64,
    cache_misses: AtomicU64,
    upstream_requests: AtomicU64,
    upstream_errors: AtomicU64,
    stale_served: AtomicU64,
    cached_files: AtomicU64,
    cached_bytes: AtomicU64,
    last_ok_ms: AtomicI64,
}

impl FirmsProxy {
    pub fn new(config: &Config, http: reqwest::Client) -> FirmsProxy {
        FirmsProxy {
            enabled: config.mock.is_none(),
            key: config.firms_map_key.clone(),
            base: config.firms_base_url.trim_end_matches('/').to_owned(),
            http,
            ttl: config.firms_cache_ttl,
            max_bytes: config.firms_max_bytes,
            slots: (0..SOURCES.len() * usize::from(MAX_DAYS)).map(|_| Arc::default()).collect(),
            refused: Mutex::new(None),
            window: Mutex::new((Instant::now(), 0)),
            last_failure: Mutex::new(None),
            cache_hits: AtomicU64::new(0),
            cache_misses: AtomicU64::new(0),
            upstream_requests: AtomicU64::new(0),
            upstream_errors: AtomicU64::new(0),
            stale_served: AtomicU64::new(0),
            cached_files: AtomicU64::new(0),
            cached_bytes: AtomicU64::new(0),
            last_ok_ms: AtomicI64::new(0),
        }
    }

    /// True when the proxy could serve files: not in mock mode, and a key is set.
    pub fn configured(&self) -> bool {
        self.enabled && self.key.is_some()
    }

    /// True when the gateway makes outside requests at all (not mock mode).
    pub fn enabled(&self) -> bool {
        self.enabled
    }

    fn served(&self, cached: &Cached, cache: CacheState) -> Served {
        let age = cached.fetched.elapsed();
        let fresh_for = if cache == CacheState::Stale { Duration::ZERO } else { self.ttl.saturating_sub(age) };
        Served { gzip: cached.gzip.clone(), raw_len: cached.raw_len, age, fresh_for, cache }
    }

    /// The file, from the cache when it is fresh, otherwise from FIRMS.
    pub async fn get(self: &Arc<Self>, file: FireFile) -> Result<Served, Failure> {
        if !self.enabled {
            return Err(Failure::Off);
        }
        if self.key.is_none() {
            return Err(Failure::NeedsKey);
        }
        // One caller at a time per file. Whoever waits here while another
        // refreshes finds the fresh copy when the lock is theirs.
        let mut slot = self.slots[file.index()].clone().lock_owned().await;
        if let Some(cached) = &slot.cached
            && cached.fetched.elapsed() < self.ttl
        {
            self.cache_hits.fetch_add(1, Relaxed);
            return Ok(self.served(cached, CacheState::Hit));
        }
        self.cache_misses.fetch_add(1, Relaxed);
        // The refresh runs in its own task, holding the lock: if this caller
        // goes away, the request it started still finishes and fills the
        // cache instead of being paid for and thrown away.
        let this = self.clone();
        let refresh = tokio::spawn(async move { this.refresh(&mut slot, file).await });
        refresh.await.unwrap_or(Err(Failure::Upstream))
    }

    async fn refresh(&self, slot: &mut Slot, file: FireFile) -> Result<Served, Failure> {
        let now = Instant::now();
        let waiting =
            |held: Option<(Instant, Failure)>| held.filter(|(until, _)| now < *until).map(|(_, failure)| failure);
        let refused = *self.refused.lock();
        let held = waiting(refused).or_else(|| waiting(slot.retry));
        let outcome = match held {
            Some(failure) => Err(failure),
            None if !self.reserve_request(now) => {
                *self.last_failure.lock() = Some(Failure::Busy);
                Err(Failure::Busy)
            }
            None => {
                let outcome = self.fetch(file).await;
                self.remember(slot, outcome.as_ref().err().copied());
                outcome
            }
        };
        match outcome {
            Ok(cached) => {
                let served = self.served(&cached, CacheState::Miss);
                self.store(slot, Some(cached));
                self.trim();
                Ok(served)
            }
            Err(failure) => {
                if slot.cached.as_ref().is_some_and(|old| old.fetched.elapsed() >= MAX_STALE) {
                    self.store(slot, None);
                }
                match &slot.cached {
                    Some(old) if failure.allows_stale() => {
                        self.stale_served.fetch_add(1, Relaxed);
                        Ok(self.served(old, CacheState::Stale))
                    }
                    _ => Err(failure),
                }
            }
        }
    }

    /// Count one request against the gateway's own ceiling. False when the window is full.
    fn reserve_request(&self, now: Instant) -> bool {
        let mut window = self.window.lock();
        if now.saturating_duration_since(window.0) >= WINDOW {
            *window = (now, 0);
        }
        if window.1 >= MAX_REQUESTS_PER_WINDOW {
            return false;
        }
        window.1 += 1;
        true
    }

    /// Note how a request to FIRMS went, so the next one is not made too soon.
    fn remember(&self, slot: &mut Slot, failure: Option<Failure>) {
        *self.last_failure.lock() = failure;
        let now = Instant::now();
        match failure {
            None => {
                slot.retry = None;
                *self.refused.lock() = None;
                self.last_ok_ms.store(now_ms(), Relaxed);
            }
            Some(failure) => {
                self.upstream_errors.fetch_add(1, Relaxed);
                if matches!(failure, Failure::KeyRejected | Failure::Limited) {
                    // The key is the same for every file, so every file waits.
                    *self.refused.lock() = Some((now + RETRY_AFTER_REFUSAL, failure));
                } else {
                    slot.retry = Some((now + RETRY_AFTER_FAILURE, failure));
                }
            }
        }
    }

    /// Replace (or drop) a slot's copy, keeping the cache totals in step.
    fn store(&self, slot: &mut Slot, cached: Option<Cached>) {
        if let Some(old) = &slot.cached {
            self.cached_files.fetch_sub(1, Relaxed);
            self.cached_bytes.fetch_sub(old.gzip.len() as u64, Relaxed);
        }
        if let Some(new) = &cached {
            self.cached_files.fetch_add(1, Relaxed);
            self.cached_bytes.fetch_add(new.gzip.len() as u64, Relaxed);
        }
        slot.cached = cached;
    }

    /// Keep the cache within its size by dropping the files fetched longest
    /// ago. Files being refreshed right now are locked and left alone.
    fn trim(&self) {
        while self.cached_bytes.load(Relaxed) > CACHE_MAX_BYTES {
            let oldest = self
                .slots
                .iter()
                .filter_map(|slot| {
                    let guard = slot.try_lock().ok()?;
                    guard.cached.as_ref().map(|cached| (cached.fetched, slot))
                })
                .min_by_key(|(fetched, _)| *fetched);
            let Some((_, slot)) = oldest else { break };
            let Ok(mut guard) = slot.try_lock() else { break };
            self.store(&mut guard, None);
        }
    }

    async fn fetch(&self, file: FireFile) -> Result<Cached, Failure> {
        let key = self.key.as_ref().ok_or(Failure::NeedsKey)?.expose();
        let (source, days) = (file.source(), file.days);
        let fail = |failure: Failure, reason: String| {
            // The reason is built from error text without the URL; scrubbing
            // the key as well costs nothing and leaves no way for it to leak.
            let reason = reason.replace(key, "[key]");
            tracing::warn!(source, days, %reason, "FIRMS request failed");
            failure
        };
        self.upstream_requests.fetch_add(1, Relaxed);
        let started = Instant::now();
        let url = format!("{}/api/area/csv/{key}/{source}/world/{days}", self.base);
        let mut response = self
            .http
            .get(&url)
            .timeout(TIMEOUT)
            .send()
            .await
            .map_err(|e| fail(Failure::Upstream, describe_http_error(e)))?;
        let status = response.status().as_u16();
        let mut body: Vec<u8> = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| fail(Failure::Upstream, describe_http_error(e)))? {
            if body.len() + chunk.len() > self.max_bytes {
                return Err(fail(Failure::Upstream, format!("the file is larger than {} bytes", self.max_bytes)));
            }
            body.extend_from_slice(&chunk);
        }
        if let Err(failure) = classify(status, &body) {
            return Err(fail(failure, format!("HTTP {status}, read as: {}", failure.code())));
        }
        let raw_len = body.len();
        let packed = tokio::task::spawn_blocking(move || gzip(&body)).await.ok().flatten();
        let Some(packed) = packed else {
            return Err(fail(Failure::Upstream, "compressing the file failed".to_owned()));
        };
        tracing::info!(
            source,
            days,
            bytes = raw_len,
            packed = packed.len(),
            ms = started.elapsed().as_millis() as u64,
            "FIRMS file refreshed"
        );
        Ok(Cached { gzip: Bytes::from(packed), raw_len, fetched: Instant::now() })
    }

    pub fn stats(&self) -> FirmsStats {
        let (status, note) = if !self.enabled {
            (UpstreamStatus::Off, "Off in mock mode.")
        } else if self.key.is_none() {
            (UpstreamStatus::NeedsKey, "Set FIRMS_MAP_KEY to serve wildfires.")
        } else {
            match *self.last_failure.lock() {
                None => (UpstreamStatus::Ok, ""),
                Some(Failure::KeyRejected) => (UpstreamStatus::NeedsKey, "NASA FIRMS rejected the map key."),
                Some(Failure::Limited) => {
                    (UpstreamStatus::Degraded, "NASA FIRMS says the map key is over its request limit.")
                }
                Some(Failure::Busy) => {
                    (UpstreamStatus::Degraded, "The gateway's own ceiling on NASA FIRMS requests was reached.")
                }
                Some(_) => (UpstreamStatus::Degraded, "The last request to NASA FIRMS failed."),
            }
        };
        let last_ok = self.last_ok_ms.load(Relaxed);
        FirmsStats {
            status,
            note,
            cache_hits: self.cache_hits.load(Relaxed),
            cache_misses: self.cache_misses.load(Relaxed),
            upstream_requests: self.upstream_requests.load(Relaxed),
            upstream_errors: self.upstream_errors.load(Relaxed),
            stale_served: self.stale_served.load(Relaxed),
            cached_files: self.cached_files.load(Relaxed),
            cached_bytes: self.cached_bytes.load(Relaxed),
            last_ok_seconds_ago: (last_ok > 0).then(|| (now_ms() - last_ok) / 1000),
        }
    }
}

/// Decide what FIRMS answered. It reports problems as a short line of text,
/// sometimes with status 200, so the body is what counts: a fire file starts
/// with its CSV header.
pub fn classify(status: u16, body: &[u8]) -> Result<(), Failure> {
    let head = String::from_utf8_lossy(&body[..body.len().min(256)]).to_ascii_lowercase();
    let head = head.trim_start_matches('\u{feff}').trim_start();
    if (200..300).contains(&status) && head.starts_with("latitude,longitude,") {
        return Ok(());
    }
    if head.contains("map_key") {
        // "MAP_KEY is invalid or your have exceeded your transaction/time limit"
        // is the limit; a bare "Invalid MAP_KEY." is the key.
        return Err(if head.contains("exceed") || head.contains("limit") {
            Failure::Limited
        } else {
            Failure::KeyRejected
        });
    }
    Err(if status == 429 { Failure::Limited } else { Failure::Upstream })
}

fn gzip(raw: &[u8]) -> Option<Vec<u8>> {
    let out = Vec::with_capacity(raw.len() / 4 + 64);
    let mut encoder = flate2::write::GzEncoder::new(out, flate2::Compression::new(6));
    encoder.write_all(raw).ok()?;
    encoder.finish().ok()
}

fn gunzip(packed: &[u8], raw_len: usize) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(raw_len);
    flate2::read::GzDecoder::new(packed).read_to_end(&mut out).ok()?;
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_listed_files_are_served() {
        let file = FireFile::parse("VIIRS_SNPP_NRT", "5").unwrap();
        assert_eq!((file.source(), file.days()), ("VIIRS_SNPP_NRT", 5));
        assert_eq!(file.index(), 19, "the last of twenty slots");
        assert_eq!(FireFile::parse("MODIS_NRT", "1").unwrap().index(), 0);
        for source in ["modis_nrt", "MODIS_SP", "LANDSAT_NRT", "", "MODIS_NRT/../x", "MODIS_NRT "] {
            assert_eq!(FireFile::parse(source, "1"), Err(BadFile::Source), "{source:?}");
        }
        for days in ["0", "6", "10", "01", "1.0", "-1", "+1", "", "two", " 2"] {
            assert_eq!(FireFile::parse("MODIS_NRT", days), Err(BadFile::Days), "{days:?}");
        }
    }

    #[test]
    fn firms_answers_are_told_apart_by_their_text() {
        let modis = b"latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,confidence\n";
        assert_eq!(classify(200, modis), Ok(()));
        assert_eq!(classify(200, b"\xef\xbb\xbflatitude,longitude,bright_ti4\n1,2,3\n"), Ok(()), "a byte order mark");
        // A rejected key: status 400, or the same text with a 200.
        assert_eq!(classify(400, b"Invalid MAP_KEY."), Err(Failure::KeyRejected));
        assert_eq!(classify(200, b"Invalid MAP_KEY."), Err(Failure::KeyRejected));
        let limit = b"MAP_KEY is invalid or your have exceeded your transaction/time limit. Please try again later.";
        assert_eq!(classify(403, limit), Err(Failure::Limited));
        assert_eq!(classify(429, b""), Err(Failure::Limited));
        assert_eq!(classify(500, b"<html>Server error</html>"), Err(Failure::Upstream));
        assert_eq!(classify(200, b"<html>Maintenance</html>"), Err(Failure::Upstream));
        assert_eq!(classify(200, b""), Err(Failure::Upstream));
        assert_eq!(classify(404, modis), Err(Failure::Upstream), "a fire file only counts with a success status");
    }

    #[test]
    fn failures_map_to_codes_and_plain_messages() {
        assert_eq!(Failure::NeedsKey.code(), "needs_key");
        assert_eq!(Failure::KeyRejected.code(), "needs_key");
        assert_eq!(Failure::Limited.code(), "upstream_limited");
        assert_eq!(Failure::Upstream.code(), "upstream_error");
        assert!(!Failure::KeyRejected.allows_stale(), "a rejected key must be seen, not hidden behind an old copy");
        assert!(Failure::Upstream.allows_stale() && Failure::Limited.allows_stale());
        for failure in
            [Failure::Off, Failure::NeedsKey, Failure::KeyRejected, Failure::Limited, Failure::Upstream, Failure::Busy]
        {
            assert!(failure.message().ends_with('.') && failure.message().len() > 20);
        }
    }

    #[test]
    fn compression_round_trips() {
        let csv = "latitude,longitude,brightness\n".to_owned() + &"-12.345,130.123,320.5\n".repeat(2000);
        let packed = gzip(csv.as_bytes()).unwrap();
        assert!(packed.len() * 5 < csv.len(), "{} of {}", packed.len(), csv.len());
        assert_eq!(gunzip(&packed, csv.len()).unwrap(), csv.as_bytes());
        assert_eq!(gunzip(b"not gzip", 0), None);
    }
}
