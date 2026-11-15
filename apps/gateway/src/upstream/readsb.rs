//! Normaliser for readsb-style aircraft JSON.
//!
//! adsb.lol (`/v2/point`, re-api), adsb.fi (`/v3/lat/lon/dist`) and
//! airplanes.live all run readsb and return the same per-aircraft fields; only
//! the envelope differs (`ac` or `aircraft`, `now` in milliseconds or seconds).
//! Field reference: <https://github.com/wiedehopf/readsb/blob/dev/README-json.md>.

use serde::Deserialize;

use crate::model::{Fix, Observation, aircraft_category as cat, flag};
use crate::protocol::MetaKey;

const KNOTS_TO_MPS: f64 = 0.514_444;
const FEET_TO_M: f64 = 0.3048;
const FPM_TO_MPS: f64 = 0.00508;

/// Positions older than this are not worth showing as live traffic.
const MAX_POSITION_AGE_S: f64 = 120.0;

#[derive(Debug, Deserialize)]
struct Envelope {
    /// Server time: milliseconds in the v2 API, seconds in native readsb output.
    #[serde(default)]
    now: f64,
    #[serde(default, alias = "aircraft")]
    ac: Vec<Aircraft>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum Altitude {
    Feet(f64),
    /// The string "ground".
    Word(String),
}

#[derive(Debug, Deserialize)]
struct Aircraft {
    hex: String,
    flight: Option<String>,
    r: Option<String>,
    t: Option<String>,
    desc: Option<String>,
    #[serde(rename = "ownOp")]
    own_op: Option<String>,
    alt_baro: Option<Altitude>,
    alt_geom: Option<f64>,
    gs: Option<f64>,
    track: Option<f64>,
    true_heading: Option<f64>,
    baro_rate: Option<f64>,
    geom_rate: Option<f64>,
    squawk: Option<String>,
    category: Option<String>,
    lat: Option<f64>,
    lon: Option<f64>,
    seen_pos: Option<f64>,
    #[serde(rename = "dbFlags")]
    db_flags: Option<u32>,
}

/// One parsed response.
#[derive(Debug, Default)]
pub struct Parsed {
    pub observations: Vec<Observation>,
    /// The provider's clock when it answered, Unix epoch milliseconds.
    pub now_ms: i64,
    /// Aircraft in the response, including those skipped for having no usable position.
    pub listed: usize,
}

/// ADS-B emitter category ("A3", "B6", ...) to `AircraftCategory`.
pub fn emitter_category(code: &str) -> u8 {
    match code {
        "A1" => cat::LIGHT,
        "A2" => cat::MEDIUM,
        // A4 is the "high vortex large" class (the Boeing 757): large, not heavy.
        "A3" | "A4" => cat::LARGE,
        "A5" => cat::HEAVY,
        "A6" => cat::HIGH_PERFORMANCE,
        "A7" => cat::ROTORCRAFT,
        "B1" => cat::GLIDER,
        // Ultralights, hang gliders and paragliders fly like the lightest aircraft.
        "B4" => cat::LIGHT,
        "B6" => cat::UAV,
        "B7" => cat::HIGH_PERFORMANCE,
        // Every C class is something on the surface: vehicles and obstacles.
        c if c.starts_with('C') && c.len() == 2 && c != "C0" => cat::SURFACE,
        _ => cat::UNKNOWN,
    }
}

/// True for the three squawks that declare an emergency.
pub fn is_emergency_squawk(squawk: &str) -> bool {
    matches!(squawk, "7500" | "7600" | "7700")
}

/// Parse a readsb-style response into observations.
///
/// `received_ms` is our own clock when the response arrived; it is used when
/// the response carries no usable `now`.
pub fn parse(body: &[u8], received_ms: i64) -> Result<Parsed, serde_json::Error> {
    let envelope: Envelope = serde_json::from_slice(body)?;
    let now_ms = if envelope.now > 1e11 {
        envelope.now as i64
    } else if envelope.now > 1e8 {
        (envelope.now * 1000.0) as i64
    } else {
        received_ms
    };
    let listed = envelope.ac.len();
    let mut observations = Vec::with_capacity(listed);
    for a in envelope.ac {
        // A leading "~" marks a non-ICAO address (TIS-B and the like): no stable identity.
        let Ok(id) = u32::from_str_radix(&a.hex, 16) else { continue };
        if id == 0 || id > 0xFF_FFFF {
            continue;
        }
        let (Some(lat), Some(lon)) = (a.lat, a.lon) else { continue };
        if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
            continue;
        }
        let seen_pos = a.seen_pos.unwrap_or(0.0).max(0.0);
        if seen_pos > MAX_POSITION_AGE_S {
            continue;
        }

        let on_ground = matches!(&a.alt_baro, Some(Altitude::Word(w)) if w == "ground");
        let baro_ft = match a.alt_baro {
            Some(Altitude::Feet(ft)) => Some(ft),
            _ => None,
        };
        // Geometric altitude is height above the ellipsoid, which is what a
        // globe wants; pressure altitude is the fallback.
        let alt_m = if on_ground { 0.0 } else { a.alt_geom.or(baro_ft).unwrap_or(0.0) * FEET_TO_M };
        let squawk = a.squawk.as_deref().map(str::trim).filter(|s| !s.is_empty());

        let mut flags = 0u8;
        if on_ground {
            flags |= flag::STATIONARY;
        }
        if squawk.is_some_and(is_emergency_squawk) {
            flags |= flag::EMERGENCY;
        }
        if a.db_flags.is_some_and(|f| f & 1 != 0) {
            flags |= flag::MILITARY;
        }

        let mut obs = Observation::new(id);
        obs.fix = Some(Fix::from_si(
            lon,
            lat,
            alt_m,
            a.track.or(a.true_heading),
            a.gs.unwrap_or(0.0) * KNOTS_TO_MPS,
            a.geom_rate.or(a.baro_rate).unwrap_or(0.0) * FPM_TO_MPS,
            flags,
            now_ms - (seen_pos * 1000.0) as i64,
        ));
        obs.category = Some(a.category.as_deref().map_or(cat::UNKNOWN, emitter_category));
        if let Some(flight) = a.flight.as_deref().map(str::trim).filter(|f| !f.is_empty() && !f.starts_with('@')) {
            obs.fact(MetaKey::Label, flight);
        }
        if let Some(r) = &a.r {
            obs.fact(MetaKey::Registration, r);
        }
        if let Some(t) = &a.t {
            obs.fact(MetaKey::TypeCode, t);
        }
        if let Some(desc) = &a.desc {
            obs.fact(MetaKey::TypeName, desc);
        }
        if let Some(op) = &a.own_op {
            obs.fact(MetaKey::Operator, op);
        }
        if let Some(squawk) = squawk {
            obs.fact(MetaKey::Squawk, squawk);
        }
        observations.push(obs);
    }
    Ok(Parsed { observations, now_ms, listed })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emitter_categories_map_to_the_app_categories() {
        assert_eq!(emitter_category("A0"), cat::UNKNOWN);
        assert_eq!(emitter_category("A1"), cat::LIGHT);
        assert_eq!(emitter_category("A2"), cat::MEDIUM);
        assert_eq!(emitter_category("A3"), cat::LARGE);
        assert_eq!(emitter_category("A4"), cat::LARGE);
        assert_eq!(emitter_category("A5"), cat::HEAVY);
        assert_eq!(emitter_category("A6"), cat::HIGH_PERFORMANCE);
        assert_eq!(emitter_category("A7"), cat::ROTORCRAFT);
        assert_eq!(emitter_category("B1"), cat::GLIDER);
        assert_eq!(emitter_category("B2"), cat::UNKNOWN);
        assert_eq!(emitter_category("B4"), cat::LIGHT);
        assert_eq!(emitter_category("B6"), cat::UAV);
        assert_eq!(emitter_category("C0"), cat::UNKNOWN);
        assert_eq!(emitter_category("C1"), cat::SURFACE);
        assert_eq!(emitter_category("C2"), cat::SURFACE);
        assert_eq!(emitter_category("D3"), cat::UNKNOWN);
        assert_eq!(emitter_category(""), cat::UNKNOWN);
    }

