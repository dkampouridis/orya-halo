/**
 * Daily true-colour satellite imagery from NASA GIBS.
 *
 * Layer: VIIRS corrected reflectance from NOAA-20, the most complete of the
 * daily true-colour mosaics on the Web-Mercator endpoint (Suomi NPP's copy
 * was twelve days behind when this was checked; MODIS Terra and Aqua leave
 * gaps between swaths near the equator and their orbits are drifting).
 * Tiles are 256 px JPEG, zoom 0 to 9.
 *
 * Verified 2026-11-14 against the WMTS capabilities and DescribeDomains
 * documents; tiles and both documents answer `Access-Control-Allow-Origin: *`.
 */
import { defineSource } from "@orya-halo/schema";
import type { SourceOutput, TileOverlay } from "@orya-halo/schema";
import {
  DAY_MS,
  GIBS_ATTRIBUTION,
  GIBS_DOCS,
  GIBS_LICENCE,
  fetchGibsDomains,
  gibsTileUrl,
  hasTime,
  isoDay,
  parseGibsDomains,
  startOfUtcDay,
} from "../shared/overlays/gibs.ts";
import type { GibsLayer, GibsRaw } from "../shared/overlays/gibs.ts";

export const TRUE_COLOUR_LAYER: GibsLayer = {
  id: "VIIRS_NOAA20_CorrectedReflectance_TrueColor",
  matrixSet: "GoogleMapsCompatible_Level9",
  maxZoom: 9,
  format: "jpeg",
};

/**
 * A UTC day's mosaic is built from early-afternoon passes that sweep west
 * from the date line, so its last swath is acquired about 01:30 UTC the next
 * day and published roughly three hours later. Thirty hours after a day
 * starts is the first moment it can be called complete.
 */
export const COMPLETE_AFTER_MS = 30 * 3_600_000;

/** How many days of frames to offer the time scrubber, newest included. */
export const IMAGERY_FRAME_DAYS = 5;

/** The mosaic's representative instant: noon UTC of its day. */
const NOON_MS = DAY_MS / 2;

/** Start (midnight UTC) of the most recent day whose mosaic is complete at `nowMs`. */
export function latestCompleteDay(nowMs: number): number {
  return startOfUtcDay(nowMs - COMPLETE_AFTER_MS);
}

export function normaliseTrueColour(raw: GibsRaw, nowMs: number): TileOverlay {
  const ranges = raw.domainsXml ? parseGibsDomains(raw.domainsXml) : [];
  let newest = latestCompleteDay(nowMs);
  if (ranges.length > 0) {
    // Never ask for a day the server has not published (satellite outages).
    const lastPublished = startOfUtcDay(ranges[ranges.length - 1].endMs);
    newest = Math.min(newest, lastPublished);
  }

  const frames: { timeMs: number; tiles: string[] }[] = [];
  for (let i = IMAGERY_FRAME_DAYS - 1; i >= 0; i--) {
    const day = newest - i * DAY_MS;
    if (ranges.length > 0 && !hasTime(ranges, day)) continue;
    frames.push({ timeMs: day + NOON_MS, tiles: [gibsTileUrl(TRUE_COLOUR_LAYER, isoDay(day))] });
  }
  if (frames.length === 0) {
    frames.push({
      timeMs: newest + NOON_MS,
      tiles: [gibsTileUrl(TRUE_COLOUR_LAYER, isoDay(newest))],
    });
  }

  const latest = frames[frames.length - 1];
  return {
    tiles: latest.tiles,
    tileSize: 256,
    minZoom: 0,
    maxZoom: TRUE_COLOUR_LAYER.maxZoom,
    opacity: 1,
    frames,
    timeMs: latest.timeMs,
  };
}

export const gibsTrueColour = defineSource<GibsRaw>({
  id: "gibs-truecolour",
  name: "NASA GIBS (VIIRS, NOAA-20)",
  layer: "imagery",
  transport: "fetch",
  schema: [
    { key: "timeMs", label: "Imagery date", type: "time" },
    { key: "tiles", label: "Tile URL template", type: "url" },
  ],
  // The answer changes once a day; an hourly check picks the new day up promptly.
  refreshRate: 3_600_000,
  licence: GIBS_LICENCE,
  attribution: GIBS_ATTRIBUTION,
  docs: GIBS_DOCS,

  fetch(ctx) {
    const newest = latestCompleteDay(ctx.now());
    const from = isoDay(newest - (IMAGERY_FRAME_DAYS + 2) * DAY_MS);
    const to = isoDay(newest + DAY_MS);
    return fetchGibsDomains(ctx, TRUE_COLOUR_LAYER, from, to);
  },

  normalise(raw, ctx): SourceOutput {
    return { type: "tiles", overlay: normaliseTrueColour(raw, ctx.now()) };
  },
});
