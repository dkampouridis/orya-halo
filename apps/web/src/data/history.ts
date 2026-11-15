/**
 * History ring: fixed-memory keyframes behind the time scrubber.
 *
 * Each moving kind gets one ring. Every entity owns a *slot*; a keyframe is a
 * dense array over slots, so two keyframes line up by index and no ids are
 * stored per record. A record is quantised to 8 bytes (10 with altitude):
 *
 *   word 0: longitude, 24 bits (2.4 m at the equator) | heading, 8 bits (1.4 deg)
 *   word 1: latitude, 24 bits (1.2 m)                 | speed, 8 bits (per-kind unit)
 *   alt:    int16 metres, only for kinds that fly
 *
 * Memory is `frames x slots x record` and is capped by a byte budget per
 * kind (see `HISTORY_PROFILES`): 28 MB for aircraft plus 20 MB for ships is
 * the 48 MB total. At the default 30 minutes that is 91 aircraft keyframes
 * 20 s apart for up to ~30,000 slots, and 31 ship keyframes 60 s apart for up
 * to ~66,000 slots, so 20,000 aircraft and 50,000 ships fit with room for the
 * objects that came and went inside the window. When the budget is reached
 * the ring recycles the slot of whichever departed object left longest ago;
 * if every slot is live, further objects are simply not recorded.
 */
import {
  BLEND_SIZE,
  EARTH_RADIUS_M,
  EntityKind,
  MAX_EXTRAPOLATION_S,
  MOTION_SIZE,
  POSITION_SIZE,
  STYLE_SIZE,
  createRenderBatch,
} from "@orya-halo/schema";
import type { RenderBatch } from "@orya-halo/schema";
import { styleValue } from "./batch.ts";
import { IdMap } from "./idmap.ts";
import type { EntityStore } from "./store.ts";

export interface HistoryProfile {
  /** Milliseconds between keyframes. Stretched if the window would not fit the budget. */
  intervalMs: number;
  /** Hard cap on the ring's memory, bytes. */
  budgetBytes: number;
  /** Record altitude (2 more bytes per record). */
  hasAlt: boolean;
  /** Metres per second per unit of the 8-bit speed. */
  speedUnit: number;
}

const MB = 1024 * 1024;

/** The moving kinds that are recorded, and what each may spend. */
export const HISTORY_PROFILES: Partial<Record<EntityKind, HistoryProfile>> = {
  [EntityKind.Aircraft]: { intervalMs: 20_000, budgetBytes: 28 * MB, hasAlt: true, speedUnit: 1.5 },
  [EntityKind.Ship]: { intervalMs: 60_000, budgetBytes: 20 * MB, hasAlt: false, speedUnit: 0.2 },
};

const LON_STEPS = 0xffffff;
/** One less than the lon range: the all-ones latitude marks an empty record. */
const LAT_STEPS = 0xfffffe;
const ABSENT = 0xffffffff;
const HEADING_UNKNOWN = 255;
/** Bookkeeping bytes per slot outside the keyframes (ids, times, free queue, id map). */
const SLOT_OVERHEAD_BYTES = 68;
const MIN_SLOTS = 4096;
const GROW_SLOTS = 4096;
const DEG = Math.PI / 180;
const NO_BLEND_S = -1e6;

export interface TrackPoints {
  count: number;
  /** lon, lat, alt triples. */
  positions: Float32Array;
  timesMs: Float64Array;
}

export class HistoryRing {
  readonly kind: EntityKind;
  /** Keyframes held. */
  readonly frames: number;
  /** Actual spacing, after any stretch to fit the budget. */
  readonly intervalMs: number;
  /** Most slots the budget allows. */
  readonly maxSlots: number;
  /** Entities that could not be recorded because every slot was live. */
  dropped = 0;

  private readonly hasAlt: boolean;
  private readonly speedUnit: number;
  private readonly recordBytes: number;
  private readonly windowMs: number;

  private capacity: number;
  private w0: Uint32Array;
  private w1: Uint32Array;
  private alt: Int16Array | null;
  private readonly times: Float64Array;
  private head = 0;
  private filled = 0;

