/**
 * Earthquakes: USGS Earthquake Hazards Program GeoJSON summary feeds.
 *
 * Three feeds are merged so the globe shows both what is happening now and
 * what mattered this week, without pulling the 30-day catalogue:
 *
 * - all earthquakes, past day: the live picture, dominated by small events
 *   where networks are dense;
 * - magnitude 4.5 and above, past week: the worldwide events that outline the
 *   plate boundaries (about 120 of them);
 * - significant, past week: the handful that were widely felt or damaging,
 *   whatever their magnitude.
 *
 * USGS regenerates each feed once a minute and serves it with
 * `Cache-Control: max-age=60`, so the refresh rate matches that.
 */
import { EntityKind, createColumns, defineSource, hashId } from "@orya-halo/schema";
import type {
  Attribution,
  EntityMeta,
  EntityUpdate,
  HaloEvent,
  SchemaField,
  SourceContext,
  SourcePlugin,
} from "@orya-halo/schema";
import { detailFields, formatUtc } from "../shared/space-earth/detail.ts";
import { SourceError, fetchText } from "../shared/space-earth/errors.ts";

const SOURCE_ID = "usgs-quakes";
const FEED_BASE = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary";

/** Feed names, the essential one first. */
export const USGS_FEEDS = ["all_day", "4.5_week", "significant_week"] as const;

/** Quakes at least this strong make the ticker... */
export const EVENT_MIN_MAGNITUDE = 4.5;
/** ...while they are at most this old. */
export const EVENT_WINDOW_MS = 3_600_000;

/** One feature of a USGS GeoJSON summary feed. Only the fields used here. */
export interface UsgsFeature {
  id: string;
  properties: {
    mag: number | null;
    place: string | null;
    time: number;
    updated?: number;
    url?: string;
    felt?: number | null;
    alert?: string | null;
    status?: string;
    tsunami?: number;
    sig?: number;
    magType?: string | null;
    type?: string;
    title?: string;
  };
  geometry: {
    type: string;
    coordinates: [lon: number, lat: number, depthKm: number | null];
  } | null;
}

export interface UsgsFeed {
  metadata?: { generated?: number; title?: string; count?: number };
  features: UsgsFeature[];
}

/** The feeds that answered, in `USGS_FEEDS` order. */
export interface QuakesRaw {
  feeds: UsgsFeed[];
}

const ATTRIBUTION: Attribution = {
  text: "Credit: U.S. Geological Survey",
  url: "https://earthquake.usgs.gov/",
};

const SCHEMA: readonly SchemaField[] = [
  { key: "label", label: "Place", type: "string" },
  { key: "magnitude", label: "Magnitude", type: "number" },
  { key: "magType", label: "Magnitude type", type: "string" },
  { key: "depthKm", label: "Depth", type: "number", unit: "km" },
  { key: "timeMs", label: "Time", type: "time" },
  { key: "felt", label: "Felt reports", type: "number" },
  { key: "alert", label: "PAGER alert", type: "string" },
  { key: "tsunami", label: "Tsunami message issued", type: "boolean" },
  { key: "significance", label: "Significance", type: "number" },
  { key: "status", label: "Review status", type: "string" },
  { key: "url", label: "USGS event page", type: "url" },
];

/** PAGER alert colour to the `category` code: 0 none, 1 green, 2 yellow, 3 orange, 4 red. */
export function alertLevel(alert: string | null | undefined): number {
  switch (alert) {
    case "green":
      return 1;
    case "yellow":
      return 2;
    case "orange":
      return 3;
    case "red":
      return 4;
    default:
      return 0;
  }
}

/** "M5.8", always one decimal, as seismologists write it. */
export function formatMagnitude(mag: number): string {
  return `M${mag.toFixed(1)}`;
}

/**
 * A plain ticker sentence from a USGS place string: "M6.4 earthquake near
 * Lata, Solomon Islands". USGS writes places as "30 km WSW of Lata, Solomon
 * Islands", as a bare region ("Fiji region", "central Mid-Atlantic Ridge") or
 * already with a preposition ("off the coast of Oregon").
 */
