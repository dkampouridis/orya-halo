//! End to end: start the gateway on an ephemeral port in mock mode, connect a
//! real WebSocket client and walk through the protocol: hello, FULL upsert,
//! meta, deltas, stats, a re-subscription, errors that keep the subscription,
//! and the HTTP endpoints.

use std::collections::HashSet;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use h3o::{LatLng, Resolution};
use orya_halo_gateway::config::{Config, MockConfig};
use orya_halo_gateway::protocol::{FRAME_FLAG_DEFLATE, Frame, ServerMessage, decode_frame, read_header};
use orya_halo_gateway::{Gateway, start};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

const AIRCRAFT: u8 = 1;
const SHIP: u8 = 2;

async fn gateway(configure: impl FnOnce(&mut Config)) -> Gateway {
    let mut config = Config::for_tests();
    config.mock = Some(MockConfig { aircraft: 400, ships: 600 });
    config.tick_ms = 100;
    config.world_cadence_ms = 300;
    config.stats_interval_ms = 200;
    config.density_interval_ms = 200;
    configure(&mut config);
    let gateway = start(config).await.expect("gateway starts");
    // Wait for the mock feeds' first batch, so every test sees the whole fleet.
    let loaded = |kind: usize| gateway.app.metrics.entities[kind].load(std::sync::atomic::Ordering::Relaxed);
    for _ in 0..100 {
        if loaded(0) == 400 && loaded(1) == 600 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!((loaded(0), loaded(1)), (400, 600), "the mock fleet loads");
    gateway
}

/// HTTP status of a WebSocket handshake: 101 when it succeeds.
async fn handshake_status(gateway: &Gateway, query: &str, origin: Option<&str>) -> u16 {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let mut request = format!("ws://{}/v1/stream{query}", gateway.addr).into_client_request().unwrap();
    if let Some(origin) = origin {
        request.headers_mut().insert("origin", origin.parse().unwrap());
    }
    match tokio_tungstenite::connect_async(request).await {
        Ok(_) => 101,
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => response.status().as_u16(),
        Err(other) => panic!("unexpected handshake failure: {other}"),
    }
}

/// What a client collected over a stretch of the stream.
#[derive(Default)]
struct Seen {
    texts: Vec<Value>,
    frames: Vec<Frame>,
    /// Frames that arrived with the DEFLATE flag set.
    deflated: usize,
    wire_bytes: usize,
}

impl Seen {
    fn upserts(&self, kind: u8) -> Vec<(bool, Vec<u32>)> {
        self.frames
            .iter()
            .filter_map(|f| match f {
                Frame::Upsert { header, full, rows } if header.kind == kind => {
                    Some((*full, rows.iter().map(|r| r.id).collect()))
                }
                _ => None,
            })
            .collect()
    }

    fn meta_ids(&self, kind: u8) -> HashSet<u32> {
        self.frames
            .iter()
            .filter_map(|f| match f {
                Frame::Meta { header, records } if header.kind == kind => Some(records.iter().map(|r| r.id)),
                _ => None,
            })
            .flatten()
            .collect()
    }

    fn count(&self, pred: impl Fn(&Frame) -> bool) -> usize {
        self.frames.iter().filter(|f| pred(f)).count()
    }
}

/// Read everything that arrives until `done` says so or the time runs out.
async fn collect(socket: &mut Socket, limit: Duration, done: impl Fn(&Seen) -> bool) -> Seen {
    let mut seen = Seen::default();
    let deadline = tokio::time::Instant::now() + limit;
    while !done(&seen) {
        let message = match tokio::time::timeout_at(deadline, socket.next()).await {
            Ok(Some(Ok(message))) => message,
            Ok(other) => panic!("the stream ended: {other:?}"),
            Err(_) => break,
        };
        match message {
            Message::Text(text) => {
                seen.texts.push(serde_json::from_str(text.as_str()).expect("control messages are JSON"))
            }
            Message::Binary(bytes) => {
                seen.wire_bytes += bytes.len();
                if read_header(&bytes).expect("a valid header").flags & FRAME_FLAG_DEFLATE != 0 {
                    seen.deflated += 1;
                }
                seen.frames.push(decode_frame(&bytes).expect("a valid frame"));
            }
            _ => {}
        }
    }
    seen
}

async fn connect(gateway: &Gateway, query: &str) -> Socket {
    let url = format!("ws://{}/v1/stream{query}", gateway.addr);
    let (socket, _) = tokio_tungstenite::connect_async(url).await.expect("WebSocket connects");
    socket
}

async fn send(socket: &mut Socket, message: Value) {
    socket.send(Message::text(message.to_string())).await.expect("send");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_client_walks_through_the_protocol() {
    let gateway = gateway(|_| {}).await;
    let mut socket = connect(&gateway, "?v=1").await;

    // hello is the first message on every connection.
    let seen = collect(&mut socket, Duration::from_secs(5), |s| !s.texts.is_empty()).await;
    let hello: ServerMessage = serde_json::from_value(seen.texts[0].clone()).expect("hello parses");
    let ServerMessage::Hello { v, tick_ms, max_cells, density_res, layers } = hello else { panic!("not hello") };
    assert_eq!((v, tick_ms, max_cells, density_res), (1, 100, 2000, 2));
    assert_eq!(layers.aircraft.status, 1);
    assert_eq!(layers.ships.status, 1);
    assert!(layers.aircraft.attribution.contains("Simulated"));
    assert!(seen.frames.is_empty(), "nothing is sent before a subscription");

    // Subscribe to the whole world: FULL upserts, facts, density and stats follow.
    send(&mut socket, json!({"t":"sub","layers":["aircraft","ships"],"res":0,"cells":[],"points":true,"density":true}))
        .await;
    let seen = collect(&mut socket, Duration::from_secs(10), |s| {
        s.upserts(AIRCRAFT).iter().any(|(full, _)| *full)
            && s.upserts(SHIP).iter().any(|(full, _)| *full)
            && s.count(|f| matches!(f, Frame::Stats { .. })) > 0
            && s.count(|f| matches!(f, Frame::Density { .. })) >= 2
    })
    .await;
    let aircraft_full = seen.upserts(AIRCRAFT).into_iter().find(|(full, _)| *full).expect("FULL aircraft upsert");
    let ship_full = seen.upserts(SHIP).into_iter().find(|(full, _)| *full).expect("FULL ship upsert");
    assert_eq!(aircraft_full.1.len(), 400);
    assert_eq!(ship_full.1.len(), 600);
    assert!(seen.upserts(AIRCRAFT)[0].0, "the first upsert after sub is FULL");
    let aircraft_ids: HashSet<u32> = aircraft_full.1.iter().copied().collect();
    assert_eq!(seen.meta_ids(AIRCRAFT), aircraft_ids, "facts arrive for every entity in the FULL");
    assert_eq!(seen.meta_ids(SHIP).len(), 600);
    let stats = seen.frames.iter().find_map(|f| match f {
        Frame::Stats { entries, .. } => Some(entries.clone()),
        _ => None,
    });
    let stats = stats.expect("a stats frame");
    assert_eq!((stats[0].kind, stats[0].status, stats[0].total), (1, 1, 400));
    assert_eq!((stats[1].kind, stats[1].status, stats[1].total), (2, 1, 600));
    let density_total: u32 = seen
        .frames
        .iter()
        .find_map(|f| match f {
            Frame::Density { header, res, rows } if header.kind == AIRCRAFT => {
                assert_eq!(*res, 2);
                Some(rows.iter().map(|r| r.count).sum())
            }
            _ => None,
        })
        .expect("aircraft density");
    assert_eq!(density_total, 400, "density counts every aircraft once");

    // Then deltas: the mock fleet moves every second, so non-FULL upserts follow.
    let seen = collect(&mut socket, Duration::from_secs(10), |s| {
        s.upserts(AIRCRAFT).iter().filter(|(full, _)| !full).map(|(_, ids)| ids.len()).sum::<usize>() >= 300
    })
    .await;
    let deltas = seen.upserts(AIRCRAFT);
    assert!(deltas.iter().all(|(full, _)| !full), "no FULL without a new subscription");
    assert!(deltas.iter().flat_map(|(_, ids)| ids).all(|id| aircraft_ids.contains(id)));
    assert!(seen.count(|f| matches!(f, Frame::Stats { .. })) > 0, "stats keep coming");

    // Ping is answered with the same id.
    send(&mut socket, json!({"t":"ping","id":7})).await;
    let seen = collect(&mut socket, Duration::from_secs(5), |s| !s.texts.is_empty()).await;
    assert_eq!(seen.texts[0], json!({"t":"pong","id":7}));

    // Re-subscribe to the cells around London at resolution 2, aircraft only.
    let centre = LatLng::new(51.5, -0.5).unwrap().to_cell(Resolution::Two);
    let cells: Vec<String> = centre.grid_disk::<Vec<_>>(2).iter().map(ToString::to_string).collect();
    send(&mut socket, json!({"t":"sub","layers":["aircraft"],"res":2,"cells":cells,"points":true,"density":false}))
        .await;
    let seen =
        collect(&mut socket, Duration::from_secs(10), |s| s.upserts(AIRCRAFT).iter().any(|(full, _)| *full)).await;
    let (_, local) = seen.upserts(AIRCRAFT).into_iter().find(|(full, _)| *full).unwrap();
    assert!(!local.is_empty() && local.len() < 400, "{} aircraft near London", local.len());
    let local: HashSet<u32> = local.into_iter().collect();
    // Facts for the new FULL arrive too (right after it), and ships stop.
    let after = collect(&mut socket, Duration::from_millis(1500), |_| false).await;
    let mut metas = seen.meta_ids(AIRCRAFT);
    metas.extend(after.meta_ids(AIRCRAFT));
    assert!(local.is_subset(&metas));
    assert!(after.upserts(SHIP).is_empty(), "the ships layer was dropped");
    assert_eq!(after.count(|f| matches!(f, Frame::Density { .. })), 0, "density was switched off");
    assert!(after.upserts(AIRCRAFT).iter().all(|(full, _)| !full));

    // A bad subscription gets an error and the previous one stays in force.
    send(
        &mut socket,
        json!({"t":"sub","layers":["aircraft"],"res":2,"cells":["nonsense"],"points":true,"density":false}),
    )
    .await;
    send(&mut socket, json!({"t":"sub","layers":["boats"],"res":0,"cells":[],"points":true,"density":false})).await;
    send(&mut socket, json!({"t":"sub","layers":["aircraft"],"res":9,"cells":[],"points":true,"density":false})).await;
    socket.send(Message::text("this is not json")).await.unwrap();
    let seen = collect(&mut socket, Duration::from_secs(5), |s| s.texts.len() >= 4).await;
    let codes: Vec<&str> = seen.texts.iter().map(|t| t["code"].as_str().unwrap()).collect();
    assert_eq!(codes, ["bad_cell", "bad_layer", "bad_resolution", "bad_request"]);
    assert!(seen.texts.iter().all(|t| t["t"] == "error" && t["message"].as_str().is_some_and(|m| !m.is_empty())));
    let seen = collect(&mut socket, Duration::from_secs(10), |s| !s.upserts(AIRCRAFT).is_empty()).await;
    assert!(seen.upserts(AIRCRAFT).iter().all(|(full, ids)| !full && ids.iter().all(|id| aircraft_ids.contains(id))));

    // Closing from the client side completes the closing handshake.
    socket.close(None).await.expect("close frame sent");
    let clean = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match socket.next().await {
                Some(Ok(Message::Close(_))) => break true,
                Some(Ok(_)) => {}
                Some(Err(_)) | None => break false,
            }
        }
    })
    .await
    .expect("the server answers the close");
    assert!(clean, "the server echoes the close frame");
    gateway.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compressed_streams_carry_the_same_frames_in_fewer_bytes() {
    let gateway = gateway(|_| {}).await;
    let sub = json!({"t":"sub","layers":["aircraft","ships"],"res":0,"cells":[],"points":true,"density":false});
    let got_full = |s: &Seen| {
        s.upserts(AIRCRAFT).iter().any(|(full, _)| *full)
            && s.upserts(SHIP).iter().any(|(full, _)| *full)
            && s.meta_ids(SHIP).len() == 600
    };

    let mut plain = connect(&gateway, "?v=1").await;
    send(&mut plain, sub.clone()).await;
    let plain_seen = collect(&mut plain, Duration::from_secs(10), got_full).await;
    assert_eq!(plain_seen.deflated, 0, "frames are only compressed when asked for");

    let mut packed = connect(&gateway, "?v=1&z=1").await;
    send(&mut packed, sub).await;
    let packed_seen = collect(&mut packed, Duration::from_secs(10), got_full).await;
    assert!(packed_seen.deflated >= 3, "the big frames are deflated");
    let full = |s: &Seen| {
        let mut ids = s.upserts(SHIP).into_iter().find(|(full, _)| *full).unwrap().1;
        ids.sort_unstable();
        ids
    };
    assert_eq!(full(&plain_seen), full(&packed_seen));
    let big = |s: &Seen| s.wire_bytes;
    assert!(big(&packed_seen) * 2 < big(&plain_seen), "{} vs {} bytes", big(&packed_seen), big(&plain_seen));

    gateway.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn http_endpoints_answer() {
    let gateway = gateway(|c| c.max_clients_per_ip = 2).await;
    let base = format!("http://{}", gateway.addr);
    let http = orya_halo_gateway::http_client("gateway-tests").unwrap();
    let get = |path: &str| {
        let request = http.get(format!("{base}{path}"));
        async move {
            let response = request.send().await.expect("request");
            let status = response.status().as_u16();
            (status, response.text().await.expect("body"))
        }
    };
    let (status, body) = get("/health").await;
    assert_eq!(status, 200);
    let health: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(health["status"], "ok");
    assert_eq!(health["mock"], true);
    assert_eq!(health["layers"]["aircraft"]["entities"], 400);
    assert_eq!(health["layers"]["aircraft"]["statusName"], "ok");
    assert_eq!(health["upstreams"].as_array().unwrap().len(), 2);

    let (status, metrics) = get("/metrics").await;
    assert_eq!(status, 200);
    assert!(metrics.contains("halo_entities{kind=\"ships\"} 600"));
    assert!(metrics.contains("halo_upstream_status{source=\"mock-aircraft\",layer=\"aircraft\"} 1"));
    assert!(metrics.contains("# TYPE halo_tick_seconds_last gauge"));

    let (status, body) = get("/v1/attribution").await;
    assert_eq!(status, 200);
    let attribution: Value = serde_json::from_str(&body).unwrap();
    let sources = attribution["sources"].as_array().unwrap();
    assert_eq!(sources.len(), 2);
    for key in ["id", "name", "layer", "licence", "licenceUrl", "attribution", "attributionUrl", "notes", "docs"] {
        assert!(sources[0][key].is_string(), "sources[0].{key}");
    }

    // Search by callsign prefix, then fetch the detail of the first hit by number and by name.
    let (status, body) = get("/v1/search?q=mock%20vessel%2012").await;
    assert_eq!(status, 200);
    let results: Value = serde_json::from_str(&body).unwrap();
    let hits = results["results"].as_array().unwrap();
    assert!(!hits.is_empty() && hits.len() <= 20);
    assert_eq!(hits[0]["title"], "MOCK VESSEL 12", "the exact match ranks first");
    assert_eq!(hits[0]["kind"], 2);
    let id = hits[0]["id"].as_u64().unwrap();
    for kind in ["2", "ship", "ships"] {
        let (status, body) = get(&format!("/v1/entity/{kind}/{id}")).await;
        assert_eq!(status, 200, "{body}");
        let entity: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(entity["id"], id);
        assert_eq!(entity["meta"]["label"], "MOCK VESSEL 12");
        assert_eq!(entity["meta"]["source"], "mock-ships");
        assert!(entity["lon"].is_number() && entity["lat"].is_number() && entity["fixTimeMs"].is_number());
        let track = entity["track"].as_array().unwrap();
        assert!(!track.is_empty() && track[0].as_array().unwrap().len() == 4);
        assert_eq!(entity["attribution"]["text"], "Simulated traffic, not real ships");
    }
    assert_eq!(get("/v1/entity/aircraft/1").await.0, 404);
    assert_eq!(get("/v1/entity/submarine/1").await.0, 400);
    assert_eq!(get("/v1/entity/ship/abc").await.0, 400);
    assert_eq!(get("/v1/search").await.0, 400);
    assert_eq!(get("/v1/search?q=zzzzzzzz").await.1, r#"{"query":"zzzzzzzz","results":[]}"#);
    assert_eq!(get("/nope").await.0, 404);

    // CORS: local development origins are allowed by default, others are not.
    let cors = |origin: &'static str| {
        let request = http.get(format!("{base}/health")).header("origin", origin);
        async move { request.send().await.unwrap().headers().get("access-control-allow-origin").cloned() }
    };
    assert_eq!(cors("http://localhost:5173").await.unwrap(), "http://localhost:5173");
    assert!(cors("https://elsewhere.example").await.is_none());

    // The WebSocket handshake enforces the same list, the protocol version and the per-address limit.
    assert_eq!(handshake_status(&gateway, "?v=2", None).await, 400);
    assert_eq!(handshake_status(&gateway, "?v=1", Some("https://elsewhere.example")).await, 403);
    assert_eq!(handshake_status(&gateway, "?v=1", Some("http://localhost:5173")).await, 101);
    // Dropped sockets give their place back, so hold two open for the limit check.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let _a = connect(&gateway, "?v=1").await;
    let _b = connect(&gateway, "").await;
    assert_eq!(handshake_status(&gateway, "?v=1", None).await, 429, "a third connection from one address is refused");

    gateway.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_closes_clients_cleanly() {
    let gateway = gateway(|_| {}).await;
    let mut socket = connect(&gateway, "?v=1").await;
    let _ = collect(&mut socket, Duration::from_secs(5), |s| !s.texts.is_empty()).await;
    gateway.stop().await;
    let closed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match socket.next().await {
                Some(Ok(Message::Close(frame))) => break frame.map(|f| u16::from(f.code)),
                Some(Ok(_)) => {}
                Some(Err(_)) | None => break None,
            }
        }
    })
    .await
    .expect("the socket closes promptly");
    assert_eq!(closed, Some(1001), "going away");
}
