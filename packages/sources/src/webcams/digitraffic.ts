/**
 * Finland's road weather cameras, published by Fintraffic through
 * Digitraffic. Keyless and openly licensed, so the webcam layer works with
 * no configuration.
 *
 * Verified 2026-11-14 (https://www.digitraffic.fi/en/terms-of-service/ and
 * https://www.digitraffic.fi/en/support/instructions/, plus live requests):
 * CC BY 4.0; credit "Source: Fintraffic / digitraffic.fi, license CC 4.0 BY";
 * 60 requests a minute per address without an identifying header, more with
 * one; the station list and the images answer
 * `Access-Control-Allow-Origin: *` and the `Digitraffic-User` header is
 * allowed cross-origin. 813 stations, about 2,300 camera views, each
 * refreshed every ten minutes.
 */
import { defineSource, hashId } from "@orya-halo/schema";
import type {
  Attribution,
  DetailField,
  DetailMedia,
  EntityDetail,
  SourceOutput,
} from "@orya-halo/schema";
import { SourceError, fetchJson } from "../shared/overlays/http.ts";
import { LIST_FEED_CAP, VIEW_CAP, camerasToUpdate, selectCameras } from "./shared.ts";
import type { Camera, CameraView } from "./shared.ts";

const API = "https://tie.digitraffic.fi/api/weathercam/v1/stations";
const IMAGE_BASE = "https://weathercam.digitraffic.fi/";
const SOURCE_ID = "digitraffic-weathercams";

/** Identifies the application, as Digitraffic asks. No personal details. */
const HEADERS = { "Digitraffic-User": "OryaHalo/0.1" };

export const DIGITRAFFIC_ATTRIBUTION: Attribution = {
  text: "Source: Fintraffic / digitraffic.fi, license CC 4.0 BY",
  url: "https://www.digitraffic.fi/en/road-traffic/",
  onMap: false,
};

/** The station list (GeoJSON), as far as this plugin reads it. */
export interface DigitrafficStations {
  dataUpdatedTime?: string;
  features?: {
    id?: string;
    geometry?: { coordinates?: number[] } | null;
    properties?: {
      id?: string;
      name?: string;
      collectionStatus?: string;
      dataUpdatedTime?: string;
      presets?: { id?: string; inCollection?: boolean }[];
    };
  }[];
}

/** One station's detail document, as far as `detail()` reads it. */
export interface DigitrafficStation {
  id?: string;
  properties?: {
    id?: string;
    name?: string;
    names?: { fi?: string; sv?: string; en?: string };
    municipality?: string;
    province?: string;
    collectionInterval?: number;
    dataUpdatedTime?: string;
    roadAddress?: { roadNumber?: number };
    presets?: {
      id?: string;
      presentationName?: string | null;
      inCollection?: boolean;
      imageUrl?: string;
    }[];
  };
}

export interface DigitrafficRaw {
  stations: DigitrafficStations;
  view?: CameraView;
}

/** Page on Fintraffic's own traffic service that shows a station's cameras. */
function stationPage(stationId: string): string {
  return `https://liikennetilanne.fintraffic.fi/kelikamerat/?cameraId=${encodeURIComponent(stationId)}`;
}

/**
 * Station names are "road_place_detail", e.g. "vt6_Imatra_Rönkkä": show the
 * place and keep the road code as its own fact.
 */
export function splitStationName(name: string): { label: string; road: string } {
  const parts = name.split("_").filter((p) => p !== "");
  if (parts.length < 2 || !/^[a-zåäö]{1,3}\d+$/i.test(parts[0])) {
    return { label: parts.join(" ") || name, road: "" };
  }
  return { label: parts.slice(1).join(" "), road: parts[0] };
}