export function quakeTitle(mag: number, place: string | null | undefined): string {
  const head = `${formatMagnitude(mag)} earthquake`;
  const where = (place ?? "").trim();
  if (!where) return head;
  const offset = /^\d+(?:\.\d+)?\s*km\s+[NSEW]{1,3}\s+of\s+(.+)$/i.exec(where);
  if (offset) return `${head} near ${offset[1]}`;
  if (
    /^(?:(?:north|south|east|west|northeast|northwest|southeast|southwest)\s+of|off|near|in|on)\b/i.test(
      where,
    )
  ) {
    return `${head} ${where[0].toLowerCase()}${where.slice(1)}`;
  }
  // Regions and sea-floor features read naturally with an article.
  const bare = where.replace(/^the\s+/i, "");
  if (/\b(?:Ridge|Rise)$/i.test(bare)) return `${head} on the ${bare}`;
  if (/\b(?:region|Ocean|Sea|Gulf|Strait|Trench|Fracture Zone|Basin|Passage)$/i.test(bare))
    return `${head} in the ${bare}`;
  return `${head} near ${where}`;
}

/** Ticker severity from magnitude: under 6 routine, 6 to 6.9 notable, 7 and above major. */
export function quakeSeverity(mag: number): 0 | 1 | 2 {
  return mag >= 7 ? 2 : mag >= 6 ? 1 : 0;
}

function usable(feature: UsgsFeature | null | undefined): feature is UsgsFeature {
  if (!feature || typeof feature.id !== "string" || !feature.properties || !feature.geometry)
    return false;
  const p = feature.properties;
  const c = feature.geometry.coordinates;
  return (
    // The feeds also carry quarry blasts, explosions and the like; this layer is earthquakes.
    (p.type === undefined || p.type === "earthquake") &&
    typeof p.mag === "number" &&
    Number.isFinite(p.mag) &&
    typeof p.time === "number" &&
    Number.isFinite(p.time) &&
    Array.isArray(c) &&
    Number.isFinite(c[0]) &&
    Number.isFinite(c[1]) &&
    c[1] >= -90 &&
    c[1] <= 90
  );
}

/** Merge the feeds, keeping the most recently updated copy of each event, oldest event first. */
export function mergeFeeds(feeds: readonly UsgsFeed[], now: number): UsgsFeature[] {
  const byId = new Map<string, UsgsFeature>();
  for (const feed of feeds) {
    if (!feed || !Array.isArray(feed.features)) continue;
    for (const feature of feed.features) {
      // An event later than the shown moment has not happened yet when scrubbing.
      if (!usable(feature) || feature.properties.time > now) continue;
      const known = byId.get(feature.id);
      if (!known || (feature.properties.updated ?? 0) > (known.properties.updated ?? 0))
        byId.set(feature.id, feature);
    }
  }
  return [...byId.values()].sort(
    (a, b) => a.properties.time - b.properties.time || (a.id < b.id ? -1 : 1),
  );
}

