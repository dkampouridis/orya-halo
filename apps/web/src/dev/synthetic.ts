/**
 * Synthetic world for the engine sandbox: movers that fly great circles
 * between hubs, satellites on circular orbits, and a handful of quakes, fires,
 * webcams and cables. It stands in for the data worker, so it produces the
 * same `RenderBatch` shape, including blend offsets when a fix is corrected.
 */
import {
  AIRCRAFT_LIVERIES,
  aircraftModelForType,
  BLEND_SIZE,
  EARTH_RADIUS_M,
  EntityFlag,
  EntityKind,
  MOTION_SIZE,
  POSITION_SIZE,
  STYLE_SIZE,
  ShipCategory,
  createRenderBatch,
  extrapolate,
  shipValueFor,
  splitShipValue,
} from "@orya-halo/schema";
import type { DensityGrid, PathSet, RenderBatch, Track } from "@orya-halo/schema";

const DEG = Math.PI / 180;

/** Deterministic random numbers, so screenshots are repeatable. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type LonLat = readonly [number, number];

const AIR_HUBS: LonLat[] = [
  [-0.45, 51.47],
  [2.55, 49.01],
  [8.57, 50.03],
  [4.76, 52.31],
  [-3.57, 40.47],
  [12.25, 41.8],
  [28.75, 41.26],
  [37.41, 55.97],
  [55.36, 25.25],
  [51.61, 25.27],
  [77.1, 28.56],
  [72.87, 19.09],
  [103.99, 1.36],
  [100.75, 13.69],
  [113.92, 22.31],
  [121.8, 31.14],
  [116.6, 40.08],
  [139.78, 35.55],
  [126.45, 37.46],
  [151.18, -33.94],
  [144.84, -37.67],
  [174.79, -37.01],
  [-73.78, 40.64],
  [-87.9, 41.98],
  [-84.43, 33.64],
  [-97.04, 32.9],
  [-118.41, 33.94],
  [-122.38, 37.62],
  [-122.31, 47.45],
  [-79.63, 43.68],
  [-99.07, 19.44],
  [-46.47, -23.43],
  [-58.54, -34.82],
  [-70.79, -33.39],
  [-74.15, 4.7],
  [28.24, -26.14],
  [36.93, -1.32],
  [31.41, 30.12],
  [3.32, 6.58],
  [-7.59, 33.37],
  [-157.92, 21.32],
  [-149.99, 61.17],
  [-21.94, 64.13],
  [24.96, 60.32],
  [18.07, 59.65],
  [106.65, -6.13],
  [120.98, 14.51],
  [67.16, 24.9],
];

const PORTS: LonLat[] = [
  [4.0, 51.95],
  [-74.0, 40.5],
  [103.8, 1.2],
  [121.9, 31.0],
  [-118.2, 33.7],
  [32.55, 29.9],
  [-79.9, 9.3],
  [139.9, 35.3],
  [114.2, 22.2],
  [55.0, 25.0],
  [18.4, -34.0],
  [151.3, -33.9],
  [-43.1, -23.0],
  [-5.6, 36.0],
  [72.8, 18.9],
  [129.0, 35.0],
  [-123.3, 48.2],
  [-90.0, 29.0],
  [10.0, 54.0],
  [-9.2, 38.6],
  [44.9, 12.6],
  [80.0, 6.9],
  [-70.9, -33.0],
  [174.8, -36.8],
  [-157.9, 21.3],
  [39.2, 21.4],
  [-0.5, 5.3],
  [12.3, 45.3],
  [23.6, 37.9],
  [-66.1, 18.5],
];

/** Point a fraction `f` of the way along the great circle from a to b, and the bearing there. */
function along(a: LonLat, b: LonLat, f: number): { lon: number; lat: number; heading: number } {
  const lat1 = a[1] * DEG;
  const lon1 = a[0] * DEG;
  const lat2 = b[1] * DEG;
  const lon2 = b[0] * DEG;
  const d =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((lat2 - lat1) / 2) ** 2 +
          Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2,
      ),
    );
  const at = (t: number): [number, number] => {
    if (d < 1e-9) return [a[0], a[1]];
    const A = Math.sin((1 - t) * d) / Math.sin(d);
    const B = Math.sin(t * d) / Math.sin(d);
    const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
    const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
    const z = A * Math.sin(lat1) + B * Math.sin(lat2);
    return [Math.atan2(y, x) / DEG, Math.atan2(z, Math.hypot(x, y)) / DEG];
  };
  const [lon, lat] = at(f);
  const [lonN, latN] = at(Math.min(f + 0.002, 1));
  const y = Math.sin((lonN - lon) * DEG) * Math.cos(latN * DEG);
  const x =
    Math.cos(lat * DEG) * Math.sin(latN * DEG) -
    Math.sin(lat * DEG) * Math.cos(latN * DEG) * Math.cos((lonN - lon) * DEG);
  return { lon, lat, heading: (Math.atan2(y, x) / DEG + 360) % 360 };
}

