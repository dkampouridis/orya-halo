/**
 * Calgary's traffic cameras, published by The City of Calgary (Mobility) on
 * its open data portal. Keyless.
 *
 * Verified 2026-11-15 (https://data.calgary.ca/d/k7p9-kppz, its metadata at
 * https://data.calgary.ca/api/views/k7p9-kppz.json, and the licence at
 * https://data.calgary.ca/stories/s/u45n-7awa, plus live requests): Open
 * Government Licence – City of Calgary, which allows copying, publishing,
 * adapting and distributing, commercial or not, with the statement "Contains
 * information licensed under the Open Government Licence – City of Calgary"
 * and a link where possible. The list (Socrata, about 80 KB for 218
 * cameras, updated daily) answers `Access-Control-Allow-Origin: *`; the
 * images are plain JPEGs on trafficcam.calgary.ca, shown with `<img>`.
 * Socrata throttles requests without an app token per address; one request
 * an hour is far inside that.
 */
import { defineSource, hashId } from "@orya-halo/schema";
import type { Attribution, EntityDetail, EntityMeta, SourceOutput } from "@orya-halo/schema";
import { SourceError, fetchJson } from "../shared/overlays/http.ts";
import { LIST_FEED_CAP, VIEW_CAP, camerasToUpdate, selectCameras } from "./shared.ts";
import type { Camera, CameraView } from "./shared.ts";

export const CALGARY_API = "https://data.calgary.ca/resource/k7p9-kppz.json?$limit=5000";
const DATASET_PAGE = "https://data.calgary.ca/d/k7p9-kppz";
const LICENCE_URL = "https://data.calgary.ca/stories/s/u45n-7awa";
const IMAGE_PATTERN = /^https:\/\/trafficcam\.calgary\.ca\/loc\d+\.jpg$/;
const SOURCE_ID = "calgary-traffic-cameras";

export const CALGARY_ATTRIBUTION: Attribution = {
  text: "Traffic cameras: The City of Calgary. Contains information licensed under the Open Government Licence – City of Calgary",
  url: LICENCE_URL,
  onMap: false,
};

/** One row of the dataset, as far as this plugin reads it. */
export interface CalgaryCameraRow {
  camera_url?: { url?: string; description?: string };
  quadrant?: string;
  camera_location?: string;
  point?: { type?: string; coordinates?: number[] };
}

export interface CalgaryRaw {
  rows: CalgaryCameraRow[];
  view?: CameraView;
}

/** Cameras with a position and an image on the City's own camera host. */
export function calgaryCameras(rows: readonly CalgaryCameraRow[]): Camera[] {
  const cameras: Camera[] = [];
  for (const row of rows) {
    const image = row.camera_url?.url?.trim() ?? "";
    if (!IMAGE_PATTERN.test(image)) continue;
    const [lon, lat] = row.point?.coordinates ?? [];
    if (typeof lon !== "number" || typeof lat !== "number") continue;
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || (lon === 0 && lat === 0)) continue;
    // The file name is the camera's stable key: "loc100.jpg" is "Camera 101".
    const key = /loc(\d+)\.jpg$/.exec(image)?.[1] ?? "";
    const location = row.camera_location?.trim() ?? "";
    cameras.push({
      id: hashId(`calgary:${key}`),
      lon,
      lat,
      fixTimeMs: 0,
      meta: {
        label: location || row.camera_url?.description?.trim() || `Camera ${key}`,
        provider: "The City of Calgary",
        country: "Canada",
        camera: row.camera_url?.description?.trim() || null,
        quadrant: row.quadrant?.trim() || null,
        image,
      },
    });
  }
  return cameras;
}

/** Detail panel content for one camera, from the facts stored with it. No request needed. */
export function calgaryDetail(meta: EntityMeta): Partial<EntityDetail> {
  const image = typeof meta.image === "string" && IMAGE_PATTERN.test(meta.image) ? meta.image : "";
  if (!image) return {};
  const title = typeof meta.label === "string" && meta.label ? meta.label : "Traffic camera";
  const camera = typeof meta.camera === "string" ? meta.camera : "";
  const quadrant = typeof meta.quadrant === "string" ? meta.quadrant : "";
  return {
    title,
    subtitle: "Traffic camera · Calgary, Alberta, Canada",
    // Schema keys, so the panel takes this list as the whole of it and leaves out the image address.
    fields: [
      ...(camera ? [{ key: "camera", label: "Camera", value: camera }] : []),
      ...(quadrant ? [{ key: "quadrant", label: "Quadrant", value: quadrant }] : []),
      { key: "provider", label: "Provider", value: "The City of Calgary" },
    ],
    media: [
      {
        type: "image",
        url: image,
        link: DATASET_PAGE,
        credit: "The City of Calgary, Open Government Licence – City of Calgary",
        alt: `Traffic camera at ${title}, Calgary`,
      },
    ],
    attribution: CALGARY_ATTRIBUTION,
    sourceUrl: DATASET_PAGE,
  };
}

export const calgaryTrafficCameras = defineSource<CalgaryRaw>({
  id: SOURCE_ID,
  name: "City of Calgary traffic cameras",
  layer: "webcams",
  transport: "fetch",
  schema: [
    { key: "label", label: "Place", type: "string" },
    { key: "provider", label: "Provider", type: "string" },
    { key: "country", label: "Country", type: "string" },
    { key: "camera", label: "Camera", type: "string" },
    { key: "quadrant", label: "Quadrant", type: "string" },
    { key: "image", label: "Image", type: "url" },
  ],
  // The list is republished daily; each image keeps its address and is fetched on selection.
  refreshRate: 3_600_000,
  licence: {
    name: "Open Government Licence – City of Calgary 2.1",
    url: LICENCE_URL,
    display: true,
    redistribution: true,
    commercial: true,
    notes:
      'Include "Contains information licensed under the Open Government Licence – City of Calgary" with a link where possible; do not suggest official status. Socrata throttles requests without an app token.',
    verified: "2026-11-15",
  },
  attribution: CALGARY_ATTRIBUTION,
  docs: DATASET_PAGE,

  async fetch(ctx) {
    const rows = await fetchJson<CalgaryCameraRow[]>(
      ctx,
      CALGARY_API,
      "Calgary's open data portal",
    );
    return { rows, view: ctx.view };
  },

  normalise(raw, ctx): SourceOutput {
    const all = Array.isArray(raw.rows) ? calgaryCameras(raw.rows) : [];
    if (all.length === 0) {
      throw new SourceError(
        "bad-data",
        "Calgary's open data portal sent a camera list this app cannot read.",
      );
    }
    const { cameras, rank } = selectCameras(all, {
      view: raw.view,
      cap: raw.view ? VIEW_CAP : LIST_FEED_CAP,
    });
    return { type: "entities", update: camerasToUpdate(SOURCE_ID, cameras, rank, ctx.now()) };
  },

  detail(_id, meta) {
    return meta ? calgaryDetail(meta) : {};
  },
});
