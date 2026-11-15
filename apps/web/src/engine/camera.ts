/** Camera arithmetic. Pure, so it can be tested without a map. */
import { EntityKind } from "@orya-halo/schema";
import { angularDistance, clamp, wrapLon } from "./maths.ts";

const DEG = Math.PI / 180;

/** MapLibre's default vertical field of view, degrees. */
export const DEFAULT_FOV = 36.87;
/** Above this zoom MapLibre's globe has eased fully into Mercator. */
export const GLOBE_MAX_ZOOM = 12;

export const FLY_MIN_MS = 1200;
export const FLY_MAX_MS = 2400;
/** Reduced motion: a camera move is a short cross-fade instead of a flight. */
export const FADE_MS = 200;

interface Place {
  lon: number;
  lat: number;
  zoom: number;
}

/**
 * How long a flight between two views should take: 1.2 s for a nudge, 2.4 s
 * for the far side of the planet or a dive from orbit to street level.
 */
export function flyDurationMs(from: Place, to: Place): number {
  const travel = angularDistance(from.lon, from.lat, to.lon, to.lat) / Math.PI;
  const dive = Math.abs(to.zoom - from.zoom) / 10;
  const effort = clamp(travel * 1.6 + dive * 0.7, 0, 1);
  return Math.round(FLY_MIN_MS + (FLY_MAX_MS - FLY_MIN_MS) * effort);
}

/** Radius of the globe on screen in CSS pixels, as MapLibre draws it. */
export function globeRadiusPx(zoom: number, lat: number): number {
  // MapLibre keeps the map scale at the centre latitude equal to Mercator's,
  // so the sphere grows by 1 / cos(latitude) as the view moves polewards.
  const cosLat = Math.max(Math.cos(clamp(lat, -85.051129, 85.051129) * DEG), 1e-6);
  return (256 * 2 ** zoom) / (Math.PI * cosLat);
}

/** Insets in CSS pixels, as `HaloEngine.setPadding` takes them. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface FitQuery {
  zoom: number;
  lat: number;
  pitch: number;
  width: number;
  height: number;
  fov?: number;
  /**
   * Camera padding. MapLibre moves the point the camera looks at to the
   * middle of the unpadded area, which slides the whole picture of the planet
   * across the canvas without resizing it.
   */
  padding?: Insets;
}

/**
 * True when the whole disc of the planet is inside the canvas.
 *
 * It is the canvas that counts, not the area left clear by the padding: the
 * HUD's glass is translucent, so a limb under a panel is still drawn and
 * still needs its data. Padding matters because it moves the disc: a globe
 * that would fit when centred can run off the edge once it is pushed aside
 * to make room for a panel.
 */
export function globeFitsView({
  zoom,
  lat,
  pitch,
  width,
  height,
  fov = DEFAULT_FOV,
  padding,
}: FitQuery): boolean {
  if (zoom > GLOBE_MAX_ZOOM || width <= 0 || height <= 0) return false;
  const radius = globeRadiusPx(zoom, lat);
  // Distance from the camera to the point it looks at, in pixels.
  const focal = (0.5 * height) / Math.tan((fov * DEG) / 2);
  const p = pitch * DEG;
  const toCentre = Math.sqrt(focal * focal + radius * radius + 2 * focal * radius * Math.cos(p));
  // Half-angle of the limb, and how far the centre sits below the view axis.
  const limb = Math.asin(Math.min(radius / toCentre, 1));
  const drop = Math.asin(Math.min((radius * Math.sin(p)) / toCentre, 1));
  if (limb + drop >= Math.PI / 2 - 1e-6) return false;
  // Where the view axis meets the canvas.
  const cx = width / 2 + ((padding?.left ?? 0) - (padding?.right ?? 0)) / 2;
  const cy = height / 2 + ((padding?.top ?? 0) - (padding?.bottom ?? 0)) / 2;
  return (
    focal * Math.tan(limb + drop) <= height - cy &&
    focal * Math.tan(limb - drop) <= cy &&
    focal * Math.tan(limb) <= Math.min(cx, width - cx)
  );
}

