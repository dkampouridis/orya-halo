/**
 * SGP4 propagation to a geodetic fix with ground-track motion.
 *
 * One SGP4 call yields position and velocity. Heading, ground speed and
 * vertical rate come from that velocity analytically (rotate into the
 * Earth-fixed frame, remove the Earth's own rotation, project on the local
 * east, north and up axes), which is exact at the fix time and costs nothing
 * extra; a second propagation a moment later would give the same numbers by
 * finite difference at twice the price. The tests check the two agree.
 */
import { EARTH_RADIUS_M } from "@orya-halo/schema";
import { gstime, sgp4 } from "satellite.js";
import type { SatRec } from "satellite.js";

const RAD2DEG = 180 / Math.PI;
/** WGS 84 ellipsoid. */
const A_KM = 6378.137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
/** Earth's rotation rate, rad/s. */
const EARTH_ROTATION = 7.292115e-5;
/** Julian date of the Unix epoch. */
const JD_UNIX_EPOCH = 2_440_587.5;
const MS_PER_DAY = 86_400_000;
/** Below this altitude an object has re-entered, whatever its elements say. */
const MIN_ALTITUDE_KM = 80;
/** No element set describes anything this far out; beyond it SGP4 has diverged. */
const MAX_ALTITUDE_KM = 2_000_000;

/** One propagated fix, in the units of `EntityColumns`. Reused as scratch space. */
export interface SatFix {
  /** Degrees east, -180..180. */
  lon: number;
  /** Geodetic latitude, degrees north. */
  lat: number;
  /** Metres above the WGS 84 ellipsoid. */
  alt: number;
  /** Course of the ground track, degrees clockwise from north, 0..360. */
  heading: number;
  /**
   * Speed of the ground track in metres per second, in the convention of
   * `extrapolate()`: the rate at which the sub-satellite point crosses a
   * sphere of `EARTH_RADIUS_M`, relative to the rotating Earth.
   */
  speed: number;
  /** Rate of change of altitude, metres per second. */
  vrate: number;
}

export function createFix(): SatFix {
  return { lon: 0, lat: 0, alt: 0, heading: 0, speed: 0, vrate: 0 };
}

/** Unix time of a satrec's element epoch, milliseconds. */
export function epochMsOf(satrec: SatRec): number {
  return (satrec.jdsatepoch - JD_UNIX_EPOCH) * MS_PER_DAY;
}

/** Greenwich mean sidereal time at a Unix time, radians. */
export function gmstAt(timeMs: number): number {
  return gstime(timeMs / MS_PER_DAY + JD_UNIX_EPOCH);
}

/**
 * Propagate `satrec` to `tsinceMin` minutes after its epoch and write the fix
 * into `out`. `cosGmst` and `sinGmst` are of the sidereal time at that moment.
 *
 * Returns false, leaving `out` untouched, when SGP4 reports an error, the
 * object has decayed, or the result is not a usable position.
 */
export function propagateFix(
  satrec: SatRec,
  tsinceMin: number,
  cosGmst: number,
  sinGmst: number,
  out: SatFix,
): boolean {
  let pv: ReturnType<typeof sgp4>;
  try {
    pv = sgp4(satrec, tsinceMin);
  } catch {
    return false;
  }
  // satrec.tempa <= 0 is satellite.js's check for long-decayed objects that
  // SGP4 would otherwise place somewhere meaningless.
  if (pv === null || satrec.tempa <= 0) return false;
  const r = pv.position;
  const v = pv.velocity;

  // TEME to Earth-fixed: rotate about the pole by the sidereal angle.
  const x = r.x * cosGmst + r.y * sinGmst;
  const y = r.y * cosGmst - r.x * sinGmst;
  const z = r.z;
  // Velocity relative to the rotating Earth: rotate, then subtract omega x r.
  const vx = v.x * cosGmst + v.y * sinGmst + EARTH_ROTATION * y;
  const vy = v.y * cosGmst - v.x * sinGmst - EARTH_ROTATION * x;
  const vz = v.z;

  const p = Math.sqrt(x * x + y * y);
  const lon = Math.atan2(y, x);
  // Geodetic latitude by fixed-point iteration; converges in 3 to 5 passes.
  let lat = Math.atan2(z, p);
  let sinLat = Math.sin(lat);
  let n = A_KM / Math.sqrt(1 - E2 * sinLat * sinLat);
  for (let k = 0; k < 8; k++) {
    const next = Math.atan2(z + n * E2 * sinLat, p);
    const delta = next - lat;
    lat = next;
    sinLat = Math.sin(lat);
    n = A_KM / Math.sqrt(1 - E2 * sinLat * sinLat);
    if (delta < 1e-11 && delta > -1e-11) break;
  }
  const cosLat = Math.cos(lat);
  const heightKm = p * cosLat + z * sinLat - (A_KM * A_KM) / n;
  // NaN fails both comparisons' complement, so this also rejects non-finite results.
  if (!(heightKm > MIN_ALTITUDE_KM && heightKm < MAX_ALTITUDE_KM)) return false;

  // Exactly over a pole longitude is arbitrary; any axis pair works there.
  const sinLon = p > 1e-9 ? y / p : 0;
  const cosLon = p > 1e-9 ? x / p : 1;
  const east = vy * cosLon - vx * sinLon;
  const north = vz * cosLat - (vx * cosLon + vy * sinLon) * sinLat;
  const up = (vx * cosLon + vy * sinLon) * cosLat + vz * sinLat;

  // Rates of geodetic latitude and longitude are north / (M + h) and
  // east / ((N + h) cos lat). `extrapolate()` turns speed and heading back into
  // those rates on a sphere of EARTH_RADIUS_M, so scale to that sphere here.
  const w2 = 1 - E2 * sinLat * sinLat;
  const m = (A_KM * (1 - E2)) / (w2 * Math.sqrt(w2));
  const northRate = (north / (m + heightKm)) * EARTH_RADIUS_M;
  const eastRate = (east / (n + heightKm)) * EARTH_RADIUS_M;

  let heading = Math.atan2(eastRate, northRate) * RAD2DEG;
  if (heading < 0) heading += 360;

  out.lon = lon * RAD2DEG;
  out.lat = lat * RAD2DEG;
  out.alt = heightKm * 1000;
  out.heading = heading;
  out.speed = Math.sqrt(northRate * northRate + eastRate * eastRate);
  out.vrate = up * 1000;
  return true;
}
