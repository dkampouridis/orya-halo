//! Subscriptions and fan-out: who gets which frames each tick.
//!
//! Clients with the same subscription form a *group*. A client in step with
//! its group is "synced": it holds exactly the entities in the group's cells,
//! so the group's delta frames are right for every synced member and are built
//! once, not once per client. That set is the client's known-set; it never
//! needs to be stored because it can always be derived from the world index.
//! A client that is new to the group, or whose queue overflowed, is unsynced
//! and gets a FULL frame (again built once per group) before rejoining the
//! deltas.
//!
//! Frame order within a tick is Remove, Upsert, Meta, so an id that expired
//! and reappeared between two ticks ends up present on the client.

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;
use std::sync::atomic::Ordering::Relaxed;

use bytes::Bytes;
use h3o::{CellIndex, LatLng, Resolution};
use rustc_hash::{FxHashMap, FxHashSet};
use tokio::sync::mpsc;

use crate::config::Config;
use crate::metrics::Metrics;
use crate::model::{Kind, UpstreamStatus};
use crate::protocol::{self, DensityRow, MetaWriter, StatsEntry, UpsertRow};
use crate::world::{Entity, KindTable, World, parent_cell};

pub type ConnId = u64;

/// What the engine queues for a connection's socket task.
#[derive(Debug, Clone, PartialEq)]
pub enum Outbound {
    Frame(Bytes),
    Text(String),
}

/// A validated subscription. Two clients with equal shapes share a group.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SubShape {
    /// Indexed by `Kind::index`.
    pub layers: [bool; Kind::COUNT],
    /// 0 is the whole world; otherwise the H3 resolution of `cells`.
    pub res: u8,
    pub points: bool,
    pub density: bool,
    /// Sorted, without duplicates. Empty when `res` is 0.
    pub cells: Vec<u64>,
}

/// Why a subscription was refused: an error code and a sentence for the user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubError {
    pub code: &'static str,
    pub message: String,
}

/// Check a `sub` message against the protocol's rules.
pub fn validate_sub(
    layers: &[String],
    res: u8,
    cells: &[String],
    points: bool,
    density: bool,
    max_cells: u32,
) -> Result<SubShape, SubError> {
    let err = |code: &'static str, message: String| Err(SubError { code, message });
    let mut wanted = [false; Kind::COUNT];
    for layer in layers {
        match Kind::from_layer(layer) {
            Some(kind) => wanted[kind.index()] = true,
            None => return err("bad_layer", format!("Unknown layer \"{}\". Use aircraft or ships.", clip(layer))),
        }
    }
    if res > 3 {
        return err("bad_resolution", format!("Resolution {res} is not supported. Use 0 (whole world), 1, 2 or 3."));
    }
    let mut parsed = Vec::new();
    if res > 0 {
        if cells.len() > max_cells as usize {
            return err(
                "too_many_cells",
                format!(
                    "{} cells is more than the limit of {max_cells}. Subscribe at a coarser resolution.",
                    cells.len()
                ),
            );
        }
        parsed.reserve(cells.len());
        for text in cells {
            let Ok(cell) = CellIndex::from_str(text) else {
                return err("bad_cell", format!("\"{}\" is not an H3 cell index.", clip(text)));
            };
            if u8::from(cell.resolution()) != res {
                return err(
                    "bad_cell",
                    format!(
                        "Cell {cell} has resolution {}, but the subscription says {res}.",
                        u8::from(cell.resolution())
                    ),
                );
            }
            parsed.push(u64::from(cell));
        }
        parsed.sort_unstable();
        parsed.dedup();
    }
    Ok(SubShape { layers: wanted, res, points, density, cells: parsed })
}

/// Shorten untrusted text before echoing it in an error message.
fn clip(text: &str) -> String {
    text.chars().take(32).collect()
}

/// What clients are looking at, for upstreams that can prioritise areas.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Demand {
    pub clients: usize,
    /// At least one client is subscribed to aircraft, as points or as density.
    /// Feeds with a daily allowance spend nothing while this is false.
    pub aircraft_wanted: bool,
    /// At least one client wants individual aircraft for the whole world.
    pub aircraft_world: bool,
    /// Resolution-2 cells in which some client wants individual aircraft. Sorted.
    pub aircraft_cells: Vec<u64>,
}

struct Group {
    shape: Arc<SubShape>,
    cell_set: FxHashSet<u64>,
    members: Vec<ConnId>,
    /// The group's area as resolution-2 cells, for `Demand`.
    demand_cells: Vec<u64>,
}

impl Group {
    fn new(shape: Arc<SubShape>) -> Group {
        let cell_set: FxHashSet<u64> = shape.cells.iter().copied().collect();
        let mut demand_cells: Vec<u64> = match shape.res {
            2 => shape.cells.clone(),
            3 => shape.cells.iter().map(|&c| parent_cell(c, 2)).collect(),
            1 => shape
                .cells
                .iter()
                .filter_map(|&c| CellIndex::try_from(c).ok())
                .flat_map(|c| c.children(Resolution::Two))
                .map(u64::from)
                .collect(),
            _ => Vec::new(),
        };
        demand_cells.sort_unstable();
        demand_cells.dedup();
        Group { shape, cell_set, members: Vec::new(), demand_cells }
    }

    /// Whether a resolution-3 cell lies in the subscribed area.
    #[inline]
    fn contains(&self, cell3: u64) -> bool {
        if cell3 == 0 {
            return false;
        }
        self.shape.res == 0 || self.cell_set.contains(&parent_cell(cell3, self.shape.res))
    }
}

struct Conn {
    tx: mpsc::Sender<Outbound>,
    /// Asked for frame-level compression with `?z=1`.
    compress: bool,
    shape: Option<Arc<SubShape>>,
    /// In step with the group for this kind; false means "send FULL next".
    synced: [bool; Kind::COUNT],
    /// World tick in which the last FULL for this kind was sent. A FULL holds
    /// everything changed up to and including that tick.
    full_tick: [u32; Kind::COUNT],
    /// Lost frames to a full queue since the last FULL.
    lagging: bool,
    density_sent: [u64; Kind::COUNT],
    greeted: bool,
}

/// A frame built once and shared by every client it goes to, with the
/// compressed form made on first use.
struct SharedFrame {
    raw: Bytes,
    packed: Option<Option<Bytes>>,
}

impl SharedFrame {
    fn new(raw: Vec<u8>) -> SharedFrame {
        SharedFrame { raw: Bytes::from(raw), packed: None }
    }

    fn for_conn(&mut self, compress: bool, min_bytes: usize, level: u32) -> Bytes {
        if !compress || self.raw.len() < protocol::HEADER_BYTES + min_bytes {
            return self.raw.clone();
        }
        let raw = &self.raw;
        self.packed
            .get_or_insert_with(|| protocol::deflate_frame(raw, level).map(Bytes::from))
            .clone()
            .unwrap_or_else(|| self.raw.clone())
    }
}

/// Changed slots of one kind, bucketed by their cell at one resolution.
type Buckets = FxHashMap<u64, Vec<u32>>;

#[derive(Default)]
struct BucketCache {
    by_res: [[Option<Buckets>; 3]; Kind::COUNT],
}

impl BucketCache {
    fn get(&mut self, table: &KindTable, res: u8) -> &Buckets {
        self.by_res[table.kind.index()][usize::from(res) - 1].get_or_insert_with(|| {
            let mut buckets = Buckets::default();
            for &slot in &table.changed {
                let e = table.slot(slot);
                if e.alive && e.positioned() {
                    buckets.entry(parent_cell(e.cell, res)).or_default().push(slot);
                }
            }
            buckets
        })
    }
}

struct DensityFrame {
    version: u64,
    built_ms: i64,
    frame: SharedFrame,
}

pub struct Hub {
    conns: FxHashMap<ConnId, Conn>,
    groups: HashMap<Arc<SubShape>, Group>,
    density: [Option<DensityFrame>; Kind::COUNT],
    centres: FxHashMap<u64, (f32, f32)>,
    last_stats_ms: i64,
    metrics: Arc<Metrics>,
    world_cadence: u32,
    density_res: u8,
    density_interval_ms: i64,
    stats_interval_ms: i64,
    compress_min_bytes: usize,
    compress_level: u32,
    /// Most Upsert and Meta pairs one kind's FULL is split into.
    full_max_chunks: usize,
}

