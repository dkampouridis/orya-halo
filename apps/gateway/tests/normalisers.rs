//! Normalisers against samples recorded from the real services.
//!
//! The files under `tests/fixtures` were captured on 2026-11-14 with one
//! request each and trimmed to a handful of entries:
//!
//! - `adsblol_point.json`: `GET https://api.adsb.lol/v2/point/51.47/-0.45/60`
//! - `adsbfi_v3.json`: `GET https://opendata.adsb.fi/api/v3/lat/60.32/lon/24.96/dist/80`
//! - `digitraffic_mqtt.bin`: raw MQTT bytes from `wss://meri.digitraffic.fi/mqtt`
//!   (CONNACK, SUBACK, then PUBLISH packets on the `vessels-v2` topics)
//! - `digitraffic_locations.json`, `digitraffic_vessels.json`: the REST snapshot endpoints
//! - `standing_data_route.json`: `GET https://vrs-standing-data.adsb.lol/routes/BA/BAW834.json`
//!
//! AISStream needs an API key, so its samples (`aisstream_*.json`) are built
//! from the message shapes in its documentation, not recorded.

use std::path::PathBuf;

use orya_halo_gateway::enrich;
use orya_halo_gateway::model::{Observation, aircraft_category, flag, ship_category};
use orya_halo_gateway::protocol::{HEADING_UNKNOWN, MetaKey};
use orya_halo_gateway::upstream::{aisstream, digitraffic, readsb};

fn fixture(name: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name);
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

fn fact(obs: &Observation, key: MetaKey) -> Option<&str> {
    obs.meta.iter().find(|(k, _)| *k == key).map(|(_, v)| v.as_str())
}

fn by_id(observations: &[Observation], id: u32) -> &Observation {
    observations.iter().find(|o| o.id == id).unwrap_or_else(|| panic!("no observation for {id:x}"))
}

// --- adsb.lol ---------------------------------------------------------------

#[test]
fn adsb_lol_sample_parses() {
    let parsed = readsb::parse(&fixture("adsblol_point.json"), 0).unwrap();
    assert_eq!(parsed.now_ms, 1_794_670_509_501, "the v2 API reports now in milliseconds");
    assert_eq!(parsed.listed, 14);
    assert_eq!(parsed.observations.len(), 14);
    for o in &parsed.observations {
        let fix = o.fix.expect("every sample aircraft has a position");
        assert!((50.0..53.0).contains(&fix.lat()) && (-3.0..2.0).contains(&fix.lon()), "{:x} is near London", o.id);
        assert!(fix.time_ms <= parsed.now_ms && fix.time_ms > parsed.now_ms - 120_000);
        assert!(o.category.is_some());
    }
}

#[test]
fn adsb_lol_airliner_on_the_ground() {
    let parsed = readsb::parse(&fixture("adsblol_point.json"), 0).unwrap();
    // BAW834, an A320-family aircraft taxiing at Heathrow.
    let o = by_id(&parsed.observations, 0x406250);
    let fix = o.fix.unwrap();
    assert_eq!(fact(o, MetaKey::Label), Some("BAW834"), "the callsign is trimmed");
    assert!(fact(o, MetaKey::Registration).is_some_and(|r| r.starts_with("G-")));
    assert_eq!(fact(o, MetaKey::Squawk), Some("6335"));
    assert_eq!(o.category, Some(aircraft_category::LARGE));
    assert_eq!(fix.flags & flag::STATIONARY, flag::STATIONARY, "alt_baro \"ground\" means on the ground");
    assert_eq!(fix.alt, 0);
}

#[test]
fn adsb_lol_categories_and_flags() {
    let parsed = readsb::parse(&fixture("adsblol_point.json"), 0).unwrap();
    let category = |id: u32| by_id(&parsed.observations, id).category.unwrap();
    assert_eq!(category(0x4016ac), aircraft_category::LIGHT, "A1");
    assert_eq!(category(0x407d0d), aircraft_category::MEDIUM, "A2");
    assert_eq!(category(0x400cd8), aircraft_category::LARGE, "A3");
    assert_eq!(category(0x39c48d), aircraft_category::HEAVY, "A5");
    assert_eq!(category(0x4011c4), aircraft_category::ROTORCRAFT, "A7");
    assert_eq!(category(0x404f10), aircraft_category::GLIDER, "B1");
    assert_eq!(category(0x40753e), aircraft_category::LIGHT, "B4 ultralight");
    assert_eq!(category(0x42592e), aircraft_category::SURFACE, "C2 service vehicle");
    assert_eq!(category(0x4ca4f0), aircraft_category::UNKNOWN, "A0");
    assert_eq!(category(0x4056e6), aircraft_category::UNKNOWN, "no category field");

    // A heavy at 41,000 ft: airborne, fast, not stationary.
    let heavy = by_id(&parsed.observations, 0x39c48d).fix.unwrap();
    assert_eq!(heavy.flags, 0);
    assert!(heavy.alt_m() > 11_000.0 && heavy.alt_m() < 13_500.0, "{}", heavy.alt_m());
    assert!(heavy.speed_mps() > 150.0, "{}", heavy.speed_mps());
    assert_ne!(heavy.heading, HEADING_UNKNOWN);

    // dbFlags 8 is LADD, not military: only bit 0 sets the military flag.
    assert_eq!(by_id(&parsed.observations, 0x4d2200).fix.unwrap().flags & flag::MILITARY, 0);
    // Nobody in the sample is squawking an emergency.
    assert!(parsed.observations.iter().all(|o| o.fix.unwrap().flags & flag::EMERGENCY == 0));
}

