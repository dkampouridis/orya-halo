/**
 * Wildfires: NASA FIRMS active fire detections (near real-time).
 *
 * What is requested: the area CSV endpoint for the whole world, MODIS, two UTC
 * days. Two days because DAY_RANGE=1 means "today, UTC" and holds almost
 * nothing just after midnight; the last 24 hours are cut out of it here.
 *
 * Why MODIS by default: on 2026-11-14 FIRMS's world file was 0.9 MB (12,117
 * detections) for MODIS against 5.7 to 6.2 MB (roughly 70,000, judged from the
 * file size) for each VIIRS satellite. MODIS sees at 1 km and misses small fires that VIIRS (375 m)
 * catches, but a globe view cannot show that difference and the download is a
 * sixth of the size. Change `source` to a VIIRS product when MODIS retires or
 * when the gateway does the thinning.
 *
 * Thinning, so the layer stays light at any season:
 * 1. drop low-confidence detections;
 * 2. merge detections into 0.1 degree cells (about 11 km), each represented by
 *    its strongest detection, with the number merged kept in `detections`;
 * 3. if more than `maxPoints` cells remain, keep those with the highest fire
 *    radiative power.
 * Measured on the recorded day: 6,477 detections in 24 hours become 2,868 points.
 *
 * The key: FIRMS error responses and static files carry no CORS headers, and a
 * key shipped to browsers is shared by every visitor and can be exhausted or
 * revoked by any of them. So this plugin is meant to run where `ctx.fetch` is
 * not bound by CORS and the key stays private (the gateway, a build step), or
 * with `proxyUrl` pointing at a proxy that adds the key. It still works in a
 * browser if NASA enables CORS and the deployment accepts exposing its key.
 */
import { EntityKind, createColumns, defineSource } from "@orya-halo/schema";
import type {
  Attribution,
  EntityMeta,
  EntityUpdate,
  SchemaField,
  SourceContext,
  SourcePlugin,
} from "@orya-halo/schema";
import { columnIndexes, parseCsv } from "../shared/space-earth/csv.ts";
import { detailFields, formatUtc } from "../shared/space-earth/detail.ts";
import { SourceError, fetchText, firstLine } from "../shared/space-earth/errors.ts";

/** FIRMS near real-time products with worldwide coverage. */
export type FirmsSource = "MODIS_NRT" | "VIIRS_NOAA20_NRT" | "VIIRS_NOAA21_NRT" | "VIIRS_SNPP_NRT";

export interface FirmsOptions {
  /** Product to request. Default "MODIS_NRT". */
  source?: FirmsSource;
  /**
   * Base URL of a proxy that holds the map key. When set, the plugin needs no
   * key and requests `{proxyUrl}/{source}/world/{days}`; the proxy forwards to
   * `https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/{source}/world/{days}`.
   */
  proxyUrl?: string;
  /** Most points to emit. Default 5000. */
  maxPoints?: number;
  /** Size of the merge cells in degrees. Default 0.1. */
  cellDeg?: number;
}

/** What `fetch` returns: the provider's CSV, untouched. */
export interface FiresRaw {
  source: string;
  csv: string;
}

/** Confidence classes in the `category` column. */
export const FireConfidence = { Unknown: 0, Low: 1, Nominal: 2, High: 3 } as const;

export const FIRMS_KEY_VARIABLE = "VITE_FIRMS_MAP_KEY";
const FIRMS_API = "https://firms.modaps.eosdis.nasa.gov/api/area/csv";
const DAY_MS = 86_400_000;
/** UTC days requested, so that the last 24 hours are always covered. */
const DAY_RANGE = 2;
const CONFIDENCE_LABEL = ["unknown", "low", "nominal", "high"] as const;

const ATTRIBUTION: Attribution = {
  text: "Active fire data: NASA FIRMS",
  url: "https://firms.modaps.eosdis.nasa.gov/",
};

const SCHEMA: readonly SchemaField[] = [
  { key: "label", label: "Location", type: "string" },
  { key: "frpMw", label: "Fire radiative power", type: "number", unit: "MW" },
  { key: "confidence", label: "Confidence", type: "string" },
  { key: "confidencePct", label: "Confidence score", type: "number", unit: "%" },
  { key: "timeMs", label: "Observed", type: "time" },
  { key: "satellite", label: "Satellite", type: "string" },
  { key: "instrument", label: "Instrument", type: "string" },
  { key: "dayNight", label: "Pass", type: "string" },
  { key: "brightnessK", label: "Brightness temperature", type: "number", unit: "K" },
  { key: "detections", label: "Detections merged", type: "number" },
];

