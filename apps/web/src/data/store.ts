/**
 * Entity store: every entity of one kind, struct-of-arrays.
 *
 * Several sources may feed one kind (the gateway and a synthetic generator,
 * two earthquake catalogues). Each entity carries a bitmask of the sources
 * currently reporting it, so a `full` update or a `removed` list from one
 * source only drops what no other source still claims.
 *
 * The store also holds each entity's render state: the fix as the last batch
 * drew it and the blend offset in flight. It lives here, not in the batch
 * builder, so it moves with the entity on swap-remove.
 */
import type { EntityKind, EntityMeta, EntityUpdate } from "@orya-halo/schema";
import { IdMap } from "./idmap.ts";

const INITIAL_CAPACITY = 256;

/** Most sources that can feed one kind (one bit each). */
export const MAX_SOURCES_PER_KIND = 32;

/** Meta fields a person might type into search, label first. */
const SEARCH_FIELDS = ["label", "name", "callsign", "registration", "imo"] as const;

/**
 * Lower-cased searchable text of an entity: fields joined by newlines, the
 * label first. One string per entity keeps a 100k scan to one `indexOf` each.
 */
export function searchKey(meta: EntityMeta | undefined): string {
  if (!meta) return "";
  let key = "";
  let last = "";
  for (let f = 0; f < SEARCH_FIELDS.length; f++) {
    const value = meta[SEARCH_FIELDS[f]];
    if (value === undefined || value === null || value === "") continue;
    const text = String(value).trim().toLowerCase();
    if (text === "" || text === last) continue;
    key = key === "" ? text : `${key}\n${text}`;
    last = text;
  }
  return key;
}

export interface ApplyOptions {
  /**
   * Leave the `value` column of known entities alone. For feeds whose updates
   * do not carry it (gateway frames), where it is set from meta instead.
   */
  keepValue?: boolean;
}

export class EntityStore {
  readonly kind: EntityKind;
  count = 0;
  capacity = INITIAL_CAPACITY;
  /** Set by any mutation; cleared by whoever builds the next batch. */
  changed = false;

  ids = new Uint32Array(INITIAL_CAPACITY);
  lon = new Float32Array(INITIAL_CAPACITY);
  lat = new Float32Array(INITIAL_CAPACITY);
  alt = new Float32Array(INITIAL_CAPACITY);
  heading = new Float32Array(INITIAL_CAPACITY);
  speed = new Float32Array(INITIAL_CAPACITY);
  vrate = new Float32Array(INITIAL_CAPACITY);
  fixTimeMs = new Float64Array(INITIAL_CAPACITY);
  category = new Uint8Array(INITIAL_CAPACITY);
  flags = new Uint8Array(INITIAL_CAPACITY);
  value = new Float32Array(INITIAL_CAPACITY);

  /** Wall time each entity was last reported, for expiry. */
  seenMs = new Float64Array(INITIAL_CAPACITY);
  /** Bit per source currently reporting the entity. */
  sources = new Uint32Array(INITIAL_CAPACITY);
  /** Index into `sourceIds` of the source that supplied the current fix. */
  owner = new Uint8Array(INITIAL_CAPACITY);
  private stamp = new Uint32Array(INITIAL_CAPACITY);

  /** 1 when the fix changed since the last batch. */
  dirty = new Uint8Array(INITIAL_CAPACITY);
  /** 1 once the entity has appeared in a batch. */
  drawn = new Uint8Array(INITIAL_CAPACITY);
  /** The fix as the last batch drew it; valid when `drawn` and `dirty`. */
  pLon = new Float32Array(INITIAL_CAPACITY);
  pLat = new Float32Array(INITIAL_CAPACITY);
  pAlt = new Float32Array(INITIAL_CAPACITY);
  pHeading = new Float32Array(INITIAL_CAPACITY);
  pSpeed = new Float32Array(INITIAL_CAPACITY);
  pVrate = new Float32Array(INITIAL_CAPACITY);
  pFixTimeMs = new Float64Array(INITIAL_CAPACITY);
  /** Blend offset written by the last batch, and when it started. */
  bLon = new Float32Array(INITIAL_CAPACITY);
  bLat = new Float32Array(INITIAL_CAPACITY);
  bTimeMs = new Float64Array(INITIAL_CAPACITY);

  /** Static facts per entity, index-aligned. */
  meta: (EntityMeta | undefined)[] = [];
  /** `searchKey(meta)` per entity, index-aligned. Empty when there is none. */
  keys: string[] = [];

