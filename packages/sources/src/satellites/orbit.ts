/**
 * Orbit facts and categories derived from an element set: period, apogee,
 * perigee, orbit class, and the `SatelliteCategory` used to style the glyph.
 */
import { SatelliteCategory } from "@orya-halo/schema";

/** WGS 84 equatorial radius, km. Altitudes are quoted above this. */
export const EARTH_EQUATORIAL_RADIUS_KM = 6378.137;
/** Earth's gravitational parameter, km^3/s^2. */
const MU_KM3_S2 = 398_600.4418;
/** One sidereal day in minutes: the period of a geosynchronous orbit. */
export const SIDEREAL_DAY_MIN = 1436.068;
/** Altitude of the geostationary belt, km. */
const GEO_ALTITUDE_KM = 35_786;

export type OrbitClass = "leo" | "sso" | "meo" | "geo" | "gso" | "gto" | "molniya" | "heo" | "high";

/** Sentence-case name of each orbit class, shown as the detail subtitle. */
export const ORBIT_LABEL: Record<OrbitClass, string> = {
  leo: "Low Earth orbit",
  sso: "Sun-synchronous orbit",
  meo: "Medium Earth orbit",
  geo: "Geostationary orbit",
  gso: "Geosynchronous orbit",
  gto: "Geostationary transfer orbit",
  molniya: "Molniya orbit",
  heo: "Highly elliptical orbit",
  high: "High Earth orbit",
};

export interface OrbitFacts {
  periodMin: number;
  /** Altitude of the highest point above the equatorial radius, km. */
  apogeeKm: number;
  /** Altitude of the lowest point above the equatorial radius, km. */
  perigeeKm: number;
  orbit: OrbitClass;
}

/**
 * Period, apogee, perigee and orbit class from mean motion (revolutions per
 * day), eccentricity and inclination (degrees).
 */
export function orbitFacts(
  meanMotionRevPerDay: number,
  eccentricity: number,
  inclinationDeg: number,
): OrbitFacts {
  const periodMin = 1440 / meanMotionRevPerDay;
  const n = (meanMotionRevPerDay * 2 * Math.PI) / 86_400;
  const semiMajorKm = Math.cbrt(MU_KM3_S2 / (n * n));
  const apogeeKm = semiMajorKm * (1 + eccentricity) - EARTH_EQUATORIAL_RADIUS_KM;
  const perigeeKm = semiMajorKm * (1 - eccentricity) - EARTH_EQUATORIAL_RADIUS_KM;
  return {
    periodMin,
    apogeeKm,
    perigeeKm,
    orbit: orbitClass(periodMin, eccentricity, inclinationDeg, apogeeKm, perigeeKm),
  };
}

function orbitClass(
  periodMin: number,
  e: number,
  inclinationDeg: number,
  apogeeKm: number,
  perigeeKm: number,
): OrbitClass {
  const synchronous = Math.abs(periodMin - SIDEREAL_DAY_MIN) < 30;
  if (synchronous && e < 0.05) return inclinationDeg < 5 ? "geo" : "gso";
  if (e >= 0.25) {
    // Half a sidereal day at the critical inclination: apogee dwells over the far north.
    if (Math.abs(periodMin - SIDEREAL_DAY_MIN / 2) < 20 && Math.abs(inclinationDeg - 63.4) < 3)
      return "molniya";
    if (perigeeKm < 2000 && Math.abs(apogeeKm - GEO_ALTITUDE_KM) < 3000) return "gto";
    return "heo";
  }
  if (synchronous) return "gso";
  if (apogeeKm < 2000) {
    // The retrograde inclination that makes the orbit plane keep pace with the Sun.
    const sunSync =
      inclinationDeg >= 95.5 && inclinationDeg <= 103 && perigeeKm > 250 && apogeeKm < 1300;
    return sunSync ? "sso" : "leo";
  }
  if (apogeeKm < GEO_ALTITUDE_KM - 200) return "meo";
  return "high";
}