const SATELLITES: Record<string, { name: string; instrument: string }> = {
  T: { name: "Terra", instrument: "MODIS" },
  TERRA: { name: "Terra", instrument: "MODIS" },
  A: { name: "Aqua", instrument: "MODIS" },
  AQUA: { name: "Aqua", instrument: "MODIS" },
  N: { name: "Suomi NPP", instrument: "VIIRS" },
  SNPP: { name: "Suomi NPP", instrument: "VIIRS" },
  N20: { name: "NOAA-20", instrument: "VIIRS" },
  "1": { name: "NOAA-20", instrument: "VIIRS" },
  N21: { name: "NOAA-21", instrument: "VIIRS" },
  "2": { name: "NOAA-21", instrument: "VIIRS" },
  L8: { name: "Landsat 8", instrument: "OLI" },
  L9: { name: "Landsat 9", instrument: "OLI" },
};

/**
 * Confidence class and, for MODIS, the 0..100 score. MODIS reports a score
 * (FIRMS reads under 30 as low and 80 or more as high); VIIRS reports the
 * class itself as low, nominal or high, sometimes abbreviated to one letter.
 */
export function parseConfidence(cell: string | undefined): { level: number; pct: number | null } {
  const text = (cell ?? "").trim().toLowerCase();
  if (text === "") return { level: FireConfidence.Unknown, pct: null };
  if (text === "l" || text === "low") return { level: FireConfidence.Low, pct: null };
  if (text === "n" || text === "nominal") return { level: FireConfidence.Nominal, pct: null };
  if (text === "h" || text === "high") return { level: FireConfidence.High, pct: null };
  const pct = Number(text);
  if (!Number.isFinite(pct)) return { level: FireConfidence.Unknown, pct: null };
  return {
    level: pct < 30 ? FireConfidence.Low : pct < 80 ? FireConfidence.Nominal : FireConfidence.High,
    pct,
  };
}

/** Acquisition time from FIRMS `acq_date` ("2026-11-14") and `acq_time` ("0017" or "17", UTC). */
export function parseAcquisition(date: string | undefined, time: string | undefined): number {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec((date ?? "").trim());
  if (!d) return Number.NaN;
  // FIRMS drops leading zeros in some files: "17" is 00:17.
  const digits = (time ?? "").trim().replace(":", "");
  if (!/^\d{1,4}$/.test(digits)) return Number.NaN;
  const hhmm = digits.padStart(4, "0");
  return Date.UTC(
    Number(d[1]),
    Number(d[2]) - 1,
    Number(d[3]),
    Number(hhmm.slice(0, 2)),
    Number(hhmm.slice(2, 4)),
  );
}

/** A cell as a number. An empty or missing cell is NaN, where `Number("")` would say 0. */
function numberOf(cell: string | undefined): number {
  return cell === undefined || cell.trim() === "" ? Number.NaN : Number(cell);
}

function coordinateLabel(lat: number, lon: number): string {
  return `Fire at ${Math.abs(lat).toFixed(2)}°${lat < 0 ? "S" : "N"}, ${Math.abs(lon).toFixed(2)}°${lon < 0 ? "W" : "E"}`;
}

interface Thinning {
  maxPoints: number;
  cellDeg: number;
}

