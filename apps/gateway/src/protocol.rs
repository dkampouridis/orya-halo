//! Halo wire protocol, version 1. Specification: `docs/PROTOCOL.md`.
//!
//! This is the Rust twin of `packages/schema/src/protocol.ts`. Both are tested
//! against the golden files in `packages/schema/fixtures`; if the two ever
//! disagree, the fixtures are right.
//!
//! Frames are little-endian and columnar: all values of one field, then all
//! values of the next. Every frame starts with a 24-byte header.

use std::io::{Read, Write};

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u8 = 1;
pub const FRAME_MAGIC: u8 = 0x48;
pub const HEADER_BYTES: usize = 24;

pub const UPSERT_RECORD_BYTES: usize = 22;
pub const DENSITY_RECORD_BYTES: usize = 20;
pub const STATS_RECORD_BYTES: usize = 8;

/// Header flag: an Upsert that is the complete set for the subscription.
pub const FRAME_FLAG_FULL: u16 = 0x0001;
/// Header flag: everything after the 24-byte header is raw DEFLATE (RFC 1951).
/// Only sent to connections that asked for it with `?z=1`.
pub const FRAME_FLAG_DEFLATE: u16 = 0x0002;

/// Longest Meta field value in bytes; longer strings are cut at a character boundary.
pub const META_MAX_FIELD_BYTES: usize = 255;

pub const LONLAT_SCALE: f64 = 1e7;
pub const ALT_UNIT_M: f64 = 7.62;
pub const HEADING_SCALE: f64 = 100.0;
pub const HEADING_UNKNOWN: u16 = 0xFFFF;
pub const SPEED_UNIT_MPS: f64 = 0.1;
pub const VRATE_UNIT_MPS: f64 = 0.5;
pub const AGE_SATURATED_S: u8 = 255;

/// Frame type byte.
pub mod frame_type {
    pub const UPSERT: u8 = 1;
    pub const REMOVE: u8 = 2;
    pub const META: u8 = 3;
    pub const DENSITY: u8 = 4;
    pub const STATS: u8 = 5;
    pub const EVENTS: u8 = 6;
}

/// Keys of the type-length-value fields in a Meta frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u8)]
pub enum MetaKey {
    Label = 1,
    Registration = 2,
    TypeCode = 3,
    TypeName = 4,
    Operator = 5,
    Origin = 6,
    Destination = 7,
    Country = 8,
    Squawk = 9,
    Imo = 10,
    Callsign = 11,
    LengthM = 12,
    WidthM = 13,
    DraughtM = 14,
    NavStatus = 15,
    Eta = 16,
    Source = 17,
}

impl MetaKey {
    pub const ALL: [MetaKey; 17] = [
        MetaKey::Label,
        MetaKey::Registration,
        MetaKey::TypeCode,
        MetaKey::TypeName,
        MetaKey::Operator,
        MetaKey::Origin,
        MetaKey::Destination,
        MetaKey::Country,
        MetaKey::Squawk,
        MetaKey::Imo,
        MetaKey::Callsign,
        MetaKey::LengthM,
        MetaKey::WidthM,
        MetaKey::DraughtM,
        MetaKey::NavStatus,
        MetaKey::Eta,
        MetaKey::Source,
    ];

    pub fn from_u8(key: u8) -> Option<MetaKey> {
        MetaKey::ALL.get(usize::from(key).wrapping_sub(1)).copied()
    }

    /// Field name as used by the TypeScript codec and the HTTP JSON.
    pub fn name(self) -> &'static str {
        match self {
            MetaKey::Label => "label",
            MetaKey::Registration => "registration",
            MetaKey::TypeCode => "typeCode",
            MetaKey::TypeName => "typeName",
            MetaKey::Operator => "operator",
            MetaKey::Origin => "origin",
            MetaKey::Destination => "destination",
            MetaKey::Country => "country",
            MetaKey::Squawk => "squawk",
            MetaKey::Imo => "imo",
            MetaKey::Callsign => "callsign",
            MetaKey::LengthM => "lengthM",
            MetaKey::WidthM => "widthM",
            MetaKey::DraughtM => "draughtM",
            MetaKey::NavStatus => "navStatus",
            MetaKey::Eta => "eta",
            MetaKey::Source => "source",
        }
    }
}

