/**
 * Turns CelesTrak's OMM CSV into a catalogue ready to propagate: one
 * initialised SGP4 record per object plus the static facts that never change
 * between recomputes. Built once per download.
 *
 * The catalogue is plain data (arrays, typed arrays, records of numbers and
 * strings), so it survives `structuredClone` and can be kept in IndexedDB.
 */
import type { EntityMeta } from "@orya-halo/schema";
import { json2satrec } from "satellite.js";
import type { OMMJsonObject, SatRec } from "satellite.js";
import { columnIndexes, parseCsv } from "../shared/space-earth/csv.ts";
import { SourceError } from "../shared/space-earth/errors.ts";
import { ORBIT_LABEL, classifySatellite, launchYear, orbitFacts } from "./orbit.ts";
import { epochMsOf } from "./propagate.ts";

export interface SatelliteCatalogue {
  count: number;
  /** NORAD catalogue numbers. */
  ids: Uint32Array;
  /** Unix time of each element set's epoch, milliseconds. */
  epochMs: Float64Array;
  /** Orbital period, minutes. */
  periodMin: Float32Array;
  eccentricity: Float32Array;
  /** `SatelliteCategory` codes. */
  category: Uint8Array;
  satrecs: SatRec[];
  /** Static facts per object, shared by every update built from this catalogue. */
  meta: EntityMeta[];
  /** Rows of the file that were not usable (bad numbers, duplicates, failed SGP4 init). */
  skipped: number;
}

const REQUIRED = [
  "OBJECT_NAME",
  "OBJECT_ID",
  "EPOCH",
  "MEAN_MOTION",
  "ECCENTRICITY",
  "INCLINATION",
  "RA_OF_ASC_NODE",
  "ARG_OF_PERICENTER",
  "MEAN_ANOMALY",
  "NORAD_CAT_ID",
  "BSTAR",
  "MEAN_MOTION_DOT",
  "MEAN_MOTION_DDOT",
] as const;

const OPTIONAL = ["EPHEMERIS_TYPE", "ELEMENT_SET_NO"] as const;

const round = (value: number, digits: number) => {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
};

/**
 * Parse OMM CSV (CelesTrak `FORMAT=CSV`) into a catalogue. Rows that cannot
 * be propagated are counted in `skipped` and left out; a file without the OMM
 * header is a `SourceError`.
 */
export function buildCatalogue(csv: string): SatelliteCatalogue {
  const table = parseCsv(csv);
  const col = columnIndexes(table.header, REQUIRED);
  const opt = columnIndexes(table.header, OPTIONAL);
  for (const name of REQUIRED) {
    if (col[name] < 0) {
      throw new SourceError(
        "bad-data",
        "CelesTrak sent something other than orbital elements, so satellites were not updated.",
      );
    }
  }

  const rows = table.rows;
  const ids = new Uint32Array(rows.length);
  const epochMs = new Float64Array(rows.length);
  const periodMin = new Float32Array(rows.length);
  const eccentricity = new Float32Array(rows.length);
  const category = new Uint8Array(rows.length);
  const satrecs: SatRec[] = [];
  const meta: EntityMeta[] = [];
  const seen = new Set<number>();
  let n = 0;

  for (const cells of rows) {
    const id = Number(cells[col.NORAD_CAT_ID]);
    const meanMotion = Number(cells[col.MEAN_MOTION]);
    const ecc = Number(cells[col.ECCENTRICITY]);
    const inclination = Number(cells[col.INCLINATION]);
    const epoch = cells[col.EPOCH];
    if (
      !Number.isInteger(id) ||
      id <= 0 ||
      id > 0xffffffff ||
      seen.has(id) ||
      !(meanMotion > 0) ||
      !(ecc >= 0 && ecc < 1) ||
      !Number.isFinite(inclination) ||
      !epoch ||
      Number.isNaN(Date.parse(epoch.endsWith("Z") ? epoch : `${epoch}Z`)) ||
      // Only SGP4 element sets (type 0) can be propagated with SGP4.
      (opt.EPHEMERIS_TYPE >= 0 && Number(cells[opt.EPHEMERIS_TYPE]) !== 0)
    ) {
      continue;
    }

    const name = cells[col.OBJECT_NAME].trim();
    const designator = cells[col.OBJECT_ID].trim();
    const omm: OMMJsonObject = {
      OBJECT_NAME: name,
      OBJECT_ID: designator,
      EPOCH: epoch,
      MEAN_MOTION: meanMotion,
      ECCENTRICITY: ecc,
      INCLINATION: inclination,
      RA_OF_ASC_NODE: cells[col.RA_OF_ASC_NODE],
      ARG_OF_PERICENTER: cells[col.ARG_OF_PERICENTER],
      MEAN_ANOMALY: cells[col.MEAN_ANOMALY],
      NORAD_CAT_ID: id,
      ELEMENT_SET_NO: opt.ELEMENT_SET_NO >= 0 ? cells[opt.ELEMENT_SET_NO] : 999,
      BSTAR: cells[col.BSTAR],
      MEAN_MOTION_DOT: cells[col.MEAN_MOTION_DOT],
      MEAN_MOTION_DDOT: cells[col.MEAN_MOTION_DDOT],
    };

    let satrec: SatRec;
    try {
      satrec = json2satrec(omm);
    } catch {
      continue;
    }
    const epochTime = epochMsOf(satrec);
    if (satrec.error !== 0 || !Number.isFinite(epochTime) || !Number.isFinite(satrec.no)) continue;

    const facts = orbitFacts(meanMotion, ecc, inclination);
    seen.add(id);
    ids[n] = id;
    epochMs[n] = epochTime;
    periodMin[n] = facts.periodMin;
    eccentricity[n] = ecc;
    category[n] = classifySatellite(name, facts.orbit);
    satrecs.push(satrec);
    meta.push({
      label: name || `Object ${id}`,
      noradId: id,
      intlDes: designator || null,
      orbit: ORBIT_LABEL[facts.orbit],
      launchYear: launchYear(designator),
      inclinationDeg: round(inclination, 2),
      periodMin: round(facts.periodMin, 1),
      apogeeKm: Math.round(facts.apogeeKm),
      perigeeKm: Math.round(facts.perigeeKm),
      eccentricity: round(ecc, 5),
      epochMs: Math.round(epochTime),
    });
    n++;
  }

  return {
    count: n,
    ids: ids.slice(0, n),
    epochMs: epochMs.slice(0, n),
    periodMin: periodMin.slice(0, n),
    eccentricity: eccentricity.slice(0, n),
    category: category.slice(0, n),
    satrecs,
    meta,
    skipped: rows.length - n,
  };
}