    #[test]
    fn native_readsb_envelope_with_seconds_is_understood() {
        let body = br#"{"now": 1794670509.5, "messages": 1, "aircraft": [
            {"hex":"4ca7b5","flight":"EIN4KD  ","alt_baro":35000,"gs":450.0,"track":271.5,"baro_rate":-640,
             "squawk":"7700","category":"A3","lat":53.4,"lon":-5.1,"seen_pos":2.5,"dbFlags":1,"ownOp":"Aer Lingus"},
            {"hex":"~2a1b3c","lat":1.0,"lon":1.0},
            {"hex":"abc123"},
            {"hex":"abc124","lat":10.0,"lon":10.0,"seen_pos":500.0},
            {"hex":"abc125","lat":95.0,"lon":10.0}
        ]}"#;
        let parsed = parse(body, 0).unwrap();
        assert_eq!(parsed.now_ms, 1_794_670_509_500);
        assert_eq!(parsed.listed, 5);
        assert_eq!(parsed.observations.len(), 1, "non-ICAO, position-less, old and invalid entries are skipped");
        let o = &parsed.observations[0];
        assert_eq!(o.id, 0x4ca7b5);
        let fix = o.fix.unwrap();
        assert_eq!(fix.time_ms, 1_794_670_507_000);
        assert_eq!(fix.alt, 1400, "35,000 ft is 1400 units of 25 ft");
        assert_eq!(fix.heading, 27150);
        assert_eq!(fix.speed, 2315, "450 kt is 231.5 m/s");
        assert_eq!(fix.vrate, -7, "-640 ft/min is -3.25 m/s");
        assert_eq!(fix.flags, flag::EMERGENCY | flag::MILITARY);
        assert_eq!(o.category, Some(cat::LARGE));
        assert!(o.meta.contains(&(MetaKey::Label, "EIN4KD".to_owned())));
        assert!(o.meta.contains(&(MetaKey::Operator, "Aer Lingus".to_owned())));
        assert!(o.meta.contains(&(MetaKey::Squawk, "7700".to_owned())));
    }

    #[test]
    fn garbage_is_an_error_not_a_panic() {
        assert!(parse(b"<html>rate limited</html>", 0).is_err());
        assert_eq!(parse(b"{}", 5).unwrap().now_ms, 5);
        assert!(parse(br#"{"ac":[{"hex":"zzzzzz","lat":1,"lon":1}]}"#, 0).unwrap().observations.is_empty());
    }
}