/// One line in the live ticker. Field order matches the TypeScript interface so
/// both encoders produce the same JSON.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HaloEvent {
    /// Stable id, so repeated reports of the same event collapse.
    pub id: String,
    /// What kind of thing happened, e.g. "emergency".
    pub topic: String,
    #[serde(rename = "timeMs")]
    pub time_ms: i64,
    /// One plain sentence, ready to show.
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lon: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lat: Option<f64>,
    /// Entity to select when the event is clicked.
    #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
    pub entity: Option<EventRef>,
    /// 0 routine, 1 notable, 2 major.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub severity: Option<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventRef {
    pub kind: u8,
    pub id: u32,
}

/// One entity in an Upsert frame, in wire units.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct UpsertRow {
    pub id: u32,
    pub lon_e7: i32,
    pub lat_e7: i32,
    pub alt: i16,
    pub heading: u16,
    pub speed: u16,
    pub vrate: i8,
    pub age: u8,
    pub category: u8,
    pub flags: u8,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DensityRow {
    /// H3 cell index.
    pub cell: u64,
    /// Cell centre, degrees.
    pub lon: f32,
    pub lat: f32,
    pub count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StatsEntry {
    pub kind: u8,
    pub status: u8,
    pub total: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetaRecord {
    pub id: u32,
    /// Known fields only, in ascending key order.
    pub fields: Vec<(MetaKey, String)>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FrameHeader {
    pub frame_type: u8,
    pub kind: u8,
    pub flags: u16,
    pub time_ms: f64,
    pub count: u32,
    pub aux: u32,
}

/// A decoded server frame.
#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Upsert { header: FrameHeader, full: bool, rows: Vec<UpsertRow> },
    Remove { header: FrameHeader, ids: Vec<u32> },
    Meta { header: FrameHeader, records: Vec<MetaRecord> },
    Density { header: FrameHeader, res: u8, rows: Vec<DensityRow> },
    Stats { header: FrameHeader, entries: Vec<StatsEntry> },
    Events { header: FrameHeader, events: Vec<HaloEvent> },
}

impl Frame {
    pub fn header(&self) -> &FrameHeader {
        match self {
            Frame::Upsert { header, .. }
            | Frame::Remove { header, .. }
            | Frame::Meta { header, .. }
            | Frame::Density { header, .. }
            | Frame::Stats { header, .. }
            | Frame::Events { header, .. } => header,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    TooShort,
    BadMagic,
    UnsupportedVersion(u8),
    Truncated(&'static str),
    UnknownFrameType(u8),
    BadEvents,
    BadDeflate,
}

impl std::fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProtocolError::TooShort => write!(f, "frame shorter than its header"),
            ProtocolError::BadMagic => write!(f, "bad frame magic"),
            ProtocolError::UnsupportedVersion(v) => write!(f, "unsupported protocol version {v}"),
            ProtocolError::Truncated(what) => write!(f, "{what} frame truncated"),
            ProtocolError::UnknownFrameType(t) => write!(f, "unknown frame type {t}"),
            ProtocolError::BadEvents => write!(f, "events frame is not a JSON array of events"),
            ProtocolError::BadDeflate => write!(f, "frame body is not valid DEFLATE"),
        }
    }
}

impl std::error::Error for ProtocolError {}

// ---------------------------------------------------------------------------
// Quantisation: SI units to wire units. Rounding mirrors JavaScript's
// `Math.round` (halves go towards positive infinity) so both codecs agree.
// ---------------------------------------------------------------------------

/// `Math.round` as JavaScript defines it.
#[inline]
pub fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

#[inline]
fn clamp_round(value: f64, lo: f64, hi: f64) -> f64 {
    if value.is_nan() {
        return 0.0;
    }
    js_round(value).clamp(lo, hi)
}

/// Degrees east to `i32` degrees × 1e7, clamped to ±180.
#[inline]
pub fn quantise_lon(degrees: f64) -> i32 {
    clamp_round(degrees * LONLAT_SCALE, -1_800_000_000.0, 1_800_000_000.0) as i32
}

/// Degrees north to `i32` degrees × 1e7, clamped to ±90.
#[inline]
pub fn quantise_lat(degrees: f64) -> i32 {
    clamp_round(degrees * LONLAT_SCALE, -900_000_000.0, 900_000_000.0) as i32
}

/// Metres to units of 7.62 m (25 ft), clamped to the `i16` range.
#[inline]
pub fn quantise_alt(metres: f64) -> i16 {
    clamp_round(metres / ALT_UNIT_M, -32768.0, 32767.0) as i16
}

/// Degrees clockwise from north to degrees × 100 in `0..36000`. `None` or NaN is `0xFFFF`.
#[inline]
pub fn quantise_heading(degrees: Option<f64>) -> u16 {
    match degrees {
        Some(d) if d.is_finite() => {
            let wrapped = ((d % 360.0) + 360.0) % 360.0;
            (js_round(wrapped * HEADING_SCALE) as u32 % 36000) as u16
        }
        _ => HEADING_UNKNOWN,
    }
}

/// Metres per second to units of 0.1 m/s, clamped to the `u16` range.
#[inline]
pub fn quantise_speed(mps: f64) -> u16 {
    clamp_round(mps / SPEED_UNIT_MPS, 0.0, 65535.0) as u16
}

/// Metres per second (positive up) to units of 0.5 m/s, clamped to ±127.
#[inline]
pub fn quantise_vrate(mps: f64) -> i8 {
    clamp_round(mps / VRATE_UNIT_MPS, -127.0, 127.0) as i8
}

/// Whole seconds between a fix and the frame time, saturating at 255.
#[inline]
pub fn quantise_age(frame_time_ms: i64, fix_time_ms: i64) -> u8 {
    let delta = frame_time_ms.saturating_sub(fix_time_ms);
    if delta <= 0 {
        return 0;
    }
    // Integer form of Math.round(delta / 1000).
    let seconds = (delta + 500) / 1000;
    seconds.min(i64::from(AGE_SATURATED_S)) as u8
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

fn write_header(out: &mut Vec<u8>, frame_type: u8, kind: u8, flags: u16, time_ms: f64, count: u32, aux: u32) {
    out.push(FRAME_MAGIC);
    out.push(PROTOCOL_VERSION);
    out.push(frame_type);
    out.push(kind);
    out.extend_from_slice(&flags.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&time_ms.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&aux.to_le_bytes());
}

/// Encode an Upsert frame. `full` marks it as the complete set for the subscription.
pub fn encode_upsert(kind: u8, time_ms: f64, full: bool, rows: &[UpsertRow]) -> Vec<u8> {
    let n = rows.len();
    let mut out = Vec::with_capacity(HEADER_BYTES + n * UPSERT_RECORD_BYTES);
    let flags = if full { FRAME_FLAG_FULL } else { 0 };
    write_header(&mut out, frame_type::UPSERT, kind, flags, time_ms, n as u32, 0);
    for r in rows {
        out.extend_from_slice(&r.id.to_le_bytes());
    }
    for r in rows {
        out.extend_from_slice(&r.lon_e7.to_le_bytes());
    }
    for r in rows {
        out.extend_from_slice(&r.lat_e7.to_le_bytes());
    }
    for r in rows {
        out.extend_from_slice(&r.alt.to_le_bytes());
    }
    for r in rows {
        out.extend_from_slice(&r.heading.to_le_bytes());
    }
    for r in rows {
        out.extend_from_slice(&r.speed.to_le_bytes());
    }
    out.extend(rows.iter().map(|r| r.vrate as u8));
    out.extend(rows.iter().map(|r| r.age));
    out.extend(rows.iter().map(|r| r.category));
    out.extend(rows.iter().map(|r| r.flags));
    out
}

/// Encode a Remove frame.
pub fn encode_remove(kind: u8, time_ms: f64, ids: &[u32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_BYTES + ids.len() * 4);
    write_header(&mut out, frame_type::REMOVE, kind, 0, time_ms, ids.len() as u32, 0);
    for id in ids {
        out.extend_from_slice(&id.to_le_bytes());
    }
    out
}

/// Cut `text` to at most 255 bytes without splitting a character.
pub fn truncate_meta_value(text: &str) -> &str {
    if text.len() <= META_MAX_FIELD_BYTES {
        return text;
    }
    let mut end = META_MAX_FIELD_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Incremental Meta frame writer, so the hub can stream records straight from
/// the entity table without building intermediate `MetaRecord`s.
pub struct MetaWriter {
    out: Vec<u8>,
    count: u32,
}

impl MetaWriter {
    pub fn new(kind: u8, time_ms: f64) -> Self {
        let mut out = Vec::with_capacity(HEADER_BYTES + 256);
        write_header(&mut out, frame_type::META, kind, 0, time_ms, 0, 0);
        Self { out, count: 0 }
    }

    /// Append one record. `fields` must already be in ascending key order; at
    /// most 255 fields are written.
    pub fn record<'a>(&mut self, id: u32, fields: impl IntoIterator<Item = (MetaKey, &'a str)>) {
        self.out.extend_from_slice(&id.to_le_bytes());
        let count_at = self.out.len();
        self.out.push(0);
        let mut field_count = 0u8;
        for (key, value) in fields {
            if field_count == u8::MAX {
                break;
            }
            let value = truncate_meta_value(value);
            self.out.push(key as u8);
            self.out.push(value.len() as u8);
            self.out.extend_from_slice(value.as_bytes());
            field_count += 1;
        }
        self.out[count_at] = field_count;
        self.count += 1;
    }

    pub fn count(&self) -> u32 {
        self.count
    }

    pub fn finish(mut self) -> Vec<u8> {
        self.out[16..20].copy_from_slice(&self.count.to_le_bytes());
        self.out
    }
}

/// Encode a Meta frame. Fields are sorted by key, as the specification requires.
pub fn encode_meta(kind: u8, time_ms: f64, records: &[MetaRecord]) -> Vec<u8> {
    let mut writer = MetaWriter::new(kind, time_ms);
    for record in records {
        let mut fields: Vec<(MetaKey, &str)> = record.fields.iter().map(|(k, v)| (*k, v.as_str())).collect();
        fields.sort_by_key(|(k, _)| *k);
        writer.record(record.id, fields);
    }
    writer.finish()
}

/// Encode a Density frame for cells at H3 resolution `res`.
pub fn encode_density(kind: u8, time_ms: f64, res: u8, rows: &[DensityRow]) -> Vec<u8> {
    let n = rows.len();
    let mut out = Vec::with_capacity(HEADER_BYTES + n * DENSITY_RECORD_BYTES);
    write_header(&mut out, frame_type::DENSITY, kind, 0, time_ms, n as u32, u32::from(res));
    for r in rows {
        out.extend_from_slice(&(r.cell as u32).to_le_bytes());
    }
    for r in rows {
        out.extend_from_slice(&((r.cell >> 32) as u32).to_le_bytes());
    }
    for r in rows {
        out.extend_from_slice(&r.lon.to_le_bytes());
    }
    for r in rows {
        out.extend_from_slice(&r.lat.to_le_bytes());
    }
    for r in rows {
        out.extend_from_slice(&r.count.to_le_bytes());
    }
    out
}

/// Encode a Stats frame.
pub fn encode_stats(time_ms: f64, entries: &[StatsEntry]) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_BYTES + entries.len() * STATS_RECORD_BYTES);
    write_header(&mut out, frame_type::STATS, 0, 0, time_ms, entries.len() as u32, 0);
    for e in entries {
        out.push(e.kind);
        out.push(e.status);
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&e.total.to_le_bytes());
    }
    out
}