function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** True state of one kind's objects, advanced by the sandbox between batches. */
/** A traffic mix like a European sky's, by ICAO type, weighted by how common each is. */
const SYNTHETIC_TYPES: readonly (readonly [string, number])[] = [
  ["A320", 18],
  ["A20N", 10],
  ["B738", 16],
  ["B38M", 6],
  ["A321", 8],
  ["A319", 5],
  ["BCS3", 3],
  ["E190", 5],
  ["E75L", 3],
  ["CRJ9", 3],
  ["AT76", 4],
  ["DH8D", 3],
  ["B789", 3],
  ["B77W", 3],
  ["A359", 3],
  ["A333", 2],
  ["B744", 1],
  ["A388", 1],
  ["B763", 1],
  ["MD11", 1],
  ["C56X", 2],
  ["GLF6", 1],
  ["C172", 3],
  ["P28A", 2],
  ["BE20", 1],
  ["PC12", 1],
  ["EC35", 2],
  ["C130", 1],
];
const SYNTHETIC_TOTAL = SYNTHETIC_TYPES.reduce((sum, [, w]) => sum + w, 0);

/** A stable airline colour scheme for a synthetic aircraft: a third neutral, the rest any scheme. */
function syntheticLivery(id: number): number {
  const u = (Math.imul(id ^ 0x27d4eb2f, 2654435761) >>> 0) % (AIRCRAFT_LIVERIES.length * 3);
  return u < AIRCRAFT_LIVERIES.length ? 0 : u % AIRCRAFT_LIVERIES.length;
}

/** A stable aircraft type for a synthetic aircraft, as its model id. */
function syntheticAircraftModel(id: number): number {
  let u = (Math.imul(id ^ 0x5bd1e995, 2246822519) >>> 0) % SYNTHETIC_TOTAL;
  for (const [code, weight] of SYNTHETIC_TYPES) {
    if (u < weight) return aircraftModelForType(code);
    u -= weight;
  }
  return 0;
}

/** Typical length range of each `ShipCategory`, metres. */
const SHIP_LENGTHS: readonly (readonly [number, number])[] = [
  [30, 150], // unknown
  [120, 400], // cargo
  [100, 330], // tanker
  [60, 300], // passenger
  [15, 60], // fishing
  [15, 45], // service
  [20, 60], // high-speed
  [8, 30], // pleasure
  [50, 200], // military
  [20, 120], // other
];

/** Name prefixes for synthetic ships, by category: some of them pick an operator's colours. */
const SHIP_NAMES: Partial<Record<number, readonly string[]>> = {
  [ShipCategory.Cargo]: [
    "MAERSK",
    "MSC",
    "CMA CGM",
    "COSCO",
    "EVER",
    "YM",
    "HMM",
    "ONE",
    "ZIM",
    "HOEGH",
  ],
  [ShipCategory.Passenger]: [
    "CARNIVAL",
    "COSTA",
    "MSC",
    "AIDA",
    "CELEBRITY",
    "DISNEY",
    "NORWEGIAN",
  ],
  [ShipCategory.Other]: ["RV", "USCGC", "CCGS"],
};
/** AIS ship types for synthetic ships of the categories that have several. */
const SHIP_TYPE_NAMES: Partial<Record<number, readonly string[]>> = {
  [ShipCategory.Service]: ["Tug", "Pilot vessel", "Law enforcement", "Search and rescue vessel"],
  [ShipCategory.Pleasure]: ["Sailing vessel", "Pleasure craft"],
};

