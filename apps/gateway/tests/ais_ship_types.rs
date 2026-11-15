//! The type name the gateway sends for every AIS ship-and-cargo type code.
//!
//! The expected table is `packages/schema/tests/fixtures/ais-ship-types.json`,
//! which the web app's tests also read: the web app picks a ship's 3D model
//! from these exact phrases, so a phrase changed here must change there too.

use std::path::PathBuf;

use orya_halo_gateway::model::ship_category;
use orya_halo_gateway::protocol::MetaKey;
use orya_halo_gateway::upstream::ais::{StaticData, ship_category as category_of, ship_type_name, static_data};
use orya_halo_gateway::upstream::{aisstream, digitraffic};
use serde::Deserialize;

#[derive(Deserialize)]
struct Table {
    types: Vec<Row>,
}

#[derive(Deserialize)]
struct Row {
    from: u32,
    to: u32,
    #[serde(rename = "typeName")]
    type_name: String,
    category: u8,
}

fn table() -> Vec<Row> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/schema/tests/fixtures/ais-ship-types.json");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str::<Table>(&text).expect("ais-ship-types.json").types
}

fn expected(code: u32) -> Option<(String, u8)> {
    table().into_iter().find(|r| (r.from..=r.to).contains(&code)).map(|r| (r.type_name, r.category))
}

const NOW: i64 = 1_794_670_570_000;

#[test]
fn every_code_has_the_documented_type_name() {
    for code in 0..=255u32 {
        assert_eq!(
            ship_type_name(code),
            expected(code).as_ref().map(|(n, _)| n.as_str()),
            "type name of AIS type {code}"
        );
    }
    // Out of the field's range altogether.
    assert_eq!(ship_type_name(256), None);
    assert_eq!(ship_type_name(u32::MAX), None);
}

#[test]
fn a_type_name_never_disagrees_with_the_category() {
    for code in 0..=255u32 {
        if let Some((_, category)) = expected(code) {
            assert_eq!(category_of(code), category, "category of AIS type {code}");
        }
    }
    // Codes with no name keep their category: reserved 56, 57 and 59 are still service craft.
    for code in [56, 57, 59] {
        assert_eq!(ship_type_name(code), None);
        assert_eq!(category_of(code), ship_category::SERVICE, "AIS type {code}");
    }
    for code in [38, 39] {
        assert_eq!(ship_type_name(code), None);
        assert_eq!(category_of(code), ship_category::UNKNOWN, "AIS type {code}");
    }
}

#[test]
fn static_data_carries_the_type_name_only_for_defined_codes() {
    for code in 0..=255u32 {
        let o = static_data(
            &StaticData { mmsi: 230_123_456, name: "TEST", ship_type: Some(code), ..Default::default() },
            NOW,
        )
        .expect("a named vessel is an observation");
        let name = o.meta.iter().find(|(k, _)| *k == MetaKey::TypeName).map(|(_, v)| v.as_str());
        assert_eq!(name, expected(code).as_ref().map(|(n, _)| n.as_str()), "AIS type {code}");
        assert_eq!(o.category, Some(category_of(code)));
    }
    // No type at all: neither a name nor a category.
    let o = static_data(&StaticData { mmsi: 230_123_456, name: "TEST", ..Default::default() }, NOW).unwrap();
    assert!(o.meta.iter().all(|(k, _)| *k != MetaKey::TypeName));
    assert_eq!(o.category, None);
}

fn fixture(name: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name);
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

fn type_name(o: &orya_halo_gateway::model::Observation) -> Option<&str> {
    o.meta.iter().find(|(k, _)| *k == MetaKey::TypeName).map(|(_, v)| v.as_str())
}

#[test]
fn recorded_feeds_carry_the_type_name() {
    // Digitraffic's REST snapshot: a tug (52), a rescue vessel (51), a yacht (36), a tanker, type 0.
    let vessels = digitraffic::parse_rest_vessels(&fixture("digitraffic_vessels.json"), NOW).unwrap();
    let names: Vec<Option<&str>> = vessels.iter().map(type_name).collect();
    for want in ["Tug", "Search and rescue vessel", "Sailing vessel", "Tanker", "Cargo ship", "Other type"] {
        assert!(names.contains(&Some(want)), "no {want:?} in {names:?}");
    }
    let mistral = vessels.iter().find(|o| o.id == 261_011_873).unwrap();
    assert_eq!(type_name(mistral), None, "type 0 is 'not available'");

    // AISStream's static data (type 70) and a class B report (a pleasure craft).
    match aisstream::parse_message(&fixture("aisstream_ship_static_data.json"), NOW).unwrap() {
        aisstream::Parsed::Observations(o) => assert_eq!(type_name(&o[0]), Some("Cargo ship")),
        other => panic!("expected observations, got {other:?}"),
    }
    match aisstream::parse_message(&fixture("aisstream_static_data_report.json"), NOW).unwrap() {
        aisstream::Parsed::Observations(o) => {
            assert!(matches!(type_name(&o[0]), Some("Sailing vessel" | "Pleasure craft")), "{:?}", type_name(&o[0]));
        }
        other => panic!("expected observations, got {other:?}"),
    }
}
