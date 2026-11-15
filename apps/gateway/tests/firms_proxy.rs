//! The wildfire proxy against a local stand-in for NASA FIRMS: caching, single
//! flight, the allow-list, missing and rejected keys, stale copies when FIRMS
//! fails, and the key staying out of everything a client can read.

use std::io::Read;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering::SeqCst};
use std::time::Duration;

use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use orya_halo_gateway::config::{Config, Secret};
use orya_halo_gateway::{Gateway, start};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const KEY: &str = "0123456789abcdef0123456789abcdef";
const CSV: &str = "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_t31,frp,daynight\n\
                   -12.34567,130.12345,320.5,1.0,1.0,2026-11-14,0412,T,MODIS,80,6.1NRT,295.1,12.3,D\n";

/// How the stand-in answers. Each value is one of FIRMS's real behaviours.
#[derive(Clone, Copy, PartialEq)]
enum Answer {
    Csv,
    /// A rejected key: status 400 with a line of text.
    InvalidKey,
    /// The same text with status 200, which some FIRMS endpoints send.
    InvalidKeyAsOk,
    Limited,
    ServerError,
    /// A file far larger than the cap.
    Huge,
}

#[derive(Clone)]
struct Stub {
    answer: Arc<parking_lot::Mutex<Answer>>,
    delay_ms: Arc<AtomicU64>,
    requests: Arc<AtomicUsize>,
    paths: Arc<parking_lot::Mutex<Vec<String>>>,
}

impl Stub {
    fn set(&self, answer: Answer) {
        *self.answer.lock() = answer;
    }

    fn requests(&self) -> usize {
        self.requests.load(SeqCst)
    }
}

async fn stub_area(
    State(stub): State<Stub>,
    Path((key, source, area, days)): Path<(String, String, String, String)>,
) -> axum::response::Response {
    stub.requests.fetch_add(1, SeqCst);
    stub.paths.lock().push(format!("{key}/{source}/{area}/{days}"));
    tokio::time::sleep(Duration::from_millis(stub.delay_ms.load(SeqCst))).await;
    let answer = *stub.answer.lock();
    match answer {
        Answer::Csv => format!("{CSV}# {source} {days}\n").into_response(),
        Answer::InvalidKey => (StatusCode::BAD_REQUEST, "Invalid MAP_KEY.").into_response(),
        Answer::InvalidKeyAsOk => "Invalid MAP_KEY.".into_response(),
        Answer::Limited => (
            StatusCode::FORBIDDEN,
            "MAP_KEY is invalid or your have exceeded your transaction/time limit. Please try again later.",
        )
            .into_response(),
        // A real error page that happens to repeat the request, key and all.
        Answer::ServerError => {
            (StatusCode::INTERNAL_SERVER_ERROR, format!("error handling /api/area/csv/{key}/{source}")).into_response()
        }
        Answer::Huge => format!("{CSV}{}", "0,0,0\n".repeat(50_000)).into_response(),
    }
}

