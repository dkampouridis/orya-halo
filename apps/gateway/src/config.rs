//! Configuration from the environment. Every variable is documented in
//! `.env.example`; defaults are chosen so `cargo run` works with no setup.

use std::fmt;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use crate::model::Kind;

/// A key that must never reach a log line or an error message: `Debug`
/// prints a placeholder, and reading the value takes an explicit call.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Secret {
        Secret(value.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(redacted)")
    }
}

/// Per-kind limits for the in-memory world state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KindLimits {
    /// Drop an entity this long after its last report.
    pub ttl_ms: i64,
    /// Upper bound for the longer lifetimes slow-sweeping sources ask for.
    pub max_ttl_ms: i64,
    /// Flag a position as stale once it is this old.
    pub stale_ms: i64,
    /// Most entities kept; the oldest are evicted beyond this.
    pub max_entities: usize,
    /// Points kept in each entity's recent track.
    pub track_points: usize,
    /// Minimum spacing between recorded track points.
    pub track_interval_ms: i64,
    /// Re-send an otherwise unchanged fix once its time has advanced this far,
    /// so clients never hold a fix time older than this for a live entity.
    pub refresh_ms: i64,
}

/// Which origins may use the HTTP API and open a stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AllowedOrigins {
    /// Any `http://localhost`, `http://127.0.0.1` or `http://[::1]` origin, any port.
    LocalDev,
    Any,
    List(Vec<String>),
}

impl AllowedOrigins {
    pub fn allows(&self, origin: &str) -> bool {
        match self {
            AllowedOrigins::Any => true,
            AllowedOrigins::List(list) => list.iter().any(|o| o.eq_ignore_ascii_case(origin)),
            AllowedOrigins::LocalDev => is_local_origin(origin),
        }
    }
}

fn is_local_origin(origin: &str) -> bool {
    let Some(rest) = origin.strip_prefix("http://").or_else(|| origin.strip_prefix("https://")) else {
        return false;
    };
    let host = match rest.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or(""),
        None => rest.split(':').next().unwrap_or(""),
    };
    matches!(host, "localhost" | "127.0.0.1" | "::1") || host.ends_with(".localhost")
}

/// Synthetic traffic instead of real upstreams.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MockConfig {
    pub aircraft: u32,
    pub ships: u32,
}

impl MockConfig {
    pub const DEFAULT: MockConfig = MockConfig { aircraft: 20_000, ships: 50_000 };

