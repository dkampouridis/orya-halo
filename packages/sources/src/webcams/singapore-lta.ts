/**
 * Singapore's expressway and checkpoint traffic cameras, published by the
 * Land Transport Authority on data.gov.sg as the "Traffic Images" dataset.
 * Keyless.
 *
 * Verified 2026-11-15 (https://data.gov.sg/open-data-licence,
 * https://data.gov.sg/datasets/d_6cdb6b405b25aaaacbaf7689bcc6fae0/view and
 * https://guide.data.gov.sg/developer-guide/api-overview/api-rate-limits,
 * plus live requests): Singapore Open Data Licence 1.0, which allows use,
 * copying, distribution and adaptation, commercial or not, with a
 * conspicuous notice naming the dataset and linking to the licence, and no
 * suggestion of official status. data.gov.sg calls keyless access "for
 * testing" and recommends a key for production; a key cannot be kept secret
 * in a browser app, so none is used. The published limit without a key (6
 * requests per 10 seconds) is listed for the v2 real-time APIs; this v1
 * endpoint is not listed, and one request every 5 minutes is far inside it
 * either way. The list answers `Access-Control-Allow-Origin: *`; the 1920 x
 * 1080 JPEGs on images.data.gov.sg do not, and are shown with a plain `<img>`
 * (no `crossOrigin`), which needs none. The feed has no
 * camera names, only numbers, and each image has its own address, so the
 * newest one is looked up again when a camera is selected.
 */
import { defineSource, hashId } from "@orya-halo/schema";
import type {
  Attribution,
  EntityDetail,
  EntityMeta,
  SourceContext,
  SourceOutput,
} from "@orya-halo/schema";
import { SourceError, fetchJson } from "../shared/overlays/http.ts";
import { LIST_FEED_CAP, VIEW_CAP, camerasToUpdate, selectCameras } from "./shared.ts";
import type { Camera, CameraView } from "./shared.ts";

export const SG_TRAFFIC_IMAGES_API = "https://api.data.gov.sg/v1/transport/traffic-images";
const DATASET_PAGE = "https://data.gov.sg/datasets/d_6cdb6b405b25aaaacbaf7689bcc6fae0/view";
const LICENCE_URL = "https://data.gov.sg/open-data-licence";
const IMAGE_PREFIX = "https://images.data.gov.sg/";
const SOURCE_ID = "sg-lta-traffic-images";

export const SG_LTA_ATTRIBUTION: Attribution = {
  text: "Contains information from Traffic Images by the Land Transport Authority, accessed live from data.gov.sg, which is made available under the terms of the Singapore Open Data Licence version 1.0",
  url: LICENCE_URL,
  onMap: false,
};

/** The data.gov.sg answer, as far as this plugin reads it. */
export interface SgTrafficImages {
  items?: {
    timestamp?: string;
    cameras?: {
      timestamp?: string;
      image?: string;
      camera_id?: string;
      location?: { latitude?: number; longitude?: number };
      image_metadata?: { width?: number; height?: number };
    }[];
  }[];
  api_info?: { status?: string };
}

export interface SgTrafficRaw {
  feed: SgTrafficImages;
  view?: CameraView;
}

/** An image address from the feed, kept only when it is on the dataset's own image host. */
function imageUrl(url: unknown): string {
  return typeof url === "string" && url.startsWith(IMAGE_PREFIX) && !url.includes("..") ? url : "";
}

/**
 * The app refreshes an open detail panel every couple of seconds, and each
 * refresh asks the plugin again. The images change about once a minute, so
 * the list fetched for one lookup serves every lookup for the next minute
 * (a failed one too, so a refusal is not hammered): an open panel costs one
 * request a minute, well inside data.gov.sg's keyless allowance.
 */
const LOOKUP_TTL_MS = 60_000;
let lookup: { atMs: number; cameras: Promise<Camera[]> } | null = null;

function sgLookup(ctx: SourceContext): Promise<Camera[]> {
  const nowMs = Date.now();
  if (!lookup || nowMs - lookup.atMs >= LOOKUP_TTL_MS || nowMs < lookup.atMs) {
    const cameras = fetchJson<SgTrafficImages>(ctx, SG_TRAFFIC_IMAGES_API, "data.gov.sg").then(
      sgCameras,
    );
    // An aborted request (the panel closed) is not a result to keep.
    cameras.catch(() => {
      if (ctx.signal.aborted && lookup?.cameras === cameras) lookup = null;
    });
    lookup = { atMs: nowMs, cameras };
  }
  return lookup.cameras;
}

/** Forget the cached lookup (tests). */
export function resetSgLookup(): void {
  lookup = null;
}

