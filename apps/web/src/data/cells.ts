/**
 * Viewport to H3 cells, for gateway subscriptions.
 *
 * H3's polygon fill misbehaves on the shapes a globe camera produces: boxes
 * wider than a hemisphere, boxes across the antimeridian, boxes that contain
 * a pole. So the cover is built by sampling instead: points on a grid finer
 * than a cell, each mapped to its cell, then one ring of neighbours added.
 * The ring both closes any sliver a sample could miss and gives the margin
 * that keeps objects arriving just before they slide into view.
 */
import { gridDisk, latLngToCell } from "h3-js";
import type { SubscriptionRes, ViewState } from "@orya-halo/schema";

export interface CellCover {
  res: SubscriptionRes;
  /** Sorted H3 indexes at `res`. Empty when `res` is 0 (whole world). */
  cells: string[];
}

/** Average hexagon edge, km, by resolution (H3 documentation). */
const EDGE_KM = [1281.256, 483.057, 182.513, 68.979];
/** Average hexagon area, km2, by resolution. */
const AREA_KM2 = [4_357_449, 609_788, 86_802, 12_393];
const KM_PER_DEG = 111.195;
const DEG = Math.PI / 180;
/** Grow the box by this share of its size on every side before covering it. */
const MARGIN = 0.1;

/** Finest resolution worth asking for at a zoom level. 0 is the whole world. */
export function resolutionForView(view: Pick<ViewState, "zoom" | "global">): SubscriptionRes {
  if (view.global || !(view.zoom >= 3)) return 0;
  if (view.zoom < 4.5) return 1;
  if (view.zoom < 6) return 2;
  return 3;
}

interface Box {
  west: number;
  south: number;
  /** Degrees of longitude from `west`, eastwards. 360 is all the way round. */
  width: number;
  north: number;
}

/** Normalise bounds (which may cross the antimeridian) and add the margin. Null when unusable. */
function toBox(bounds: readonly [number, number, number, number]): Box | null {
  const [west, south, east, north] = bounds;
  if (
    !Number.isFinite(west) ||
    !Number.isFinite(south) ||
    !Number.isFinite(east) ||
    !Number.isFinite(north)
  )
    return null;
  if (north < south) return null;
  let width = east - west;
  // West greater than east means the box runs across the antimeridian.
  if (width < 0) width += 360;
  if (width > 360) width = 360;
  const height = north - south;
  const padLat = Math.max(height * MARGIN, 0.05);
  const padLon = Math.max(width * MARGIN, 0.05);
  const s = Math.max(-90, south - padLat);
  const n = Math.min(90, north + padLat);
  const w = width + 2 * padLon >= 360 ? -180 : west - padLon;
  return { west: w, south: s, north: n, width: Math.min(360, width + 2 * padLon) };
}

function boxAreaKm2(box: Box): number {
  const r = 6371.0088;
  return r * r * (box.width * DEG) * (Math.sin(box.north * DEG) - Math.sin(box.south * DEG));
}

/** Cells at `res` (1 to 3) covering `bounds` plus a margin. Sorted. */
export function coverBounds(
  bounds: readonly [number, number, number, number],
  res: number,
): string[] {
  const box = toBox(bounds);
  if (!box) return [];
  const seeds = new Set<string>();
  // 0.6 of an edge: the furthest any point sits from a sample is then well
  // under one cell edge, so its cell is a seed or a seed's neighbour.
  const stepLat = (EDGE_KM[res] * 0.6) / KM_PER_DEG;
  const rows = Math.max(1, Math.ceil((box.north - box.south) / stepLat));
  for (let r = 0; r <= rows; r++) {
    const lat = box.south + ((box.north - box.south) * r) / rows;
    // Meridians converge, so fewer samples are needed towards the poles.
    const stepLon = stepLat / Math.max(Math.cos(lat * DEG), 0.02);
    const cols = Math.max(1, Math.ceil(box.width / stepLon));
    for (let c = 0; c <= cols; c++) {
      let lon = box.west + (box.width * c) / cols;
      lon = ((((lon + 180) % 360) + 360) % 360) - 180;
      seeds.add(latLngToCell(lat, lon, res));
    }
  }
  const cells = new Set<string>();
  for (const seed of seeds) {
    for (const cell of gridDisk(seed, 1)) cells.add(cell);
  }
  return [...cells].sort();
}

/**
 * The subscription for a view: the finest resolution the zoom deserves that
 * fits within `maxCells`, coarsening as needed, down to the whole world.
 */
export function cellsForView(view: ViewState, maxCells: number): CellCover {
  let res: number = resolutionForView(view);
  const box = res === 0 ? null : toBox(view.bounds);
  if (!box) return { res: 0, cells: [] };
  const area = boxAreaKm2(box);
  while (res > 0) {
    // Skip resolutions that plainly cannot fit before paying for the cover.
    if (area / AREA_KM2[res] <= maxCells) {
      const cells = coverBounds(view.bounds, res);
      if (cells.length <= maxCells) return { res: res as SubscriptionRes, cells };
    }
    res--;
  }
  return { res: 0, cells: [] };
}