    /// Parse `aircraft:20000,ships:50000`. `1`, `true` or an empty value mean the defaults.
    pub fn parse(spec: &str) -> Result<MockConfig, String> {
        let spec = spec.trim();
        if spec.is_empty() || spec == "1" || spec.eq_ignore_ascii_case("true") {
            return Ok(MockConfig::DEFAULT);
        }
        let mut mock = MockConfig { aircraft: 0, ships: 0 };
        for part in spec.split(',') {
            let (name, count) =
                part.split_once(':').ok_or_else(|| format!("MOCK: expected name:count, got \"{part}\""))?;
            let count: u32 = count.trim().parse().map_err(|_| format!("MOCK: \"{}\" is not a count", count.trim()))?;
            match name.trim() {
                "aircraft" => mock.aircraft = count,
                "ships" => mock.ships = count,
                other => return Err(format!("MOCK: unknown layer \"{other}\" (use aircraft or ships)")),
            }
        }
        Ok(mock)
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub bind: SocketAddr,
    pub allowed_origins: AllowedOrigins,
    /// Believe `Fly-Client-IP` / `X-Forwarded-For` for per-IP limits. Only behind a proxy you control.
    pub trust_proxy: bool,
    /// Behind a trusted proxy, the header that carries the visitor's address
    /// (lower case). `X-Forwarded-For` is the fallback when it is absent.
    pub client_ip_header: String,

    pub tick_ms: u32,
    /// How often each entity is re-sent to whole-world subscribers.
    pub world_cadence_ms: u32,
    pub density_interval_ms: u32,
    pub density_res: u8,
    pub stats_interval_ms: u32,
    pub max_cells: u32,

    pub max_clients: usize,
    pub max_clients_per_ip: usize,
    pub idle_timeout_s: u64,
    pub ping_interval_s: u64,
    pub max_message_bytes: usize,
    /// Outbound frames queued per client before deltas are dropped.
    pub client_queue: usize,
    /// Client text messages accepted per 10 seconds.
    pub max_messages_per_10s: u32,

    /// Bodies at least this large are deflated for `?z=1` connections.
    pub compress_min_bytes: usize,
    pub compress_level: u32,

    pub aircraft: KindLimits,
    pub ships: KindLimits,

    pub mock: Option<MockConfig>,
    /// Source ids to run; empty means every source that can run with the keys present.
    pub upstreams: Vec<String>,
    pub user_agent: String,

    pub adsblol_api_key: Option<String>,
    pub adsblol_daily_quota: u32,
    pub adsblol_min_interval_ms: u64,
    /// Where the adsb.lol request budget is kept between runs; `None` keeps it in memory only.
    pub adsblol_budget_file: Option<PathBuf>,
    /// Whether a first run, with no saved budget, may spend the burst at once.
    /// Off on hosts whose disk is wiped on every restart: each restart then
    /// starts empty, so restarts can never add up to more than the allowance.
    pub adsblol_first_burst: bool,
    pub adsblol_reapi_url: String,
    pub adsblol_reapi_interval_s: u64,
    pub adsbfi_min_interval_ms: u64,
    pub aircraft_hot_interval_s: u64,
    pub aircraft_background_interval_s: u64,
    pub aircraft_tile_radius_nm: u32,

    pub aisstream_api_key: Option<String>,
    pub aisstream_url: String,
    pub digitraffic_user: String,
    pub digitraffic_mqtt_url: String,
    pub digitraffic_rest_url: String,

    pub routes_enabled: bool,

    /// NASA FIRMS map key for the wildfire proxy.
    pub firms_map_key: Option<Secret>,
    /// Where FIRMS is reached. Tests point this at a local stub.
    pub firms_base_url: String,
    /// How long a fetched fire file is served before FIRMS is asked again.
    pub firms_cache_ttl: Duration,
    /// Largest fire file accepted from FIRMS, bytes.
    pub firms_max_bytes: usize,

    /// Where CelesTrak is reached. Tests point this at a local stub.
    pub celestrak_base_url: String,
    /// How long a copy of a GP group is served before CelesTrak is asked
    /// again, and the least time between two requests for it. Two hours or more.
    pub celestrak_refresh: Duration,
    /// How long an old copy may stand in while CelesTrak refuses or cannot be reached.
    pub celestrak_max_stale: Duration,
    /// Largest GP file accepted from CelesTrak, bytes.
    pub celestrak_max_bytes: usize,
    /// Where the last good copies and the time of the last request are kept
    /// between runs; `None` keeps them in memory only.
    pub celestrak_cache_dir: Option<PathBuf>,

    pub log_json: bool,
}

impl Config {
    pub fn limits(&self, kind: Kind) -> &KindLimits {
        match kind {
            Kind::Aircraft => &self.aircraft,
            Kind::Ship => &self.ships,
        }
    }

    /// Ticks between two sends of the same entity to a whole-world subscriber.
    pub fn world_cadence_ticks(&self) -> u32 {
        (self.world_cadence_ms / self.tick_ms.max(1)).max(1)
    }

    /// Read the process environment.
    pub fn from_env() -> Result<Config, String> {
        Config::from_lookup(|key| std::env::var(key).ok())
    }

