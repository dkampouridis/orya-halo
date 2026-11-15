//! Finland's Digitraffic marine AIS: open data, no key.
//!
//! Fintraffic publishes class A position reports and vessel metadata for
//! Finnish waters and much of the Baltic under CC BY 4.0. Live data comes over
//! MQTT on a WebSocket; a REST snapshot fills the map at start-up so nobody
//! waits for every ship to report. Fishing vessels are filtered out upstream.
//!
//! Docs: <https://www.digitraffic.fi/en/marine-traffic/>. The service asks for
//! a `Digitraffic-User` header naming the application and requires gzip on REST.

use std::time::{Duration, Instant};

use anyhow::{Context, anyhow, bail};
use bytes::{Buf, Bytes, BytesMut};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;

use super::ais::{self, Position, StaticData};
use super::wsclient::{self, Frame, OpCode};
use super::{BoxFuture, Licence, SourceInfo, Upstream, UpstreamContext};
use crate::config::Config;
use crate::model::{Kind, Observation, UpstreamStatus, now_ms};

/// How far back the start-up snapshot looks. Class A ships report at least every three minutes.
const SNAPSHOT_WINDOW_MS: i64 = 30 * 60 * 1000;
/// The broker publishes a status message regularly; this much silence means a dead socket.
const SILENCE_LIMIT: Duration = Duration::from_secs(90);
const KEEP_ALIVE_S: u16 = 60;
const TOPICS: [&str; 3] = ["vessels-v2/+/location", "vessels-v2/+/metadata", "vessels-v2/status"];

// ---------------------------------------------------------------------------
// A minimal MQTT 3.1.1 client: CONNECT, SUBSCRIBE at QoS 0, PINGREQ, and
// reading PUBLISH. That is all a read-only subscriber needs.
// ---------------------------------------------------------------------------

mod packet {
    pub const CONNACK: u8 = 2;
    pub const PUBLISH: u8 = 3;
    pub const SUBACK: u8 = 9;
    pub const PINGREQ: [u8; 2] = [0xC0, 0x00];
}

fn put_string(out: &mut Vec<u8>, text: &str) {
    out.extend_from_slice(&(text.len() as u16).to_be_bytes());
    out.extend_from_slice(text.as_bytes());
}

fn finish_packet(first_byte: u8, body: &[u8]) -> Vec<u8> {
    let mut out = vec![first_byte];
    let mut len = body.len();
    loop {
        let mut digit = (len % 128) as u8;
        len /= 128;
        if len > 0 {
            digit |= 0x80;
        }
        out.push(digit);
        if len == 0 {
            break;
        }
    }
    out.extend_from_slice(body);
    out
}

/// CONNECT with a clean session and no credentials.
pub fn encode_connect(client_id: &str, keep_alive_s: u16) -> Vec<u8> {
    let mut body = Vec::new();
    put_string(&mut body, "MQTT");
    body.push(4); // protocol level: 3.1.1
    body.push(0x02); // clean session
    body.extend_from_slice(&keep_alive_s.to_be_bytes());
    put_string(&mut body, client_id);
    finish_packet(0x10, &body)
}

/// SUBSCRIBE to topic filters at QoS 0.
pub fn encode_subscribe(packet_id: u16, topics: &[&str]) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&packet_id.to_be_bytes());
    for topic in topics {
        put_string(&mut body, topic);
        body.push(0);
    }
    finish_packet(0x82, &body)
}

/// One MQTT control packet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Packet {
    /// Packet type (high nibble of the first byte).
    pub kind: u8,
    /// Flags (low nibble).
    pub flags: u8,
    pub body: Bytes,
}

impl Packet {
    /// Topic and payload of a PUBLISH packet.
    pub fn publish(&self) -> Option<(&str, &[u8])> {
        if self.kind != packet::PUBLISH || self.body.len() < 2 {
            return None;
        }
        let topic_len = usize::from(u16::from_be_bytes([self.body[0], self.body[1]]));
        let mut payload_at = 2 + topic_len;
        let topic = std::str::from_utf8(self.body.get(2..payload_at)?).ok()?;
        // QoS 1 and 2 carry a packet id before the payload.
        if self.flags & 0x06 != 0 {
            payload_at += 2;
        }
        Some((topic, self.body.get(payload_at..)?))
    }
}

