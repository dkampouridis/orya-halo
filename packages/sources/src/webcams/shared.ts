/**
 * What the webcam plugins share: one camera shape, density ranking, viewport
 * thinning and the conversion to an `EntityUpdate`.
 *
 * Every camera gets a rank in the `value` column: the lowest zoom at which it
 * should appear so that cameras stay about 64 px apart. A renderer can filter
 * on it with no refetch. When a viewport is known the plugins also drop what
 * the view cannot show, and cap the count.
 */
import { EntityFlag, EntityKind, createColumns } from "@orya-halo/schema";
import type { EntityMeta, EntityUpdate, SourceContext } from "@orya-halo/schema";

/** One camera, already in the app's terms. */
export interface Camera {
  /** Stable numeric id, unique within the webcam kind. */
  id: number;
  lon: number;
  lat: number;
  /** When the camera last reported, Unix epoch milliseconds; 0 when unknown. */
  fixTimeMs: number;
  meta: EntityMeta;
}

/** The part of the viewport the webcam plugins use. */
export type CameraView = Pick<NonNullable<SourceContext["view"]>, "zoom" | "bounds">;

/** Deepest rank handed out; cameras closer together than this share it. */
export const MAX_RANK = 14;

/** Degrees of longitude that 64 px cover at zoom 0 on a 512 px world. */
const CELL_AT_ZOOM_0 = 45;

/**
 * Rank cameras by how crowded their surroundings are. Rank `z` means "the
 * first camera in its 64 px cell at zoom `z`". Order decides who wins a
 * cell, so pass cameras in a stable order (the plugins sort by id).
 */
export function rankByDensity(cameras: readonly Pick<Camera, "lon" | "lat">[]): Uint8Array {
  const rank = new Uint8Array(cameras.length).fill(255);
  let unranked = cameras.length;
  for (let zoom = 0; zoom < MAX_RANK && unranked > 0; zoom++) {
    const size = CELL_AT_ZOOM_0 / 2 ** zoom;
    const columns = Math.ceil(360 / size);
    const cell = (c: Pick<Camera, "lon" | "lat">) =>
      Math.floor((c.lat + 90) / size) * columns + Math.floor((c.lon + 180) / size);
    const taken = new Set<number>();
    for (let i = 0; i < cameras.length; i++) if (rank[i] !== 255) taken.add(cell(cameras[i]));
    for (let i = 0; i < cameras.length; i++) {
      if (rank[i] !== 255) continue;
      const key = cell(cameras[i]);
      if (taken.has(key)) continue;
      taken.add(key);
      rank[i] = zoom;
      unranked--;
    }
  }
  for (let i = 0; i < rank.length; i++) if (rank[i] === 255) rank[i] = MAX_RANK;
  return rank;
}

/** True when a point lies inside the view's bounds grown by `pad` (a fraction of their size). */
export function inView(
  lon: number,
  lat: number,
  bounds: CameraView["bounds"],
  pad = 0.25,
): boolean {
  const [west, south, east, north] = bounds;
  const padLat = (north - south) * pad;
  if (lat < south - padLat || lat > north + padLat) return false;
  // West greater than east means the view straddles the antimeridian.
  const span = west <= east ? east - west : east - west + 360;
  if (span >= 360) return true;
  const padLon = span * pad;
  const from = west - padLon;
  const offset = (((lon - from) % 360) + 360) % 360;
  return offset <= span + 2 * padLon;
}

export interface SelectOptions {
  /** Viewport, when the caller knows one. */
  view?: CameraView;
  /** Most cameras to return. The most crowded are dropped first. */
  cap: number;
}

/**
 * Sort cameras by id, rank them, and keep what the view can show: inside the
 * padded bounds and ranked no deeper than one zoom past the view's. Without
 * a view everything is kept, up to the cap.
 */
export function selectCameras(
  cameras: readonly Camera[],
  options: SelectOptions,
): { cameras: Camera[]; rank: Uint8Array } {
  const ordered = [...cameras].sort((a, b) => a.id - b.id);
  const rank = rankByDensity(ordered);
  let keep = ordered.map((_, i) => i);
  const { view } = options;
  if (view) {
    const deepest = Math.floor(view.zoom) + 1;
    keep = keep.filter(
      (i) => rank[i] <= deepest && inView(ordered[i].lon, ordered[i].lat, view.bounds),
    );
  }
  if (keep.length > options.cap) {
    keep = [...keep]
      .sort((a, b) => rank[a] - rank[b] || a - b)
      .slice(0, options.cap)
      .sort((a, b) => a - b);
  }
  return { cameras: keep.map((i) => ordered[i]), rank: Uint8Array.from(keep, (i) => rank[i]) };
}

/** Build the entity batch for a set of cameras from one source. */
export function camerasToUpdate(
  source: string,
  cameras: readonly Camera[],
  rank: Uint8Array,
  nowMs: number,
): EntityUpdate {
  const count = cameras.length;
  const columns = createColumns(count);
  const meta: EntityMeta[] = [];
  for (let i = 0; i < count; i++) {
    const camera = cameras[i];
    columns.ids[i] = camera.id;
    columns.lon[i] = camera.lon;
    columns.lat[i] = camera.lat;
    columns.fixTimeMs[i] = camera.fixTimeMs > 0 ? camera.fixTimeMs : nowMs;
    columns.flags[i] = EntityFlag.Stationary;
    // Lowest zoom at which this camera should be drawn; see `rankByDensity`.
    columns.value[i] = rank[i];
    meta.push(camera.meta);
  }
  return { kind: EntityKind.Webcam, source, timeMs: nowMs, full: true, count, columns, meta };
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Plain text from a provider's HTML fragment: tags dropped, entities decoded
 * (numeric ones too, for place names such as "C&#x259;X&#x323;&#x2B7;"),
 * whitespace collapsed. The result is shown as text, never as markup.
 */
export function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
      if (name[0] !== "#") return NAMED_ENTITIES[name.toLowerCase()] ?? match;
      const code =
        name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** Cap for the keyless list feeds with no viewport: each fits whole, so it only guards against a runaway feed. */
export const LIST_FEED_CAP = 1500;

/** Most cameras one source contributes to a single view. */
export const VIEW_CAP = 400;