#[inline]
fn row(e: &Entity, now_ms: i64) -> UpsertRow {
    UpsertRow {
        id: e.id,
        lon_e7: e.fix.lon_e7,
        lat_e7: e.fix.lat_e7,
        alt: e.fix.alt,
        heading: e.fix.heading,
        speed: e.fix.speed,
        vrate: e.fix.vrate,
        age: protocol::quantise_age(now_ms, e.fix.time_ms),
        category: e.category,
        flags: e.wire_flags(),
    }
}

/// Queue slots kept free for entity frames when sending disposable ones.
const FULL_RESERVE: usize = 2 * Kind::COUNT;
/// Entities per frame when a FULL set is split up: about 90 KB of Upsert.
const FULL_CHUNK: usize = 4096;

impl Hub {
    pub fn new(config: &Config, metrics: Arc<Metrics>) -> Hub {
        Hub {
            conns: FxHashMap::default(),
            groups: HashMap::new(),
            density: [None, None],
            centres: FxHashMap::default(),
            last_stats_ms: 0,
            metrics,
            world_cadence: config.world_cadence_ticks(),
            density_res: config.density_res,
            density_interval_ms: i64::from(config.density_interval_ms),
            stats_interval_ms: i64::from(config.stats_interval_ms),
            compress_min_bytes: config.compress_min_bytes,
            compress_level: config.compress_level,
            // Both kinds' FULLs together may fill half a client's queue.
            full_max_chunks: (config.client_queue / 8).max(1),
        }
    }

    pub fn client_count(&self) -> usize {
        self.conns.len()
    }

    pub fn group_count(&self) -> usize {
        self.groups.len()
    }

    /// Register a connection. It receives nothing until it subscribes.
    pub fn connect(&mut self, id: ConnId, tx: mpsc::Sender<Outbound>, compress: bool) {
        self.conns.insert(
            id,
            Conn {
                tx,
                compress,
                shape: None,
                synced: [false; Kind::COUNT],
                full_tick: [0; Kind::COUNT],
                lagging: false,
                density_sent: [u64::MAX; Kind::COUNT],
                greeted: false,
            },
        );
        self.metrics.clients.store(self.conns.len() as u64, Relaxed);
    }

    pub fn disconnect(&mut self, id: ConnId) {
        if let Some(conn) = self.conns.remove(&id)
            && let Some(shape) = conn.shape
        {
            self.leave(&shape, id);
        }
        self.metrics.clients.store(self.conns.len() as u64, Relaxed);
    }

    fn leave(&mut self, shape: &Arc<SubShape>, id: ConnId) {
        if let Some(group) = self.groups.get_mut(shape) {
            group.members.retain(|m| *m != id);
            if group.members.is_empty() {
                self.groups.remove(shape);
            }
        }
        self.metrics.groups.store(self.groups.len() as u64, Relaxed);
    }

    /// Replace a connection's subscription. Its next Upsert for each kind is FULL.
    pub fn subscribe(&mut self, id: ConnId, shape: SubShape) {
        let Some(conn) = self.conns.get_mut(&id) else { return };
        let shape = match self.groups.get_key_value(&shape) {
            Some((existing, _)) => existing.clone(),
            None => Arc::new(shape),
        };
        let previous = conn.shape.replace(shape.clone());
        conn.synced = [false; Kind::COUNT];
        // Density is the same for every subscription, so a client that was
        // already receiving it for a kind keeps what it has; panning the map
        // must not cost a density frame each time.
        for kind in Kind::ALL {
            let k = kind.index();
            let had = previous.as_ref().is_some_and(|p| p.density && p.layers[k]);
            if !had {
                conn.density_sent[k] = u64::MAX;
            }
        }
        if let Some(previous) = previous {
            self.leave(&previous, id);
        }
        self.groups.entry(shape.clone()).or_insert_with(|| Group::new(shape)).members.push(id);
        self.metrics.groups.store(self.groups.len() as u64, Relaxed);
        Metrics::add(&self.metrics.subscriptions, 1);
    }

    /// The areas clients want individual aircraft for.
    pub fn demand(&self) -> Demand {
        let mut demand = Demand { clients: self.conns.len(), ..Default::default() };
        for group in self.groups.values() {
            if !group.shape.layers[Kind::Aircraft.index()] {
                continue;
            }
            demand.aircraft_wanted |= group.shape.points || group.shape.density;
            if !group.shape.points {
                continue;
            }
            if group.shape.res == 0 {
                demand.aircraft_world = true;
            } else {
                demand.aircraft_cells.extend_from_slice(&group.demand_cells);
            }
        }
        demand.aircraft_cells.sort_unstable();
        demand.aircraft_cells.dedup();
        demand
    }

    /// Queue `frames` for one connection, all or nothing. Only this task sends
    /// on the channel, so free capacity can only grow between the check and
    /// the sends.
    fn deliver(
        conn: &mut Conn,
        frames: &mut [&mut SharedFrame],
        metrics: &Metrics,
        min_bytes: usize,
        level: u32,
    ) -> bool {
        if conn.tx.capacity() < frames.len() {
            Metrics::add(&metrics.frames_dropped, frames.len() as u64);
            return false;
        }
        for frame in frames.iter_mut() {
            let bytes = frame.for_conn(conn.compress, min_bytes, level);
            let (wire, raw) = (bytes.len() as u64, frame.raw.len() as u64);
            if conn.tx.try_send(Outbound::Frame(bytes)).is_err() {
                // Closed: the socket task is gone and a disconnect is on its way.
                return false;
            }
            Metrics::add(&metrics.frames_sent, 1);
            Metrics::add(&metrics.bytes_sent, wire);
            Metrics::add(&metrics.bytes_uncompressed, raw);
        }
        true
    }

    /// Run one fan-out tick. Call after `World::sweep` and before `World::end_tick`.
    pub fn tick(&mut self, world: &World, now_ms: i64, statuses: [UpstreamStatus; Kind::COUNT]) {
        self.send_deltas(world, now_ms);
        self.sync_pending(world, now_ms, true);
        self.send_density(world, now_ms);
        self.send_events(world, now_ms);
        if now_ms - self.last_stats_ms >= self.stats_interval_ms {
            self.last_stats_ms = now_ms;
            self.send_stats(world, now_ms, statuses);
        }
    }

    /// Bring newly subscribed connections up to date without waiting for the
    /// next tick, so panning the map feels immediate. Safe between ticks:
    /// anything in the FULL that the next delta repeats is idempotent on the
    /// client. Whole-world subscriptions wait for the tick instead: their FULL
    /// is megabytes, and building it once per tick for everyone who joined is
    /// far cheaper than once per arrival.
    pub fn flush(&mut self, world: &World, now_ms: i64) {
        self.sync_pending(world, now_ms, false);
        self.send_density(world, now_ms);
    }

