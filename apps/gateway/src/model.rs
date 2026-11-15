//! Shared vocabulary: entity kinds, categories, flags and the normalised
//! observation every upstream produces. Numeric values mirror
//! `packages/schema/src/kinds.ts` and are part of the wire protocol.

use crate::protocol::{self, MetaKey};

/// Kinds of entity the gateway serves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Kind {
    Aircraft = 1,
    Ship = 2,
}

impl Kind {
    pub const ALL: [Kind; 2] = [Kind::Aircraft, Kind::Ship];
    pub const COUNT: usize = 2;

    /// Dense index for per-kind arrays.
    #[inline]
    pub fn index(self) -> usize {
        self as usize - 1
    }

    /// Layer name used in subscriptions and `hello`.
    pub fn layer(self) -> &'static str {
        match self {
            Kind::Aircraft => "aircraft",
            Kind::Ship => "ships",
        }
    }

    pub fn from_layer(layer: &str) -> Option<Kind> {
        match layer {
            "aircraft" => Some(Kind::Aircraft),
            "ships" => Some(Kind::Ship),
            _ => None,
        }
    }

    /// Parse the `{kind}` path segment of the HTTP API: the number or the word.
    pub fn from_path(segment: &str) -> Option<Kind> {
        match segment {
            "1" | "aircraft" => Some(Kind::Aircraft),
            "2" | "ship" | "ships" => Some(Kind::Ship),
            _ => None,
        }
    }
}

/// `EntityFlag` bits.
pub mod flag {
    /// On the ground, moored or otherwise not under way.
    pub const STATIONARY: u8 = 1 << 0;
    /// Emergency squawk or distress status.
    pub const EMERGENCY: u8 = 1 << 1;
    pub const MILITARY: u8 = 1 << 2;
    /// Position is older than the layer's freshness window. Set by the gateway, never by a source.
    pub const STALE: u8 = 1 << 3;
}

/// `AircraftCategory` codes.
pub mod aircraft_category {
    pub const UNKNOWN: u8 = 0;
    pub const LIGHT: u8 = 1;
    pub const MEDIUM: u8 = 2;
    pub const LARGE: u8 = 3;
    pub const HEAVY: u8 = 4;
    pub const HIGH_PERFORMANCE: u8 = 5;
    pub const ROTORCRAFT: u8 = 6;
    pub const GLIDER: u8 = 7;
    pub const UAV: u8 = 8;
    pub const SURFACE: u8 = 9;
}

/// `ShipCategory` codes.
pub mod ship_category {
    pub const UNKNOWN: u8 = 0;
    pub const CARGO: u8 = 1;
    pub const TANKER: u8 = 2;
    pub const PASSENGER: u8 = 3;
    pub const FISHING: u8 = 4;
    pub const SERVICE: u8 = 5;
    pub const HIGH_SPEED: u8 = 6;
    pub const PLEASURE: u8 = 7;
    pub const MILITARY: u8 = 8;
    pub const OTHER: u8 = 9;
}

/// Upstream health, as reported in `hello` and Stats frames.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum UpstreamStatus {
    Off = 0,
    Ok = 1,
    Degraded = 2,
    NeedsKey = 3,
    Down = 4,
}

impl UpstreamStatus {
    pub fn from_u8(value: u8) -> UpstreamStatus {
        match value {
            1 => UpstreamStatus::Ok,
            2 => UpstreamStatus::Degraded,
            3 => UpstreamStatus::NeedsKey,
            4 => UpstreamStatus::Down,
            _ => UpstreamStatus::Off,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            UpstreamStatus::Off => "off",
            UpstreamStatus::Ok => "ok",
            UpstreamStatus::Degraded => "degraded",
            UpstreamStatus::NeedsKey => "needs-key",
            UpstreamStatus::Down => "down",
        }
    }
}

/// Position and motion of one entity at one moment, already in wire units so
/// that "did anything change" is an exact comparison and encoding is a copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Fix {
    pub lon_e7: i32,
    pub lat_e7: i32,
    /// Units of 7.62 m.
    pub alt: i16,
    /// Degrees × 100, `0xFFFF` unknown.
    pub heading: u16,
    /// Units of 0.1 m/s.
    pub speed: u16,
    /// Units of 0.5 m/s.
    pub vrate: i8,
    /// Source-provided `flag` bits (never `STALE`).
    pub flags: u8,
    /// When the position was observed, Unix epoch milliseconds.
    pub time_ms: i64,
}

impl Fix {
    /// Build a fix from SI units. `heading_deg` is course over ground.
    #[allow(clippy::too_many_arguments)]
    pub fn from_si(
        lon_deg: f64,
        lat_deg: f64,
        alt_m: f64,
        heading_deg: Option<f64>,
        speed_mps: f64,
        vrate_mps: f64,
        flags: u8,
        time_ms: i64,
    ) -> Fix {
        Fix {
            lon_e7: protocol::quantise_lon(lon_deg),
            lat_e7: protocol::quantise_lat(lat_deg),
            alt: protocol::quantise_alt(alt_m),
            heading: protocol::quantise_heading(heading_deg),
            speed: protocol::quantise_speed(speed_mps),
            vrate: protocol::quantise_vrate(vrate_mps),
            flags: flags & !flag::STALE,
            time_ms,
        }
    }

