//! HTTP endpoints: health, metrics, entity detail, search, attribution, the
//! wildfire proxy and the satellite element cache.

use std::collections::HashMap;
use std::fmt::Write;
use std::sync::atomic::Ordering::Relaxed;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{Value, json};
use tokio::sync::oneshot;
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::App;
use crate::celestrak::{self, Group};
use crate::engine::Command;
use crate::enrich::ROUTES_ATTRIBUTION;
use crate::firms::{self, BadFile, CacheState, Failure, FireFile};
use crate::model::{Kind, UpstreamStatus, now_ms};
use crate::protocol::MetaKey;
use crate::world::EntityDetail;

const SEARCH_DEFAULT_LIMIT: usize = 20;
const SEARCH_MAX_LIMIT: usize = 50;
const SEARCH_MAX_QUERY: usize = 64;
/// Says whether a proxied file came from the cache: `hit`, `miss` or `stale`.
const CACHE_STATE_HEADER: HeaderName = HeaderName::from_static("x-halo-cache");
/// A browser may reuse a proxied file this long without asking the gateway again.
const PROXY_MAX_AGE_S: u64 = 300;

pub fn router(app: App) -> Router {
    let allowed = app.config.allowed_origins.clone();
    let cors = CorsLayer::new()
        .allow_methods([Method::GET])
        .allow_headers([header::CONTENT_TYPE])
        // Let a page read how old a proxied file is and where it came from.
        .expose_headers([header::AGE, CACHE_STATE_HEADER])
        .allow_origin(AllowOrigin::predicate(move |origin: &HeaderValue, _| {
            origin.to_str().is_ok_and(|o| allowed.allows(o))
        }));
    Router::new()
        .route("/", get(index))
        .route("/health", get(health))
        .route("/metrics", get(metrics))
        .route("/v1/stream", get(crate::ws::stream))
        .route("/v1/entity/{kind}/{id}", get(entity))
        .route("/v1/search", get(search))
        .route("/v1/attribution", get(attribution))
        .route("/v1/proxy/firms/{source}/world/{days}", get(firms_proxy))
        .route("/v1/proxy/celestrak/{file}", get(celestrak_proxy))
        .layer(cors)
        .with_state(app)
}

fn error(status: StatusCode, code: &str, message: impl Into<String>) -> Response {
    (status, Json(json!({ "error": { "code": code, "message": message.into() } }))).into_response()
}

async fn index() -> Json<Value> {
    Json(json!({
        "name": "Orya Halo gateway",
        "version": env!("CARGO_PKG_VERSION"),
        "protocol": 1,
        "stream": "/v1/stream?v=1",
        "endpoints": [
            "/health",
            "/metrics",
            "/v1/entity/{kind}/{id}",
            "/v1/search?q=",
            "/v1/attribution",
            "/v1/proxy/firms/{source}/world/{days}",
            "/v1/proxy/celestrak/{group}.csv"
        ],
    }))
}

fn layers_json(app: &App) -> Value {
    let mut layers = serde_json::Map::new();
    for kind in Kind::ALL {
        let status = app.registry.layer_status(kind);
        layers.insert(
            kind.layer().to_owned(),
            json!({
                "status": status as u8,
                "statusName": status.name(),
                "attribution": app.registry.layer_attribution(kind),
                "entities": app.metrics.entities[kind.index()].load(Relaxed),
            }),
        );
    }
    Value::Object(layers)
}

