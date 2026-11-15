//! In-memory world state: one entity table per kind, indexed by H3 cell.
//!
//! The world is single-threaded on purpose. It is owned by the engine task,
//! which applies upstream observations as they arrive and, once per tick, lets
//! the hub read the lists of what changed. Nothing here blocks or allocates
//! per client.
//!
//! Tick bookkeeping: `tick` is the number of the period in progress. Every
//! change is stamped with it and appended to a per-kind list (`changed`,
//! `moved`, `removed`). `end_tick` clears the lists and starts the next period.

use std::collections::VecDeque;

use h3o::{LatLng, Resolution};
use rustc_hash::FxHashMap;

use crate::config::{Config, KindLimits};
use crate::model::{Fix, Kind, Observation, flag};
use crate::protocol::{EventRef, HaloEvent, LONLAT_SCALE, MetaKey};

/// Resolution every entity is indexed at. Subscriptions at 1 and 2 use its parents.
pub const INDEX_RES: u8 = 3;

/// Ticker events are remembered this long: to replay to new connections and
/// to avoid announcing the same emergency twice.
const EVENT_MEMORY_MS: i64 = 30 * 60 * 1000;
const EVENT_MEMORY_MAX: usize = 64;

/// H3 cell at resolution 3 containing a point, or 0 when the point is invalid.
pub fn cell_of(lat_e7: i32, lon_e7: i32) -> u64 {
    match LatLng::new(f64::from(lat_e7) / LONLAT_SCALE, f64::from(lon_e7) / LONLAT_SCALE) {
        Ok(ll) => u64::from(ll.to_cell(Resolution::Three)),
        Err(_) => 0,
    }
}

/// Parent of a cell at a coarser (or the same) resolution, by bit manipulation:
/// set the resolution field and blank out the finer digits. Equivalent to
/// `CellIndex::parent` for valid input, without re-validating the index.
#[inline]
pub fn parent_cell(cell: u64, res: u8) -> u64 {
    const RES_MASK: u64 = 0xF << 52;
    let unused_digits = (1u64 << (3 * (15 - u32::from(res)))) - 1;
    (cell & !RES_MASK) | (u64::from(res) << 52) | unused_digits
}

/// Static facts about one entity: a few short strings, sorted by key.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Meta(Vec<(MetaKey, Box<str>)>);

impl Meta {
    pub fn get(&self, key: MetaKey) -> Option<&str> {
        self.0.iter().find(|(k, _)| *k == key).map(|(_, v)| &**v)
    }

    /// Set a field. Returns true when the value changed.
    pub fn set(&mut self, key: MetaKey, value: &str) -> bool {
        match self.0.binary_search_by_key(&key, |(k, _)| *k) {
            Ok(i) => {
                if &*self.0[i].1 == value {
                    return false;
                }
                self.0[i].1 = value.into();
                true
            }
            Err(i) => {
                self.0.insert(i, (key, value.into()));
                true
            }
        }
    }

    /// Fields in ascending key order, as a Meta frame wants them.
    pub fn iter(&self) -> impl Iterator<Item = (MetaKey, &str)> {
        self.0.iter().map(|(k, v)| (*k, &**v))
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// One vertex of an entity's recent track.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrackPoint {
    /// Unix seconds.
    pub time_s: u32,
    pub lon_e7: i32,
    pub lat_e7: i32,
    /// Units of 7.62 m.
    pub alt: i16,
}

#[derive(Debug, Clone)]
pub struct Entity {
    pub id: u32,
    pub alive: bool,
    /// Latest fix. `fix.time_ms == 0` until a position arrives.
    pub fix: Fix,
    pub category: u8,
    /// Position older than the kind's freshness window.
    pub stale: bool,
    /// Resolution-3 cell, or 0 while the entity has no position.
    pub cell: u64,
    /// Cell at the start of the tick in which the entity last changed cell.
    pub prev_cell: u64,
    pub moved_tick: u32,
    /// Tick in which the fix, category or flags last changed.
    pub changed_tick: u32,
    /// Tick in which the facts last changed.
    pub meta_tick: u32,
    pub last_seen_ms: i64,
    pub expires_ms: i64,
    /// Fix time when the entity was last marked changed.
    announced_ms: i64,
    /// Registry index of the source of the latest fix.
    pub source: u8,
    pub meta: Meta,
    pub track: VecDeque<TrackPoint>,
}

impl Entity {
    pub fn positioned(&self) -> bool {
        self.cell != 0
    }

    /// `EntityFlag` bits as sent on the wire.
    pub fn wire_flags(&self) -> u8 {
        self.fix.flags | if self.stale { flag::STALE } else { 0 }
    }