/** Launch year from an international designator such as "1998-067A", or null. */
export function launchYear(designator: string): number | null {
  const match = /^(\d{4})-\d{3}/.exec(designator);
  if (!match) return null;
  const year = Number(match[1]);
  return year >= 1957 && year <= 2200 ? year : null;
}

// Name patterns, checked in this order. Names are CelesTrak's OBJECT_NAME, upper case.
// The lists favour the families that make up most of the active catalogue; anything
// unmatched falls through to the orbit (geostationary) or to "other".

/** Fragments and spent stages. Not expected in the active group, kept for other groups. */
const DEBRIS = /\bDEB\b|\bR\/B\b|\bAKM\b|\bPKM\b|\bDEBRIS\b|\bFRAGMENT\b|\bCOOLANT\b/;

/** Space stations, their modules, and crew or cargo vehicles that fly to them. */
const STATION =
  /^ISS\b|^CSS\b|\bZARYA\b|\bTIANHE\b|\bWENTIAN\b|\bMENGTIAN\b|\bTIANGONG\b|^NAUKA\b|^POISK\b|^SOYUZ[- ]MS\b|^PROGRESS[- ]MS\b|^CREW DRAGON\b|^DRAGON\b|^CARGO DRAGON\b|^CYGNUS\b|^TIANZHOU\b|^SHENZHOU\b|^SZ-\d+ MODULE\b|^HTV\b|^STARLINER\b|^DREAM CHASER\b|^HAVEN-\d|^AXIOM\b/;

const NAVIGATION =
  /^GPS\b|^NAVSTAR\b|\bGLONASS\b|^GSAT\d{4}\b|\bGALILEO\b|^BEIDOU\b|^QZS\b|^IRNSS\b|^NVS-\d|^WAAS\b|\bEGNOS\b|^CENTISPACE\b|^PULSAR-\d/;

/** Large communication and data-relay fleets flying as one system. */
const CONSTELLATION =
  /^STARLINK\b|^ONEWEB\b|^KUIPER\b|^QIANFAN\b|^HULIANWANG\b|^GUOWANG\b|^IRIDIUM\b|^GLOBALSTAR\b|^ORBCOMM\b|^O3B\b|^GEESAT\b|^TIANQI\b|^KINEIS\b|^GONETS\b|^SPACEMOBILE\b|^BLUEBIRD\b|^BLUEWALKER\b|^SPACEBEE\b|^ASTROCAST\b|^SATELIOT\b|^CONNECTA\b|^LIGHTSPEED\b|^E-SPACE\b|^YINHE\b|^RASSVET\b|^SDA\b|^SDA-|^PRAETORIAN SDA\b|^TRANCHE\b|^APRIZESAT\b|^LYNK\b|^SKYKRAFT\b|^FOSSASAT\b|^HUBBLE-\d/;

