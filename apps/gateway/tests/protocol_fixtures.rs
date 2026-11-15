//! Byte-for-byte parity with the TypeScript codec.
//!
//! The content of every golden file in `packages/schema/fixtures` is rebuilt
//! here from the same values as `packages/schema/scripts/fixtures.ts`, encoded
//! with the Rust codec and compared with the bytes on disk. The decoder is
//! then run over the same files.

use std::path::PathBuf;

use orya_halo_gateway::protocol::*;

const FIXTURE_TIME_MS: f64 = 1_794_000_000_123.0;
const AIRCRAFT: u8 = 1;
const SHIP: u8 = 2;

fn fixture(name: &str) -> Vec<u8> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/schema/fixtures").join(format!("{name}.bin"));
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

fn aircraft_rows() -> Vec<UpsertRow> {
    vec![
        UpsertRow {
            id: 0x4ca7b5,
            lon_e7: -3_456_789,
            lat_e7: 515_074_000,
            alt: 1400,
            heading: 9_050,
            speed: 2_345,
            vrate: -12,
            age: 0,
            category: 4,
            flags: 0,
        },
        UpsertRow {
            id: 0xa1b2c3,
            lon_e7: 1_800_000_000,
            lat_e7: -338_688_000,
            alt: -4,
            heading: 0,
            speed: 0,
            vrate: 0,
            age: 3,
            category: 1,
            flags: 1,
        },
        UpsertRow {
            id: 0x000001,
            lon_e7: -1_800_000_000,
            lat_e7: 900_000_000,
            alt: 32767,
            heading: 0xffff,
            speed: 65_535,
            vrate: 127,
            age: 255,
            category: 0,
            flags: 0b1010,
        },
    ]
}

fn ship_rows() -> Vec<UpsertRow> {
    vec![UpsertRow {
        id: 230_123_456,
        lon_e7: 249_384_000,
        lat_e7: 601_699_000,
        alt: 0,
        heading: 27_015,
        speed: 62,
        vrate: 0,
        age: 12,
        category: 3,
        flags: 0,
    }]
}

fn meta_records() -> Vec<MetaRecord> {
    vec![
        MetaRecord {
            id: 0x4ca7b5,
            fields: vec![
                (MetaKey::Label, "EIN4KD".into()),
                (MetaKey::Registration, "EI-DVM".into()),
                (MetaKey::TypeCode, "A320".into()),
                (MetaKey::Operator, "Aer Lingus".into()),
            ],
        },
        MetaRecord {
            id: 0xa1b2c3,
            fields: vec![(MetaKey::Label, "Zürich ✈ 東京".into()), (MetaKey::Squawk, "7700".into())],
        },
        MetaRecord { id: 7, fields: vec![] },
    ]
}

fn density_rows() -> Vec<DensityRow> {
    vec![
        DensityRow { cell: 0x0820007f_ffffffff, lon: -122.5, lat: 37.75, count: 42 },
        DensityRow { cell: 0x08283473_1fffffff, lon: 2.25, lat: 48.875, count: 100_000 },
    ]
}

fn stats_entries() -> Vec<StatsEntry> {
    vec![StatsEntry { kind: AIRCRAFT, status: 1, total: 12_345 }, StatsEntry { kind: SHIP, status: 3, total: 0 }]
}

fn events() -> Vec<HaloEvent> {
    vec![HaloEvent {
        id: "emergency-4ca7b5".into(),
        topic: "emergency".into(),
        time_ms: 1_794_000_000_123,
        title: "EIN4KD is squawking 7700 over the Irish Sea".into(),
        detail: None,
        lon: Some(-5.1),
        lat: Some(53.4),
        entity: Some(EventRef { kind: AIRCRAFT, id: 0x4ca7b5 }),
        severity: Some(2),
    }]
}

#[test]
fn encoder_reproduces_upsert_aircraft() {
    assert_eq!(encode_upsert(AIRCRAFT, FIXTURE_TIME_MS, true, &aircraft_rows()), fixture("upsert-aircraft"));
}

#[test]
fn encoder_reproduces_upsert_ship_delta() {
    assert_eq!(encode_upsert(SHIP, FIXTURE_TIME_MS + 1000.0, false, &ship_rows()), fixture("upsert-ship-delta"));
}

