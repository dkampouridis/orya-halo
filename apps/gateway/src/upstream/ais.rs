//! What every AIS feed has in common: turning position reports and static or
//! voyage data into observations, whatever JSON dialect they arrived in.
//! Field meanings follow ITU-R M.1371.

use crate::model::{Fix, Observation, flag, ship_category as cat};
use crate::protocol::MetaKey;

const KNOTS_TO_MPS: f64 = 0.514_444;

/// AIS ship-and-cargo type code to `ShipCategory`.
pub fn ship_category(ais_type: u32) -> u8 {
    match ais_type {
        30 => cat::FISHING,
        31..=34 => cat::SERVICE,
        35 => cat::MILITARY,
        36 | 37 => cat::PLEASURE,
        40..=49 => cat::HIGH_SPEED,
        // Pilots, search and rescue, tugs, tenders, anti-pollution, law enforcement, medical.
        50..=59 => cat::SERVICE,
        60..=69 => cat::PASSENGER,
        70..=79 => cat::CARGO,
        80..=89 => cat::TANKER,
        20..=29 | 90..=99 => cat::OTHER,
        _ => cat::UNKNOWN,
    }
}

/// Navigational status code as a short phrase, or `None` when undefined.
pub fn nav_status_name(status: u8) -> Option<&'static str> {
    Some(match status {
        0 => "Under way using engine",
        1 => "At anchor",
        2 => "Not under command",
        3 => "Restricted manoeuvrability",
        4 => "Constrained by draught",
        5 => "Moored",
        6 => "Aground",
        7 => "Engaged in fishing",
        8 => "Under way sailing",
        11 => "Towing astern",
        12 => "Pushing ahead or towing alongside",
        14 => "AIS-SART active",
        _ => return None,
    })
}

/// True for MMSIs that belong to vessels (maritime identification digits 2 to 7).
/// Base stations, aids to navigation and search-and-rescue aircraft are not ships.
pub fn is_vessel_mmsi(mmsi: u32) -> bool {
    (200_000_000..800_000_000).contains(&mmsi)
}

/// A class A or class B position report, in the units AIS decoders publish.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Position {
    pub mmsi: u32,
    pub lat: f64,
    pub lon: f64,
    /// Speed over ground, knots. 102.3 and above mean "not available".
    pub sog_knots: f64,
    /// Course over ground, degrees. 360 means "not available".
    pub cog: f64,
    /// True heading, degrees. 511 means "not available".
    pub heading: u32,
    /// Navigational status; `None` for class B, which does not send one.
    pub nav_status: Option<u8>,
    pub time_ms: i64,
}

/// Normalise a position report, or `None` when it carries no usable position.
pub fn position(p: &Position) -> Option<Observation> {
    if !is_vessel_mmsi(p.mmsi) {
        return None;
    }
    // AIS sends 91 and 181 for "position not available".
    if !(-90.0..=90.0).contains(&p.lat) || !(-180.0..=180.0).contains(&p.lon) {
        return None;
    }
    // Null Island is a GPS with no fix, not a ship in the Gulf of Guinea.
    if p.lat.abs() < 1e-4 && p.lon.abs() < 1e-4 {
        return None;
    }
    let sog = if (0.0..102.3).contains(&p.sog_knots) { p.sog_knots } else { 0.0 };
    let cog = (0.0..360.0).contains(&p.cog).then_some(p.cog);
    let heading = (p.heading < 360).then(|| f64::from(p.heading));
    // Course over ground is noise for a ship that is not moving; its bow
    // direction is the better thing to draw.
    let direction = if sog < 0.5 { heading.or(cog) } else { cog.or(heading) };

    let mut flags = 0u8;
    if matches!(p.nav_status, Some(1 | 5 | 6)) {
        flags |= flag::STATIONARY;
    }
    if p.nav_status == Some(14) {
        flags |= flag::EMERGENCY;
    }
    let mut obs = Observation::new(p.mmsi);
    obs.fix = Some(Fix::from_si(p.lon, p.lat, 0.0, direction, sog * KNOTS_TO_MPS, 0.0, flags, p.time_ms));
    if let Some(name) = p.nav_status.and_then(nav_status_name) {
        obs.fact(MetaKey::NavStatus, name);
    }
    Some(obs)
}

