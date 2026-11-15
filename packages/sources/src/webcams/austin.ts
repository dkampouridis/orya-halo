/**
 * Austin's traffic cameras, owned and operated by Austin Transportation and
 * Public Works and published on the City of Austin open data portal.
 * Keyless.
 *
 * Verified 2026-11-15 (https://data.austintexas.gov/d/b4k4-adkb, its
 * metadata at https://data.austintexas.gov/api/views/b4k4-adkb.json, and
 * the City of Austin Open Data Terms of Use at
 * https://data.austintexas.gov/stories/s/ranj-cccq, plus live requests): the
 * dataset is marked public domain; the terms say data on the portal is
 * "offered free and without restriction", disclaim any warranty, and let the
 * City end any display of its data. No credit is required; one is given as
 * a courtesy. The list (Socrata, about 120 KB for some 820 working cameras,
 * updated daily) answers `Access-Control-Allow-Origin: *`; the screenshots
 * on cctv.austinmobility.io are plain JPEGs shown with `<img>`. Socrata
 * throttles requests without an app token per address; one request an hour
 * is far inside that.
 */
import { defineSource, hashId } from "@orya-halo/schema";
import type { Attribution, EntityDetail, EntityMeta, SourceOutput } from "@orya-halo/schema";
import { SourceError, fetchJson } from "../shared/overlays/http.ts";
import { LIST_FEED_CAP, VIEW_CAP, camerasToUpdate, selectCameras } from "./shared.ts";
import type { Camera, CameraView } from "./shared.ts";

/** Only the cameras that are switched on, and only the columns this plugin reads. */
export const AUSTIN_API =
  "https://data.austintexas.gov/resource/b4k4-adkb.json?$select=camera_id,location_name,screenshot_address,location&$where=camera_status%3D%27TURNED_ON%27&$limit=5000";
const DATASET_PAGE = "https://data.austintexas.gov/d/b4k4-adkb";
const TERMS_URL = "https://data.austintexas.gov/stories/s/ranj-cccq";
const SOURCE_ID = "austin-traffic-cameras";

export const AUSTIN_ATTRIBUTION: Attribution = {
  text: "Traffic cameras: Austin Transportation and Public Works, City of Austin Open Data Portal (public domain; credit given as courtesy)",
  url: DATASET_PAGE,
  onMap: false,
};

/** One row of the dataset, as far as this plugin reads it. */
export interface AustinCameraRow {
  camera_id?: string;
  location_name?: string;
  screenshot_address?: string;
  location?: { type?: string; coordinates?: number[] };
}

export interface AustinRaw {
  rows: AustinCameraRow[];
  view?: CameraView;
}

/** The camera's current screenshot. Ids are digits only. */
export function austinScreenshot(cameraId: string): string {
  return `https://cctv.austinmobility.io/image/${cameraId}.jpg`;
}

/** Street names arrive in capitals: "LAMAR BLVD / BARTON SPRINGS RD" → "Lamar Blvd / Barton Springs Rd". */
export function austinPlace(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(
      /(^|[\s/(-])([a-z])/g,
      (_, before: string, letter: string) => before + letter.toUpperCase(),
    )
    .replace(/\b(Ih|Us|Sh|Fm|Rm|Svrd|Blk|Heb)\b/g, (word: string) => word.toUpperCase());
}

/** Cameras with a position and a screenshot at the address the dataset documents. */
export function austinCameras(rows: readonly AustinCameraRow[]): Camera[] {
  const cameras: Camera[] = [];
  for (const row of rows) {
    const id = row.camera_id?.trim() ?? "";
    if (!/^\d+$/.test(id)) continue;
    // Build the address from the id rather than trusting an arbitrary URL from the feed.
    if (row.screenshot_address?.trim() !== austinScreenshot(id)) continue;
    const [lon, lat] = row.location?.coordinates ?? [];
    if (typeof lon !== "number" || typeof lat !== "number") continue;
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || (lon === 0 && lat === 0)) continue;
    cameras.push({
      id: hashId(`austin:${id}`),
      lon,
      lat,
      fixTimeMs: 0,
      meta: {
        label: austinPlace(row.location_name ?? "") || `Camera ${id}`,
        provider: "Austin Transportation and Public Works",
        country: "United States",
        cameraId: id,
      },
    });
  }
  return cameras;
}

/** Detail panel content for one camera, from the facts stored with it. No request needed. */
export function austinDetail(meta: EntityMeta): Partial<EntityDetail> {
  const id = typeof meta.cameraId === "string" && /^\d+$/.test(meta.cameraId) ? meta.cameraId : "";
  if (!id) return {};
  const title = typeof meta.label === "string" && meta.label ? meta.label : `Camera ${id}`;
  return {
    title,
    subtitle: "Traffic camera · Austin, Texas, United States",
    fields: [
      { key: "cameraId", label: "Camera", value: id },
      { key: "provider", label: "Provider", value: "Austin Transportation and Public Works" },
    ],
    media: [
      {
        type: "image",
        url: austinScreenshot(id),
        link: DATASET_PAGE,
        credit: "Austin Transportation and Public Works",
        alt: `Traffic camera at ${title}, Austin`,
      },
    ],
    attribution: AUSTIN_ATTRIBUTION,
    sourceUrl: DATASET_PAGE,
  };
}

export const austinTrafficCameras = defineSource<AustinRaw>({
  id: SOURCE_ID,
  name: "City of Austin traffic cameras",
  layer: "webcams",
  transport: "fetch",
  schema: [
    { key: "label", label: "Place", type: "string" },
    { key: "provider", label: "Provider", type: "string" },
    { key: "country", label: "Country", type: "string" },
    { key: "cameraId", label: "Camera", type: "string" },
  ],
  // The list is republished daily; each screenshot keeps its address and is fetched on selection.
  refreshRate: 3_600_000,
  licence: {
    name: "Public domain (City of Austin Open Data Terms of Use)",
    url: TERMS_URL,
    display: true,
    redistribution: true,
    commercial: true,
    notes:
      "Offered free and without restriction, with no warranty; the City may ask for any display of its data to end. Socrata throttles requests without an app token.",
    verified: "2026-11-15",
  },
  attribution: AUSTIN_ATTRIBUTION,
  docs: DATASET_PAGE,

  async fetch(ctx) {
    const rows = await fetchJson<AustinCameraRow[]>(ctx, AUSTIN_API, "Austin's open data portal");
    return { rows, view: ctx.view };
  },

  normalise(raw, ctx): SourceOutput {
    const all = Array.isArray(raw.rows) ? austinCameras(raw.rows) : [];
    if (all.length === 0) {
      throw new SourceError(
        "bad-data",
        "Austin's open data portal sent a camera list this app cannot read.",
      );
    }
    const { cameras, rank } = selectCameras(all, {
      view: raw.view,
      cap: raw.view ? VIEW_CAP : LIST_FEED_CAP,
    });
    return { type: "entities", update: camerasToUpdate(SOURCE_ID, cameras, rank, ctx.now()) };
  },

  detail(_id, meta) {
    return meta ? austinDetail(meta) : {};
  },
});