    fn send_deltas(&mut self, world: &World, now_ms: i64) {
        let tick = world.tick;
        let time = now_ms as f64;
        let cadence = self.world_cadence;
        let (min_bytes, level) = (self.compress_min_bytes, self.compress_level);
        let mut cache = BucketCache::default();
        let mut rows: Vec<UpsertRow> = Vec::new();
        let mut removed: Vec<u32> = Vec::new();
        let Hub { conns, groups, metrics, .. } = self;

        for group in groups.values() {
            if !group.shape.points {
                continue;
            }
            for kind in Kind::ALL {
                let k = kind.index();
                if !group.shape.layers[k] || !group.members.iter().any(|m| conns.get(m).is_some_and(|c| c.synced[k])) {
                    continue;
                }
                let table = world.table(kind);
                if group.shape.res == 0 {
                    Self::send_world_deltas(conns, group, table, tick, cadence, now_ms, metrics, min_bytes, level);
                    continue;
                }

                rows.clear();
                removed.clear();
                let mut meta = MetaWriter::new(kind as u8, time);
                let buckets = cache.get(table, group.shape.res);
                let mut visit = |slots: &[u32], rows: &mut Vec<UpsertRow>| {
                    for &slot in slots {
                        let e = table.slot(slot);
                        rows.push(row(e, now_ms));
                        // Facts go with an entity's first upsert and whenever they change.
                        let entered = e.moved_tick == tick && !group.contains(e.prev_cell);
                        if (entered || e.meta_tick == tick) && !e.meta.is_empty() {
                            meta.record(e.id, e.meta.iter());
                        }
                    }
                };
                // Walk whichever is smaller: the subscription or what changed.
                if buckets.len() < group.shape.cells.len() {
                    for (cell, slots) in buckets {
                        if group.cell_set.contains(cell) {
                            visit(slots, &mut rows);
                        }
                    }
                } else {
                    for cell in &group.shape.cells {
                        if let Some(slots) = buckets.get(cell) {
                            visit(slots, &mut rows);
                        }
                    }
                }
                for &slot in &table.moved {
                    let e = table.slot(slot);
                    if e.alive && group.contains(e.prev_cell) && !group.contains(e.cell) {
                        removed.push(e.id);
                    }
                }
                removed.extend(table.removed.iter().filter(|(_, cell)| group.contains(*cell)).map(|(id, _)| *id));

                let mut frames: Vec<SharedFrame> = Vec::with_capacity(3);
                if !removed.is_empty() {
                    frames.push(SharedFrame::new(protocol::encode_remove(kind as u8, time, &removed)));
                }
                if !rows.is_empty() {
                    frames.push(SharedFrame::new(protocol::encode_upsert(kind as u8, time, false, &rows)));
                }
                if meta.count() > 0 {
                    frames.push(SharedFrame::new(meta.finish()));
                }
                if frames.is_empty() {
                    continue;
                }
                let mut refs: Vec<&mut SharedFrame> = frames.iter_mut().collect();
                for member in &group.members {
                    let Some(conn) = conns.get_mut(member) else { continue };
                    if conn.synced[k] && !Self::deliver(conn, &mut refs, metrics, min_bytes, level) {
                        // The client has missed changes: it is out of step for
                        // every kind until a FULL puts it right.
                        conn.synced = [false; Kind::COUNT];
                        conn.lagging = true;
                    }
                }
            }
        }
    }

    /// Deltas for a whole-world group. Each entity has one turn per cadence
    /// and is sent then if it changed since its previous turn.
    ///
    /// A member whose FULL is more recent than that previous turn already
    /// holds everything up to the FULL, so for it "changed since the FULL" is
    /// the test; otherwise it would be sent again what the FULL just gave it,
    /// facts included. Members that were brought up to date in the same tick
    /// share one frame, and after one cadence everybody is back on the
    /// group's.
    #[allow(clippy::too_many_arguments)]
    fn send_world_deltas(
        conns: &mut FxHashMap<ConnId, Conn>,
        group: &Group,
        table: &KindTable,
        tick: u32,
        cadence: u32,
        now_ms: i64,
        metrics: &Metrics,
        min_bytes: usize,
        level: u32,
    ) {
        let kind = table.kind;
        let k = kind.index();
        let time = now_ms as f64;
        // An entity is due when it changed after `since`.
        let previous_turn = i64::from(tick) - i64::from(cadence);
        let since_of = |conn: &Conn| i64::from(conn.full_tick[k]).max(previous_turn);
        let mut sinces: Vec<i64> =
            group.members.iter().filter_map(|m| conns.get(m)).filter(|c| c.synced[k]).map(since_of).collect();
        sinces.sort_unstable();
        sinces.dedup();

        // Removals are not held for an entity's turn, and are the same for everyone.
        let removed: Vec<u32> = table.removed.iter().map(|(id, _)| *id).collect();
        let mut remove =
            (!removed.is_empty()).then(|| SharedFrame::new(protocol::encode_remove(kind as u8, time, &removed)));
        let phase = (tick % cadence) as usize;
        let mut rows: Vec<UpsertRow> = Vec::new();
        for since in sinces {
            rows.clear();
            let mut meta = MetaWriter::new(kind as u8, time);
            for slot in (phase..table.slots()).step_by(cadence as usize) {
                let e = table.slot(slot as u32);
                if e.alive && e.positioned() && i64::from(e.changed_tick) > since {
                    rows.push(row(e, now_ms));
                    if i64::from(e.meta_tick) > since && !e.meta.is_empty() {
                        meta.record(e.id, e.meta.iter());
                    }
                }
            }
            let mut upsert =
                (!rows.is_empty()).then(|| SharedFrame::new(protocol::encode_upsert(kind as u8, time, false, &rows)));
            let mut facts = (meta.count() > 0).then(|| SharedFrame::new(meta.finish()));
            let mut refs: Vec<&mut SharedFrame> =
                remove.iter_mut().chain(upsert.iter_mut()).chain(facts.iter_mut()).collect();
            if refs.is_empty() {
                continue;
            }
            for member in &group.members {
                let Some(conn) = conns.get_mut(member) else { continue };
                if conn.synced[k]
                    && since_of(conn) == since
                    && !Self::deliver(conn, &mut refs, metrics, min_bytes, level)
                {
                    conn.synced = [false; Kind::COUNT];
                    conn.lagging = true;
                }
            }
        }
    }

    fn sync_pending(&mut self, world: &World, now_ms: i64, include_world: bool) {
        let time = now_ms as f64;
        let (min_bytes, level) = (self.compress_min_bytes, self.compress_level);
        let max_chunks = self.full_max_chunks;
        let mut members: Vec<&Entity> = Vec::new();
        let mut rows: Vec<UpsertRow> = Vec::new();
        let Hub { conns, groups, metrics, .. } = self;

        for group in groups.values() {
            if group.shape.res == 0 && !include_world {
                continue;
            }
            for kind in Kind::ALL {
                let k = kind.index();
                if !group.shape.layers[k] || !group.shape.points {
                    continue;
                }
                // A FULL is up to `max_chunks` Upsert and Meta pairs; only
                // clients with room for all of it are synchronised this time.
                let ready = |c: &Conn| !c.synced[k] && c.tx.capacity() >= (2 * max_chunks).min(c.tx.max_capacity());
                if !group.members.iter().any(|m| conns.get(m).is_some_and(ready)) {
                    continue;
                }
                let table = world.table(kind);
                members.clear();
                match group.shape.res {
                    0 => members.extend(table.iter().filter(|e| e.positioned())),
                    3 => {
                        for cell in &group.shape.cells {
                            members.extend(table.in_cell(*cell).iter().map(|&slot| table.slot(slot)));
                        }
                    }
                    res => {
                        for (cell, slots) in table.occupied_cells() {
                            if group.cell_set.contains(&parent_cell(cell, res)) {
                                members.extend(slots.iter().map(|&slot| table.slot(slot)));
                            }
                        }
                    }
                }

                // A big set goes out as one FULL frame followed by ordinary
                // upserts for the rest. The client ends up with the same set,
                // and no single message is larger than a chunk, which keeps
                // socket buffers (and the browser's parse time) small.
                let chunk_size = FULL_CHUNK.max(members.len().div_ceil(max_chunks)).max(1);
                let mut frames: Vec<SharedFrame> = Vec::new();
                for (i, chunk) in members.chunks(chunk_size).enumerate() {
                    rows.clear();
                    let mut meta = MetaWriter::new(kind as u8, time);
                    for e in chunk {
                        rows.push(row(e, now_ms));
                        if !e.meta.is_empty() {
                            meta.record(e.id, e.meta.iter());
                        }
                    }
                    frames.push(SharedFrame::new(protocol::encode_upsert(kind as u8, time, i == 0, &rows)));
                    if meta.count() > 0 {
                        frames.push(SharedFrame::new(meta.finish()));
                    }
                }
                if frames.is_empty() {
                    // An empty FULL still goes out: it tells the client to drop what it holds.
                    frames.push(SharedFrame::new(protocol::encode_upsert(kind as u8, time, true, &[])));
                }
                let mut refs: Vec<&mut SharedFrame> = frames.iter_mut().collect();
                for member in &group.members {
                    let Some(conn) = conns.get_mut(member) else { continue };
                    if ready(conn) && Self::deliver(conn, &mut refs, metrics, min_bytes, level) {
                        conn.synced[k] = true;
                        conn.full_tick[k] = world.tick;
                        Metrics::add(&metrics.full_syncs, 1);
                        if conn.lagging && conn.synced.iter().zip(group.shape.layers).all(|(s, wanted)| *s || !wanted) {
                            conn.lagging = false;
                            Metrics::add(&metrics.resyncs, 1);
                        }
                    }
                }
            }
        }
    }

