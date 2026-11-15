//! Request allowances for the polled aircraft feeds.
//!
//! Two limits apply to a feed: a minimum spacing between requests and, for
//! adsb.lol, a number of requests per day. The daily one must never be
//! exceeded, whatever clients ask for and however often the gateway is
//! restarted, so it is kept as a small token bucket ([`Ledger`]):
//!
//! - the bucket holds at most a tenth of the day's allowance (the burst);
//! - it refills evenly, at the rest of the allowance per day.
//!
//! Burst plus one day's refill is exactly the allowance, so no 24-hour window,
//! wherever it starts, can hold more requests than that. Nothing is spent
//! while nobody is watching aircraft.
//!
//! The bucket is written to a state file before every request and read back
//! at start-up ([`Store`]), so a restart carries on where the last run stopped
//! instead of starting with a fresh allowance. Two gateways on one machine
//! share one allowance at the provider (it is counted per IP address), so they
//! share the file too, under a lock.

use std::fs::{self, OpenOptions};
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

const DAY_MS: i64 = 86_400_000;
const HOUR_MS: i64 = 3_600_000;
const STATE_VERSION: u8 = 1;
/// The bucket holds one part in this many of the day's allowance.
const BURST_SHARE: u32 = 10;
/// A `Retry-After` this long means "come back tomorrow", not "ease off".
const QUOTA_RETRY_AFTER_S: u64 = 900;
/// However hard a provider pushes back, try again at least this often.
const SLOWEST_INTERVAL: Duration = Duration::from_secs(120);
/// Calm requests before the spacing is relaxed one step back towards the configured value.
const CALM_BEFORE_RELAXING: u32 = 100;
/// How long to wait for another process to let go of the state file.
const LOCK_TRIES: u32 = 40;
const LOCK_RETRY: Duration = Duration::from_millis(5);

/// A moment on both clocks: the monotonic one for spacing requests, the wall
/// clock for the daily allowance (which has to survive a restart).
#[derive(Debug, Clone, Copy)]
pub struct Now {
    pub at: Instant,
    /// Unix epoch milliseconds.
    pub ms: i64,
}

impl Now {
    pub fn real() -> Now {
        Now { at: Instant::now(), ms: crate::model::now_ms() }
    }
}

/// What the budget says about sending a request now.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Allowance {
    /// Send now.
    Go,
    /// Too soon after the last request: ask again after this long.
    Wait(Duration),
    /// Nobody is watching, and a daily allowance is not spent on nobody.
    Idle,
    /// The daily allowance is used up for now; the next request may go after this long.
    Exhausted(Duration),
}

/// The daily allowance as a token bucket. Pure arithmetic on the time it is
/// given, so it can be tested with a simulated clock.
#[derive(Debug, Clone, PartialEq)]
pub struct Ledger {
    per_day: u32,
    burst: u32,
    tokens: f64,
    /// UTC day number `spent_today` counts.
    day: i64,
    spent_today: u32,
    updated_ms: i64,
    /// The provider said the allowance is gone until then.
    blocked_until_ms: i64,
}

/// A [`Ledger`] as written to the state file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    v: u8,
    per_day: u32,
    day: i64,
    spent_today: u32,
    tokens: f64,
    updated_ms: i64,
    #[serde(default)]
    blocked_until_ms: i64,
}

impl Ledger {
    /// A first run: the burst is available at once.
    pub fn new(per_day: u32, now_ms: i64) -> Ledger {
        // Below two a day there is no room for both a burst and a refill.
        let per_day = per_day.max(2);
        let burst = (per_day / BURST_SHARE).clamp(1, per_day - 1);
        Ledger {
            per_day,
            burst,
            tokens: f64::from(burst),
            day: now_ms.div_euclid(DAY_MS),
            spent_today: 0,
            updated_ms: now_ms,
            blocked_until_ms: 0,
        }
    }

    /// Nothing is known about earlier spending: start empty and let it refill.
    pub fn empty(per_day: u32, now_ms: i64) -> Ledger {
        Ledger { tokens: 0.0, ..Ledger::new(per_day, now_ms) }
    }

    /// Carry on from a saved state. A changed allowance keeps what was spent
    /// and never grants more than the new burst.
    pub fn restore(saved: &Saved, per_day: u32, now_ms: i64) -> Ledger {
        let mut ledger = Ledger::empty(per_day, now_ms);
        if saved.tokens.is_finite() {
            ledger.tokens = saved.tokens.clamp(0.0, f64::from(ledger.burst));
        }
        // A stamp from the future (the clock was set back since) earns nothing.
        ledger.updated_ms = saved.updated_ms.min(now_ms);
        ledger.day = saved.day;
        ledger.spent_today = saved.spent_today;
        ledger.blocked_until_ms = saved.blocked_until_ms.min(now_ms + DAY_MS);
        ledger.refill(now_ms);
        ledger
    }