/** Stations that are collecting images, as cameras. */
export function digitrafficCameras(stations: DigitrafficStations): Camera[] {
  const cameras: Camera[] = [];
  for (const feature of stations.features ?? []) {
    const p = feature.properties;
    const stationId = p?.id ?? feature.id;
    const [lon, lat] = feature.geometry?.coordinates ?? [];
    if (!p || !stationId || !Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (p.collectionStatus !== "GATHERING") continue;
    const views = (p.presets ?? []).filter((preset) => preset.inCollection && preset.id).length;
    if (views === 0) continue;
    const { label, road } = splitStationName(p.name ?? stationId);
    const updated = Date.parse(p.dataUpdatedTime ?? "");
    cameras.push({
      id: hashId(`fi-weathercam:${stationId}`),
      lon,
      lat,
      fixTimeMs: Number.isNaN(updated) ? 0 : updated,
      meta: {
        label,
        provider: "Fintraffic",
        country: "Finland",
        stationId,
        road: road || null,
        views,
      },
    });
  }
  return cameras;
}

/** Detail panel content from a station document. */
export function digitrafficDetail(
  station: DigitrafficStation,
  fallbackLabel?: string,
): Partial<EntityDetail> {
  const p = station.properties ?? {};
  const stationId = p.id ?? station.id ?? "";
  const title = p.names?.en || p.names?.fi || fallbackLabel || p.name || stationId;
  const place = [p.municipality, p.province, "Finland"].filter(Boolean).join(", ");
  const link = stationPage(stationId);

  const media: DetailMedia[] = [];
  for (const preset of p.presets ?? []) {
    if (!preset.inCollection || !preset.id) continue;
    // Build the address from the preset id rather than trusting an arbitrary URL from the feed.
    const url = `${IMAGE_BASE}${encodeURIComponent(preset.id)}.jpg`;
    const view = preset.presentationName ? `, view "${preset.presentationName}"` : "";
    media.push({
      type: "image",
      url,
      link,
      credit: "Fintraffic / digitraffic.fi, CC BY 4.0",
      alt: `Road weather camera at ${title}${view}`,
    });
  }

  const fields: DetailField[] = [];
  if (p.roadAddress?.roadNumber !== undefined) {
    fields.push({
      key: "road",
      label: "Road",
      value: String(p.roadAddress.roadNumber),
      numeric: p.roadAddress.roadNumber,
    });
  }
  if (p.municipality)
    fields.push({ key: "municipality", label: "Municipality", value: p.municipality });
  if (p.collectionInterval) {
    const minutes = Math.round(p.collectionInterval / 60);
    fields.push({
      key: "interval",
      label: "New image every",
      value: String(minutes),
      unit: "min",
      numeric: minutes,
    });
  }
  fields.push({
    key: "views",
    label: "Camera views",
    value: String(media.length),
    numeric: media.length,
  });

  const detail: Partial<EntityDetail> = {
    title,
    subtitle: place ? `Road weather camera · ${place}` : "Road weather camera",
    fields,
    media,
    attribution: DIGITRAFFIC_ATTRIBUTION,
    sourceUrl: link,
  };
  const updated = Date.parse(p.dataUpdatedTime ?? "");
  if (!Number.isNaN(updated)) detail.fixTimeMs = updated;
  return detail;
}

export const digitrafficWeathercams = defineSource<DigitrafficRaw>({
  id: SOURCE_ID,
  name: "Fintraffic road weather cameras (Digitraffic)",
  layer: "webcams",
  transport: "fetch",
  schema: [
    { key: "label", label: "Place", type: "string" },
    { key: "provider", label: "Provider", type: "string" },
    { key: "country", label: "Country", type: "string" },
    { key: "stationId", label: "Station", type: "string" },
    { key: "road", label: "Road", type: "string" },
    { key: "views", label: "Camera views", type: "number" },
  ],
  // The list only changes when stations are added or serviced; images are fetched on selection.
  refreshRate: 600_000,
  licence: {
    name: "CC BY 4.0",
    url: "https://www.digitraffic.fi/en/terms-of-service/",
    display: true,
    redistribution: true,
    commercial: true,
    notes:
      "Credit Fintraffic / digitraffic.fi with the licence. 60 requests a minute per address without a Digitraffic-User header; this plugin sends one. Say so if an image is modified.",
    verified: "2026-11-14",
  },
  attribution: DIGITRAFFIC_ATTRIBUTION,
  docs: "https://www.digitraffic.fi/en/road-traffic/",

  async fetch(ctx) {
    const stations = await fetchJson<DigitrafficStations>(ctx, API, "Digitraffic", {
      headers: HEADERS,
    });
    return { stations, view: ctx.view };
  },

  normalise(raw, ctx): SourceOutput {
    if (!Array.isArray(raw.stations?.features)) {
      throw new SourceError("bad-data", "Digitraffic sent a camera list this app cannot read.");
    }
    const { cameras, rank } = selectCameras(digitrafficCameras(raw.stations), {
      view: raw.view,
      cap: raw.view ? VIEW_CAP : LIST_FEED_CAP,
    });
    return { type: "entities", update: camerasToUpdate(SOURCE_ID, cameras, rank, ctx.now()) };
  },

  async detail(_id, meta, ctx) {
    const stationId = typeof meta?.stationId === "string" ? meta.stationId : "";
    if (!/^C\d+$/.test(stationId)) return {};
    const station = await fetchJson<DigitrafficStation>(ctx, `${API}/${stationId}`, "Digitraffic", {
      headers: HEADERS,
    });
    return digitrafficDetail(station, typeof meta?.label === "string" ? meta.label : undefined);
  },
});