function normaliseFires(
  raw: FiresRaw,
  now: number,
  sourceId: string,
  thinning: Thinning,
): EntityUpdate {
  const table = parseCsv(raw.csv);
  const col = columnIndexes(table.header, [
    "latitude",
    "longitude",
    "acq_date",
    "acq_time",
    "satellite",
    "instrument",
    "confidence",
    "frp",
    "daynight",
    "brightness",
    "bright_ti4",
    "type",
  ]);
  if (
    col.latitude < 0 ||
    col.longitude < 0 ||
    col.acq_date < 0 ||
    col.acq_time < 0 ||
    col.frp < 0
  ) {
    throw new SourceError(
      "bad-data",
      "NASA FIRMS sent something other than fire detections, so wildfires were not updated.",
    );
  }
  const brightnessCol = col.brightness >= 0 ? col.brightness : col.bright_ti4;

  const { cellDeg, maxPoints } = thinning;
  const cols = Math.round(360 / cellDeg);
  const rowsOfCells = Math.round(180 / cellDeg);
  // Cell id to the row that represents it and the number of detections merged into it.
  const best = new Map<number, number>();
  const bestFrp = new Map<number, number>();
  const merged = new Map<number, number>();
  const rows = table.rows;

  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r];
    const lat = numberOf(cells[col.latitude]);
    const lon = numberOf(cells[col.longitude]);
    const frp = numberOf(cells[col.frp]);
    if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180) || !(frp >= 0)) continue;
    // Standard-processing files mark volcanoes and static sources with a type; keep vegetation fires (0).
    if (
      col.type >= 0 &&
      cells[col.type] !== undefined &&
      cells[col.type].trim() !== "" &&
      Number(cells[col.type]) !== 0
    )
      continue;
    if (col.confidence >= 0 && parseConfidence(cells[col.confidence]).level === FireConfidence.Low)
      continue;
    const t = parseAcquisition(cells[col.acq_date], cells[col.acq_time]);
    if (!(t <= now && now - t <= DAY_MS)) continue;

    const cx = Math.min(cols - 1, Math.floor((lon + 180) / cellDeg));
    const cy = Math.min(rowsOfCells - 1, Math.floor((lat + 90) / cellDeg));
    const cell = cy * cols + cx + 1;
    merged.set(cell, (merged.get(cell) ?? 0) + 1);
    const known = bestFrp.get(cell);
    if (known === undefined || frp > known) {
      bestFrp.set(cell, frp);
      best.set(cell, r);
    }
  }

  // Strongest first to apply the cap, then weakest first so strong fires draw on top.
  let chosen = [...best.keys()];
  if (chosen.length > maxPoints) {
    chosen.sort((a, b) => (bestFrp.get(b) as number) - (bestFrp.get(a) as number) || a - b);
    chosen = chosen.slice(0, maxPoints);
  }
  chosen.sort((a, b) => (bestFrp.get(a) as number) - (bestFrp.get(b) as number) || a - b);

  const n = chosen.length;
  const c = createColumns(n);
  const meta: EntityMeta[] = [];
  for (let i = 0; i < n; i++) {
    const cell = chosen[i];
    const cells = rows[best.get(cell) as number];
    const lat = Number(cells[col.latitude]);
    const lon = Number(cells[col.longitude]);
    const frp = Number(cells[col.frp]);
    const t = parseAcquisition(cells[col.acq_date], cells[col.acq_time]);
    const confidence =
      col.confidence >= 0
        ? parseConfidence(cells[col.confidence])
        : { level: FireConfidence.Unknown, pct: null };
    const code = col.satellite >= 0 ? (cells[col.satellite] ?? "").trim() : "";
    const known = SATELLITES[code.toUpperCase()];
    const instrument =
      (col.instrument >= 0 ? (cells[col.instrument] ?? "").trim() : "") ||
      known?.instrument ||
      null;
    const pass = col.daynight >= 0 ? (cells[col.daynight] ?? "").trim().toUpperCase() : "";
    const brightness = brightnessCol >= 0 ? Number(cells[brightnessCol]) : Number.NaN;

    c.ids[i] = cell;
    c.lon[i] = lon;
    c.lat[i] = lat;
    c.fixTimeMs[i] = t;
    c.value[i] = frp;
    c.category[i] = confidence.level;
    meta[i] = {
      label: coordinateLabel(lat, lon),
      frpMw: frp,
      confidence: CONFIDENCE_LABEL[confidence.level],
      confidencePct: confidence.pct,
      timeMs: t,
      satellite: known?.name ?? (code || null),
      instrument,
      dayNight: pass === "D" ? "day" : pass === "N" ? "night" : null,
      brightnessK: Number.isFinite(brightness) ? brightness : null,
      detections: merged.get(cell) as number,
      lat,
      lon,
    };
  }

  return {
    kind: EntityKind.Fire,
    source: sourceId,
    timeMs: now,
    full: true,
    count: n,
    columns: c,
    meta,
  };
}

function needsKey(message: string): SourceError {
  return new SourceError("needs-key", message);
}