/**
 * A stable, plausible batch value for a synthetic ship: its length and beam,
 * and a name and type that give it a model and colours as real ones get them.
 */
function syntheticShipValue(category: number, id: number): number {
  const [min, max] = SHIP_LENGTHS[category] ?? SHIP_LENGTHS[0];
  const hash = (salt: number): number => (Math.imul(id ^ salt, 2654435761) >>> 0) % 1000;
  const lengthM = min + ((max - min) * hash(0)) / 1000;
  const beamM = lengthM / (5.5 + (3 * hash(0x9e37)) / 1000);
  const names = SHIP_NAMES[category] ?? [];
  // Half the ships of a category with operators get one.
  const pick = hash(0x7f4a) % (names.length * 2);
  const types = SHIP_TYPE_NAMES[category] ?? [];
  return shipValueFor({
    category,
    name: pick < names.length ? `${names[pick]} SYNTH` : "SYNTH",
    typeName: types.length > 0 ? types[hash(0x3c6e) % types.length] : null,
    lengthM,
    beamM,
  });
}

interface Fleet {
  kind: EntityKind;
  count: number;
  lon: Float64Array;
  lat: Float64Array;
  alt: Float32Array;
  heading: Float32Array;
  speed: Float32Array;
  vrate: Float32Array;
  turn: Float32Array;
  flags: Uint8Array;
  category: Uint8Array;
  /** Satellites only: inclination, ascending node, phase and mean motion (rad/s). */
  orbit?: Float64Array;
  /** Ships only: the batch value (`syntheticShipValue`), worked out once. */
  value?: Float32Array;
  seq: number;
  batch: RenderBatch | null;
}

function makeFleet(kind: EntityKind, count: number): Fleet {
  return {
    kind,
    count,
    lon: new Float64Array(count),
    lat: new Float64Array(count),
    alt: new Float32Array(count),
    heading: new Float32Array(count),
    speed: new Float32Array(count),
    vrate: new Float32Array(count),
    turn: new Float32Array(count),
    flags: new Uint8Array(count),
    category: new Uint8Array(count),
    seq: 0,
    batch: null,
  };
}

const EARTH_ROTATION = (2 * Math.PI) / 86164.1;
const MU = 3.986004418e14;

function satellitePosition(orbit: Float64Array, i: number, tSeconds: number): [number, number] {
  const inc = orbit[i * 4];
  const node = orbit[i * 4 + 1];
  const u = orbit[i * 4 + 2] + orbit[i * 4 + 3] * tSeconds;
  const lat = Math.asin(Math.sin(inc) * Math.sin(u));
  const lon =
    node + Math.atan2(Math.cos(inc) * Math.sin(u), Math.cos(u)) - EARTH_ROTATION * tSeconds;
  return [wrapLon(lon / DEG), lat / DEG];
}

export interface SyntheticOptions {
  /** Total moving objects, shared between aircraft, ships and satellites. */
  movers: number;
  seed?: number;
  /** Fraction of objects that receive a new fix in each batch. */
  refresh?: number;
}

export class SyntheticWorld {
  readonly epochMs: number;
  private readonly random: () => number;
  private readonly fleets: Fleet[];
  private readonly refresh: number;
  private lastStepMs: number;

  constructor(options: SyntheticOptions, startMs: number) {
    this.random = mulberry32(options.seed ?? 7);
    this.refresh = options.refresh ?? 0.5;
    this.epochMs = startMs;
    this.lastStepMs = startMs;
    const aircraft = Math.round(options.movers * 0.55);
    const ships = Math.round(options.movers * 0.3);
    const satellites = Math.max(options.movers - aircraft - ships, 0);
    this.fleets = [
      this.seedAircraft(aircraft),
      this.seedShips(ships),
      this.seedSatellites(satellites),
    ];
  }

