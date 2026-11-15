//! The satellite element cache against a local stand-in for CelesTrak: one
//! download per refresh window whatever clients do, single flight, stopping
//! at the first non-200 answer, old copies while CelesTrak refuses, 304s,
//! the allow-list, mock mode, and the saved copy surviving a restart.

use std::io::Read;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering::SeqCst};
use std::time::Duration;

use axum::Router;
use axum::extract::{RawQuery, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::get;
use orya_halo_gateway::config::Config;
use orya_halo_gateway::{Gateway, start};
use serde_json::Value;

/// Recorded from CelesTrak on 2026-11-14 (GROUP=stations, first two objects), with its CRLF line ends.
const CSV: &str = "OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION,ECCENTRICITY,INCLINATION,RA_OF_ASC_NODE,ARG_OF_PERICENTER,MEAN_ANOMALY,EPHEMERIS_TYPE,CLASSIFICATION_TYPE,NORAD_CAT_ID,ELEMENT_SET_NO,REV_AT_EPOCH,BSTAR,MEAN_MOTION_DOT,MEAN_MOTION_DDOT\r\n\
ISS (ZARYA),1998-067A,2026-11-14T04:10:44.607360,15.49541553,.00038573,51.6315,301.8926,64.2513,295.8899,0,U,25544,999,54121,.16935744E-3,.9139E-4,0\r\n\
CSS (TIANHE),2021-035A,2026-11-14T03:22:41.405376,15.60417052,.00062096,41.4655,15.1946,49.3826,310.7493,0,U,48274,999,31205,.27125178E-3,.18493E-3,0\r\n";
/// CelesTrak's answer to a second download of the same update, as it words it.
const REFUSAL: &str = "GP data has not updated since your last successful\r\ndownload of GROUP=active at 2026-11-14 15:19:02 UTC.\r\nData is updated once every 2 hours.\r\n";

#[derive(Clone, Copy, PartialEq)]
enum Answer {
    Csv,
    /// The once-per-update refusal.
    Refused,
    ServerError,
    /// HTTP 200 with something that is not OMM CSV.
    NotCsv,
    /// A redirect, as CelesTrak sends for a wrong domain or a legacy query.
    Moved,
    /// A file far larger than the cap.
    Huge,
}

#[derive(Clone)]
struct Stub {
    answer: Arc<parking_lot::Mutex<Answer>>,
    delay_ms: Arc<AtomicU64>,
    requests: Arc<AtomicUsize>,
    /// Query string and User-Agent of every request.
    seen: Arc<parking_lot::Mutex<Vec<(String, String)>>>,
    elsewhere: Arc<AtomicUsize>,
    /// Where the stand-in listens, for gateways started later in a test.
    base: String,
}

impl Stub {
    fn set(&self, answer: Answer) {
        *self.answer.lock() = answer;
    }

    fn requests(&self) -> usize {
        self.requests.load(SeqCst)
    }
}

async fn stub_gp(State(stub): State<Stub>, RawQuery(query): RawQuery, headers: HeaderMap) -> axum::response::Response {
    stub.requests.fetch_add(1, SeqCst);
    let agent = headers.get(header::USER_AGENT).and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
    stub.seen.lock().push((query.unwrap_or_default(), agent));
    tokio::time::sleep(Duration::from_millis(stub.delay_ms.load(SeqCst))).await;
    let answer = *stub.answer.lock();
    match answer {
        Answer::Csv => ([(header::CONTENT_TYPE, "text/plain; charset=UTF-8")], CSV).into_response(),
        Answer::Refused => (StatusCode::FORBIDDEN, REFUSAL).into_response(),
        Answer::ServerError => (StatusCode::SERVICE_UNAVAILABLE, "<html>Server busy</html>").into_response(),
        Answer::NotCsv => "No GP data found".into_response(),
        Answer::Moved => (StatusCode::MOVED_PERMANENTLY, [(header::LOCATION, "/elsewhere")]).into_response(),
        Answer::Huge => format!("{CSV}{}", "X,1,2026-11-14T00:00:00,15,0,0,0,0,0,0,U,1,999,1,0,0,0\r\n".repeat(20_000))
            .into_response(),
    }
}

async fn stub_elsewhere(State(stub): State<Stub>) -> &'static str {
    stub.elsewhere.fetch_add(1, SeqCst);
    CSV
}

