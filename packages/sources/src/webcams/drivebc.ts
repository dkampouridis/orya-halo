/**
 * British Columbia's highway cameras (DriveBC HighwayCams), published by the
 * Ministry of Transportation and Transit in the B.C. Data Catalogue.
 * Keyless.
 *
 * Verified 2026-11-15 (https://catalogue.data.gov.bc.ca/dataset/bc-highwaycams
 * and the licence at
 * https://www2.gov.bc.ca/gov/content?id=A519A56BC2BF44E4A008B33FCF527F61,
 * plus live requests): Open Government Licence – British Columbia 2.0, which
 * allows copying, publishing, adapting and distributing, commercial or not,
 * with the statement "Contains information licensed under the Open
 * Government Licence – British Columbia" and, where possible, a link; no
 * suggestion of official status. The licence covers the Catalogue records;
 * for the images themselves the only explicit statement is the BC HighwayCam
 * terms page (images.drivebc.ca, as archived on 2025-08-17; drivebc.ca now
 * has no terms page): "BC HighwayCam images are now available through DataBC
 * Catalogue, and may be republished under the terms and conditions of the
 * Open Government License (OGL)." The CSV (about 250 KB, some 1,040 views at
 * about 490 locations, updated monthly) and the camera images answer
 * `Access-Control-Allow-Origin: *`; the images also send
 * `Cross-Origin-Resource-Policy: cross-origin`.
 */
import { defineSource, hashId } from "@orya-halo/schema";
import type {
  Attribution,
  DetailField,
  DetailMedia,
  EntityDetail,
  EntityMeta,
  SourceOutput,
} from "@orya-halo/schema";
import { columnIndexes, parseCsv } from "../shared/space-earth/csv.ts";
import { SourceError, fetchBody } from "../shared/overlays/http.ts";
import { LIST_FEED_CAP, VIEW_CAP, camerasToUpdate, plainText, selectCameras } from "./shared.ts";
import type { Camera, CameraView } from "./shared.ts";

export const DRIVEBC_CSV =
  "https://catalogue.data.gov.bc.ca/dataset/6b39a910-6c77-476f-ac96-7b4f18849b1c/resource/a9d52d85-8402-4ce7-b2ac-a2779837c48a/download/webcams.csv";
const DATASET_PAGE = "https://catalogue.data.gov.bc.ca/dataset/bc-highwaycams";
const LICENCE_URL = "https://www2.gov.bc.ca/gov/content?id=A519A56BC2BF44E4A008B33FCF527F61";
const SOURCE_ID = "drivebc-highwaycams";

export const DRIVEBC_ATTRIBUTION: Attribution = {
  text: "DriveBC HighwayCams, B.C. Ministry of Transportation and Transit. Contains information licensed under the Open Government Licence – British Columbia",
  url: LICENCE_URL,
  onMap: false,
};

export interface DriveBcRaw {
  /** The camera list (CSV). */
  csv: string;
  view?: CameraView;
}

const COLUMNS = [
  "id",
  "cam_group",
  "camName",
  "caption",
  "credit",
  "region_name",
  "highway_number",
  "orientation",
  "latitude",
  "longitude",
] as const;

/** The camera's image and its page on DriveBC. Ids are digits only. */
export function driveBcImage(viewId: string): { image: string; page: string } {
  return {
    image: `https://www.drivebc.ca/images/${viewId}.jpg`,
    page: `https://www.drivebc.ca/cameras/${viewId}`,
  };
}

/** "Britannia - S" → "Britannia"; the direction is shown with each image instead. */
function placeName(camName: string): string {
  return camName.replace(/\s+-\s+[NSEW]{1,2}B?$/, "").trim() || camName.trim();
}

/** "Highway 99 at Copper Drive in Britannia Beach, looking south." → without the direction. */
function describe(caption: string): string {
  return plainText(caption)
    .replace(/,?\s*looking\s+[a-z -]+\.?$/i, "")
    .replace(/\.$/, "")
    .trim();
}

/**
 * One camera per location. DriveBC lists each direction a camera looks as
 * its own view and groups views on one pole by `cam_group`; the map shows
 * the group and the panel shows every view.
 */