    /// The cell clients knew this entity in when the current tick began.
    fn known_cell(&self, tick: u32) -> u64 {
        if self.moved_tick == tick { self.prev_cell } else { self.cell }
    }
}

/// All entities of one kind.
pub struct KindTable {
    pub kind: Kind,
    limits: KindLimits,
    density_res: u8,
    entities: Vec<Entity>,
    free: Vec<u32>,
    /// Slots freed this tick; reused only from the next tick so the change
    /// lists never point at a recycled slot.
    pending_free: Vec<u32>,
    by_id: FxHashMap<u32, u32>,
    /// Resolution-3 cell to the slots of the entities in it.
    cells: FxHashMap<u64, Vec<u32>>,
    density: FxHashMap<u64, u32>,
    /// Bumped whenever a density count changes.
    pub density_version: u64,
    positioned: usize,
    /// Slots whose fix, flags, category or facts changed this tick.
    pub changed: Vec<u32>,
    /// Slots that changed cell this tick (including first appearance).
    pub moved: Vec<u32>,
    /// `(id, cell)` of entities dropped this tick; `cell` is where clients knew them.
    pub removed: Vec<(u32, u64)>,
}

impl KindTable {
    fn new(kind: Kind, limits: KindLimits, density_res: u8) -> Self {
        Self {
            kind,
            limits,
            density_res,
            entities: Vec::new(),
            free: Vec::new(),
            pending_free: Vec::new(),
            by_id: FxHashMap::default(),
            cells: FxHashMap::default(),
            density: FxHashMap::default(),
            density_version: 0,
            positioned: 0,
            changed: Vec::new(),
            moved: Vec::new(),
            removed: Vec::new(),
        }
    }

    /// Entities with a position: what Stats reports as the worldwide total.
    pub fn total(&self) -> usize {
        self.positioned
    }

    /// Every tracked id, including entities still waiting for a first position.
    pub fn len(&self) -> usize {
        self.by_id.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_id.is_empty()
    }

    /// Size of the slot table, for whole-world iteration by slot.
    pub fn slots(&self) -> usize {
        self.entities.len()
    }

    #[inline]
    pub fn slot(&self, slot: u32) -> &Entity {
        &self.entities[slot as usize]
    }

    pub fn get(&self, id: u32) -> Option<&Entity> {
        self.by_id.get(&id).map(|&slot| &self.entities[slot as usize])
    }

    /// Slots of the entities in one resolution-3 cell.
    pub fn in_cell(&self, cell: u64) -> &[u32] {
        self.cells.get(&cell).map_or(&[], Vec::as_slice)
    }

    /// Every occupied resolution-3 cell with its slots.
    pub fn occupied_cells(&self) -> impl Iterator<Item = (u64, &[u32])> {
        self.cells.iter().map(|(cell, slots)| (*cell, slots.as_slice()))
    }

    /// Entity counts per cell at the density resolution.
    pub fn density(&self) -> &FxHashMap<u64, u32> {
        &self.density
    }

    pub fn iter(&self) -> impl Iterator<Item = &Entity> {
        self.entities.iter().filter(|e| e.alive)
    }

    fn allocate(&mut self, id: u32) -> u32 {
        let entity = Entity {
            id,
            alive: true,
            fix: Fix::default(),
            category: 0,
            stale: false,
            cell: 0,
            prev_cell: 0,
            moved_tick: 0,
            changed_tick: 0,
            meta_tick: 0,
            last_seen_ms: 0,
            expires_ms: 0,
            announced_ms: 0,
            source: 0,
            meta: Meta::default(),
            track: VecDeque::new(),
        };
        let slot = match self.free.pop() {
            Some(slot) => {
                self.entities[slot as usize] = entity;
                slot
            }
            None => {
                self.entities.push(entity);
                (self.entities.len() - 1) as u32
            }
        };
        self.by_id.insert(id, slot);
        slot
    }

    fn mark_changed(&mut self, slot: u32, tick: u32) {
        let e = &mut self.entities[slot as usize];
        if e.changed_tick != tick {
            e.changed_tick = tick;
            self.changed.push(slot);
        }
    }

    fn density_add(&mut self, cell: u64) {
        *self.density.entry(parent_cell(cell, self.density_res)).or_insert(0) += 1;
        self.density_version += 1;
    }

    fn density_sub(&mut self, cell: u64) {
        let key = parent_cell(cell, self.density_res);
        if let Some(count) = self.density.get_mut(&key) {
            *count -= 1;
            if *count == 0 {
                self.density.remove(&key);
            }
        }
        self.density_version += 1;
    }

    fn index_remove(&mut self, slot: u32, cell: u64) {
        if let Some(list) = self.cells.get_mut(&cell) {
            if let Some(i) = list.iter().position(|&s| s == slot) {
                list.swap_remove(i);
            }
            if list.is_empty() {
                self.cells.remove(&cell);
            }
        }
    }

    /// Move an entity to a new cell, keeping the index, the density counts and
    /// the tick's `moved` list in step.
    fn set_cell(&mut self, slot: u32, new_cell: u64, tick: u32) {
        let (old_cell, first_move) = {
            let e = &mut self.entities[slot as usize];
            let old = e.cell;
            if old == new_cell {
                return;
            }
            let first = e.moved_tick != tick;
            if first {
                e.moved_tick = tick;
                e.prev_cell = old;
            }
            e.cell = new_cell;
            (old, first)
        };
        if first_move {
            self.moved.push(slot);
        }
        if old_cell != 0 {
            self.index_remove(slot, old_cell);
            if parent_cell(old_cell, self.density_res) != parent_cell(new_cell, self.density_res) {
                self.density_sub(old_cell);
                self.density_add(new_cell);
            }
        } else {
            self.positioned += 1;
            self.density_add(new_cell);
        }
        self.cells.entry(new_cell).or_default().push(slot);
    }

