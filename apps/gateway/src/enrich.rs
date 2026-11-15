//! Optional extras for the detail endpoint: where a flight is going.
//!
//! Routes come from Virtual Radar Server's crowd-sourced standing data
//! (CC0 1.0, <https://github.com/vradarserver/standing-data>) through the
//! per-callsign JSON files adsb.lol publishes from it. One small static file
//! is fetched the first time somebody opens a flight, then cached for hours.
//! The data maps a flight number to its usual route, so a route is only shown
//! when the aircraft is actually somewhere between the two airports.

use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use rustc_hash::FxHashMap;
use serde::{Deserialize, Serialize};

use crate::model::haversine_km;

const CACHE_TTL: Duration = Duration::from_secs(6 * 3600);
const CACHE_MAX: usize = 4096;
/// Lookups are user-driven, but never let them turn into a crawl of the provider.
const MIN_INTERVAL: Duration = Duration::from_millis(250);
const TIMEOUT: Duration = Duration::from_secs(3);

pub const ROUTES_ATTRIBUTION: &str = "Route data: Virtual Radar Server standing data (CC0), served by adsb.lol";

#[derive(Debug, Clone, PartialEq, Deserialize)]
struct StandingAirport {
    #[serde(default)]
    name: String,
    #[serde(default)]
    icao: String,
    #[serde(default)]
    iata: String,
    lat: f64,
    lon: f64,
}

#[derive(Debug, Deserialize)]
struct StandingRoute {
    #[serde(default, rename = "_airports")]
    airports: Vec<StandingAirport>,
}

/// One end of a route, as the detail panel shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Airport {
    /// IATA code when there is one, otherwise ICAO.
    pub code: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub name: String,
    pub lon: f64,
    pub lat: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Route {
    pub origin: Airport,
    pub destination: Airport,
}

/// Parse a standing-data route file into its airports, in flying order.
pub fn parse_route(body: &[u8]) -> Option<Vec<Airport>> {
    let route: StandingRoute = serde_json::from_slice(body).ok()?;
    let airports: Vec<Airport> = route
        .airports
        .into_iter()
        .map(|a| Airport {
            code: if a.iata.is_empty() { a.icao } else { a.iata },
            name: a.name,
            lon: a.lon,
            lat: a.lat,
        })
        .filter(|a| !a.code.is_empty())
        .collect();
    (airports.len() >= 2).then_some(airports)
}

/// Pick the leg of a route the aircraft is on, or `None` when it is nowhere
/// near any of them: flight numbers are reused, and a wrong route is worse
/// than no route.
pub fn plausible_leg(airports: &[Airport], lat: f64, lon: f64) -> Option<Route> {
    airports
        .windows(2)
        .filter_map(|leg| {
            let direct = haversine_km(leg[0].lat, leg[0].lon, leg[1].lat, leg[1].lon);
            let via = haversine_km(leg[0].lat, leg[0].lon, lat, lon) + haversine_km(lat, lon, leg[1].lat, leg[1].lon);
            // Allow for routings that are not great circles, and holds near airports.
            let detour = via - direct;
            (detour <= direct * 0.25 + 300.0).then_some((detour, leg))
        })
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, leg)| Route { origin: leg[0].clone(), destination: leg[1].clone() })
}

/// True for callsigns that look like an airline flight: three letters, then a flight number.
pub fn is_flight_callsign(callsign: &str) -> bool {
    let b = callsign.as_bytes();
    (4..=8).contains(&b.len())
        && b[..3].iter().all(u8::is_ascii_uppercase)
        && b[3].is_ascii_digit()
        && b[3..].iter().all(u8::is_ascii_alphanumeric)
}

type Cached = (Instant, Option<Arc<Vec<Airport>>>);

pub struct Routes {
    enabled: bool,
    base: String,
    http: reqwest::Client,
    cache: Mutex<FxHashMap<String, Cached>>,
    last_request: Mutex<Option<Instant>>,
}

