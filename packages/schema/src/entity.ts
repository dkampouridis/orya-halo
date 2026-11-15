/**
 * Columnar entity data.
 *
 * Two shapes exist on purpose:
 *
 * - `EntityUpdate` is what a source plugin produces: plain struct-of-arrays in
 *   SI units, easy to fill and test.
 * - `RenderBatch` is what a worker hands to the renderer: interleaved,
 *   GPU-ready attributes. The vertex shader dead-reckons every object from
 *   its last fix, so the batch only changes when data changes, never per frame.
 */
import type { EntityKind } from "./kinds.ts";

/** Reference to one entity anywhere in the app. */
export interface EntityRef {
  readonly kind: EntityKind;
  /**
   * Stable numeric id, unique within a kind: ICAO 24-bit address, MMSI,
   * NORAD catalogue number, or a 32-bit hash of the source's own id.
   */
  readonly id: number;
}

/** Struct-of-arrays columns. Every array has exactly `count` elements. */
export interface EntityColumns {
  ids: Uint32Array;
  /** Degrees east, -180..180. */
  lon: Float32Array;
  /** Degrees north, -90..90. */
  lat: Float32Array;
  /** Metres above mean sea level. Depth is negative (earthquakes). */
  alt: Float32Array;
  /** Course over ground, degrees clockwise from true north. NaN when unknown. */
  heading: Float32Array;
  /** Ground speed in metres per second. 0 for things that do not move. */
  speed: Float32Array;
  /** Vertical rate in metres per second, positive up. */
  vrate: Float32Array;
  /** When each position was observed, Unix epoch milliseconds. */
  fixTimeMs: Float64Array;
  /** Kind-specific category code, see `AircraftCategory` and friends. */
  category: Uint8Array;
  /** `EntityFlag` bits. */
  flags: Uint8Array;
  /**
   * Kind-specific scalar: earthquake magnitude, fire radiative power (MW),
   * ship length (m), satellite orbital period (min). 0 when unused.
   */
  value: Float32Array;
}

/** Free-form static facts about an entity, shown in the detail panel. */
export interface EntityMeta {
  /** Short human label: callsign, ship name, satellite name, place. */
  label?: string;
  [key: string]: string | number | boolean | null | undefined;
}

/** A normalised batch of observations from one source. */
export interface EntityUpdate {
  kind: EntityKind;
  /** Id of the source plugin that produced it. */
  source: string;
  /** When the batch was produced, Unix epoch milliseconds. */
  timeMs: number;
  /**
   * True when the batch is the complete current set for this source: entities
   * of this kind from this source that are absent must be dropped.
   */
  full: boolean;
  count: number;
  columns: EntityColumns;
  /** Optional per-entity static facts, parallel to the columns. */
  meta?: (EntityMeta | undefined)[];
  /** Ids to drop, for incremental updates. */
  removed?: Uint32Array;
}

export function createColumns(count: number): EntityColumns {
  return {
    ids: new Uint32Array(count),
    lon: new Float32Array(count),
    lat: new Float32Array(count),
    alt: new Float32Array(count),
    heading: new Float32Array(count).fill(Number.NaN),
    speed: new Float32Array(count),
    vrate: new Float32Array(count),
    fixTimeMs: new Float64Array(count),
    category: new Uint8Array(count),
    flags: new Uint8Array(count),
    value: new Float32Array(count),
  };
}

/** Floats per entity in each interleaved `RenderBatch` attribute. */
export const POSITION_SIZE = 3;
export const MOTION_SIZE = 4;
export const BLEND_SIZE = 3;
export const STYLE_SIZE = 4;

/**
 * GPU-ready snapshot of every visible entity of one kind.
 *
 * All times are seconds relative to `epochMs`, so they keep millisecond
 * precision in 32-bit floats for sessions of any length. A new batch may use
 * a new epoch.
 */
export interface RenderBatch {
  kind: EntityKind;
  /** Increments with every batch of this kind. */
  seq: number;
  epochMs: number;
  count: number;
  /** `count` ids, index-aligned with the attributes. Used for picking. */
  ids: Uint32Array;
  /** `count * 3`: lon (deg), lat (deg), alt (m) at the fix time. */
  positions: Float32Array;
  /** `count * 4`: heading (deg, NaN unknown), speed (m/s), vrate (m/s), fix time (s). */
  motion: Float32Array;
  /**
   * `count * 3`: dLon (deg), dLat (deg), update time (s). When a new fix
   * disagrees with where the object was drawn, the difference is stored here
   * and eased to zero over `BLEND_SECONDS`, so nothing ever jumps.
   */
  blend: Float32Array;
  /**
   * `count * 4`: category, flags, value scaled to 0..255, and for aircraft
   * the 3D model id (`aircraftModelForType`, 0 when the type is not known).
   * The scale per kind: ship length / 400 m, satellite period / 1440 min,
   * earthquake magnitude / 10, fire log10(1 + MW) / 3; 0 for other kinds.
   */
  style: Uint8Array;
  /** `count` raw kind-specific scalars (magnitude, FRP, ...). */
  values: Float32Array;
}