    fn send_density(&mut self, world: &World, now_ms: i64) {
        let (min_bytes, level) = (self.compress_min_bytes, self.compress_level);
        for kind in Kind::ALL {
            let k = kind.index();
            let wanted = |g: &Group| g.shape.density && g.shape.layers[k];
            if !self.groups.values().any(wanted) {
                continue;
            }
            let table = world.table(kind);
            let rebuild = match &self.density[k] {
                None => true,
                Some(d) => d.version != table.density_version && now_ms - d.built_ms >= self.density_interval_ms,
            };
            if rebuild {
                let mut rows: Vec<DensityRow> = table
                    .density()
                    .iter()
                    .map(|(&cell, &count)| {
                        let (lon, lat) = *self.centres.entry(cell).or_insert_with(|| {
                            CellIndex::try_from(cell)
                                .map(|c| {
                                    let ll = LatLng::from(c);
                                    (ll.lng() as f32, ll.lat() as f32)
                                })
                                .unwrap_or((0.0, 0.0))
                        });
                        DensityRow { cell, lon, lat, count }
                    })
                    .collect();
                rows.sort_unstable_by_key(|r| r.cell);
                self.density[k] = Some(DensityFrame {
                    version: table.density_version,
                    built_ms: now_ms,
                    frame: SharedFrame::new(protocol::encode_density(
                        kind as u8,
                        now_ms as f64,
                        self.density_res,
                        &rows,
                    )),
                });
            }
            let Hub { conns, groups, density, metrics, .. } = self;
            let Some(current) = density[k].as_mut() else { continue };
            for group in groups.values().filter(|g| wanted(g)) {
                for member in &group.members {
                    let Some(conn) = conns.get_mut(member) else { continue };
                    // Density is replaced wholesale, so a skipped frame costs
                    // nothing: the next one carries everything.
                    if conn.density_sent[k] != current.version
                        && conn.tx.capacity() > FULL_RESERVE
                        && Self::deliver(conn, &mut [&mut current.frame], metrics, min_bytes, level)
                    {
                        conn.density_sent[k] = current.version;
                    }
                }
            }
        }
    }

    fn send_events(&mut self, world: &World, now_ms: i64) {
        let (min_bytes, level) = (self.compress_min_bytes, self.compress_level);
        let Hub { conns, metrics, .. } = self;
        let mut fresh =
            (!world.events.is_empty()).then(|| SharedFrame::new(protocol::encode_events(now_ms as f64, &world.events)));
        let mut backlog: Option<SharedFrame> = None;
        Metrics::add(&metrics.events, world.events.len() as u64);
        for conn in conns.values_mut() {
            if conn.shape.is_none() {
                continue;
            }
            if !conn.greeted {
                // A new subscriber gets the recent ticker lines once; they
                // already include anything raised this tick.
                conn.greeted = true;
                if world.recent_events().next().is_some() {
                    let frame = backlog.get_or_insert_with(|| {
                        let events: Vec<_> = world.recent_events().cloned().collect();
                        SharedFrame::new(protocol::encode_events(now_ms as f64, &events))
                    });
                    Self::deliver(conn, &mut [frame], metrics, min_bytes, level);
                }
            } else if let Some(frame) = fresh.as_mut() {
                Self::deliver(conn, &mut [frame], metrics, min_bytes, level);
            }
        }
    }