  readonly sourceIds: string[] = [];
  private readonly index = new IdMap(INITIAL_CAPACITY);
  private generation = 0;

  constructor(kind: EntityKind) {
    this.kind = kind;
  }

  /** Index of `id`, or -1. */
  indexOf(id: number): number {
    return this.index.get(id);
  }

  /** Capacity of the id map, for flatness checks. */
  get indexCapacity(): number {
    return this.index.capacity;
  }

  /** Bytes held by the typed columns (meta objects excluded). */
  get bytes(): number {
    return this.capacity * BYTES_PER_ENTITY + this.index.capacity * 8;
  }

  /** Id of the source that supplied entity `i`'s current fix. */
  ownerOf(i: number): string | undefined {
    return this.sourceIds[this.owner[i]];
  }

  private sourceIndex(source: string): number {
    let s = this.sourceIds.indexOf(source);
    if (s === -1) {
      if (this.sourceIds.length >= MAX_SOURCES_PER_KIND) {
        throw new Error(`More than ${MAX_SOURCES_PER_KIND} sources feed entity kind ${this.kind}`);
      }
      s = this.sourceIds.push(source) - 1;
    }
    return s;
  }

  /**
   * Merge one update. `nowMs` is wall time and only stamps freshness.
   * Returns how many fixes were new or changed.
   */
  apply(update: EntityUpdate, nowMs: number, options?: ApplyOptions): number {
    const src = this.sourceIndex(update.source);
    const bit = (1 << src) >>> 0;
    const keepValue = options?.keepValue === true;
    const c = update.columns;
    const metas = update.meta;
    const n = update.count;
    const gen = ++this.generation;
    let applied = 0;

    for (let i = 0; i < n; i++) {
      const id = c.ids[i];
      let idx = this.index.get(id);
      if (idx === -1) {
        idx = this.append(id);
        this.lon[idx] = c.lon[i];
        this.lat[idx] = c.lat[i];
        this.alt[idx] = c.alt[i];
        this.heading[idx] = c.heading[i];
        this.speed[idx] = c.speed[i];
        this.vrate[idx] = c.vrate[i];
        this.fixTimeMs[idx] = c.fixTimeMs[i];
        this.category[idx] = c.category[i];
        this.flags[idx] = c.flags[i];
        this.value[idx] = c.value[i];
        this.owner[idx] = src;
        this.sources[idx] = bit;
        applied++;
      } else {
        this.sources[idx] |= bit;
        const t = c.fixTimeMs[i];
        // Between sources the newest fix wins (a tie goes to the arriving
        // update). A source may always revise what it reported itself, even
        // backwards in time: that is how a clock-driven source replays.
        if (t >= this.fixTimeMs[idx] || this.owner[idx] === src) {
          const heading = c.heading[i];
          const current = this.heading[idx];
          const moved =
            t !== this.fixTimeMs[idx] ||
            c.lon[i] !== this.lon[idx] ||
            c.lat[i] !== this.lat[idx] ||
            c.alt[i] !== this.alt[idx] ||
            c.speed[i] !== this.speed[idx] ||
            c.vrate[i] !== this.vrate[idx] ||
            (heading !== current && !(heading !== heading && current !== current));
          if (moved) {
            if (this.dirty[idx] === 0) this.savePrevious(idx);
            this.lon[idx] = c.lon[i];
            this.lat[idx] = c.lat[i];
            this.alt[idx] = c.alt[i];
            this.heading[idx] = heading;
            this.speed[idx] = c.speed[i];
            this.vrate[idx] = c.vrate[i];
            this.fixTimeMs[idx] = t;
            this.owner[idx] = src;
            this.dirty[idx] = 1;
            this.changed = true;
            applied++;
          }
          if (c.category[i] !== this.category[idx] || c.flags[i] !== this.flags[idx]) {
            this.category[idx] = c.category[i];
            this.flags[idx] = c.flags[i];
            this.changed = true;
          }
          if (!keepValue && c.value[i] !== this.value[idx]) {
            this.value[idx] = c.value[i];
            this.changed = true;
          }
        }
      }
      this.seenMs[idx] = nowMs;
      this.stamp[idx] = gen;
      if (metas !== undefined) {
        const m = metas[i];
        if (m !== undefined) this.mergeMetaAt(idx, m);
      }
    }

    const removed = update.removed;
    if (removed !== undefined) {
      for (let i = 0; i < removed.length; i++) {
        const idx = this.index.get(removed[i]);
        if (idx !== -1) this.release(idx, bit);
      }
    }

    if (update.full) {
      // Backwards, so the entity swapped into a freed index was already visited.
      for (let idx = this.count - 1; idx >= 0; idx--) {
        if ((this.sources[idx] & bit) !== 0 && this.stamp[idx] !== gen) this.release(idx, bit);
      }
    }
    return applied;
  }

