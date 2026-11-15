/**
 * Undersea telecommunications cables from OpenStreetMap, baked into a static
 * asset by `packages/sources/scripts/build-cables.ts`.
 *
 * Coverage is what OpenStreetMap volunteers have mapped: strong around
 * Europe and the North Atlantic, thin in the Pacific. See the build script's
 * output for the numbers of the current asset.
 */
import { defineSource } from "@orya-halo/schema";
import type {
  Attribution,
  DetailField,
  EntityDetail,
  EntityMeta,
  SourceContext,
  SourceOutput,
} from "@orya-halo/schema";
import { SourceError, assetUrl, fetchBytes } from "../shared/overlays/http.ts";
import { UNNAMED_CABLE, decodeCables } from "./format.ts";

/** Path of the asset under the app's asset base. */
export const CABLES_ASSET = "data/cables.bin";

export const OSM_ATTRIBUTION: Attribution = {
  text: "© OpenStreetMap contributors",
  url: "https://www.openstreetmap.org/copyright",
  onMap: true,
};

function osmWayUrl(way: number): string {
  return `https://www.openstreetmap.org/way/${way}`;
}

/** Detail panel content for one cable, from the facts stored with its path. */
export function cableDetail(meta: EntityMeta): Partial<EntityDetail> {
  const name = typeof meta.label === "string" && meta.label ? meta.label : UNNAMED_CABLE;
  const operator = typeof meta.operator === "string" ? meta.operator : "";
  const lengthKm = typeof meta.lengthKm === "number" ? meta.lengthKm : null;
  const way = typeof meta.osmWay === "number" ? meta.osmWay : null;
  const wikidata = typeof meta.wikidata === "string" ? meta.wikidata : "";

  const fields: DetailField[] = [];
  if (operator) fields.push({ key: "operator", label: "Operator", value: operator });
  if (lengthKm !== null) {
    fields.push({
      key: "lengthKm",
      label: "Mapped length",
      value: lengthKm.toLocaleString("en-GB"),
      unit: "km",
      numeric: lengthKm,
    });
  }
  if (wikidata) fields.push({ key: "wikidata", label: "Wikidata", value: wikidata });

  const detail: Partial<EntityDetail> = {
    title: name,
    subtitle: operator ? `Undersea cable · ${operator}` : "Undersea telecommunications cable",
    fields,
    attribution: OSM_ATTRIBUTION,
    meta,
  };
  if (way !== null) detail.sourceUrl = osmWayUrl(way);
  return detail;
}

async function loadAsset(
  ctx: Pick<SourceContext, "fetch" | "signal" | "assetBase">,
): Promise<ArrayBuffer> {
  return fetchBytes(ctx, assetUrl(ctx.assetBase, CABLES_ASSET), "The cable data file");
}

export const osmCables = defineSource<ArrayBuffer>({
  id: "osm-cables",
  name: "OpenStreetMap",
  layer: "cables",
  transport: "static",
  schema: [
    { key: "label", label: "Name", type: "string" },
    { key: "operator", label: "Operator", type: "string" },
    { key: "lengthKm", label: "Mapped length", type: "number", unit: "km" },
    { key: "osmWay", label: "OpenStreetMap way", type: "number" },
    { key: "wikidata", label: "Wikidata", type: "string" },
    { key: "named", label: "Has a name", type: "boolean" },
  ],
  refreshRate: 0,
  licence: {
    name: "ODbL 1.0",
    url: "https://opendatacommons.org/licenses/odbl/1-0/",
    display: true,
    redistribution: true,
    commercial: true,
    notes:
      "Attribution required. Share-alike: the baked cable file is a derived database and is itself offered under ODbL 1.0.",
    verified: "2026-11-14",
  },
  attribution: OSM_ATTRIBUTION,
  docs: "https://wiki.openstreetmap.org/wiki/Tag:communication%3Dline",

  fetch(ctx) {
    return loadAsset(ctx);
  },

  normalise(raw): SourceOutput {
    try {
      return { type: "paths", paths: decodeCables(raw).paths };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown format";
      throw new SourceError("bad-data", `The cable data file could not be read. ${reason}`);
    }
  },

  async detail(id, meta, ctx) {
    if (meta && typeof meta.osmWay === "number") return cableDetail(meta);
    // No facts came with the selection: look the cable up in the asset (served from the HTTP cache).
    const { paths } = decodeCables(await loadAsset(ctx));
    const index = paths.ids.indexOf(id);
    const facts = index === -1 ? undefined : paths.meta?.[index];
    return facts ? cableDetail(facts) : {};
  },
});
