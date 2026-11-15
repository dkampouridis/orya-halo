/**
 * Satellites: CelesTrak GP element sets, propagated locally with SGP4.
 *
 * The element sets are downloaded rarely (CelesTrak allows one download per
 * update, and updates every two hours); positions are recomputed from them
 * every second for whatever moment `ctx.now()` names, so the time scrubber
 * works without any stored history.
 *
 * Format: OMM in CSV. Measured on the active group on 2026-11-14 (16,894
 * objects): CSV is 2.55 MB (0.96 MB gzipped) against 7.15 MB for the same data
 * as JSON, and both parse in about 15 ms. TLE is not an option: catalogue
 * numbers passed 99999 in July 2026 and TLE cannot carry them.
 */
import { EntityFlag, EntityKind, createColumns, defineSource } from "@orya-halo/schema";
import type {
  Attribution,
  EntityMeta,
  EntityUpdate,
  SchemaField,
  SourceContext,
  SourcePlugin,
  Track,
} from "@orya-halo/schema";
import { detailFields } from "../shared/space-earth/detail.ts";
import { SourceError, firstSentence } from "../shared/space-earth/errors.ts";
import { buildCatalogue } from "./catalogue.ts";
import type { SatelliteCatalogue } from "./catalogue.ts";
import { SIDEREAL_DAY_MIN } from "./orbit.ts";
import { createFix, gmstAt, propagateFix } from "./propagate.ts";

export { buildCatalogue } from "./catalogue.ts";
export type { SatelliteCatalogue } from "./catalogue.ts";
export { ORBIT_LABEL, classifySatellite, launchYear, orbitFacts } from "./orbit.ts";
export type { OrbitClass, OrbitFacts } from "./orbit.ts";
export { createFix, epochMsOf, gmstAt, propagateFix } from "./propagate.ts";
export type { SatFix } from "./propagate.ts";

const SOURCE_ID = "celestrak-gp";
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Every active payload, one request. Starlink and the other groups are
 * subsets of it, and CelesTrak asks clients not to download both.
 */
export const CELESTRAK_GP_URL =
  "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=CSV";

/** SGP4 drifts kilometres per day from the element epoch; past this the fix is only a rough guide. */
const STALE_ELEMENTS_MS = 30 * DAY_MS;

const ATTRIBUTION: Attribution = {
  text: "Satellite orbits: CelesTrak, from U.S. Space Force GP data",
  url: "https://celestrak.org/",
};

const SCHEMA: readonly SchemaField[] = [
  { key: "label", label: "Name", type: "string" },
  { key: "noradId", label: "NORAD id", type: "number" },
  { key: "intlDes", label: "International designator", type: "string" },
  { key: "launchYear", label: "Launch year", type: "number" },
  { key: "orbit", label: "Orbit", type: "string" },
  { key: "inclinationDeg", label: "Inclination", type: "number", unit: "°" },
  { key: "periodMin", label: "Period", type: "number", unit: "min" },
  { key: "apogeeKm", label: "Apogee", type: "number", unit: "km" },
  { key: "perigeeKm", label: "Perigee", type: "number", unit: "km" },
  { key: "eccentricity", label: "Eccentricity", type: "number" },
  { key: "epochMs", label: "Elements measured", type: "time" },
];

/** Scratch fix reused by every propagation; nothing reads it across calls. */
const FIX = createFix();

