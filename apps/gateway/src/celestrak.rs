//! Satellite element cache: CelesTrak GP files in OMM CSV, fetched at most
//! once per update and shared by every client.
//!
//! CelesTrak serves a group once per data update (every 2 hours) to each IP
//! address, answers a repeat with HTTP 403, and puts addresses that keep
//! erroring in its firewall. Its usage policy asks deployments with many
//! users behind one address to cache through their own proxy
//! (<https://celestrak.org/usage-policy.php>). This is that proxy:
//!
//! - one copy per group, kept gzip-compressed in memory, served to everybody;
//! - fetched only when a client asks and the copy is older than
//!   `CELESTRAK_REFRESH_S` (2 hours, never less), so an idle gateway asks
//!   nothing;
//! - at most one attempt per group per refresh window, whatever happens:
//!   a 403, any other status, a timeout or a file that is not OMM CSV ends
//!   the attempt and nothing is asked again until the window is over;
//! - single flight: while one request refreshes a group, the others wait for
//!   its answer instead of asking CelesTrak themselves;
//! - the last good copy is served for up to `CELESTRAK_MAX_STALE_S` (7 days)
//!   while CelesTrak is refusing or unreachable, marked `X-Halo-Cache: stale`;
//! - the copy and the time of the last attempt are kept in
//!   `CELESTRAK_CACHE_DIR`, so a restart neither forgets the window nor
//!   spends a download.
//!
//! Redirects are not followed: CelesTrak answers wrong domains and legacy
//! queries with a 301 and asks clients to stop there.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering::Relaxed};
use std::time::{Duration, Instant};

use bytes::Bytes;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as AsyncMutex;

use crate::config::Config;
use crate::describe_http_error;
use crate::model::{UpstreamStatus, now_ms};

/// GP groups the proxy serves. `active` is what the web app uses; `stations`
/// (a few dozen objects) is for development and protocol checks.
pub const GROUPS: [&str; 2] = ["active", "stations"];
/// The credit CelesTrak asks for, ready to show.
pub const ATTRIBUTION: &str = "Satellite orbits: CelesTrak, from U.S. Space Force GP data";
/// What the User-Agent adds to the gateway's own name: what this client is,
/// so CelesTrak can tell it apart. Nothing about the operator.
pub const USER_AGENT_PURPOSE: &str =
    "shared CelesTrak cache for an open-source live globe; one download per group per update";

/// A CelesTrak update cycle. The refresh interval can be set longer, never shorter.
pub const MIN_REFRESH: Duration = Duration::from_secs(2 * 3600);
/// The active group is 2.5 MB and takes a few seconds at worst.
const TIMEOUT: Duration = Duration::from_secs(60);
/// Browsers and CDNs hold a copy at most this long before asking the gateway again.
const CLIENT_HOLD_MAX: Duration = Duration::from_secs(3600);
const CLIENT_HOLD_MIN: Duration = Duration::from_secs(60);

/// One group the proxy serves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Group(usize);

impl Group {
    /// Read the `{group}.csv` path segment against the allow-list.
    pub fn parse(file: &str) -> Option<Group> {
        let name = file.strip_suffix(".csv")?;
        GROUPS.iter().position(|g| *g == name).map(Group)
    }

    pub fn name(self) -> &'static str {
        GROUPS[self.0]
    }
}

/// Why the proxy has no copy to give.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// Mock mode: the gateway makes no outside requests.
    Off,
    /// CelesTrak answered with this status instead of 200.
    Refused(u16),
    /// CelesTrak could not be reached, or did not finish in time.
    Unreachable,
    /// CelesTrak answered 200 with something other than OMM CSV, or a file over the size cap.
    BadData,
}

