/**
 * NASA GIBS (Global Imagery Browse Services) access, shared by the satellite
 * imagery plugin and the IMERG precipitation plugin.
 *
 * Everything here targets the Web-Mercator "best" endpoint. Verified
 * 2026-11-14 against
 * https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml
 * and https://nasa-gibs.github.io/gibs-api-docs/access-basics/.
 */
import type { Attribution, LicenceInfo, SourceContext } from "@orya-halo/schema";
import { fetchBody } from "./http.ts";

export const GIBS_BASE = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";

export const GIBS_DOCS = "https://nasa-gibs.github.io/gibs-api-docs/";

export const GIBS_LICENCE: LicenceInfo = {
  name: "NASA open data (no restrictions on use)",
  url: "https://www.earthdata.nasa.gov/engage/open-data-services-software-policies",
  display: true,
  redistribution: true,
  commercial: true,
  notes:
    "NASA asks for an acknowledgement of GIBS and ESDIS wherever the imagery is used. No key, no published rate limit; do not bulk-download tiles.",
  verified: "2026-11-14",
};

export const GIBS_ATTRIBUTION: Attribution = {
  text: "We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS).",
  url: "https://earthdata.nasa.gov/gibs/",
  onMap: false,
};

/** Short credit for places where the full acknowledgement does not fit. */
export const GIBS_SHORT_CREDIT = "Imagery: NASA GIBS / ESDIS";

export const DAY_MS = 86_400_000;

/** One GIBS visualisation layer on the Web-Mercator endpoint. */
export interface GibsLayer {
  /** Layer identifier, e.g. "VIIRS_NOAA20_CorrectedReflectance_TrueColor". */
  id: string;
  /** TileMatrixSet, e.g. "GoogleMapsCompatible_Level9". The level is the deepest zoom served. */
  matrixSet: string;
  maxZoom: number;
  format: "jpeg" | "png";
}

/**
 * XYZ template for one layer and time. GIBS orders the path as
 * TileMatrix/TileRow/TileCol, which is `{z}/{y}/{x}`.
 *
 * `time` is `YYYY-MM-DD` for daily layers and `YYYY-MM-DDTHH:MM:SSZ` for
 * sub-daily ones.
 */
export function gibsTileUrl(layer: GibsLayer, time: string): string {
  return `${GIBS_BASE}/${layer.id}/default/${time}/${layer.matrixSet}/{z}/{y}/{x}.${layer.format}`;
}

/**
 * URL of the WMTS DescribeDomains document for a time window: a few hundred
 * bytes listing the periods that really have imagery, instead of the 5.8 MB
 * capabilities file.
 */
export function gibsDomainsUrl(layer: GibsLayer, from: string, to: string): string {
  return `${GIBS_BASE}/1.0.0/${layer.id}/default/${layer.matrixSet}/all/${from}--${to}.xml`;
}

/** A run of evenly spaced times that have imagery. */
export interface TimeRange {
  startMs: number;
  endMs: number;
  stepMs: number;
}

/** `P1D`, `PT30M`, `PT6M`, `P1M` (taken as 30 days) to milliseconds. 0 if unreadable. */
export function parsePeriod(period: string): number {
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    period.trim(),
  );
  if (!m) return 0;
  const [, y, mo, d, h, mi, s] = m;
  return (
    Number(y ?? 0) * 365 * DAY_MS +
    Number(mo ?? 0) * 30 * DAY_MS +
    Number(d ?? 0) * DAY_MS +
    Number(h ?? 0) * 3_600_000 +
    Number(mi ?? 0) * 60_000 +
    Number(s ?? 0) * 1000
  );
}

/**
 * Read the time ranges out of a DescribeDomains document. Each `<Domain>`
 * holds one or more comma-separated `start/end/period` triples. Returns them
 * oldest first; an empty list when the document has none.
 */
export function parseGibsDomains(xml: string): TimeRange[] {
  const ranges: TimeRange[] = [];
  for (const match of xml.matchAll(/<Domain>([^<]*)<\/Domain>/g)) {
    for (const triple of match[1].split(",")) {
      const [start, end, period] = triple.trim().split("/");
      if (!start || !end || !period) continue;
      const startMs = Date.parse(start);
      const endMs = Date.parse(end);
      const stepMs = parsePeriod(period);
      if (Number.isNaN(startMs) || Number.isNaN(endMs) || stepMs <= 0 || endMs < startMs) continue;
      ranges.push({ startMs, endMs, stepMs });
    }
  }
  return ranges.sort((a, b) => a.startMs - b.startMs);
}

/** True when `timeMs` is one of the times a range list covers. */
export function hasTime(ranges: readonly TimeRange[], timeMs: number): boolean {
  return ranges.some(
    (r) => timeMs >= r.startMs && timeMs <= r.endMs && (timeMs - r.startMs) % r.stepMs === 0,
  );
}

/** `YYYY-MM-DD` of a UTC instant. */
export function isoDay(timeMs: number): string {
  return new Date(timeMs).toISOString().slice(0, 10);
}

/** `YYYY-MM-DDTHH:MM:SSZ` of a UTC instant, the form GIBS wants for sub-daily layers. */
export function isoSecond(timeMs: number): string {
  return `${new Date(timeMs).toISOString().slice(0, 19)}Z`;
}

/** Midnight UTC at or before `timeMs`. */
export function startOfUtcDay(timeMs: number): number {
  return Math.floor(timeMs / DAY_MS) * DAY_MS;
}

/** What the GIBS plugins keep from one fetch. */
export interface GibsRaw {
  /** DescribeDomains document, or null when it could not be fetched. */
  domainsXml: string | null;
}

/**
 * Fetch the availability document for a window. A failure here is not fatal:
 * tiles are served from a different path, so the plugins fall back to the
 * clock and say so through `domainsXml: null`.
 */
export async function fetchGibsDomains(
  ctx: Pick<SourceContext, "fetch" | "signal">,
  layer: GibsLayer,
  from: string,
  to: string,
): Promise<GibsRaw> {
  try {
    return { domainsXml: await fetchBody(ctx, gibsDomainsUrl(layer, from, to), "NASA GIBS") };
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    return { domainsXml: null };
  }
}