/** ArrayBuffers of a batch, for zero-copy `postMessage` transfer. */
export function batchTransferables(batch: RenderBatch): ArrayBuffer[] {
  return [
    batch.ids.buffer,
    batch.positions.buffer,
    batch.motion.buffer,
    batch.blend.buffer,
    batch.style.buffer,
    batch.values.buffer,
  ] as ArrayBuffer[];
}

export function createRenderBatch(
  kind: EntityKind,
  count: number,
  epochMs: number,
  seq = 0,
): RenderBatch {
  return {
    kind,
    seq,
    epochMs,
    count,
    ids: new Uint32Array(count),
    positions: new Float32Array(count * POSITION_SIZE),
    motion: new Float32Array(count * MOTION_SIZE),
    blend: new Float32Array(count * BLEND_SIZE),
    style: new Uint8Array(count * STYLE_SIZE),
    values: new Float32Array(count),
  };
}

/** Seconds over which a position correction eases out. */
export const BLEND_SECONDS = 1.5;

/** Mean Earth radius in metres, as used by every dead-reckoning step. */
export const EARTH_RADIUS_M = 6_371_008.8;

/**
 * Longest time, per kind, an object is projected forward from its last fix.
 * Past this it holds position (and the renderer fades it as stale).
 */
export const MAX_EXTRAPOLATION_S: Record<EntityKind, number> = {
  1: 45,
  2: 600,
  3: 30,
  4: 0,
  5: 0,
  6: 0,
  7: 0,
};

const DEG = Math.PI / 180;

/**
 * Where entity `i` of `batch` is at `timeMs`. This is the reference
 * implementation of the dead-reckoning the vertex shader performs; the two
 * must stay in step so labels, picking and follow mode agree with the pixels.
 *
 * Writes `[lon, lat, alt]` into `out` and returns it.
 */
export function extrapolate(
  batch: RenderBatch,
  i: number,
  timeMs: number,
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  const t = (timeMs - batch.epochMs) / 1000;
  const p = i * POSITION_SIZE;
  const m = i * MOTION_SIZE;
  const b = i * BLEND_SIZE;

  let lon = batch.positions[p];
  let lat = batch.positions[p + 1];
  let alt = batch.positions[p + 2];

  const heading = batch.motion[m];
  const speed = batch.motion[m + 1];
  const vrate = batch.motion[m + 2];
  const fixT = batch.motion[m + 3];

  const maxDt = MAX_EXTRAPOLATION_S[batch.kind];
  const dt = Math.min(Math.max(t - fixT, 0), maxDt);

  if (dt > 0 && speed > 0 && !Number.isNaN(heading)) {
    const dist = speed * dt;
    const h = heading * DEG;
    const cosLat = Math.max(Math.cos(lat * DEG), 0.01);
    lat += (dist * Math.cos(h)) / EARTH_RADIUS_M / DEG;
    lon += (dist * Math.sin(h)) / (EARTH_RADIUS_M * cosLat) / DEG;
    alt += vrate * dt;
  }

  const since = t - batch.blend[b + 2];
  if (since < BLEND_SECONDS) {
    const x = Math.min(Math.max(since / BLEND_SECONDS, 0), 1);
    const k = 1 - x * x * (3 - 2 * x);
    lon += batch.blend[b] * k;
    lat += batch.blend[b + 1] * k;
  }

  if (lat > 90) lat = 90;
  else if (lat < -90) lat = -90;
  if (lon > 180) lon -= 360;
  else if (lon < -180) lon += 360;

  out[0] = lon;
  out[1] = lat;
  out[2] = alt;
  return out;
}

/** Index of `id` in a batch, or -1. Linear; fine for the one selected object. */
export function indexOfId(batch: RenderBatch, id: number): number {
  return batch.ids.indexOf(id);
}

/** FNV-1a 32-bit hash, for sources whose ids are strings. */
export function hashId(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