impl Failure {
    /// One plain sentence for the person looking at the map. Nothing CelesTrak sent is repeated.
    pub fn message(self) -> String {
        match self {
            Failure::Off => "Satellite elements are off in mock mode: the gateway makes no outside requests.".to_owned(),
            Failure::Refused(403) => {
                "CelesTrak refused the gateway's request (HTTP 403), as it does when an address asks twice in one update."
                    .to_owned()
            }
            Failure::Refused(status) => format!("CelesTrak answered the gateway with HTTP {status}."),
            Failure::Unreachable => "CelesTrak could not be reached from the gateway.".to_owned(),
            Failure::BadData => "CelesTrak sent the gateway something other than orbital elements.".to_owned(),
        }
    }

    fn note(self) -> &'static str {
        match self {
            Failure::Off => "Off in mock mode.",
            Failure::Refused(403) => "CelesTrak refused the last request (HTTP 403).",
            Failure::Refused(_) => "CelesTrak answered the last request with an error.",
            Failure::Unreachable => "CelesTrak could not be reached.",
            Failure::BadData => "CelesTrak's last answer was not OMM CSV.",
        }
    }
}

/// Where a served copy came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheState {
    /// The cached copy, within its refresh interval.
    Hit,
    /// Fetched from CelesTrak for this request.
    Miss,
    /// Older than the refresh interval, served because CelesTrak may not be asked or did not answer.
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

/// A copy ready to send.
#[derive(Debug, Clone)]
pub struct Served {
    /// The CSV, gzip-compressed once when it was fetched.
    pub gzip: Bytes,
    pub raw_len: usize,
    /// Weak validator: the same elements give the same tag, whichever encoding is sent.
    pub etag: String,
    /// Time since it was fetched from CelesTrak.
    pub age: Duration,
    /// Until the gateway may next ask CelesTrak for this group; zero when it may now.
    pub next_refresh_in: Duration,
    pub cache: CacheState,
}

impl Served {
    /// The CSV itself, for the rare client that does not accept gzip.
    pub async fn unpacked(&self) -> Option<Vec<u8>> {
        let (packed, raw_len) = (self.gzip.clone(), self.raw_len);
        tokio::task::spawn_blocking(move || gunzip(&packed, raw_len)).await.ok().flatten()
    }

    /// How long a browser or CDN may reuse this answer, counted from when it
    /// was fetched (caches add `Age` to their own clock): until the gateway
    /// could have a newer copy, between one minute and an hour from now.
    pub fn max_age(&self) -> Duration {
        self.age + self.next_refresh_in.clamp(CLIENT_HOLD_MIN, CLIENT_HOLD_MAX)
    }
}

/// Why there is nothing to serve, and when asking again could help.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Unavailable {
    pub failure: Failure,
    /// Until the gateway may ask CelesTrak again; `None` in mock mode.
    pub retry_in: Option<Duration>,
}

#[derive(Debug, Clone)]
struct Cached {
    gzip: Bytes,
    raw_len: usize,
    etag: String,
    /// Wall clock, Unix milliseconds: survives a restart through the cache file.
    fetched_ms: i64,
}

#[derive(Debug, Default)]
struct Slot {
    cached: Option<Cached>,
    /// The last request to CelesTrak, successful or not, Unix milliseconds.
    attempt_ms: Option<i64>,
    failure: Option<Failure>,
}

