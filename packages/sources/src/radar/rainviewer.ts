/**
 * Rain radar mosaic from RainViewer's public Weather Maps API.
 *
 * What the free API offers since 1 January 2026 (verified 2026-11-14 at
 * https://www.rainviewer.com/api/transition-faq.html and by live requests):
 * past frames only (about two hours at ten-minute steps, no nowcast, no
 * satellite), one colour scheme (2, "Universal Blue"), and zoom 0 to 7.
 * A request above zoom 7 still answers HTTP 200, with a "Zoom level not
 * supported" picture, so `maxZoom` must be honoured by the renderer.
 */
import { defineSource } from "@orya-halo/schema";
import type { SourceOutput, TileOverlay } from "@orya-halo/schema";
import { SourceError, fetchJson } from "../shared/overlays/http.ts";

export const RAINVIEWER_INDEX = "https://api.rainviewer.com/public/weather-maps.json";

/** Deepest zoom the free tiles are rendered at. */
export const RAINVIEWER_MAX_ZOOM = 7;

/**
 * 512 px tiles: a quarter of the requests of 256 px tiles for the same
 * picture, which matters under the per-address request limit when the time
 * scrubber walks through thirteen frames.
 */
const TILE_SIZE = 512;
/** The only colour scheme left on the free API. */
const COLOUR_SCHEME = 2;
/** `{smooth}_{snow}`: blurred edges, snow in its own colours. */
const OPTIONS = "1_1";

/** The index document, as far as this plugin reads it. */
export interface RainViewerIndex {
  version?: string;
  /** Unix seconds. */
  generated?: number;
  host?: string;
  radar?: {
    past?: RainViewerFrame[];
    nowcast?: RainViewerFrame[];
  };
}

export interface RainViewerFrame {
  /** Unix seconds. */
  time: number;
  /** Path under `host`, e.g. "/v2/radar/c950bdb97023". */
  path: string;
}

function tileUrl(host: string, path: string): string {
  return `${host}${path}/${TILE_SIZE}/{z}/{x}/{y}/${COLOUR_SCHEME}/${OPTIONS}.png`;
}

/** Turn the index into an overlay whose frames run oldest to newest. */
export function normaliseRainViewer(raw: RainViewerIndex): TileOverlay {
  const host = typeof raw.host === "string" ? raw.host.replace(/\/+$/, "") : "";
  const past = (raw.radar?.past ?? []).filter(
    (f) => typeof f?.path === "string" && f.path.startsWith("/") && Number.isFinite(f.time),
  );
  if (!host.startsWith("https://") || past.length === 0) {
    throw new SourceError("bad-data", "RainViewer returned no radar frames.");
  }

  // Forecast ("nowcast") frames are left out on purpose: the scrubber shows what was observed.
  const frames = past
    .map((f) => ({ timeMs: f.time * 1000, tiles: [tileUrl(host, f.path)] }))
    .sort((a, b) => a.timeMs - b.timeMs);
  const latest = frames[frames.length - 1];

  return {
    tiles: latest.tiles,
    tileSize: TILE_SIZE,
    minZoom: 0,
    maxZoom: RAINVIEWER_MAX_ZOOM,
    opacity: 0.7,
    frames,
    timeMs: latest.timeMs,
  };
}

export const rainViewerRadar = defineSource<RainViewerIndex>({
  id: "rainviewer-radar",
  name: "RainViewer",
  layer: "radar",
  transport: "fetch",
  schema: [
    { key: "timeMs", label: "Radar time", type: "time" },
    { key: "tiles", label: "Tile URL template", type: "url" },
  ],
  // A new frame appears every ten minutes; asking every five keeps the lag under one frame.
  refreshRate: 300_000,
  licence: {
    name: "RainViewer API terms of use (free for personal and educational use)",
    url: "https://www.rainviewer.com/api.html",
    display: true,
    redistribution: false,
    commercial: false,
    notes:
      "Free tier is for personal, educational and small community projects, with no availability guarantee; commercial or high-volume use needs an agreement. Credit with a link to rainviewer.com is required. Limit of 100 requests per address per minute: load frames lazily, never all thirteen at once. Tiles must come straight from RainViewer, not through the gateway.",
    verified: "2026-11-14",
  },
  attribution: {
    text: "Weather data by RainViewer",
    url: "https://www.rainviewer.com/",
    onMap: true,
  },
  docs: "https://www.rainviewer.com/api/weather-maps-api.html",

  fetch(ctx) {
    return fetchJson<RainViewerIndex>(ctx, RAINVIEWER_INDEX, "RainViewer");
  },

  normalise(raw): SourceOutput {
    return { type: "tiles", overlay: normaliseRainViewer(raw) };
  },
});