/** Imaging, radar, weather, ocean, atmosphere and radio-frequency mapping. */
const EARTH_OBSERVATION =
  /^FLOCK\b|^SKYSAT\b|^DOVE\b|^PELICAN\b|^TANAGER\b|^LEMUR\b|^ICEYE\b|^CAPELLA\b|^UMBRA\b|^STRIX\b|^QPS-SAR\b|^GAOFEN\b|^YAOGAN\b|^JILIN\b|^ZIYUAN\b|^SUPERVIEW\b|^WORLDVIEW\b|^LEGION\b|^GEOEYE\b|^PLEIADES\b|^SPOT\b|^TERRA$|^AQUA$|^AURA$|^SUOMI NPP\b|^NOAA\b|^JPSS\b|^METOP\b|^METEOR-M\b|^FENGYUN\b|^HIMAWARI\b|^METEOSAT\b|^MSG\b|^MTG\b|^GOES\b|^INSAT-3D|^ELEKTRO\b|^ARKTIKA\b|^GEO-KOMPSAT\b|^KOMPSAT\b|^CARTOSAT\b|^RESOURCESAT\b|^RISAT\b|^OCEANSAT\b|^EOS-\d|^SAOCOM\b|^COSMO-SKYMED\b|^CSG\b|^TERRASAR\b|^TANDEM-X\b|^PAZ$|^RADARSAT\b|^RCM-\d|^ALOS\b|^GCOM\b|^GOSAT\b|^LANDSAT\b|^SENTINEL\b|^CBERS\b|^DMSP\b|^ICESAT\b|^SMAP$|^CYGFM\d|^HAWK\b|^GLOBAL-\d|^BLACKSKY\b|^NUSAT\b|^KANOPUS\b|^RESURS\b|^KONDOR\b|^HAIYANG\b|^HY-\d|^TIANHUI\b|^YUNHAI\b|^TIANMU\b|^YUNYAO\b|^PIESAT\b|^HJ-\d|^THEOS\b|^FORMOSAT\b|^EARTHCARE\b|^SWOT$|^PACE$|^NISAR$|^JASON\b|^CRYOSAT\b|^SMOS$|^PROBA-V\b|^OCO[- ]\d|^GHGSAT\b|^GRUS\b|^WILDFIRE\b|^TOMORROW\b|^NEONSAT\b|^IRIDE\b|^SITRO\b|^AETHER\b|^BRO-\d|^DS-EO\b|^VRSS\b|^KHALIFASAT\b|^DUBAISAT\b|^SSTL\b|^DMC\b|^VNREDSAT\b|^LOTUSAT\b|^GOKTURK\b|^IMECE\b|^RASAT\b|^EROS\b|^OFEK\b|^TECSAR\b|^ASNARO\b|^IGS\b|^NOVASAR\b|^CARBONSAT\b|^MICROCARB\b|^TROPICS\b|^TEMPO$|^GEMS$|^ZHUHAI\b|^NINGXIA\b|^FOREST\b/;

/** Astronomy, heliophysics, geodesy and space-physics missions. */
const SCIENCE =
  /^HST$|^CXO\b|^CHANDRA\b|^XMM\b|^INTEGRAL$|^SWIFT$|^FGRST\b|^FERMI\b|^NUSTAR$|^IXPE$|^TESS$|^CHEOPS$|^ASTROSAT\b|^HXMT\b|^EINSTEIN PROBE\b|^SVOM\b|^IRIS$|^HINODE\b|^SDO$|^CLUSTER\b|^THEMIS\b|^MMS \d|^SWARM [ABC]$|^GRACE-FO\b|^LAGEOS\b|^LARES\b|^STARLETTE$|^STELLA$|^AJISAI\b|\bETALON\b|^CSES\b|^DAMPE\b|^XPOSAT\b|^SPHEREX\b|^PUNCH\b|^TRACERS\b|^GEOTAIL\b|^IBEX$|^XRISM\b|^NICER\b|^GAIA$|^ASTRO-|^HERMES\b|^PROBA-[23]\b|^TIANGUAN\b|^XUNTIAN\b|^SMILE$|^ASO-S\b|^KUAFU\b/;

/**
 * Category of an object from its name, falling back to its orbit. Specific
 * roles win over the orbit: a geostationary weather satellite is earth
 * observation, a geostationary navigation satellite is navigation.
 */
export function classifySatellite(name: string, orbit: OrbitClass): number {
  // Underscores count as word characters and would hide the boundary in "SDA_602".
  const upper = name.toUpperCase().replace(/_/g, " ");
  if (DEBRIS.test(upper)) return SatelliteCategory.Debris;
  if (STATION.test(upper)) return SatelliteCategory.Station;
  if (NAVIGATION.test(upper)) return SatelliteCategory.Navigation;
  if (CONSTELLATION.test(upper)) return SatelliteCategory.Constellation;
  if (EARTH_OBSERVATION.test(upper)) return SatelliteCategory.EarthObservation;
  if (SCIENCE.test(upper)) return SatelliteCategory.Science;
  if (orbit === "geo" || orbit === "gso") return SatelliteCategory.Geostationary;
  return SatelliteCategory.Other;
}
