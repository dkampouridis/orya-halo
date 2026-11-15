//! AISStream.io: worldwide AIS over one WebSocket, with a free API key.
//!
//! Docs: <https://aisstream.io/documentation>. The service wants
//! `permessage-deflate`, one JSON subscription within three seconds of
//! connecting, and the key kept on a server. It publishes no licence or terms
//! of use (checked 2026-11-14); its documentation tells integrators to "proxy
//! only the information your clients need from your own server", which is
//! what this gateway does. Without `AISSTREAM_API_KEY` the feed reports
//! "needs key" and stays idle.

use std::time::{Duration, Instant};

use anyhow::bail;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;

use super::ais::{self, Position, StaticData};
use super::wsclient::{self, Frame, OpCode};
use super::{BoxFuture, Licence, SourceInfo, Upstream, UpstreamContext};
use crate::config::Config;
use crate::model::{Kind, Observation, UpstreamStatus, now_ms};
use crate::protocol::MetaKey;

/// The message types that describe where ships are and what they are.
const MESSAGE_TYPES: [&str; 5] = [
    "PositionReport",
    "StandardClassBPositionReport",
    "ExtendedClassBPositionReport",
    "ShipStaticData",
    "StaticDataReport",
];
const SILENCE_LIMIT: Duration = Duration::from_secs(60);

#[derive(Debug, Deserialize)]
struct Envelope {
    #[serde(rename = "MessageType", default)]
    message_type: String,
    #[serde(rename = "MetaData", default)]
    meta: Option<MetaData>,
    #[serde(rename = "Message", default)]
    message: Messages,
    /// Sent instead of a message when the subscription is refused.
    #[serde(default, alias = "Error")]
    error: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct MetaData {
    #[serde(rename = "MMSI")]
    mmsi: u32,
    #[serde(rename = "ShipName")]
    ship_name: String,
    /// Go's default time format: `2026-11-14 15:36:04.318353 +0000 UTC`.
    time_utc: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default, rename_all = "PascalCase")]
struct Messages {
    position_report: Option<PositionMessage>,
    standard_class_b_position_report: Option<PositionMessage>,
    extended_class_b_position_report: Option<PositionMessage>,
    ship_static_data: Option<StaticMessage>,
    static_data_report: Option<StaticReport>,
    compression_enabled: Option<bool>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default, rename_all = "PascalCase")]
struct PositionMessage {
    #[serde(rename = "UserID")]
    user_id: u32,
    sog: f64,
    cog: f64,
    latitude: f64,
    longitude: f64,
    true_heading: u32,
    /// Class A only.
    navigational_status: Option<u8>,
    // Extended class B reports (message 19) also carry a little static data.
    name: String,
    #[serde(rename = "Type")]
    ship_type: Option<u32>,
    dimension: Dimension,
}

#[derive(Debug, Deserialize, Default, Clone, Copy)]
#[serde(default, rename_all = "PascalCase")]
struct Dimension {
    a: u32,
    b: u32,
    c: u32,
    d: u32,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default, rename_all = "PascalCase")]
struct Eta {
    month: u8,
    day: u8,
    hour: u8,
    minute: u8,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default, rename_all = "PascalCase")]
struct StaticMessage {
    #[serde(rename = "UserID")]
    user_id: u32,
    imo_number: u32,
    call_sign: String,
    name: String,
    #[serde(rename = "Type")]
    ship_type: Option<u32>,
    dimension: Dimension,
    eta: Eta,
    /// Metres.
    maximum_static_draught: f64,
    destination: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default, rename_all = "PascalCase")]
struct StaticReport {
    #[serde(rename = "UserID")]
    user_id: u32,
    report_a: ReportA,
    report_b: ReportB,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default, rename_all = "PascalCase")]
struct ReportA {
    valid: bool,
    name: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default, rename_all = "PascalCase")]
struct ReportB {
    valid: bool,
    ship_type: Option<u32>,
    call_sign: String,
    dimension: Dimension,
}

/// What one AISStream message turned out to be.
#[derive(Debug, PartialEq)]
pub enum Parsed {
    /// Zero, one or two observations (an extended class B report is a position plus facts).
    Observations(Vec<Observation>),
    /// The subscription was accepted; whether compression was negotiated.
    Confirmed { compression: Option<bool> },
    /// The service refused us, with its reason.
    Refused(String),
}