/** Mean Earth radius, metres. */
const EARTH_RADIUS_M = 6_371_008.8;
/** The furthest the camera target is moved to keep a high object in frame, metres. */
const FOLLOW_MAX_SHIFT_M = 2_500_000;

/**
 * Where the camera should look so that an object drawn `alt` metres above
 * `lon`, `lat` appears at the centre of the clear area.
 *
 * Looking straight down, that is the point beneath it. With the camera
 * pitched, something above the ground appears further up the screen than the
 * ground under it, by its height times the tangent of the pitch; so the
 * camera looks at the ground that far beyond the object, in the direction the
 * camera faces. (Flat-ground geometry: exact for aircraft, close enough for
 * low orbits, and capped so a geostationary satellite does not send the
 * camera to the other side of the planet.)
 */
export function followCentre(
  lon: number,
  lat: number,
  alt: number,
  pitch: number,
  bearing: number,
  out: [number, number] = [0, 0],
): [number, number] {
  const shift = Math.min(
    Math.max(alt, 0) * Math.tan(clamp(pitch, 0, 85) * DEG),
    FOLLOW_MAX_SHIFT_M,
  );
  if (shift < 1) {
    out[0] = lon;
    out[1] = lat;
    return out;
  }
  // Destination along a great circle from the object, heading `bearing`.
  const d = shift / EARTH_RADIUS_M;
  const b = bearing * DEG;
  const phi = lat * DEG;
  const sinPhi2 = Math.sin(phi) * Math.cos(d) + Math.cos(phi) * Math.sin(d) * Math.cos(b);
  const phi2 = Math.asin(clamp(sinPhi2, -1, 1));
  const dLon = Math.atan2(
    Math.sin(b) * Math.sin(d) * Math.cos(phi),
    Math.cos(d) - Math.sin(phi) * sinPhi2,
  );
  out[0] = wrapLon(lon + dLon / DEG);
  out[1] = clamp(phi2 / DEG, -85, 85);
  return out;
}

/**
 * Eases `current` towards `target` so that the gap halves every
 * `halfLifeMs`, whatever the frame rate, and lands on the target once it is
 * within `epsilon` of it rather than creeping towards it for ever.
 */
export function approach(
  current: number,
  target: number,
  dtMs: number,
  halfLifeMs: number,
  epsilon = 1e-3,
): number {
  if (halfLifeMs <= 0) return target;
  // No time passed, or a clock that ran backwards: stay put. A negative step
  // would move away from the target and overshoot past where it started.
  if (!(dtMs > 0)) return current;
  const next = target + (current - target) * 0.5 ** (dtMs / halfLifeMs);
  return Math.abs(next - target) < epsilon ? target : next;
}

/**
 * Bounds as `[west, south, east, north]` with longitudes in -180..180; west
 * exceeds east when the view straddles the antimeridian. A view that wraps
 * the whole way round reports the full range.
 */
export function normaliseBounds(
  west: number,
  south: number,
  east: number,
  north: number,
): [number, number, number, number] {
  const s = clamp(south, -90, 90);
  const n = clamp(north, -90, 90);
  if (!(east - west < 360)) return [-180, s, 180, n];
  return [wrapLon(west), s, wrapLon(east), n];
}

/** Zoom that frames one object of a kind after flying to it. */
export function framingZoom(kind: EntityKind): number {
  switch (kind) {
    case EntityKind.Aircraft:
      return 7.5;
    case EntityKind.Ship:
      return 9;
    case EntityKind.Satellite:
      return 3;
    case EntityKind.Quake:
      return 6;
    case EntityKind.Webcam:
      return 11;
    case EntityKind.Fire:
      return 9;
    default:
      return 4.5;
  }
}

/** Degrees of longitude per second for the idle orbit: unhurried from orbit, slower when close. */
export function orbitRate(zoom: number): number {
  return 1.8 * Math.min(1, 2 ** (2.5 - zoom));
}