    fn send_stats(&mut self, world: &World, now_ms: i64, statuses: [UpstreamStatus; Kind::COUNT]) {
        let entries: Vec<StatsEntry> = Kind::ALL
            .iter()
            .map(|kind| StatsEntry {
                kind: *kind as u8,
                status: statuses[kind.index()] as u8,
                total: world.table(*kind).total() as u32,
            })
            .collect();
        let frame = Bytes::from(protocol::encode_stats(now_ms as f64, &entries));
        for conn in self.conns.values() {
            // Stats are disposable: a client that is behind simply misses one.
            if conn.tx.try_send(Outbound::Frame(frame.clone())).is_ok() {
                Metrics::add(&self.metrics.frames_sent, 1);
                Metrics::add(&self.metrics.bytes_sent, frame.len() as u64);
                Metrics::add(&self.metrics.bytes_uncompressed, frame.len() as u64);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Fix, Observation, flag};
    use crate::protocol::{Frame, MetaKey, decode_frame};

    const SRC: &str = "test";
    const OK: [UpstreamStatus; 2] = [UpstreamStatus::Ok, UpstreamStatus::NeedsKey];

    struct Rig {
        world: World,
        hub: Hub,
        now: i64,
    }

    struct Client {
        id: ConnId,
        rx: mpsc::Receiver<Outbound>,
    }

    impl Client {
        /// Everything queued so far, decoded.
        fn drain(&mut self) -> Vec<Frame> {
            let mut frames = Vec::new();
            while let Ok(out) = self.rx.try_recv() {
                if let Outbound::Frame(bytes) = out {
                    frames.push(decode_frame(&bytes).expect("valid frame"));
                }
            }
            frames
        }
    }

    fn upserts(frames: &[Frame], kind: Kind) -> Vec<(bool, Vec<u32>)> {
        frames
            .iter()
            .filter_map(|f| match f {
                Frame::Upsert { header, full, rows } if header.kind == kind as u8 => {
                    let mut ids: Vec<u32> = rows.iter().map(|r| r.id).collect();
                    ids.sort_unstable();
                    Some((*full, ids))
                }
                _ => None,
            })
            .collect()
    }

    fn removes(frames: &[Frame], kind: Kind) -> Vec<u32> {
        let mut ids: Vec<u32> = frames
            .iter()
            .filter_map(|f| match f {
                Frame::Remove { header, ids } if header.kind == kind as u8 => Some(ids.clone()),
                _ => None,
            })
            .flatten()
            .collect();
        ids.sort_unstable();
        ids
    }

    fn metas(frames: &[Frame], kind: Kind) -> Vec<u32> {
        let mut ids: Vec<u32> = frames
            .iter()
            .filter_map(|f| match f {
                Frame::Meta { header, records } if header.kind == kind as u8 => {
                    Some(records.iter().map(|r| r.id).collect::<Vec<_>>())
                }
                _ => None,
            })
            .flatten()
            .collect();
        ids.sort_unstable();
        ids
    }

    fn cell_hex(lon: f64, lat: f64, res: Resolution) -> String {
        LatLng::new(lat, lon).unwrap().to_cell(res).to_string()
    }

    impl Rig {
        fn new() -> Rig {
            Rig::with(Config::for_tests())
        }

        fn with(config: Config) -> Rig {
            let metrics = Arc::new(Metrics::default());
            Rig { world: World::new(&config), hub: Hub::new(&config, metrics), now: 1_000_000 }
        }

        fn client(&mut self, queue: usize) -> Client {
            let id = self.hub.client_count() as ConnId + 1;
            let (tx, rx) = mpsc::channel(queue);
            self.hub.connect(id, tx, false);
            Client { id, rx }
        }

        fn sub(&mut self, client: &Client, layers: &[&str], res: u8, cells: &[String]) {
            let layers: Vec<String> = layers.iter().map(|l| (*l).to_owned()).collect();
            let shape = validate_sub(&layers, res, cells, true, false, 2000).expect("valid subscription");
            self.hub.subscribe(client.id, shape);
        }

        fn put(&mut self, kind: Kind, id: u32, lon: f64, lat: f64, label: Option<&str>) {
            let mut obs = Observation::new(id);
            obs.fix = Some(Fix::from_si(lon, lat, 1000.0, Some(45.0), 100.0, 0.0, 0, self.now));
            if let Some(label) = label {
                obs.fact(MetaKey::Label, label);
            }
            self.world.apply(kind, 0, SRC, obs, self.now);
        }

        /// One full tick, one second later.
        fn tick(&mut self) {
            self.now += 1000;
            self.world.sweep(self.now);
            self.hub.tick(&self.world, self.now, OK);
            self.world.end_tick();
        }
    }

    // London, Paris and New York sit in different resolution-1 cells.
    const LONDON: (f64, f64) = (-0.45, 51.47);
    const PARIS: (f64, f64) = (2.55, 49.0);
    const NEW_YORK: (f64, f64) = (-73.78, 40.64);

    #[test]
    fn subscriptions_are_validated() {
        let cell2 = cell_hex(LONDON.0, LONDON.1, Resolution::Two);
        let cell3 = cell_hex(LONDON.0, LONDON.1, Resolution::Three);
        let layers = vec!["aircraft".to_owned()];

        let ok = validate_sub(&layers, 2, &[cell2.clone(), cell2.clone()], true, false, 10).unwrap();
        assert_eq!(ok.cells.len(), 1, "duplicates collapse");
        assert_eq!(ok.layers, [true, false]);

        let world = validate_sub(&layers, 0, &["not a cell".to_owned()], true, true, 10).unwrap();
        assert!(world.cells.is_empty(), "cells are ignored for the whole world");

        assert_eq!(validate_sub(&["boats".to_owned()], 0, &[], true, false, 10).unwrap_err().code, "bad_layer");
        assert_eq!(validate_sub(&layers, 4, &[], true, false, 10).unwrap_err().code, "bad_resolution");
        assert_eq!(validate_sub(&layers, 2, &["zzz".to_owned()], true, false, 10).unwrap_err().code, "bad_cell");
        let mismatch = validate_sub(&layers, 2, &[cell3], true, false, 10).unwrap_err();
        assert_eq!(mismatch.code, "bad_cell");
        assert!(mismatch.message.contains("resolution 3"), "{}", mismatch.message);
        let many: Vec<String> = vec![cell2; 11];
        assert_eq!(validate_sub(&layers, 2, &many, true, false, 10).unwrap_err().code, "too_many_cells");
        assert_eq!(validate_sub(&[], 3, &[], true, false, 10).unwrap().layers, [false, false]);
    }

    #[test]
    fn full_after_sub_then_only_what_changed() {
        let mut rig = Rig::new();
        rig.put(Kind::Aircraft, 1, LONDON.0, LONDON.1, Some("BAW1"));
        rig.put(Kind::Aircraft, 2, LONDON.0 + 0.01, LONDON.1, None);
        rig.put(Kind::Aircraft, 3, NEW_YORK.0, NEW_YORK.1, Some("AAL3"));
        rig.put(Kind::Ship, 9, LONDON.0, LONDON.1, Some("THAMES"));
        rig.tick();

        let mut c = rig.client(64);
        let cells = [cell_hex(LONDON.0, LONDON.1, Resolution::Two)];
        rig.sub(&c, &["aircraft"], 2, &cells);
        rig.tick();
        let frames = c.drain();
        assert_eq!(upserts(&frames, Kind::Aircraft), vec![(true, vec![1, 2])]);
        assert_eq!(metas(&frames, Kind::Aircraft), vec![1, 2], "every entity has at least its source");
        assert!(upserts(&frames, Kind::Ship).is_empty(), "ships were not asked for");

        // Nothing changed: no entity frames at all.
        rig.tick();
        let frames = c.drain();
        assert!(upserts(&frames, Kind::Aircraft).is_empty());
        assert!(metas(&frames, Kind::Aircraft).is_empty());

        // One moves, one appears, one changes far away.
        rig.put(Kind::Aircraft, 1, LONDON.0 + 0.02, LONDON.1, None);
        rig.put(Kind::Aircraft, 4, LONDON.0 - 0.02, LONDON.1, Some("EZY4"));
        rig.put(Kind::Aircraft, 3, NEW_YORK.0 + 0.1, NEW_YORK.1, None);
        rig.tick();
        let frames = c.drain();
        assert_eq!(upserts(&frames, Kind::Aircraft), vec![(false, vec![1, 4])]);
        assert_eq!(metas(&frames, Kind::Aircraft), vec![4], "facts go once, with the first upsert");

        // A fact changes: it is sent again.
        let mut obs = Observation::new(1);
        obs.fact(MetaKey::Squawk, "7421");
        rig.world.apply(Kind::Aircraft, 0, SRC, obs, rig.now);
        rig.tick();
        let frames = c.drain();
        assert_eq!(metas(&frames, Kind::Aircraft), vec![1]);
        assert_eq!(upserts(&frames, Kind::Aircraft), vec![(false, vec![1])]);
    }

    #[test]
    fn resubscribing_sends_full_for_the_new_area() {
        let mut rig = Rig::new();
        rig.put(Kind::Aircraft, 1, LONDON.0, LONDON.1, Some("BAW1"));
        rig.put(Kind::Aircraft, 3, NEW_YORK.0, NEW_YORK.1, Some("AAL3"));
        rig.tick();
        let mut c = rig.client(64);
        rig.sub(&c, &["aircraft"], 1, &[cell_hex(LONDON.0, LONDON.1, Resolution::One)]);
        rig.hub.flush(&rig.world, rig.now);
        assert_eq!(upserts(&c.drain(), Kind::Aircraft), vec![(true, vec![1])], "flush answers without a tick");

        rig.sub(&c, &["aircraft"], 3, &[cell_hex(NEW_YORK.0, NEW_YORK.1, Resolution::Three)]);
        rig.tick();
        let frames = c.drain();
        assert_eq!(upserts(&frames, Kind::Aircraft), vec![(true, vec![3])]);
        assert_eq!(metas(&frames, Kind::Aircraft), vec![3]);
        assert_eq!(rig.hub.group_count(), 1, "the old group is dropped when its last member leaves");

        // Subscribing to an empty area still sends an (empty) FULL so the client clears.
        rig.sub(&c, &["aircraft"], 3, &[cell_hex(100.0, -40.0, Resolution::Three)]);
        rig.tick();
        assert_eq!(upserts(&c.drain(), Kind::Aircraft), vec![(true, vec![])]);
    }

    #[test]
    fn leaving_the_area_and_expiring_send_removes() {
        let mut rig = Rig::new();
        rig.put(Kind::Aircraft, 1, LONDON.0, LONDON.1, Some("BAW1"));
        rig.put(Kind::Aircraft, 2, LONDON.0, LONDON.1 + 0.01, None);
        rig.put(Kind::Aircraft, 5, PARIS.0, PARIS.1, Some("AFR5"));
        rig.tick();
        let mut c = rig.client(64);
        rig.sub(&c, &["aircraft"], 1, &[cell_hex(LONDON.0, LONDON.1, Resolution::One)]);
        rig.tick();
        assert_eq!(upserts(&c.drain(), Kind::Aircraft), vec![(true, vec![1, 2])]);

        // 1 flies to New York (leaves), 5 flies in from Paris (enters, with facts).
        rig.put(Kind::Aircraft, 1, NEW_YORK.0, NEW_YORK.1, None);
        rig.put(Kind::Aircraft, 5, LONDON.0, LONDON.1, None);
        rig.tick();
        let frames = c.drain();
        assert_eq!(removes(&frames, Kind::Aircraft), vec![1]);
        assert_eq!(upserts(&frames, Kind::Aircraft), vec![(false, vec![5])]);
        assert_eq!(metas(&frames, Kind::Aircraft), vec![5], "facts accompany an entity entering the area");

        // 2 falls silent and expires after the 90 second lifetime.
        let mut frames = Vec::new();
        for _ in 0..95 {
            rig.put(Kind::Aircraft, 5, LONDON.0, LONDON.1, None);
            rig.tick();
            // Keep reading, as a live client does, so the queue never fills.
            frames.extend(c.drain());
        }
        assert_eq!(removes(&frames, Kind::Aircraft), vec![2]);
        // Before expiring it was flagged stale, which is an upsert.
        let stale_upsert = frames.iter().any(|f| match f {
            Frame::Upsert { rows, .. } => rows.iter().any(|r| r.id == 2 && r.flags & flag::STALE != 0),
            _ => false,
        });
        assert!(stale_upsert);
        // Something that left and expired elsewhere is not removed twice.
        assert!(!removes(&frames, Kind::Aircraft).contains(&1));
    }

    #[test]
    fn remove_precedes_upsert_when_an_id_returns_within_a_tick() {
        let mut rig = Rig::new();
        rig.put(Kind::Aircraft, 1, LONDON.0, LONDON.1, None);
        rig.tick();
        let mut c = rig.client(64);
        rig.sub(&c, &["aircraft"], 3, &[cell_hex(LONDON.0, LONDON.1, Resolution::Three)]);
        rig.tick();
        c.drain();
        rig.world.gone(Kind::Aircraft, &[1], i64::MAX);
        rig.put(Kind::Aircraft, 1, LONDON.0, LONDON.1, None);
        rig.tick();
        let order: Vec<u8> = c
            .drain()
            .iter()
            .filter(|f| f.header().kind == Kind::Aircraft as u8)
            .map(|f| f.header().frame_type)
            .collect();
        assert_eq!(order, vec![protocol::frame_type::REMOVE, protocol::frame_type::UPSERT, protocol::frame_type::META]);
    }

    #[test]
    fn frames_within_a_tick_arrive_in_the_documented_order() {
        let mut config = Config::for_tests();
        config.density_interval_ms = 0;
        let mut rig = Rig::with(config);
        rig.put(Kind::Aircraft, 1, LONDON.0, LONDON.1, Some("BAW1"));
        rig.put(Kind::Aircraft, 2, LONDON.0 + 0.01, LONDON.1, Some("BAW2"));
        rig.put(Kind::Ship, 9, LONDON.0, LONDON.1, Some("THAMES"));
        rig.tick();
        let mut c = rig.client(64);
        let layers = ["aircraft".to_owned(), "ships".to_owned()];
        let cells = [cell_hex(LONDON.0, LONDON.1, Resolution::Two)];
        rig.hub.subscribe(c.id, validate_sub(&layers, 2, &cells, true, true, 2000).unwrap());
        rig.tick();
        let order = |frames: &[Frame]| -> Vec<(u8, u8)> {
            frames.iter().map(|f| (f.header().frame_type, f.header().kind)).collect()
        };
        use protocol::frame_type::{DENSITY, EVENTS, META, REMOVE, STATS, UPSERT};
        // After a sub: per kind the FULL and its facts, then density per kind, then stats.
        assert_eq!(
            order(&c.drain()),
            [(UPSERT, 1), (META, 1), (UPSERT, 2), (META, 2), (DENSITY, 1), (DENSITY, 2), (STATS, 0)]
        );

        // One busy tick: an aircraft goes, one declares an emergency, one appears, and a ship moves.
        rig.world.gone(Kind::Aircraft, &[1], i64::MAX);
        let mut mayday = Observation::new(2);
        mayday.fix = Some(Fix::from_si(LONDON.0 + 0.02, LONDON.1, 1000.0, None, 100.0, 0.0, flag::EMERGENCY, rig.now));
        mayday.fact(MetaKey::Squawk, "7700");
        rig.world.apply(Kind::Aircraft, 0, SRC, mayday, rig.now);
        rig.put(Kind::Aircraft, 4, LONDON.0 - 0.01, LONDON.1, Some("EZY4"));
        rig.put(Kind::Ship, 9, LONDON.0 + 0.0001, LONDON.1, None);
        rig.tick();
        assert_eq!(
            order(&c.drain()),
            [(REMOVE, 1), (UPSERT, 1), (META, 1), (UPSERT, 2), (DENSITY, 1), (EVENTS, 0), (STATS, 0)],
            "per kind: Remove, Upsert, Meta; then Density, Events, Stats"
        );
    }

    #[test]
    fn whole_world_subscribers_get_each_entity_once_per_cadence() {
        let mut config = Config::for_tests();
        config.world_cadence_ms = 4000;
        let mut rig = Rig::with(config);
        for id in 1..=40u32 {
            rig.put(Kind::Aircraft, id, f64::from(id) * 3.0 - 60.0, 10.0, Some("X"));
        }
        // Let a full cadence pass so the facts are no longer news.
        for _ in 0..5 {
            rig.tick();
        }
        let mut c = rig.client(256);
        rig.sub(&c, &["aircraft"], 0, &[]);
        rig.tick();
        let frames = c.drain();
        assert!(upserts(&frames, Kind::Aircraft)[0].0);
        assert_eq!(upserts(&frames, Kind::Aircraft)[0].1.len(), 40);

        // Every aircraft moves every tick for two full cadences.
        let mut sent: FxHashMap<u32, u32> = FxHashMap::default();
        let mut per_tick = Vec::new();
        for step in 0..8 {
            for id in 1..=40u32 {
                rig.put(Kind::Aircraft, id, f64::from(id) * 3.0 - 60.0 + f64::from(step + 1) * 0.01, 10.0, None);
            }
            rig.tick();
            let frames = c.drain();
            let mut n = 0;
            for (full, ids) in upserts(&frames, Kind::Aircraft) {
                assert!(!full);
                n += ids.len();
                for id in ids {
                    *sent.entry(id).or_default() += 1;
                }
            }
            per_tick.push(n);
            assert!(metas(&frames, Kind::Aircraft).is_empty(), "facts did not change");
        }
        assert_eq!(per_tick, vec![10; 8], "a quarter of the fleet each tick");
        assert!(sent.len() == 40 && sent.values().all(|n| *n == 2), "each entity exactly once per cadence");

        // Removal is immediate, not held for the entity's turn.
        rig.world.gone(Kind::Aircraft, &[7], i64::MAX);
        rig.tick();
        assert_eq!(removes(&c.drain(), Kind::Aircraft), vec![7]);

        // A newcomer is announced, with facts, within one cadence.
        rig.put(Kind::Aircraft, 99, 0.0, -20.0, Some("NEW99"));
        let mut seen = (0, 0);
        for _ in 0..4 {
            rig.tick();
            let frames = c.drain();
            seen.0 += upserts(&frames, Kind::Aircraft).iter().filter(|(_, ids)| ids.contains(&99)).count();
            seen.1 += metas(&frames, Kind::Aircraft).iter().filter(|id| **id == 99).count();
        }
        assert_eq!(seen, (1, 1));
    }

    #[test]
    fn a_whole_world_full_is_not_followed_by_what_it_already_carried() {
        let mut config = Config::for_tests();
        config.world_cadence_ms = 4000;
        let mut rig = Rig::with(config);
        let lon = |id: u32| f64::from(id) * 3.0 - 60.0;
        for id in 1..=40u32 {
            rig.put(Kind::Aircraft, id, lon(id), 10.0, Some("X"));
        }
        // The fleet is brand new when the client joins: everything, facts
        // included, changed within the last cadence.
        let mut a = rig.client(256);
        rig.sub(&a, &["aircraft"], 0, &[]);
        rig.tick();
        let frames = a.drain();
        assert_eq!(
            upserts(&frames, Kind::Aircraft).iter().map(|(full, ids)| (*full, ids.len())).collect::<Vec<_>>(),
            [(true, 40)]
        );
        assert_eq!(metas(&frames, Kind::Aircraft).len(), 40);

        // Nothing changes for two cadences, so nothing follows: the FULL had it all.
        for _ in 0..8 {
            rig.tick();
            let frames = a.drain();
            assert!(upserts(&frames, Kind::Aircraft).is_empty(), "positions the FULL carried are not repeated");
            assert!(metas(&frames, Kind::Aircraft).is_empty(), "facts the FULL carried are not repeated");
        }

        // What changes after the FULL is sent once, at the entity's turn: a
        // move without its facts, a new fact with them.
        rig.put(Kind::Aircraft, 5, lon(5) + 0.01, 10.0, None);
        let mut obs = Observation::new(6);
        obs.fact(MetaKey::Squawk, "7421");
        rig.world.apply(Kind::Aircraft, 0, SRC, obs, rig.now);
        let (mut ups, mut facts) = (Vec::new(), Vec::new());
        for _ in 0..8 {
            rig.tick();
            let frames = a.drain();
            ups.extend(upserts(&frames, Kind::Aircraft).into_iter().flat_map(|(_, ids)| ids));
            facts.extend(metas(&frames, Kind::Aircraft));
        }
        ups.sort_unstable();
        assert_eq!((ups, facts), (vec![5, 6], vec![6]));

        // A second client joins while the whole fleet has just moved. The
        // first is owed every move at its turn; the second got them in its FULL.
        for id in 1..=40u32 {
            rig.put(Kind::Aircraft, id, lon(id) + 0.02, 10.0, None);
        }
        let mut b = rig.client(256);
        rig.sub(&b, &["aircraft"], 0, &[]);
        let (mut to_a, mut to_b) = (Vec::new(), Vec::new());
        for _ in 0..8 {
            rig.tick();
            to_a.extend(upserts(&a.drain(), Kind::Aircraft));
            to_b.extend(upserts(&b.drain(), Kind::Aircraft));
        }
        let mut moved: Vec<u32> = to_a.iter().flat_map(|(_, ids)| ids.iter().copied()).collect();
        moved.sort_unstable();
        assert_eq!(moved, (1..=40).collect::<Vec<u32>>(), "the settled client gets each move exactly once");
        assert_eq!(to_b.iter().map(|(full, ids)| (*full, ids.len())).collect::<Vec<_>>(), [(true, 40)]);

        // After that both are on the same shared frames.
        rig.put(Kind::Aircraft, 9, lon(9) + 0.03, 10.0, None);
        let (mut to_a, mut to_b) = (Vec::new(), Vec::new());
        for _ in 0..4 {
            rig.tick();
            to_a.extend(upserts(&a.drain(), Kind::Aircraft));
            to_b.extend(upserts(&b.drain(), Kind::Aircraft));
        }
        assert_eq!(to_a, vec![(false, vec![9])]);
        assert_eq!(to_a, to_b);
    }

    #[test]
    fn a_slow_client_is_resynced_with_full_and_does_not_hold_others_up() {
        let mut rig = Rig::new();
        rig.put(Kind::Aircraft, 1, LONDON.0, LONDON.1, Some("BAW1"));
        rig.tick();
        let cells = [cell_hex(LONDON.0, LONDON.1, Resolution::Two)];
        let mut slow = rig.client(8);
        let mut fast = rig.client(256);
        rig.sub(&slow, &["aircraft"], 2, &cells);
        rig.sub(&fast, &["aircraft"], 2, &cells);
        rig.tick();
        assert_eq!(upserts(&slow.drain(), Kind::Aircraft), vec![(true, vec![1])]);
        assert_eq!(upserts(&fast.drain(), Kind::Aircraft), vec![(true, vec![1])]);
        assert_eq!(rig.hub.group_count(), 1);

        // The slow client stops reading. Its queue of 8 fills with deltas and stats.
        for step in 0..30 {
            rig.put(Kind::Aircraft, 1, LONDON.0 + f64::from(step + 1) * 0.001, LONDON.1, None);
            rig.put(Kind::Aircraft, 100 + step as u32, LONDON.0, LONDON.1 + 0.001 * f64::from(step), Some("NEW"));
            rig.tick();
            // The fast client keeps getting every delta.
            let frames = fast.drain();
            assert_eq!(upserts(&frames, Kind::Aircraft), vec![(false, vec![1, 100 + step as u32])]);
        }
        assert!(rig.hub.metrics.frames_dropped.load(Relaxed) > 0);
        assert_eq!(rig.hub.metrics.resyncs.load(Relaxed), 0);

        // It wakes up and reads what was queued: stale deltas, no FULL yet.
        let queued = slow.drain();
        assert!(queued.len() <= 8);
        assert!(upserts(&queued, Kind::Aircraft).iter().all(|(full, _)| !full));

        // The next tick resynchronises it with one FULL holding the current set.
        rig.tick();
        let frames = slow.drain();
        let ups = upserts(&frames, Kind::Aircraft);
        assert_eq!(ups.len(), 1);
        assert!(ups[0].0, "resync is a FULL frame");
        assert_eq!(ups[0].1.len(), 31);
        assert_eq!(metas(&frames, Kind::Aircraft).len(), 31, "facts are resent with the FULL");
        assert_eq!(rig.hub.metrics.resyncs.load(Relaxed), 1);

        // And then it is back on deltas.
        rig.put(Kind::Aircraft, 1, LONDON.0 + 0.2, LONDON.1, None);
        rig.tick();
        assert_eq!(upserts(&slow.drain(), Kind::Aircraft), vec![(false, vec![1])]);
    }

    #[test]
    fn whole_world_full_waits_for_the_tick() {
        let mut rig = Rig::new();
        rig.put(Kind::Aircraft, 1, LONDON.0, LONDON.1, Some("BAW1"));
        rig.tick();
        let mut c = rig.client(64);
        rig.sub(&c, &["aircraft"], 0, &[]);
        rig.hub.flush(&rig.world, rig.now);
        assert!(c.drain().is_empty(), "a whole-world FULL is built once per tick, not per arrival");
        rig.tick();
        assert_eq!(upserts(&c.drain(), Kind::Aircraft), vec![(true, vec![1])]);
    }

    #[test]
    fn a_large_full_is_split_into_bounded_frames() {
        let mut rig = Rig::new();
        for id in 1..=10_000u32 {
            rig.put(Kind::Ship, id, f64::from(id % 360) - 180.0, f64::from(id % 120) - 60.0, Some("SHIP"));
        }
        rig.tick();
        let mut c = rig.client(64);
        rig.sub(&c, &["ships"], 0, &[]);
        rig.tick();
        let frames = c.drain();
        let ups = upserts(&frames, Kind::Ship);
        // 10,000 entities at 4,096 a frame: one FULL, then the rest as ordinary upserts.
        assert_eq!(
            ups.iter().map(|(full, ids)| (*full, ids.len())).collect::<Vec<_>>(),
            vec![(true, 4096), (false, 4096), (false, 1808)]
        );
        let mut all: Vec<u32> = ups.iter().flat_map(|(_, ids)| ids.iter().copied()).collect();
        all.sort_unstable();
        all.dedup();
        assert_eq!(all.len(), 10_000, "together they are the whole set, with no repeats");
        assert_eq!(metas(&frames, Kind::Ship).len(), 10_000);
        // Each chunk's facts follow its upsert.
        let order: Vec<u8> =
            frames.iter().filter(|f| f.header().kind == Kind::Ship as u8).map(|f| f.header().frame_type).collect();
        assert_eq!(order, vec![1, 3, 1, 3, 1, 3]);

        // A small queue allows fewer, larger frames rather than none at all.
        let mut config = Config::for_tests();
        config.client_queue = 8;
        let mut rig = Rig::with(config);
        for id in 1..=10_000u32 {
            rig.put(Kind::Ship, id, f64::from(id % 360) - 180.0, f64::from(id % 120) - 60.0, None);
        }
        let mut small = rig.client(8);
        rig.sub(&small, &["ships"], 0, &[]);
        rig.tick();
        let ups = upserts(&small.drain(), Kind::Ship);
        assert_eq!(ups.iter().map(|(full, ids)| (*full, ids.len())).collect::<Vec<_>>(), vec![(true, 10_000)]);
    }

    #[test]
    fn identical_subscriptions_share_one_frame() {
        let mut rig = Rig::new();
        rig.put(Kind::Aircraft, 1, LONDON.0, LONDON.1, Some("BAW1"));
        rig.tick();
        let cells = [cell_hex(LONDON.0, LONDON.1, Resolution::Two)];
        let mut a = rig.client(64);
        let mut b = rig.client(64);
        rig.sub(&a, &["aircraft"], 2, &cells);
        rig.sub(&b, &["aircraft"], 2, &cells);
        rig.tick();
        let first = |c: &mut Client| loop {
            match c.rx.try_recv().expect("a frame") {
                Outbound::Frame(bytes) if bytes[2] == protocol::frame_type::UPSERT => break bytes,
                _ => {}
            }
        };
        let (fa, fb) = (first(&mut a), first(&mut b));
        assert_eq!(fa.as_ptr(), fb.as_ptr(), "both clients hold the same allocation");
    }

    #[test]
    fn density_is_global_and_only_resent_when_it_changes() {
        let mut rig = Rig::new();
        rig.put(Kind::Ship, 1, LONDON.0, LONDON.1, None);
        rig.put(Kind::Ship, 2, LONDON.0, LONDON.1, None);
        rig.put(Kind::Ship, 3, NEW_YORK.0, NEW_YORK.1, None);
        rig.tick();
        let mut c = rig.client(64);
        let shape = validate_sub(&["ships".to_owned()], 0, &[], false, true, 2000).unwrap();
        rig.hub.subscribe(c.id, shape);
        rig.tick();
        let frames = c.drain();
        assert!(upserts(&frames, Kind::Ship).is_empty(), "points were not asked for");
        let density: Vec<_> = frames
            .iter()
            .filter_map(|f| match f {
                Frame::Density { res, rows, .. } => Some((*res, rows.clone())),
                _ => None,
            })
            .collect();
        assert_eq!(density.len(), 1);
        assert_eq!(density[0].0, 2);
        let mut counts: Vec<u32> = density[0].1.iter().map(|r| r.count).collect();
        counts.sort_unstable();
        assert_eq!(counts, vec![1, 2]);
        let london = density[0].1.iter().find(|r| r.count == 2).unwrap();
        assert!((london.lat - 51.5).abs() < 2.0 && london.lon.abs() < 3.0, "cell centre is near London");

        for _ in 0..6 {
            rig.tick();
        }
        assert!(c.drain().iter().all(|f| !matches!(f, Frame::Density { .. })), "unchanged counts are not resent");

        rig.put(Kind::Ship, 4, PARIS.0, PARIS.1, None);
        for _ in 0..6 {
            rig.tick();
        }
        assert_eq!(c.drain().iter().filter(|f| matches!(f, Frame::Density { .. })).count(), 1);

        // Moving the viewport keeps density on: nothing changed, so nothing is resent.
        let cells = [cell_hex(LONDON.0, LONDON.1, Resolution::Two)];
        let shape = validate_sub(&["ships".to_owned()], 2, &cells, true, true, 2000).unwrap();
        rig.hub.subscribe(c.id, shape);
        rig.tick();
        let frames = c.drain();
        assert_eq!(upserts(&frames, Kind::Ship), vec![(true, vec![1, 2])]);
        assert!(frames.iter().all(|f| !matches!(f, Frame::Density { .. })));

        // Switching density off and on again does resend it.
        for density in [false, true] {
            let shape = validate_sub(&["ships".to_owned()], 2, &cells, true, density, 2000).unwrap();
            rig.hub.subscribe(c.id, shape);
            rig.tick();
        }
        assert_eq!(c.drain().iter().filter(|f| matches!(f, Frame::Density { .. })).count(), 1);
    }

    #[test]
    fn stats_and_events_reach_every_subscriber() {
        let mut rig = Rig::new();
        rig.put(Kind::Aircraft, 1, LONDON.0, LONDON.1, Some("BAW1"));
        rig.tick();
        let mut c = rig.client(64);
        rig.sub(&c, &["ships"], 3, &[cell_hex(NEW_YORK.0, NEW_YORK.1, Resolution::Three)]);
        rig.tick();
        let frames = c.drain();
        let stats = frames.iter().find_map(|f| match f {
            Frame::Stats { entries, .. } => Some(entries.clone()),
            _ => None,
        });
        assert_eq!(
            stats.unwrap(),
            vec![StatsEntry { kind: 1, status: 1, total: 1 }, StatsEntry { kind: 2, status: 3, total: 0 }]
        );

        let mut obs = Observation::new(1);
        obs.fix = Some(Fix::from_si(LONDON.0, LONDON.1, 1000.0, None, 100.0, 0.0, flag::EMERGENCY, rig.now));
        obs.fact(MetaKey::Squawk, "7700");
        rig.world.apply(Kind::Aircraft, 0, SRC, obs, rig.now);
        rig.tick();
        let events: Vec<_> = c
            .drain()
            .into_iter()
            .filter_map(|f| match f {
                Frame::Events { events, .. } => Some(events),
                _ => None,
            })
            .flatten()
            .collect();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].title, "BAW1 is squawking 7700 (general emergency).");

        // A later subscriber is told about it once.
        let mut late = rig.client(64);
        rig.sub(&late, &["aircraft"], 0, &[]);
        rig.tick();
        rig.tick();
        let replayed = late.drain().iter().filter(|f| matches!(f, Frame::Events { .. })).count();
        assert_eq!(replayed, 1);
    }