#[test]
fn encoder_reproduces_upsert_empty() {
    assert_eq!(encode_upsert(AIRCRAFT, FIXTURE_TIME_MS, true, &[]), fixture("upsert-empty"));
}

#[test]
fn encoder_reproduces_remove() {
    assert_eq!(encode_remove(AIRCRAFT, FIXTURE_TIME_MS, &[0x4ca7b5, 0xffff_ffff]), fixture("remove"));
}

#[test]
fn encoder_reproduces_meta() {
    assert_eq!(encode_meta(AIRCRAFT, FIXTURE_TIME_MS, &meta_records()), fixture("meta"));
}

#[test]
fn encoder_reproduces_density() {
    assert_eq!(encode_density(SHIP, FIXTURE_TIME_MS, 2, &density_rows()), fixture("density"));
}

#[test]
fn encoder_reproduces_stats() {
    assert_eq!(encode_stats(FIXTURE_TIME_MS, &stats_entries()), fixture("stats"));
}

#[test]
fn encoder_reproduces_events() {
    assert_eq!(encode_events(FIXTURE_TIME_MS, &events()), fixture("events"));
}

#[test]
fn decoder_reads_upserts() {
    let Frame::Upsert { header, full, rows } = decode_frame(&fixture("upsert-aircraft")).unwrap() else {
        panic!("not an upsert");
    };
    assert_eq!(header.kind, AIRCRAFT);
    assert_eq!(header.time_ms, FIXTURE_TIME_MS);
    assert_eq!(header.flags, FRAME_FLAG_FULL);
    assert!(full);
    assert_eq!(rows, aircraft_rows());

    let Frame::Upsert { header, full, rows } = decode_frame(&fixture("upsert-ship-delta")).unwrap() else {
        panic!("not an upsert");
    };
    assert_eq!(header.kind, SHIP);
    assert_eq!(header.time_ms, FIXTURE_TIME_MS + 1000.0);
    assert!(!full);
    assert_eq!(rows, ship_rows());

    let Frame::Upsert { header, full, rows } = decode_frame(&fixture("upsert-empty")).unwrap() else {
        panic!("not an upsert");
    };
    assert_eq!(header.count, 0);
    assert!(full);
    assert!(rows.is_empty());
}

#[test]
fn decoder_reads_remove() {
    let Frame::Remove { header, ids } = decode_frame(&fixture("remove")).unwrap() else { panic!("not a remove") };
    assert_eq!(header.kind, AIRCRAFT);
    assert_eq!(ids, vec![0x4ca7b5, 0xffff_ffff]);
}

#[test]
fn decoder_reads_meta() {
    let Frame::Meta { header, records } = decode_frame(&fixture("meta")).unwrap() else { panic!("not meta") };
    assert_eq!(header.count, 3);
    assert_eq!(records, meta_records());
}

#[test]
fn decoder_reads_density() {
    let Frame::Density { header, res, rows } = decode_frame(&fixture("density")).unwrap() else {
        panic!("not density");
    };
    assert_eq!(header.kind, SHIP);
    assert_eq!(header.aux, 2);
    assert_eq!(res, 2);
    assert_eq!(rows, density_rows());
}

#[test]
fn decoder_reads_stats() {
    let Frame::Stats { header, entries } = decode_frame(&fixture("stats")).unwrap() else { panic!("not stats") };
    assert_eq!(header.kind, 0);
    assert_eq!(entries, stats_entries());
}

#[test]
fn decoder_reads_events() {
    let Frame::Events { header, events: decoded } = decode_frame(&fixture("events")).unwrap() else {
        panic!("not events");
    };
    assert_eq!(header.count, 1);
    assert_eq!(decoded, events());
}

#[test]
fn compressed_fixtures_decode_to_the_same_frames() {
    for name in ["upsert-aircraft", "meta", "density", "events"] {
        let raw = fixture(name);
        // Small frames may not shrink; when they do, the result must decode identically.
        if let Some(packed) = deflate_frame(&raw, 6) {
            assert_eq!(inflate_frame(&packed).unwrap(), raw, "{name}");
            assert_eq!(decode_frame(&packed).unwrap(), decode_frame(&raw).unwrap(), "{name}");
        }
    }
}