    pub fn saved(&self) -> Saved {
        Saved {
            v: STATE_VERSION,
            per_day: self.per_day,
            day: self.day,
            spent_today: self.spent_today,
            tokens: self.tokens,
            updated_ms: self.updated_ms,
            blocked_until_ms: self.blocked_until_ms,
        }
    }

    fn tokens_per_ms(&self) -> f64 {
        f64::from(self.per_day - self.burst) / DAY_MS as f64
    }

    fn refill(&mut self, now_ms: i64) {
        if now_ms >= self.updated_ms {
            let earned = (now_ms - self.updated_ms) as f64 * self.tokens_per_ms();
            self.tokens = (self.tokens + earned).min(f64::from(self.burst));
            self.updated_ms = now_ms;
        } else if self.updated_ms - now_ms > HOUR_MS {
            // The clock was set back a long way: count from the new time.
            // After a small step back, time already counted earns nothing twice.
            self.updated_ms = now_ms;
        }
        let day = now_ms.div_euclid(DAY_MS);
        if day != self.day {
            self.day = day;
            self.spent_today = 0;
        }
    }

    /// Milliseconds until a request may be sent; 0 means now.
    pub fn wait_ms(&mut self, now_ms: i64) -> i64 {
        self.refill(now_ms);
        let mut wait = (self.blocked_until_ms - now_ms).max(0);
        if self.tokens < 1.0 {
            wait = wait.max(((1.0 - self.tokens) / self.tokens_per_ms()).ceil() as i64);
        }
        // Implied by the bucket; kept as a second guard that is easy to reason about.
        if self.spent_today >= self.per_day {
            wait = wait.max((self.day + 1) * DAY_MS - now_ms);
        }
        wait
    }

    /// Take one request out of the allowance. False when none is available.
    pub fn spend(&mut self, now_ms: i64) -> bool {
        if self.wait_ms(now_ms) > 0 {
            return false;
        }
        self.tokens -= 1.0;
        self.spent_today += 1;
        true
    }

    /// The provider says the allowance is gone until `until_ms`, whatever this ledger counted.
    pub fn block_until(&mut self, until_ms: i64, now_ms: i64) {
        self.refill(now_ms);
        self.tokens = 0.0;
        self.blocked_until_ms = self.blocked_until_ms.max(until_ms.min(now_ms + DAY_MS));
    }

    /// Take on whatever a saved state knows that is worse than what this
    /// ledger believes: another process may have spent from the same allowance.
    fn absorb(&mut self, saved: &Saved, now_ms: i64) {
        let theirs = Ledger::restore(saved, self.per_day, now_ms);
        self.refill(now_ms);
        self.tokens = self.tokens.min(theirs.tokens);
        if theirs.day == self.day {
            self.spent_today = self.spent_today.max(theirs.spent_today);
        }
        self.blocked_until_ms = self.blocked_until_ms.max(theirs.blocked_until_ms);
    }

    pub fn per_day(&self) -> u32 {
        self.per_day
    }

    pub fn burst(&self) -> u32 {
        self.burst
    }

    /// Whole requests that could be sent right now.
    pub fn available(&self) -> u32 {
        if self.spent_today >= self.per_day { 0 } else { self.tokens.max(0.0).floor() as u32 }
    }

    pub fn spent_today(&self) -> u32 {
        self.spent_today
    }

    /// Seconds one request takes to come back.
    pub fn refill_every_s(&self) -> f64 {
        1.0 / (self.tokens_per_ms() * 1000.0)
    }
}

/// The state file of a daily allowance.
#[derive(Debug, Clone)]
pub struct Store {
    path: PathBuf,
}

enum Loaded {
    Missing,
    /// There is a file but it cannot be trusted.
    Unreadable,
    Found(Saved),
}

impl Store {
    pub fn new(path: PathBuf) -> Store {
        Store { path }
    }

    fn load(&self) -> Loaded {
        match fs::read(&self.path) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Loaded::Missing,
            Err(_) => Loaded::Unreadable,
            Ok(bytes) => match serde_json::from_slice::<Saved>(&bytes) {
                Ok(saved) if saved.v == STATE_VERSION => Loaded::Found(saved),
                _ => Loaded::Unreadable,
            },
        }
    }

    /// Replace the file in one step, so a crash never leaves half a state behind.
    fn save(&self, saved: &Saved) -> io::Result<()> {
        let tmp = self.path.with_extension("tmp");
        fs::write(&tmp, serde_json::to_vec(saved)?)?;
        fs::rename(&tmp, &self.path)
    }

    /// Run `work` while holding the state file's lock. Gives up with
    /// `WouldBlock` rather than wait long for a process that holds it.
    fn locked<T>(&self, work: impl FnOnce() -> io::Result<T>) -> io::Result<T> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let lock =
            OpenOptions::new().create(true).truncate(false).write(true).open(self.path.with_extension("lock"))?;
        let mut tries = 0;
        loop {
            match lock.try_lock() {
                Ok(()) => break,
                Err(fs::TryLockError::WouldBlock) if tries < LOCK_TRIES => {
                    tries += 1;
                    std::thread::sleep(LOCK_RETRY);
                }
                Err(fs::TryLockError::WouldBlock) => return Err(io::ErrorKind::WouldBlock.into()),
                Err(fs::TryLockError::Error(e)) => return Err(e),
            }
        }
        let out = work();
        let _ = lock.unlock();
        out
    }
}