    #[test]
    fn compressed_connections_get_deflated_frames_that_decode_the_same() {
        let mut rig = Rig::new();
        for id in 1..=200u32 {
            rig.put(Kind::Aircraft, id, LONDON.0 + f64::from(id) * 0.0001, LONDON.1, Some("CALLSIGN"));
        }
        rig.tick();
        let cells = [cell_hex(LONDON.0, LONDON.1, Resolution::One)];
        let (tx, mut zrx) = mpsc::channel(64);
        rig.hub.connect(77, tx, true);
        let mut plain = rig.client(64);
        let shape = validate_sub(&["aircraft".to_owned()], 1, &cells, true, false, 2000).unwrap();
        rig.hub.subscribe(77, shape);
        rig.sub(&plain, &["aircraft"], 1, &cells);
        rig.tick();

        let mut packed_frames = Vec::new();
        let mut saw_flag = false;
        while let Ok(Outbound::Frame(bytes)) = zrx.try_recv() {
            let header = protocol::read_header(&bytes).unwrap();
            saw_flag |= header.flags & protocol::FRAME_FLAG_DEFLATE != 0;
            if header.frame_type == protocol::frame_type::STATS {
                assert_eq!(header.flags & protocol::FRAME_FLAG_DEFLATE, 0, "small frames are left alone");
            }
            packed_frames.push(decode_frame(&bytes).unwrap());
        }
        assert!(saw_flag);
        assert_eq!(packed_frames, plain.drain());
        let m = &rig.hub.metrics;
        assert!(m.bytes_sent.load(Relaxed) < m.bytes_uncompressed.load(Relaxed));
    }

