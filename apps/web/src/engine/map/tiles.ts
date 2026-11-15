/**
 * Where base map tiles come from.
 *
 * Out of the box, with no key: `public/tiles/world.pmtiles`, a whole-world
 * Protomaps extract for zoom 0 to 5 written by `scripts/fetch-tiles.mjs`.
 * Past its last zoom MapLibre overzooms it, so the globe always works, just
 * without street detail.
 *
 * For detail down to street level, set one of:
 *   VITE_PMTILES_URL    a PMTiles archive you host (your own bucket, with CORS
 *                       for your origin). Protomaps asks people not to hotlink
 *                       its build bucket, and that bucket only answers CORS for
 *                       localhost anyway.
 *   VITE_PROTOMAPS_KEY  a key for Protomaps' hosted tile API, which is free for
 *                       non-commercial use.
 *
 * One MapLibre protocol stitches the two together: low zooms always come from
 * the local file (same origin, one small download), deeper zooms from the
 * configured source.
 */
import type { AddProtocolAction } from "maplibre-gl";
import { PMTiles } from "pmtiles";

export const TILE_PROTOCOL = "halo-tiles";
const API_TEMPLATE = "https://api.protomaps.com/tiles/v4/{z}/{x}/{y}.mvt?key={key}";
/** Protomaps builds stop at zoom 15; MapLibre overzooms beyond. */
const DEEP_MAX_ZOOM = 15;

/** Credit required by OpenStreetMap's licence, plus the courtesy credit Protomaps asks for. */
export const BASEMAP_CREDITS = [
  { text: "Protomaps", url: "https://protomaps.com" },
  { text: "© OpenStreetMap", url: "https://openstreetmap.org/copyright" },
] as const;

/** The same credit as HTML, for the style's source (where other tools that read the style expect it). */
export const BASEMAP_ATTRIBUTION = BASEMAP_CREDITS.map(
  (c) => `<a href="${c.url}" target="_blank" rel="noopener">${c.text}</a>`,
).join(" ");

export interface TileOptions {
  /** Base URL of the app's static assets. */
  assetBase: string;
  /** `VITE_PMTILES_URL`, if set. */
  pmtilesUrl?: string;
  /** `VITE_PROTOMAPS_KEY`, if set. */
  apiKey?: string;
}

export interface TileSetup {
  /** Tile URL template for the style's vector source. */
  template: string;
  maxZoom: number;
  attribution: string;
  /** Register with `addProtocol(TILE_PROTOCOL, load)`. */
  load: AddProtocolAction;
  /** What was found. The engine turns this into its status; nothing is written to the console. */
  local: boolean;
  deep: "pmtiles" | "api" | null;
  /** True when `VITE_PMTILES_URL` was set but could not be read. */
  remoteFailed: boolean;
}

/** Which source serves a tile at zoom `z`. Exported for tests. */
export function routeTile(
  z: number,
  localMaxZoom: number | null,
  deep: "pmtiles" | "api" | null,
): "local" | "pmtiles" | "api" | "none" {
  if (localMaxZoom !== null && z <= localMaxZoom) return "local";
  return deep ?? "none";
}

export function joinAsset(base: string, path: string): string {
  return `${base.endsWith("/") ? base : `${base}/`}${path.replace(/^\//, "")}`;
}

async function openArchive(url: string): Promise<{ archive: PMTiles; maxZoom: number } | null> {
  try {
    const archive = new PMTiles(url);
    const header = await archive.getHeader();
    return { archive, maxZoom: header.maxZoom };
  } catch {
    // Missing file, a dev server answering with index.html, or a CORS refusal.
    return null;
  }
}

/**
 * An empty tile. A new buffer every time: MapLibre hands tile data to its
 * worker by transfer, which detaches the buffer, so a shared one would fail
 * on its second use.
 */
const empty = (): Uint8Array => new Uint8Array(0);

export async function createTileSetup(options: TileOptions): Promise<TileSetup> {
  const [local, remote] = await Promise.all([
    openArchive(joinAsset(options.assetBase, "tiles/world.pmtiles")),
    options.pmtilesUrl ? openArchive(options.pmtilesUrl) : Promise.resolve(null),
  ]);
  const deep = remote ? "pmtiles" : options.apiKey ? "api" : null;
  const localMaxZoom = local ? local.maxZoom : null;

  const load: AddProtocolAction = async (request, abort) => {
    const match = /\/(\d+)\/(\d+)\/(\d+)$/.exec(request.url);
    if (!match) throw new Error(`Bad tile URL: ${request.url}`);
    const z = Number(match[1]);
    const x = Number(match[2]);
    const y = Number(match[3]);
    const route = routeTile(z, localMaxZoom, deep);

    if (route === "local" || route === "pmtiles") {
      const archive = route === "local" ? local?.archive : remote?.archive;
      const tile = await archive?.getZxy(z, x, y, abort.signal);
      return tile
        ? {
            data: new Uint8Array(tile.data),
            cacheControl: tile.cacheControl,
            expires: tile.expires,
          }
        : { data: empty() };
    }
    if (route === "api" && options.apiKey) {
      const url = API_TEMPLATE.replace("{z}", String(z))
        .replace("{x}", String(x))
        .replace("{y}", String(y))
        .replace("{key}", encodeURIComponent(options.apiKey));
      const res = await fetch(url, { signal: abort.signal });
      if (res.status === 204 || res.status === 404) return { data: empty() };
      if (!res.ok) throw new Error(`Tile request failed (${res.status})`);
      return {
        data: new Uint8Array(await res.arrayBuffer()),
        cacheControl: res.headers.get("cache-control") ?? undefined,
      };
    }
    return { data: empty() };
  };

  return {
    template: `${TILE_PROTOCOL}://tiles/{z}/{x}/{y}`,
    maxZoom: deep ? (remote?.maxZoom ?? DEEP_MAX_ZOOM) : (localMaxZoom ?? 5),
    attribution: BASEMAP_ATTRIBUTION,
    load,
    local: local !== null,
    deep,
    remoteFailed: Boolean(options.pmtilesUrl) && !remote,
  };
}
