/**
 * Synthetic traffic: aircraft-like and ship-like movers all over the world,
 * for load testing with no network.
 *
 * Each "fetch" advances a random subset of the fleet along its course and
 * reports only that subset, the way a real feed trickles in. Now and then,
 * and whenever polling was interrupted, it reports the whole fleet instead,
 * so a store that was emptied in between fills up again at once.
 */
import {
  aircraftModelForType,
  AircraftCategory,
  EARTH_RADIUS_M,
  EntityKind,
  ShipCategory,
  createColumns,
  defineSource,
} from "@orya-halo/schema";
import type { EntityMeta, EntityUpdate, SourcePlugin } from "@orya-halo/schema";

/** Plausible types for synthetic aircraft, by ADS-B category, so close in they draw as real models. */
const SYNTHETIC_TYPES: Partial<Record<number, readonly string[]>> = {
  [AircraftCategory.Heavy]: ["B77W", "A359", "B789", "A333", "B744", "A388"],
  [AircraftCategory.Large]: ["A20N", "A320", "B738", "B38M", "A321", "E190", "BCS3", "CRJ9"],
  [AircraftCategory.Light]: ["C172", "P28A", "SR22", "EC35", "PC12", "AT76", "DH8D"],
};

export const SYNTHETIC_AIRCRAFT_ID = "synthetic-aircraft";
export const SYNTHETIC_SHIPS_ID = "synthetic-ships";

interface Fleet {
  kind: EntityKind;
  count: number;
  ids: Uint32Array;
  lon: Float64Array;
  lat: Float64Array;
  alt: Float32Array;
  heading: Float32Array;
  speed: Float32Array;
  vrate: Float32Array;
  fixTimeMs: Float64Array;
  category: Uint8Array;
  meta: EntityMeta[];
  random: () => number;
  /** Indexes the next `normalise` reports, when it is not the whole fleet. */
  pending: Uint32Array;
  pendingCount: number;
  /** The next `normalise` reports everyone. */
  full: boolean;
  polls: number;
  timeMs: number;
}

const DEG = Math.PI / 180;
/** Every this many polls the whole fleet is reported, not a subset. */
const FULL_EVERY = 30;
/** Longer than this between polls counts as an interruption. */
const GAP_MS = 2500;

/** Small seeded generator (mulberry32), so a load test is repeatable. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createFleet(kind: EntityKind, count: number, seed: number, nowMs: number): Fleet {
  const random = seededRandom(seed);
  const aircraft = kind === EntityKind.Aircraft;
  const fleet: Fleet = {
    kind,
    count,
    ids: new Uint32Array(count),
    lon: new Float64Array(count),
    lat: new Float64Array(count),
    alt: new Float32Array(count),
    heading: new Float32Array(count),
    speed: new Float32Array(count),
    vrate: new Float32Array(count),
    fixTimeMs: new Float64Array(count).fill(nowMs),
    category: new Uint8Array(count),
    meta: [],
    random,
    pending: new Uint32Array(count),
    pendingCount: 0,
    full: true,
    polls: 0,
    timeMs: nowMs,
  };
  for (let i = 0; i < count; i++) {
    // Ids sit in ranges no real ICAO address or MMSI uses.
    fleet.ids[i] = aircraft ? 0xf00000 + i : 990_000_000 + i;
    fleet.lon[i] = random() * 360 - 180;
    // Uniform over the sphere's area, kept off the poles.
    fleet.lat[i] = Math.asin(random() * 1.8 - 0.9) / DEG;
    fleet.heading[i] = random() * 360;
    if (aircraft) {
      const cruising = random() < 0.85;
      fleet.speed[i] = cruising ? 200 + random() * 60 : 60 + random() * 90;
      fleet.alt[i] = cruising ? 9000 + random() * 3500 : 500 + random() * 4000;
      fleet.vrate[i] = cruising ? 0 : (random() - 0.5) * 16;
      fleet.category[i] = cruising
        ? random() < 0.3
          ? AircraftCategory.Heavy
          : AircraftCategory.Large
        : AircraftCategory.Light;
      const types = SYNTHETIC_TYPES[fleet.category[i]] ?? ["A320"];
      fleet.meta.push({
        label: `SYN${String(1000 + (i % 9000))}`,
        registration: `X-${i.toString(36).toUpperCase()}`,
        typeName: "Synthetic aircraft",
        typeCode: types[Math.floor(random() * types.length)],
      });
    } else {
      fleet.speed[i] = random() < 0.2 ? 0 : 3 + random() * 9;
      fleet.category[i] = 1 + Math.floor(random() * (ShipCategory.Other - 1));
      fleet.meta.push({
        label: `Synthetic ${i + 1}`,
        typeName: "Synthetic vessel",
        lengthM: Math.round(40 + random() * 300),
      });
    }
  }
  return fleet;
}

/** Move entity `i` along its course to `nowMs` and give it a slightly new course. */
function advance(fleet: Fleet, i: number, nowMs: number): void {
  const dt = (nowMs - fleet.fixTimeMs[i]) / 1000;
  if (dt <= 0) return;
  const dist = fleet.speed[i] * dt;
  const h = fleet.heading[i] * DEG;
  let lat = fleet.lat[i];
  let lon = fleet.lon[i];
  const cosLat = Math.max(Math.cos(lat * DEG), 0.01);
  lat += (dist * Math.cos(h)) / EARTH_RADIUS_M / DEG;
  lon += (dist * Math.sin(h)) / (EARTH_RADIUS_M * cosLat) / DEG;
  let heading = fleet.heading[i] + (fleet.random() - 0.5) * 6;
  // Turn back before the poles, where a constant heading stops meaning anything.
  if (lat > 75 || lat < -75) {
    heading = 180 - heading;
    lat = lat > 75 ? 75 : -75;
  }
  if (lon > 180) lon -= 360;
  else if (lon < -180) lon += 360;
  fleet.lat[i] = lat;
  fleet.lon[i] = lon;
  fleet.heading[i] = ((heading % 360) + 360) % 360;
  if (fleet.kind === EntityKind.Aircraft) {
    fleet.alt[i] = Math.min(13_000, Math.max(300, fleet.alt[i] + fleet.vrate[i] * dt));
  }
  fleet.fixTimeMs[i] = nowMs;
}