/// A daily allowance kept in step with its state file.
#[derive(Debug)]
pub struct Quota {
    ledger: Ledger,
    store: Option<Store>,
    /// The state file could not be written; say so once, not on every request.
    store_failed: bool,
}

/// What `/health` and `/metrics` report about a daily allowance.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetStatus {
    /// Requests allowed in any 24 hours.
    pub per_day: u32,
    /// Most requests that can go out in quick succession.
    pub burst: u32,
    /// Requests that could go out right now.
    pub available_now: u32,
    /// Requests sent since midnight UTC, including by earlier runs.
    pub spent_today: u32,
    pub left_today: u32,
    /// Seconds one request takes to come back.
    pub refill_every_s: f64,
    /// Seconds until the next request may go; 0 when one is available.
    pub wait_s: u64,
    /// Whether the allowance survives a restart.
    pub persisted: bool,
}

impl Quota {
    /// Open an allowance of `per_day` requests. With a store, carries on from
    /// the saved state; a state that cannot be read counts as "everything
    /// spent", because nothing shows that it was not.
    pub fn open(per_day: u32, store: Option<Store>, now_ms: i64) -> Quota {
        Quota::open_with(per_day, store, now_ms, true)
    }

    /// As [`Quota::open`]; with `first_burst` false a run that finds no saved
    /// state starts empty instead of with the burst. For hosts that lose their
    /// disk on every restart: there, "no saved state" is the normal case and a
    /// burst per restart could add up to more than the day's allowance.
    pub fn open_with(per_day: u32, store: Option<Store>, now_ms: i64, first_burst: bool) -> Quota {
        // Read under the lock, so a state another gateway is replacing right
        // now is not mistaken for a missing one. Where the lock cannot be
        // taken (a read-only directory), read anyway.
        let loaded = store.as_ref().map(|store| store.locked(|| Ok(store.load())).unwrap_or_else(|_| store.load()));
        let ledger = match loaded {
            None | Some(Loaded::Missing) if first_burst => Ledger::new(per_day, now_ms),
            None | Some(Loaded::Missing) => Ledger::empty(per_day, now_ms),
            Some(Loaded::Found(saved)) => Ledger::restore(&saved, per_day, now_ms),
            Some(Loaded::Unreadable) => {
                tracing::warn!("the saved request budget could not be read; starting with an empty one");
                Ledger::empty(per_day, now_ms)
            }
        };
        Quota { ledger, store, store_failed: false }
    }

    pub fn ledger(&self) -> &Ledger {
        &self.ledger
    }

    fn store_failure(&mut self, error: &io::Error) {
        if !self.store_failed {
            self.store_failed = true;
            let path = self.store.as_ref().map(|s| s.path.display().to_string()).unwrap_or_default();
            tracing::warn!(
                %path,
                %error,
                "the request budget could not be saved; it is kept in memory, so a restart starts with a fresh burst"
            );
        }
    }

    /// Take one request out of the allowance and record it on disk before the
    /// request is sent. False when none is available, or when another process
    /// holds the state file (in which case nothing was spent).
    pub fn spend(&mut self, now_ms: i64) -> bool {
        let Some(store) = self.store.clone() else { return self.ledger.spend(now_ms) };
        let ledger = &mut self.ledger;
        let mut spent = None;
        let outcome = store.locked(|| {
            if let Loaded::Found(saved) = store.load() {
                ledger.absorb(&saved, now_ms);
            }
            let ok = ledger.spend(now_ms);
            spent = Some(ok);
            if ok { store.save(&ledger.saved()) } else { Ok(()) }
        });
        match (outcome, spent) {
            (Ok(()), spent) => {
                self.store_failed = false;
                spent.unwrap_or(false)
            }
            (Err(e), None) if e.kind() == io::ErrorKind::WouldBlock => false,
            (Err(e), spent) => {
                // A directory that cannot be written must not stop the feed.
                self.store_failure(&e);
                spent.unwrap_or_else(|| self.ledger.spend(now_ms))
            }
        }
    }

    /// The provider says the allowance is gone until `until_ms`.
    pub fn block_until(&mut self, until_ms: i64, now_ms: i64) {
        self.ledger.block_until(until_ms, now_ms);
        if let Some(store) = self.store.clone() {
            let saved = self.ledger.saved();
            if let Err(e) = store.locked(|| store.save(&saved)) {
                self.store_failure(&e);
            }
        }
    }