/// Static and voyage data (AIS messages 5, 19 and 24). Unknown values are zero or empty.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct StaticData<'a> {
    pub mmsi: u32,
    pub name: &'a str,
    pub callsign: &'a str,
    pub imo: u32,
    pub ship_type: Option<u32>,
    /// Distances from the position reference to bow, stern, port and starboard, metres.
    pub to_bow: u32,
    pub to_stern: u32,
    pub to_port: u32,
    pub to_starboard: u32,
    pub draught_m: f64,
    pub destination: &'a str,
    /// Month, day, hour, minute (UTC) as broadcast; zeros and 24/60 mean unknown.
    pub eta: Option<(u8, u8, u8, u8)>,
}

/// AIS pads text with `@` and spaces.
fn clean(text: &str) -> &str {
    text.trim_matches(|c: char| c == '@' || c.is_whitespace())
}

/// Normalise static and voyage data into facts. `now_ms` fixes the year of the ETA.
pub fn static_data(s: &StaticData<'_>, now_ms: i64) -> Option<Observation> {
    if !is_vessel_mmsi(s.mmsi) {
        return None;
    }
    let mut obs = Observation::new(s.mmsi);
    obs.fact(MetaKey::Label, clean(s.name));
    obs.fact(MetaKey::Callsign, clean(s.callsign));
    // IMO numbers are seven digits; anything else is a placeholder.
    if (1_000_000..=9_999_999).contains(&s.imo) {
        obs.fact(MetaKey::Imo, s.imo.to_string());
    }
    if let Some(ship_type) = s.ship_type {
        obs.category = Some(ship_category(ship_type));
    }
    let length = s.to_bow + s.to_stern;
    let width = s.to_port + s.to_starboard;
    // 511 and 63 are the "this big or bigger" ceilings of the two fields.
    if length > 0 && s.to_bow < 511 && s.to_stern < 511 {
        obs.fact(MetaKey::LengthM, length.to_string());
    }
    if width > 0 && s.to_port < 63 && s.to_starboard < 63 {
        obs.fact(MetaKey::WidthM, width.to_string());
    }
    if s.draught_m > 0.0 && s.draught_m < 25.5 {
        obs.fact(MetaKey::DraughtM, format!("{:.1}", s.draught_m));
    }
    obs.fact(MetaKey::Destination, clean(s.destination));
    if let Some((month, day, hour, minute)) = s.eta
        && let Some(eta) = eta_text(month, day, hour, minute, now_ms)
    {
        obs.fact(MetaKey::Eta, eta);
    }
    (!obs.meta.is_empty() || obs.category.is_some()).then_some(obs)
}

/// Unpack the 20-bit ETA field: month (4 bits), day (5), hour (5), minute (6).
pub fn unpack_eta(packed: u32) -> (u8, u8, u8, u8) {
    (((packed >> 16) & 0xF) as u8, ((packed >> 11) & 0x1F) as u8, ((packed >> 6) & 0x1F) as u8, (packed & 0x3F) as u8)
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: u8, day: u8) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let m = i64::from(month);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn year_of(days: i64) -> i64 {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let month_index = (5 * doy + 2) / 153;
    yoe + era * 400 + i64::from(month_index >= 10)
}