    /// Build a configuration from any key/value source. Unset and empty values use the default.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Config, String> {
        let get = |key: &str| lookup(key).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
        fn num<T: std::str::FromStr>(key: &str, value: Option<String>, default: T) -> Result<T, String> {
            match value {
                None => Ok(default),
                Some(v) => v.parse().map_err(|_| format!("{key}: \"{v}\" is not a valid number")),
            }
        }
        fn flag(key: &str, value: Option<String>, default: bool) -> Result<bool, String> {
            match value.as_deref().map(str::to_ascii_lowercase).as_deref() {
                None => Ok(default),
                Some("1" | "true" | "yes" | "on") => Ok(true),
                Some("0" | "false" | "no" | "off") => Ok(false),
                Some(v) => Err(format!("{key}: \"{v}\" is not true or false")),
            }
        }
        macro_rules! n {
            ($key:literal, $default:expr) => {
                num($key, get($key), $default)?
            };
        }
        macro_rules! b {
            ($key:literal, $default:expr) => {
                flag($key, get($key), $default)?
            };
        }

        let mut bind: SocketAddr = match get("BIND_ADDR") {
            Some(v) => v.parse().map_err(|_| format!("BIND_ADDR: \"{v}\" is not an address like 0.0.0.0:8787"))?,
            None => SocketAddr::from(([0, 0, 0, 0], 8787)),
        };
        if let Some(port) = get("PORT") {
            bind.set_port(port.parse().map_err(|_| format!("PORT: \"{port}\" is not a port number"))?);
        }

        let allowed_origins = match get("ALLOWED_ORIGINS").as_deref() {
            None => AllowedOrigins::LocalDev,
            Some("*") => AllowedOrigins::Any,
            Some(list) => AllowedOrigins::List(
                list.split(',').map(|o| o.trim().trim_end_matches('/').to_owned()).filter(|o| !o.is_empty()).collect(),
            ),
        };

        let mock = match get("MOCK") {
            Some(spec) if spec != "0" && !spec.eq_ignore_ascii_case("false") => Some(MockConfig::parse(&spec)?),
            _ => None,
        };

        let tick_ms: u32 = n!("TICK_MS", 1000);
        if !(50..=60_000).contains(&tick_ms) {
            return Err(format!("TICK_MS: {tick_ms} is out of range (50 to 60000)"));
        }
        let density_res: u8 = n!("DENSITY_RES", 2);
        if !(1..=3).contains(&density_res) {
            return Err(format!("DENSITY_RES: {density_res} is out of range (1 to 3)"));
        }
        let adsblol_api_key = get("ADSBLOL_API_KEY");
        // Documented free tiers: 500 requests a day without a key, 1000 with an ad-hoc key.
        let default_quota = if adsblol_api_key.is_some() { 1000 } else { 500 };
        // Unkeyed requests also hit an undocumented burst limit: a live test
        // on 2026-11-14 was refused at the sixth request in thirty seconds.
        // Ten seconds apart stays well under it; keyed tiers allow far more.
        let default_adsblol_interval = if adsblol_api_key.is_some() { 2000u64 } else { 10_000 };
        let adsblol_daily_quota: u32 = n!("ADSBLOL_DAILY_QUOTA", default_quota);
        if !(10..=1_000_000).contains(&adsblol_daily_quota) {
            return Err(format!("ADSBLOL_DAILY_QUOTA: {adsblol_daily_quota} is out of range (10 to 1000000)"));
        }
        let adsblol_budget_file = match get("ADSBLOL_BUDGET_FILE") {
            None => Some(std::env::temp_dir().join("orya-halo-gateway").join("adsb-lol-budget.json")),
            Some(v) if ["off", "none", "false", "0"].contains(&v.to_ascii_lowercase().as_str()) => None,
            Some(path) => Some(PathBuf::from(path)),
        };
        // The key becomes part of a URL path, so anything but letters and
        // digits is refused. The message must not repeat the value.
        let firms_map_key = match get("FIRMS_MAP_KEY") {
            Some(key) if key.len() <= 128 && key.bytes().all(|b| b.is_ascii_alphanumeric()) => Some(Secret::new(key)),
            Some(_) => return Err("FIRMS_MAP_KEY: a map key is letters and digits only (usually 32)".to_owned()),
            None => None,
        };