/// Encode an Events frame: a UTF-8 JSON array after the header.
pub fn encode_events(time_ms: f64, events: &[HaloEvent]) -> Vec<u8> {
    let body = serde_json::to_vec(events).expect("events serialise");
    let mut out = Vec::with_capacity(HEADER_BYTES + body.len());
    write_header(&mut out, frame_type::EVENTS, 0, 0, time_ms, events.len() as u32, 0);
    out.extend_from_slice(&body);
    out
}

// ---------------------------------------------------------------------------
// Frame-level compression
// ---------------------------------------------------------------------------

/// Compress a frame's body with raw DEFLATE and set [`FRAME_FLAG_DEFLATE`].
///
/// Returns `None` when the frame is already compressed or would not shrink, in
/// which case the caller sends the original. The header stays readable so a
/// client can route the frame before inflating it.
pub fn deflate_frame(frame: &[u8], level: u32) -> Option<Vec<u8>> {
    if frame.len() <= HEADER_BYTES {
        return None;
    }
    let flags = u16::from_le_bytes([frame[4], frame[5]]);
    if flags & FRAME_FLAG_DEFLATE != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(HEADER_BYTES + frame.len() / 2);
    out.extend_from_slice(&frame[..HEADER_BYTES]);
    let mut encoder = flate2::write::DeflateEncoder::new(out, flate2::Compression::new(level));
    encoder.write_all(&frame[HEADER_BYTES..]).ok()?;
    let mut out = encoder.finish().ok()?;
    if out.len() >= frame.len() {
        return None;
    }
    out[4..6].copy_from_slice(&(flags | FRAME_FLAG_DEFLATE).to_le_bytes());
    Some(out)
}