    pub fn status(&mut self, now_ms: i64) -> BudgetStatus {
        let wait_ms = self.ledger.wait_ms(now_ms);
        let l = &self.ledger;
        BudgetStatus {
            per_day: l.per_day,
            burst: l.burst,
            available_now: if wait_ms > 0 { 0 } else { l.available() },
            spent_today: l.spent_today,
            left_today: l.per_day.saturating_sub(l.spent_today),
            refill_every_s: (l.refill_every_s() * 10.0).round() / 10.0,
            wait_s: (wait_ms as u64).div_ceil(1000),
            persisted: self.store.is_some() && !self.store_failed,
        }
    }
}

/// A feed's request allowance: a minimum spacing and, for some providers, a
/// daily [`Quota`].
#[derive(Debug, Clone)]
pub struct Budget {
    /// Never send faster than this. Grows when the provider pushes back.
    min_interval: Duration,
    /// The spacing asked for in the configuration; `min_interval` drifts back to it.
    configured_interval: Duration,
    /// Spacing when nobody is watching and there is no daily quota to protect.
    idle_interval: Duration,
    quota: Option<Arc<Mutex<Quota>>>,
    last_request: Option<Instant>,
    /// Requests answered normally since the provider last pushed back.
    calm_streak: u32,
}

impl Budget {
    /// A plain rate limit: one request per `min_interval`, slower when idle.
    pub fn rate(min_interval: Duration, idle_interval: Duration) -> Budget {
        Budget {
            min_interval,
            configured_interval: min_interval,
            idle_interval: idle_interval.max(min_interval),
            quota: None,
            last_request: None,
            calm_streak: 0,
        }
    }

    /// A daily quota on top of a rate limit: requests go out every
    /// `min_interval` while the quota has some to give and somebody is watching.
    pub fn daily(quota: Quota, min_interval: Duration) -> Budget {
        Budget { quota: Some(Arc::new(Mutex::new(quota))), ..Budget::rate(min_interval, min_interval) }
    }

    /// The daily quota, if there is one, for `/health` and `/metrics`.
    pub fn quota(&self) -> Option<Arc<Mutex<Quota>>> {
        self.quota.clone()
    }

    /// May a request go out now? `watched` is true when some client wants this feed's data.
    pub fn check(&mut self, now: Now, watched: bool) -> Allowance {
        let interval = match &self.quota {
            None if watched => self.min_interval,
            None => self.idle_interval,
            Some(_) if !watched => return Allowance::Idle,
            Some(quota) => {
                let wait_ms = quota.lock().ledger.wait_ms(now.ms);
                if wait_ms > 0 {
                    return Allowance::Exhausted(Duration::from_millis(wait_ms as u64));
                }
                self.min_interval
            }
        };
        match self.last_request {
            Some(last) if now.at.saturating_duration_since(last) < interval => {
                Allowance::Wait(interval - now.at.saturating_duration_since(last))
            }
            _ => Allowance::Go,
        }
    }

    /// Account for a request that is about to be sent. False when the daily
    /// quota turned out to have nothing left (another process got there
    /// first): do not send.
    pub fn spend_blocking(&mut self, now: Now) -> bool {
        let spent = self.quota.as_ref().is_none_or(|quota| quota.lock().spend(now.ms));
        if spent {
            self.last_request = Some(now.at);
        }
        spent
    }

    /// [`Budget::spend_blocking`] for async callers: the state file and its
    /// lock are handled off the async workers.
    pub async fn spend(&mut self, now: Now) -> bool {
        let spent = match self.quota.clone() {
            None => true,
            Some(quota) => tokio::task::spawn_blocking(move || quota.lock().spend(now.ms)).await.unwrap_or(false),
        };
        if spent {
            self.last_request = Some(now.at);
        }
        spent
    }

    /// The provider answered 429. A long `Retry-After` means the daily quota
    /// is gone until then; a short one means a burst limit was hit, so space
    /// requests twice as far apart from now on.
    pub fn pushed_back(&mut self, now: Now, retry_after_s: Option<u64>) {
        self.calm_streak = 0;
        match (retry_after_s, &self.quota) {
            (Some(s), Some(quota)) if s >= QUOTA_RETRY_AFTER_S => {
                let until = now.ms.saturating_add(i64::try_from(s).unwrap_or(i64::MAX).saturating_mul(1000));
                quota.lock().block_until(until, now.ms);
            }
            _ => self.min_interval = (self.min_interval * 2).min(SLOWEST_INTERVAL).max(self.configured_interval),
        }
    }

    /// A request was answered normally. After a long calm stretch the spacing
    /// eases back towards the configured value, a quarter at a time.
    pub fn succeeded(&mut self) {
        self.calm_streak += 1;
        if self.calm_streak >= CALM_BEFORE_RELAXING && self.min_interval > self.configured_interval {
            self.calm_streak = 0;
            self.min_interval = self.min_interval.mul_f64(0.75).max(self.configured_interval);
        }
    }

    /// The current spacing between requests at full speed.
    pub fn interval(&self) -> Duration {
        self.min_interval
    }