  private slotId: Uint32Array;
  private slotBorn: Float64Array;
  private slotDied: Float64Array;
  private slotSeen: Uint32Array;
  private slotLive: Uint8Array;
  private slotCategory: Uint8Array;
  private slotFlags: Uint8Array;
  private slotValue: Float32Array;
  /** FIFO of released slots, oldest departure first. */
  private freeQueue: Int32Array;
  private freeHead = 0;
  private freeCount = 0;
  private used = 0;
  private readonly map: IdMap;
  private generation = 0;

  constructor(
    kind: EntityKind,
    historyMs: number,
    profile: HistoryProfile,
    initialSlots = MIN_SLOTS,
  ) {
    this.kind = kind;
    this.hasAlt = profile.hasAlt;
    this.speedUnit = profile.speedUnit;
    this.recordBytes = 8 + (profile.hasAlt ? 2 : 0);
    this.windowMs = historyMs;

    // A longer window keeps the same budget by spacing keyframes further apart.
    let intervalMs = profile.intervalMs;
    let frames = Math.ceil(historyMs / intervalMs) + 1;
    while (this.slotsFor(profile.budgetBytes, frames) < MIN_SLOTS && frames > 2) {
      intervalMs *= 2;
      frames = Math.ceil(historyMs / intervalMs) + 1;
    }
    this.intervalMs = intervalMs;
    this.frames = frames;
    this.maxSlots = this.slotsFor(profile.budgetBytes, frames);
    this.capacity = Math.max(1, Math.min(initialSlots, this.maxSlots));

    this.w0 = new Uint32Array(frames * this.capacity);
    this.w1 = new Uint32Array(frames * this.capacity).fill(ABSENT);
    this.alt = this.hasAlt ? new Int16Array(frames * this.capacity) : null;
    this.times = new Float64Array(frames);
    this.slotId = new Uint32Array(this.capacity);
    this.slotBorn = new Float64Array(this.capacity);
    this.slotDied = new Float64Array(this.capacity);
    this.slotSeen = new Uint32Array(this.capacity);
    this.slotLive = new Uint8Array(this.capacity);
    this.slotCategory = new Uint8Array(this.capacity);
    this.slotFlags = new Uint8Array(this.capacity);
    this.slotValue = new Float32Array(this.capacity);
    this.freeQueue = new Int32Array(this.capacity);
    this.map = new IdMap(this.capacity);
  }

  private slotsFor(budgetBytes: number, frames: number): number {
    return Math.floor(budgetBytes / (frames * this.recordBytes + SLOT_OVERHEAD_BYTES));
  }

  /** Bytes currently allocated, measured. Never exceeds the profile's budget. */
  get bytes(): number {
    return (
      this.w0.byteLength +
      this.w1.byteLength +
      (this.alt ? this.alt.byteLength : 0) +
      this.times.byteLength +
      this.slotId.byteLength +
      this.slotBorn.byteLength +
      this.slotDied.byteLength +
      this.slotSeen.byteLength +
      this.slotLive.byteLength +
      this.slotCategory.byteLength +
      this.slotFlags.byteLength +
      this.slotValue.byteLength +
      this.freeQueue.byteLength +
      this.map.capacity * 8
    );
  }

  get slots(): number {
    return this.capacity;
  }

  get keyframes(): number {
    return this.filled;
  }

  /** Recorded span, or null before the first keyframe. */
  range(): { fromMs: number; toMs: number } | null {
    if (this.filled === 0) return null;
    return { fromMs: this.times[this.frameAt(0)], toMs: this.times[this.frameAt(this.filled - 1)] };
  }

  clear(): void {
    this.head = 0;
    this.filled = 0;
    this.used = 0;
    this.freeHead = 0;
    this.freeCount = 0;
    this.slotLive.fill(0);
    this.map.clear();
    this.w1.fill(ABSENT);
  }

  /** Frame index of the `i`th oldest keyframe. */
  private frameAt(i: number): number {
    return (this.head - this.filled + i + this.frames * 2) % this.frames;
  }

  /**
   * Write one keyframe: every entity in `store`, dead-reckoned to `timeMs`.
   * An empty store still writes a frame, so gaps replay as gaps.
   */
  record(store: EntityStore, timeMs: number): void {
    const n = store.count;
    const gen = ++this.generation;

