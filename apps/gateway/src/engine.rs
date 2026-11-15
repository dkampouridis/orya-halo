//! The engine task: the one owner of the world state and the hub.
//!
//! Everything that mutates state arrives here as a message: observations from
//! upstreams, commands from connections, questions from HTTP handlers. Nothing
//! is locked on the hot path, a slow socket can never hold the tick, and the
//! whole thing can be driven synchronously in tests.

use std::sync::Arc;
use std::sync::atomic::Ordering::Relaxed;
use std::time::{Duration, Instant};

use tokio::sync::{mpsc, oneshot, watch};

use crate::config::Config;
use crate::hub::{ConnId, Demand, Hub, Outbound, SubShape};
use crate::metrics::Metrics;
use crate::model::{Kind, UpstreamMessage, now_ms};
use crate::upstream::Registry;
use crate::world::{EntityDetail, SearchHit, World};

/// Requests from connection tasks and HTTP handlers.
pub enum Command {
    Connect { id: ConnId, tx: mpsc::Sender<Outbound>, compress: bool },
    Subscribe { id: ConnId, shape: SubShape },
    Disconnect { id: ConnId },
    Detail { kind: Kind, id: u32, reply: oneshot::Sender<Option<EntityDetail>> },
    Search { query: String, limit: usize, reply: oneshot::Sender<Vec<SearchHit>> },
}

/// Upstream messages applied between two looks at the tick timer, so a burst
/// of data cannot starve the tick.
const UPSTREAM_BURST: usize = 64;

pub struct Engine {
    pub world: World,
    pub hub: Hub,
    registry: Arc<Registry>,
    metrics: Arc<Metrics>,
    demand_tx: watch::Sender<Arc<Demand>>,
    demand_dirty: bool,
    tick_budget_micros: u64,
}

impl Engine {
    pub fn new(
        config: &Config,
        registry: Arc<Registry>,
        metrics: Arc<Metrics>,
        demand_tx: watch::Sender<Arc<Demand>>,
    ) -> Engine {
        Engine {
            world: World::new(config),
            hub: Hub::new(config, metrics.clone()),
            registry,
            metrics,
            demand_tx,
            demand_dirty: false,
            tick_budget_micros: u64::from(config.tick_ms) * 1000,
        }
    }

    /// Apply one upstream message to the world.
    pub fn ingest(&mut self, message: UpstreamMessage, now_ms: i64) {
        match message {
            UpstreamMessage::Batch { kind, source, observations } => {
                let source_id = self.registry.by_index(source).map_or("unknown", |s| s.info.id);
                for obs in observations {
                    self.world.apply(kind, source, source_id, obs, now_ms);
                }
            }
            UpstreamMessage::Gone { kind, ids, unless_seen_after_ms } => {
                self.world.gone(kind, &ids, unless_seen_after_ms);
            }
        }
    }

    /// Handle one command. Returns true when a connection is waiting for a FULL.
    pub fn command(&mut self, command: Command) -> bool {
        match command {
            Command::Connect { id, tx, compress } => {
                self.hub.connect(id, tx, compress);
                self.demand_dirty = true;
                false
            }
            Command::Subscribe { id, shape } => {
                self.hub.subscribe(id, shape);
                self.demand_dirty = true;
                true
            }
            Command::Disconnect { id } => {
                self.hub.disconnect(id);
                self.demand_dirty = true;
                false
            }
            Command::Detail { kind, id, reply } => {
                let _ = reply.send(self.world.detail(kind, id));
                false
            }
            Command::Search { query, limit, reply } => {
                let _ = reply.send(self.world.search(&query, limit));
                false
            }
        }
    }

    /// Answer new subscriptions straight away instead of at the next tick.
    pub fn flush(&mut self, now_ms: i64) {
        self.hub.flush(&self.world, now_ms);
    }

    /// One fan-out tick: expire, send, start the next period.
    pub fn tick(&mut self, now_ms: i64) {
        let started = Instant::now();
        self.world.sweep(now_ms);
        self.hub.tick(&self.world, now_ms, self.registry.statuses());
        self.world.end_tick();

        for kind in Kind::ALL {
            self.metrics.entities[kind.index()].store(self.world.table(kind).total() as u64, Relaxed);
        }
        self.metrics.observations.store(self.world.observations, Relaxed);
        if self.demand_dirty {
            self.demand_dirty = false;
            let demand = self.hub.demand();
            // Upstreams compare the pointer to notice a change, so only publish real ones.
            if **self.demand_tx.borrow() != demand {
                let _ = self.demand_tx.send(Arc::new(demand));
            }
        }
        self.metrics.record_tick(started.elapsed().as_micros() as u64, self.tick_budget_micros);
    }

    /// Run until `shutdown` flips or every sender is gone.
    pub async fn run(
        mut self,
        mut upstream_rx: mpsc::Receiver<UpstreamMessage>,
        mut command_rx: mpsc::Receiver<Command>,
        mut shutdown: watch::Receiver<bool>,
        tick_ms: u32,
    ) {
        let mut ticker = tokio::time::interval(Duration::from_millis(u64::from(tick_ms)));
        // After a long tick, carry on from now rather than firing a burst to catch up.
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut upstream_open = true;
        loop {
            tokio::select! {
                biased;
                _ = shutdown.changed() => break,
                _ = ticker.tick() => self.tick(now_ms()),
                command = command_rx.recv() => {
                    let Some(command) = command else { break };
                    let mut pending_full = self.command(command);
                    while let Ok(more) = command_rx.try_recv() {
                        pending_full |= self.command(more);
                    }
                    if pending_full {
                        self.flush(now_ms());
                    }
                }
                message = upstream_rx.recv(), if upstream_open => {
                    let Some(message) = message else { upstream_open = false; continue };
                    let now = now_ms();
                    self.ingest(message, now);
                    for _ in 1..UPSTREAM_BURST {
                        match upstream_rx.try_recv() {
                            Ok(more) => self.ingest(more, now),
                            Err(_) => break,
                        }
                    }
                }
            }
        }
    }
}