    fn remove_slot(&mut self, slot: u32, tick: u32) {
        let (id, cell, known_cell) = {
            let e = &mut self.entities[slot as usize];
            if !e.alive {
                return;
            }
            e.alive = false;
            let out = (e.id, e.cell, e.known_cell(tick));
            // Release the strings and the track now; the slot itself is recycled next tick.
            e.meta = Meta::default();
            e.track = VecDeque::new();
            out
        };
        self.by_id.remove(&id);
        if cell != 0 {
            self.index_remove(slot, cell);
            self.density_sub(cell);
            self.positioned -= 1;
        }
        // An entity created and dropped within one tick was never announced.
        if known_cell != 0 {
            self.removed.push((id, known_cell));
        }
        self.pending_free.push(slot);
    }

    /// Drop the oldest entities when the table is over its cap.
    fn enforce_cap(&mut self, tick: u32) {
        if self.by_id.len() <= self.limits.max_entities {
            return;
        }
        // Evict a batch so a sustained overflow does not sort on every insert.
        let excess = self.by_id.len() - self.limits.max_entities + self.limits.max_entities / 50;
        let mut ages: Vec<(i64, u32)> = self
            .entities
            .iter()
            .enumerate()
            .filter(|(_, e)| e.alive)
            .map(|(i, e)| (e.last_seen_ms, i as u32))
            .collect();
        let n = excess.min(ages.len());
        if n == 0 {
            return;
        }
        ages.select_nth_unstable(n - 1);
        for &(_, slot) in &ages[..n] {
            self.remove_slot(slot, tick);
        }
    }

    fn end_tick(&mut self) {
        self.changed.clear();
        self.moved.clear();
        self.removed.clear();
        self.free.append(&mut self.pending_free);
    }
}

/// Everything `/v1/entity/{kind}/{id}` reports about one entity.
#[derive(Debug, Clone)]
pub struct EntityDetail {
    pub kind: Kind,
    pub id: u32,
    pub fix: Fix,
    pub category: u8,
    pub flags: u8,
    pub source: u8,
    pub meta: Vec<(MetaKey, String)>,
    pub track: Vec<TrackPoint>,
}

/// One `/v1/search` result.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchHit {
    pub kind: Kind,
    pub id: u32,
    pub lon: f64,
    pub lat: f64,
    pub title: String,
    pub subtitle: Option<String>,
    /// Higher is better: 100 exact, 80 prefix, 50 substring.
    pub score: u8,
}

pub struct World {
    tables: [KindTable; Kind::COUNT],
    /// Number of the tick period in progress. Starts at 1.
    pub tick: u32,
    /// Ticker events raised this tick.
    pub events: Vec<HaloEvent>,
    recent_events: VecDeque<HaloEvent>,
    /// Observations applied since start, for metrics.
    pub observations: u64,
}

impl World {
    pub fn new(config: &Config) -> World {
        World {
            tables: [
                KindTable::new(Kind::Aircraft, config.aircraft, config.density_res),
                KindTable::new(Kind::Ship, config.ships, config.density_res),
            ],
            tick: 1,
            events: Vec::new(),
            recent_events: VecDeque::new(),
            observations: 0,
        }
    }

    pub fn table(&self, kind: Kind) -> &KindTable {
        &self.tables[kind.index()]
    }

    /// Events raised in the last half hour, oldest first.
    pub fn recent_events(&self) -> impl Iterator<Item = &HaloEvent> {
        self.recent_events.iter()
    }