export function driveBcCameras(csv: string): Camera[] {
  const { header, rows } = parseCsv(csv);
  const col = columnIndexes(header, COLUMNS);
  if (col.id < 0 || col.latitude < 0 || col.longitude < 0) return [];

  const groups = new Map<string, string[][]>();
  for (const row of rows) {
    const id = row[col.id]?.trim() ?? "";
    if (!/^\d+$/.test(id)) continue;
    const group = col.cam_group >= 0 && /^\d+$/.test(row[col.cam_group]?.trim() ?? "");
    const key = group ? row[col.cam_group].trim() : id;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  const cameras: Camera[] = [];
  for (const [group, views] of groups) {
    // The view whose id names the group is the camera's main one; order the rest by id.
    views.sort((a, b) => {
      const main = Number(b[col.id] === group) - Number(a[col.id] === group);
      return main || Number(a[col.id]) - Number(b[col.id]);
    });
    const first = views[0];
    const lat = Number.parseFloat(first[col.latitude]);
    const lon = Number.parseFloat(first[col.longitude]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
      continue;
    if (lat === 0 && lon === 0) continue;
    const cell = (row: string[], name: (typeof COLUMNS)[number]) =>
      col[name] >= 0 ? (row[col[name]] ?? "").trim() : "";
    const name = plainText(cell(first, "camName"));
    cameras.push({
      id: hashId(`drivebc:${group}`),
      lon,
      lat,
      fixTimeMs: 0,
      meta: {
        label: placeName(name) || `Camera ${group}`,
        provider: "B.C. Ministry of Transportation and Transit",
        country: "Canada",
        group,
        // Each view's id and the way it looks, as "520:S,521:N".
        views: views
          .map((row) => `${cell(row, "id")}:${cell(row, "orientation").replace(/[^A-Z]/g, "")}`)
          .join(","),
        place: describe(cell(first, "caption")) || null,
        highway: cell(first, "highway_number") || null,
        region: cell(first, "region_name") || null,
        note: plainText(cell(first, "credit")) || null,
      },
    });
  }
  return cameras;
}

const DIRECTIONS: Record<string, string> = {
  N: "north",
  S: "south",
  E: "east",
  W: "west",
  NE: "north-east",
  NW: "north-west",
  SE: "south-east",
  SW: "south-west",
};

/** Detail panel content for one location, from the facts stored with it. No request needed. */
export function driveBcDetail(meta: EntityMeta): Partial<EntityDetail> {
  const views = (typeof meta.views === "string" ? meta.views : "")
    .split(",")
    .map((view) => view.split(":"))
    .filter(([id]) => /^\d+$/.test(id ?? ""));
  if (views.length === 0) return {};
  const title = typeof meta.label === "string" && meta.label ? meta.label : `Camera ${views[0][0]}`;
  const text = (key: string) => (typeof meta[key] === "string" ? (meta[key] as string) : "");
  const region = text("region");

  const media: DetailMedia[] = views.map(([id, way]) => {
    const { image, page } = driveBcImage(id);
    const looking = DIRECTIONS[way ?? ""];
    return {
      type: "image",
      url: image,
      link: page,
      credit: "DriveBC, B.C. Ministry of Transportation and Transit",
      alt: `Highway camera at ${title}${looking ? `, looking ${looking}` : ""}`,
    };
  });

  const fields: DetailField[] = [];
  if (text("place")) fields.push({ key: "place", label: "Where", value: text("place") });
  if (text("highway")) fields.push({ key: "highway", label: "Highway", value: text("highway") });
  if (region) fields.push({ key: "region", label: "Region", value: region });
  fields.push({
    key: "views",
    label: "Camera views",
    value: String(media.length),
    numeric: media.length,
  });
  if (text("note")) fields.push({ key: "note", label: "Note", value: text("note") });
  fields.push({
    key: "provider",
    label: "Provider",
    value: "B.C. Ministry of Transportation and Transit",
  });

  return {
    title,
    subtitle: `Highway camera · ${[region, "British Columbia"].filter(Boolean).join(", ")}`,
    fields,
    media,
    attribution: DRIVEBC_ATTRIBUTION,
    sourceUrl: driveBcImage(views[0][0]).page,
  };
}

export const driveBcHighwayCams = defineSource<DriveBcRaw>({
  id: SOURCE_ID,
  name: "DriveBC highway cameras (B.C. Ministry of Transportation and Transit)",
  layer: "webcams",
  transport: "fetch",
  schema: [
    { key: "label", label: "Place", type: "string" },
    { key: "provider", label: "Provider", type: "string" },
    { key: "country", label: "Country", type: "string" },
    { key: "group", label: "Camera", type: "string" },
    { key: "views", label: "Views", type: "string" },
    { key: "place", label: "Where", type: "string" },
    { key: "highway", label: "Highway", type: "string" },
    { key: "region", label: "Region", type: "string" },
    { key: "note", label: "Note", type: "string" },
  ],
  // The list is republished monthly; the images are fetched on selection.
  refreshRate: 6 * 3_600_000,
  licence: {
    name: "Open Government Licence – British Columbia 2.0",
    url: LICENCE_URL,
    display: true,
    redistribution: true,
    commercial: true,
    notes:
      'Include "Contains information licensed under the Open Government Licence – British Columbia" with a link where possible; do not suggest official status or use the Province\'s marks.',
    verified: "2026-11-15",
  },
  attribution: DRIVEBC_ATTRIBUTION,
  docs: DATASET_PAGE,

  async fetch(ctx) {
    return { csv: await fetchBody(ctx, DRIVEBC_CSV, "The B.C. Data Catalogue"), view: ctx.view };
  },

  normalise(raw, ctx): SourceOutput {
    const all = driveBcCameras(raw.csv ?? "");
    if (all.length === 0) {
      throw new SourceError(
        "bad-data",
        "The B.C. Data Catalogue sent a camera list this app cannot read.",
      );
    }
    const { cameras, rank } = selectCameras(all, {
      view: raw.view,
      cap: raw.view ? VIEW_CAP : LIST_FEED_CAP,
    });
    return { type: "entities", update: camerasToUpdate(SOURCE_ID, cameras, rank, ctx.now()) };
  },

  detail(_id, meta) {
    return meta ? driveBcDetail(meta) : {};
  },
});