/// Undo [`deflate_frame`]: same header with the flag cleared, inflated body.
/// Frames without the flag are returned unchanged.
pub fn inflate_frame(frame: &[u8]) -> Result<Vec<u8>, ProtocolError> {
    if frame.len() < HEADER_BYTES {
        return Err(ProtocolError::TooShort);
    }
    let flags = u16::from_le_bytes([frame[4], frame[5]]);
    if flags & FRAME_FLAG_DEFLATE == 0 {
        return Ok(frame.to_vec());
    }
    let mut out = Vec::with_capacity(frame.len() * 3);
    out.extend_from_slice(&frame[..HEADER_BYTES]);
    flate2::read::DeflateDecoder::new(&frame[HEADER_BYTES..])
        .read_to_end(&mut out)
        .map_err(|_| ProtocolError::BadDeflate)?;
    out[4..6].copy_from_slice(&(flags & !FRAME_FLAG_DEFLATE).to_le_bytes());
    Ok(out)
}

// ---------------------------------------------------------------------------
// Decoding (used by tests, the load check and any Rust client)
// ---------------------------------------------------------------------------

/// Read and validate the 24-byte header.
pub fn read_header(buf: &[u8]) -> Result<FrameHeader, ProtocolError> {
    if buf.len() < HEADER_BYTES {
        return Err(ProtocolError::TooShort);
    }
    if buf[0] != FRAME_MAGIC {
        return Err(ProtocolError::BadMagic);
    }
    if buf[1] != PROTOCOL_VERSION {
        return Err(ProtocolError::UnsupportedVersion(buf[1]));
    }
    Ok(FrameHeader {
        frame_type: buf[2],
        kind: buf[3],
        flags: u16::from_le_bytes([buf[4], buf[5]]),
        time_ms: f64::from_le_bytes(buf[8..16].try_into().expect("8 bytes")),
        count: u32::from_le_bytes(buf[16..20].try_into().expect("4 bytes")),
        aux: u32::from_le_bytes(buf[20..24].try_into().expect("4 bytes")),
    })
}

