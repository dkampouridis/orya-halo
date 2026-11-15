/**
 * Webcams from the Windy Webcams API v3 (free tier). Needs a key.
 *
 * Verified 2026-11-14 at https://api.windy.com/webcams/docs,
 * https://api.windy.com/webcams/terms,
 * https://account.windy.com/agreements/windy-webcams-api-terms-of-use and
 * the OpenAPI document behind https://api.windy.com/webcams/api/v3/docs.
 * No key was available, so the response shape below follows the published
 * schema and has not been exercised against the live service.
 *
 * Display rules this plugin and the HUD must keep:
 * - every image links to the webcam's Windy page or player;
 * - "Webcams provided by Windy.com" (linked) and an "add a webcam" link sit
 *   next to the webcams, in the page's normal text style;
 * - images are shown at their own size or smaller, never stretched;
 * - image addresses expire ten minutes after they are issued (free tier), so
 *   `detail()` asks for a fresh one each time and nothing is cached.
 */
import { defineSource } from "@orya-halo/schema";
import type {
  Attribution,
  DetailField,
  DetailMedia,
  EntityDetail,
  SourceContext,
  SourceOutput,
} from "@orya-halo/schema";
import { SourceError, fetchJson } from "../shared/overlays/http.ts";
import { camerasToUpdate } from "./shared.ts";
import type { Camera } from "./shared.ts";

const API = "https://api.windy.com/webcams/api/v3";
const SOURCE_ID = "windy-webcams";
const PROVIDER = "Windy Webcams";

/** Most webcams shown from this source at once. */
export const WINDY_CAP = 300;

/** The credit line Windy requires next to its webcams, with both of its links. */
export const WINDY_COURTESY = {
  text: "Webcams provided by Windy.com",
  url: "https://www.windy.com/",
  addText: "Add a webcam",
  addUrl: "https://www.windy.com/webcams/add",
} as const;

export const WINDY_ATTRIBUTION: Attribution = {
  text: WINDY_COURTESY.text,
  url: WINDY_COURTESY.url,
  onMap: true,
};

/** One webcam in an API answer, as far as this plugin reads it. */
export interface WindyWebcam {
  webcamId?: number;
  title?: string;
  status?: string;
  viewCount?: number;
  lastUpdatedOn?: string;
  /** How many webcams this one stands for in a map cluster. */
  clusterSize?: number;
  location?: {
    latitude?: number;
    longitude?: number;
    city?: string;
    region?: string;
    country?: string;
  };
  images?: {
    current?: { icon?: string; thumbnail?: string; preview?: string };
  };
  player?: { day?: string; live?: string };
  urls?: { detail?: string; provider?: string };
}

export interface WindyRaw {
  webcams: WindyWebcam[];
}

type View = NonNullable<SourceContext["view"]>;

/** Largest box the cluster endpoint accepts at its shallowest zoom (4); it halves with each zoom. */
const MAX_LAT_SPAN = 22.5;
const MAX_LON_SPAN = 45;
const MIN_API_ZOOM = 4;
const MAX_API_ZOOM = 18;

/**
 * The request for a view. Wide views (more than twice the cluster endpoint's
 * largest box) ask for the world's most popular webcams; closer views ask the
 * cluster endpoint, which spreads webcams evenly for a zoom level and limits
 * the box it accepts at each zoom. The box is trimmed around the view centre
 * when it would exceed that limit.
 */
