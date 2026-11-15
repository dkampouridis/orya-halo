/**
 * Where the sun is. Low-precision solar ephemeris (the Astronomical Almanac's
 * approximate formulas, good to about 0.01 degrees between 1950 and 2050),
 * which is far finer than a terminator drawn on a screen needs.
 */

const DEG = Math.PI / 180;
const J2000_UNIX_MS = 946_728_000_000; // 2000-01-01T12:00:00Z

export interface SubsolarPoint {
  /** Degrees east, -180..180: the longitude where the sun is overhead. */
  lon: number;
  /** Degrees north: the sun's declination. */
  lat: number;
}

function wrap180(deg: number): number {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

/** The point on Earth directly under the sun at `timeMs` (Unix epoch milliseconds). */
export function subsolarPoint(timeMs: number): SubsolarPoint {
  // Days since J2000.0.
  const n = (timeMs - J2000_UNIX_MS) / 86_400_000;
  const meanLongitude = 280.46 + 0.9856474 * n;
  const meanAnomaly = (357.528 + 0.9856003 * n) * DEG;
  const eclipticLongitude =
    (meanLongitude + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) * DEG;
  const obliquity = (23.439 - 0.0000004 * n) * DEG;

  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));
  const rightAscension = Math.atan2(
    Math.cos(obliquity) * Math.sin(eclipticLongitude),
    Math.cos(eclipticLongitude),
  );

  // Greenwich mean sidereal time in degrees: how far the Earth has turned under the stars.
  const gmst = 280.46061837 + 360.98564736629 * n;
  return { lon: wrap180(rightAscension / DEG - gmst), lat: declination / DEG };
}

/**
 * Unit vector from the Earth's centre towards the sun, in MapLibre's globe
 * frame (x = sin(lon)cos(lat), y = sin(lat), z = cos(lon)cos(lat)).
 */
export function sunDirection(
  timeMs: number,
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  const { lon, lat } = subsolarPoint(timeMs);
  const cosLat = Math.cos(lat * DEG);
  out[0] = Math.sin(lon * DEG) * cosLat;
  out[1] = Math.sin(lat * DEG);
  out[2] = Math.cos(lon * DEG) * cosLat;
  return out;
}

/** Sine of the sun's elevation at a place: positive by day, negative at night, 0 on the terminator. */
export function sunElevationSine(timeMs: number, lon: number, lat: number): number {
  const sun = subsolarPoint(timeMs);
  const dLon = (lon - sun.lon) * DEG;
  return (
    Math.sin(lat * DEG) * Math.sin(sun.lat * DEG) +
    Math.cos(lat * DEG) * Math.cos(sun.lat * DEG) * Math.cos(dLon)
  );
}

/**
 * How much of the night treatment applies at a given sun elevation sine:
 * 0 in daylight, 1 in full night, easing through twilight. The night shader
 * uses the same curve (`NIGHT_START`, `NIGHT_FULL`).
 */
export const NIGHT_START = 0.06;
export const NIGHT_FULL = -0.22;

export function nightFactor(elevationSine: number): number {
  const t = Math.min(Math.max((elevationSine - NIGHT_START) / (NIGHT_FULL - NIGHT_START), 0), 1);
  return t * t * (3 - 2 * t);
}