/// Reassembles MQTT packets from a byte stream: a WebSocket message may hold
/// several packets, or part of one.
#[derive(Default)]
pub struct Decoder {
    buffer: BytesMut,
}

impl Decoder {
    pub fn feed(&mut self, bytes: &[u8]) {
        self.buffer.extend_from_slice(bytes);
    }

    /// The next complete packet, `Ok(None)` when more bytes are needed.
    pub fn next_packet(&mut self) -> anyhow::Result<Option<Packet>> {
        if self.buffer.len() < 2 {
            return Ok(None);
        }
        let mut len = 0usize;
        let mut header = 1;
        loop {
            let Some(&digit) = self.buffer.get(header) else { return Ok(None) };
            len |= usize::from(digit & 0x7F) << (7 * (header - 1));
            header += 1;
            if digit & 0x80 == 0 {
                break;
            }
            if header > 4 {
                bail!("malformed MQTT length");
            }
        }
        if self.buffer.len() < header + len {
            return Ok(None);
        }
        let first = self.buffer[0];
        self.buffer.advance(header);
        let body = self.buffer.split_to(len).freeze();
        Ok(Some(Packet { kind: first >> 4, flags: first & 0x0F, body }))
    }
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/// `vessels-v2/<mmsi>/location` payload. The MMSI is in the topic, not the body.
#[derive(Debug, Deserialize)]
struct LocationMessage {
    /// Unix seconds.
    time: i64,
    sog: f64,
    cog: f64,
    #[serde(rename = "navStat")]
    nav_stat: u8,
    heading: u32,
    lon: f64,
    lat: f64,
}

/// `vessels-v2/<mmsi>/metadata` payload, and (with other field names) a REST vessel.
#[derive(Debug, Deserialize)]
struct MetadataMessage {
    #[serde(default)]
    mmsi: u32,
    #[serde(default)]
    name: String,
    #[serde(default, rename = "callSign")]
    call_sign: String,
    #[serde(default)]
    destination: String,
    /// Tenths of a metre.
    #[serde(default)]
    draught: u32,
    /// Bit-packed month, day, hour, minute.
    #[serde(default)]
    eta: u32,
    #[serde(default)]
    imo: u32,
    #[serde(default, rename = "type", alias = "shipType")]
    ship_type: Option<u32>,
    #[serde(default, rename = "refA", alias = "referencePointA")]
    ref_a: u32,
    #[serde(default, rename = "refB", alias = "referencePointB")]
    ref_b: u32,
    #[serde(default, rename = "refC", alias = "referencePointC")]
    ref_c: u32,
    #[serde(default, rename = "refD", alias = "referencePointD")]
    ref_d: u32,
}

impl MetadataMessage {
    fn observation(&self, mmsi: u32, now_ms: i64) -> Option<Observation> {
        ais::static_data(
            &StaticData {
                mmsi,
                name: &self.name,
                callsign: &self.call_sign,
                imo: self.imo,
                ship_type: self.ship_type,
                to_bow: self.ref_a,
                to_stern: self.ref_b,
                to_port: self.ref_c,
                to_starboard: self.ref_d,
                draught_m: f64::from(self.draught) / 10.0,
                destination: &self.destination,
                eta: Some(ais::unpack_eta(self.eta)),
            },
            now_ms,
        )
    }
}

#[derive(Debug, Deserialize)]
struct RestLocations {
    features: Vec<RestFeature>,
}

#[derive(Debug, Deserialize)]
struct RestFeature {
    mmsi: u32,
    geometry: RestGeometry,
    properties: RestProperties,
}

#[derive(Debug, Deserialize)]
struct RestGeometry {
    /// Longitude, latitude.
    coordinates: [f64; 2],
}

#[derive(Debug, Deserialize)]
struct RestProperties {
    sog: f64,
    cog: f64,
    #[serde(rename = "navStat")]
    nav_stat: u8,
    heading: u32,
    /// Unix milliseconds.
    #[serde(rename = "timestampExternal")]
    timestamp_external: i64,
}

/// What a topic is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Topic {
    Location(u32),
    Metadata(u32),
    Other,
}