/// What `/health` and `/metrics` report about the proxy.
#[derive(Debug, Clone, PartialEq)]
pub struct CelestrakStats {
    pub status: UpstreamStatus,
    pub note: &'static str,
    pub cache_hits: u64,
    pub cache_misses: u64,
    pub not_modified: u64,
    pub upstream_requests: u64,
    pub upstream_errors: u64,
    pub stale_served: u64,
    pub unavailable: u64,
    pub cached_bytes: u64,
    pub last_ok_seconds_ago: Option<i64>,
    pub groups: Vec<GroupStats>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GroupStats {
    pub group: &'static str,
    pub age_s: Option<i64>,
    pub bytes: Option<u64>,
    pub last_attempt_seconds_ago: Option<i64>,
    pub next_refresh_in_s: i64,
    pub last_failure: Option<String>,
}

/// The shared cache in front of CelesTrak.
pub struct CelestrakProxy {
    /// False in mock mode, where no request may leave the machine.
    enabled: bool,
    base: String,
    http: reqwest::Client,
    refresh: Duration,
    max_stale: Duration,
    max_bytes: usize,
    dir: Option<PathBuf>,
    /// One per group. Holding a slot's lock is what makes a refresh single flight.
    slots: Vec<Arc<AsyncMutex<Slot>>>,
    last_failure: Mutex<Option<Failure>>,
    cache_hits: AtomicU64,
    cache_misses: AtomicU64,
    not_modified: AtomicU64,
    upstream_requests: AtomicU64,
    upstream_errors: AtomicU64,
    stale_served: AtomicU64,
    unavailable: AtomicU64,
    cached_bytes: AtomicU64,
    last_ok_ms: AtomicI64,
}

impl CelestrakProxy {
    /// Build the proxy, restoring saved copies from `CELESTRAK_CACHE_DIR`. `http`
    /// must not follow redirects.
    pub fn new(config: &Config, http: reqwest::Client) -> CelestrakProxy {
        let dir = config.celestrak_cache_dir.clone();
        let proxy = CelestrakProxy {
            enabled: config.mock.is_none(),
            base: config.celestrak_base_url.trim_end_matches('/').to_owned(),
            http,
            refresh: config.celestrak_refresh,
            max_stale: config.celestrak_max_stale,
            max_bytes: config.celestrak_max_bytes,
            slots: GROUPS
                .iter()
                .map(|group| {
                    let slot = dir.as_deref().map(|dir| restore(dir, group)).unwrap_or_default();
                    Arc::new(AsyncMutex::new(slot))
                })
                .collect(),
            dir,
            last_failure: Mutex::new(None),
            cache_hits: AtomicU64::new(0),
            cache_misses: AtomicU64::new(0),
            not_modified: AtomicU64::new(0),
            upstream_requests: AtomicU64::new(0),
            upstream_errors: AtomicU64::new(0),
            stale_served: AtomicU64::new(0),
            unavailable: AtomicU64::new(0),
            cached_bytes: AtomicU64::new(0),
            last_ok_ms: AtomicI64::new(0),
        };
        for slot in &proxy.slots {
            let slot = slot.try_lock().expect("nobody else has the proxy yet");
            if let Some(cached) = &slot.cached {
                proxy.cached_bytes.fetch_add(cached.gzip.len() as u64, Relaxed);
                proxy.last_ok_ms.fetch_max(cached.fetched_ms, Relaxed);
            }
        }
        proxy
    }

    /// True when the gateway makes outside requests at all (not mock mode).
    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn refresh_interval(&self) -> Duration {
        self.refresh
    }

    pub fn max_stale(&self) -> Duration {
        self.max_stale
    }

    /// A client got a 304 for its copy.
    pub fn count_not_modified(&self) {
        self.not_modified.fetch_add(1, Relaxed);
    }

    fn served(&self, slot: &Slot, cached: &Cached, cache: CacheState, now: i64) -> Served {
        Served {
            gzip: cached.gzip.clone(),
            raw_len: cached.raw_len,
            etag: cached.etag.clone(),
            age: ms(now - cached.fetched_ms),
            next_refresh_in: self.next_refresh_in(slot, now),
            cache,
        }
    }

    fn next_refresh_in(&self, slot: &Slot, now: i64) -> Duration {
        let last = slot.attempt_ms.into_iter().chain(slot.cached.as_ref().map(|c| c.fetched_ms)).max();
        last.map_or(Duration::ZERO, |last| self.refresh.saturating_sub(ms(now - last)))
    }