function normaliseCatalogue(raw: SatelliteCatalogue, now: number): EntityUpdate {
  const n = raw.count;
  const c = createColumns(n);
  const gmst = gmstAt(now);
  const cosGmst = Math.cos(gmst);
  const sinGmst = Math.sin(gmst);
  const { satrecs, epochMs, ids, category, periodMin } = raw;
  // Shared with the catalogue until an object has to be skipped.
  let meta: EntityMeta[] = raw.meta;
  let k = 0;

  for (let i = 0; i < n; i++) {
    const age = now - epochMs[i];
    if (!propagateFix(satrecs[i], age / 60_000, cosGmst, sinGmst, FIX)) {
      if (meta === raw.meta) meta = raw.meta.slice(0, k);
      continue;
    }
    c.ids[k] = ids[i];
    c.lon[k] = FIX.lon;
    c.lat[k] = FIX.lat;
    c.alt[k] = FIX.alt;
    c.heading[k] = FIX.heading;
    c.speed[k] = FIX.speed;
    c.vrate[k] = FIX.vrate;
    c.fixTimeMs[k] = now;
    c.category[k] = category[i];
    c.flags[k] = age > STALE_ELEMENTS_MS || age < -STALE_ELEMENTS_MS ? EntityFlag.Stale : 0;
    c.value[k] = periodMin[i];
    if (meta !== raw.meta) meta.push(raw.meta[i]);
    k++;
  }

  if (k < n) {
    c.ids = c.ids.slice(0, k);
    c.lon = c.lon.slice(0, k);
    c.lat = c.lat.slice(0, k);
    c.alt = c.alt.slice(0, k);
    c.heading = c.heading.slice(0, k);
    c.speed = c.speed.slice(0, k);
    c.vrate = c.vrate.slice(0, k);
    c.fixTimeMs = c.fixTimeMs.slice(0, k);
    c.category = c.category.slice(0, k);
    c.flags = c.flags.slice(0, k);
    c.value = c.value.slice(0, k);
  }

  return {
    kind: EntityKind.Satellite,
    source: SOURCE_ID,
    timeMs: now,
    full: true,
    count: k,
    columns: c,
    meta,
  };
}

/**
 * Ground track of one object across one revolution centred on `now`. Orbits
 * slower than the Earth turns (beyond geosynchronous) are shown for one
 * sidereal day instead: longer than that the track is the Earth's rotation
 * drawn over and over, not the orbit.
 */
function orbitTrack(raw: SatelliteCatalogue, id: number, now: number): Track | null {
  const i = raw.ids.indexOf(id);
  if (i < 0) return null;
  const period = raw.periodMin[i];
  if (!(period > 0)) return null;
  const spanMin = Math.min(period, SIDEREAL_DAY_MIN);
  // Eccentric orbits sweep fast through perigee and need the finer step.
  const segments = raw.eccentricity[i] > 0.1 ? 360 : 180;
  const stepMs = (spanMin * 60_000) / segments;
  const startMs = now - (spanMin * 60_000) / 2;
  const satrec = raw.satrecs[i];
  const epoch = raw.epochMs[i];

  const positions = new Float32Array((segments + 1) * 3);
  const timesMs = new Float64Array(segments + 1);
  const fix = createFix();
  let k = 0;
  for (let s = 0; s <= segments; s++) {
    const t = startMs + s * stepMs;
    const gmst = gmstAt(t);
    if (!propagateFix(satrec, (t - epoch) / 60_000, Math.cos(gmst), Math.sin(gmst), fix)) continue;
    positions[k * 3] = fix.lon;
    positions[k * 3 + 1] = fix.lat;
    positions[k * 3 + 2] = fix.alt;
    timesMs[k] = t;
    k++;
  }
  if (k < 2) return null;
  return {
    ref: { kind: EntityKind.Satellite, id },
    count: k,
    positions: k === segments + 1 ? positions : positions.slice(0, k * 3),
    timesMs: k === segments + 1 ? timesMs : timesMs.slice(0, k),
  };
}

/** Where a catalogue the plugin handed over came from. */
export type ElementsOrigin =
  /** The element source answered: CelesTrak or the proxy, or the runner's copy of its last answer still within `cacheTtl`. */
  | "live"
  /** An older copy of the element source's answer, kept by the runner. */
  | "cache"
  /** The copy shipped with the app. */
  | "snapshot";

/** What `fetch` and `fallback` return: a catalogue, and where and when its elements are from. */
export interface SatelliteElements extends SatelliteCatalogue {
  origin: ElementsOrigin;
  /** Median element epoch, Unix milliseconds: the moment the catalogue describes. */
  elementsMs: number;
}