#[inline]
fn u32_at(buf: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(buf[offset..offset + 4].try_into().expect("4 bytes"))
}

#[inline]
fn u16_at(buf: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(buf[offset..offset + 2].try_into().expect("2 bytes"))
}

/// Decode any server frame, inflating it first when it carries [`FRAME_FLAG_DEFLATE`].
pub fn decode_frame(buf: &[u8]) -> Result<Frame, ProtocolError> {
    let mut header = read_header(buf)?;
    let inflated;
    let buf = if header.flags & FRAME_FLAG_DEFLATE != 0 {
        inflated = inflate_frame(buf)?;
        header.flags &= !FRAME_FLAG_DEFLATE;
        &inflated[..]
    } else {
        buf
    };
    let n = header.count as usize;
    match header.frame_type {
        frame_type::UPSERT => {
            let need = n.checked_mul(UPSERT_RECORD_BYTES).and_then(|b| b.checked_add(HEADER_BYTES));
            if need.is_none_or(|need| buf.len() < need) {
                return Err(ProtocolError::Truncated("Upsert"));
            }
            let ids = HEADER_BYTES;
            let lon = ids + n * 4;
            let lat = lon + n * 4;
            let alt = lat + n * 4;
            let heading = alt + n * 2;
            let speed = heading + n * 2;
            let vrate = speed + n * 2;
            let age = vrate + n;
            let category = age + n;
            let flags = category + n;
            let rows = (0..n)
                .map(|i| UpsertRow {
                    id: u32_at(buf, ids + i * 4),
                    lon_e7: u32_at(buf, lon + i * 4) as i32,
                    lat_e7: u32_at(buf, lat + i * 4) as i32,
                    alt: u16_at(buf, alt + i * 2) as i16,
                    heading: u16_at(buf, heading + i * 2),
                    speed: u16_at(buf, speed + i * 2),
                    vrate: buf[vrate + i] as i8,
                    age: buf[age + i],
                    category: buf[category + i],
                    flags: buf[flags + i],
                })
                .collect();
            Ok(Frame::Upsert { header, full: header.flags & FRAME_FLAG_FULL != 0, rows })
        }
        frame_type::REMOVE => {
            let need = n.checked_mul(4).and_then(|b| b.checked_add(HEADER_BYTES));
            if need.is_none_or(|need| buf.len() < need) {
                return Err(ProtocolError::Truncated("Remove"));
            }
            let ids = (0..n).map(|i| u32_at(buf, HEADER_BYTES + i * 4)).collect();
            Ok(Frame::Remove { header, ids })
        }
        frame_type::META => {
            let truncated = || ProtocolError::Truncated("Meta");
            let mut records = Vec::with_capacity(n.min(65_536));
            let mut o = HEADER_BYTES;
            for _ in 0..n {
                if o + 5 > buf.len() {
                    return Err(truncated());
                }
                let id = u32_at(buf, o);
                let field_count = buf[o + 4];
                o += 5;
                let mut fields = Vec::with_capacity(usize::from(field_count));
                for _ in 0..field_count {
                    if o + 2 > buf.len() {
                        return Err(truncated());
                    }
                    let key = buf[o];
                    let len = usize::from(buf[o + 1]);
                    o += 2;
                    if o + len > buf.len() {
                        return Err(truncated());
                    }
                    // Unknown keys are skipped so older decoders tolerate newer servers.
                    if let Some(key) = MetaKey::from_u8(key) {
                        fields.push((key, String::from_utf8_lossy(&buf[o..o + len]).into_owned()));
                    }
                    o += len;
                }
                records.push(MetaRecord { id, fields });
            }
            Ok(Frame::Meta { header, records })
        }
        frame_type::DENSITY => {
            let need = n.checked_mul(DENSITY_RECORD_BYTES).and_then(|b| b.checked_add(HEADER_BYTES));
            if need.is_none_or(|need| buf.len() < need) {
                return Err(ProtocolError::Truncated("Density"));
            }
            let lo = HEADER_BYTES;
            let hi = lo + n * 4;
            let lon = hi + n * 4;
            let lat = lon + n * 4;
            let counts = lat + n * 4;
            let rows = (0..n)
                .map(|i| DensityRow {
                    cell: u64::from(u32_at(buf, lo + i * 4)) | (u64::from(u32_at(buf, hi + i * 4)) << 32),
                    lon: f32::from_bits(u32_at(buf, lon + i * 4)),
                    lat: f32::from_bits(u32_at(buf, lat + i * 4)),
                    count: u32_at(buf, counts + i * 4),
                })
                .collect();
            Ok(Frame::Density { header, res: header.aux as u8, rows })
        }
        frame_type::STATS => {
            let need = n.checked_mul(STATS_RECORD_BYTES).and_then(|b| b.checked_add(HEADER_BYTES));
            if need.is_none_or(|need| buf.len() < need) {
                return Err(ProtocolError::Truncated("Stats"));
            }
            let entries = (0..n)
                .map(|i| {
                    let o = HEADER_BYTES + i * STATS_RECORD_BYTES;
                    StatsEntry { kind: buf[o], status: buf[o + 1], total: u32_at(buf, o + 4) }
                })
                .collect();
            Ok(Frame::Stats { header, entries })
        }
        frame_type::EVENTS => {
            let events: Vec<HaloEvent> =
                serde_json::from_slice(&buf[HEADER_BYTES..]).map_err(|_| ProtocolError::BadEvents)?;
            Ok(Frame::Events { header, events })
        }
        other => Err(ProtocolError::UnknownFrameType(other)),
    }
}

