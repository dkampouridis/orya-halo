/**
 * Hong Kong traffic snapshot cameras, published by the Transport Department
 * on DATA.GOV.HK. Keyless.
 *
 * Verified 2026-11-14 (https://data.gov.hk/en/terms-and-conditions and
 * https://data.gov.hk/en-data/dataset/hk-td-tis_2-traffic-snapshot-images,
 * plus live requests): free to reproduce, distribute and link to for
 * commercial and non-commercial purposes, provided the source is identified
 * and the Government's ownership acknowledged; the camera list (XML, 405 KB,
 * 1,013 cameras) and the 320 x 240 JPEG snapshots answer
 * `Access-Control-Allow-Origin: *`; snapshots refresh every two minutes.
 */
import { defineSource, hashId } from "@orya-halo/schema";
import type { Attribution, EntityDetail, EntityMeta, SourceOutput } from "@orya-halo/schema";
import { SourceError, fetchBody } from "../shared/overlays/http.ts";
import { LIST_FEED_CAP, VIEW_CAP, camerasToUpdate, selectCameras } from "./shared.ts";
import type { Camera, CameraView } from "./shared.ts";

const LIST_URL =
  "https://static.data.gov.hk/td/traffic-snapshot-images/code/Traffic_Camera_Locations_En.xml";
const IMAGE_BASE = "https://tdcctv.data.one.gov.hk/";
const DATASET_PAGE = "https://data.gov.hk/en-data/dataset/hk-td-tis_2-traffic-snapshot-images";
const SOURCE_ID = "hk-traffic-cameras";

export const HK_TRAFFIC_ATTRIBUTION: Attribution = {
  text: "Traffic snapshot images © Transport Department, Government of the Hong Kong SAR, from DATA.GOV.HK",
  url: DATASET_PAGE,
  onMap: false,
};

export interface HkTrafficRaw {
  /** The camera list document. */
  xml: string;
  view?: CameraView;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function unescapeXml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ENTITIES[name]);
}

function tag(block: string, name: string): string {
  const match = new RegExp(`<${name}>([^<]*)</${name}>`).exec(block);
  return match ? unescapeXml(match[1]).trim() : "";
}

/** Address of a camera's current snapshot. Keys are letters and digits only. */
export function hkSnapshotUrl(key: string): string {
  return `${IMAGE_BASE}${key}.JPG`;
}

/** Read the camera list. Entries without a usable key or position are skipped. */
export function parseHkCameras(xml: string): Camera[] {
  const cameras: Camera[] = [];
  for (const match of xml.matchAll(/<image>([\s\S]*?)<\/image>/g)) {
    const block = match[1];
    const key = tag(block, "key");
    // parseFloat, not Number: an empty element must not read as latitude 0.
    const lat = Number.parseFloat(tag(block, "latitude"));
    const lon = Number.parseFloat(tag(block, "longitude"));
    if (
      !/^[A-Za-z0-9]+$/.test(key) ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      (lat === 0 && lon === 0)
    )
      continue;
    // Descriptions end with the key in brackets: "Aberdeen Praya Road near Fish Market [H429F]".
    const label = tag(block, "description").replace(/\s*\[[^\]]*\]\s*$/, "") || key;
    cameras.push({
      id: hashId(`hk-td:${key}`),
      lon,
      lat,
      fixTimeMs: 0,
      meta: {
        label,
        provider: "Transport Department, Hong Kong",
        country: "Hong Kong",
        key,
        district: tag(block, "district") || null,
        region: tag(block, "region") || null,
      },
    });
  }
  return cameras;
}

/** Detail panel content for one camera, from the facts stored with it. No request needed. */
export function hkCameraDetail(meta: EntityMeta): Partial<EntityDetail> {
  const key = typeof meta.key === "string" && /^[A-Za-z0-9]+$/.test(meta.key) ? meta.key : "";
  if (!key) return {};
  const title = typeof meta.label === "string" && meta.label ? meta.label : key;
  const district = typeof meta.district === "string" ? meta.district : "";
  const region = typeof meta.region === "string" ? meta.region : "";
  const place = [district, region !== district ? region : "", "Hong Kong"]
    .filter(Boolean)
    .join(", ");
  return {
    title,
    subtitle: `Traffic camera · ${place}`,
    fields: [
      { key: "key", label: "Camera", value: key },
      ...(district ? [{ key: "district", label: "District", value: district }] : []),
      { key: "interval", label: "New image every", value: "2", unit: "min", numeric: 2 },
    ],
    media: [
      {
        type: "image",
        url: hkSnapshotUrl(key),
        link: DATASET_PAGE,
        credit: "Transport Department, Hong Kong SAR Government · DATA.GOV.HK",
        alt: `Traffic camera at ${title}, Hong Kong`,
      },
    ],
    attribution: HK_TRAFFIC_ATTRIBUTION,
    sourceUrl: DATASET_PAGE,
  };
}

export const hkTrafficCameras = defineSource<HkTrafficRaw>({
  id: SOURCE_ID,
  name: "Hong Kong Transport Department traffic cameras (DATA.GOV.HK)",
  layer: "webcams",
  transport: "fetch",
  schema: [
    { key: "label", label: "Place", type: "string" },
    { key: "provider", label: "Provider", type: "string" },
    { key: "country", label: "Country", type: "string" },
    { key: "key", label: "Camera", type: "string" },
    { key: "district", label: "District", type: "string" },
    { key: "region", label: "Region", type: "string" },
  ],
  // The camera list changes a few times a year; the snapshots are fetched on selection.
  refreshRate: 3_600_000,
  licence: {
    name: "DATA.GOV.HK terms and conditions of use",
    url: "https://data.gov.hk/en/terms-and-conditions",
    display: true,
    redistribution: true,
    commercial: true,
    notes:
      "Identify the source, acknowledge the Government's ownership of the data, and credit the Government, the Transport Department and DATA.GOV.HK. Data is provided as is.",
    verified: "2026-11-14",
  },
  attribution: HK_TRAFFIC_ATTRIBUTION,
  docs: DATASET_PAGE,

  async fetch(ctx) {
    return { xml: await fetchBody(ctx, LIST_URL, "DATA.GOV.HK"), view: ctx.view };
  },

  normalise(raw, ctx): SourceOutput {
    const all = parseHkCameras(raw.xml);
    if (all.length === 0)
      throw new SourceError("bad-data", "DATA.GOV.HK sent a camera list this app cannot read.");
    const { cameras, rank } = selectCameras(all, {
      view: raw.view,
      cap: raw.view ? VIEW_CAP : LIST_FEED_CAP,
    });
    return { type: "entities", update: camerasToUpdate(SOURCE_ID, cameras, rank, ctx.now()) };
  },

  detail(_id, meta) {
    return meta ? hkCameraDetail(meta) : {};
  },
});
