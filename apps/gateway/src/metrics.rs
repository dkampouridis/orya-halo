//! Process-wide counters, readable from any task without touching the engine.
//! `/metrics` renders them as Prometheus text; `/health` reads a few.

use std::fmt::Write;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering::Relaxed};

use crate::model::Kind;

#[derive(Default)]
pub struct Metrics {
    pub started_ms: AtomicI64,
    pub clients: AtomicU64,
    pub connections_total: AtomicU64,
    pub connections_rejected: AtomicU64,
    pub subscriptions: AtomicU64,
    pub groups: AtomicU64,
    pub client_messages: AtomicU64,
    pub client_errors: AtomicU64,

    pub frames_sent: AtomicU64,
    /// Bytes handed to sockets, after frame compression.
    pub bytes_sent: AtomicU64,
    /// The same frames before compression, for the compression ratio.
    pub bytes_uncompressed: AtomicU64,
    pub frames_dropped: AtomicU64,
    pub full_syncs: AtomicU64,
    pub resyncs: AtomicU64,

    pub entities: [AtomicU64; Kind::COUNT],
    pub observations: AtomicU64,
    pub events: AtomicU64,

    pub ticks: AtomicU64,
    pub tick_micros_last: AtomicU64,
    pub tick_micros_max: AtomicU64,
    pub tick_micros_sum: AtomicU64,
    pub tick_overruns: AtomicU64,
}

impl Metrics {
    pub fn add(counter: &AtomicU64, n: u64) {
        counter.fetch_add(n, Relaxed);
    }

    pub fn record_tick(&self, micros: u64, budget_micros: u64) {
        self.ticks.fetch_add(1, Relaxed);
        self.tick_micros_last.store(micros, Relaxed);
        self.tick_micros_sum.fetch_add(micros, Relaxed);
        self.tick_micros_max.fetch_max(micros, Relaxed);
        if micros > budget_micros {
            self.tick_overruns.fetch_add(1, Relaxed);
        }
    }

    /// Append the gateway's own series in Prometheus text format.
    pub fn render(&self, out: &mut String) {
        let mut metric = |name: &str, kind: &str, help: &str, value: f64| {
            let _ = writeln!(out, "# HELP {name} {help}\n# TYPE {name} {kind}\n{name} {value}");
        };
        let c = |a: &AtomicU64| a.load(Relaxed) as f64;
        metric("halo_clients", "gauge", "WebSocket clients connected.", c(&self.clients));
        metric("halo_connections_total", "counter", "WebSocket connections accepted.", c(&self.connections_total));
        metric(
            "halo_connections_rejected_total",
            "counter",
            "Connections refused by a limit or the origin check.",
            c(&self.connections_rejected),
        );
        metric("halo_subscriptions_total", "counter", "Subscription messages accepted.", c(&self.subscriptions));
        metric("halo_subscription_groups", "gauge", "Distinct subscription shapes in use.", c(&self.groups));
        metric(
            "halo_client_messages_total",
            "counter",
            "Text messages received from clients.",
            c(&self.client_messages),
        );
        metric(
            "halo_client_errors_total",
            "counter",
            "Client messages answered with an error.",
            c(&self.client_errors),
        );
        metric("halo_frames_sent_total", "counter", "Binary frames queued to clients.", c(&self.frames_sent));
        metric(
            "halo_bytes_sent_total",
            "counter",
            "Frame bytes queued to clients, after compression.",
            c(&self.bytes_sent),
        );
        metric(
            "halo_bytes_uncompressed_total",
            "counter",
            "The same frame bytes before compression.",
            c(&self.bytes_uncompressed),
        );
        metric(
            "halo_frames_dropped_total",
            "counter",
            "Frames not sent because a client's queue was full.",
            c(&self.frames_dropped),
        );
        metric("halo_full_syncs_total", "counter", "FULL upserts sent.", c(&self.full_syncs));
        metric("halo_resyncs_total", "counter", "Times a slow client was resynchronised with FULL.", c(&self.resyncs));
        metric("halo_observations_total", "counter", "Upstream observations applied.", c(&self.observations));
        metric("halo_events_total", "counter", "Ticker events raised.", c(&self.events));
        metric("halo_ticks_total", "counter", "Fan-out ticks run.", c(&self.ticks));
        metric("halo_tick_seconds_last", "gauge", "Duration of the last tick.", c(&self.tick_micros_last) / 1e6);
        metric("halo_tick_seconds_max", "gauge", "Longest tick since start.", c(&self.tick_micros_max) / 1e6);
        metric("halo_tick_seconds_sum", "counter", "Total time spent in ticks.", c(&self.tick_micros_sum) / 1e6);
        metric(
            "halo_tick_overruns_total",
            "counter",
            "Ticks that took longer than the tick interval.",
            c(&self.tick_overruns),
        );
        let _ = writeln!(out, "# HELP halo_entities Entities tracked worldwide.\n# TYPE halo_entities gauge");
        for kind in Kind::ALL {
            let _ = writeln!(
                out,
                "halo_entities{{kind=\"{}\"}} {}",
                kind.layer(),
                self.entities[kind.index()].load(Relaxed)
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_prometheus_text() {
        let m = Metrics::default();
        m.clients.store(3, Relaxed);
        m.entities[0].store(42, Relaxed);
        m.record_tick(1500, 1_000_000);
        m.record_tick(2_000_000, 1_000_000);
        let mut out = String::new();
        m.render(&mut out);
        assert!(out.contains("# TYPE halo_clients gauge\nhalo_clients 3\n"));
        assert!(out.contains("halo_entities{kind=\"aircraft\"} 42\n"));
        assert!(out.contains("halo_tick_overruns_total 1\n"));
        assert!(out.contains("halo_tick_seconds_max 2\n"));
    }
}