    // Pass 1: note who is present, so departed slots are freed before anyone
    // new needs one.
    let missing = 0;
    for (let i = 0; i < n; i++) {
      const s = this.map.get(store.ids[i]);
      if (s !== -1) this.slotSeen[s] = gen;
      else missing++;
    }
    for (let s = 0; s < this.used; s++) {
      if (this.slotLive[s] === 1 && this.slotSeen[s] !== gen) {
        this.slotLive[s] = 0;
        this.slotDied[s] = timeMs;
        this.map.delete(this.slotId[s]);
        this.freeQueue[(this.freeHead + this.freeCount) % this.capacity] = s;
        this.freeCount++;
      }
    }
    if (missing > 0) {
      // Grow once for everyone who needs a slot, not once per newcomer. Freed
      // slots whose records have aged out are free to reuse and need no room.
      const cutoff = timeMs - this.windowMs - this.intervalMs;
      let reusable = 0;
      while (
        reusable < this.freeCount &&
        reusable < missing &&
        this.slotDied[this.freeQueue[(this.freeHead + reusable) % this.capacity]] < cutoff
      ) {
        reusable++;
      }
      const needed = this.used + missing - reusable;
      if (needed > this.capacity && this.capacity < this.maxSlots) {
        this.grow(Math.min(this.maxSlots, Math.ceil(needed / GROW_SLOTS) * GROW_SLOTS));
      }
      for (let i = 0; i < n; i++) {
        if (this.map.get(store.ids[i]) === -1) this.allocate(store.ids[i], timeMs, gen);
      }
    }

    // Pass 2: write the frame. Capacity is settled now, so offsets are stable.
    // Slots are looked up again rather than remembered: a scratch array sized
    // by the store would sit outside the byte budget.
    const frame = this.head;
    const base = frame * this.capacity;
    const w0 = this.w0;
    const w1 = this.w1;
    const alt = this.alt;
    w1.fill(ABSENT, base, base + this.capacity);
    const maxDt = MAX_EXTRAPOLATION_S[this.kind];
    const speedUnit = this.speedUnit;

    for (let i = 0; i < n; i++) {
      const s = this.map.get(store.ids[i]);
      if (s === -1) continue;
      let lon = store.lon[i];
      let lat = store.lat[i];
      let z = store.alt[i];
      const heading = store.heading[i];
      const speed = store.speed[i];
      let dt = (timeMs - store.fixTimeMs[i]) / 1000;
      if (dt > maxDt) dt = maxDt;
      if (dt > 0 && speed > 0 && heading === heading) {
        const dist = speed * dt;
        const h = heading * DEG;
        const cosLat = Math.max(Math.cos(lat * DEG), 0.01);
        lat += (dist * Math.cos(h)) / EARTH_RADIUS_M / DEG;
        lon += (dist * Math.sin(h)) / (EARTH_RADIUS_M * cosLat) / DEG;
        z += store.vrate[i] * dt;
      }
      if (lat > 90) lat = 90;
      else if (lat < -90) lat = -90;
      if (lon >= 180) lon -= 360;
      else if (lon < -180) lon += 360;

      const lonQ = Math.min(LON_STEPS, Math.max(0, Math.round(((lon + 180) / 360) * LON_STEPS)));
      const latQ = Math.min(LAT_STEPS, Math.max(0, Math.round(((lat + 90) / 180) * LAT_STEPS)));
      const headingQ =
        heading === heading
          ? Math.round((((heading % 360) + 360) % 360) * (255 / 360)) % 255
          : HEADING_UNKNOWN;
      const speedQ = Math.min(255, Math.round(speed / speedUnit));
      w0[base + s] = ((lonQ << 8) | headingQ) >>> 0;
      w1[base + s] = ((latQ << 8) | speedQ) >>> 0;
      if (alt !== null) alt[base + s] = Math.max(-32768, Math.min(32767, Math.round(z)));
      this.slotCategory[s] = store.category[i];
      this.slotFlags[s] = store.flags[i];
      this.slotValue[s] = store.value[i];
    }

    this.times[frame] = timeMs;
    this.head = (this.head + 1) % this.frames;
    if (this.filled < this.frames) this.filled++;
  }

  private allocate(id: number, timeMs: number, gen: number): number {
    let s = -1;
    if (
      this.freeCount > 0 &&
      this.slotDied[this.freeQueue[this.freeHead]] < timeMs - this.windowMs - this.intervalMs
    ) {
      // Its records have all aged out of the ring: reuse costs nothing.
      s = this.popFree();
    } else if (this.used < this.capacity) {
      s = this.used++;
    } else if (this.capacity < this.maxSlots) {
      this.grow(Math.min(this.maxSlots, this.capacity + GROW_SLOTS));
      s = this.used++;
    } else if (this.freeCount > 0) {
      // Over budget: the object that left longest ago loses its history.
      s = this.popFree();
    } else {
      this.dropped++;
      return -1;
    }
    this.slotId[s] = id;
    this.slotBorn[s] = timeMs;
    this.slotLive[s] = 1;
    this.slotSeen[s] = gen;
    this.map.set(id, s);
    return s;
  }