pub fn parse_topic(topic: &str) -> Topic {
    let mut parts = topic.split('/');
    if parts.next() != Some("vessels-v2") {
        return Topic::Other;
    }
    let (Some(mmsi), Some(leaf), None) = (parts.next().and_then(|m| m.parse().ok()), parts.next(), parts.next()) else {
        return Topic::Other;
    };
    match leaf {
        "location" => Topic::Location(mmsi),
        "metadata" => Topic::Metadata(mmsi),
        _ => Topic::Other,
    }
}

/// Normalise one MQTT message. `Ok(None)` for topics and reports with nothing to show.
pub fn parse_message(topic: &str, payload: &[u8], now_ms: i64) -> Result<Option<Observation>, serde_json::Error> {
    match parse_topic(topic) {
        Topic::Location(mmsi) => {
            let m: LocationMessage = serde_json::from_slice(payload)?;
            Ok(ais::position(&Position {
                mmsi,
                lat: m.lat,
                lon: m.lon,
                sog_knots: m.sog,
                cog: m.cog,
                heading: m.heading,
                nav_status: Some(m.nav_stat),
                time_ms: m.time * 1000,
            }))
        }
        Topic::Metadata(mmsi) => {
            let m: MetadataMessage = serde_json::from_slice(payload)?;
            Ok(m.observation(mmsi, now_ms))
        }
        Topic::Other => Ok(None),
    }
}

/// Normalise the REST `/api/ais/v1/locations` GeoJSON.
pub fn parse_rest_locations(body: &[u8]) -> Result<Vec<Observation>, serde_json::Error> {
    let collection: RestLocations = serde_json::from_slice(body)?;
    Ok(collection
        .features
        .iter()
        .filter_map(|f| {
            ais::position(&Position {
                mmsi: f.mmsi,
                lat: f.geometry.coordinates[1],
                lon: f.geometry.coordinates[0],
                sog_knots: f.properties.sog,
                cog: f.properties.cog,
                heading: f.properties.heading,
                nav_status: Some(f.properties.nav_stat),
                time_ms: f.properties.timestamp_external,
            })
        })
        .collect())
}

/// Normalise the REST `/api/ais/v1/vessels` list.
pub fn parse_rest_vessels(body: &[u8], now_ms: i64) -> Result<Vec<Observation>, serde_json::Error> {
    let vessels: Vec<MetadataMessage> = serde_json::from_slice(body)?;
    Ok(vessels.iter().filter_map(|v| v.observation(v.mmsi, now_ms)).collect())
}

// ---------------------------------------------------------------------------
// The feed
// ---------------------------------------------------------------------------

pub struct Digitraffic {
    user: String,
    mqtt_url: String,
    rest_url: String,
}

impl Digitraffic {
    pub fn new(config: &Config) -> Digitraffic {
        Digitraffic {
            user: config.digitraffic_user.clone(),
            mqtt_url: config.digitraffic_mqtt_url.clone(),
            rest_url: config.digitraffic_rest_url.trim_end_matches('/').to_owned(),
        }
    }

    async fn get(&self, ctx: &UpstreamContext, path: &str) -> anyhow::Result<Bytes> {
        let started = Instant::now();
        let result = async {
            let response = ctx
                .http
                .get(format!("{}{path}", self.rest_url))
                .header("Digitraffic-User", &self.user)
                .timeout(Duration::from_secs(30))
                .send()
                .await
                .map_err(|e| anyhow!(e.without_url()))?;
            if !response.status().is_success() {
                bail!("HTTP {}", response.status().as_u16());
            }
            response.bytes().await.map_err(|e| anyhow!(e.without_url()))
        }
        .await;
        ctx.state.record_request(started.elapsed(), result.is_ok());
        result
    }

    /// Two requests that fill the map at once: who is out there and where.
    async fn snapshot(&self, ctx: &UpstreamContext) -> anyhow::Result<usize> {
        let now = now_ms();
        let from = now - SNAPSHOT_WINDOW_MS;
        let vessels = self.get(ctx, &format!("/api/ais/v1/vessels?from={from}")).await.context("vessel metadata")?;
        ctx.push(parse_rest_vessels(&vessels, now).context("vessel metadata")?).await;
        let locations =
            self.get(ctx, &format!("/api/ais/v1/locations?from={from}")).await.context("vessel locations")?;
        let positions = parse_rest_locations(&locations).context("vessel locations")?;
        let count = positions.len();
        ctx.push(positions).await;
        Ok(count)
    }