#[test]
fn an_emergency_squawk_in_a_real_record_sets_the_flag() {
    let text = String::from_utf8(fixture("adsblol_point.json")).unwrap();
    // The same record as recorded, with only the squawk changed.
    let altered = text.replace(r#""squawk":"6005""#, r#""squawk":"7700""#);
    assert_ne!(text, altered);
    let parsed = readsb::parse(altered.as_bytes(), 0).unwrap();
    let o = by_id(&parsed.observations, 0x400cd8);
    assert_eq!(o.fix.unwrap().flags, flag::EMERGENCY);
    assert_eq!(fact(o, MetaKey::Squawk), Some("7700"));
    let military = text.replace(r#""dbFlags":8"#, r#""dbFlags":1"#);
    let parsed = readsb::parse(military.as_bytes(), 0).unwrap();
    assert_eq!(by_id(&parsed.observations, 0x4d2200).fix.unwrap().flags, flag::MILITARY);
}

// --- adsb.fi ----------------------------------------------------------------

#[test]
fn adsb_fi_v3_sample_parses() {
    let parsed = readsb::parse(&fixture("adsbfi_v3.json"), 0).unwrap();
    assert_eq!(parsed.now_ms, 1_794_670_510_001);
    assert_eq!(parsed.observations.len(), 8);
    // FIN15, an A350 climbing out of Helsinki: adsb.fi includes the type description.
    let o = by_id(&parsed.observations, 0x461f4c);
    assert_eq!(fact(o, MetaKey::Label), Some("FIN15"));
    assert_eq!(fact(o, MetaKey::Registration), Some("OH-LWE"));
    assert_eq!(fact(o, MetaKey::TypeCode), Some("A359"));
    assert_eq!(fact(o, MetaKey::TypeName), Some("AIRBUS A-350-900"));
    assert_eq!(o.category, Some(aircraft_category::HEAVY));
    let fix = o.fix.unwrap();
    // Geometric altitude 25,975 ft; ground speed 367.4 kt; track 312.24; climbing 1184 ft/min.
    assert_eq!(fix.alt, 1039);
    assert_eq!(fix.speed, 1890);
    assert_eq!(fix.heading, 31224);
    assert_eq!(fix.vrate, 12);
    assert_eq!(fix.lat_e7, 611_121_480);
    assert_eq!(fix.lon_e7, 229_996_740);
    assert_eq!(fix.time_ms, 1_794_670_510_001 - 216);

    // A ground vehicle with no callsign still appears, as a surface object without a label.
    let vehicle = by_id(&parsed.observations, 0x5113fb);
    assert_eq!(fact(vehicle, MetaKey::Label), None);
    assert_eq!(vehicle.fix.unwrap().flags, flag::STATIONARY);
}

// --- Digitraffic ------------------------------------------------------------

/// Run the recorded MQTT byte stream through the decoder and the normaliser.
fn digitraffic_stream() -> (Vec<digitraffic::Packet>, Vec<Observation>) {
    let bytes = fixture("digitraffic_mqtt.bin");
    let mut decoder = digitraffic::Decoder::default();
    let mut packets = Vec::new();
    let mut observations = Vec::new();
    // Feed in awkward chunks, as a WebSocket would deliver them.
    for chunk in bytes.chunks(97) {
        decoder.feed(chunk);
        while let Some(packet) = decoder.next_packet().unwrap() {
            if let Some((topic, payload)) = packet.publish()
                && let Some(obs) = digitraffic::parse_message(topic, payload, 1_794_670_568_000).unwrap()
            {
                observations.push(obs);
            }
            packets.push(packet);
        }
    }
    (packets, observations)
}

#[test]
fn digitraffic_mqtt_stream_decodes() {
    let (packets, observations) = digitraffic_stream();
    assert_eq!(packets.len(), 42);
    assert_eq!(packets[0].kind, 2, "CONNACK first");
    assert_eq!(&packets[0].body[..], &[0, 0], "connection accepted");
    assert_eq!(packets[1].kind, 9, "then SUBACK");
    assert!(packets[2..].iter().all(|p| p.kind == 3));
    let topics: Vec<&str> = packets.iter().filter_map(|p| p.publish().map(|(topic, _)| topic)).collect();
    assert_eq!(topics.iter().filter(|t| t.ends_with("/location")).count(), 30);
    assert_eq!(topics.iter().filter(|t| t.ends_with("/metadata")).count(), 9);
    assert!(topics.contains(&"vessels-v2/status"));
    // Every location and metadata message yields something; the status message does not.
    assert_eq!(observations.len(), 39);
}

#[test]
fn digitraffic_location_message() {
    let (_, observations) = digitraffic_stream();
    // vessels-v2/257472880/location: cog 160.6, heading 326, sog 0.0, navStat 0, time 1794670563.
    let o = observations.iter().find(|o| o.id == 257_472_880 && o.fix.is_some()).unwrap();
    let fix = o.fix.unwrap();
    assert_eq!(fix.lat_e7, 638_278_530);
    assert_eq!(fix.lon_e7, 230_361_770);
    assert_eq!(fix.speed, 0);
    assert_eq!(fix.heading, 32600, "not moving, so the bow direction is used");
    assert_eq!(fix.time_ms, 1_794_670_563_000);
    assert_eq!(fix.flags, 0, "under way using engine, even at zero speed");
    assert_eq!(fact(o, MetaKey::NavStatus), Some("Under way using engine"));
    assert!(observations.iter().filter_map(|o| o.fix).all(|f| f.alt == 0 && f.vrate == 0));
}

#[test]
fn digitraffic_metadata_message() {
    let (_, observations) = digitraffic_stream();
    // The icebreaker Voima: type 90, 84 m long, draught 6.5 m, bound for Helsinki.
    let o = observations.iter().find(|o| o.id == 230_291_000 && o.fix.is_none()).unwrap();
    assert_eq!(fact(o, MetaKey::Label), Some("VOIMA"));
    assert_eq!(fact(o, MetaKey::Callsign), Some("OHLW"));
    assert_eq!(fact(o, MetaKey::Imo), Some("5383158"));
    assert_eq!(fact(o, MetaKey::Destination), Some("FIHEL"));
    assert_eq!(fact(o, MetaKey::LengthM), Some("84"));
    assert_eq!(fact(o, MetaKey::WidthM), Some("20"));
    assert_eq!(fact(o, MetaKey::DraughtM), Some("6.5"));
    assert_eq!(fact(o, MetaKey::Eta), Some("2026-10-08T13:00Z"));
    assert_eq!(o.category, Some(ship_category::OTHER));

    let cargo = observations.iter().find(|o| o.id == 538_009_355 && o.fix.is_none()).unwrap();
    assert_eq!(fact(cargo, MetaKey::Label), Some("SSI VIGILANT"));
    assert_eq!(cargo.category, Some(ship_category::CARGO));
    assert_eq!(fact(cargo, MetaKey::LengthM), Some("199"));
}

#[test]
fn digitraffic_rest_snapshot_parses() {
    let positions = digitraffic::parse_rest_locations(&fixture("digitraffic_locations.json")).unwrap();
    assert_eq!(positions.len(), 10);
    // The first feature: moored in Helsinki's South Harbour.
    let o = &positions[0];
    assert_eq!(o.id, 230_941_940);
    let fix = o.fix.unwrap();
    assert_eq!((fix.lon_e7, fix.lat_e7), (249_623_970, 601_717_920));
    assert_eq!(fix.flags, flag::STATIONARY);
    assert_eq!(fix.time_ms, 1_794_670_259_573, "REST timestamps are milliseconds");
    assert_eq!(fix.heading, 19400);
    assert_eq!(fact(o, MetaKey::NavStatus), Some("Moored"));

    let vessels = digitraffic::parse_rest_vessels(&fixture("digitraffic_vessels.json"), 1_794_670_568_000).unwrap();
    assert!(vessels.len() >= 10, "{}", vessels.len());
    let atlant = vessels.iter().find(|o| o.id == 273_274_080).unwrap();
    assert_eq!(fact(atlant, MetaKey::Label), Some("ATLANT"));
    assert_eq!(fact(atlant, MetaKey::Callsign), Some("UAIF6"));
    assert_eq!(fact(atlant, MetaKey::Imo), Some("9412995"));
    assert_eq!(fact(atlant, MetaKey::LengthM), Some("229"));
    assert_eq!(fact(atlant, MetaKey::WidthM), Some("42"));
    assert_eq!(fact(atlant, MetaKey::DraughtM), Some("10.3"));
    assert_eq!(atlant.category, Some(ship_category::TANKER));
    // MISTRAL reports IMO 0 and ship type 0: no IMO fact, unknown category.
    let mistral = vessels.iter().find(|o| o.id == 261_011_873).unwrap();
    assert_eq!(fact(mistral, MetaKey::Imo), None);
    assert_eq!(mistral.category, Some(ship_category::UNKNOWN));
}

// --- AISStream (documentation-shaped samples) -------------------------------

fn aisstream(name: &str, now_ms: i64) -> Vec<Observation> {
    match aisstream::parse_message(&fixture(name), now_ms).unwrap() {
        aisstream::Parsed::Observations(observations) => observations,
        other => panic!("expected observations, got {other:?}"),
    }
}

const AIS_NOW: i64 = 1_794_670_570_000;

#[test]
fn aisstream_position_report() {
    let observations = aisstream("aisstream_position_report.json", AIS_NOW);
    assert_eq!(observations.len(), 1);
    let o = &observations[0];
    assert_eq!(o.id, 368_207_620);
    let fix = o.fix.unwrap();
    assert_eq!((fix.lat_e7, fix.lon_e7), (257_617_000, -801_918_000));
    assert_eq!(fix.speed, 64, "12.4 kt is 6.4 m/s");
    assert_eq!(fix.heading, 8670, "under way: course over ground");
    assert_eq!(fix.flags, 0);
    assert_eq!(fix.time_ms, 1_794_670_564_000, "the envelope's time_utc");
    assert_eq!(fact(o, MetaKey::Label), Some("EXAMPLE VESSEL"));
    assert_eq!(fact(o, MetaKey::NavStatus), Some("Under way using engine"));
}

#[test]
fn aisstream_static_data() {
    let observations = aisstream("aisstream_ship_static_data.json", AIS_NOW);
    assert_eq!(observations.len(), 1);
    let o = &observations[0];
    assert!(o.fix.is_none());
    assert_eq!(o.category, Some(ship_category::CARGO));
    assert_eq!(fact(o, MetaKey::Label), Some("EXAMPLE VESSEL"));
    assert_eq!(fact(o, MetaKey::Callsign), Some("WDH1234"));
    assert_eq!(fact(o, MetaKey::Imo), Some("9123456"));
    assert_eq!(fact(o, MetaKey::LengthM), Some("180"));
    assert_eq!(fact(o, MetaKey::WidthM), Some("28"));
    assert_eq!(fact(o, MetaKey::DraughtM), Some("9.4"));
    assert_eq!(fact(o, MetaKey::Destination), Some("MIAMI"));
    assert_eq!(fact(o, MetaKey::Eta), Some("2026-11-16T06:30Z"));
}

#[test]
fn aisstream_class_b_reports() {
    // Class B sends no navigational status.
    let standard = aisstream("aisstream_class_b.json", AIS_NOW);
    assert_eq!(standard.len(), 1);
    assert_eq!(standard[0].id, 338_123_456);
    assert_eq!(fact(&standard[0], MetaKey::NavStatus), None);
    assert_eq!(standard[0].fix.unwrap().heading, HEADING_UNKNOWN, "heading 511 and course 360 are both unknown");

    // Part B of a static data report: type and callsign, no name.
    let report = aisstream("aisstream_static_data_report.json", AIS_NOW);
    assert_eq!(report.len(), 1);
    assert_eq!(report[0].category, Some(ship_category::PLEASURE));
    assert_eq!(fact(&report[0], MetaKey::Callsign), Some("WXY9876"));
    assert_eq!(fact(&report[0], MetaKey::Label), None);
    assert_eq!(fact(&report[0], MetaKey::LengthM), Some("12"));
}

// --- Routes -----------------------------------------------------------------

#[test]
fn standing_data_route_parses() {
    let airports = enrich::parse_route(&fixture("standing_data_route.json")).unwrap();
    assert_eq!(airports.len(), 2);
    assert_eq!(airports[0].code, "LHR");
    assert_eq!(airports[0].name, "London Heathrow Airport");
    assert_eq!(airports[1].code, "DUB");
    assert!((airports[1].lat - 53.421299).abs() < 1e-9);
    // BAW834 taxiing at Heathrow is plausibly on this route; over Paris it is not.
    assert!(enrich::plausible_leg(&airports, 51.47, -0.45).is_some());
    assert!(enrich::plausible_leg(&airports, 48.86, 2.35).is_none());
    assert!(enrich::parse_route(b"{}").is_none());
    assert!(enrich::parse_route(b"not json").is_none());
}