function normaliseFleet(fleet: Fleet, source: string): EntityUpdate {
  const n = fleet.full ? fleet.count : fleet.pendingCount;
  const columns = createColumns(n);
  const meta: (EntityMeta | undefined)[] | undefined = fleet.full ? fleet.meta : undefined;
  for (let k = 0; k < n; k++) {
    const i = fleet.full ? k : fleet.pending[k];
    columns.ids[k] = fleet.ids[i];
    columns.lon[k] = fleet.lon[i];
    columns.lat[k] = fleet.lat[i];
    columns.alt[k] = fleet.alt[i];
    columns.heading[k] = fleet.heading[i];
    columns.speed[k] = fleet.speed[i];
    columns.vrate[k] = fleet.vrate[i];
    columns.fixTimeMs[k] = fleet.fixTimeMs[i];
    columns.category[k] = fleet.category[i];
    const length = fleet.meta[i].lengthM;
    const typeCode = fleet.meta[i].typeCode;
    // An aircraft's value is the 3D model of its type, as the gateway path sets it from meta.
    columns.value[k] =
      typeof length === "number"
        ? length
        : typeof typeCode === "string"
          ? aircraftModelForType(typeCode)
          : 0;
  }
  const update: EntityUpdate = {
    kind: fleet.kind,
    source,
    timeMs: fleet.timeMs,
    full: fleet.full,
    count: n,
    columns,
  };
  if (meta) update.meta = meta;
  return update;
}

function syntheticSource(
  kind: EntityKind,
  id: string,
  count: number,
  seed: number,
  share: number,
): SourcePlugin<Fleet> {
  let fleet: Fleet | null = null;
  return defineSource<Fleet>({
    id,
    name: "Orya Halo synthetic traffic",
    layer: kind === EntityKind.Aircraft ? "aircraft" : "ships",
    transport: "compute",
    schema: [],
    refreshRate: 1000,
    licence: {
      name: "Generated locally",
      url: "https://github.com/",
      display: true,
      redistribution: true,
      commercial: true,
      notes: "Not real traffic: random movers for load testing.",
      verified: "2026-11-14",
    },
    attribution: { text: "Synthetic test traffic", url: "" },
    docs: "",
    async fetch(ctx) {
      const now = ctx.now();
      if (fleet === null) {
        fleet = createFleet(kind, count, seed, now);
        return fleet;
      }
      const f = fleet;
      f.polls++;
      // A gap means polling stopped (layer off, tab hidden, clock scrubbed) and
      // the store may have been emptied; a periodic full report covers the rest.
      f.full = f.polls % FULL_EVERY === 0 || Math.abs(now - f.timeMs) > GAP_MS;
      f.timeMs = now;
      f.pendingCount = 0;
      for (let i = 0; i < f.count; i++) {
        // A different random subset each second, like position reports trickling in.
        if (f.full || f.random() < share) {
          advance(f, i, now);
          f.pending[f.pendingCount++] = i;
        }
      }
      return f;
    },
    normalise(raw) {
      return { type: "entities", update: normaliseFleet(raw, id) };
    },
  });
}

/**
 * Plugins that generate `count` aircraft and `count` ships. Aircraft report
 * about every 3 s each, ships about every 10 s, as live feeds do.
 */
export function createSyntheticSources(count: number, seed = 1): SourcePlugin[] {
  if (!(count > 0)) return [];
  const n = Math.floor(count);
  return [
    syntheticSource(EntityKind.Aircraft, SYNTHETIC_AIRCRAFT_ID, n, seed, 1 / 3),
    syntheticSource(EntityKind.Ship, SYNTHETIC_SHIPS_ID, n, seed + 7919, 1 / 10),
  ];
}