    /// Merge one observation. The newest fix wins; facts accumulate.
    pub fn apply(&mut self, kind: Kind, source: u8, source_id: &str, obs: Observation, now_ms: i64) {
        self.observations += 1;
        let tick = self.tick;
        let table = &mut self.tables[kind.index()];
        let limits = table.limits;

        let (slot, created) = match table.by_id.get(&obs.id) {
            Some(&slot) => (slot, false),
            None => {
                if obs.fix.is_none() && obs.meta.is_empty() && obs.category.is_none() {
                    return;
                }
                let slot = table.allocate(obs.id);
                let e = &mut table.entities[slot as usize];
                e.source = source;
                e.last_seen_ms = now_ms;
                e.expires_ms = now_ms + limits.ttl_ms;
                e.meta.set(MetaKey::Source, source_id);
                (slot, true)
            }
        };

        let mut dirty = false;
        let mut meta_dirty = created;
        let mut emergency_raised = false;
        let mut new_cell = None;
        {
            let e = &mut table.entities[slot as usize];
            for (key, value) in &obs.meta {
                meta_dirty |= e.meta.set(*key, value);
            }
            if let Some(category) = obs.category
                && category != e.category
            {
                e.category = category;
                dirty = true;
            }
            if let Some(mut fix) = obs.fix {
                // A clock ahead of ours must not make a fix look fresher than "now".
                fix.time_ms = fix.time_ms.min(now_ms);
                fix.flags &= !flag::STALE;
                if !e.positioned() || fix.time_ms >= e.fix.time_ms {
                    let old = e.fix;
                    let same_motion = old.lon_e7 == fix.lon_e7
                        && old.lat_e7 == fix.lat_e7
                        && old.alt == fix.alt
                        && old.heading == fix.heading
                        && old.speed == fix.speed
                        && old.vrate == fix.vrate
                        && old.flags == fix.flags;
                    if !e.positioned() || old.lon_e7 != fix.lon_e7 || old.lat_e7 != fix.lat_e7 {
                        let cell = cell_of(fix.lat_e7, fix.lon_e7);
                        if cell == 0 {
                            return;
                        }
                        if cell != e.cell {
                            new_cell = Some(cell);
                        }
                    }
                    emergency_raised = fix.flags & flag::EMERGENCY != 0 && old.flags & flag::EMERGENCY == 0;
                    let first_position = !e.positioned();
                    e.fix = fix;
                    e.source = source;
                    if first_position || !same_motion || fix.time_ms - e.announced_ms >= limits.refresh_ms {
                        dirty = true;
                        e.announced_ms = fix.time_ms;
                    }
                    if e.stale && now_ms - fix.time_ms <= limits.stale_ms {
                        e.stale = false;
                        dirty = true;
                    }
                    if first_position {
                        // First appearance: clients need the facts gathered so far.
                        meta_dirty = true;
                    }
                    e.last_seen_ms = now_ms;
                    let ttl =
                        obs.ttl_ms.map_or(limits.ttl_ms, |t| i64::from(t).clamp(limits.ttl_ms, limits.max_ttl_ms));
                    e.expires_ms = now_ms + ttl;

                    let time_s = (fix.time_ms / 1000) as u32;
                    let record = match e.track.back() {
                        None => true,
                        Some(last) => {
                            i64::from(time_s) - i64::from(last.time_s) >= limits.track_interval_ms / 1000
                                && (last.lon_e7 != fix.lon_e7 || last.lat_e7 != fix.lat_e7)
                        }
                    };
                    if record && limits.track_points > 0 {
                        if e.track.len() >= limits.track_points {
                            e.track.pop_front();
                        }
                        e.track.push_back(TrackPoint { time_s, lon_e7: fix.lon_e7, lat_e7: fix.lat_e7, alt: fix.alt });
                    }
                }
            }
            if meta_dirty {
                e.meta_tick = tick;
            }
        }

        if let Some(cell) = new_cell {
            table.set_cell(slot, cell, tick);
        }
        // Facts ride along with an Upsert, so a change of facts marks the entity changed too.
        if (dirty || meta_dirty) && table.entities[slot as usize].positioned() {
            table.mark_changed(slot, tick);
        }
        if created {
            table.enforce_cap(tick);
        }
        if emergency_raised && kind == Kind::Aircraft {
            self.raise_emergency(slot, now_ms);
        }
    }

    /// Drop entities a source positively no longer sees, unless something has
    /// reported them since.
    pub fn gone(&mut self, kind: Kind, ids: &[u32], unless_seen_after_ms: i64) {
        let tick = self.tick;
        let table = &mut self.tables[kind.index()];
        for id in ids {
            if let Some(&slot) = table.by_id.get(id)
                && table.entities[slot as usize].last_seen_ms <= unless_seen_after_ms
            {
                table.remove_slot(slot, tick);
            }
        }
    }

    /// Expire silent entities and flag stale positions. Call once per tick,
    /// before the hub reads the change lists.
    pub fn sweep(&mut self, now_ms: i64) {
        let tick = self.tick;
        for table in &mut self.tables {
            let stale_ms = table.limits.stale_ms;
            for slot in 0..table.entities.len() as u32 {
                let e = &mut table.entities[slot as usize];
                if !e.alive {
                    continue;
                }
                if now_ms >= e.expires_ms {
                    table.remove_slot(slot, tick);
                    continue;
                }
                if e.positioned() {
                    let stale = now_ms - e.fix.time_ms > stale_ms;
                    if stale != e.stale {
                        e.stale = stale;
                        table.mark_changed(slot, tick);
                    }
                }
            }
        }
        while self.recent_events.front().is_some_and(|e| now_ms - e.time_ms > EVENT_MEMORY_MS) {
            self.recent_events.pop_front();
        }
    }

    /// Finish the tick: clear the change lists and start the next period.
    pub fn end_tick(&mut self) {
        for table in &mut self.tables {
            table.end_tick();
        }
        self.events.clear();
        self.tick += 1;
    }