  private seedAircraft(count: number): Fleet {
    const f = makeFleet(EntityKind.Aircraft, count);
    const r = this.random;
    for (let i = 0; i < count; i++) {
      const a = AIR_HUBS[Math.floor(r() * AIR_HUBS.length)];
      let b = AIR_HUBS[Math.floor(r() * AIR_HUBS.length)];
      if (b === a) b = AIR_HUBS[(AIR_HUBS.indexOf(a) + 1) % AIR_HUBS.length];
      const p = along(a, b, 0.03 + r() * 0.94);
      f.lon[i] = wrapLon(p.lon + (r() - 0.5) * 1.6);
      f.lat[i] = Math.max(-85, Math.min(85, p.lat + (r() - 0.5) * 1.6));
      f.heading[i] = (p.heading + (r() - 0.5) * 8 + 360) % 360;
      f.speed[i] = 170 + r() * 90;
      f.alt[i] = 8500 + r() * 3500;
      f.turn[i] = (r() - 0.5) * 0.25;
      f.category[i] = 1 + Math.floor(r() * 4);
      if (r() < 0.0015) f.flags[i] |= EntityFlag.Emergency;
      if (r() < 0.01) f.flags[i] |= EntityFlag.Stale;
    }
    return f;
  }

  private seedShips(count: number): Fleet {
    const f = makeFleet(EntityKind.Ship, count);
    const r = this.random;
    for (let i = 0; i < count; i++) {
      const a = PORTS[Math.floor(r() * PORTS.length)];
      let b = PORTS[Math.floor(r() * PORTS.length)];
      if (b === a) b = PORTS[(PORTS.indexOf(a) + 1) % PORTS.length];
      const p = along(a, b, r());
      f.lon[i] = wrapLon(p.lon + (r() - 0.5) * 2.4);
      f.lat[i] = Math.max(-80, Math.min(80, p.lat + (r() - 0.5) * 2.4));
      const moored = r() < 0.12;
      f.heading[i] = r() < 0.03 ? Number.NaN : (p.heading + (r() - 0.5) * 20 + 360) % 360;
      f.speed[i] = moored ? 0 : 4 + r() * 9;
      f.turn[i] = (r() - 0.5) * 0.05;
      f.category[i] = 1 + Math.floor(r() * 8);
      if (moored) f.flags[i] |= EntityFlag.Stationary;
    }
    return f;
  }

  private seedSatellites(count: number): Fleet {
    const f = makeFleet(EntityKind.Satellite, count);
    f.orbit = new Float64Array(count * 4);
    const r = this.random;
    for (let i = 0; i < count; i++) {
      const pick = r();
      // Mostly low orbit, with a few navigation and geostationary birds.
      const alt = pick < 0.86 ? 400_000 + r() * 900_000 : pick < 0.95 ? 20_200_000 : 35_786_000;
      const inc = alt > 30_000_000 ? r() * 0.02 : (pick < 0.5 ? 53 + r() * 3 : 40 + r() * 58) * DEG;
      f.alt[i] = alt;
      f.orbit[i * 4] = inc;
      f.orbit[i * 4 + 1] = r() * 2 * Math.PI;
      f.orbit[i * 4 + 2] = r() * 2 * Math.PI;
      f.orbit[i * 4 + 3] = Math.sqrt(MU / (EARTH_RADIUS_M + alt) ** 3);
      f.category[i] = alt > 30_000_000 ? 6 : alt > 10_000_000 ? 3 : 2;
    }
    return f;
  }