export interface CelestrakSourceOptions {
  /**
   * Where current elements come from: CelesTrak itself (the default), or a
   * cache in front of it that answers with the same OMM CSV, such as the
   * gateway's `/v1/proxy/celestrak/active.csv`.
   */
  url?: string;
  /** A copy of the same file shipped with the app, used when nothing newer can be had. */
  fallbackUrl?: string;
}

/** Elements older than this are called out in the layer message. */
const OLD_ELEMENTS_MS = 14 * DAY_MS;

const DAY_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});
const DAY_YEAR_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/** What the layer says while it shows elements that are not current: their date, and their age once that matters. */
export function fallbackMessage(elementsMs: number, now: number): string {
  const sameYear = new Date(elementsMs).getUTCFullYear() === new Date(now).getUTCFullYear();
  const day = (sameYear ? DAY_FORMAT : DAY_YEAR_FORMAT).format(elementsMs);
  const ageDays = Math.floor((now - elementsMs) / DAY_MS);
  const age =
    now - elementsMs >= OLD_ELEMENTS_MS
      ? ` They are ${ageDays} days old, so positions are only a rough guide.`
      : "";
  return `Showing satellite orbits from ${day}.${age} Fresher data is temporarily unavailable.`;
}

function medianOf(values: Float64Array): number {
  const sorted = Float64Array.from(values).sort();
  return sorted[sorted.length >> 1];
}

/** The `{"error":{"message":"..."}}` sentence an Orya Halo proxy answers with, if that is what `body` is. */
function proxyMessage(body: string): string | null {
  try {
    const message = (JSON.parse(body) as { error?: { message?: unknown } }).error?.message;
    return typeof message === "string" && message.trim() !== "" ? message.trim() : null;
  } catch {
    return null;
  }
}

/**
 * GET an OMM CSV. Like `fetchText`, any status other than 200 is a
 * `SourceError` ("blocked" for 403 and 429), and the provider's own sentence
 * is carried; a proxy's JSON error is read for its message.
 */
async function fetchElements(
  ctx: Pick<SourceContext, "fetch" | "signal">,
  url: string,
  provider: string,
): Promise<string> {
  const response = await ctx.fetch(url, { signal: ctx.signal });
  if (response.status === 200) return response.text();
  let said = "";
  try {
    const body = await response.text();
    said = proxyMessage(body) ?? firstSentence(body);
  } catch {
    // The status alone is enough to report.
  }
  const tail = said ? `: ${said}` : ".";
  if (response.status === 403 || response.status === 429) {
    throw new SourceError(
      "blocked",
      `${provider} refused the request (HTTP ${response.status})${tail}`,
      response.status,
    );
  }
  throw new SourceError(
    "http",
    `${provider} answered HTTP ${response.status}${tail}`,
    response.status,
  );
}

function elementsOf(csv: string, origin: ElementsOrigin, provider: string): SatelliteElements {
  const catalogue = buildCatalogue(csv);
  if (catalogue.count === 0) {
    throw new SourceError(
      "bad-data",
      `${provider} sent no usable orbital elements, so satellites were not updated.`,
    );
  }
  return Object.assign(catalogue, { origin, elementsMs: medianOf(catalogue.epochMs) });
}

/**
 * The satellite source. Elements come from `url` (CelesTrak unless told
 * otherwise); `fallback` offers, in this order, the runner's older copy of
 * that answer and the bundled `fallbackUrl`, so satellites appear even when
 * CelesTrak has refused this address for the next two hours.
 */