/** Cameras with a position and a current image. Unreadable entries are skipped. */
export function sgCameras(feed: SgTrafficImages): Camera[] {
  const cameras: Camera[] = [];
  const list: unknown = feed.items?.[0]?.cameras;
  for (const entry of Array.isArray(list)
    ? (list as NonNullable<NonNullable<SgTrafficImages["items"]>[number]["cameras"]>)
    : []) {
    if (!entry || typeof entry !== "object") continue;
    const id = typeof entry.camera_id === "string" ? entry.camera_id.trim() : "";
    const lat = entry.location?.latitude;
    const lon = entry.location?.longitude;
    const image = imageUrl(entry.image);
    if (!/^\d+$/.test(id) || !image) continue;
    if (typeof lat !== "number" || typeof lon !== "number") continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
    const taken = Date.parse(entry.timestamp ?? "");
    cameras.push({
      id: hashId(`sg-lta:${id}`),
      lon,
      lat,
      fixTimeMs: Number.isNaN(taken) ? 0 : taken,
      meta: {
        label: `Traffic camera ${id}`,
        provider: "Land Transport Authority",
        country: "Singapore",
        cameraId: id,
        image,
      },
    });
  }
  return cameras;
}

/**
 * Detail panel content for one camera. `latest` is the camera's entry in a
 * fresher copy of the feed, when one could be had.
 */
export function sgCameraDetail(
  meta: EntityMeta,
  latest?: { image: string; takenMs: number },
): Partial<EntityDetail> {
  const id = typeof meta.cameraId === "string" && /^\d+$/.test(meta.cameraId) ? meta.cameraId : "";
  if (!id) return {};
  const image = latest?.image || imageUrl(meta.image);
  const detail: Partial<EntityDetail> = {
    title: `Traffic camera ${id}`,
    subtitle: "Traffic camera · Singapore",
    // Schema keys, so the panel takes this list as the whole of it and leaves out the image address.
    fields: [
      { key: "cameraId", label: "Camera", value: id },
      { key: "provider", label: "Provider", value: "Land Transport Authority" },
    ],
    media: image
      ? [
          {
            type: "image",
            url: image,
            link: DATASET_PAGE,
            credit: "Land Transport Authority · data.gov.sg, Singapore Open Data Licence",
            alt: `Traffic camera ${id}, Singapore`,
          },
        ]
      : [],
    attribution: SG_LTA_ATTRIBUTION,
    sourceUrl: DATASET_PAGE,
  };
  if (latest && latest.takenMs > 0) detail.fixTimeMs = latest.takenMs;
  return detail;
}

export const sgLtaTrafficCameras = defineSource<SgTrafficRaw>({
  id: SOURCE_ID,
  name: "Singapore Land Transport Authority traffic cameras (data.gov.sg)",
  layer: "webcams",
  transport: "fetch",
  schema: [
    { key: "label", label: "Place", type: "string" },
    { key: "provider", label: "Provider", type: "string" },
    { key: "country", label: "Country", type: "string" },
    { key: "cameraId", label: "Camera", type: "string" },
    { key: "image", label: "Latest image", type: "url" },
  ],
  // Images are taken about once a minute; the panel looks up the newest when a camera is selected.
  refreshRate: 5 * 60_000,
  licence: {
    name: "Singapore Open Data Licence 1.0",
    url: LICENCE_URL,
    display: true,
    redistribution: true,
    commercial: true,
    notes:
      "Show a conspicuous notice naming the dataset and linking to the licence; do not suggest official status. Keyless access is described as for testing; the published 6 requests per 10 seconds is for the v2 real-time APIs. Images are shown with a plain <img>.",
    verified: "2026-11-15",
  },
  attribution: SG_LTA_ATTRIBUTION,
  docs: DATASET_PAGE,

  async fetch(ctx) {
    const feed = await fetchJson<SgTrafficImages>(ctx, SG_TRAFFIC_IMAGES_API, "data.gov.sg");
    return { feed, view: ctx.view };
  },

  normalise(raw, ctx): SourceOutput {
    const items: unknown = raw.feed?.items;
    const list: unknown = Array.isArray(items)
      ? (items[0] as { cameras?: unknown })?.cameras
      : null;
    if (!Array.isArray(items) || (list !== undefined && !Array.isArray(list))) {
      throw new SourceError("bad-data", "data.gov.sg sent a camera list this app cannot read.");
    }
    const { cameras, rank } = selectCameras(sgCameras(raw.feed), {
      view: raw.view,
      cap: raw.view ? VIEW_CAP : LIST_FEED_CAP,
    });
    return { type: "entities", update: camerasToUpdate(SOURCE_ID, cameras, rank, ctx.now()) };
  },

  async detail(_id, meta, ctx) {
    if (!meta) return {};
    const id = typeof meta.cameraId === "string" ? meta.cameraId : "";
    let latest: { image: string; takenMs: number } | undefined;
    try {
      const camera = (await sgLookup(ctx)).find((c) => c.meta.cameraId === id);
      if (camera) latest = { image: String(camera.meta.image), takenMs: camera.fixTimeMs };
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      // The image from the last list is a minute or two old at worst: show it.
    }
    return sgCameraDetail(meta, latest);
  },
});