  /** Drop ids reported gone by `source`. Entities another source still reports stay. */
  removeIds(ids: ArrayLike<number>, source: string): void {
    const s = this.sourceIds.indexOf(source);
    if (s === -1) return;
    const bit = (1 << s) >>> 0;
    for (let i = 0; i < ids.length; i++) {
      const idx = this.index.get(ids[i]);
      if (idx !== -1) this.release(idx, bit);
    }
  }

  /** Drop everything only `source` was reporting (layer switched off, feed lost). */
  removeSource(source: string): void {
    const s = this.sourceIds.indexOf(source);
    if (s === -1) return;
    const bit = (1 << s) >>> 0;
    for (let idx = this.count - 1; idx >= 0; idx--) {
      if ((this.sources[idx] & bit) !== 0) this.release(idx, bit);
    }
  }

  /** Drop entities not reported for `ttlMs`. Returns how many went. */
  expire(nowMs: number, ttlMs: number): number {
    if (ttlMs <= 0) return 0;
    const cutoff = nowMs - ttlMs;
    let removed = 0;
    for (let idx = this.count - 1; idx >= 0; idx--) {
      if (this.seenMs[idx] < cutoff) {
        this.removeAt(idx);
        removed++;
      }
    }
    return removed;
  }

  /** Merge static facts into an entity. Returns false when the id is unknown. */
  mergeMeta(id: number, meta: EntityMeta): boolean {
    const idx = this.index.get(id);
    if (idx === -1) return false;
    this.mergeMetaAt(idx, meta);
    return true;
  }

  /** Set the kind-specific scalar of one entity (ship length from meta). */
  setValue(id: number, value: number): void {
    const idx = this.index.get(id);
    if (idx === -1 || this.value[idx] === value) return;
    this.value[idx] = value;
    this.changed = true;
  }

  /** Forget what the renderer was last shown, so the next batch starts clean. */
  resetDrawn(): void {
    this.drawn.fill(0, 0, this.count);
    this.dirty.fill(1, 0, this.count);
    this.changed = true;
  }

  clear(): void {
    for (let i = 0; i < this.count; i++) {
      this.meta[i] = undefined;
      this.keys[i] = "";
    }
    if (this.count > 0) this.changed = true;
    this.count = 0;
    this.index.clear();
  }

  private mergeMetaAt(idx: number, incoming: EntityMeta): void {
    const existing = this.meta[idx];
    // Compute sources hand back the same object on every pass.
    if (existing === incoming) return;
    if (existing === undefined) {
      this.meta[idx] = incoming;
      this.keys[idx] = searchKey(incoming);
      return;
    }
    let touched = false;
    for (const key in incoming) {
      const value = incoming[key];
      if (value !== undefined && existing[key] !== value) {
        existing[key] = value;
        touched = true;
      }
    }
    if (touched) this.keys[idx] = searchKey(existing);
  }

  private savePrevious(idx: number): void {
    this.pLon[idx] = this.lon[idx];
    this.pLat[idx] = this.lat[idx];
    this.pAlt[idx] = this.alt[idx];
    this.pHeading[idx] = this.heading[idx];
    this.pSpeed[idx] = this.speed[idx];
    this.pVrate[idx] = this.vrate[idx];
    this.pFixTimeMs[idx] = this.fixTimeMs[idx];
  }

  private append(id: number): number {
    if (this.count === this.capacity) this.grow();
    const idx = this.count++;
    this.ids[idx] = id;
    this.index.set(id, idx);
    this.dirty[idx] = 1;
    this.drawn[idx] = 0;
    this.bLon[idx] = 0;
    this.bLat[idx] = 0;
    this.bTimeMs[idx] = 0;
    this.meta[idx] = undefined;
    this.keys[idx] = "";
    this.changed = true;
    return idx;
  }

  /** Clear one source's claim; remove the entity when nobody reports it. */
  private release(idx: number, bit: number): void {
    const left = (this.sources[idx] & ~bit) >>> 0;
    if (left === 0) this.removeAt(idx);
    else this.sources[idx] = left;
  }