/// Start the stand-in and a gateway pointed at it.
async fn rig(configure: impl FnOnce(&mut Config)) -> (Stub, Gateway) {
    let stub = Stub {
        answer: Arc::new(parking_lot::Mutex::new(Answer::Csv)),
        delay_ms: Arc::new(AtomicU64::new(0)),
        requests: Arc::new(AtomicUsize::new(0)),
        paths: Arc::default(),
    };
    let app =
        Router::new().route("/api/area/csv/{key}/{source}/{area}/{days}", get(stub_area)).with_state(stub.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let mut config = Config::for_tests();
    config.firms_map_key = Some(Secret::new(KEY));
    config.firms_base_url = format!("http://{addr}");
    configure(&mut config);
    (stub, start(config).await.expect("gateway starts"))
}

struct Reply {
    status: u16,
    headers: reqwest::header::HeaderMap,
    body: String,
}

impl Reply {
    fn header(&self, name: &str) -> &str {
        self.headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or("")
    }

    fn error_code(&self) -> String {
        let json: Value =
            serde_json::from_str(&self.body).unwrap_or_else(|_| panic!("a JSON error body: {}", self.body));
        assert!(json["error"]["message"].as_str().is_some_and(|m| m.len() > 20 && m.ends_with('.')), "{json}");
        json["error"]["code"].as_str().expect("a code").to_owned()
    }
}

async fn fetch(gateway: &Gateway, path: &str) -> Reply {
    let http = orya_halo_gateway::http_client("gateway-tests").unwrap();
    let response = http.get(format!("http://{}{path}", gateway.addr)).send().await.expect("request");
    Reply {
        status: response.status().as_u16(),
        headers: response.headers().clone(),
        body: response.text().await.unwrap(),
    }
}

const MODIS_2: &str = "/v1/proxy/firms/MODIS_NRT/world/2";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_is_fetched_once_and_then_served_from_the_cache() {
    let (stub, gateway) = rig(|_| {}).await;
    let first = fetch(&gateway, MODIS_2).await;
    assert_eq!(first.status, 200, "{}", first.body);
    assert_eq!(first.body, format!("{CSV}# MODIS_NRT 2\n"), "the CSV is passed on unchanged");
    assert_eq!(first.header("content-type"), "text/csv; charset=utf-8");
    assert_eq!(first.header("x-halo-cache"), "miss");
    assert_eq!(first.header("vary"), "accept-encoding");
    assert_eq!(first.header("cache-control"), "public, max-age=300");
    assert_eq!(*stub.paths.lock(), [format!("{KEY}/MODIS_NRT/world/2")], "the key is added on the way out");

    for _ in 0..5 {
        let again = fetch(&gateway, MODIS_2).await;
        assert_eq!((again.status, again.header("x-halo-cache")), (200, "hit"));
        assert_eq!(again.body, first.body);
        assert!(again.header("age").parse::<u64>().is_ok());
    }
    assert_eq!(stub.requests(), 1, "five more clients, no more requests to FIRMS");

    // Another product or day range is another file.
    let viirs = fetch(&gateway, "/v1/proxy/firms/VIIRS_NOAA20_NRT/world/1").await;
    assert_eq!((viirs.status, viirs.header("x-halo-cache")), (200, "miss"));
    assert!(viirs.body.ends_with("# VIIRS_NOAA20_NRT 1\n"));
    assert_eq!(stub.requests(), 2);

    // The counters say the same, and nothing a client can read holds the key.
    let health: Value = serde_json::from_str(&fetch(&gateway, "/health").await.body).unwrap();
    let firms = &health["firms"];
    assert_eq!((firms["statusName"].as_str(), firms["cacheTtlS"].as_u64()), (Some("ok"), Some(1200)));
    assert_eq!((firms["cacheHits"].as_u64(), firms["cacheMisses"].as_u64()), (Some(5), Some(2)));
    assert_eq!((firms["upstreamRequests"].as_u64(), firms["upstreamErrors"].as_u64()), (Some(2), Some(0)));
    assert_eq!(firms["cachedFiles"], 2);
    assert!(firms["cachedBytes"].as_u64().unwrap() > 100 && firms["lastOkSecondsAgo"].is_number());
    let metrics = fetch(&gateway, "/metrics").await.body;
    assert!(metrics.contains("halo_firms_cache_hits_total 5\n"), "{metrics}");
    assert!(metrics.contains("halo_firms_cache_misses_total 2\n"));
    assert!(metrics.contains("halo_firms_upstream_requests_total 2\n"));
    assert!(metrics.contains("halo_firms_status 1\n"));
    let attribution = fetch(&gateway, "/v1/attribution").await.body;
    let sources: Value = serde_json::from_str(&attribution).unwrap();
    let nasa = sources["sources"].as_array().unwrap().iter().find(|s| s["id"] == "nasa-firms").expect("NASA FIRMS");
    assert_eq!(nasa["attribution"], "Active fire data: NASA FIRMS");
    assert_eq!((nasa["active"].as_bool(), nasa["redistribution"].as_bool()), (Some(true), Some(true)));
    assert_eq!(nasa["requiresKey"], "FIRMS_MAP_KEY");
    for readable in [health.to_string(), metrics, attribution, fetch(&gateway, "/").await.body] {
        assert!(!readable.contains(KEY));
    }
    gateway.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn many_clients_at_once_cause_one_request() {
    let (stub, gateway) = rig(|_| {}).await;
    stub.delay_ms.store(400, SeqCst);
    let gateway = Arc::new(gateway);
    let clients: Vec<_> = (0..24)
        .map(|_| {
            let gateway = gateway.clone();
            tokio::spawn(async move { fetch(&gateway, MODIS_2).await })
        })
        .collect();
    let mut states = Vec::new();
    for client in clients {
        let reply = client.await.unwrap();
        assert_eq!(reply.status, 200);
        assert_eq!(reply.body, format!("{CSV}# MODIS_NRT 2\n"));
        states.push(reply.header("x-halo-cache").to_owned());
    }
    assert_eq!(stub.requests(), 1, "24 clients, one request to FIRMS");
    assert_eq!(states.iter().filter(|s| *s == "miss").count(), 1, "{states:?}");
    assert_eq!(states.iter().filter(|s| *s == "hit").count(), 23);

    // A client that gives up while its request to FIRMS is in flight does not
    // waste it: the answer still lands in the cache for the next one.
    let http = orya_halo_gateway::http_client("gateway-tests").unwrap();
    let url = format!("http://{}/v1/proxy/firms/VIIRS_SNPP_NRT/world/1", gateway.addr);
    let gave_up = http.get(&url).timeout(Duration::from_millis(100)).send().await;
    assert!(gave_up.is_err(), "the impatient client timed out");
    tokio::time::sleep(Duration::from_millis(600)).await;
    let next = fetch(&gateway, "/v1/proxy/firms/VIIRS_SNPP_NRT/world/1").await;
    assert_eq!((next.status, next.header("x-halo-cache")), (200, "hit"));
    assert_eq!(stub.requests(), 2);
    Arc::into_inner(gateway).unwrap().stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_listed_sources_and_day_ranges_are_proxied() {
    let (stub, gateway) = rig(|_| {}).await;
    for path in [
        "/v1/proxy/firms/modis_nrt/world/1",
        "/v1/proxy/firms/MODIS_SP/world/1",
        "/v1/proxy/firms/LANDSAT_NRT/world/1",
        "/v1/proxy/firms/anything/world/1",
    ] {
        let reply = fetch(&gateway, path).await;
        assert_eq!((reply.status, reply.error_code().as_str()), (400, "bad_source"), "{path}");
    }
    for path in [
        "/v1/proxy/firms/MODIS_NRT/world/0",
        "/v1/proxy/firms/MODIS_NRT/world/6",
        "/v1/proxy/firms/MODIS_NRT/world/10",
        "/v1/proxy/firms/MODIS_NRT/world/two",
        "/v1/proxy/firms/MODIS_NRT/world/-1",
    ] {
        let reply = fetch(&gateway, path).await;
        assert_eq!((reply.status, reply.error_code().as_str()), (400, "bad_days"), "{path}");
    }
    // Only the whole world is offered, and only at this depth.
    assert_eq!(fetch(&gateway, "/v1/proxy/firms/MODIS_NRT/-10,40,10,60/1").await.status, 404);
    assert_eq!(fetch(&gateway, "/v1/proxy/firms/MODIS_NRT/world/1/2026-11-01").await.status, 404);
    assert_eq!(fetch(&gateway, "/v1/proxy/firms").await.status, 404);
    assert_eq!(stub.requests(), 0, "nothing reached FIRMS");
    // Every listed combination is accepted.
    for source in ["MODIS_NRT", "VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT", "VIIRS_SNPP_NRT"] {
        for days in 1..=5 {
            assert_eq!(fetch(&gateway, &format!("/v1/proxy/firms/{source}/world/{days}")).await.status, 200);
        }
    }
    assert_eq!(stub.requests(), 20);
    gateway.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn without_a_key_the_proxy_says_what_is_missing() {
    let (stub, gateway) = rig(|config| config.firms_map_key = None).await;
    let reply = fetch(&gateway, MODIS_2).await;
    assert_eq!(reply.status, 503);
    assert_eq!(reply.error_code(), "needs_key");
    assert!(reply.body.contains("FIRMS_MAP_KEY"), "{}", reply.body);
    assert_eq!(reply.header("cache-control"), "no-store");
    assert_eq!(stub.requests(), 0);
    // A bad path is still a bad path: the client's mistake comes first.
    assert_eq!(fetch(&gateway, "/v1/proxy/firms/MODIS_NRT/world/9").await.status, 400);

    let health: Value = serde_json::from_str(&fetch(&gateway, "/health").await.body).unwrap();
    assert_eq!(health["firms"]["statusName"], "needs-key");
    assert!(fetch(&gateway, "/metrics").await.body.contains("halo_firms_status 3\n"));
    let attribution: Value = serde_json::from_str(&fetch(&gateway, "/v1/attribution").await.body).unwrap();
    let nasa = attribution["sources"].as_array().unwrap().iter().find(|s| s["id"] == "nasa-firms").unwrap();
    assert_eq!(nasa["active"], false);
    gateway.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_key_firms_rejects_is_reported_as_a_missing_key() {
    for answer in [Answer::InvalidKey, Answer::InvalidKeyAsOk] {
        let (stub, gateway) = rig(|_| {}).await;
        stub.set(answer);
        let reply = fetch(&gateway, MODIS_2).await;
        assert_eq!(reply.status, 503);
        assert_eq!(reply.error_code(), "needs_key");
        assert!(reply.body.contains("rejected") && !reply.body.contains(KEY), "{}", reply.body);
        assert_eq!(stub.requests(), 1);

        // The key is the same for every file, so none of them is tried again for now.
        assert_eq!(fetch(&gateway, MODIS_2).await.status, 503);
        assert_eq!(fetch(&gateway, "/v1/proxy/firms/VIIRS_SNPP_NRT/world/1").await.error_code(), "needs_key");
        assert_eq!(stub.requests(), 1, "a rejected key is not hammered");
        let health: Value = serde_json::from_str(&fetch(&gateway, "/health").await.body).unwrap();
        assert_eq!(health["firms"]["statusName"], "needs-key");
        assert_eq!(health["firms"]["upstreamErrors"], 1);
        gateway.stop().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rejected_key_is_not_hidden_behind_an_old_copy() {
    let (stub, gateway) = rig(|config| config.firms_cache_ttl = Duration::from_millis(200)).await;
    assert_eq!(fetch(&gateway, MODIS_2).await.status, 200);
    stub.set(Answer::InvalidKey);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let reply = fetch(&gateway, MODIS_2).await;
    assert_eq!((reply.status, reply.error_code().as_str()), (503, "needs_key"));
    gateway.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_old_copy_is_served_while_firms_is_failing() {
    let (stub, gateway) = rig(|config| config.firms_cache_ttl = Duration::from_millis(200)).await;
    let fresh = fetch(&gateway, MODIS_2).await;
    assert_eq!((fresh.status, fresh.header("x-halo-cache")), (200, "miss"));

    stub.set(Answer::ServerError);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let stale = fetch(&gateway, MODIS_2).await;
    assert_eq!((stale.status, stale.header("x-halo-cache")), (200, "stale"));
    assert_eq!(stale.body, fresh.body);
    assert_eq!(stale.header("cache-control"), "public, max-age=60");
    assert_eq!(stub.requests(), 2);
    // The failure is remembered: the next clients get the old copy without another request.
    for _ in 0..3 {
        assert_eq!(fetch(&gateway, MODIS_2).await.header("x-halo-cache"), "stale");
    }
    assert_eq!(stub.requests(), 2);

    // A file never fetched has no old copy: that is a plain 502, with nothing FIRMS said in it.
    let missing = fetch(&gateway, "/v1/proxy/firms/VIIRS_NOAA21_NRT/world/3").await;
    assert_eq!(missing.status, 502);
    assert_eq!(missing.error_code(), "upstream_error");
    assert!(!missing.body.contains(KEY) && !missing.body.contains("error handling"), "{}", missing.body);
    assert_eq!(missing.header("cache-control"), "no-store");
    assert_eq!(stub.requests(), 3);
    assert_eq!(fetch(&gateway, "/v1/proxy/firms/VIIRS_NOAA21_NRT/world/3").await.status, 502);
    assert_eq!(stub.requests(), 3, "a failing file is not retried at once");

    let health: Value = serde_json::from_str(&fetch(&gateway, "/health").await.body).unwrap();
    let firms = &health["firms"];
    assert_eq!(firms["statusName"], "degraded");
    assert_eq!((firms["staleServed"].as_u64(), firms["upstreamErrors"].as_u64()), (Some(4), Some(2)));
    assert!(!health.to_string().contains(KEY));
    gateway.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_request_limit_and_oversized_files_are_plain_502s() {
    let (stub, gateway) = rig(|config| config.firms_max_bytes = 64 * 1024).await;
    stub.set(Answer::Huge);
    let huge = fetch(&gateway, MODIS_2).await;
    assert_eq!((huge.status, huge.error_code().as_str()), (502, "upstream_error"));

    stub.set(Answer::Limited);
    let limited = fetch(&gateway, "/v1/proxy/firms/MODIS_NRT/world/1").await;
    assert_eq!((limited.status, limited.error_code().as_str()), (502, "upstream_limited"));
    // Over the limit means stop asking, for every file.
    stub.set(Answer::Csv);
    assert_eq!(fetch(&gateway, "/v1/proxy/firms/MODIS_NRT/world/3").await.error_code(), "upstream_limited");
    assert_eq!(stub.requests(), 2);
    gateway.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_proxy_follows_the_normal_cors_rules_and_sends_gzip_on_the_wire() {
    let (_stub, gateway) = rig(|_| {}).await;
    let http = orya_halo_gateway::http_client("gateway-tests").unwrap();
    let cors = |origin: &'static str| {
        let request = http.get(format!("http://{}{MODIS_2}", gateway.addr)).header("origin", origin);
        async move { request.send().await.unwrap().headers().clone() }
    };
    let local = cors("http://localhost:5173").await;
    assert_eq!(local.get("access-control-allow-origin").unwrap(), "http://localhost:5173");
    let exposed = local.get("access-control-expose-headers").unwrap().to_str().unwrap().to_ascii_lowercase();
    assert!(exposed.contains("x-halo-cache") && exposed.contains("age"), "{exposed}");
    assert!(cors("https://elsewhere.example").await.get("access-control-allow-origin").is_none());

    // Speak HTTP by hand to see the bytes: gzip for a client that takes it, plain CSV for one that does not.
    let raw = |accept: &'static str| async move {
        let mut socket = tokio::net::TcpStream::connect(gateway.addr).await.unwrap();
        let request = format!("GET {MODIS_2} HTTP/1.1\r\nHost: gateway\r\n{accept}Connection: close\r\n\r\n");
        socket.write_all(request.as_bytes()).await.unwrap();
        let mut reply = Vec::new();
        socket.read_to_end(&mut reply).await.unwrap();
        let split = reply.windows(4).position(|w| w == b"\r\n\r\n").expect("a header block");
        (String::from_utf8_lossy(&reply[..split]).to_ascii_lowercase(), reply[split + 4..].to_vec())
    };
    let (head, body) = raw("Accept-Encoding: gzip, deflate, br\r\n").await;
    assert!(head.starts_with("http/1.1 200") && head.contains("content-encoding: gzip"), "{head}");
    let mut csv = String::new();
    flate2::read::GzDecoder::new(&body[..]).read_to_string(&mut csv).expect("a gzip body");
    assert_eq!(csv, format!("{CSV}# MODIS_NRT 2\n"));

    let (head, body) = raw("").await;
    assert!(head.starts_with("http/1.1 200") && !head.contains("content-encoding"), "{head}");
    assert_eq!(String::from_utf8(body).unwrap(), csv);
    gateway.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mock_mode_makes_no_outside_requests() {
    let (stub, gateway) = rig(|config| {
        config.mock = Some(orya_halo_gateway::config::MockConfig { aircraft: 5, ships: 5 });
    })
    .await;
    let reply = fetch(&gateway, MODIS_2).await;
    assert_eq!((reply.status, reply.error_code().as_str()), (503, "unavailable"));
    assert_eq!(stub.requests(), 0);
    let attribution = fetch(&gateway, "/v1/attribution").await.body;
    assert!(!attribution.contains("nasa-firms"), "a source that is not in use is not credited");
    gateway.stop().await;
}