    fn raise_emergency(&mut self, slot: u32, now_ms: i64) {
        let e = self.tables[Kind::Aircraft.index()].slot(slot);
        let squawk = e.meta.get(MetaKey::Squawk).unwrap_or("");
        let (meaning, severity) = match squawk {
            "7500" => ("unlawful interference", 2),
            "7600" => ("radio failure", 1),
            "7700" => ("general emergency", 2),
            _ => ("an emergency", 1),
        };
        let name = match e.meta.get(MetaKey::Label) {
            Some(label) => label.to_owned(),
            None => format!("Aircraft {:06x}", e.id),
        };
        let title = if squawk.is_empty() {
            format!("{name} is reporting an emergency.")
        } else {
            format!("{name} is squawking {squawk} ({meaning}).")
        };
        let id = format!("emergency-{:06x}-{}", e.id, if squawk.is_empty() { "x" } else { squawk });
        if self.recent_events.iter().any(|known| known.id == id) {
            return;
        }
        let event = HaloEvent {
            id,
            topic: "emergency".to_owned(),
            time_ms: now_ms,
            title,
            detail: None,
            // Four decimals is about ten metres: plenty for a ticker line.
            lon: Some((e.fix.lon() * 1e4).round() / 1e4),
            lat: Some((e.fix.lat() * 1e4).round() / 1e4),
            entity: Some(EventRef { kind: Kind::Aircraft as u8, id: e.id }),
            severity: Some(severity),
        };
        if self.recent_events.len() >= EVENT_MEMORY_MAX {
            self.recent_events.pop_front();
        }
        self.recent_events.push_back(event.clone());
        self.events.push(event);
    }

    /// Latest fix, facts and recent track of one entity.
    pub fn detail(&self, kind: Kind, id: u32) -> Option<EntityDetail> {
        let e = self.table(kind).get(id)?;
        if !e.positioned() {
            return None;
        }
        Some(EntityDetail {
            kind,
            id,
            fix: e.fix,
            category: e.category,
            flags: e.wire_flags(),
            source: e.source,
            meta: e.meta.iter().map(|(k, v)| (k, v.to_owned())).collect(),
            track: e.track.iter().copied().collect(),
        })
    }

    /// Find entities anywhere by callsign, registration, name, MMSI or hex
    /// address. Matching is case-insensitive: exact, then prefix, then substring.
    pub fn search(&self, query: &str, limit: usize) -> Vec<SearchHit> {
        let needle = query.trim().to_ascii_lowercase();
        if needle.is_empty() || limit == 0 {
            return Vec::new();
        }
        const FIELDS: [MetaKey; 5] =
            [MetaKey::Label, MetaKey::Registration, MetaKey::Callsign, MetaKey::Imo, MetaKey::TypeCode];
        let mut hits: Vec<(u8, Kind, u32)> = Vec::new();
        let mut id_text = String::with_capacity(12);
        for table in &self.tables {
            for (slot, e) in table.entities.iter().enumerate() {
                if !e.alive || !e.positioned() {
                    continue;
                }
                let mut best = 0u8;
                for (key, value) in e.meta.iter() {
                    if !FIELDS.contains(&key) {
                        continue;
                    }
                    // A type code is only worth an exact match: "A320" should
                    // not drown out everything whose callsign contains "A3".
                    let score = match_score(value, &needle);
                    if key == MetaKey::TypeCode && score < 100 {
                        continue;
                    }
                    best = best.max(if key == MetaKey::TypeCode { 40 } else { score });
                }
                if best < 100 {
                    id_text.clear();
                    use std::fmt::Write;
                    match table.kind {
                        Kind::Aircraft => write!(id_text, "{:06x}", e.id).ok(),
                        Kind::Ship => write!(id_text, "{}", e.id).ok(),
                    };
                    best = best.max(match_score(&id_text, &needle));
                }
                if best > 0 {
                    hits.push((best, table.kind, slot as u32));
                }
            }
        }
        hits.sort_unstable_by(|a, b| b.0.cmp(&a.0).then(a.2.cmp(&b.2)));
        hits.truncate(limit);
        hits.into_iter()
            .map(|(score, kind, slot)| {
                let e = self.table(kind).slot(slot);
                let title = match e.meta.get(MetaKey::Label) {
                    Some(label) => label.to_owned(),
                    None => match kind {
                        Kind::Aircraft => format!("{:06x}", e.id),
                        Kind::Ship => e.id.to_string(),
                    },
                };
                let subtitle = match kind {
                    Kind::Aircraft => [MetaKey::Registration, MetaKey::TypeName, MetaKey::TypeCode]
                        .iter()
                        .filter_map(|k| e.meta.get(*k))
                        .take(2)
                        .collect::<Vec<_>>()
                        .join(" · "),
                    Kind::Ship => format!("MMSI {}", e.id),
                };
                SearchHit {
                    kind,
                    id: e.id,
                    lon: e.fix.lon(),
                    lat: e.fix.lat(),
                    title,
                    subtitle: (!subtitle.is_empty()).then_some(subtitle),
                    score,
                }
            })
            .collect()
    }
}

/// 100 for an exact match, 80 for a prefix, 50 for a substring, 0 otherwise.
/// `needle` must already be lower-case ASCII; `hay` is compared ignoring ASCII case.
fn match_score(hay: &str, needle: &str) -> u8 {
    let (hay, needle) = (hay.as_bytes(), needle.as_bytes());
    if needle.len() > hay.len() {
        return 0;
    }
    let matches_at =
        |start: usize| hay[start..start + needle.len()].iter().zip(needle).all(|(h, n)| h.to_ascii_lowercase() == *n);
    if matches_at(0) {
        return if hay.len() == needle.len() { 100 } else { 80 };
    }
    if (1..=hay.len() - needle.len()).any(matches_at) { 50 } else { 0 }
}