  /** Advance the true state to `nowMs`. */
  private step(nowMs: number): void {
    const dt = Math.max((nowMs - this.lastStepMs) / 1000, 0);
    this.lastStepMs = nowMs;
    const t = (nowMs - this.epochMs) / 1000;
    for (const f of this.fleets) {
      if (f.orbit) {
        for (let i = 0; i < f.count; i++) {
          const [lon, lat] = satellitePosition(f.orbit, i, t);
          const [lon2, lat2] = satellitePosition(f.orbit, i, t + 1);
          const dLat = (lat2 - lat) * DEG;
          const dLon = wrapLon(lon2 - lon) * DEG * Math.cos(lat * DEG);
          f.lon[i] = lon;
          f.lat[i] = lat;
          f.heading[i] = (Math.atan2(dLon, dLat) / DEG + 360) % 360;
          f.speed[i] = Math.hypot(dLat, dLon) * EARTH_RADIUS_M;
        }
        continue;
      }
      if (dt === 0) continue;
      for (let i = 0; i < f.count; i++) {
        const speed = f.speed[i];
        const heading = f.heading[i];
        if (!(speed > 0) || Number.isNaN(heading)) continue;
        const h = heading * DEG;
        const dist = speed * dt;
        const cosLat = Math.max(Math.cos(f.lat[i] * DEG), 0.01);
        let lat = f.lat[i] + (dist * Math.cos(h)) / EARTH_RADIUS_M / DEG;
        const lon = f.lon[i] + (dist * Math.sin(h)) / (EARTH_RADIUS_M * cosLat) / DEG;
        let nextHeading = heading + f.turn[i] * dt;
        if (lat > 84 || lat < -84) {
          lat = Math.max(-84, Math.min(84, lat));
          nextHeading = 180 - nextHeading;
        }
        f.lat[i] = lat;
        f.lon[i] = wrapLon(lon);
        f.heading[i] = ((nextHeading % 360) + 360) % 360;
      }
    }
  }

  /**
   * One new batch per kind for `nowMs`. About `refresh` of the objects get a
   * fresh fix; where that fix disagrees with where the previous batch would
   * have drawn the object, the difference goes into the blend columns.
   */
  batches(nowMs: number): RenderBatch[] {
    this.step(nowMs);
    const t = (nowMs - this.epochMs) / 1000;
    const out: RenderBatch[] = [];
    const drawn: [number, number, number] = [0, 0, 0];
    for (const f of this.fleets) {
      if (f.count === 0) continue;
      const prev = f.batch;
      const batch = createRenderBatch(f.kind, f.count, this.epochMs, ++f.seq);
      for (let i = 0; i < f.count; i++) {
        const p = i * POSITION_SIZE;
        const m = i * MOTION_SIZE;
        const b = i * BLEND_SIZE;
        const s = i * STYLE_SIZE;
        batch.ids[i] = (f.kind << 24) | (i + 1);
        if (prev && this.random() >= this.refresh) {
          batch.positions.set(prev.positions.subarray(p, p + POSITION_SIZE), p);
          batch.motion.set(prev.motion.subarray(m, m + MOTION_SIZE), m);
          batch.blend.set(prev.blend.subarray(b, b + BLEND_SIZE), b);
        } else {
          batch.positions[p] = f.lon[i];
          batch.positions[p + 1] = f.lat[i];
          batch.positions[p + 2] = f.alt[i];
          batch.motion[m] = f.heading[i];
          batch.motion[m + 1] = f.speed[i];
          batch.motion[m + 2] = f.vrate[i];
          batch.motion[m + 3] = t;
          if (prev) {
            extrapolate(prev, i, nowMs, drawn);
            batch.blend[b] = wrapLon(drawn[0] - batch.positions[p]);
            batch.blend[b + 1] = drawn[1] - batch.positions[p + 1];
            batch.blend[b + 2] = t;
          } else {
            batch.blend[b + 2] = -1e6;
          }
        }
        batch.style[s] = f.category[i];
        batch.style[s + 1] = f.flags[i];
        if (f.kind === EntityKind.Ship) {
          if (!f.value) f.value = new Float32Array(f.count);
          if (f.value[i] === 0) f.value[i] = syntheticShipValue(f.category[i], batch.ids[i]);
          const ship = splitShipValue(f.value[i]);
          batch.values[i] = f.value[i];
          batch.style[s + 2] = Math.min(255, Math.round((ship.lengthM / 400) * 255));
          batch.style[s + 3] = ship.model;
        }
        if (f.kind === EntityKind.Aircraft) {
          batch.style[s + 2] = syntheticLivery(batch.ids[i]);
          batch.style[s + 3] = syntheticAircraftModel(batch.ids[i]);
        }
      }
      f.batch = batch;
      out.push(batch);
    }
    return out;
  }