function normaliseQuakes(
  raw: QuakesRaw,
  now: number,
): { update: EntityUpdate; events: HaloEvent[] } {
  const features = mergeFeeds(raw.feeds, now);
  const n = features.length;
  const c = createColumns(n);
  const meta: EntityMeta[] = [];
  const events: HaloEvent[] = [];

  for (let i = 0; i < n; i++) {
    const feature = features[i];
    const p = feature.properties;
    const [lon, lat, depth] = feature.geometry!.coordinates;
    const mag = p.mag as number;
    const depthKm = typeof depth === "number" && Number.isFinite(depth) ? depth : 0;
    const id = hashId(feature.id);
    // USGS longitudes are already -180..180; fold any stray value rather than trust it.
    const lonWrapped = lon > 180 || lon < -180 ? ((((lon + 180) % 360) + 360) % 360) - 180 : lon;

    c.ids[i] = id;
    c.lon[i] = lonWrapped;
    c.lat[i] = lat;
    c.alt[i] = -depthKm * 1000;
    c.fixTimeMs[i] = p.time;
    c.value[i] = mag;
    c.category[i] = alertLevel(p.alert);

    const place = p.place?.trim() || "Unnamed location";
    meta[i] = {
      label: place,
      magnitude: mag,
      magType: p.magType ?? null,
      depthKm: Math.round(depthKm * 10) / 10,
      timeMs: p.time,
      felt: typeof p.felt === "number" ? p.felt : null,
      alert: p.alert ?? null,
      tsunami: p.tsunami === 1,
      significance: typeof p.sig === "number" ? p.sig : null,
      status: p.status ?? null,
      url: p.url ?? `https://earthquake.usgs.gov/earthquakes/eventpage/${feature.id}`,
    };

    if (mag >= EVENT_MIN_MAGNITUDE && now - p.time <= EVENT_WINDOW_MS) {
      const depthText = `${Math.round(depthKm)} km deep`;
      events.push({
        id: `quake:${feature.id}`,
        topic: "quake",
        timeMs: p.time,
        title: quakeTitle(mag, p.place),
        detail: p.place ? `${place}, ${depthText}` : depthText,
        lon: lonWrapped,
        lat,
        ref: { kind: EntityKind.Quake, id },
        severity: quakeSeverity(mag),
      });
    }
  }

  return {
    update: {
      kind: EntityKind.Quake,
      source: SOURCE_ID,
      timeMs: now,
      full: true,
      count: n,
      columns: c,
      meta,
    },
    events,
  };
}

async function fetchFeed(ctx: SourceContext, name: string): Promise<UsgsFeed> {
  const text = await fetchText(ctx, `${FEED_BASE}/${name}.geojson`, "USGS");
  let feed: unknown;
  try {
    feed = JSON.parse(text);
  } catch {
    throw new SourceError("bad-data", "USGS sent an earthquake feed that could not be read.");
  }
  if (typeof feed !== "object" || feed === null || !Array.isArray((feed as UsgsFeed).features)) {
    throw new SourceError("bad-data", "USGS sent an earthquake feed that could not be read.");
  }
  return feed as UsgsFeed;
}

export const usgsQuakes: SourcePlugin<QuakesRaw> = defineSource<QuakesRaw>({
  id: SOURCE_ID,
  name: "USGS Earthquake Hazards Program",
  layer: "quakes",
  transport: "fetch",
  schema: SCHEMA,
  refreshRate: 60_000,
  licence: {
    name: "Public domain (U.S. Geological Survey)",
    url: "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits",
    display: true,
    redistribution: true,
    commercial: true,
    notes:
      "USGS-authored data are in the U.S. public domain. USGS asks for the credit line. Feeds are regenerated every minute; do not poll faster.",
    verified: "2026-11-14",
  },
  attribution: ATTRIBUTION,
  docs: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php",

  async fetch(ctx) {
    const results = await Promise.allSettled(USGS_FEEDS.map((name) => fetchFeed(ctx, name)));
    // The past-day feed is the layer; without it there is nothing honest to show.
    if (results[0].status === "rejected") throw results[0].reason;
    const feeds: UsgsFeed[] = [];
    for (const result of results) if (result.status === "fulfilled") feeds.push(result.value);
    return { feeds };
  },

  normalise(raw, ctx) {
    const { update, events } = normaliseQuakes(raw, ctx.now());
    return { type: "entities", update, events };
  },

  detail(_id, meta) {
    if (!meta) return { attribution: ATTRIBUTION };
    const mag = typeof meta.magnitude === "number" ? meta.magnitude : null;
    const parts: string[] = [];
    if (mag !== null)
      parts.push(`Magnitude ${mag.toFixed(1)}${meta.magType ? ` (${meta.magType})` : ""}`);
    if (typeof meta.depthKm === "number") parts.push(`${Math.round(meta.depthKm)} km deep`);
    if (typeof meta.timeMs === "number") parts.push(formatUtc(meta.timeMs));
    return {
      subtitle: parts.join(", "),
      fields: detailFields(SCHEMA, meta).filter((field) => field.key !== "timeMs"),
      sourceUrl: typeof meta.url === "string" ? meta.url : undefined,
      attribution: ATTRIBUTION,
    };
  },
});

export default usgsQuakes;