export function createCelestrakSource(
  options: CelestrakSourceOptions = {},
): SourcePlugin<SatelliteCatalogue> {
  const url = options.url ?? CELESTRAK_GP_URL;
  const fallbackUrl = options.fallbackUrl;
  const provider = /(^|\.)celestrak\.org$/i.test(new URL(url, "https://halo.invalid/").hostname)
    ? "CelesTrak"
    : "The satellite element proxy";
  const SNAPSHOT = "The bundled satellite snapshot";

  return defineSource<SatelliteCatalogue>({
    ...PLUGIN,

    async fetch(ctx): Promise<SatelliteElements> {
      return elementsOf(await fetchElements(ctx, url, provider), "live", provider);
    },

    async fallback(ctx) {
      let elements: SatelliteElements | null = null;
      let failure: unknown = null;
      try {
        // Only ever an older copy here: the runner's fallback context never asks the network.
        elements = elementsOf(await fetchElements(ctx, url, provider), "cache", provider);
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        failure = error;
      }
      // The bundled file may be newer than a copy kept from a visit long ago.
      if (
        fallbackUrl !== undefined &&
        (elements === null || ctx.now() - elements.elementsMs >= OLD_ELEMENTS_MS)
      ) {
        try {
          const snapshot = elementsOf(
            await fetchElements(ctx, fallbackUrl, SNAPSHOT),
            "snapshot",
            SNAPSHOT,
          );
          if (elements === null || snapshot.elementsMs > elements.elementsMs) elements = snapshot;
        } catch (error) {
          if (ctx.signal.aborted) throw error;
          failure = error;
        }
      }
      if (elements === null)
        throw (
          failure ??
          new SourceError("http", "No copy of the satellite orbits is available offline.")
        );
      return { raw: elements, message: fallbackMessage(elements.elementsMs, ctx.now()) };
    },
  });
}

/** Everything about the source except where its elements come from. */
const PLUGIN: Omit<SourcePlugin<SatelliteCatalogue>, "fetch" | "fallback"> = {
  id: SOURCE_ID,
  name: "CelesTrak",
  layer: "satellites",
  transport: "compute",
  schema: SCHEMA,
  // CelesTrak checks for new data every 2 hours and serves a group once per
  // update to each IP address; the underlying U.S. Space Force data changes 2 to
  // 3 times a day. Six hours keeps elements fresh and leaves a wide margin.
  refreshRate: 6 * HOUR_MS,
  // Never ask again within one update cycle plus margin, even after a reload:
  // a second request gets HTTP 403 and repeated ones get the address blocked.
  cacheTtl: 3 * HOUR_MS,
  // Measured in Node 24: 16,892 objects propagate in 11.5 ms, so once a second costs about 1.2% of a core.
  recomputeRate: 1000,
  licence: {
    name: "CelesTrak usage policy (no formal licence; U.S. Government GP data)",
    url: "https://celestrak.org/usage-policy.php",
    display: true,
    redistribution: true,
    commercial: true,
    notes:
      "Free for all users; CelesTrak publishes a usage policy rather than a licence. Download a group at most once per update (every 2 hours); a repeat gets HTTP 403. Stop on any non-200 response: 50 errors in 2 hours puts the address in the firewall. Deployments with many users behind one address should cache through their own proxy: the gateway's /v1/proxy/celestrak is one. A copy of the active group ships with the web app as a fallback.",
    verified: "2026-11-14",
  },
  attribution: ATTRIBUTION,
  docs: "https://celestrak.org/NORAD/documentation/gp-data-formats.php",

  normalise(raw, ctx) {
    return { type: "entities", update: normaliseCatalogue(raw, ctx.now()) };
  },

  track(raw, id, ctx) {
    return orbitTrack(raw, id, ctx.now());
  },

  detail(id, meta) {
    return {
      subtitle: typeof meta?.orbit === "string" ? meta.orbit : undefined,
      fields: detailFields(SCHEMA, meta).filter((field) => field.key !== "orbit"),
      // CelesTrak's catalogue page for the object: owner, launch site, status.
      sourceUrl: `https://celestrak.org/satcat/table-satcat.php?CATNR=${id}`,
      attribution: ATTRIBUTION,
    };
  },
};

/** Elements straight from CelesTrak, with only the runner's own copy to fall back on. */
export const celestrak: SourcePlugin<SatelliteCatalogue> = createCelestrakSource();

export default celestrak;