export function windyRequestUrl(view: View | undefined): string {
  const popular = `${API}/webcams?limit=50&offset=0&sortKey=popularity&sortDirection=desc&include=location`;
  if (!view) return popular;

  let [west, south, east, north] = view.bounds;
  south = Math.max(-90, south);
  north = Math.min(90, north);
  if (west > east) {
    // The endpoint takes -180..180 only: keep the side of the antimeridian the centre is on.
    if (view.lon >= west) east = 180;
    else west = -180;
  }
  const latSpan = north - south;
  const lonSpan = east - west;
  if (!(latSpan > 0) || !(lonSpan > 0)) return popular;
  if (latSpan > MAX_LAT_SPAN * 2 || lonSpan > MAX_LON_SPAN * 2) return popular;

  // Deepest zoom whose box limit still covers the view, but no deeper than the map itself.
  // The endpoint counts zoom on 256 px tiles, one more than a 512 px map's zoom.
  const fit = Math.floor(
    MIN_API_ZOOM + Math.log2(Math.min(MAX_LAT_SPAN / latSpan, MAX_LON_SPAN / lonSpan)),
  );
  const zoom = Math.min(
    MAX_API_ZOOM,
    Math.max(MIN_API_ZOOM, Math.min(fit, Math.floor(view.zoom) + 1)),
  );
  const halfLat = Math.min(latSpan, MAX_LAT_SPAN / 2 ** (zoom - MIN_API_ZOOM)) / 2;
  const halfLon = Math.min(lonSpan, MAX_LON_SPAN / 2 ** (zoom - MIN_API_ZOOM)) / 2;
  const midLat = (south + north) / 2;
  const midLon = (west + east) / 2;

  const params = new URLSearchParams({
    northLat: (midLat + halfLat).toFixed(4),
    southLat: (midLat - halfLat).toFixed(4),
    eastLon: (midLon + halfLon).toFixed(4),
    westLon: (midLon - halfLon).toFixed(4),
    zoom: String(zoom),
    include: "location",
  });
  return `${API}/map/clusters?${params.toString()}`;
}

/** Active webcams with a position, as cameras. */
export function windyCameras(webcams: readonly WindyWebcam[]): Camera[] {
  const cameras: Camera[] = [];
  const seen = new Set<number>();
  for (const cam of webcams) {
    const id = cam.webcamId;
    const lat = cam.location?.latitude;
    const lon = cam.location?.longitude;
    if (
      typeof id !== "number" ||
      !Number.isInteger(id) ||
      id <= 0 ||
      id > 0xffffffff ||
      seen.has(id)
    )
      continue;
    if (
      typeof lat !== "number" ||
      typeof lon !== "number" ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon)
    )
      continue;
    if (cam.status !== undefined && cam.status !== "active") continue;
    seen.add(id);
    const updated = Date.parse(cam.lastUpdatedOn ?? "");
    cameras.push({
      // Windy's own id, so `detail()` can ask for the webcam without any stored facts.
      id,
      lon,
      lat,
      fixTimeMs: Number.isNaN(updated) ? 0 : updated,
      meta: {
        label: cam.title || cam.location?.city || "Webcam",
        provider: "Windy.com",
        country: cam.location?.country ?? null,
        city: cam.location?.city ?? null,
        webcamId: id,
        clusterSize: cam.clusterSize ?? 1,
      },
    });
    if (cameras.length >= WINDY_CAP) break;
  }
  return cameras;
}

function httpsOnly(url: string | undefined): string | undefined {
  return typeof url === "string" && url.startsWith("https://") ? url : undefined;
}

/** Detail panel content for one webcam, following Windy's display rules. */
export function windyDetail(cam: WindyWebcam): Partial<EntityDetail> {
  const title = cam.title || "Webcam";
  const page =
    httpsOnly(cam.urls?.detail) ??
    (cam.webcamId ? `https://webcams.windy.com/webcams/${cam.webcamId}` : WINDY_COURTESY.url);
  const media: DetailMedia[] = [];
  const image =
    httpsOnly(cam.images?.current?.preview) ?? httpsOnly(cam.images?.current?.thumbnail);
  if (image) {
    media.push({
      type: "image",
      url: image,
      link: page,
      credit: WINDY_COURTESY.text,
      alt: `Webcam view: ${title}`,
    });
  }
  const player = httpsOnly(cam.player?.day);
  if (player) {
    media.push({
      type: "embed",
      url: player,
      link: page,
      credit: WINDY_COURTESY.text,
      alt: `Time-lapse of the last day: ${title}`,
    });
  }

  const place = [cam.location?.city, cam.location?.region, cam.location?.country]
    .filter(Boolean)
    .join(", ");
  const fields: DetailField[] = [];
  if (cam.location?.city) fields.push({ key: "city", label: "City", value: cam.location.city });
  if (cam.location?.country)
    fields.push({ key: "country", label: "Country", value: cam.location.country });
  if (typeof cam.viewCount === "number") {
    fields.push({
      key: "views",
      label: "Views",
      value: cam.viewCount.toLocaleString("en-GB"),
      numeric: cam.viewCount,
    });
  }

  const detail: Partial<EntityDetail> = {
    title,
    subtitle: place ? `Webcam · ${place}` : "Webcam",
    fields,
    media,
    attribution: WINDY_ATTRIBUTION,
    sourceUrl: page,
  };
  const updated = Date.parse(cam.lastUpdatedOn ?? "");
  if (!Number.isNaN(updated)) detail.fixTimeMs = updated;
  return detail;
}