        let celestrak_cache_dir = match get("CELESTRAK_CACHE_DIR") {
            None => Some(std::env::temp_dir().join("orya-halo-gateway").join("celestrak")),
            Some(v) if ["off", "none", "false", "0"].contains(&v.to_ascii_lowercase().as_str()) => None,
            Some(path) => Some(PathBuf::from(path)),
        };

        let config = Config {
            bind,
            allowed_origins,
            trust_proxy: b!("TRUST_PROXY", false),
            client_ip_header: get("CLIENT_IP_HEADER")
                .map(|h| h.trim().to_ascii_lowercase())
                .filter(|h| !h.is_empty())
                .unwrap_or_else(|| "fly-client-ip".to_owned()),
            tick_ms,
            world_cadence_ms: n!("WORLD_CADENCE_MS", 5000),
            density_interval_ms: n!("DENSITY_INTERVAL_MS", 5000),
            density_res,
            stats_interval_ms: n!("STATS_INTERVAL_MS", 1000),
            max_cells: n!("MAX_CELLS", 2000),
            max_clients: n!("MAX_CLIENTS", 2000),
            max_clients_per_ip: n!("MAX_CLIENTS_PER_IP", 8),
            idle_timeout_s: n!("IDLE_TIMEOUT_S", 60),
            ping_interval_s: n!("PING_INTERVAL_S", 20),
            max_message_bytes: n!("MAX_MESSAGE_BYTES", 131_072),
            client_queue: n!("CLIENT_QUEUE_FRAMES", 64usize).max(8),
            max_messages_per_10s: n!("MAX_CLIENT_MESSAGES_PER_10S", 60),
            compress_min_bytes: n!("COMPRESS_MIN_BYTES", 512),
            compress_level: n!("COMPRESS_LEVEL", 1u32).min(9),
            aircraft: KindLimits {
                ttl_ms: n!("AIRCRAFT_TTL_S", 90i64) * 1000,
                max_ttl_ms: n!("AIRCRAFT_MAX_TTL_S", 900i64) * 1000,
                stale_ms: n!("AIRCRAFT_STALE_S", 45i64) * 1000,
                max_entities: n!("MAX_AIRCRAFT", 100_000),
                track_points: n!("AIRCRAFT_TRACK_POINTS", 32),
                track_interval_ms: n!("AIRCRAFT_TRACK_INTERVAL_S", 15i64) * 1000,
                refresh_ms: 30_000,
            },
            ships: KindLimits {
                ttl_ms: n!("SHIP_TTL_S", 1200i64) * 1000,
                max_ttl_ms: n!("SHIP_MAX_TTL_S", 3600i64) * 1000,
                stale_ms: n!("SHIP_STALE_S", 600i64) * 1000,
                max_entities: n!("MAX_SHIPS", 300_000),
                track_points: n!("SHIP_TRACK_POINTS", 16),
                track_interval_ms: n!("SHIP_TRACK_INTERVAL_S", 120i64) * 1000,
                refresh_ms: 300_000,
            },
            mock,
            upstreams: get("UPSTREAMS")
                .map(|v| v.split(',').map(|s| s.trim().to_ascii_lowercase()).filter(|s| !s.is_empty()).collect())
                .unwrap_or_default(),
            user_agent: get("HTTP_USER_AGENT")
                .unwrap_or_else(|| concat!("orya-halo-gateway/", env!("CARGO_PKG_VERSION")).to_owned()),
            adsblol_daily_quota,
            adsblol_api_key,
            adsblol_budget_file,
            adsblol_first_burst: b!("ADSBLOL_FIRST_BURST", true),
            adsblol_min_interval_ms: n!("ADSBLOL_MIN_INTERVAL_MS", default_adsblol_interval).max(500),
            adsblol_reapi_url: get("ADSBLOL_REAPI_URL")
                .unwrap_or_else(|| "https://re-api.adsb.lol/?all_with_pos".to_owned()),
            // The documented allowance is two whole-world snapshots a minute.
            adsblol_reapi_interval_s: n!("ADSBLOL_REAPI_INTERVAL_S", 30u64).max(30),
            // The documented limit is one request a second; stay a little under it.
            adsbfi_min_interval_ms: n!("ADSBFI_MIN_INTERVAL_MS", 1100u64).max(1000),
            aircraft_hot_interval_s: n!("AIRCRAFT_HOT_INTERVAL_S", 5u64).max(1),
            aircraft_background_interval_s: n!("AIRCRAFT_BACKGROUND_INTERVAL_S", 30u64).max(1),
            aircraft_tile_radius_nm: n!("AIRCRAFT_TILE_RADIUS_NM", 250u32).clamp(25, 250),
            aisstream_api_key: get("AISSTREAM_API_KEY"),
            aisstream_url: get("AISSTREAM_URL").unwrap_or_else(|| "wss://stream.aisstream.io/v0/stream".to_owned()),
            digitraffic_user: get("DIGITRAFFIC_USER").unwrap_or_else(|| "orya-halo-gateway".to_owned()),
            digitraffic_mqtt_url: get("DIGITRAFFIC_MQTT_URL")
                .unwrap_or_else(|| "wss://meri.digitraffic.fi:443/mqtt".to_owned()),
            digitraffic_rest_url: get("DIGITRAFFIC_REST_URL")
                .unwrap_or_else(|| "https://meri.digitraffic.fi".to_owned()),
            routes_enabled: b!("ROUTES_ENABLED", true),
            firms_map_key,
            firms_base_url: get("FIRMS_BASE_URL")
                .map(|v| v.trim_end_matches('/').to_owned())
                .unwrap_or_else(|| "https://firms.modaps.eosdis.nasa.gov".to_owned()),
            firms_cache_ttl: Duration::from_secs(n!("FIRMS_CACHE_TTL_S", 1200u64).max(60)),
            firms_max_bytes: n!("FIRMS_MAX_BYTES", 50_331_648usize).max(1024),
            celestrak_base_url: get("CELESTRAK_BASE_URL")
                .map(|v| v.trim_end_matches('/').to_owned())
                .unwrap_or_else(|| "https://celestrak.org".to_owned()),
            // CelesTrak updates every two hours and serves each update once per address.
            celestrak_refresh: Duration::from_secs(n!("CELESTRAK_REFRESH_S", 7200u64))
                .max(crate::celestrak::MIN_REFRESH),
            celestrak_max_stale: Duration::from_secs(n!("CELESTRAK_MAX_STALE_S", 604_800u64)),
            celestrak_max_bytes: n!("CELESTRAK_MAX_BYTES", 16_777_216usize).max(1024),
            celestrak_cache_dir,
            log_json: get("LOG_FORMAT").is_some_and(|v| v.eq_ignore_ascii_case("json")),
        };
        Ok(config)
    }