/// Liveness and per-upstream status.
async fn health(State(app): State<App>) -> Json<Value> {
    let now = now_ms();
    let upstreams: Vec<Value> = app
        .registry
        .sources
        .iter()
        .map(|s| {
            let count = s.latency_count.load(Relaxed);
            let last_ok = s.last_ok_ms.load(Relaxed);
            json!({
                "id": s.info.id,
                "name": s.info.name,
                "layer": s.info.kind.layer(),
                "status": s.status() as u8,
                "statusName": s.status().name(),
                "note": s.note(),
                "requests": s.requests.load(Relaxed),
                "errors": s.errors.load(Relaxed),
                "rateLimited": s.rate_limited.load(Relaxed),
                "observations": s.observations.load(Relaxed),
                "lastOkSecondsAgo": (last_ok > 0).then(|| (now - last_ok) / 1000),
                "latencyMsLast": s.latency_ms_last.load(Relaxed),
                "latencyMsMean": (count > 0).then(|| s.latency_ms_sum.load(Relaxed) / count),
                "budget": s.budget_status(),
            })
        })
        .collect();
    let ticks = app.metrics.ticks.load(Relaxed);
    Json(json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "protocol": 1,
        "uptimeS": (now - app.metrics.started_ms.load(Relaxed)) / 1000,
        "mock": app.config.mock.is_some(),
        "clients": app.limits.total(),
        "tick": {
            "intervalMs": app.config.tick_ms,
            "count": ticks,
            "lastMs": app.metrics.tick_micros_last.load(Relaxed) as f64 / 1000.0,
            "maxMs": app.metrics.tick_micros_max.load(Relaxed) as f64 / 1000.0,
            "meanMs": if ticks > 0 { app.metrics.tick_micros_sum.load(Relaxed) as f64 / ticks as f64 / 1000.0 } else { 0.0 },
            "overruns": app.metrics.tick_overruns.load(Relaxed),
        },
        "layers": layers_json(&app),
        "upstreams": upstreams,
        "aircraftSweep": app.sweep.as_ref().map(|s| s.stats(now)),
        "firms": firms_json(&app),
        "celestrak": celestrak_json(&app),
    }))
}

/// The satellite element cache's state and counters, for `/health`.
fn celestrak_json(app: &App) -> Value {
    let c = app.celestrak.stats();
    let groups: Vec<Value> = c
        .groups
        .iter()
        .map(|g| {
            json!({
                "group": g.group,
                "ageS": g.age_s,
                "bytes": g.bytes,
                "lastAttemptSecondsAgo": g.last_attempt_seconds_ago,
                "nextRefreshInS": g.next_refresh_in_s,
                "lastFailure": g.last_failure,
            })
        })
        .collect();
    json!({
        "status": c.status as u8,
        "statusName": c.status.name(),
        "note": c.note,
        "refreshS": app.celestrak.refresh_interval().as_secs(),
        "maxStaleS": app.celestrak.max_stale().as_secs(),
        "cacheHits": c.cache_hits,
        "cacheMisses": c.cache_misses,
        "notModified": c.not_modified,
        "upstreamRequests": c.upstream_requests,
        "upstreamErrors": c.upstream_errors,
        "staleServed": c.stale_served,
        "unavailable": c.unavailable,
        "cachedBytes": c.cached_bytes,
        "lastOkSecondsAgo": c.last_ok_seconds_ago,
        "groups": groups,
    })
}

/// The wildfire proxy's state and counters, for `/health`.
fn firms_json(app: &App) -> Value {
    let f = app.firms.stats();
    json!({
        "status": f.status as u8,
        "statusName": f.status.name(),
        "note": f.note,
        "cacheTtlS": app.config.firms_cache_ttl.as_secs(),
        "cacheHits": f.cache_hits,
        "cacheMisses": f.cache_misses,
        "upstreamRequests": f.upstream_requests,
        "upstreamErrors": f.upstream_errors,
        "staleServed": f.stale_served,
        "cachedFiles": f.cached_files,
        "cachedBytes": f.cached_bytes,
        "lastOkSecondsAgo": f.last_ok_seconds_ago,
    })
}