/// Parse `2026-11-14 15:36:04.318353 +0000 UTC` to Unix milliseconds.
fn parse_time_utc(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || b[10] != b' ' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let n = |range: std::ops::Range<usize>| text.get(range)?.parse::<i64>().ok();
    let (year, month, day) = (n(0..4)?, n(5..7)?, n(8..10)?);
    let (hour, minute, second) = (n(11..13)?, n(14..16)?, n(17..19)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    // Days since the epoch, as in `ais::eta_text`.
    let y = if month <= 2 { year - 1 } else { year };
    let (era, yoe) = (y.div_euclid(400), y.rem_euclid(400));
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    Some(((days * 24 + hour) * 60 + minute) * 60_000 + second * 1000)
}

/// Normalise one message from the stream.
pub fn parse_message(payload: &[u8], now_ms: i64) -> Result<Parsed, serde_json::Error> {
    let envelope: Envelope = serde_json::from_slice(payload)?;
    if let Some(error) = envelope.error {
        return Ok(Parsed::Refused(error));
    }
    if envelope.message_type == "SubscriptionConfirmation" {
        return Ok(Parsed::Confirmed { compression: envelope.message.compression_enabled });
    }
    let meta = envelope.meta.unwrap_or_default();
    // Trust the service's receive time when it is plausible; otherwise use ours.
    let time_ms =
        parse_time_utc(&meta.time_utc).filter(|t| (now_ms - 600_000..=now_ms + 5_000).contains(t)).unwrap_or(now_ms);
    let m = envelope.message;
    let mut out = Vec::new();

    let position = m.position_report.or(m.standard_class_b_position_report).or(m.extended_class_b_position_report);
    if let Some(p) = position {
        let mmsi = if p.user_id != 0 { p.user_id } else { meta.mmsi };
        if let Some(mut obs) = ais::position(&Position {
            mmsi,
            lat: p.latitude,
            lon: p.longitude,
            sog_knots: p.sog,
            cog: p.cog,
            heading: p.true_heading,
            nav_status: p.navigational_status,
            time_ms,
        }) {
            // The envelope repeats the last known name, which labels ships
            // long before their six-minute static report comes round.
            obs.fact(MetaKey::Label, meta.ship_name.trim_matches(|c: char| c == '@' || c.is_whitespace()));
            out.push(obs);
        }
        if p.ship_type.is_some() || !p.name.is_empty() {
            let d = p.dimension;
            out.extend(ais::static_data(
                &StaticData {
                    mmsi,
                    name: &p.name,
                    ship_type: p.ship_type,
                    to_bow: d.a,
                    to_stern: d.b,
                    to_port: d.c,
                    to_starboard: d.d,
                    ..Default::default()
                },
                now_ms,
            ));
        }
    }
    if let Some(s) = m.ship_static_data {
        let d = s.dimension;
        out.extend(ais::static_data(
            &StaticData {
                mmsi: if s.user_id != 0 { s.user_id } else { meta.mmsi },
                name: &s.name,
                callsign: &s.call_sign,
                imo: s.imo_number,
                ship_type: s.ship_type,
                to_bow: d.a,
                to_stern: d.b,
                to_port: d.c,
                to_starboard: d.d,
                draught_m: s.maximum_static_draught,
                destination: &s.destination,
                eta: Some((s.eta.month, s.eta.day, s.eta.hour, s.eta.minute)),
            },
            now_ms,
        ));
    }
    if let Some(r) = m.static_data_report {
        let d = r.report_b.dimension;
        out.extend(ais::static_data(
            &StaticData {
                mmsi: if r.user_id != 0 { r.user_id } else { meta.mmsi },
                name: if r.report_a.valid { &r.report_a.name } else { "" },
                callsign: if r.report_b.valid { &r.report_b.call_sign } else { "" },
                ship_type: if r.report_b.valid { r.report_b.ship_type } else { None },
                to_bow: d.a,
                to_stern: d.b,
                to_port: d.c,
                to_starboard: d.d,
                ..Default::default()
            },
            now_ms,
        ));
    }
    Ok(Parsed::Observations(out))
}

/// The subscription sent right after connecting.
pub fn subscription(api_key: &str) -> String {
    serde_json::json!({
        "APIKey": api_key,
        "BoundingBoxes": [[[-90.0, -180.0], [90.0, 180.0]]],
        "FilterMessageTypes": MESSAGE_TYPES,
    })
    .to_string()
}

pub struct AisStream {
    api_key: Option<String>,
    url: String,
}

impl AisStream {
    pub fn new(config: &Config) -> AisStream {
        AisStream { api_key: config.aisstream_api_key.clone(), url: config.aisstream_url.clone() }
    }

    async fn stream(&self, ctx: &mut UpstreamContext, api_key: &str) -> anyhow::Result<()> {
        let started = Instant::now();
        let connected = wsclient::connect(&self.url, &[], true, Duration::from_secs(20)).await;
        ctx.state.record_request(started.elapsed(), connected.is_ok());
        let mut socket = connected?;
        // The service closes connections that have not subscribed within three seconds.
        socket.send(Frame::text(subscription(api_key))).await?;

        let mut pending: Vec<Observation> = Vec::new();
        let mut flush = tokio::time::interval(Duration::from_millis(250));
        let mut last_data = Instant::now();
        loop {
            tokio::select! {
                frame = socket.next() => {
                    let Some(frame) = frame else { bail!("connection closed") };
                    match frame.opcode() {
                        OpCode::Binary | OpCode::Text => {}
                        OpCode::Close => bail!("closed by the server"),
                        _ => continue,
                    }
                    last_data = Instant::now();
                    match parse_message(frame.payload(), now_ms()) {
                        Ok(Parsed::Observations(observations)) => pending.extend(observations),
                        Ok(Parsed::Confirmed { compression }) => {
                            let note = match compression {
                                Some(false) => "Connected without compression: the service may drop messages over its bandwidth limit.",
                                _ => "Connected to the live stream.",
                            };
                            ctx.state.set_status(UpstreamStatus::Ok, note);
                        }
                        Ok(Parsed::Refused(reason)) => bail!("refused: {reason}"),
                        Err(e) => tracing::debug!(error = %e, "unreadable AISStream message"),
                    }
                    if pending.len() >= 1000 {
                        ctx.push(std::mem::take(&mut pending)).await;
                    }
                }
                _ = flush.tick() => {
                    if !pending.is_empty() {
                        ctx.push(std::mem::take(&mut pending)).await;
                    }
                    if last_data.elapsed() > SILENCE_LIMIT {
                        bail!("no data for {} seconds", SILENCE_LIMIT.as_secs());
                    }
                }
                _ = ctx.shutdown.changed() => {
                    let _ = socket.close().await;
                    return Ok(());
                }
            }
        }
    }

    async fn run_loop(self, mut ctx: UpstreamContext) {
        let Some(api_key) = self.api_key.clone() else {
            ctx.state.set_status(UpstreamStatus::NeedsKey, "Set AISSTREAM_API_KEY to show ships worldwide.");
            return;
        };
        ctx.state.set_status(UpstreamStatus::Degraded, "Connecting.");
        let mut failures = 0u32;
        while !ctx.is_shutdown() {
            let connected_at = Instant::now();
            let outcome = self.stream(&mut ctx, &api_key).await;
            if ctx.is_shutdown() {
                break;
            }
            if connected_at.elapsed() > Duration::from_secs(120) {
                failures = 0;
            }
            failures += 1;
            let reason = outcome.err().map_or_else(|| "connection ended".to_owned(), |e| format!("{e:#}"));
            let refused = reason.starts_with("refused");
            let status = if refused || failures >= 4 { UpstreamStatus::Down } else { UpstreamStatus::Degraded };
            ctx.state.set_status(status, format!("Live stream interrupted: {reason}. Reconnecting."));
            // A refused key will not start working by itself: retry rarely.
            let pause = if refused { 300 } else { (5u64 << failures.min(5).saturating_sub(1)).min(120) };
            if !ctx.sleep(Duration::from_secs(pause)).await {
                break;
            }
        }
    }
}

impl Upstream for AisStream {
    fn info(&self) -> SourceInfo {
        SourceInfo {
            id: "aisstream",
            name: "AISStream.io",
            kind: Kind::Ship,
            licence: Licence {
                name: "No published terms",
                url: "https://aisstream.io/documentation",
                display: true,
                redistribution: true,
                commercial: false,
                notes: "The provider publishes no licence or terms of use. Its documentation asks integrators to \
                        proxy data to their clients from their own server, which is what the gateway does. No SLA. \
                        Ask the provider before any commercial use.",
                verified: "2026-11-14",
            },
            attribution: "Ship positions from AISStream.io",
            attribution_url: "https://aisstream.io/",
            docs: "https://aisstream.io/documentation",
            requires_key: Some("AISSTREAM_API_KEY"),
            coverage: "worldwide",
        }
    }

    fn run(self: Box<Self>, ctx: UpstreamContext) -> BoxFuture {
        Box::pin(self.run_loop(ctx))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn go_timestamps_parse() {
        assert_eq!(parse_time_utc("2026-11-14 15:36:04.318353 +0000 UTC"), Some(1_794_670_564_000));
        assert_eq!(parse_time_utc("1970-01-01 00:00:00 +0000 UTC"), Some(0));
        assert_eq!(parse_time_utc("2024-02-29 23:59:59.9 +0000 UTC"), Some(1_709_251_199_000));
        assert_eq!(parse_time_utc(""), None);
        assert_eq!(parse_time_utc("2026-13-14 15:36:04"), None);
        assert_eq!(parse_time_utc("not a time at all, sorry"), None);
    }

    #[test]
    fn the_subscription_covers_the_world_and_filters_message_types() {
        let sub: serde_json::Value = serde_json::from_str(&subscription("k")).unwrap();
        assert_eq!(sub["APIKey"], "k");
        assert_eq!(sub["BoundingBoxes"], serde_json::json!([[[-90.0, -180.0], [90.0, 180.0]]]));
        assert_eq!(sub["FilterMessageTypes"].as_array().unwrap().len(), 5);
    }

    #[test]
    fn refusals_and_confirmations_are_recognised() {
        assert_eq!(
            parse_message(br#"{"error":"Api Key Is Not Valid"}"#, 0).unwrap(),
            Parsed::Refused("Api Key Is Not Valid".into())
        );
        assert_eq!(
            parse_message(br#"{"MessageType":"SubscriptionConfirmation","Message":{"CompressionEnabled":true}}"#, 0)
                .unwrap(),
            Parsed::Confirmed { compression: Some(true) }
        );
        assert_eq!(
            parse_message(br#"{"MessageType":"UnknownMessage","Message":{"UnknownMessage":{}}}"#, 0).unwrap(),
            Parsed::Observations(vec![])
        );
        assert!(parse_message(b"not json", 0).is_err());
    }
}