    /// Connect, subscribe and pump messages until the connection ends.
    async fn stream(&self, ctx: &mut UpstreamContext) -> anyhow::Result<()> {
        let started = Instant::now();
        let connected = wsclient::connect(
            &self.mqtt_url,
            &[("Sec-WebSocket-Protocol", "mqtt"), ("Digitraffic-User", &self.user)],
            false,
            Duration::from_secs(20),
        )
        .await;
        ctx.state.record_request(started.elapsed(), connected.is_ok());
        let mut socket = connected?;

        // A client id must be unique per connection or the broker drops the older one.
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.subsec_nanos())
            ^ std::process::id();
        let client_id = format!(
            "{}-{nonce:08x}",
            self.user.chars().filter(char::is_ascii_alphanumeric).take(12).collect::<String>()
        );
        socket.send(Frame::binary(encode_connect(&client_id, KEEP_ALIVE_S))).await?;

        let mut decoder = Decoder::default();
        let mut pending: Vec<Observation> = Vec::new();
        let mut flush = tokio::time::interval(Duration::from_millis(250));
        let mut ping = tokio::time::interval(Duration::from_secs(u64::from(KEEP_ALIVE_S) / 2));
        ping.reset();
        let mut last_data = Instant::now();
        let mut subscribed = false;
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
                    decoder.feed(frame.payload());
                    while let Some(packet) = decoder.next_packet()? {
                        match packet.kind {
                            packet::CONNACK => {
                                if packet.body.get(1) != Some(&0) {
                                    bail!("the broker refused the connection (code {:?})", packet.body.get(1));
                                }
                                socket.send(Frame::binary(encode_subscribe(1, &TOPICS))).await?;
                            }
                            packet::SUBACK => {
                                if packet.body.iter().skip(2).any(|code| *code == 0x80) {
                                    bail!("the broker refused a subscription");
                                }
                                subscribed = true;
                                ctx.state.set_status(UpstreamStatus::Ok, "Connected to the live stream.");
                            }
                            packet::PUBLISH => {
                                if let Some((topic, payload)) = packet.publish() {
                                    match parse_message(topic, payload, now_ms()) {
                                        Ok(Some(obs)) => pending.push(obs),
                                        Ok(None) => {}
                                        Err(e) => tracing::debug!(topic, error = %e, "unreadable Digitraffic message"),
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                    if pending.len() >= 500 {
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
                    if !subscribed && last_data.elapsed() > Duration::from_secs(15) {
                        bail!("the broker did not confirm the subscription");
                    }
                }
                _ = ping.tick() => socket.send(Frame::binary(packet::PINGREQ.to_vec())).await?,
                _ = ctx.shutdown.changed() => {
                    let _ = socket.close().await;
                    return Ok(());
                }
            }
        }
    }

    async fn run_loop(self, mut ctx: UpstreamContext) {
        ctx.state.set_status(UpstreamStatus::Degraded, "Connecting.");
        let mut failures = 0u32;
        let mut last_snapshot: Option<Instant> = None;
        while !ctx.is_shutdown() {
            // Refill from REST at start-up and after any gap long enough for ships to have moved on.
            if last_snapshot.is_none_or(|t| t.elapsed() > Duration::from_secs(600)) {
                match self.snapshot(&ctx).await {
                    Ok(count) => {
                        last_snapshot = Some(Instant::now());
                        tracing::info!(ships = count, "Digitraffic snapshot loaded");
                    }
                    Err(e) => tracing::warn!(error = %format!("{e:#}"), "Digitraffic snapshot failed"),
                }
            }
            let connected_at = Instant::now();
            let outcome = self.stream(&mut ctx).await;
            if ctx.is_shutdown() {
                break;
            }
            // A connection that lasted a while was healthy: start the back-off again.
            if connected_at.elapsed() > Duration::from_secs(120) {
                failures = 0;
            }
            failures += 1;
            let reason = outcome.err().map_or_else(|| "connection ended".to_owned(), |e| format!("{e:#}"));
            let status = if failures >= 4 { UpstreamStatus::Down } else { UpstreamStatus::Degraded };
            ctx.state.set_status(status, format!("Live stream interrupted: {reason}. Reconnecting."));
            // The broker allows five connections a minute per IP: never retry faster than every 15 s.
            let pause = Duration::from_secs((15u64 << failures.min(4).saturating_sub(1)).min(120));
            if !ctx.sleep(pause).await {
                break;
            }
        }
    }
}

impl Upstream for Digitraffic {
    fn info(&self) -> SourceInfo {
        SourceInfo {
            id: "digitraffic",
            name: "Fintraffic Digitraffic marine AIS",
            kind: Kind::Ship,
            licence: Licence {
                name: "CC BY 4.0",
                url: "https://creativecommons.org/licenses/by/4.0/",
                display: true,
                redistribution: true,
                commercial: true,
                notes: "Credit the source, link the licence and say the data was modified (normalised). Class A \
                        only; fishing vessels are filtered out by the provider.",
                verified: "2026-11-14",
            },
            attribution: "Source: Fintraffic / digitraffic.fi, license CC 4.0 BY",
            attribution_url: "https://www.digitraffic.fi/en/marine-traffic/",
            docs: "https://www.digitraffic.fi/en/marine-traffic/",
            requires_key: None,
            coverage: "Finnish waters and the northern Baltic Sea",
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
    fn connect_and_subscribe_packets_are_well_formed() {
        let connect = encode_connect("abc", 60);
        assert_eq!(connect, [0x10, 15, 0, 4, b'M', b'Q', b'T', b'T', 4, 2, 0, 60, 0, 3, b'a', b'b', b'c']);
        let subscribe = encode_subscribe(1, &["a/+/b", "c"]);
        assert_eq!(subscribe, [0x82, 14, 0, 1, 0, 5, b'a', b'/', b'+', b'/', b'b', 0, 0, 1, b'c', 0]);
    }

    #[test]
    fn long_packets_use_a_multi_byte_length() {
        let packet = finish_packet(0x30, &vec![7u8; 321]);
        assert_eq!(&packet[..3], &[0x30, 0xC1, 0x02]);
        let mut decoder = Decoder::default();
        // Fed a byte at a time, the decoder waits for the whole packet.
        for (i, byte) in packet.iter().enumerate() {
            decoder.feed(&[*byte]);
            let got = decoder.next_packet().unwrap();
            assert_eq!(got.is_some(), i == packet.len() - 1);
            if let Some(p) = got {
                assert_eq!((p.kind, p.flags, p.body.len()), (3, 0, 321));
            }
        }
    }

    #[test]
    fn several_packets_in_one_message_are_split() {
        let mut body = Vec::new();
        put_string(&mut body, "vessels-v2/230123456/location");
        body.extend_from_slice(b"{}");
        let mut bytes = vec![0x20, 0x02, 0x00, 0x00];
        bytes.extend(finish_packet(0x30, &body));
        bytes.extend([0xD0, 0x00]);
        let mut decoder = Decoder::default();
        decoder.feed(&bytes);
        let connack = decoder.next_packet().unwrap().unwrap();
        assert_eq!(connack.kind, packet::CONNACK);
        let publish = decoder.next_packet().unwrap().unwrap();
        assert_eq!(publish.publish(), Some(("vessels-v2/230123456/location", &b"{}"[..])));
        assert_eq!(decoder.next_packet().unwrap().unwrap().kind, 13);
        assert_eq!(decoder.next_packet().unwrap(), None);
    }

    #[test]
    fn topics_are_classified() {
        assert_eq!(parse_topic("vessels-v2/230123456/location"), Topic::Location(230_123_456));
        assert_eq!(parse_topic("vessels-v2/230123456/metadata"), Topic::Metadata(230_123_456));
        assert_eq!(parse_topic("vessels-v2/status"), Topic::Other);
        assert_eq!(parse_topic("vessels-v2/abc/location"), Topic::Other);
        assert_eq!(parse_topic("vessels-v2/1/location/extra"), Topic::Other);
        assert_eq!(parse_topic("other/1/location"), Topic::Other);
    }
}