    pub fn status(&self, now: Now) -> Option<BudgetStatus> {
        self.quota.as_ref().map(|quota| quota.lock().status(now.ms))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2026-11-14T00:00:00Z, a day boundary, so tests can place themselves within a UTC day.
    const MIDNIGHT: i64 = 20_771 * DAY_MS;
    const SECOND: i64 = 1000;

    /// A clock the test moves by hand.
    struct Clock {
        start: Instant,
        ms: i64,
    }

    impl Clock {
        fn at(ms: i64) -> Clock {
            Clock { start: Instant::now(), ms }
        }

        fn now(&self) -> Now {
            Now { at: self.start + Duration::from_millis((self.ms - MIDNIGHT) as u64), ms: self.ms }
        }

        fn advance(&mut self, by: Duration) {
            self.ms += by.as_millis() as i64;
        }
    }

    /// Let a watched budget run until `until_ms`, sending whenever it may.
    /// Returns when each request went out.
    fn run_watched(budget: &mut Budget, clock: &mut Clock, until_ms: i64) -> Vec<i64> {
        let mut sent = Vec::new();
        while clock.ms < until_ms {
            match budget.check(clock.now(), true) {
                Allowance::Go => {
                    if budget.spend_blocking(clock.now()) {
                        sent.push(clock.ms);
                    }
                    clock.advance(Duration::from_millis(1));
                }
                Allowance::Wait(wait) | Allowance::Exhausted(wait) => clock.advance(wait.max(Duration::from_millis(1))),
                Allowance::Idle => unreachable!("the budget is being watched"),
            }
        }
        sent
    }

    /// The most requests in any 24 hours, sliding the window over every request.
    fn busiest_day(sent: &[i64]) -> usize {
        let mut most = 0;
        let mut start = 0;
        for end in 0..sent.len() {
            while sent[end] - sent[start] >= DAY_MS {
                start += 1;
            }
            most = most.max(end - start + 1);
        }
        most
    }

    fn temp_store(name: &str) -> Store {
        let dir = std::env::temp_dir().join(format!("orya-halo-budget-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        Store::new(dir.join("budget.json"))
    }

    fn remove(store: &Store) {
        let _ = fs::remove_dir_all(store.path.parent().unwrap());
    }

    #[test]
    fn a_plain_rate_limit_spaces_requests() {
        let mut clock = Clock::at(MIDNIGHT);
        let mut budget = Budget::rate(Duration::from_millis(1100), Duration::from_millis(4400));
        assert_eq!(budget.check(clock.now(), true), Allowance::Go);
        assert!(budget.spend_blocking(clock.now()));
        clock.advance(Duration::from_millis(100));
        assert_eq!(budget.check(clock.now(), true), Allowance::Wait(Duration::from_millis(1000)));
        clock.advance(Duration::from_millis(1000));
        assert_eq!(budget.check(clock.now(), true), Allowance::Go);
        // Nobody watching: the idle spacing applies.
        assert_eq!(budget.check(clock.now(), false), Allowance::Wait(Duration::from_millis(3300)));
        assert_eq!(budget.status(clock.now()), None);
    }

    #[test]
    fn a_day_of_watching_never_exceeds_the_allowance() {
        // Start mid-afternoon, so calendar days and 24-hour windows disagree.
        let mut clock = Clock::at(MIDNIGHT + 15 * HOUR_MS);
        let quota = Quota::open(500, None, clock.ms);
        let mut budget = Budget::daily(quota, Duration::from_secs(10));
        let sent = run_watched(&mut budget, &mut clock, MIDNIGHT + 15 * HOUR_MS + 7 * DAY_MS);

        assert!(busiest_day(&sent) <= 500, "{} requests in some 24 hours", busiest_day(&sent));
        for day in 0..8 {
            let from = MIDNIGHT + day * DAY_MS;
            let in_day = sent.iter().filter(|t| (from..from + DAY_MS).contains(*t)).count();
            assert!(in_day <= 500, "{in_day} requests on UTC day {day}");
        }
        // And it is used, not hoarded: the burst once, then the refill, every day.
        assert!((50 + 450 * 7 - 2..=50 + 450 * 7).contains(&sent.len()), "{} in a week of watching", sent.len());
        assert!(busiest_day(&sent) >= 495);
    }

    #[test]
    fn the_burst_is_small_and_the_rest_is_spread_over_the_day() {
        let mut clock = Clock::at(MIDNIGHT);
        let quota = Quota::open(500, None, clock.ms);
        let mut budget = Budget::daily(quota, Duration::from_secs(10));
        let sent = run_watched(&mut budget, &mut clock, MIDNIGHT + DAY_MS);

        // The burst goes out at the configured spacing: about ten seconds apart...
        let burst: Vec<i64> = sent.windows(2).take(49).map(|w| w[1] - w[0]).collect();
        assert!(burst.iter().all(|gap| (10 * SECOND..11 * SECOND).contains(gap)), "{burst:?}");
        // ...then one request each time the bucket earns one: every 192 seconds, all day.
        let steady: Vec<i64> = sent.windows(2).skip(60).map(|w| w[1] - w[0]).collect();
        assert!(steady.len() > 400);
        assert!(steady.iter().all(|gap| (190 * SECOND..194 * SECOND).contains(gap)), "{steady:?}");
        assert_eq!(budget.status(clock.now()).unwrap().refill_every_s, 192.0);
    }

    #[test]
    fn nothing_is_spent_while_nobody_is_watching() {
        let mut clock = Clock::at(MIDNIGHT);
        let quota = Quota::open(500, None, clock.ms);
        let mut budget = Budget::daily(quota, Duration::from_secs(10));
        for _ in 0..DAY_MS / (10 * SECOND) {
            assert_eq!(budget.check(clock.now(), false), Allowance::Idle);
            clock.advance(Duration::from_secs(10));
        }
        let status = budget.status(clock.now()).unwrap();
        assert_eq!((status.spent_today, status.available_now), (0, 50));
        // The first viewer gets the burst straight away.
        assert_eq!(budget.check(clock.now(), true), Allowance::Go);
    }

    #[test]
    fn an_emptied_bucket_refills_while_idle_but_never_past_the_burst() {
        let mut clock = Clock::at(MIDNIGHT);
        let mut ledger = Ledger::new(500, clock.ms);
        for _ in 0..50 {
            assert!(ledger.spend(clock.ms));
        }
        assert!(!ledger.spend(clock.ms));
        assert!((192 * SECOND..=192 * SECOND + 1).contains(&ledger.wait_ms(clock.ms)));
        clock.advance(Duration::from_secs(192 * 10 + 1));
        ledger.wait_ms(clock.ms);
        assert_eq!(ledger.available(), 10);
        // A week of silence is still worth one burst, not a week of requests.
        clock.advance(Duration::from_secs(7 * 86_400));
        ledger.wait_ms(clock.ms);
        assert_eq!(ledger.available(), 50);
    }

    #[test]
    fn a_restart_resumes_the_remaining_budget() {
        let store = temp_store("restart");
        let mut clock = Clock::at(MIDNIGHT + 9 * HOUR_MS);
        let mut first = Quota::open(500, Some(store.clone()), clock.ms);
        for _ in 0..30 {
            assert!(first.spend(clock.ms));
        }
        assert_eq!(first.status(clock.ms).available_now, 20);
        drop(first);

        // Restarted at once: twenty left, not a fresh fifty.
        let mut second = Quota::open(500, Some(store.clone()), clock.ms);
        let status = second.status(clock.ms);
        assert_eq!((status.available_now, status.spent_today, status.left_today), (20, 30, 470));
        assert!(status.persisted);
        for _ in 0..20 {
            assert!(second.spend(clock.ms));
        }
        assert!(!second.spend(clock.ms));
        drop(second);

        // Restarted later: the time the gateway was down has refilled the bucket, at the usual rate.
        clock.advance(Duration::from_secs(192 * 5 + 1));
        let mut third = Quota::open(500, Some(store.clone()), clock.ms);
        let status = third.status(clock.ms);
        assert_eq!((status.available_now, status.spent_today), (5, 50));
        remove(&store);
    }

    #[test]
    fn restarting_all_day_cannot_exceed_the_allowance() {
        let store = temp_store("restart-loop");
        let start = MIDNIGHT + 6 * HOUR_MS;
        let mut clock = Clock::at(start);
        let mut sent = Vec::new();
        // A developer restarts the gateway every ten minutes for two days, with a viewer connected throughout.
        while clock.ms < start + 2 * DAY_MS {
            let quota = Quota::open(500, Some(store.clone()), clock.ms);
            let mut budget = Budget::daily(quota, Duration::from_secs(10));
            let until = clock.ms + 600 * SECOND;
            sent.extend(run_watched(&mut budget, &mut clock, until));
        }
        assert!(busiest_day(&sent) <= 500, "{} requests in some 24 hours", busiest_day(&sent));
        assert!(sent.len() >= 900, "{}: restarts must not lose the allowance either", sent.len());
        remove(&store);
    }

    #[test]
    fn a_host_that_wipes_its_disk_stays_under_the_allowance_when_starts_are_empty() {
        // A free host that sleeps after 15 minutes idle and loses its files each
        // time: no state survives, so every start must begin with nothing to spend.
        let mut clock = Clock::at(MIDNIGHT);
        let start = clock.ms;
        let mut sent = Vec::new();
        while clock.ms < start + 2 * DAY_MS {
            let quota = Quota::open_with(500, None, clock.ms, false);
            assert_eq!(quota.ledger().available(), 0, "a cold start has nothing to spend");
            let mut budget = Budget::daily(quota, Duration::from_secs(10));
            let until = clock.ms + 900 * SECOND;
            sent.extend(run_watched(&mut budget, &mut clock, until));
        }
        assert!(busiest_day(&sent) <= 500, "{} requests in some 24 hours", busiest_day(&sent));
        // The refill still flows while someone watches: aircraft keep updating.
        assert!(sent.len() >= 600, "only {} requests in two days", sent.len());
    }

    #[test]
    fn without_a_state_file_every_start_is_a_first_run() {
        // This is why persistence is on by default: with it off, each restart has a burst to spend.
        let clock = Clock::at(MIDNIGHT);
        let mut first = Quota::open(500, None, clock.ms);
        for _ in 0..50 {
            assert!(first.spend(clock.ms));
        }
        let mut second = Quota::open(500, None, clock.ms);
        assert_eq!(second.status(clock.ms).available_now, 50);
        assert!(!second.status(clock.ms).persisted);
    }

    #[test]
    fn the_day_count_starts_again_at_midnight_utc_without_a_fresh_burst() {
        let store = temp_store("rollover");
        let mut clock = Clock::at(MIDNIGHT + 23 * HOUR_MS + 50 * 60 * SECOND);
        let mut quota = Quota::open(500, Some(store.clone()), clock.ms);
        for _ in 0..50 {
            assert!(quota.spend(clock.ms));
        }
        assert_eq!(quota.status(clock.ms).spent_today, 50);

        // Twenty minutes later it is tomorrow: the count is zero, the bucket has only what it earned.
        clock.advance(Duration::from_secs(20 * 60));
        let status = quota.status(clock.ms);
        assert_eq!((status.spent_today, status.left_today), (0, 500));
        assert_eq!(status.available_now, 6, "twenty minutes at one request per 192 seconds");

        // The same across a restart that spans midnight.
        drop(quota);
        let mut restarted = Quota::open(500, Some(store.clone()), clock.ms);
        let status = restarted.status(clock.ms);
        assert_eq!((status.spent_today, status.available_now), (0, 6));
        remove(&store);
    }

    #[test]
    fn the_day_count_is_a_hard_stop_of_its_own() {
        // Cannot happen through the bucket; a state file edited by hand could say so.
        let now = MIDNIGHT + 12 * HOUR_MS;
        let saved = Saved {
            v: 1,
            per_day: 500,
            day: MIDNIGHT / DAY_MS,
            spent_today: 500,
            tokens: 50.0,
            updated_ms: now,
            blocked_until_ms: 0,
        };
        let mut ledger = Ledger::restore(&saved, 500, now);
        assert!(!ledger.spend(now));
        assert_eq!(ledger.available(), 0);
        assert_eq!(ledger.wait_ms(now), 12 * HOUR_MS, "until midnight UTC");
        assert!(ledger.spend(MIDNIGHT + DAY_MS));
    }

    #[test]
    fn the_provider_can_declare_the_allowance_gone_and_it_comes_back_by_itself() {
        let store = temp_store("blocked");
        let mut clock = Clock::at(MIDNIGHT + HOUR_MS);
        let quota = Quota::open(500, Some(store.clone()), clock.ms);
        let mut budget = Budget::daily(quota, Duration::from_secs(10));
        assert!(budget.spend_blocking(clock.now()));

        // A short Retry-After is a burst limit: the allowance is untouched, the spacing doubles.
        budget.pushed_back(clock.now(), Some(7));
        assert_eq!(budget.status(clock.now()).unwrap().available_now, 49);
        assert_eq!(budget.interval(), Duration::from_secs(20));
        clock.advance(Duration::from_secs(1));
        assert_eq!(budget.check(clock.now(), true), Allowance::Wait(Duration::from_secs(19)));
        // Repeated push-back keeps doubling, up to two minutes; a long calm stretch eases it back.
        for _ in 0..10 {
            budget.pushed_back(clock.now(), None);
        }
        assert_eq!(budget.interval(), Duration::from_secs(120));
        for _ in 0..2000 {
            budget.succeeded();
        }
        assert_eq!(budget.interval(), Duration::from_secs(10));

        // A long one is the daily quota: nothing goes out until then, whatever the bucket held.
        budget.pushed_back(clock.now(), Some(3600));
        assert_eq!(budget.check(clock.now(), true), Allowance::Exhausted(Duration::from_secs(3600)));
        let status = budget.status(clock.now()).unwrap();
        assert_eq!((status.available_now, status.wait_s), (0, 3600));

        // A restart does not forget that.
        let mut restarted = Quota::open(500, Some(store.clone()), clock.ms + 60 * SECOND);
        assert!(!restarted.spend(clock.ms + 60 * SECOND));
        assert_eq!(restarted.status(clock.ms + 60 * SECOND).wait_s, 3540);

        // An hour later it resumes with what the bucket earned meanwhile.
        clock.advance(Duration::from_secs(3600));
        assert_eq!(budget.check(clock.now(), true), Allowance::Go);
        assert_eq!(budget.status(clock.now()).unwrap().available_now, 18);
        remove(&store);
    }

    #[test]
    fn two_gateways_sharing_a_state_file_share_one_allowance() {
        let store = temp_store("shared");
        let clock = Clock::at(MIDNIGHT + HOUR_MS);
        let mut a = Quota::open(500, Some(store.clone()), clock.ms);
        let mut b = Quota::open(500, Some(store.clone()), clock.ms);
        let mut sent = 0;
        for _ in 0..40 {
            sent += u32::from(a.spend(clock.ms));
            sent += u32::from(b.spend(clock.ms));
        }
        assert_eq!(sent, 50, "one burst between them, not one each");
        assert_eq!(a.status(clock.ms).available_now, 0);
        remove(&store);
    }

    #[test]
    fn a_state_file_that_cannot_be_trusted_counts_as_everything_spent() {
        let store = temp_store("corrupt");
        fs::create_dir_all(store.path.parent().unwrap()).unwrap();
        for junk in ["not json", "{\"v\":9,\"perDay\":500}", ""] {
            fs::write(&store.path, junk).unwrap();
            let mut quota = Quota::open(500, Some(store.clone()), MIDNIGHT);
            assert_eq!(quota.status(MIDNIGHT).available_now, 0, "{junk:?}");
            assert!(!quota.spend(MIDNIGHT));
        }
        // It refills from there and the next save replaces the bad file.
        let mut quota = Quota::open(500, Some(store.clone()), MIDNIGHT);
        assert!(quota.spend(MIDNIGHT + 193 * SECOND));
        assert!(matches!(store.load(), Loaded::Found(_)));

        // Absurd numbers in an otherwise valid file are clamped, not believed.
        let wild =
            "{\"v\":1,\"perDay\":500,\"day\":0,\"spentToday\":0,\"tokens\":1e9,\"updatedMs\":0,\"blockedUntilMs\":0}";
        fs::write(&store.path, wild).unwrap();
        assert_eq!(Quota::open(500, Some(store.clone()), MIDNIGHT).status(MIDNIGHT).available_now, 50);
        remove(&store);
    }

    #[test]
    fn a_directory_that_cannot_be_written_does_not_stop_the_feed() {
        // The "directory" is a file, so nothing can be created under it.
        let blocker = std::env::temp_dir().join(format!("orya-halo-budget-test-{}-blocker", std::process::id()));
        fs::write(&blocker, "x").unwrap();
        let mut quota = Quota::open(500, Some(Store::new(blocker.join("budget.json"))), MIDNIGHT);
        // An hour in there is something to spend, however the missing file was read at start-up.
        assert!(quota.spend(MIDNIGHT + HOUR_MS));
        let status = quota.status(MIDNIGHT + HOUR_MS);
        assert!(status.available_now > 0 && status.spent_today == 1 && !status.persisted, "{status:?}");
        let _ = fs::remove_file(&blocker);
    }

    #[test]
    fn a_changed_allowance_keeps_what_was_spent() {
        let store = temp_store("changed");
        let now = MIDNIGHT + HOUR_MS;
        let mut keyless = Quota::open(500, Some(store.clone()), now);
        for _ in 0..40 {
            assert!(keyless.spend(now));
        }
        // A key is added: 1,000 a day. The ten requests left carry over; the larger burst is earned, not granted.
        let mut keyed = Quota::open(1000, Some(store.clone()), now);
        let status = keyed.status(now);
        assert_eq!((status.per_day, status.burst, status.available_now, status.spent_today), (1000, 100, 10, 40));
        assert_eq!(status.refill_every_s, 96.0);
        // And back: a bucket fuller than the smaller burst is cut down to it.
        let mut keyed = Quota::open(7200, Some(store.clone()), now + DAY_MS);
        assert!(keyed.spend(now + DAY_MS));
        assert_eq!(Quota::open(500, Some(store.clone()), now + DAY_MS).status(now + DAY_MS).available_now, 50);
        remove(&store);
    }

    #[test]
    fn a_clock_set_back_earns_nothing_twice() {
        let mut ledger = Ledger::empty(500, MIDNIGHT + HOUR_MS);
        // Ten minutes pass, then the clock steps back five and runs forward again.
        ledger.wait_ms(MIDNIGHT + HOUR_MS + 600 * SECOND);
        assert_eq!(ledger.available(), 3);
        ledger.wait_ms(MIDNIGHT + HOUR_MS + 300 * SECOND);
        ledger.wait_ms(MIDNIGHT + HOUR_MS + 600 * SECOND);
        assert_eq!(ledger.available(), 3, "the five minutes are not counted again");
        // After a correction of days the ledger follows the new clock rather than freezing.
        ledger.wait_ms(MIDNIGHT - 3 * DAY_MS);
        ledger.wait_ms(MIDNIGHT - 3 * DAY_MS + 193 * SECOND);
        assert_eq!(ledger.available(), 4);
    }

    #[test]
    fn tiny_allowances_still_work() {
        for per_day in [0, 1, 2, 9, 10, 19] {
            let mut ledger = Ledger::new(per_day, MIDNIGHT);
            assert!(ledger.burst() >= 1 && ledger.burst() < ledger.per_day(), "{per_day}");
            assert!(ledger.spend(MIDNIGHT));
            assert!(ledger.refill_every_s().is_finite());
        }
    }
}