  /** Coarse lon/lat grid of aircraft counts, standing in for the worker's H3 density. */
  density(kind: EntityKind, cellDeg = 3): DensityGrid | null {
    const fleet = this.fleets.find((f) => f.kind === kind);
    if (!fleet || fleet.count === 0) return null;
    const cols = Math.round(360 / cellDeg);
    const rows = Math.round(180 / cellDeg);
    const grid = new Uint32Array(cols * rows);
    for (let i = 0; i < fleet.count; i++) {
      const c = Math.min(cols - 1, Math.floor((fleet.lon[i] + 180) / cellDeg));
      const r = Math.min(rows - 1, Math.floor((fleet.lat[i] + 90) / cellDeg));
      grid[r * cols + c]++;
    }
    const cells: number[] = [];
    const counts: number[] = [];
    let max = 0;
    for (let k = 0; k < grid.length; k++) {
      if (grid[k] === 0) continue;
      cells.push(((k % cols) + 0.5) * cellDeg - 180, (Math.floor(k / cols) + 0.5) * cellDeg - 90);
      counts.push(grid[k]);
      max = Math.max(max, grid[k]);
    }
    // Resolution 2 cells are roughly this size (about 180 km edges).
    return {
      kind,
      res: 2,
      count: counts.length,
      positions: new Float32Array(cells),
      counts: new Uint32Array(counts),
      max,
    };
  }

  /** A plausible track for one object: where it has been, or a satellite's orbit ahead. */
  track(kind: EntityKind, id: number, nowMs: number): Track | null {
    const fleet = this.fleets.find((f) => f.kind === kind);
    const i = (id & 0xffffff) - 1;
    if (!fleet || i < 0 || i >= fleet.count) return null;
    const t = (nowMs - this.epochMs) / 1000;
    const n = 180;
    const positions = new Float32Array(n * 3);
    const timesMs = new Float64Array(n);
    if (fleet.orbit) {
      const period = (2 * Math.PI) / fleet.orbit[i * 4 + 3];
      for (let k = 0; k < n; k++) {
        const at = t + ((k - n * 0.25) / n) * Math.min(period, 86400);
        const [lon, lat] = satellitePosition(fleet.orbit, i, at);
        positions.set([lon, lat, fleet.alt[i]], k * 3);
        timesMs[k] = this.epochMs + at * 1000;
      }
    } else {
      // Walk backwards along the current heading with a gentle bend.
      let lon = fleet.lon[i];
      let lat = fleet.lat[i];
      let heading = Number.isNaN(fleet.heading[i]) ? 0 : fleet.heading[i];
      const stepS = kind === EntityKind.Ship ? 240 : 20;
      for (let k = n - 1; k >= 0; k--) {
        positions.set([lon, lat, fleet.alt[i]], k * 3);
        timesMs[k] = nowMs - (n - 1 - k) * stepS * 1000;
        const h = (heading + 180) * DEG;
        const dist = fleet.speed[i] * stepS;
        lat += (dist * Math.cos(h)) / EARTH_RADIUS_M / DEG;
        lon += (dist * Math.sin(h)) / (EARTH_RADIUS_M * Math.max(Math.cos(lat * DEG), 0.01)) / DEG;
        heading -= fleet.turn[i] * stepS * 0.2 + Math.sin(k * 0.11) * 0.35;
      }
    }
    return { ref: { kind, id }, count: n, positions, timesMs };
  }
}

const QUAKE_ZONES: LonLat[] = [
  [142.4, 38.3],
  [-70.6, -33.4],
  [-122.0, 37.2],
  [95.9, 3.3],
  [28.9, 40.8],
  [-155.3, 19.4],
  [178.0, -18.0],
  [-174.0, -20.5],
  [121.6, 23.9],
  [-98.8, 17.1],
  [70.6, 36.5],
  [14.3, 40.8],
  [-149.9, 61.2],
  [167.0, -15.4],
  [126.6, 0.9],
  [-77.0, -12.0],
];