    /// A quiet configuration for tests: ephemeral port, no upstreams, fast ticks.
    pub fn for_tests() -> Config {
        let mut config = Config::from_lookup(|_| None).expect("defaults are valid");
        config.bind = SocketAddr::from(([127, 0, 0, 1], 0));
        config.upstreams = vec!["none".to_owned()];
        // Tests must not leave files behind or pick up a developer's saved budget or copies.
        config.adsblol_budget_file = None;
        config.celestrak_cache_dir = None;
        config
    }

    /// True when the source id is enabled, given that it is on or off by default.
    pub fn source_enabled(&self, id: &str, default_on: bool) -> bool {
        if self.upstreams.is_empty() { default_on } else { self.upstreams.iter().any(|u| u == id) }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn from(pairs: &[(&str, &str)]) -> Result<Config, String> {
        let map: HashMap<String, String> = pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
        Config::from_lookup(|key| map.get(key).cloned())
    }

    #[test]
    fn defaults_are_sensible() {
        let c = from(&[]).unwrap();
        assert_eq!(c.bind.to_string(), "0.0.0.0:8787");
        assert_eq!(c.tick_ms, 1000);
        assert_eq!(c.max_cells, 2000);
        assert_eq!(c.density_res, 2);
        assert_eq!(c.world_cadence_ticks(), 5);
        assert_eq!(c.allowed_origins, AllowedOrigins::LocalDev);
        assert_eq!(c.adsblol_daily_quota, 500);
        assert!(c.adsblol_budget_file.as_ref().is_some_and(|p| p.ends_with("orya-halo-gateway/adsb-lol-budget.json")));
        assert!(c.firms_map_key.is_none());
        assert_eq!(c.firms_base_url, "https://firms.modaps.eosdis.nasa.gov");
        assert_eq!(c.firms_cache_ttl, Duration::from_secs(1200));
        assert_eq!(c.celestrak_base_url, "https://celestrak.org");
        assert_eq!(c.celestrak_refresh, Duration::from_secs(7200));
        assert_eq!(c.celestrak_max_stale, Duration::from_secs(7 * 86_400));
        assert!(c.celestrak_cache_dir.as_ref().is_some_and(|p| p.ends_with("orya-halo-gateway/celestrak")));
        assert!(c.mock.is_none());
        assert!(c.source_enabled("adsb-lol", true));
        assert!(!c.source_enabled("adsb-fi", false));
    }

    #[test]
    fn values_are_read_and_validated() {
        let c = from(&[
            ("BIND_ADDR", "127.0.0.1:9000"),
            ("PORT", "8797"),
            ("TICK_MS", "250"),
            ("WORLD_CADENCE_MS", "2000"),
            ("ALLOWED_ORIGINS", "https://halo.example, https://other.example/"),
            ("MOCK", "aircraft:10,ships:20"),
            ("UPSTREAMS", "adsb-fi, Digitraffic"),
            ("ADSBLOL_API_KEY", "k"),
        ])
        .unwrap();
        assert_eq!(c.bind.to_string(), "127.0.0.1:8797");
        assert_eq!(c.world_cadence_ticks(), 8);
        assert!(c.allowed_origins.allows("https://other.example"));
        assert!(!c.allowed_origins.allows("https://evil.example"));
        assert_eq!(c.mock, Some(MockConfig { aircraft: 10, ships: 20 }));
        assert!(c.source_enabled("adsb-fi", false));
        assert!(c.source_enabled("digitraffic", true));
        assert!(!c.source_enabled("adsb-lol", true));
        assert_eq!(c.adsblol_daily_quota, 1000);

        assert!(from(&[("TICK_MS", "abc")]).unwrap_err().contains("TICK_MS"));
        assert!(from(&[("TICK_MS", "5")]).unwrap_err().contains("out of range"));
        assert!(from(&[("MOCK", "boats:5")]).unwrap_err().contains("unknown layer"));
        assert!(from(&[("TRUST_PROXY", "maybe")]).is_err());
        assert!(from(&[("ADSBLOL_DAILY_QUOTA", "0")]).unwrap_err().contains("out of range"));
    }

    #[test]
    fn the_budget_file_can_be_moved_or_switched_off() {
        let moved = from(&[("ADSBLOL_BUDGET_FILE", "/var/lib/halo/budget.json")]).unwrap();
        assert_eq!(moved.adsblol_budget_file, Some(PathBuf::from("/var/lib/halo/budget.json")));
        for off in ["off", "OFF", "none", "false", "0"] {
            assert_eq!(from(&[("ADSBLOL_BUDGET_FILE", off)]).unwrap().adsblol_budget_file, None, "{off}");
        }
        assert_eq!(Config::for_tests().adsblol_budget_file, None);
        assert_eq!(from(&[("CELESTRAK_CACHE_DIR", "off")]).unwrap().celestrak_cache_dir, None);
        assert_eq!(Config::for_tests().celestrak_cache_dir, None);
    }

    #[test]
    fn celestrak_is_never_asked_more_than_once_per_update() {
        let c = from(&[("CELESTRAK_REFRESH_S", "60"), ("CELESTRAK_BASE_URL", "http://127.0.0.1:9/")]).unwrap();
        assert_eq!(c.celestrak_refresh, Duration::from_secs(7200), "two hours is the floor");
        assert_eq!(c.celestrak_base_url, "http://127.0.0.1:9");
        let longer = from(&[("CELESTRAK_REFRESH_S", "21600")]).unwrap();
        assert_eq!(longer.celestrak_refresh, Duration::from_secs(21_600));
    }

    #[test]
    fn the_firms_key_is_checked_and_never_printed() {
        let key = "0123456789abcdef0123456789ABCDEF";
        let c = from(&[("FIRMS_MAP_KEY", key), ("FIRMS_BASE_URL", "http://127.0.0.1:9/"), ("FIRMS_CACHE_TTL_S", "5")])
            .unwrap();
        assert_eq!(c.firms_map_key.as_ref().map(Secret::expose), Some(key));
        assert_eq!(c.firms_base_url, "http://127.0.0.1:9");
        assert_eq!(c.firms_cache_ttl, Duration::from_secs(60), "FIRMS is not asked more than once a minute");
        assert!(!format!("{c:?}").contains(key), "the key is not in the debug output");

        // A key that would change the request path is refused, without being echoed.
        for bad in ["abc/../def", "key with spaces", "k?x=1", "ключ"] {
            let error = from(&[("FIRMS_MAP_KEY", bad)]).unwrap_err();
            assert!(error.starts_with("FIRMS_MAP_KEY") && !error.contains(bad), "{error}");
        }
    }

    #[test]
    fn local_dev_origins_are_recognised() {
        let dev = AllowedOrigins::LocalDev;
        assert!(dev.allows("http://localhost:5173"));
        assert!(dev.allows("http://127.0.0.1:3000"));
        assert!(dev.allows("http://[::1]:5173"));
        assert!(dev.allows("http://app.localhost:5173"));
        assert!(!dev.allows("https://localhost.evil.example"));
        assert!(!dev.allows("https://halo.example"));
        assert!(AllowedOrigins::Any.allows("https://anything.example"));
    }

    #[test]
    fn env_example_documents_every_variable() {
        // Record every key the configuration asks for...
        let asked = std::cell::RefCell::new(std::collections::BTreeSet::new());
        Config::from_lookup(|key| {
            asked.borrow_mut().insert(key.to_owned());
            None
        })
        .unwrap();
        let asked = asked.into_inner();
        // ...and every key .env.example mentions, commented out or not.
        let example = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/.env.example")).unwrap();
        let documented: std::collections::BTreeSet<String> = example
            .lines()
            .filter_map(|line| {
                let line = line.trim_start_matches('#').trim_start();
                let (key, _) = line.split_once('=')?;
                (!key.is_empty() && key.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'))
                    .then(|| key.to_owned())
            })
            .collect();
        let undocumented: Vec<_> = asked.difference(&documented).collect();
        assert!(undocumented.is_empty(), "missing from .env.example: {undocumented:?}");
        // RUST_LOG is read by the logger, not by Config.
        let unknown: Vec<_> = documented.difference(&asked).filter(|k| *k != "RUST_LOG").collect();
        assert!(unknown.is_empty(), "in .env.example but not read: {unknown:?}");
    }

    #[test]
    fn mock_spec_shorthand() {
        assert_eq!(MockConfig::parse("1").unwrap(), MockConfig::DEFAULT);
        assert_eq!(MockConfig::parse("aircraft:5").unwrap(), MockConfig { aircraft: 5, ships: 0 });
        assert!(MockConfig::parse("aircraft").is_err());
    }
}