#[cfg(test)]
mod tests {
    use h3o::CellIndex;

    use super::*;

    const SRC: &str = "test";

    fn world() -> World {
        World::new(&Config::for_tests())
    }

    fn fix(lon: f64, lat: f64, time_ms: i64) -> Fix {
        Fix::from_si(lon, lat, 10_000.0, Some(90.0), 200.0, 0.0, 0, time_ms)
    }

    fn obs(id: u32, lon: f64, lat: f64, time_ms: i64) -> Observation {
        Observation { id, fix: Some(fix(lon, lat, time_ms)), ..Default::default() }
    }

    #[test]
    fn parent_cell_matches_h3o() {
        let mut seed = 12345u64;
        let mut next = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 11) as f64 / (1u64 << 53) as f64
        };
        for _ in 0..2000 {
            let lat = next() * 180.0 - 90.0;
            let lon = next() * 360.0 - 180.0;
            let cell = LatLng::new(lat, lon).unwrap().to_cell(Resolution::Three);
            let raw = u64::from(cell);
            assert_eq!(raw, cell_of(crate::protocol::quantise_lat(lat), crate::protocol::quantise_lon(lon)));
            assert_eq!(parent_cell(raw, 3), raw);
            assert_eq!(parent_cell(raw, 2), u64::from(cell.parent(Resolution::Two).unwrap()));
            assert_eq!(parent_cell(raw, 1), u64::from(cell.parent(Resolution::One).unwrap()));
            assert!(CellIndex::try_from(parent_cell(raw, 1)).is_ok());
        }
    }

    #[test]
    fn newest_fix_wins_and_facts_accumulate() {
        let mut w = world();
        w.apply(Kind::Aircraft, 0, SRC, obs(1, 10.0, 50.0, 1000), 1000);
        let mut later = obs(1, 10.1, 50.0, 3000);
        later.fact(MetaKey::Label, "TEST1 ");
        w.apply(Kind::Aircraft, 1, "other", later, 3000);
        // An older report from a slower source must not move the entity back.
        let mut stale = obs(1, 9.0, 49.0, 2000);
        stale.fact(MetaKey::Registration, "G-TEST");
        w.apply(Kind::Aircraft, 0, SRC, stale, 3500);

        let e = w.table(Kind::Aircraft).get(1).unwrap();
        assert_eq!(e.fix.lon_e7, 101_000_000);
        assert_eq!(e.fix.time_ms, 3000);
        assert_eq!(e.source, 1);
        assert_eq!(e.meta.get(MetaKey::Label), Some("TEST1"));
        assert_eq!(e.meta.get(MetaKey::Registration), Some("G-TEST"));
        assert_eq!(e.meta.get(MetaKey::Source), Some(SRC), "source is where it was first seen");
        assert_eq!(w.table(Kind::Aircraft).total(), 1);
        assert_eq!(w.table(Kind::Aircraft).changed.len(), 1, "one entry per tick however often it changes");
    }

    #[test]
    fn unchanged_fixes_are_not_announced_until_the_refresh_interval() {
        let mut w = world();
        w.apply(Kind::Ship, 0, SRC, obs(7, 24.9, 60.1, 1_000), 1_000);
        w.end_tick();
        w.apply(Kind::Ship, 0, SRC, obs(7, 24.9, 60.1, 61_000), 61_000);
        assert!(w.table(Kind::Ship).changed.is_empty());
        assert_eq!(w.table(Kind::Ship).get(7).unwrap().fix.time_ms, 61_000, "the fix time still advances");
        w.apply(Kind::Ship, 0, SRC, obs(7, 24.9, 60.1, 301_000), 301_000);
        assert_eq!(w.table(Kind::Ship).changed.len(), 1);
    }

    #[test]
    fn entities_expire_and_report_where_clients_knew_them() {
        let mut w = world();
        w.apply(Kind::Aircraft, 0, SRC, obs(1, 10.0, 50.0, 0), 0);
        let cell = w.table(Kind::Aircraft).get(1).unwrap().cell;
        w.end_tick();
        w.sweep(89_000);
        assert!(w.table(Kind::Aircraft).get(1).is_some());
        assert!(w.table(Kind::Aircraft).get(1).unwrap().stale);
        assert_eq!(w.table(Kind::Aircraft).changed.len(), 1, "turning stale is a change");
        w.end_tick();
        w.sweep(90_000);
        assert!(w.table(Kind::Aircraft).get(1).is_none());
        assert_eq!(w.table(Kind::Aircraft).removed, vec![(1, cell)]);
        assert_eq!(w.table(Kind::Aircraft).total(), 0);
        assert!(w.table(Kind::Aircraft).density().is_empty());
        assert!(w.table(Kind::Aircraft).in_cell(cell).is_empty());
    }

    #[test]
    fn a_longer_lifetime_can_be_requested_up_to_the_cap() {
        let mut w = world();
        let mut slow = obs(1, 10.0, 50.0, 0);
        slow.ttl_ms = Some(400_000);
        w.apply(Kind::Aircraft, 0, SRC, slow, 0);
        let mut too_long = obs(2, 10.0, 50.0, 0);
        too_long.ttl_ms = Some(u32::MAX);
        w.apply(Kind::Aircraft, 0, SRC, too_long, 0);
        w.sweep(399_000);
        assert!(w.table(Kind::Aircraft).get(1).is_some());
        w.sweep(400_000);
        assert!(w.table(Kind::Aircraft).get(1).is_none());
        w.sweep(899_000);
        assert!(w.table(Kind::Aircraft).get(2).is_some());
        w.sweep(900_000);
        assert!(w.table(Kind::Aircraft).get(2).is_none());
    }

    #[test]
    fn gone_removes_only_what_nobody_has_seen_since() {
        let mut w = world();
        w.apply(Kind::Aircraft, 0, SRC, obs(1, 10.0, 50.0, 1000), 1000);
        w.apply(Kind::Aircraft, 0, SRC, obs(2, 10.0, 50.0, 1000), 1000);
        w.apply(Kind::Aircraft, 1, SRC, obs(2, 10.0, 50.0, 5000), 5000);
        w.gone(Kind::Aircraft, &[1, 2, 3], 4000);
        assert!(w.table(Kind::Aircraft).get(1).is_none());
        assert!(w.table(Kind::Aircraft).get(2).is_some());
    }

    #[test]
    fn cell_moves_are_tracked_once_per_tick_and_density_follows() {
        let mut w = world();
        w.apply(Kind::Aircraft, 0, SRC, obs(1, 0.0, 0.0, 1000), 1000);
        let first = w.table(Kind::Aircraft).get(1).unwrap().cell;
        assert_eq!(w.table(Kind::Aircraft).moved.len(), 1);
        assert_eq!(w.table(Kind::Aircraft).get(1).unwrap().prev_cell, 0);
        w.end_tick();

        w.apply(Kind::Aircraft, 0, SRC, obs(1, 40.0, 40.0, 2000), 2000);
        w.apply(Kind::Aircraft, 0, SRC, obs(1, 80.0, 60.0, 3000), 3000);
        let t = w.table(Kind::Aircraft);
        let e = t.get(1).unwrap();
        assert_eq!(t.moved.len(), 1);
        assert_eq!(e.prev_cell, first, "the cell at the start of the tick is kept");
        assert_ne!(e.cell, first);
        assert!(t.in_cell(first).is_empty());
        assert_eq!(t.in_cell(e.cell).len(), 1);
        assert_eq!(t.density().len(), 1);
        assert_eq!(t.density().get(&parent_cell(e.cell, 2)), Some(&1));
    }

    #[test]
    fn slots_are_not_recycled_within_a_tick() {
        let mut w = world();
        w.apply(Kind::Aircraft, 0, SRC, obs(1, 0.0, 0.0, 1000), 1000);
        w.end_tick();
        w.gone(Kind::Aircraft, &[1], i64::MAX);
        w.apply(Kind::Aircraft, 0, SRC, obs(2, 5.0, 5.0, 2000), 2000);
        let t = w.table(Kind::Aircraft);
        assert_eq!(t.slots(), 2);
        assert!(!t.slot(0).alive);
        assert_eq!(t.slot(1).id, 2);
        w.end_tick();
        w.apply(Kind::Aircraft, 0, SRC, obs(3, 5.0, 5.0, 3000), 3000);
        assert_eq!(w.table(Kind::Aircraft).slots(), 2, "the freed slot is reused next tick");
    }

    #[test]
    fn created_and_dropped_within_one_tick_is_never_announced_as_removed() {
        let mut w = world();
        w.apply(Kind::Aircraft, 0, SRC, obs(1, 0.0, 0.0, 1000), 1000);
        w.gone(Kind::Aircraft, &[1], i64::MAX);
        assert!(w.table(Kind::Aircraft).removed.is_empty());
    }

    #[test]
    fn facts_without_a_position_wait_for_one() {
        let mut w = world();
        let mut static_data = Observation::new(230_000_001);
        static_data.fact(MetaKey::Label, "AURORA");
        static_data.category = Some(crate::model::ship_category::PASSENGER);
        w.apply(Kind::Ship, 0, SRC, static_data, 1000);
        let t = w.table(Kind::Ship);
        assert_eq!(t.total(), 0);
        assert_eq!(t.len(), 1);
        assert!(t.changed.is_empty());
        assert!(w.detail(Kind::Ship, 230_000_001).is_none());
        w.end_tick();

        w.apply(Kind::Ship, 0, SRC, obs(230_000_001, 24.9, 60.1, 2000), 2000);
        let t = w.table(Kind::Ship);
        let e = t.get(230_000_001).unwrap();
        assert_eq!(t.total(), 1);
        assert_eq!(e.category, crate::model::ship_category::PASSENGER);
        assert_eq!(e.meta_tick, w.tick, "facts are due with the first position");
        assert_eq!(t.changed.len(), 1);
    }

    #[test]
    fn the_cap_evicts_the_oldest() {
        let mut config = Config::for_tests();
        config.aircraft.max_entities = 100;
        let mut w = World::new(&config);
        for i in 0..150u32 {
            w.apply(Kind::Aircraft, 0, SRC, obs(i + 1, f64::from(i) * 0.1, 10.0, i64::from(i)), i64::from(i));
        }
        let t = w.table(Kind::Aircraft);
        assert!(t.len() <= 100, "{}", t.len());
        assert!(t.get(150).is_some(), "the newest survives");
        assert!(t.get(1).is_none(), "the oldest is evicted");
    }

    #[test]
    fn an_emergency_squawk_raises_one_event() {
        let mut w = world();
        let mut o = obs(0x4ca7b5, -5.1, 53.4, 1000);
        o.fact(MetaKey::Label, "EIN4KD");
        o.fact(MetaKey::Squawk, "7700");
        o.fix.as_mut().unwrap().flags = flag::EMERGENCY;
        w.apply(Kind::Aircraft, 0, SRC, o.clone(), 1000);
        assert_eq!(w.events.len(), 1);
        let event = &w.events[0];
        assert_eq!(event.id, "emergency-4ca7b5-7700");
        assert_eq!(event.topic, "emergency");
        assert_eq!(event.title, "EIN4KD is squawking 7700 (general emergency).");
        assert_eq!(event.entity, Some(EventRef { kind: 1, id: 0x4ca7b5 }));
        assert_eq!(event.severity, Some(2));
        assert_eq!(event.lon, Some(-5.1));
        w.end_tick();

        // Still squawking: no repeat. Clearing and squawking again within the
        // half hour is the same event, not a new one.
        o.fix.as_mut().unwrap().time_ms = 2000;
        w.apply(Kind::Aircraft, 0, SRC, o.clone(), 2000);
        let mut cleared = obs(0x4ca7b5, -5.1, 53.4, 3000);
        cleared.fact(MetaKey::Squawk, "2000");
        w.apply(Kind::Aircraft, 0, SRC, cleared, 3000);
        o.fix.as_mut().unwrap().time_ms = 4000;
        w.apply(Kind::Aircraft, 0, SRC, o, 4000);
        assert!(w.events.is_empty());
        assert_eq!(w.recent_events().count(), 1);
        assert!(w.table(Kind::Aircraft).get(0x4ca7b5).unwrap().wire_flags() & flag::EMERGENCY != 0);
    }

    #[test]
    fn search_ranks_exact_then_prefix_then_substring() {
        let mut w = world();
        let mut add = |kind: Kind, id: u32, label: &str, reg: Option<&str>| {
            let mut o = obs(id, 10.0, 50.0, 1000);
            o.fact(MetaKey::Label, label);
            if let Some(reg) = reg {
                o.fact(MetaKey::Registration, reg);
            }
            w.apply(kind, 0, SRC, o, 1000);
        };
        add(Kind::Aircraft, 0x4ca7b5, "EIN4KD", Some("EI-DVM"));
        add(Kind::Aircraft, 0x400001, "BAW4", Some("G-EUUU"));
        add(Kind::Aircraft, 0x400002, "XBAW41", None);
        add(Kind::Ship, 230_123_456, "BALTIC QUEEN", None);

        let hits = w.search("baw4", 10);
        assert_eq!(hits.iter().map(|h| h.id).collect::<Vec<_>>(), vec![0x400001, 0x400002]);
        assert_eq!(hits[0].score, 100);
        assert_eq!(hits[1].score, 50);
        assert_eq!(w.search("ei-d", 10)[0].title, "EIN4KD");
        assert_eq!(w.search("4CA7", 10)[0].id, 0x4ca7b5, "hex address prefix");
        assert_eq!(w.search("230123456", 10)[0].kind, Kind::Ship);
        assert_eq!(w.search("queen", 10)[0].subtitle.as_deref(), Some("MMSI 230123456"));
        assert_eq!(w.search("a", 2).len(), 2, "results are capped");
        assert!(w.search("  ", 10).is_empty());
        assert!(w.search("zzzz", 10).is_empty());
    }

    #[test]
    fn detail_includes_the_track() {
        let mut w = world();
        for i in 0..5i64 {
            w.apply(Kind::Aircraft, 0, SRC, obs(1, 10.0 + i as f64 * 0.1, 50.0, i * 20_000), i * 20_000);
        }
        // Too soon after the last point: not recorded.
        w.apply(Kind::Aircraft, 0, SRC, obs(1, 10.45, 50.0, 85_000), 85_000);
        let d = w.detail(Kind::Aircraft, 1).unwrap();
        assert_eq!(d.track.len(), 5);
        assert_eq!(d.track[0].time_s, 0);
        assert_eq!(d.track[4].time_s, 80);
        assert_eq!(d.fix.time_ms, 85_000);
        assert!(w.detail(Kind::Aircraft, 2).is_none());
    }
}
