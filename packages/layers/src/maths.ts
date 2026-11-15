/**
 * CPU mirrors of the small formulas the shaders use, so the engine (reticle,
 * picking, `project`) and the tests agree with the pixels.
 */

/** deck.gl's globe radius in common units. */
export const GLOBE_RADIUS = 256;
/** Earth radius deck.gl uses to place altitudes on the globe, metres. */
export const DECK_EARTH_RADIUS_M = 6_370_972;

const LIMB_INNER = 0.999;
const LIMB_OUTER = 0.99995;
const DEG = Math.PI / 180;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

/** deck.gl globe common-space position of a coordinate. Mirrors `project_globe_`. */
export function globeCommon(
  lon: number,
  lat: number,
  alt = 0,
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  const lambda = lon * DEG;
  const phi = lat * DEG;
  const cosPhi = Math.cos(phi);
  const d = (alt / DECK_EARTH_RADIUS_M + 1) * GLOBE_RADIUS;
  out[0] = Math.sin(lambda) * cosPhi * d;
  out[1] = -Math.cos(lambda) * cosPhi * d;
  out[2] = Math.sin(phi) * d;
  return out;
}

/**
 * 1 when `point` is visible from `camera` (both in globe common space), 0 when
 * the planet hides it, in between just past the limb. Mirrors
 * `halo_visibility` in the shaders.
 */
export function haloVisibility(
  camera: ArrayLike<number>,
  point: ArrayLike<number>,
  radius = GLOBE_RADIUS,
): number {
  const rx = point[0] - camera[0];
  const ry = point[1] - camera[1];
  const rz = point[2] - camera[2];
  const rr = Math.max(rx * rx + ry * ry + rz * rz, 1e-12);
  const t = Math.min(Math.max(-(camera[0] * rx + camera[1] * ry + camera[2] * rz) / rr, 0), 1);
  const nearest = Math.hypot(camera[0] + rx * t, camera[1] + ry * t, camera[2] + rz * t);
  return smoothstep(radius * LIMB_INNER, radius * LIMB_OUTER, nearest);
}

/**
 * A pixel size ramped between two zoom levels, clamped at both ends. `ease`
 * above 1 keeps sizes near the low end for longer, so a crowded globe stays a
 * field of points and glyphs only open up once there is room for them.
 */
export function sizeAtZoom(
  zoom: number,
  range: readonly [number, number],
  sizes: readonly [number, number],
  ease = 1,
): number {
  const t = Math.min(Math.max((zoom - range[0]) / (range[1] - range[0]), 0), 1);
  return sizes[0] + (sizes[1] - sizes[0]) * t ** ease;
}

/**
 * How far a layer of glyphs has turned into points of light at `zoom`: 1 at
 * and below the first zoom of `range`, 0 at and above the second, eased in
 * between so neither end of the change shows as a step. Null: never.
 */
export function farness(zoom: number, range: readonly [number, number] | null): number {
  if (!range) return 0;
  return 1 - smoothstep(range[0], range[1], zoom);
}

/**
 * Longitude step, in degrees at the equator, that projects to a few pixels at
 * `zoom`. The shaders offset each object by this much along its heading to
 * find which way "forward" points on screen under any projection.
 */
export function headingProbeDegrees(zoom: number): number {
  return (360 / 512) * 6 * 2 ** -zoom;
}

/** Screen radius of an earthquake ring in pixels before zoom scaling. Mirrors the markers shader. */
export function quakeRadiusPx(magnitude: number): number {
  return Math.min(Math.max(5 + (magnitude - 2.5) * 4.2, 4), 30);
}
