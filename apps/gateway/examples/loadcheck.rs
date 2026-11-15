//! A simple load check: mock traffic, many simulated clients, real sockets.
//!
//! ```sh
//! cargo run --release --example loadcheck
//! LOAD_CLIENTS=500 LOAD_SECONDS=60 cargo run --release --example loadcheck
//! ```
//!
//! Starts the gateway in mock mode (20,000 aircraft and 50,000 ships unless
//! `LOAD_AIRCRAFT` / `LOAD_SHIPS` say otherwise) on an ephemeral port, connects
//! `LOAD_CLIENTS` WebSocket clients with a mix of subscriptions, and reports
//! tick time, CPU, memory, bytes per second per client and what frame
//! compression saves. The clients run in the same process, so CPU and memory
//! are an upper bound for the gateway alone.
//!
//! To measure the gateway by itself, run it separately and point the check at it:
//!
//! ```sh
//! MOCK=1 MAX_CLIENTS_PER_IP=1000 PORT=8797 cargo run --release &
//! LOAD_TARGET=127.0.0.1:8797 cargo run --release --example loadcheck
//! ```
//!
//! By default clients share twelve viewpoints, so many subscriptions are
//! identical and their frames are built once. `LOAD_DISTINCT=1` gives every
//! viewport client its own area instead.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use h3o::{LatLng, Resolution};
use orya_halo_gateway::config::{Config, MockConfig};
use orya_halo_gateway::protocol::{self, FRAME_FLAG_DEFLATE, frame_type};
use serde_json::json;
use sysinfo::{ProcessesToUpdate, System};
use tokio_tungstenite::tungstenite::Message;

/// Viewports are centred on busy places so they are never empty.
const VIEWS: [(f64, f64); 12] = [
    (51.5, -0.5),
    (40.6, -73.8),
    (35.6, 139.8),
    (1.3, 103.9),
    (25.3, 55.4),
    (33.9, -118.4),
    (50.0, 8.6),
    (22.3, 113.9),
    (-33.9, 151.2),
    (52.0, 4.1),
    (31.2, 121.8),
    (41.3, 28.7),
];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Class {
    WorldPoints,
    WorldDensity,
    ViewportFine,
    ViewportCoarse,
    Stalled,
}

impl Class {
    const ALL: [Class; 5] =
        [Class::WorldPoints, Class::WorldDensity, Class::ViewportFine, Class::ViewportCoarse, Class::Stalled];

    fn of(index: usize) -> Class {
        match index % 20 {
            0 | 10 => Class::WorldPoints,
            1 | 11 => Class::WorldDensity,
            19 => Class::Stalled,
            n if n % 2 == 0 => Class::ViewportFine,
            _ => Class::ViewportCoarse,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Class::WorldPoints => "whole world, points",
            Class::WorldDensity => "whole world, density only",
            Class::ViewportFine => "viewport, res 3 (61 cells)",
            Class::ViewportCoarse => "viewport, res 2 (37 cells)",
            Class::Stalled => "stalled (never reads)",
        }
    }

    fn subscription(self, index: usize) -> serde_json::Value {
        let (mut lat, mut lon) = VIEWS[index % VIEWS.len()];
        // LOAD_DISTINCT=1 nudges every client's view so no two subscriptions
        // are equal: the worst case for frame sharing.
        if std::env::var("LOAD_DISTINCT").is_ok_and(|v| v == "1") {
            lat += (index % 17) as f64 * 0.9 - 7.0;
            lon += (index / 12) as f64 * 1.3;
        }
        let cells = |res: Resolution, k: u32| -> Vec<String> {
            let centre = LatLng::new(lat, lon).expect("valid view").to_cell(res);
            centre.grid_disk::<Vec<_>>(k).iter().map(ToString::to_string).collect()
        };
        let layers = json!(["aircraft", "ships"]);
        match self {
            Class::WorldPoints | Class::Stalled => {
                json!({"t":"sub","layers":layers,"res":0,"cells":[],"points":true,"density":false})
            }
            Class::WorldDensity => json!({"t":"sub","layers":layers,"res":0,"cells":[],"points":false,"density":true}),
            Class::ViewportFine => {
                json!({"t":"sub","layers":layers,"res":3,"cells":cells(Resolution::Three, 4),"points":true,"density":false})
            }
            Class::ViewportCoarse => {
                json!({"t":"sub","layers":layers,"res":2,"cells":cells(Resolution::Two, 3),"points":true,"density":true})
            }
        }
    }
}