    /// The group, from the cache when it is fresh, otherwise from CelesTrak
    /// if this refresh window has not been used yet.
    pub async fn get(self: &Arc<Self>, group: Group) -> Result<Served, Unavailable> {
        if !self.enabled {
            return Err(Unavailable { failure: Failure::Off, retry_in: None });
        }
        // One caller at a time per group. Whoever waits here while another
        // refreshes finds the new copy when the lock is theirs.
        let mut slot = self.slots[group.0].clone().lock_owned().await;
        let now = now_ms();
        if slot.cached.as_ref().is_some_and(|c| ms(now - c.fetched_ms) >= self.max_stale) {
            // Too old to pass off as the sky: positions would be far off.
            self.drop_copy(&mut slot);
        }
        if let Some(cached) = &slot.cached
            && ms(now - cached.fetched_ms) < self.refresh
        {
            self.cache_hits.fetch_add(1, Relaxed);
            return Ok(self.served(&slot, cached, CacheState::Hit, now));
        }
        self.cache_misses.fetch_add(1, Relaxed);
        if self.next_refresh_in(&slot, now) > Duration::ZERO {
            // This window's one request is spent (or failed): no second one.
            return self.fallback(&slot, now);
        }
        // The refresh runs in its own task, holding the lock: if this caller
        // goes away, the download it started still finishes and fills the
        // cache instead of being paid for and thrown away.
        let this = self.clone();
        let refresh = tokio::spawn(async move { this.refresh(&mut slot, group).await });
        refresh.await.unwrap_or(Err(Unavailable { failure: Failure::Unreachable, retry_in: Some(self.refresh) }))
    }

    async fn refresh(&self, slot: &mut Slot, group: Group) -> Result<Served, Unavailable> {
        let started = now_ms();
        slot.attempt_ms = Some(started);
        // Saved before the request goes out: a crash mid-download must not lead to a second one.
        self.save_meta(slot, group).await;
        let outcome = self.fetch(group).await;
        let now = now_ms();
        match outcome {
            Ok(cached) => {
                *self.last_failure.lock() = None;
                slot.failure = None;
                self.last_ok_ms.store(cached.fetched_ms, Relaxed);
                self.drop_copy(slot);
                self.cached_bytes.fetch_add(cached.gzip.len() as u64, Relaxed);
                slot.cached = Some(cached);
                self.save_copy(slot, group).await;
                let cached = slot.cached.as_ref().expect("just stored");
                Ok(self.served(slot, cached, CacheState::Miss, now))
            }
            Err(failure) => {
                self.upstream_errors.fetch_add(1, Relaxed);
                *self.last_failure.lock() = Some(failure);
                slot.failure = Some(failure);
                self.save_meta(slot, group).await;
                self.fallback(slot, now)
            }
        }
    }

    /// The old copy when there is one, otherwise why there is none and when to come back.
    fn fallback(&self, slot: &Slot, now: i64) -> Result<Served, Unavailable> {
        match &slot.cached {
            Some(old) => {
                self.stale_served.fetch_add(1, Relaxed);
                Ok(self.served(slot, old, CacheState::Stale, now))
            }
            None => {
                self.unavailable.fetch_add(1, Relaxed);
                let failure = slot.failure.unwrap_or(Failure::Unreachable);
                Err(Unavailable { failure, retry_in: Some(self.next_refresh_in(slot, now)) })
            }
        }
    }

    fn drop_copy(&self, slot: &mut Slot) {
        if let Some(old) = slot.cached.take() {
            self.cached_bytes.fetch_sub(old.gzip.len() as u64, Relaxed);
        }
    }