  private popFree(): number {
    const s = this.freeQueue[this.freeHead];
    this.freeHead = (this.freeHead + 1) % this.capacity;
    this.freeCount--;
    return s;
  }

  private grow(capacity: number): void {
    const old = this.capacity;
    const frames = this.frames;
    const w0 = new Uint32Array(frames * capacity);
    const w1 = new Uint32Array(frames * capacity).fill(ABSENT);
    const alt = this.alt ? new Int16Array(frames * capacity) : null;
    for (let f = 0; f < frames; f++) {
      w0.set(this.w0.subarray(f * old, f * old + old), f * capacity);
      w1.set(this.w1.subarray(f * old, f * old + old), f * capacity);
      if (alt && this.alt) alt.set(this.alt.subarray(f * old, f * old + old), f * capacity);
    }
    this.w0 = w0;
    this.w1 = w1;
    this.alt = alt;

    const slotId = new Uint32Array(capacity);
    slotId.set(this.slotId);
    this.slotId = slotId;
    const slotBorn = new Float64Array(capacity);
    slotBorn.set(this.slotBorn);
    this.slotBorn = slotBorn;
    const slotDied = new Float64Array(capacity);
    slotDied.set(this.slotDied);
    this.slotDied = slotDied;
    const slotSeen = new Uint32Array(capacity);
    slotSeen.set(this.slotSeen);
    this.slotSeen = slotSeen;
    const slotLive = new Uint8Array(capacity);
    slotLive.set(this.slotLive);
    this.slotLive = slotLive;
    const slotCategory = new Uint8Array(capacity);
    slotCategory.set(this.slotCategory);
    this.slotCategory = slotCategory;
    const slotFlags = new Uint8Array(capacity);
    slotFlags.set(this.slotFlags);
    this.slotFlags = slotFlags;
    const slotValue = new Float32Array(capacity);
    slotValue.set(this.slotValue);
    this.slotValue = slotValue;

    // Unroll the queue so its order survives the new modulus.
    const freeQueue = new Int32Array(capacity);
    for (let i = 0; i < this.freeCount; i++)
      freeQueue[i] = this.freeQueue[(this.freeHead + i) % old];
    this.freeQueue = freeQueue;
    this.freeHead = 0;
    this.capacity = capacity;
  }