/** Earthquakes scattered round the usual plate boundaries, aged up to a day. */
export function syntheticQuakes(nowMs: number, count = 70, seed = 11): RenderBatch {
  const r = mulberry32(seed);
  const batch = createRenderBatch(EntityKind.Quake, count, nowMs, 1);
  for (let i = 0; i < count; i++) {
    const z = QUAKE_ZONES[Math.floor(r() * QUAKE_ZONES.length)];
    const magnitude = 2.5 + -Math.log(1 - r() * 0.985) / 1.1;
    batch.ids[i] = 0x400000 + i;
    batch.positions.set(
      [wrapLon(z[0] + (r() - 0.5) * 16), z[1] + (r() - 0.5) * 12, -(5000 + r() * 60000)],
      i * POSITION_SIZE,
    );
    batch.motion.set([Number.NaN, 0, 0, -(r() ** 2) * 86400], i * MOTION_SIZE);
    batch.blend[i * BLEND_SIZE + 2] = -1e6;
    batch.values[i] = Math.min(magnitude, 7.8);
    batch.style[i * STYLE_SIZE + 2] = Math.round(Math.min(magnitude / 9, 1) * 255);
  }
  return batch;
}

function staticBatch(
  kind: EntityKind,
  points: { lon: number; lat: number; value: number }[],
  nowMs: number,
): RenderBatch {
  const batch = createRenderBatch(kind, points.length, nowMs, 1);
  points.forEach((p, i) => {
    batch.ids[i] = (kind << 24) | (i + 1);
    batch.positions.set([p.lon, p.lat, 0], i * POSITION_SIZE);
    batch.motion.set([Number.NaN, 0, 0, 0], i * MOTION_SIZE);
    batch.blend[i * BLEND_SIZE + 2] = -1e6;
    batch.values[i] = p.value;
  });
  return batch;
}

export function syntheticFires(nowMs: number, count = 400, seed = 23): RenderBatch {
  const r = mulberry32(seed);
  const regions: LonLat[] = [
    [22, -8],
    [28, 6],
    [-58, -11],
    [133, -17],
    [102, 17],
    [-120, 40],
    [15, 12],
  ];
  const points = Array.from({ length: count }, () => {
    const c = regions[Math.floor(r() * regions.length)];
    return { lon: c[0] + (r() - 0.5) * 18, lat: c[1] + (r() - 0.5) * 12, value: Math.exp(r() * 6) };
  });
  return staticBatch(EntityKind.Fire, points, nowMs);
}

/**
 * Webcams near the hubs, six to a hub. Each carries a zoom rank in its value,
 * as the real webcam sources do: the lowest zoom at which it should be drawn.
 * Here the first camera of every third hub shows from orbit, the first of
 * the others from zoom 3, and the rest of each cluster from zoom 6 to 10.
 */
export function syntheticWebcams(nowMs: number, seed = 31): RenderBatch {
  const r = mulberry32(seed);
  const points: { lon: number; lat: number; value: number }[] = [];
  AIR_HUBS.slice(0, 36).forEach(([lon, lat], hub) => {
    for (let k = 0; k < 6; k++) {
      points.push({
        lon: lon + 0.15 + (k === 0 ? 0 : (r() - 0.5) * 0.5),
        lat: lat + 0.1 + (k === 0 ? 0 : (r() - 0.5) * 0.35),
        value: k === 0 ? (hub % 3 === 0 ? 0 : 3) : 5 + k,
      });
    }
  });
  return staticBatch(EntityKind.Webcam, points, nowMs);
}

/** A few great-circle "cables" between ports, densified so they hug the globe. */
export function syntheticCables(): PathSet {
  const pairs: [number, number][] = [
    [0, 1],
    [1, 13],
    [2, 5],
    [3, 4],
    [4, 7],
    [10, 12],
    [11, 23],
    [14, 9],
    [20, 21],
    [2, 11],
    [24, 4],
    [13, 26],
  ];
  const positions: number[] = [];
  const startIndices: number[] = [0];
  const names: string[] = [];
  pairs.forEach(([a, b], k) => {
    const steps = 96;
    for (let s = 0; s <= steps; s++) {
      const p = along(PORTS[a], PORTS[b], s / steps);
      positions.push(p.lon, p.lat);
    }
    startIndices.push(positions.length / 2);
    names.push(`Sandbox cable ${k + 1}`);
  });
  return {
    count: pairs.length,
    ids: Uint32Array.from(pairs, (_, k) => 9000 + k),
    startIndices: new Uint32Array(startIndices),
    positions: new Float32Array(positions),
    names,
  };
}