/// Start the stand-in and a gateway pointed at it.
async fn rig(configure: impl FnOnce(&mut Config)) -> (Stub, Gateway) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let stub = Stub {
        answer: Arc::new(parking_lot::Mutex::new(Answer::Csv)),
        delay_ms: Arc::new(AtomicU64::new(0)),
        requests: Arc::new(AtomicUsize::new(0)),
        seen: Arc::default(),
        elsewhere: Arc::new(AtomicUsize::new(0)),
        base,
    };
    let app = Router::new()
        .route("/NORAD/elements/gp.php", get(stub_gp))
        .route("/elsewhere", get(stub_elsewhere))
        .with_state(stub.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let gateway = gateway_for(&stub.base, configure).await;
    (stub, gateway)
}

async fn gateway_for(base: &str, configure: impl FnOnce(&mut Config)) -> Gateway {
    let mut config = Config::for_tests();
    config.celestrak_base_url = base.to_owned();
    configure(&mut config);
    start(config).await.expect("gateway starts")
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

    fn max_age(&self) -> u64 {
        let control = self.header("cache-control");
        control.strip_prefix("public, max-age=").and_then(|s| s.parse().ok()).unwrap_or_else(|| panic!("{control}"))
    }
}

async fn fetch_with(gateway: &Gateway, path: &str, headers: &[(&str, &str)]) -> Reply {
    let http = orya_halo_gateway::http_client("gateway-tests").unwrap();
    let mut request = http.get(format!("http://{}{path}", gateway.addr));
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = request.send().await.expect("request");
    Reply {
        status: response.status().as_u16(),
        headers: response.headers().clone(),
        body: response.text().await.unwrap(),
    }
}

async fn fetch(gateway: &Gateway, path: &str) -> Reply {
    fetch_with(gateway, path, &[]).await
}

async fn health(gateway: &Gateway) -> Value {
    serde_json::from_str(&fetch(gateway, "/health").await.body).unwrap()
}