  /**
   * Indexes (0 = oldest) of the keyframes around `timeMs`: the latest at or
   * before it, and the one after (or -1 past the newest keyframe).
   */
  private bracket(timeMs: number): [number, number] {
    let lo = 0;
    let hi = this.filled - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.times[this.frameAt(mid)] <= timeMs) lo = mid;
      else hi = mid - 1;
    }
    return [lo, lo + 1 < this.filled ? lo + 1 : -1];
  }

  /**
   * Rebuild the kind as it was at `timeMs`: positions interpolated between
   * the surrounding keyframes, with heading and speed so the renderer can
   * draw tails and keep moving if it plays on. Returns null with no history.
   */
  reconstruct(timeMs: number, seq: number): RenderBatch | null {
    if (this.filled === 0) return null;
    const [i0, i1] = this.bracket(timeMs);
    const f0 = this.frameAt(i0);
    const t0 = this.times[f0];
    const base0 = f0 * this.capacity;
    const f1 = i1 === -1 ? -1 : this.frameAt(i1);
    const t1 = f1 === -1 ? 0 : this.times[f1];
    const base1 = f1 === -1 ? 0 : f1 * this.capacity;
    const w0 = this.w0;
    const w1 = this.w1;
    const alt = this.alt;
    const used = this.used;

    let count = 0;
    for (let s = 0; s < used; s++) {
      if (w1[base0 + s] >>> 8 !== 0xffffff && this.slotBorn[s] <= t0) count++;
    }

    const epochMs = Math.floor(timeMs);
    const batch = createRenderBatch(this.kind, count, epochMs, seq);
    const { ids, positions, motion, blend, style, values } = batch;
    const fraction = f1 === -1 ? 0 : Math.min(Math.max((timeMs - t0) / (t1 - t0), 0), 1);
    const sinceS = Math.min(Math.max((timeMs - t0) / 1000, 0), MAX_EXTRAPOLATION_S[this.kind]);
    const speedUnit = this.speedUnit;
    const kind = this.kind;
    const fixS = (timeMs - epochMs) / 1000;

    let j = 0;
    for (let s = 0; s < used; s++) {
      const b0 = w1[base0 + s];
      if (b0 >>> 8 === 0xffffff || this.slotBorn[s] > t0) continue;
      const a0 = w0[base0 + s];
      let lon = ((a0 >>> 8) / LON_STEPS) * 360 - 180;
      let lat = ((b0 >>> 8) / LAT_STEPS) * 180 - 90;
      let z = alt !== null ? alt[base0 + s] : 0;
      const headingQ = a0 & 0xff;
      const heading = headingQ === HEADING_UNKNOWN ? Number.NaN : headingQ * (360 / 255);
      const speed = (b0 & 0xff) * speedUnit;

      const b1 = f1 === -1 ? ABSENT : w1[base1 + s];
      if (b1 >>> 8 !== 0xffffff) {
        const a1 = w0[base1 + s];
        let dLon = ((a1 >>> 8) / LON_STEPS) * 360 - 180 - lon;
        if (dLon > 180) dLon -= 360;
        else if (dLon < -180) dLon += 360;
        lon += dLon * fraction;
        lat += (((b1 >>> 8) / LAT_STEPS) * 180 - 90 - lat) * fraction;
        if (alt !== null) z += (alt[base1 + s] - z) * fraction;
      } else if (sinceS > 0 && speed > 0 && heading === heading) {
        // Gone by the next keyframe (or there is none yet): coast on the
        // recorded course, as the live view would have.
        const dist = speed * sinceS;
        const h = heading * DEG;
        const cosLat = Math.max(Math.cos(lat * DEG), 0.01);
        lat += (dist * Math.cos(h)) / EARTH_RADIUS_M / DEG;
        lon += (dist * Math.sin(h)) / (EARTH_RADIUS_M * cosLat) / DEG;
      }
      if (lat > 90) lat = 90;
      else if (lat < -90) lat = -90;
      if (lon > 180) lon -= 360;
      else if (lon < -180) lon += 360;

      ids[j] = this.slotId[s];
      const p = j * POSITION_SIZE;
      positions[p] = lon;
      positions[p + 1] = lat;
      positions[p + 2] = z;
      const m = j * MOTION_SIZE;
      motion[m] = heading;
      motion[m + 1] = speed;
      motion[m + 2] = 0;
      motion[m + 3] = fixS;
      blend[j * BLEND_SIZE + 2] = NO_BLEND_S;
      const o = j * STYLE_SIZE;
      style[o] = this.slotCategory[s];
      style[o + 1] = this.slotFlags[s];
      style[o + 2] = styleValue(kind, this.slotValue[s]);
      values[j] = this.slotValue[s];
      j++;
    }
    return batch;
  }

  /** Every recorded position of one entity, oldest first. */
  track(id: number): TrackPoints {
    const positions = new Float32Array(this.filled * 3);
    const timesMs = new Float64Array(this.filled);
    let count = 0;
    // An entity that left and came back may own more than one slot.
    const owned: number[] = [];
    for (let s = 0; s < this.used; s++) if (this.slotId[s] === id) owned.push(s);
    if (owned.length === 0) return { count, positions, timesMs };
    for (let i = 0; i < this.filled; i++) {
      const frame = this.frameAt(i);
      const t = this.times[frame];
      const base = frame * this.capacity;
      for (const s of owned) {
        if (this.slotBorn[s] > t) continue;
        const b = this.w1[base + s];
        if (b >>> 8 === 0xffffff) continue;
        positions[count * 3] = ((this.w0[base + s] >>> 8) / LON_STEPS) * 360 - 180;
        positions[count * 3 + 1] = ((b >>> 8) / LAT_STEPS) * 180 - 90;
        positions[count * 3 + 2] = this.alt !== null ? this.alt[base + s] : 0;
        timesMs[count] = t;
        count++;
        break;
      }
    }
    return { count, positions, timesMs };
  }
}