#[derive(Default)]
struct Counters {
    clients: AtomicU64,
    frames: AtomicU64,
    bytes: AtomicU64,
    /// Bytes received after the first five seconds, i.e. without the initial FULL.
    steady_bytes: AtomicU64,
    deflated: AtomicU64,
}

fn env<T: std::str::FromStr>(name: &str, default: T) -> T {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

async fn client(addr: SocketAddr, index: usize, counters: Arc<[Counters; 5]>, started: Instant) {
    let class = Class::of(index);
    let slot = Class::ALL.iter().position(|c| *c == class).expect("known class");
    // Every other client asks for frame compression.
    let z = if index.is_multiple_of(2) { "&z=1" } else { "" };
    let url = format!("ws://{addr}/v1/stream?v=1{z}");
    let Ok((mut socket, _)) = tokio_tungstenite::connect_async(url).await else {
        eprintln!("client {index} could not connect");
        return;
    };
    counters[slot].clients.fetch_add(1, Relaxed);
    if socket.send(Message::text(class.subscription(index).to_string())).await.is_err() {
        return;
    }
    if class == Class::Stalled {
        // Hold the socket open without reading: the gateway must cope.
        tokio::time::sleep(Duration::from_secs(3600)).await;
        return;
    }
    while let Some(Ok(message)) = socket.next().await {
        if let Message::Binary(bytes) = message {
            let c = &counters[slot];
            c.frames.fetch_add(1, Relaxed);
            c.bytes.fetch_add(bytes.len() as u64, Relaxed);
            if started.elapsed() > Duration::from_secs(5) {
                c.steady_bytes.fetch_add(bytes.len() as u64, Relaxed);
            }
            if bytes.len() >= 6 && u16::from_le_bytes([bytes[4], bytes[5]]) & FRAME_FLAG_DEFLATE != 0 {
                c.deflated.fetch_add(1, Relaxed);
            }
        }
    }
}

/// Collect uncompressed frames from one whole-world client and one viewport
/// client, to measure compression on exactly what the gateway sends.
async fn sample_frames(addr: SocketAddr, seconds: u64) -> Vec<(String, Vec<u8>)> {
    let mut samples: Vec<(String, Vec<u8>)> = Vec::new();
    for (label, class) in [("world", Class::WorldPoints), ("viewport", Class::ViewportFine)] {
        let (mut socket, _) =
            tokio_tungstenite::connect_async(format!("ws://{addr}/v1/stream?v=1")).await.expect("sampler connects");
        let mut sub = class.subscription(0);
        sub["density"] = json!(true);
        socket.send(Message::text(sub.to_string())).await.expect("sampler subscribes");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(seconds);
        while let Ok(Some(Ok(message))) = tokio::time::timeout_at(deadline, socket.next()).await {
            let Message::Binary(bytes) = message else { continue };
            let Ok(header) = protocol::read_header(&bytes) else { continue };
            let kind = match header.kind {
                1 => "aircraft ",
                2 => "ships ",
                _ => "",
            };
            let what = match header.frame_type {
                frame_type::UPSERT if header.flags & protocol::FRAME_FLAG_FULL != 0 => "FULL upsert",
                frame_type::UPSERT => "delta upsert",
                frame_type::META => "meta",
                frame_type::REMOVE => "remove",
                frame_type::DENSITY => "density",
                frame_type::STATS => "stats",
                _ => "events",
            };
            samples.push((format!("{label}: {kind}{what}"), bytes.to_vec()));
        }
    }
    samples
}

fn compression_report(samples: &[(String, Vec<u8>)]) {
    // Group by label, summing sizes, in first-seen order.
    let mut groups: Vec<(String, Vec<&Vec<u8>>)> = Vec::new();
    for (label, bytes) in samples {
        match groups.iter_mut().find(|(l, _)| l == label) {
            Some((_, list)) => list.push(bytes),
            None => groups.push((label.clone(), vec![bytes])),
        }
    }
    println!("\nFrame compression (raw DEFLATE of the body, header kept), by level");
    println!("{:<34} {:>7} {:>11} {:>8} {:>8} {:>8} {:>8}", "frame", "count", "raw bytes", "L1", "L4", "L6", "L9");
    let mut totals = [0usize; 5];
    for (label, frames) in &groups {
        let raw: usize = frames.iter().map(|f| f.len()).sum();
        let mut line = format!("{label:<34} {:>7} {raw:>11}", frames.len());
        totals[0] += raw;
        for (i, level) in [1u32, 4, 6, 9].into_iter().enumerate() {
            let packed: usize =
                frames.iter().map(|f| protocol::deflate_frame(f, level).map_or(f.len(), |p| p.len())).sum();
            totals[i + 1] += packed;
            line.push_str(&format!(" {:>7.0}%", 100.0 * packed as f64 / raw.max(1) as f64));
        }
        println!("{line}");
    }
    let mut line = format!("{:<34} {:>7} {:>11}", "all sampled frames", samples.len(), totals[0]);
    for packed in &totals[1..] {
        line.push_str(&format!(" {:>7.0}%", 100.0 * *packed as f64 / totals[0].max(1) as f64));
    }
    println!("{line}");

    println!("\nCompression speed on the sampled frames");
    for level in [1u32, 4, 6, 9] {
        let started = Instant::now();
        let mut packed = 0usize;
        for (_, frame) in samples {
            packed += protocol::deflate_frame(frame, level).map_or(frame.len(), |p| p.len());
        }
        let secs = started.elapsed().as_secs_f64();
        println!(
            "  level {level}: {:>5.1} MB/s, output {:>4.1}% of input",
            totals[0] as f64 / 1e6 / secs.max(1e-9),
            100.0 * packed as f64 / totals[0].max(1) as f64
        );
    }
}

/// The gateway's own counters, read from `/metrics` so the same code measures
/// an in-process gateway and one running elsewhere.
async fn scrape(http: &reqwest::Client, addr: SocketAddr) -> HashMap<String, f64> {
    let text = match http.get(format!("http://{addr}/metrics")).send().await {
        Ok(response) => response.text().await.unwrap_or_default(),
        Err(_) => String::new(),
    };
    text.lines()
        .filter(|line| !line.starts_with('#'))
        .filter_map(|line| {
            let (name, value) = line.rsplit_once(' ')?;
            Some((name.to_owned(), value.parse().ok()?))
        })
        .collect()
}

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let clients: usize = env("LOAD_CLIENTS", 300);
    let seconds: u64 = env("LOAD_SECONDS", 30);
    let target: Option<SocketAddr> = std::env::var("LOAD_TARGET").ok().and_then(|v| v.parse().ok());
    let http = orya_halo_gateway::http_client("orya-halo-loadcheck").expect("HTTP client");
    let mut system = System::new().expect("process information is available");

    // Either measure a gateway that is already running, or start one here.
    let (gateway, addr, pid, shared_process) = match target {
        Some(addr) => {
            system.refresh_processes(ProcessesToUpdate::All, true);
            let pid = system
                .processes()
                .iter()
                .find(|(_, p)| p.name().to_string_lossy().starts_with("orya-halo-gateway"))
                .map(|(pid, _)| *pid);
            println!("Load check against {addr}: {clients} clients, {seconds} s");
            (None, addr, pid, false)
        }
        None => {
            let mut config = Config::from_lookup(|_| None).expect("defaults");
            config.bind = "127.0.0.1:0".parse().expect("address");
            config.mock = Some(MockConfig { aircraft: env("LOAD_AIRCRAFT", 20_000), ships: env("LOAD_SHIPS", 50_000) });
            config.max_clients = clients + 16;
            config.max_clients_per_ip = clients + 16;
            let gateway = orya_halo_gateway::start(config).await.expect("gateway starts");
            let addr = gateway.addr;
            println!("Load check with an in-process mock gateway: {clients} clients, {seconds} s");
            (Some(gateway), addr, sysinfo::get_current_pid().ok(), true)
        }
    };
    let measure = |system: &mut System| -> (u64, u64) {
        let Some(pid) = pid else { return (0, 0) };
        system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
        system.process(pid).map_or((0, 0), |p| (p.accumulated_cpu_time(), p.memory()))
    };

    // Let the mock fleet load before anyone connects.
    tokio::time::sleep(Duration::from_secs(3)).await;
    let (_, idle_memory) = measure(&mut system);
    let samples = sample_frames(addr, 12).await;

    let before = scrape(&http, addr).await;
    let (cpu_before, _) = measure(&mut system);
    let counters: Arc<[Counters; 5]> = Arc::new(Default::default());
    let started = Instant::now();
    let tasks: Vec<_> = (0..clients).map(|i| tokio::spawn(client(addr, i, counters.clone(), started))).collect();

    let mut peak_memory = 0u64;
    for _ in 0..seconds {
        tokio::time::sleep(Duration::from_secs(1)).await;
        peak_memory = peak_memory.max(measure(&mut system).1);
    }
    let wall = started.elapsed().as_secs_f64();
    let (cpu_after, memory) = measure(&mut system);
    let after = scrape(&http, addr).await;
    let value = |name: &str| after.get(name).copied().unwrap_or(0.0);
    let delta = |name: &str| value(name) - before.get(name).copied().unwrap_or(0.0);

    let ticks = delta("halo_ticks_total");
    let (sent, raw) = (delta("halo_bytes_sent_total"), delta("halo_bytes_uncompressed_total"));
    let who = if shared_process { "gateway and simulated clients together" } else { "gateway process alone" };
    println!("\nGateway");
    println!(
        "  entities tracked      {} aircraft, {} ships",
        value("halo_entities{kind=\"aircraft\"}"),
        value("halo_entities{kind=\"ships\"}")
    );
    println!("  clients connected     {}", value("halo_clients"));
    println!("  subscription groups   {}", value("halo_subscription_groups"));
    println!("  ticks                 {ticks} in {wall:.0} s");
    println!(
        "  tick time             mean {:.2} ms over the run, max {:.2} ms since start",
        1000.0 * delta("halo_tick_seconds_sum") / ticks.max(1.0),
        1000.0 * value("halo_tick_seconds_max")
    );
    println!("  tick overruns         {}", delta("halo_tick_overruns_total"));
    if pid.is_some() {
        println!("  CPU                   {:.1}% of one core ({who})", (cpu_after - cpu_before) as f64 / 10.0 / wall);
        println!(
            "  memory (RSS)          {:.0} MB before clients, {:.0} MB at the end, {:.0} MB peak ({who})",
            idle_memory as f64 / 1e6,
            memory as f64 / 1e6,
            peak_memory as f64 / 1e6
        );
    } else {
        println!("  CPU and memory        gateway process not found on this machine; measure it where it runs");
    }
    println!("  frames dropped        {}, resyncs {}", delta("halo_frames_dropped_total"), delta("halo_resyncs_total"));
    println!(
        "  bytes queued          {:.1} MB on the wire, {:.1} MB before compression ({:.0}% saved; half the clients use ?z=1)",
        sent / 1e6,
        raw / 1e6,
        100.0 * (1.0 - sent / raw.max(1.0))
    );

    println!("\nPer client, by subscription (wire bytes; half of each class uses ?z=1)");
    println!("{:<30} {:>7} {:>12} {:>16} {:>18}", "class", "clients", "frames/s", "bytes/s total", "bytes/s steady");
    for (slot, class) in Class::ALL.iter().enumerate() {
        let c = &counters[slot];
        let n = c.clients.load(Relaxed).max(1) as f64;
        println!(
            "{:<30} {:>7} {:>12.1} {:>16.0} {:>18.0}",
            class.label(),
            c.clients.load(Relaxed),
            c.frames.load(Relaxed) as f64 / n / wall,
            c.bytes.load(Relaxed) as f64 / n / wall,
            c.steady_bytes.load(Relaxed) as f64 / n / (wall - 5.0).max(1.0),
        );
    }

    compression_report(&samples);

    for task in tasks {
        task.abort();
    }
    if let Some(gateway) = gateway {
        gateway.stop().await;
    }
}