    #[test]
    fn demand_lists_the_areas_being_watched() {
        let mut rig = Rig::new();
        let a = rig.client(8);
        let b = rig.client(8);
        let c = rig.client(8);
        let cell3 = LatLng::new(LONDON.1, LONDON.0).unwrap().to_cell(Resolution::Three);
        let cell1 = LatLng::new(NEW_YORK.1, NEW_YORK.0).unwrap().to_cell(Resolution::One);
        rig.sub(&a, &["aircraft"], 3, &[cell3.to_string()]);
        rig.sub(&b, &["aircraft", "ships"], 1, &[cell1.to_string()]);
        rig.sub(&c, &["ships"], 0, &[]);
        let demand = rig.hub.demand();
        assert_eq!(demand.clients, 3);
        assert!(demand.aircraft_wanted);
        assert!(!demand.aircraft_world, "only ships are wanted worldwide");
        assert!(demand.aircraft_cells.contains(&u64::from(cell3.parent(Resolution::Two).unwrap())));
        assert_eq!(demand.aircraft_cells.len(), 1 + cell1.children(Resolution::Two).count());

        rig.hub.disconnect(a.id);
        rig.hub.disconnect(b.id);
        assert!(rig.hub.demand().aircraft_cells.is_empty());
        assert_eq!(rig.hub.group_count(), 1);
        // A client that only watches ships is no reason to spend aircraft requests...
        assert!(!rig.hub.demand().aircraft_wanted);
        assert_eq!(rig.hub.demand().clients, 1);
        // ...but one that shows aircraft as density is, though it names no cells.
        let shape = validate_sub(&["aircraft".to_owned()], 0, &[], false, true, 2000).unwrap();
        rig.hub.subscribe(c.id, shape);
        let demand = rig.hub.demand();
        assert!(demand.aircraft_wanted && !demand.aircraft_world && demand.aircraft_cells.is_empty());
    }
}