impl Routes {
    pub fn new(enabled: bool, base: &str, http: reqwest::Client) -> Routes {
        Routes {
            enabled,
            base: base.trim_end_matches('/').to_owned(),
            http,
            cache: Mutex::new(FxHashMap::default()),
            last_request: Mutex::new(None),
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    /// The route a flight is on, if the standing data knows the callsign and
    /// the aircraft's position fits. Never fails: no answer is `None`.
    pub async fn lookup(&self, callsign: &str, lat: f64, lon: f64) -> Option<Route> {
        if !self.enabled || !is_flight_callsign(callsign) {
            return None;
        }
        if let Some((at, airports)) = self.cache.lock().get(callsign)
            && at.elapsed() < CACHE_TTL
        {
            return airports.as_ref().and_then(|a| plausible_leg(a, lat, lon));
        }
        {
            let mut last = self.last_request.lock();
            if last.is_some_and(|t| t.elapsed() < MIN_INTERVAL) {
                return None;
            }
            *last = Some(Instant::now());
        }
        let url = format!("{}/{}/{}.json", self.base, &callsign[..2], callsign);
        let fetched = async {
            let response = self.http.get(&url).timeout(TIMEOUT).send().await.ok()?;
            // An unknown callsign is a definite answer worth caching; an error is not.
            if response.status().as_u16() == 404 {
                return Some(None);
            }
            if !response.status().is_success() {
                return None;
            }
            Some(parse_route(&response.bytes().await.ok()?).map(Arc::new))
        }
        .await?;
        let mut cache = self.cache.lock();
        if cache.len() >= CACHE_MAX {
            cache.retain(|_, (at, _)| at.elapsed() < CACHE_TTL / 4);
            if cache.len() >= CACHE_MAX {
                cache.clear();
            }
        }
        cache.insert(callsign.to_owned(), (Instant::now(), fetched.clone()));
        fetched.as_ref().and_then(|a| plausible_leg(a, lat, lon))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn airport(code: &str, lat: f64, lon: f64) -> Airport {
        Airport { code: code.into(), name: String::new(), lon, lat }
    }

    #[test]
    fn callsigns_that_look_like_flights() {
        assert!(is_flight_callsign("BAW834"));
        assert!(is_flight_callsign("EZY83TD"));
        assert!(is_flight_callsign("RYR1"));
        assert!(!is_flight_callsign("GATYS"), "a registration used as a callsign");
        assert!(!is_flight_callsign("N123AB"));
        assert!(!is_flight_callsign("BAW"));
        assert!(!is_flight_callsign("baw834"));
        assert!(!is_flight_callsign("BAW 834"));
        assert!(!is_flight_callsign("BAW834567"));
    }

    #[test]
    fn a_route_is_only_offered_when_the_aircraft_is_on_it() {
        let lhr = airport("LHR", 51.4706, -0.4619);
        let dub = airport("DUB", 53.4213, -6.2701);
        let route = [lhr.clone(), dub.clone()];
        // Over the Irish Sea, between the two.
        let leg = plausible_leg(&route, 53.0, -4.5).unwrap();
        assert_eq!((leg.origin.code.as_str(), leg.destination.code.as_str()), ("LHR", "DUB"));
        // Holding near Heathrow still counts.
        assert!(plausible_leg(&route, 51.3, -0.2).is_some());
        // The same flight number over Germany is some other flight.
        assert!(plausible_leg(&route, 50.0, 10.0).is_none());
    }

    #[test]
    fn the_right_leg_of_a_multi_stop_route_is_chosen() {
        let route = [airport("LHR", 51.47, -0.46), airport("SIN", 1.36, 103.99), airport("SYD", -33.95, 151.18)];
        let first = plausible_leg(&route, 40.0, 50.0).unwrap();
        assert_eq!((first.origin.code.as_str(), first.destination.code.as_str()), ("LHR", "SIN"));
        let second = plausible_leg(&route, -15.0, 125.0).unwrap();
        assert_eq!((second.origin.code.as_str(), second.destination.code.as_str()), ("SIN", "SYD"));
    }
}