    async fn fetch(&self, group: Group) -> Result<Cached, Failure> {
        let name = group.name();
        let fail = |failure: Failure, reason: String| {
            tracing::warn!(group = name, %reason, "CelesTrak request failed; not asking again this update");
            failure
        };
        self.upstream_requests.fetch_add(1, Relaxed);
        let started = Instant::now();
        let url = format!("{}/NORAD/elements/gp.php?GROUP={name}&FORMAT=CSV", self.base);
        let mut response = self
            .http
            .get(&url)
            .timeout(TIMEOUT)
            .send()
            .await
            .map_err(|e| fail(Failure::Unreachable, describe_http_error(e)))?;
        let status = response.status().as_u16();
        if status != 200 {
            // Stop at once, whatever the status: CelesTrak counts errors against the address.
            return Err(fail(Failure::Refused(status), format!("HTTP {status}")));
        }
        let mut body: Vec<u8> = Vec::new();
        while let Some(chunk) =
            response.chunk().await.map_err(|e| fail(Failure::Unreachable, describe_http_error(e)))?
        {
            if body.len() + chunk.len() > self.max_bytes {
                return Err(fail(Failure::BadData, format!("the file is larger than {} bytes", self.max_bytes)));
            }
            body.extend_from_slice(&chunk);
        }
        if !is_omm_csv(&body) {
            return Err(fail(Failure::BadData, format!("{} bytes that are not OMM CSV", body.len())));
        }
        let raw_len = body.len();
        let etag = etag_of(&body);
        let packed = tokio::task::spawn_blocking(move || gzip(&body)).await.ok().flatten();
        let Some(packed) = packed else {
            return Err(fail(Failure::BadData, "compressing the file failed".to_owned()));
        };
        tracing::info!(
            group = name,
            bytes = raw_len,
            packed = packed.len(),
            ms = started.elapsed().as_millis() as u64,
            "CelesTrak elements refreshed"
        );
        Ok(Cached { gzip: Bytes::from(packed), raw_len, etag, fetched_ms: now_ms() })
    }

    async fn save_meta(&self, slot: &Slot, group: Group) {
        let Some(dir) = self.dir.clone() else { return };
        let meta = Meta {
            attempt_ms: slot.attempt_ms,
            fetched_ms: slot.cached.as_ref().map(|c| c.fetched_ms),
            failure_status: match slot.failure {
                Some(Failure::Refused(status)) => Some(status),
                _ => None,
            },
        };
        let saved = tokio::task::spawn_blocking(move || write_meta(&dir, group.name(), &meta)).await;
        if let Ok(Err(error)) = saved {
            tracing::warn!(group = group.name(), %error, "could not save the CelesTrak cache state");
        }
    }

    async fn save_copy(&self, slot: &Slot, group: Group) {
        let (Some(dir), Some(cached)) = (self.dir.clone(), slot.cached.clone()) else { return };
        let meta = Meta { attempt_ms: slot.attempt_ms, fetched_ms: Some(cached.fetched_ms), failure_status: None };
        let saved = tokio::task::spawn_blocking(move || {
            write_atomic(&dir.join(format!("{}.csv.gz", group.name())), &cached.gzip)?;
            write_meta(&dir, group.name(), &meta)
        })
        .await;
        if let Ok(Err(error)) = saved {
            tracing::warn!(group = group.name(), %error, "could not save the CelesTrak copy");
        }
    }