// ---------------------------------------------------------------------------
// JSON control messages
// ---------------------------------------------------------------------------

/// Client to server messages (JSON text frames).
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum ClientMessage {
    Sub {
        layers: Vec<String>,
        res: u8,
        #[serde(default)]
        cells: Vec<String>,
        #[serde(default = "default_true")]
        points: bool,
        #[serde(default)]
        density: bool,
    },
    Ping {
        id: serde_json::Value,
    },
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HelloLayer {
    pub status: u8,
    pub attribution: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HelloLayers {
    pub aircraft: HelloLayer,
    pub ships: HelloLayer,
}

/// Server to client control messages (JSON text frames).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum ServerMessage {
    Hello {
        v: u8,
        #[serde(rename = "tickMs")]
        tick_ms: u32,
        #[serde(rename = "maxCells")]
        max_cells: u32,
        #[serde(rename = "densityRes")]
        density_res: u8,
        layers: HelloLayers,
    },
    Pong {
        id: serde_json::Value,
    },
    Error {
        code: String,
        message: String,
    },
}

impl ServerMessage {
    pub fn error(code: &str, message: impl Into<String>) -> Self {
        ServerMessage::Error { code: code.to_owned(), message: message.into() }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("control message serialises")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_round_matches_math_round() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(-2.51), -3.0);
        assert_eq!(js_round(0.49), 0.0);
    }

    #[test]
    fn positions_scale_and_clamp() {
        assert_eq!(quantise_lon(-0.3456789), -3_456_789);
        assert_eq!(quantise_lat(51.5074), 515_074_000);
        assert_eq!(quantise_lon(180.0), 1_800_000_000);
        assert_eq!(quantise_lon(-180.0), -1_800_000_000);
        assert_eq!(quantise_lon(540.0), 1_800_000_000);
        assert_eq!(quantise_lat(-91.0), -900_000_000);
        assert_eq!(quantise_lat(f64::NAN), 0);
    }

    #[test]
    fn altitude_is_in_25_foot_units() {
        // 35,000 ft is 10,668 m and exactly 1400 units.
        assert_eq!(quantise_alt(10_668.0), 1400);
        assert_eq!(quantise_alt(-30.48), -4);
        assert_eq!(quantise_alt(1e9), 32767);
        assert_eq!(quantise_alt(-1e9), -32768);
        assert_eq!(quantise_alt(3.81), 1);
        assert_eq!(quantise_alt(-3.81), 0);
    }

    #[test]
    fn heading_wraps_and_marks_unknown() {
        assert_eq!(quantise_heading(Some(90.5)), 9050);
        assert_eq!(quantise_heading(Some(0.0)), 0);
        assert_eq!(quantise_heading(Some(360.0)), 0);
        assert_eq!(quantise_heading(Some(-90.0)), 27000);
        assert_eq!(quantise_heading(Some(725.25)), 525);
        // Rounds up to 360.00, which wraps to 0 rather than leaving the range.
        assert_eq!(quantise_heading(Some(359.999)), 0);
        assert_eq!(quantise_heading(None), HEADING_UNKNOWN);
        assert_eq!(quantise_heading(Some(f64::NAN)), HEADING_UNKNOWN);
    }

    #[test]
    fn speed_and_vertical_rate_clamp() {
        assert_eq!(quantise_speed(234.5), 2345);
        assert_eq!(quantise_speed(-5.0), 0);
        assert_eq!(quantise_speed(1e6), 65535);
        assert_eq!(quantise_vrate(-6.0), -12);
        assert_eq!(quantise_vrate(100.0), 127);
        assert_eq!(quantise_vrate(-100.0), -127);
        assert_eq!(quantise_vrate(0.25), 1);
        assert_eq!(quantise_vrate(-0.25), 0);
    }

    #[test]
    fn age_rounds_and_saturates() {
        assert_eq!(quantise_age(10_000, 10_000), 0);
        assert_eq!(quantise_age(10_000, 12_000), 0);
        assert_eq!(quantise_age(10_000, 7_000), 3);
        assert_eq!(quantise_age(10_000, 9_501), 0);
        assert_eq!(quantise_age(10_000, 9_500), 1);
        assert_eq!(quantise_age(1_000_000, 0), 255);
        assert_eq!(quantise_age(255_400, 0), 255);
        assert_eq!(quantise_age(254_400, 0), 254);
    }

    #[test]
    fn meta_values_are_cut_on_a_character_boundary() {
        let ascii = "a".repeat(300);
        assert_eq!(truncate_meta_value(&ascii).len(), 255);
        // 254 ASCII bytes then a 3-byte character: cutting at 255 would split it.
        let text = format!("{}東京", "a".repeat(254));
        let cut = truncate_meta_value(&text);
        assert_eq!(cut.len(), 254);
        assert!(cut.chars().all(|c| c == 'a'));
        // 253 ASCII bytes then a 2-byte character fits exactly.
        let text = format!("{}ü and more text that is dropped", "a".repeat(253));
        assert_eq!(truncate_meta_value(&text).len(), 255);
        assert!(truncate_meta_value(&text).ends_with('ü'));
        assert_eq!(truncate_meta_value("short"), "short");
    }

    #[test]
    fn meta_fields_are_written_in_key_order() {
        let frame = encode_meta(
            1,
            0.0,
            &[MetaRecord {
                id: 9,
                fields: vec![
                    (MetaKey::Squawk, "7700".into()),
                    (MetaKey::Label, "TEST1".into()),
                    (MetaKey::TypeCode, "A320".into()),
                ],
            }],
        );
        let keys: Vec<u8> = {
            let mut o = HEADER_BYTES + 5;
            let mut keys = Vec::new();
            while o < frame.len() {
                keys.push(frame[o]);
                o += 2 + usize::from(frame[o + 1]);
            }
            keys
        };
        assert_eq!(keys, vec![1, 3, 9]);
        let Frame::Meta { records, .. } = decode_frame(&frame).unwrap() else { panic!("not meta") };
        assert_eq!(records[0].fields[0], (MetaKey::Label, "TEST1".to_owned()));
    }

    #[test]
    fn meta_decoder_skips_unknown_keys() {
        let mut frame = Vec::new();
        write_header(&mut frame, frame_type::META, 2, 0, 1.0, 1, 0);
        frame.extend_from_slice(&7u32.to_le_bytes());
        frame.push(3);
        frame.extend_from_slice(&[1, 2, b'h', b'i']);
        frame.extend_from_slice(&[200, 3, 1, 2, 3]);
        frame.extend_from_slice(&[17, 1, b'x']);
        let Frame::Meta { records, .. } = decode_frame(&frame).unwrap() else { panic!("not meta") };
        assert_eq!(records[0].fields, vec![(MetaKey::Label, "hi".to_owned()), (MetaKey::Source, "x".to_owned())]);
    }

    #[test]
    fn truncated_frames_are_rejected() {
        let frame = encode_upsert(1, 5.0, true, &[UpsertRow { id: 1, ..Default::default() }]);
        assert_eq!(decode_frame(&frame[..frame.len() - 1]), Err(ProtocolError::Truncated("Upsert")));
        assert_eq!(decode_frame(&frame[..10]), Err(ProtocolError::TooShort));
        let mut bad = frame.clone();
        bad[0] = 0;
        assert_eq!(decode_frame(&bad), Err(ProtocolError::BadMagic));
        bad = frame.clone();
        bad[1] = 2;
        assert_eq!(decode_frame(&bad), Err(ProtocolError::UnsupportedVersion(2)));
        bad = frame;
        bad[2] = 99;
        assert_eq!(decode_frame(&bad), Err(ProtocolError::UnknownFrameType(99)));
    }

    #[test]
    fn deflate_round_trips_and_keeps_the_header_readable() {
        let rows: Vec<UpsertRow> = (0..500)
            .map(|i| UpsertRow {
                id: 0x400000 + i,
                lon_e7: -1_000_000 + i as i32 * 977,
                lat_e7: 515_000_000 + i as i32 * 1013,
                alt: 1400,
                heading: 9000,
                speed: 2300,
                vrate: 0,
                age: 1,
                category: 3,
                flags: 0,
            })
            .collect();
        let raw = encode_upsert(1, 1_794_000_000_123.0, true, &rows);
        let packed = deflate_frame(&raw, 6).expect("compresses");
        assert!(packed.len() < raw.len());
        let header = read_header(&packed).unwrap();
        assert_eq!(header.flags, FRAME_FLAG_FULL | FRAME_FLAG_DEFLATE);
        assert_eq!(header.count, 500);
        assert_eq!(&packed[..4], &raw[..4]);
        assert_eq!(&packed[6..HEADER_BYTES], &raw[6..HEADER_BYTES]);
        assert_eq!(inflate_frame(&packed).unwrap(), raw);
        assert_eq!(decode_frame(&packed).unwrap(), decode_frame(&raw).unwrap());
        // Already-compressed and header-only frames are left alone.
        assert!(deflate_frame(&packed, 6).is_none());
        assert!(deflate_frame(&encode_remove(1, 0.0, &[]), 6).is_none());
    }

    #[test]
    fn client_messages_parse() {
        let sub: ClientMessage = serde_json::from_str(
            r#"{"t":"sub","layers":["aircraft","ships"],"res":2,"cells":["823f67fffffffff"],"points":true,"density":false}"#,
        )
        .unwrap();
        assert_eq!(
            sub,
            ClientMessage::Sub {
                layers: vec!["aircraft".into(), "ships".into()],
                res: 2,
                cells: vec!["823f67fffffffff".into()],
                points: true,
                density: false,
            }
        );
        let ping: ClientMessage = serde_json::from_str(r#"{"t":"ping","id":7}"#).unwrap();
        assert_eq!(ping, ClientMessage::Ping { id: serde_json::json!(7) });
        assert!(serde_json::from_str::<ClientMessage>(r#"{"t":"nope"}"#).is_err());
    }

    #[test]
    fn server_messages_use_the_documented_field_names() {
        let hello = ServerMessage::Hello {
            v: 1,
            tick_ms: 1000,
            max_cells: 2000,
            density_res: 2,
            layers: HelloLayers {
                aircraft: HelloLayer { status: 1, attribution: "a".into() },
                ships: HelloLayer { status: 3, attribution: "b".into() },
            },
        };
        assert_eq!(
            hello.to_json(),
            r#"{"t":"hello","v":1,"tickMs":1000,"maxCells":2000,"densityRes":2,"layers":{"aircraft":{"status":1,"attribution":"a"},"ships":{"status":3,"attribution":"b"}}}"#
        );
        assert_eq!(ServerMessage::Pong { id: serde_json::json!(7) }.to_json(), r#"{"t":"pong","id":7}"#);
        assert_eq!(
            ServerMessage::error("bad_request", "x").to_json(),
            r#"{"t":"error","code":"bad_request","message":"x"}"#
        );
    }
}