/// Prometheus text exposition.
async fn metrics(State(app): State<App>) -> Response {
    let mut out = String::with_capacity(4096);
    app.metrics.render(&mut out);
    let series: [(&str, &str, &str); 7] = [
        ("halo_upstream_status", "gauge", "Upstream status: 0 off, 1 ok, 2 degraded, 3 needs key, 4 down."),
        ("halo_upstream_requests_total", "counter", "Requests or connection attempts made to the upstream."),
        ("halo_upstream_errors_total", "counter", "Upstream requests that failed."),
        ("halo_upstream_rate_limited_total", "counter", "Upstream requests answered with HTTP 429."),
        ("halo_upstream_observations_total", "counter", "Observations received from the upstream."),
        ("halo_upstream_latency_seconds_sum", "counter", "Total time spent waiting for the upstream."),
        ("halo_upstream_latency_seconds_count", "counter", "Upstream requests timed."),
    ];
    for (name, kind, help) in series {
        let _ = writeln!(out, "# HELP {name} {help}\n# TYPE {name} {kind}");
        for s in &app.registry.sources {
            let value = match name {
                "halo_upstream_status" => f64::from(s.status() as u8),
                "halo_upstream_requests_total" => s.requests.load(Relaxed) as f64,
                "halo_upstream_errors_total" => s.errors.load(Relaxed) as f64,
                "halo_upstream_rate_limited_total" => s.rate_limited.load(Relaxed) as f64,
                "halo_upstream_observations_total" => s.observations.load(Relaxed) as f64,
                "halo_upstream_latency_seconds_sum" => s.latency_ms_sum.load(Relaxed) as f64 / 1000.0,
                _ => s.latency_count.load(Relaxed) as f64,
            };
            let _ = writeln!(out, "{name}{{source=\"{}\",layer=\"{}\"}} {value}", s.info.id, s.info.kind.layer());
        }
    }
    let budgets: Vec<_> = app.registry.sources.iter().filter_map(|s| Some((s, s.budget_status()?))).collect();
    let budget_series: [(&str, &str); 4] = [
        ("halo_upstream_budget_per_day", "Requests the upstream allows in any 24 hours."),
        ("halo_upstream_budget_available", "Requests that could be sent to the upstream right now."),
        ("halo_upstream_budget_spent_today", "Requests sent to the upstream since midnight UTC, across restarts."),
        ("halo_upstream_budget_left_today", "Requests left in the upstream's allowance for the UTC day."),
    ];
    for (name, help) in budget_series {
        if budgets.is_empty() {
            break;
        }
        let _ = writeln!(out, "# HELP {name} {help}\n# TYPE {name} gauge");
        for (s, budget) in &budgets {
            let value = match name {
                "halo_upstream_budget_per_day" => budget.per_day,
                "halo_upstream_budget_available" => budget.available_now,
                "halo_upstream_budget_spent_today" => budget.spent_today,
                _ => budget.left_today,
            };
            let _ = writeln!(out, "{name}{{source=\"{}\",layer=\"{}\"}} {value}", s.info.id, s.info.kind.layer());
        }
    }
    let f = app.firms.stats();
    let firms_series: [(&str, &str, &str, u64); 8] = [
        ("halo_firms_status", "gauge", "Wildfire proxy: 0 off, 1 ok, 2 degraded, 3 needs key.", f.status as u64),
        ("halo_firms_cache_hits_total", "counter", "Wildfire requests answered from the cache.", f.cache_hits),
        ("halo_firms_cache_misses_total", "counter", "Wildfire requests that found no fresh copy.", f.cache_misses),
        ("halo_firms_upstream_requests_total", "counter", "Requests made to NASA FIRMS.", f.upstream_requests),
        ("halo_firms_upstream_errors_total", "counter", "Requests to NASA FIRMS that failed.", f.upstream_errors),
        (
            "halo_firms_stale_served_total",
            "counter",
            "Wildfire requests answered with an expired copy.",
            f.stale_served,
        ),
        ("halo_firms_cached_files", "gauge", "Fire files held in the cache.", f.cached_files),
        ("halo_firms_cached_bytes", "gauge", "Compressed bytes held in the wildfire cache.", f.cached_bytes),
    ];
    for (name, kind, help, value) in firms_series {
        let _ = writeln!(out, "# HELP {name} {help}\n# TYPE {name} {kind}\n{name} {value}");
    }
    let c = app.celestrak.stats();
    let celestrak_series: [(&str, &str, &str, u64); 9] = [
        ("halo_celestrak_status", "gauge", "Satellite element cache: 0 off, 1 ok, 2 degraded.", c.status as u64),
        ("halo_celestrak_cache_hits_total", "counter", "Element requests answered from a fresh copy.", c.cache_hits),
        ("halo_celestrak_cache_misses_total", "counter", "Element requests that found no fresh copy.", c.cache_misses),
        ("halo_celestrak_not_modified_total", "counter", "Element requests answered 304 Not Modified.", c.not_modified),
        ("halo_celestrak_upstream_requests_total", "counter", "Requests made to CelesTrak.", c.upstream_requests),
        ("halo_celestrak_upstream_errors_total", "counter", "Requests to CelesTrak that failed.", c.upstream_errors),
        ("halo_celestrak_stale_served_total", "counter", "Element requests answered with an old copy.", c.stale_served),
        ("halo_celestrak_unavailable_total", "counter", "Element requests with no copy to give.", c.unavailable),
        ("halo_celestrak_cached_bytes", "gauge", "Compressed bytes held in the element cache.", c.cached_bytes),
    ];
    for (name, kind, help, value) in celestrak_series {
        let _ = writeln!(out, "# HELP {name} {help}\n# TYPE {name} {kind}\n{name} {value}");
    }
    ([(header::CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8")], out).into_response()
}

/// Parse an entity id: decimal as on the wire, or hex with a `0x` prefix.
fn parse_id(text: &str) -> Option<u32> {
    match text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        Some(hex) => u32::from_str_radix(hex, 16).ok(),
        None => text.parse().ok(),
    }
}

/// The JSON document for one entity, before any enrichment.
pub fn entity_json(app: &App, d: &EntityDetail) -> Value {
    let mut meta = serde_json::Map::new();
    for (key, value) in &d.meta {
        meta.insert(key.name().to_owned(), Value::String(value.clone()));
    }
    let track: Vec<Value> = d
        .track
        .iter()
        .map(|p| {
            json!([
                f64::from(p.lon_e7) / 1e7,
                f64::from(p.lat_e7) / 1e7,
                (f64::from(p.alt) * crate::protocol::ALT_UNIT_M * 10.0).round() / 10.0,
                i64::from(p.time_s) * 1000
            ])
        })
        .collect();
    let source = app.registry.by_index(d.source);
    json!({
        "kind": d.kind as u8,
        "id": d.id,
        "layer": d.kind.layer(),
        "lon": d.fix.lon(),
        "lat": d.fix.lat(),
        "alt": (d.fix.alt_m() * 100.0).round() / 100.0,
        "heading": d.fix.heading_deg(),
        "speed": (d.fix.speed_mps() * 10.0).round() / 10.0,
        "vrate": d.fix.vrate_mps(),
        "fixTimeMs": d.fix.time_ms,
        "category": d.category,
        "flags": d.flags,
        "meta": meta,
        "track": track,
        "source": source.map(|s| s.info.id),
        "attribution": source.map(|s| json!({ "text": s.info.attribution, "url": s.info.attribution_url })),
    })
}

/// Detail for one entity: latest fix, facts, recent track.
async fn entity(State(app): State<App>, Path((kind, id)): Path<(String, String)>) -> Response {
    let Some(kind) = Kind::from_path(&kind) else {
        return error(StatusCode::BAD_REQUEST, "bad_kind", "Unknown kind. Use aircraft or ship (or 1 or 2).");
    };
    let Some(id) = parse_id(&id) else {
        return error(StatusCode::BAD_REQUEST, "bad_id", "The id must be a number, as sent in Upsert frames.");
    };
    let (reply, answer) = oneshot::channel();
    if app.commands.send(Command::Detail { kind, id, reply }).await.is_err() {
        return error(StatusCode::SERVICE_UNAVAILABLE, "unavailable", "The gateway is shutting down.");
    }
    let Ok(Some(detail)) = answer.await else {
        return error(StatusCode::NOT_FOUND, "not_found", "Nothing with that id is being tracked right now.");
    };
    let mut body = entity_json(&app, &detail);
    if kind == Kind::Aircraft
        && let Some(callsign) = detail.meta.iter().find(|(k, _)| *k == MetaKey::Label).map(|(_, v)| v.as_str())
        && let Some(route) = app.routes.lookup(callsign, detail.fix.lat(), detail.fix.lon()).await
    {
        body["origin"] = json!(route.origin);
        body["destination"] = json!(route.destination);
        body["routeAttribution"] = json!(ROUTES_ATTRIBUTION);
    }
    // A fix is a few seconds old at best: let a browser reuse it briefly, no longer.
    ([(header::CACHE_CONTROL, "max-age=2")], Json(body)).into_response()
}

/// Find entities anywhere by callsign, registration, name, MMSI or hex address.
async fn search(State(app): State<App>, Query(params): Query<HashMap<String, String>>) -> Response {
    let query = params.get("q").map(|q| q.trim()).unwrap_or("");
    if query.is_empty() {
        return error(StatusCode::BAD_REQUEST, "missing_query", "Add ?q= with a callsign, registration, name or MMSI.");
    }
    if query.len() > SEARCH_MAX_QUERY {
        return error(StatusCode::BAD_REQUEST, "query_too_long", "The search text is too long.");
    }
    let limit = params
        .get("limit")
        .and_then(|l| l.parse::<usize>().ok())
        .unwrap_or(SEARCH_DEFAULT_LIMIT)
        .clamp(1, SEARCH_MAX_LIMIT);
    let (reply, answer) = oneshot::channel();
    if app.commands.send(Command::Search { query: query.to_owned(), limit, reply }).await.is_err() {
        return error(StatusCode::SERVICE_UNAVAILABLE, "unavailable", "The gateway is shutting down.");
    }
    let hits = answer.await.unwrap_or_default();
    let results: Vec<Value> = hits
        .iter()
        .map(|h| {
            json!({
                "kind": h.kind as u8,
                "id": h.id,
                "layer": h.kind.layer(),
                "title": h.title,
                "subtitle": h.subtitle,
                "lon": h.lon,
                "lat": h.lat,
                "score": h.score,
            })
        })
        .collect();
    Json(json!({ "query": query, "results": results })).into_response()
}

/// Upstream sources in use, with licence and credit text.
async fn attribution(State(app): State<App>) -> Json<Value> {
    let mut sources: Vec<Value> = app
        .registry
        .sources
        .iter()
        .map(|s| {
            let l = &s.info.licence;
            json!({
                "id": s.info.id,
                "name": s.info.name,
                "layer": s.info.kind.layer(),
                "active": !matches!(s.status(), UpstreamStatus::Off | UpstreamStatus::NeedsKey),
                "status": s.status() as u8,
                "licence": l.name,
                "licenceUrl": l.url,
                "attribution": s.info.attribution,
                "attributionUrl": s.info.attribution_url,
                "notes": l.notes,
                "docs": s.info.docs,
                "coverage": s.info.coverage,
                "display": l.display,
                "redistribution": l.redistribution,
                "commercial": l.commercial,
                "verified": l.verified,
                "requiresKey": s.info.requires_key,
            })
        })
        .collect();
    if app.routes.enabled() && app.config.mock.is_none() {
        sources.push(json!({
            "id": "vrs-standing-data",
            "name": "Virtual Radar Server standing data",
            "layer": "aircraft",
            "active": true,
            "status": 1,
            "licence": "CC0 1.0",
            "licenceUrl": "https://github.com/vradarserver/standing-data/blob/main/LICENSE",
            "attribution": ROUTES_ATTRIBUTION,
            "attributionUrl": "https://github.com/vradarserver/standing-data",
            "notes": "Flight routes for the detail panel. Crowd-sourced, so occasionally out of date.",
            "docs": "https://github.com/vradarserver/standing-data",
            "coverage": "scheduled airline flights",
            "display": true,
            "redistribution": true,
            "commercial": true,
            "verified": "2026-11-14",
            "requiresKey": null,
        }));
    }
    if app.firms.enabled() {
        let f = app.firms.stats();
        sources.push(json!({
            "id": "nasa-firms",
            "name": "NASA FIRMS",
            "layer": "fires",
            "active": !matches!(f.status, UpstreamStatus::Off | UpstreamStatus::NeedsKey),
            "status": f.status as u8,
            "licence": "NASA open data (CC0)",
            "licenceUrl": "https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance",
            "attribution": firms::ATTRIBUTION,
            "attributionUrl": "https://firms.modaps.eosdis.nasa.gov/",
            "notes": "Near real-time active fire detections, passed on unchanged through /v1/proxy/firms. \
                      Acknowledge NASA as the source; do not suggest that NASA endorses the app.",
            "docs": "https://firms.modaps.eosdis.nasa.gov/api/area/",
            "coverage": "worldwide",
            "display": true,
            "redistribution": true,
            "commercial": true,
            "verified": "2026-11-14",
            "requiresKey": "FIRMS_MAP_KEY",
        }));
    }
    if app.celestrak.enabled() {
        let c = app.celestrak.stats();
        sources.push(json!({
            "id": "celestrak-gp",
            "name": "CelesTrak",
            "layer": "satellites",
            "active": true,
            "status": c.status as u8,
            "licence": "CelesTrak usage policy (no formal licence; U.S. Government GP data)",
            "licenceUrl": "https://celestrak.org/usage-policy.php",
            "attribution": celestrak::ATTRIBUTION,
            "attributionUrl": "https://celestrak.org/",
            "notes": "GP element sets passed on unchanged through /v1/proxy/celestrak, fetched at most once per \
                      group per two-hour update so that every visitor shares one download.",
            "docs": "https://celestrak.org/NORAD/documentation/gp-data-formats.php",
            "coverage": "worldwide",
            "display": true,
            "redistribution": true,
            "commercial": true,
            "verified": "2026-11-14",
            "requiresKey": null,
        }));
    }
    Json(json!({ "layers": layers_json(&app), "sources": sources }))
}

/// True when the request says it can take a gzip body.
fn accepts_gzip(headers: &HeaderMap) -> bool {
    let codings = headers.get_all(header::ACCEPT_ENCODING).iter().filter_map(|v| v.to_str().ok());
    codings.flat_map(|v| v.split(',')).any(|item| {
        let mut parts = item.split(';');
        let coding = parts.next().unwrap_or("").trim();
        let refused = parts
            .any(|p| p.trim().strip_prefix("q=").and_then(|q| q.trim().parse::<f32>().ok()).is_some_and(|q| q <= 0.0));
        (coding.eq_ignore_ascii_case("gzip") || coding.eq_ignore_ascii_case("x-gzip")) && !refused
    })
}

/// NASA FIRMS active-fire CSV for one product and day range, from the shared cache.
async fn firms_proxy(
    State(app): State<App>,
    Path((source, days)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let file = match FireFile::parse(&source, &days) {
        Ok(file) => file,
        Err(BadFile::Source) => {
            let message = format!("Unknown source. Use one of {}.", firms::SOURCES.join(", "));
            return error(StatusCode::BAD_REQUEST, "bad_source", message);
        }
        Err(BadFile::Days) => {
            let message = format!("The number of days must be from 1 to {}.", firms::MAX_DAYS);
            return error(StatusCode::BAD_REQUEST, "bad_days", message);
        }
    };
    let served = match app.firms.get(file).await {
        Ok(served) => served,
        Err(failure) => {
            let status = match failure {
                Failure::Off | Failure::NeedsKey | Failure::KeyRejected => StatusCode::SERVICE_UNAVAILABLE,
                Failure::Limited | Failure::Upstream | Failure::Busy => StatusCode::BAD_GATEWAY,
            };
            let mut response = error(status, failure.code(), failure.message());
            response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            return response;
        }
    };
    // An expired copy is better than nothing, but should be asked for again soon.
    // Caches count the `Age` sent below against max-age, so the hold goes on top of it.
    let hold =
        if served.cache == CacheState::Stale { 60 } else { served.fresh_for.as_secs().clamp(1, PROXY_MAX_AGE_S) };
    let max_age = served.age.as_secs() + hold;
    let common = [
        (header::CONTENT_TYPE, HeaderValue::from_static("text/csv; charset=utf-8")),
        (header::VARY, HeaderValue::from_static("accept-encoding")),
        (header::CACHE_CONTROL, HeaderValue::from_str(&format!("public, max-age={max_age}")).expect("ASCII")),
        (header::AGE, HeaderValue::from(served.age.as_secs())),
        (CACHE_STATE_HEADER, HeaderValue::from_static(served.cache.name())),
    ];
    if accepts_gzip(&headers) {
        // Compressed once when it was fetched: sending it this way costs nothing.
        return (common, [(header::CONTENT_ENCODING, "gzip")], served.gzip).into_response();
    }
    match served.unpacked().await {
        Some(csv) => (common, csv).into_response(),
        None => error(StatusCode::INTERNAL_SERVER_ERROR, "internal", "The cached fire file could not be read."),
    }
}

/// CelesTrak GP elements for one group as OMM CSV, from the shared cache.
async fn celestrak_proxy(State(app): State<App>, Path(file): Path<String>, headers: HeaderMap) -> Response {
    let Some(group) = Group::parse(&file) else {
        let names: Vec<String> = celestrak::GROUPS.iter().map(|g| format!("{g}.csv")).collect();
        return error(StatusCode::BAD_REQUEST, "bad_group", format!("Unknown group. Use one of {}.", names.join(", ")));
    };
    let served = match app.celestrak.get(group).await {
        Ok(served) => served,
        Err(unavailable) => {
            let mut response = error(StatusCode::SERVICE_UNAVAILABLE, "unavailable", unavailable.failure.message());
            let headers = response.headers_mut();
            headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            if let Some(retry_in) = unavailable.retry_in {
                // Asking before then gets the same answer: the gateway will not ask CelesTrak sooner.
                headers.insert(header::RETRY_AFTER, HeaderValue::from(retry_in.as_secs().max(60)));
            }
            return response;
        }
    };
    let common = [
        (header::CONTENT_TYPE, HeaderValue::from_static("text/csv; charset=utf-8")),
        (header::VARY, HeaderValue::from_static("accept-encoding")),
        (
            header::CACHE_CONTROL,
            HeaderValue::from_str(&format!("public, max-age={}", served.max_age().as_secs())).expect("ASCII"),
        ),
        (header::AGE, HeaderValue::from(served.age.as_secs())),
        (header::ETAG, HeaderValue::from_str(&served.etag).expect("ASCII")),
        (CACHE_STATE_HEADER, HeaderValue::from_static(served.cache.name())),
    ];
    let unchanged = headers
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .any(|v| celestrak::matches_etag(v, &served.etag));
    if unchanged {
        app.celestrak.count_not_modified();
        return (StatusCode::NOT_MODIFIED, common).into_response();
    }
    if accepts_gzip(&headers) {
        return (common, [(header::CONTENT_ENCODING, "gzip")], served.gzip).into_response();
    }
    match served.unpacked().await {
        Some(csv) => (common, csv).into_response(),
        None => error(StatusCode::INTERNAL_SERVER_ERROR, "internal", "The cached element file could not be read."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_parse_as_decimal_or_prefixed_hex() {
        assert_eq!(parse_id("5023669"), Some(0x4ca7b5));
        assert_eq!(parse_id("0x4ca7b5"), Some(0x4ca7b5));
        assert_eq!(parse_id("0X4CA7B5"), Some(0x4ca7b5));
        assert_eq!(parse_id("4ca7b5"), None, "bare hex is ambiguous with decimal, so it is refused");
        assert_eq!(parse_id("-1"), None);
        assert_eq!(parse_id(""), None);
    }

    #[test]
    fn gzip_is_sent_only_to_clients_that_take_it() {
        let with = |value: &'static str| {
            let mut headers = HeaderMap::new();
            headers.insert(header::ACCEPT_ENCODING, HeaderValue::from_static(value));
            accepts_gzip(&headers)
        };
        assert!(with("gzip"));
        assert!(with("gzip, deflate, br, zstd"));
        assert!(with("deflate, GZIP;q=0.5"));
        assert!(!with("identity"));
        assert!(!with("br"));
        assert!(!with("gzip;q=0, identity"));
        assert!(!with("gzip; q=0.0"));
        assert!(!accepts_gzip(&HeaderMap::new()));
    }
}