    pub fn stats(&self) -> CelestrakStats {
        let now = now_ms();
        let last_failure = *self.last_failure.lock();
        let (status, note) = if !self.enabled {
            (UpstreamStatus::Off, Failure::Off.note())
        } else {
            match last_failure {
                None => (UpstreamStatus::Ok, ""),
                Some(failure) => (UpstreamStatus::Degraded, failure.note()),
            }
        };
        let groups = GROUPS
            .iter()
            .zip(&self.slots)
            .filter_map(|(group, slot)| {
                // A slot being refreshed right now is reported next time.
                let slot = slot.try_lock().ok()?;
                Some(GroupStats {
                    group,
                    age_s: slot.cached.as_ref().map(|c| (now - c.fetched_ms) / 1000),
                    bytes: slot.cached.as_ref().map(|c| c.gzip.len() as u64),
                    last_attempt_seconds_ago: slot.attempt_ms.map(|a| (now - a) / 1000),
                    next_refresh_in_s: self.next_refresh_in(&slot, now).as_secs() as i64,
                    last_failure: slot.failure.map(|f| f.note().to_owned()),
                })
            })
            .collect();
        let last_ok = self.last_ok_ms.load(Relaxed);
        CelestrakStats {
            status,
            note,
            cache_hits: self.cache_hits.load(Relaxed),
            cache_misses: self.cache_misses.load(Relaxed),
            not_modified: self.not_modified.load(Relaxed),
            upstream_requests: self.upstream_requests.load(Relaxed),
            upstream_errors: self.upstream_errors.load(Relaxed),
            stale_served: self.stale_served.load(Relaxed),
            unavailable: self.unavailable.load(Relaxed),
            cached_bytes: self.cached_bytes.load(Relaxed),
            last_ok_seconds_ago: (last_ok > 0).then(|| (now - last_ok) / 1000),
            groups,
        }
    }
}

/// What is kept next to a saved copy.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    attempt_ms: Option<i64>,
    fetched_ms: Option<i64>,
    /// The status CelesTrak refused the last attempt with, if it did.
    failure_status: Option<u16>,
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

fn write_meta(dir: &Path, group: &str, meta: &Meta) -> std::io::Result<()> {
    write_atomic(&dir.join(format!("{group}.json")), &serde_json::to_vec(meta)?)
}

/// The saved state of one group. Anything missing or unreadable is simply
/// not restored; a copy that does not decode as OMM CSV is ignored.
fn restore(dir: &Path, group: &str) -> Slot {
    let Ok(meta) = std::fs::read(dir.join(format!("{group}.json"))) else { return Slot::default() };
    let Ok(meta) = serde_json::from_slice::<Meta>(&meta) else { return Slot::default() };
    let cached = meta.fetched_ms.and_then(|fetched_ms| {
        let packed = std::fs::read(dir.join(format!("{group}.csv.gz"))).ok()?;
        let raw = gunzip(&packed, packed.len() * 4)?;
        is_omm_csv(&raw).then(|| Cached {
            raw_len: raw.len(),
            etag: etag_of(&raw),
            gzip: Bytes::from(packed),
            fetched_ms,
        })
    });
    let failure = meta.failure_status.map(Failure::Refused);
    tracing::info!(group, restored = cached.is_some(), "CelesTrak cache state restored");
    Slot { attempt_ms: meta.attempt_ms, failure, cached }
}

/// An OMM CSV file starts with its header row, `OBJECT_NAME,...`, and has a row after it.
pub fn is_omm_csv(body: &[u8]) -> bool {
    let body = body.strip_prefix(b"\xef\xbb\xbf".as_slice()).unwrap_or(body);
    let Some(rest) = body.strip_prefix(b"OBJECT_NAME,".as_slice()) else { return false };
    let mut lines = rest.split(|b| *b == b'\n');
    let header = lines.next().unwrap_or_default();
    header.windows(b"NORAD_CAT_ID".len()).any(|w| w == b"NORAD_CAT_ID")
        && lines.any(|line| line.iter().any(|b| !b.is_ascii_whitespace()))
}

/// A weak entity tag from the file's bytes (FNV-1a, 64 bits): identical
/// elements get the same tag, across restarts too.
fn etag_of(raw: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in raw {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("W/\"{hash:016x}-{:x}\"", raw.len())
}

/// True when an `If-None-Match` value names `etag`, comparing weakly as RFC 9110 asks.
pub fn matches_etag(if_none_match: &str, etag: &str) -> bool {
    let bare = |tag: &str| tag.trim().trim_start_matches("W/").to_owned();
    let ours = bare(etag);
    if_none_match.split(',').any(|tag| tag.trim() == "*" || bare(tag) == ours)
}

fn ms(value: i64) -> Duration {
    Duration::from_millis(value.max(0) as u64)
}

fn gzip(raw: &[u8]) -> Option<Vec<u8>> {
    let out = Vec::with_capacity(raw.len() / 3 + 64);
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

    const CSV: &[u8] = b"OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION,ECCENTRICITY,INCLINATION,RA_OF_ASC_NODE,ARG_OF_PERICENTER,MEAN_ANOMALY,EPHEMERIS_TYPE,CLASSIFICATION_TYPE,NORAD_CAT_ID,ELEMENT_SET_NO,REV_AT_EPOCH,BSTAR,MEAN_MOTION_DOT,MEAN_MOTION_DDOT\r\n\
ISS (ZARYA),1998-067A,2026-11-14T04:10:44.607360,15.49541553,.00038573,51.6315,301.8926,64.2513,295.8899,0,U,25544,999,54121,.16935744E-3,.9139E-4,0\r\n";

    #[test]
    fn only_listed_groups_are_served() {
        assert_eq!(Group::parse("active.csv").map(Group::name), Some("active"));
        assert_eq!(Group::parse("stations.csv").map(Group::name), Some("stations"));
        for file in
            ["active", "starlink.csv", "ACTIVE.csv", "active.json", "active.csv.gz", "", ".csv", "../active.csv"]
        {
            assert_eq!(Group::parse(file), None, "{file:?}");
        }
    }

    #[test]
    fn omm_csv_is_told_apart_from_error_pages() {
        assert!(is_omm_csv(CSV));
        assert!(is_omm_csv(&[b"\xef\xbb\xbf".as_slice(), CSV].concat()), "a byte order mark");
        let header_only = &CSV[..CSV.iter().position(|b| *b == b'\n').unwrap() + 1];
        assert!(!is_omm_csv(header_only), "a header with no objects");
        for body in [&b"No GP data found"[..], b"<html>Maintenance</html>", b"", b"OBJECT_NAME,EPOCH\nX,2026\n"] {
            assert!(!is_omm_csv(body), "{:?}", String::from_utf8_lossy(body));
        }
    }

    #[test]
    fn entity_tags_follow_the_content_and_compare_weakly() {
        let tag = etag_of(CSV);
        assert!(tag.starts_with("W/\"") && tag.ends_with('"'), "{tag}");
        assert_eq!(tag, etag_of(CSV));
        assert_ne!(tag, etag_of(&CSV[..CSV.len() - 2]));
        assert!(matches_etag(&tag, &tag));
        assert!(matches_etag(tag.trim_start_matches("W/"), &tag), "a strong form of the same tag");
        assert!(matches_etag(&format!("\"other\", {tag}"), &tag));
        assert!(matches_etag("*", &tag));
        assert!(!matches_etag("\"other\"", &tag));
        assert!(!matches_etag("", &tag));
    }

    #[test]
    fn clients_hold_a_copy_until_a_newer_one_could_exist() {
        let served = |age_s: u64, next_s: u64| Served {
            gzip: Bytes::new(),
            raw_len: 0,
            etag: String::new(),
            age: Duration::from_secs(age_s),
            next_refresh_in: Duration::from_secs(next_s),
            cache: CacheState::Hit,
        };
        // Fresh: an hour on top of its age, which caches count against max-age.
        assert_eq!(served(10, 7190).max_age(), Duration::from_secs(10 + 3600));
        assert_eq!(served(6600, 600).max_age(), Duration::from_secs(6600 + 600));
        // Due for a refresh now: a minute, so a client comes back soon but not in a loop.
        assert_eq!(served(9000, 0).max_age(), Duration::from_secs(9000 + 60));
    }

    #[test]
    fn failures_have_plain_messages() {
        for failure in
            [Failure::Off, Failure::Refused(403), Failure::Refused(503), Failure::Unreachable, Failure::BadData]
        {
            let message = failure.message();
            assert!(message.ends_with('.') && message.len() > 20, "{message}");
            assert!(failure.note().ends_with('.'));
        }
        assert!(Failure::Refused(403).message().contains("HTTP 403"));
    }

    #[test]
    fn compression_round_trips() {
        let packed = gzip(CSV).unwrap();
        assert_eq!(gunzip(&packed, CSV.len()).unwrap(), CSV);
    }
}