function requireKey(ctx: Pick<SourceContext, "key">): Record<string, string> {
  if (!ctx.key) {
    throw new SourceError(
      "needs-key",
      "Windy webcams need an API key. Set VITE_WINDY_WEBCAMS_KEY to turn them on.",
    );
  }
  return { "x-windy-api-key": ctx.key };
}

export const windyWebcams = defineSource<WindyRaw>({
  id: SOURCE_ID,
  name: PROVIDER,
  layer: "webcams",
  transport: "fetch",
  schema: [
    { key: "label", label: "Title", type: "string" },
    { key: "provider", label: "Provider", type: "string" },
    { key: "city", label: "City", type: "string" },
    { key: "country", label: "Country", type: "string" },
    { key: "webcamId", label: "Windy webcam", type: "number" },
    { key: "clusterSize", label: "Webcams nearby", type: "number" },
  ],
  // The set for a view barely changes; the terms forbid intensive automated use.
  refreshRate: 600_000,
  // The request is for the area in view, so a new view needs a new request.
  viewAware: true,
  requiresKey: "VITE_WINDY_WEBCAMS_KEY",
  licence: {
    name: "Windy Webcams API terms of use (free tier)",
    url: "https://account.windy.com/agreements/windy-webcams-api-terms-of-use",
    display: true,
    redistribution: false,
    commercial: true,
    notes:
      'Link every image to its Windy page or player; show "Webcams provided by Windy.com" with an "add a webcam" link beside the webcams; never enlarge images; image addresses expire after 10 minutes, so request them when shown and do not store them. No redistribution of API data and no bulk scanning. The key must not be published (clause 8.1.3): a key built into a public web bundle is visible to visitors, so decide whether to ship one. Free tier may not sit only behind a paywall; Windy may show ads in its player.',
    verified: "2026-11-14",
  },
  attribution: WINDY_ATTRIBUTION,
  docs: "https://api.windy.com/webcams/docs",

  async fetch(ctx) {
    const headers = requireKey(ctx);
    const body = await fetchJson<WindyWebcam[] | { webcams?: WindyWebcam[] }>(
      ctx,
      windyRequestUrl(ctx.view),
      PROVIDER,
      {
        headers,
        keyed: true,
      },
    );
    // The cluster endpoint answers with a bare list, the listing endpoint with `{ total, webcams }`.
    const webcams = Array.isArray(body) ? body : body?.webcams;
    if (!Array.isArray(webcams))
      throw new SourceError("bad-data", "Windy sent a webcam list this app cannot read.");
    return { webcams };
  },

  normalise(raw, ctx): SourceOutput {
    const cameras = windyCameras(raw.webcams);
    // Windy has already spaced these for the view's zoom, so all of them rank as always visible.
    return {
      type: "entities",
      update: camerasToUpdate(SOURCE_ID, cameras, new Uint8Array(cameras.length), ctx.now()),
    };
  },

  async detail(id, _meta, ctx) {
    const headers = requireKey(ctx);
    const cam = await fetchJson<WindyWebcam>(
      ctx,
      `${API}/webcams/${id >>> 0}?include=images,location,player,urls`,
      PROVIDER,
      { headers, keyed: true },
    );
    return windyDetail(cam);
  },
});
