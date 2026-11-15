/**
 * Test and benchmark helpers. Not imported by the worker.
 */
import { createColumns, defineSource } from "@orya-halo/schema";
import type {
  EntityKind,
  EntityMeta,
  EntityUpdate,
  LayerId,
  SourceOutput,
  SourcePlugin,
} from "@orya-halo/schema";
import { seededRandom } from "./synthetic.ts";

export interface Row {
  id: number;
  lon?: number;
  lat?: number;
  alt?: number;
  heading?: number;
  speed?: number;
  vrate?: number;
  /** Defaults to the update's time. */
  fixTimeMs?: number;
  category?: number;
  flags?: number;
  value?: number;
  meta?: EntityMeta;
}

/** Build an `EntityUpdate` from plain rows. */
export function makeUpdate(
  kind: EntityKind,
  source: string,
  timeMs: number,
  rows: readonly Row[],
  options: { full?: boolean; removed?: number[] } = {},
): EntityUpdate {
  const columns = createColumns(rows.length);
  let meta: (EntityMeta | undefined)[] | undefined;
  rows.forEach((row, i) => {
    columns.ids[i] = row.id;
    columns.lon[i] = row.lon ?? 0;
    columns.lat[i] = row.lat ?? 0;
    columns.alt[i] = row.alt ?? 0;
    columns.heading[i] = row.heading ?? Number.NaN;
    columns.speed[i] = row.speed ?? 0;
    columns.vrate[i] = row.vrate ?? 0;
    columns.fixTimeMs[i] = row.fixTimeMs ?? timeMs;
    columns.category[i] = row.category ?? 0;
    columns.flags[i] = row.flags ?? 0;
    columns.value[i] = row.value ?? 0;
    if (row.meta) {
      meta ??= Array.from({ length: rows.length });
      meta[i] = row.meta;
    }
  });
  const update: EntityUpdate = {
    kind,
    source,
    timeMs,
    full: options.full ?? false,
    count: rows.length,
    columns,
  };
  if (meta) update.meta = meta;
  if (options.removed) update.removed = Uint32Array.from(options.removed);
  return update;
}

/** `count` movers spread over the world, deterministic for a seed. */
export function randomUpdate(
  kind: EntityKind,
  source: string,
  timeMs: number,
  count: number,
  seed: number,
  options: { full?: boolean; idBase?: number; labels?: boolean; pick?: number } = {},
): EntityUpdate {
  const random = seededRandom(seed);
  const columns = createColumns(count);
  const base = options.idBase ?? 1;
  const meta: (EntityMeta | undefined)[] | undefined = options.labels ? [] : undefined;
  for (let i = 0; i < count; i++) {
    // `pick` draws ids at random from a pool that size, for partial updates.
    const n = options.pick ? Math.floor(random() * options.pick) : i;
    columns.ids[i] = base + n;
    columns.lon[i] = random() * 360 - 180;
    columns.lat[i] = random() * 160 - 80;
    columns.alt[i] = random() * 12_000;
    columns.heading[i] = random() * 360;
    columns.speed[i] = 50 + random() * 200;
    columns.vrate[i] = (random() - 0.5) * 10;
    columns.fixTimeMs[i] = timeMs - random() * 2000;
    columns.category[i] = Math.floor(random() * 9);
    if (meta)
      meta.push({
        label: label(base + n),
        registration: `R-${(base + n).toString(36).toUpperCase()}`,
      });
  }
  const update: EntityUpdate = {
    kind,
    source,
    timeMs,
    full: options.full ?? false,
    count,
    columns,
  };
  if (meta) update.meta = meta;
  return update;
}

const AIRLINES = [
  "RYR",
  "EZY",
  "DLH",
  "BAW",
  "AFR",
  "KLM",
  "UAL",
  "DAL",
  "AAL",
  "SWA",
  "QFA",
  "ANA",
  "THY",
  "UAE",
  "SIA",
  "ACA",
];

/** A callsign-like label that is stable for an id. */
export function label(id: number): string {
  return `${AIRLINES[id % AIRLINES.length]}${1000 + ((id * 7919) % 9000)}`;
}

export interface FakeSourceOptions {
  id?: string;
  layer?: LayerId;
  refreshRate?: number;
  recomputeRate?: number;
  cacheTtl?: number;
  viewAware?: boolean;
  requiresKey?: string;
  transport?: SourcePlugin["transport"];
  fetch?: SourcePlugin<unknown>["fetch"];
  stream?: SourcePlugin<unknown>["stream"];
  fallback?: SourcePlugin<unknown>["fallback"];
  normalise?: (raw: unknown, ctx: { now(): number }) => SourceOutput;
}

/** A minimal plugin whose behaviour the test supplies. */
export function fakeSource(options: FakeSourceOptions = {}): SourcePlugin {
  const plugin: SourcePlugin = {
    id: options.id ?? "fake",
    name: "Test Provider",
    layer: options.layer ?? "quakes",
    transport: options.transport ?? (options.stream ? "stream" : "fetch"),
    schema: [],
    refreshRate: options.refreshRate ?? 60_000,
    licence: {
      name: "Test",
      url: "https://example.org/licence",
      display: true,
      redistribution: true,
      commercial: true,
      verified: "2026-11-14",
    },
    attribution: { text: "Test Provider", url: "https://example.org" },
    docs: "https://example.org/docs",
    normalise:
      options.normalise ??
      (() => ({
        type: "tiles",
        overlay: { tiles: [], tileSize: 256, minZoom: 0, maxZoom: 1, opacity: 1 },
      })),
  };
  const extra: Partial<Record<keyof SourcePlugin, unknown>> = {};
  if (options.recomputeRate !== undefined) extra.recomputeRate = options.recomputeRate;
  if (options.cacheTtl !== undefined) extra.cacheTtl = options.cacheTtl;
  if (options.viewAware !== undefined) extra.viewAware = options.viewAware;
  if (options.requiresKey !== undefined) extra.requiresKey = options.requiresKey;
  if (options.fetch) extra.fetch = options.fetch;
  if (options.stream) extra.stream = options.stream;
  if (options.fallback) extra.fallback = options.fallback;
  return defineSource({ ...plugin, ...extra } as SourcePlugin);
}

/** An error of the shape source plugins throw (`SourceError` in @orya-halo/sources). */
export function sourceError(
  code: "needs-key" | "blocked" | "http" | "bad-data",
  message: string,
  status?: number,
): Error {
  return Object.assign(new Error(message), { name: "SourceError", code, status });
}