    pub fn lon(&self) -> f64 {
        f64::from(self.lon_e7) / protocol::LONLAT_SCALE
    }

    pub fn lat(&self) -> f64 {
        f64::from(self.lat_e7) / protocol::LONLAT_SCALE
    }

    pub fn alt_m(&self) -> f64 {
        f64::from(self.alt) * protocol::ALT_UNIT_M
    }

    pub fn heading_deg(&self) -> Option<f64> {
        (self.heading != protocol::HEADING_UNKNOWN).then(|| f64::from(self.heading) / protocol::HEADING_SCALE)
    }

    pub fn speed_mps(&self) -> f64 {
        f64::from(self.speed) * protocol::SPEED_UNIT_MPS
    }

    pub fn vrate_mps(&self) -> f64 {
        f64::from(self.vrate) * protocol::VRATE_UNIT_MPS
    }
}

/// One normalised report about one entity. A position report carries `fix`;
/// a static or voyage message carries only `meta` and perhaps `category`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Observation {
    /// ICAO 24-bit address or MMSI.
    pub id: u32,
    pub fix: Option<Fix>,
    /// `AircraftCategory` or `ShipCategory`, when this report says.
    pub category: Option<u8>,
    /// Static facts learned from this report. Absent keys are left as they were.
    pub meta: Vec<(MetaKey, String)>,
    /// Keep the entity this long after this report instead of the kind's
    /// default, for sources that revisit an area slowly. Milliseconds.
    pub ttl_ms: Option<u32>,
}

impl Observation {
    pub fn new(id: u32) -> Observation {
        Observation { id, ..Default::default() }
    }

    /// Record a fact, ignoring empty values.
    pub fn fact(&mut self, key: MetaKey, value: impl AsRef<str>) {
        let value = value.as_ref().trim();
        if !value.is_empty() {
            self.meta.push((key, value.to_owned()));
        }
    }
}

/// What an upstream pushes into the gateway.
#[derive(Debug, Clone, PartialEq)]
pub enum UpstreamMessage {
    /// A batch of reports from the source with the given registry index.
    Batch { kind: Kind, source: u8, observations: Vec<Observation> },
    /// Entities the source positively no longer sees. They are dropped unless
    /// something reported them after `unless_seen_after_ms`.
    Gone { kind: Kind, ids: Vec<u32>, unless_seen_after_ms: i64 },
}

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

const EARTH_RADIUS_KM: f64 = 6371.0088;

/// Great-circle distance in kilometres.
pub fn haversine_km(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let (p1, p2) = (lat1.to_radians(), lat2.to_radians());
    let dp = p2 - p1;
    let dl = (lon2 - lon1).to_radians();
    let a = (dp / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dl / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_KM * a.sqrt().min(1.0).asin()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_map_to_layers_and_path_segments() {
        assert_eq!(Kind::from_layer("aircraft"), Some(Kind::Aircraft));
        assert_eq!(Kind::from_layer("ships"), Some(Kind::Ship));
        assert_eq!(Kind::from_layer("ship"), None);
        assert_eq!(Kind::from_path("2"), Some(Kind::Ship));
        assert_eq!(Kind::from_path("ship"), Some(Kind::Ship));
        assert_eq!(Kind::from_path("satellites"), None);
        assert_eq!(Kind::Aircraft.index(), 0);
        assert_eq!(Kind::Ship.index(), 1);
    }

    #[test]
    fn fix_round_trips_through_wire_units() {
        let fix = Fix::from_si(-0.4543, 51.47, 10_668.0, Some(271.5), 231.5, -6.0, flag::STALE | flag::MILITARY, 5);
        assert_eq!(fix.lon_e7, -4_543_000);
        assert_eq!(fix.alt, 1400);
        assert_eq!(fix.heading, 27150);
        assert_eq!(fix.flags, flag::MILITARY, "a source can never set the stale bit");
        assert!((fix.lon() + 0.4543).abs() < 1e-9);
        assert!((fix.alt_m() - 10_668.0).abs() < 1e-6);
        assert_eq!(fix.heading_deg(), Some(271.5));
        assert!((fix.speed_mps() - 231.5).abs() < 1e-9);
        assert_eq!(Fix::from_si(0.0, 0.0, 0.0, None, 0.0, 0.0, 0, 0).heading_deg(), None);
    }

    #[test]
    fn haversine_is_about_right() {
        // London to Paris is roughly 344 km.
        let d = haversine_km(51.5074, -0.1278, 48.8566, 2.3522);
        assert!((d - 344.0).abs() < 3.0, "{d}");
        assert!(haversine_km(10.0, 20.0, 10.0, 20.0) < 1e-9);
    }
}