const ACTIVE: &str = "/v1/proxy/celestrak/active.csv";
const WINDOW: Duration = Duration::from_millis(500);

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_group_is_downloaded_once_and_then_served_from_the_cache() {
    let (stub, gateway) = rig(|_| {}).await;
    let first = fetch(&gateway, ACTIVE).await;
    assert_eq!(first.status, 200, "{}", first.body);
    assert_eq!(first.body, CSV, "the file is passed on unchanged");
    assert_eq!(first.header("content-type"), "text/csv; charset=utf-8");
    assert_eq!(first.header("x-halo-cache"), "miss");
    assert_eq!(first.header("vary"), "accept-encoding");
    assert_eq!(first.header("cache-control"), "public, max-age=3600", "browsers and CDNs hold it an hour");
    assert!(first.header("etag").starts_with("W/\""), "{}", first.header("etag"));
    let (query, agent) = stub.seen.lock()[0].clone();
    assert_eq!(query, "GROUP=active&FORMAT=CSV");
    assert!(agent.starts_with("orya-halo-gateway/") && agent.contains("shared CelesTrak cache"), "{agent}");

    for _ in 0..5 {
        let again = fetch(&gateway, ACTIVE).await;
        assert_eq!((again.status, again.header("x-halo-cache")), (200, "hit"));
        assert_eq!(again.body, CSV);
        assert_eq!(again.header("etag"), first.header("etag"));
        assert!(again.header("age").parse::<u64>().is_ok());
    }
    assert_eq!(stub.requests(), 1, "five more clients, no more requests to CelesTrak");

    // The stations group is its own file.
    let stations = fetch(&gateway, "/v1/proxy/celestrak/stations.csv").await;
    assert_eq!((stations.status, stations.header("x-halo-cache")), (200, "miss"));
    assert_eq!(stub.seen.lock()[1].0, "GROUP=stations&FORMAT=CSV");

    let health = health(&gateway).await;
    let c = &health["celestrak"];
    assert_eq!((c["statusName"].as_str(), c["refreshS"].as_u64()), (Some("ok"), Some(7200)));
    assert_eq!(c["maxStaleS"], 604_800);
    assert_eq!((c["cacheHits"].as_u64(), c["cacheMisses"].as_u64()), (Some(5), Some(2)));
    assert_eq!((c["upstreamRequests"].as_u64(), c["upstreamErrors"].as_u64()), (Some(2), Some(0)));
    assert!(c["cachedBytes"].as_u64().unwrap() > 100 && c["lastOkSecondsAgo"].is_number());
    let active = c["groups"].as_array().unwrap().iter().find(|g| g["group"] == "active").unwrap();
    assert!(active["nextRefreshInS"].as_i64().unwrap() > 7000, "{active}");
    let metrics = fetch(&gateway, "/metrics").await.body;
    assert!(metrics.contains("halo_celestrak_cache_hits_total 5\n"), "{metrics}");
    assert!(metrics.contains("halo_celestrak_upstream_requests_total 2\n"));
    assert!(metrics.contains("halo_celestrak_status 1\n"));
    let attribution: Value = serde_json::from_str(&fetch(&gateway, "/v1/attribution").await.body).unwrap();
    let source =
        attribution["sources"].as_array().unwrap().iter().find(|s| s["id"] == "celestrak-gp").expect("credited");
    assert_eq!(source["attribution"], "Satellite orbits: CelesTrak, from U.S. Space Force GP data");
    assert_eq!(source["layer"], "satellites");
    let index = fetch(&gateway, "/").await.body;
    assert!(index.contains("/v1/proxy/celestrak/{group}.csv"), "{index}");
    gateway.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn many_clients_at_once_cause_one_download() {
    let (stub, gateway) = rig(|_| {}).await;
    stub.delay_ms.store(400, SeqCst);
    let gateway = Arc::new(gateway);
    let clients: Vec<_> = (0..24)
        .map(|_| {
            let gateway = gateway.clone();
            tokio::spawn(async move { fetch(&gateway, ACTIVE).await })
        })
        .collect();
    let mut states = Vec::new();
    for client in clients {
        let reply = client.await.unwrap();
        assert_eq!((reply.status, reply.body.as_str()), (200, CSV));
        states.push(reply.header("x-halo-cache").to_owned());
    }
    assert_eq!(stub.requests(), 1, "24 clients, one download");
    assert_eq!(states.iter().filter(|s| *s == "miss").count(), 1, "{states:?}");

    // A client that gives up mid-download does not waste it: the copy still lands.
    let http = orya_halo_gateway::http_client("gateway-tests").unwrap();
    let url = format!("http://{}/v1/proxy/celestrak/stations.csv", gateway.addr);
    assert!(http.get(&url).timeout(Duration::from_millis(100)).send().await.is_err());
    tokio::time::sleep(Duration::from_millis(600)).await;
    let next = fetch(&gateway, "/v1/proxy/celestrak/stations.csv").await;
    assert_eq!((next.status, next.header("x-halo-cache")), (200, "hit"));
    assert_eq!(stub.requests(), 2);
    Arc::into_inner(gateway).unwrap().stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn celestrak_is_asked_at_most_once_per_refresh_window() {
    let (stub, gateway) = rig(|config| config.celestrak_refresh = WINDOW).await;
    assert_eq!(fetch(&gateway, ACTIVE).await.header("x-halo-cache"), "miss");
    // Inside the window: hits only, however many.
    for _ in 0..10 {
        assert_eq!(fetch(&gateway, ACTIVE).await.header("x-halo-cache"), "hit");
    }
    assert_eq!(stub.requests(), 1);
    // Past it, the next client's request refreshes the copy.
    tokio::time::sleep(WINDOW + Duration::from_millis(100)).await;
    assert_eq!(fetch(&gateway, ACTIVE).await.header("x-halo-cache"), "miss");
    assert_eq!(stub.requests(), 2);

    // A failed refresh spends the window too: nothing more is asked until it is over.
    stub.set(Answer::ServerError);
    tokio::time::sleep(WINDOW + Duration::from_millis(100)).await;
    for _ in 0..10 {
        let reply = fetch(&gateway, ACTIVE).await;
        assert_eq!((reply.status, reply.header("x-halo-cache")), (200, "stale"));
        assert_eq!(reply.body, CSV);
    }
    assert_eq!(stub.requests(), 3, "one attempt, then the old copy without asking again");
    tokio::time::sleep(WINDOW + Duration::from_millis(100)).await;
    stub.set(Answer::Csv);
    assert_eq!(fetch(&gateway, ACTIVE).await.header("x-halo-cache"), "miss");
    assert_eq!(stub.requests(), 4);
    gateway.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn nothing_is_fetched_until_a_client_asks() {
    let (stub, gateway) = rig(|config| config.celestrak_refresh = WINDOW).await;
    tokio::time::sleep(WINDOW * 3).await;
    // Health and metrics read the cache; they never fill it.
    let _ = health(&gateway).await;
    let _ = fetch(&gateway, "/metrics").await;
    assert_eq!(stub.requests(), 0, "an idle gateway asks CelesTrak nothing");
    gateway.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refusal_is_one_request_per_window_and_the_old_copy_stands_in() {
    // Nothing cached yet: a 503 that says when asking again could help.
    let (stub, gateway) = rig(|config| config.celestrak_refresh = Duration::from_secs(7200)).await;
    stub.set(Answer::Refused);
    let refused = fetch(&gateway, ACTIVE).await;
    assert_eq!((refused.status, refused.error_code().as_str()), (503, "unavailable"));
    assert!(refused.body.contains("HTTP 403") && !refused.body.contains("GP data has not updated"), "{}", refused.body);
    assert_eq!(refused.header("cache-control"), "no-store");
    let retry_after: u64 = refused.header("retry-after").parse().unwrap();
    assert!((7100..=7200).contains(&retry_after), "{retry_after}");
    stub.set(Answer::Csv);
    for _ in 0..20 {
        assert_eq!(fetch(&gateway, ACTIVE).await.status, 503);
    }
    assert_eq!(stub.requests(), 1, "a refusal is never retried inside the window");
    let state = health(&gateway).await;
    assert_eq!(state["celestrak"]["statusName"], "degraded");
    assert_eq!(state["celestrak"]["upstreamErrors"], 1);
    gateway.stop().await;

    // With a copy cached, a refusal serves the copy, marked stale, with its age.
    let (stub, gateway) = rig(|config| config.celestrak_refresh = WINDOW).await;
    let fresh = fetch(&gateway, ACTIVE).await;
    stub.set(Answer::Refused);
    tokio::time::sleep(WINDOW + Duration::from_millis(100)).await;
    for _ in 0..5 {
        let stale = fetch(&gateway, ACTIVE).await;
        assert_eq!((stale.status, stale.header("x-halo-cache")), (200, "stale"));
        assert_eq!((stale.body.as_str(), stale.header("etag")), (CSV, fresh.header("etag")));
        assert!(stale.header("age").parse::<u64>().is_ok());
        // Held until the gateway could have a newer copy, a minute at least.
        assert_eq!(stale.max_age(), stale.header("age").parse::<u64>().unwrap() + 60);
    }
    assert_eq!(stub.requests(), 2);
    assert_eq!(health(&gateway).await["celestrak"]["staleServed"], 5);
    gateway.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_old_copy_is_served_for_a_week_at_most() {
    let (stub, gateway) = rig(|config| {
        config.celestrak_refresh = Duration::from_millis(300);
        config.celestrak_max_stale = Duration::from_millis(900);
    })
    .await;
    assert_eq!(fetch(&gateway, ACTIVE).await.status, 200);
    stub.set(Answer::ServerError);
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(fetch(&gateway, ACTIVE).await.header("x-halo-cache"), "stale");
    tokio::time::sleep(Duration::from_millis(700)).await;
    let gone = fetch(&gateway, ACTIVE).await;
    assert_eq!((gone.status, gone.error_code().as_str()), (503, "unavailable"));
    gateway.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_matching_etag_gets_a_304() {
    let (stub, gateway) = rig(|_| {}).await;
    let first = fetch(&gateway, ACTIVE).await;
    let tag = first.header("etag").to_owned();
    let same = fetch_with(&gateway, ACTIVE, &[("if-none-match", &tag)]).await;
    assert_eq!(same.status, 304);
    assert!(same.body.is_empty());
    assert_eq!(same.header("etag"), tag);
    assert_eq!(same.header("cache-control"), first.header("cache-control"));
    assert_eq!(same.header("x-halo-cache"), "hit");
    let strong = tag.trim_start_matches("W/").to_owned();
    assert_eq!(fetch_with(&gateway, ACTIVE, &[("if-none-match", &strong)]).await.status, 304);
    let other = fetch_with(&gateway, ACTIVE, &[("if-none-match", "W/\"0000000000000000-1\"")]).await;
    assert_eq!((other.status, other.body.as_str()), (200, CSV));
    assert_eq!(stub.requests(), 1);
    assert_eq!(health(&gateway).await["celestrak"]["notModified"], 2);
    gateway.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_listed_groups_are_proxied() {
    let (stub, gateway) = rig(|_| {}).await;
    for path in [
        "/v1/proxy/celestrak/starlink.csv",
        "/v1/proxy/celestrak/active",
        "/v1/proxy/celestrak/ACTIVE.csv",
        "/v1/proxy/celestrak/active.json",
        "/v1/proxy/celestrak/active.csv.gz",
        "/v1/proxy/celestrak/..%2Factive.csv",
    ] {
        let reply = fetch(&gateway, path).await;
        assert_eq!((reply.status, reply.error_code().as_str()), (400, "bad_group"), "{path}");
        assert!(reply.body.contains("active.csv"), "{}", reply.body);
    }
    assert_eq!(fetch(&gateway, "/v1/proxy/celestrak").await.status, 404);
    assert_eq!(fetch(&gateway, "/v1/proxy/celestrak/active.csv/x").await.status, 404);
    assert_eq!(stub.requests(), 0, "nothing reached CelesTrak");
    gateway.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn redirects_error_pages_and_oversized_files_stop_the_attempt() {
    for (answer, expected) in
        [(Answer::Moved, "HTTP 301"), (Answer::NotCsv, "orbital elements"), (Answer::Huge, "orbital elements")]
    {
        let (stub, gateway) = rig(|config| config.celestrak_max_bytes = 64 * 1024).await;
        stub.set(answer);
        let reply = fetch(&gateway, ACTIVE).await;
        assert_eq!((reply.status, reply.error_code().as_str()), (503, "unavailable"));
        assert!(reply.body.contains(expected), "{}", reply.body);
        assert_eq!(fetch(&gateway, ACTIVE).await.status, 503);
        assert_eq!(stub.requests(), 1);
        assert_eq!(stub.elsewhere.load(SeqCst), 0, "a redirect is not followed");
        gateway.stop().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gzip_goes_to_clients_that_take_it() {
    let (_stub, gateway) = rig(|_| {}).await;
    let http = reqwest::Client::builder().no_gzip().build().unwrap();
    let url = format!("http://{}{ACTIVE}", gateway.addr);
    let packed = http.get(&url).header("accept-encoding", "gzip").send().await.unwrap();
    assert_eq!(packed.headers().get("content-encoding").unwrap(), "gzip");
    let mut csv = String::new();
    flate2::read::GzDecoder::new(&packed.bytes().await.unwrap()[..]).read_to_string(&mut csv).unwrap();
    assert_eq!(csv, CSV);
    let plain = http.get(&url).send().await.unwrap();
    assert!(plain.headers().get("content-encoding").is_none());
    assert_eq!(plain.text().await.unwrap(), CSV);
    // A browser page may read where the copy came from and how old it is.
    let cors = http.get(&url).header("origin", "http://localhost:5173").send().await.unwrap();
    let exposed = cors.headers().get("access-control-expose-headers").unwrap().to_str().unwrap().to_ascii_lowercase();
    assert!(exposed.contains("x-halo-cache") && exposed.contains("age"), "{exposed}");
    gateway.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mock_mode_makes_no_outside_requests() {
    let (stub, gateway) = rig(|config| {
        config.mock = Some(orya_halo_gateway::config::MockConfig { aircraft: 5, ships: 5 });
    })
    .await;
    let reply = fetch(&gateway, ACTIVE).await;
    assert_eq!((reply.status, reply.error_code().as_str()), (503, "unavailable"));
    assert!(reply.body.contains("mock mode"), "{}", reply.body);
    assert!(reply.headers.get("retry-after").is_none());
    assert_eq!(stub.requests(), 0);
    assert_eq!(health(&gateway).await["celestrak"]["statusName"], "off");
    assert!(!fetch(&gateway, "/v1/attribution").await.body.contains("celestrak-gp"));
    gateway.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restart_keeps_the_copy_and_the_window() {
    let dir = std::env::temp_dir().join(format!("halo-celestrak-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let keep = |config: &mut Config| {
        config.celestrak_cache_dir = Some(dir.clone());
        config.celestrak_refresh = Duration::from_secs(7200);
    };

    let (stub, gateway) = rig(keep).await;
    let first = fetch(&gateway, ACTIVE).await;
    assert_eq!(first.header("x-halo-cache"), "miss");
    gateway.stop().await;

    // A new gateway over the same directory: the copy is served without a download.
    let restarted = gateway_for(&stub.base, keep).await;
    let again = fetch(&restarted, ACTIVE).await;
    assert_eq!((again.status, again.header("x-halo-cache")), (200, "hit"));
    assert_eq!((again.body.as_str(), again.header("etag")), (CSV, first.header("etag")));
    assert_eq!(stub.requests(), 1, "a restart does not spend another download");
    restarted.stop().await;

    // A refused attempt is remembered as well: the restarted gateway does not ask again.
    let _ = std::fs::remove_dir_all(&dir);
    stub.set(Answer::Refused);
    let refused = gateway_for(&stub.base, keep).await;
    assert_eq!(fetch(&refused, "/v1/proxy/celestrak/stations.csv").await.status, 503);
    refused.stop().await;
    let after = gateway_for(&stub.base, keep).await;
    stub.set(Answer::Csv);
    let reply = fetch(&after, "/v1/proxy/celestrak/stations.csv").await;
    assert_eq!((reply.status, reply.error_code().as_str()), (503, "unavailable"));
    assert!(reply.body.contains("HTTP 403"), "{}", reply.body);
    assert_eq!(stub.requests(), 2, "one refused request, none after the restart");
    after.stop().await;
    let _ = std::fs::remove_dir_all(&dir);
}