  private removeAt(idx: number): void {
    const last = this.count - 1;
    this.index.delete(this.ids[idx]);
    if (idx !== last) {
      this.ids[idx] = this.ids[last];
      this.lon[idx] = this.lon[last];
      this.lat[idx] = this.lat[last];
      this.alt[idx] = this.alt[last];
      this.heading[idx] = this.heading[last];
      this.speed[idx] = this.speed[last];
      this.vrate[idx] = this.vrate[last];
      this.fixTimeMs[idx] = this.fixTimeMs[last];
      this.category[idx] = this.category[last];
      this.flags[idx] = this.flags[last];
      this.value[idx] = this.value[last];
      this.seenMs[idx] = this.seenMs[last];
      this.sources[idx] = this.sources[last];
      this.owner[idx] = this.owner[last];
      this.stamp[idx] = this.stamp[last];
      this.dirty[idx] = this.dirty[last];
      this.drawn[idx] = this.drawn[last];
      this.pLon[idx] = this.pLon[last];
      this.pLat[idx] = this.pLat[last];
      this.pAlt[idx] = this.pAlt[last];
      this.pHeading[idx] = this.pHeading[last];
      this.pSpeed[idx] = this.pSpeed[last];
      this.pVrate[idx] = this.pVrate[last];
      this.pFixTimeMs[idx] = this.pFixTimeMs[last];
      this.bLon[idx] = this.bLon[last];
      this.bLat[idx] = this.bLat[last];
      this.bTimeMs[idx] = this.bTimeMs[last];
      this.meta[idx] = this.meta[last];
      this.keys[idx] = this.keys[last];
      this.index.set(this.ids[idx], idx);
    }
    this.meta[last] = undefined;
    this.keys[last] = "";
    this.count = last;
    this.changed = true;
  }

  private grow(): void {
    const capacity = this.capacity * 2;
    this.ids = grown(this.ids, new Uint32Array(capacity));
    this.lon = grown(this.lon, new Float32Array(capacity));
    this.lat = grown(this.lat, new Float32Array(capacity));
    this.alt = grown(this.alt, new Float32Array(capacity));
    this.heading = grown(this.heading, new Float32Array(capacity));
    this.speed = grown(this.speed, new Float32Array(capacity));
    this.vrate = grown(this.vrate, new Float32Array(capacity));
    this.fixTimeMs = grown(this.fixTimeMs, new Float64Array(capacity));
    this.category = grown(this.category, new Uint8Array(capacity));
    this.flags = grown(this.flags, new Uint8Array(capacity));
    this.value = grown(this.value, new Float32Array(capacity));
    this.seenMs = grown(this.seenMs, new Float64Array(capacity));
    this.sources = grown(this.sources, new Uint32Array(capacity));
    this.owner = grown(this.owner, new Uint8Array(capacity));
    this.stamp = grown(this.stamp, new Uint32Array(capacity));
    this.dirty = grown(this.dirty, new Uint8Array(capacity));
    this.drawn = grown(this.drawn, new Uint8Array(capacity));
    this.pLon = grown(this.pLon, new Float32Array(capacity));
    this.pLat = grown(this.pLat, new Float32Array(capacity));
    this.pAlt = grown(this.pAlt, new Float32Array(capacity));
    this.pHeading = grown(this.pHeading, new Float32Array(capacity));
    this.pSpeed = grown(this.pSpeed, new Float32Array(capacity));
    this.pVrate = grown(this.pVrate, new Float32Array(capacity));
    this.pFixTimeMs = grown(this.pFixTimeMs, new Float64Array(capacity));
    this.bLon = grown(this.bLon, new Float32Array(capacity));
    this.bLat = grown(this.bLat, new Float32Array(capacity));
    this.bTimeMs = grown(this.bTimeMs, new Float64Array(capacity));
    this.capacity = capacity;
  }
}

/** Typed-column bytes per entity slot: see the field list above. */
const BYTES_PER_ENTITY =
  4 + // ids
  7 * 4 + // lon lat alt heading speed vrate value
  8 + // fixTimeMs
  2 + // category flags
  8 + // seenMs
  4 + // sources
  1 + // owner
  4 + // stamp
  2 + // dirty drawn
  6 * 4 + // previous fix
  8 + // previous fix time
  2 * 4 + // blend offset
  8; // blend time

interface Settable<T> {
  set(source: T): void;
}

function grown<T extends Settable<T>>(from: T, to: T): T {
  to.set(from);
  return to;
}
