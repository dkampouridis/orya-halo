/**
 * Global precipitation rate from NASA's IMERG (GPM), served by GIBS.
 *
 * The fully open alternative to ground radar: satellite estimates that cover
 * oceans and countries with no radar network, every 30 minutes, but six to
 * seven hours behind real time and no sharper than zoom 6 (roughly 10 km).
 * Use it where RainViewer's personal-and-educational terms do not fit, or as
 * the fallback when RainViewer is unreachable. Register one radar source at
 * a time.
 *
 * Verified 2026-11-14: layer `IMERG_Precipitation_Rate_30min`, period PT30M,
 * newest listed frame 09:30 UTC at 15:17 UTC and 10:30 at 15:52, tiles answer
 * `Access-Control-Allow-Origin: *`. Some tiles of the two newest listed
 * frames answered 404 while older frames were complete, so the plugin stays
 * an hour behind the newest listed frame.
 */
import { defineSource } from "@orya-halo/schema";
import type { SourceOutput, TileOverlay } from "@orya-halo/schema";
import {
  GIBS_ATTRIBUTION,
  GIBS_DOCS,
  GIBS_LICENCE,
  fetchGibsDomains,
  gibsTileUrl,
  hasTime,
  isoSecond,
  parseGibsDomains,
} from "../shared/overlays/gibs.ts";
import type { GibsLayer, GibsRaw } from "../shared/overlays/gibs.ts";

export const IMERG_LAYER: GibsLayer = {
  id: "IMERG_Precipitation_Rate_30min",
  matrixSet: "GoogleMapsCompatible_Level6",
  maxZoom: 6,
  format: "png",
};

const STEP_MS = 30 * 60_000;
/** Frames offered to the scrubber: six hours of half-hour steps. */
export const IMERG_FRAMES = 12;
/**
 * Steps kept between the newest listed frame and the newest shown one. A
 * frame is listed a little before all of its tiles can be fetched, and the
 * CDN remembers the resulting 404s for a while.
 */
const HOLD_BACK_STEPS = 2;
/** Delay assumed between observation and a safely published frame when availability is unknown. */
const TYPICAL_LATENCY_MS = 7 * 3_600_000;

export function normaliseImerg(raw: GibsRaw, nowMs: number): TileOverlay {
  const ranges = raw.domainsXml ? parseGibsDomains(raw.domainsXml) : [];
  const byClock = Math.floor((nowMs - TYPICAL_LATENCY_MS) / STEP_MS) * STEP_MS;
  const newest =
    ranges.length > 0
      ? Math.min(
          ranges[ranges.length - 1].endMs - HOLD_BACK_STEPS * STEP_MS,
          Math.floor(nowMs / STEP_MS) * STEP_MS,
        )
      : byClock;

  const frames: { timeMs: number; tiles: string[] }[] = [];
  for (let i = IMERG_FRAMES - 1; i >= 0; i--) {
    const time = newest - i * STEP_MS;
    // The half-hourly series has holes; skip times the server does not list.
    if (ranges.length > 0 && !hasTime(ranges, time)) continue;
    frames.push({ timeMs: time, tiles: [gibsTileUrl(IMERG_LAYER, isoSecond(time))] });
  }
  if (frames.length === 0) {
    frames.push({ timeMs: newest, tiles: [gibsTileUrl(IMERG_LAYER, isoSecond(newest))] });
  }

  const latest = frames[frames.length - 1];
  return {
    tiles: latest.tiles,
    tileSize: 256,
    minZoom: 0,
    maxZoom: IMERG_LAYER.maxZoom,
    opacity: 0.7,
    frames,
    timeMs: latest.timeMs,
  };
}

export const gibsImergPrecipitation = defineSource<GibsRaw>({
  id: "gibs-imerg",
  name: "NASA GIBS (IMERG precipitation)",
  layer: "radar",
  transport: "fetch",
  schema: [
    { key: "timeMs", label: "Observation time", type: "time" },
    { key: "tiles", label: "Tile URL template", type: "url" },
  ],
  // A new half-hour frame is published every 30 minutes.
  refreshRate: 900_000,
  licence: GIBS_LICENCE,
  attribution: GIBS_ATTRIBUTION,
  docs: GIBS_DOCS,

  fetch(ctx) {
    const now = ctx.now();
    return fetchGibsDomains(
      ctx,
      IMERG_LAYER,
      isoSecond(now - 36 * 3_600_000),
      isoSecond(now + STEP_MS),
    );
  },

  normalise(raw, ctx): SourceOutput {
    return { type: "tiles", overlay: normaliseImerg(raw, ctx.now()) };
  },
});