async function fetchFires(
  ctx: SourceContext,
  source: FirmsSource,
  proxyUrl: string | undefined,
): Promise<FiresRaw> {
  let url: string;
  if (proxyUrl) {
    url = `${proxyUrl.replace(/\/+$/, "")}/${source}/world/${DAY_RANGE}`;
  } else {
    const key = ctx.key?.trim();
    if (!key) {
      throw needsKey(
        `Wildfires need a free NASA FIRMS map key. Set ${FIRMS_KEY_VARIABLE} and reload.`,
      );
    }
    // FIRMS keys are 32 letters and digits; catching a bad paste here saves a request.
    if (!/^[0-9a-z]{32}$/i.test(key)) {
      throw needsKey(
        `The NASA FIRMS map key in ${FIRMS_KEY_VARIABLE} is not a valid key. Check it and reload.`,
      );
    }
    url = `${FIRMS_API}/${key}/${source}/world/${DAY_RANGE}`;
  }

  let csv: string;
  try {
    csv = await fetchText(ctx, url, "NASA FIRMS");
  } catch (error) {
    // FIRMS answers a rejected key with HTTP 400 "Invalid MAP_KEY." Behind a
    // proxy the key is the proxy's, not ours: its answer is passed on as it
    // is, so whoever configured the proxy can say what it means.
    if (
      !proxyUrl &&
      error instanceof SourceError &&
      /map_key/i.test(error.message) &&
      error.code !== "blocked"
    ) {
      throw needsKey(
        `NASA FIRMS rejected the map key in ${FIRMS_KEY_VARIABLE}. Check it and reload.`,
      );
    }
    throw error;
  }
  if (!/^﻿?\s*latitude,longitude,/i.test(csv)) {
    const said = firstLine(csv, 80);
    if (/map_key/i.test(said)) {
      // "exceeded" is the transaction limit (5000 per 10 minutes), the rest is a bad key.
      if (/exceed|limit/i.test(said))
        throw new SourceError(
          "blocked",
          "NASA FIRMS says the map key is over its request limit. Wildfires will retry later.",
        );
      if (proxyUrl)
        throw needsKey(
          "NASA FIRMS rejected the map key held by the wildfire proxy. Check the key on the proxy.",
        );
      throw needsKey(
        `NASA FIRMS rejected the map key in ${FIRMS_KEY_VARIABLE}. Check it and reload.`,
      );
    }
    throw new SourceError(
      "bad-data",
      "NASA FIRMS sent something other than fire detections, so wildfires were not updated.",
    );
  }
  return { source, csv };
}

/** Build a FIRMS plugin. `firms` is the default configuration. */
export function createFirmsSource(options: FirmsOptions = {}): SourcePlugin<FiresRaw> {
  const source = options.source ?? "MODIS_NRT";
  const proxyUrl = options.proxyUrl;
  const thinning: Thinning = {
    maxPoints: Math.max(1, Math.floor(options.maxPoints ?? 5000)),
    cellDeg: options.cellDeg && options.cellDeg > 0 ? options.cellDeg : 0.1,
  };
  const id = "nasa-firms";

  return defineSource<FiresRaw>({
    id,
    name: "NASA FIRMS",
    layer: "fires",
    transport: "fetch",
    schema: SCHEMA,
    // Detections arrive up to 3 hours after a satellite pass and each place is
    // passed a few times a day, so half an hour loses nothing. A world request
    // is heavy for FIRMS to generate; the limit is 5000 transactions per 10 minutes.
    refreshRate: 30 * 60_000,
    cacheTtl: 20 * 60_000,
    ...(proxyUrl ? {} : { requiresKey: FIRMS_KEY_VARIABLE }),
    licence: {
      name: "NASA open data (FIRMS, LANCE); not copyrighted",
      url: "https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance",
      display: true,
      redistribution: true,
      commercial: true,
      notes:
        "NASA asks to be acknowledged (cite as NASA FIRMS) and that use does not imply endorsement. Near real-time data are not for decisions about life or property. A free map key is required: 5000 transactions per 10 minutes, larger requests count as several. Keep the key out of browser code.",
      verified: "2026-11-14",
    },
    attribution: ATTRIBUTION,
    docs: "https://firms.modaps.eosdis.nasa.gov/api/area/",

    fetch(ctx) {
      return fetchFires(ctx, source, proxyUrl);
    },

    normalise(raw, ctx) {
      return { type: "entities", update: normaliseFires(raw, ctx.now(), id, thinning) };
    },

    detail(_id, meta) {
      if (!meta) return { attribution: ATTRIBUTION };
      const seen: string[] = [];
      if (meta.instrument && meta.satellite)
        seen.push(`Seen by ${meta.instrument} on ${meta.satellite}`);
      else if (meta.satellite) seen.push(`Seen by ${meta.satellite}`);
      if (meta.dayNight) seen.push(`${meta.dayNight} pass`);
      if (typeof meta.timeMs === "number") seen.push(formatUtc(meta.timeMs));
      const lat = Number(meta.lat);
      const lon = Number(meta.lon);
      return {
        subtitle: seen.join(", "),
        fields: detailFields(SCHEMA, meta).filter((field) => field.key !== "timeMs"),
        // The same spot on NASA's own fire map, as the FIRMS FAQ suggests.
        sourceUrl:
          Number.isFinite(lat) && Number.isFinite(lon)
            ? `https://firms.modaps.eosdis.nasa.gov/map/#d:24hrs;@${lon.toFixed(2)},${lat.toFixed(2)},10.00z`
            : "https://firms.modaps.eosdis.nasa.gov/map/",
        attribution: ATTRIBUTION,
      };
    },
  });
}

export const firms: SourcePlugin<FiresRaw> = createFirmsSource();

export default firms;