/// AIS broadcasts an ETA without a year. Give it the year that puts it
/// nearest to now, and format it as ISO 8601 UTC: `2026-11-15T08:00Z`, or
/// just the date when the time is unknown. `None` when month or day is unset.
pub fn eta_text(month: u8, day: u8, hour: u8, minute: u8, now_ms: i64) -> Option<String> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let today = now_ms.div_euclid(86_400_000);
    let this_year = year_of(today);
    let year = [this_year - 1, this_year, this_year + 1]
        .into_iter()
        .min_by_key(|y| (days_from_civil(*y, month, day) - today).abs())?;
    if hour < 24 && minute < 60 {
        Some(format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}Z"))
    } else {
        Some(format!("{year:04}-{month:02}-{day:02}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 2026-11-14T15:36:00Z
    const NOW: i64 = 1_794_670_560_000;

    #[test]
    fn ship_types_map_to_the_app_categories() {
        assert_eq!(ship_category(0), cat::UNKNOWN);
        assert_eq!(ship_category(30), cat::FISHING);
        assert_eq!(ship_category(31), cat::SERVICE);
        assert_eq!(ship_category(35), cat::MILITARY);
        assert_eq!(ship_category(36), cat::PLEASURE);
        assert_eq!(ship_category(37), cat::PLEASURE);
        assert_eq!(ship_category(40), cat::HIGH_SPEED);
        assert_eq!(ship_category(52), cat::SERVICE);
        assert_eq!(ship_category(60), cat::PASSENGER);
        assert_eq!(ship_category(69), cat::PASSENGER);
        assert_eq!(ship_category(70), cat::CARGO);
        assert_eq!(ship_category(84), cat::TANKER);
        assert_eq!(ship_category(90), cat::OTHER);
        assert_eq!(ship_category(20), cat::OTHER);
        assert_eq!(ship_category(100), cat::UNKNOWN);
        assert_eq!(ship_category(10), cat::UNKNOWN);
    }

    #[test]
    fn moored_and_anchored_ships_are_stationary() {
        let base = Position {
            mmsi: 230_123_456,
            lat: 60.1699,
            lon: 24.9384,
            sog_knots: 12.0,
            cog: 270.15,
            heading: 268,
            nav_status: Some(0),
            time_ms: NOW,
        };
        let under_way = position(&base).unwrap();
        let fix = under_way.fix.unwrap();
        assert_eq!(fix.flags, 0);
        assert_eq!(fix.heading, 27015, "a moving ship points along its course");
        assert_eq!(fix.speed, 62, "12 knots is 6.2 m/s");
        assert_eq!(fix.alt, 0);
        assert_eq!(fix.time_ms, NOW);
        assert!(under_way.meta.contains(&(MetaKey::NavStatus, "Under way using engine".to_owned())));

        for status in [1, 5, 6] {
            let o = position(&Position { nav_status: Some(status), sog_knots: 0.0, ..base }).unwrap();
            assert_eq!(o.fix.unwrap().flags, flag::STATIONARY, "status {status}");
            assert_eq!(o.fix.unwrap().heading, 26800, "a ship at rest points where its bow does");
        }
        let class_b = position(&Position { nav_status: None, ..base }).unwrap();
        assert!(class_b.meta.is_empty());
        let sart = position(&Position { nav_status: Some(14), ..base }).unwrap();
        assert_eq!(sart.fix.unwrap().flags, flag::EMERGENCY);
    }

    #[test]
    fn unavailable_values_are_recognised() {
        let base = Position {
            mmsi: 230_123_456,
            lat: 60.0,
            lon: 25.0,
            sog_knots: 102.3,
            cog: 360.0,
            heading: 511,
            nav_status: Some(15),
            time_ms: NOW,
        };
        let o = position(&base).unwrap();
        assert_eq!(o.fix.unwrap().speed, 0);
        assert_eq!(o.fix.unwrap().heading, crate::protocol::HEADING_UNKNOWN);
        assert!(o.meta.is_empty(), "status 15 is undefined");
        assert!(position(&Position { lat: 91.0, lon: 181.0, ..base }).is_none());
        assert!(position(&Position { lat: 0.0, lon: 0.0, ..base }).is_none());
        assert!(position(&Position { mmsi: 2_300_001, ..base }).is_none(), "a base station");
        assert!(position(&Position { mmsi: 992_301_234, ..base }).is_none(), "an aid to navigation");
        assert!(position(&Position { mmsi: 111_230_001, ..base }).is_none(), "a rescue aircraft");
    }

    #[test]
    fn static_data_becomes_facts() {
        let o = static_data(
            &StaticData {
                mmsi: 230_123_456,
                name: "SILJA SERENADE@@@@@",
                callsign: "OJCS  ",
                imo: 8_715_259,
                ship_type: Some(60),
                to_bow: 160,
                to_stern: 43,
                to_port: 16,
                to_starboard: 16,
                draught_m: 7.1,
                destination: " HELSINKI ",
                eta: Some((11, 15, 8, 0)),
            },
            NOW,
        )
        .unwrap();
        assert_eq!(o.category, Some(cat::PASSENGER));
        assert!(o.fix.is_none());
        let get = |key| o.meta.iter().find(|(k, _)| *k == key).map(|(_, v)| v.as_str());
        assert_eq!(get(MetaKey::Label), Some("SILJA SERENADE"));
        assert_eq!(get(MetaKey::Callsign), Some("OJCS"));
        assert_eq!(get(MetaKey::Imo), Some("8715259"));
        assert_eq!(get(MetaKey::LengthM), Some("203"));
        assert_eq!(get(MetaKey::WidthM), Some("32"));
        assert_eq!(get(MetaKey::DraughtM), Some("7.1"));
        assert_eq!(get(MetaKey::Destination), Some("HELSINKI"));
        assert_eq!(get(MetaKey::Eta), Some("2026-11-15T08:00Z"));
    }

    #[test]
    fn empty_static_data_is_dropped() {
        assert!(static_data(&StaticData { mmsi: 230_123_456, ..Default::default() }, NOW).is_none());
        assert!(static_data(&StaticData { mmsi: 5, name: "X", ..Default::default() }, NOW).is_none());
        let o = static_data(
            &StaticData { mmsi: 230_123_456, imo: 0, name: "@@@", ship_type: Some(0), ..Default::default() },
            NOW,
        )
        .unwrap();
        assert!(o.meta.is_empty());
        assert_eq!(o.category, Some(cat::UNKNOWN));
    }

    #[test]
    fn eta_gets_the_nearest_year() {
        assert_eq!(unpack_eta(672_576), (10, 8, 13, 0));
        assert_eq!(unpack_eta(741_440), (11, 10, 1, 0));
        assert_eq!(eta_text(11, 15, 8, 0, NOW).as_deref(), Some("2026-11-15T08:00Z"));
        // A January arrival seen in November is next year; a December one seen in January was last year.
        assert_eq!(eta_text(1, 3, 12, 30, NOW).as_deref(), Some("2027-01-03T12:30Z"));
        let january_2027 = NOW + 60 * 86_400_000;
        assert_eq!(eta_text(12, 20, 6, 0, january_2027).as_deref(), Some("2026-12-20T06:00Z"));
        assert_eq!(eta_text(11, 20, 24, 60, NOW).as_deref(), Some("2026-11-20"), "time unknown");
        assert_eq!(eta_text(0, 0, 24, 60, NOW), None);
        assert_eq!(eta_text(13, 1, 0, 0, NOW), None);
    }

    #[test]
    fn civil_date_helpers_agree_with_known_dates() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 3, 1), 11_017);
        assert_eq!(days_from_civil(2026, 11, 14), NOW / 86_400_000);
        assert_eq!(year_of(0), 1970);
        assert_eq!(year_of(days_from_civil(2026, 12, 31)), 2026);
        assert_eq!(year_of(days_from_civil(2027, 1, 1)), 2027);
        assert_eq!(year_of(days_from_civil(2024, 2, 29)), 2024);
    }
}
