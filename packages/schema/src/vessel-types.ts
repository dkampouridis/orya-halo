/**
 * Vessel kinds and the 3D models they are drawn with.
 *
 * AIS says little about a ship's shape: a category (cargo, tanker,
 * passenger, …), sometimes a finer type ("Tug", "Pilot vessel"), its name,
 * length and beam. From those `vesselModelFor` picks one of a handful of
 * generic hull forms; the engine builds each in code and scales it to the
 * ship's own length and beam. Where AIS cannot tell two forms apart (a cargo
 * ship may be a container ship, a bulk carrier or a car carrier) the choice
 * falls to the name, where a fleet's naming is unambiguous, and then to the
 * hull's proportions. The proportions rule is a guess, and is documented
 * as one in docs/DESIGN.md.
 *
 * Model id 0 means "not decided yet" (no static data has arrived): the
 * engine then picks by the category alone (`genericVesselModel`).
 */
import { ShipCategory } from "./kinds.ts";

/** The vessel model ids. They travel in a ship's batch value: never renumber. */
export const VesselModel = {
  Unknown: 0,
  Container: 1,
  Tanker: 2,
  Bulk: 3,
  CarCarrier: 4,
  Cruise: 5,
  Ferry: 6,
  GeneralCargo: 7,
  Fishing: 8,
  Tug: 9,
  PilotBoat: 10,
  Patrol: 11,
  SailingYacht: 12,
  MotorYacht: 13,
  Generic: 14,
} as const;
export type VesselModel = (typeof VesselModel)[keyof typeof VesselModel];

export interface VesselModelSpec {
  readonly id: VesselModel;
  readonly name: string;
  /** Typical length and beam, metres: the mesh is built at these and scaled to the ship's own. */
  readonly lengthM: number;
  readonly beamM: number;
  /** Hull side above the waterline amidships, metres. */
  readonly freeboardM: number;
}

/** Every model, by id (index = id - 1). */
export const VESSEL_MODELS: readonly VesselModelSpec[] = [
  { id: 1, name: "Container ship", lengthM: 300, beamM: 48, freeboardM: 11 },
  { id: 2, name: "Tanker", lengthM: 250, beamM: 44, freeboardM: 8 },
  { id: 3, name: "Bulk carrier", lengthM: 225, beamM: 32, freeboardM: 8 },
  { id: 4, name: "Car carrier", lengthM: 200, beamM: 32, freeboardM: 26 },
  { id: 5, name: "Cruise ship", lengthM: 300, beamM: 38, freeboardM: 10 },
  { id: 6, name: "Passenger ferry", lengthM: 180, beamM: 28, freeboardM: 8 },
  { id: 7, name: "General cargo ship", lengthM: 110, beamM: 17, freeboardM: 4.5 },
  { id: 8, name: "Fishing vessel", lengthM: 30, beamM: 8, freeboardM: 2.2 },
  { id: 9, name: "Tug", lengthM: 30, beamM: 11, freeboardM: 2.2 },
  { id: 10, name: "Pilot boat", lengthM: 17, beamM: 5, freeboardM: 1.6 },
  { id: 11, name: "Patrol vessel", lengthM: 80, beamM: 12, freeboardM: 4.5 },
  { id: 12, name: "Sailing yacht", lengthM: 14, beamM: 4.2, freeboardM: 1.1 },
  { id: 13, name: "Motor yacht", lengthM: 25, beamM: 6, freeboardM: 2.2 },
  { id: 14, name: "Vessel", lengthM: 60, beamM: 12, freeboardM: 3.5 },
];

export function vesselModel(id: number): VesselModelSpec | undefined {
  return VESSEL_MODELS[id - 1];
}

/** What AIS has told us about a ship, as the classifiers take it. */
export interface VesselInfo {
  /** `ShipCategory`. */
  readonly category: number;
  /** The ship type as the gateway words it ("Tug", "Pilot vessel"), if any. */
  readonly typeName?: string | null;
  readonly name?: string | null;
  readonly lengthM?: number | null;
  readonly beamM?: number | null;
}

/** A name in upper case with single spaces, for the naming rules. */
export function normaliseShipName(name: string | null | undefined): string {
  return (name ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9/ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Car carrier fleets whose names say what they are: NYK's "… LEADER",
 * K Line's "… HIGHWAY", MOL's "… ACE", Höegh Autoliners' "HOEGH …" and
 * Hyundai Glovis's "GLOVIS …". Only trusted on cargo ships of car carrier
 * size (see `vesselModelFor`).
 */
export function isCarCarrierName(name: string | null | undefined): boolean {
  const n = normaliseShipName(name);
  return /^(HOEGH|GLOVIS) /.test(n) || / (LEADER|HIGHWAY|ACE)$/.test(n);
}

const positive = (x: number | null | undefined): number =>
  typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0;

/**
 * The model for a ship whose static data says this much. `schemeHint` is
 * the model its operator's colour scheme belongs on, if the name matched
 * one (a container line's name makes a cargo ship a container ship).
 */
export function vesselModelFor(info: VesselInfo, schemeHint: VesselModel = 0): VesselModel {
  const t = (info.typeName ?? "").toLowerCase();
  const length = positive(info.lengthM);
  const beam = positive(info.beamM);
  // The finer AIS types first: they say more than the category.
  if (t.includes("tug") || t.includes("towing")) return VesselModel.Tug;
  if (t.includes("pilot") || t.includes("port tender")) return VesselModel.PilotBoat;
  if (t.includes("search and rescue") || t.includes("law enforcement") || t.includes("military"))
    return length > 0 && length < 25 ? VesselModel.PilotBoat : VesselModel.Patrol;
  if (t.includes("sailing")) return VesselModel.SailingYacht;
  if (t.includes("pleasure"))
    return length > 0 && length < 18 ? VesselModel.SailingYacht : VesselModel.MotorYacht;
  if (t.includes("fishing")) return VesselModel.Fishing;
  if (t.includes("high-speed") || t.includes("high speed"))
    return length >= 40 ? VesselModel.Ferry : VesselModel.PilotBoat;
  if (t.includes("dredg") || t.includes("diving") || t.includes("anti-pollution"))
    return VesselModel.Generic;

  switch (info.category) {
    case ShipCategory.Cargo: {
      if (schemeHint !== VesselModel.Unknown) return schemeHint;
      if (isCarCarrierName(info.name) && (length === 0 || length >= 140))
        return VesselModel.CarCarrier;
      if (length === 0) return VesselModel.GeneralCargo;
      if (length < 110) return VesselModel.GeneralCargo;
      // Container ships are slimmer than bulk carriers of the same length,
      // and the largest of them are wider than any but the largest ore carriers.
      if (beam > 0 && (length / beam >= 7.6 || (length >= 330 && beam >= 45)))
        return VesselModel.Container;
      return VesselModel.Bulk;
    }
    case ShipCategory.Tanker:
      return VesselModel.Tanker;
    case ShipCategory.Passenger:
      if (schemeHint !== VesselModel.Unknown) return schemeHint;
      if (length >= 230) return VesselModel.Cruise;
      return VesselModel.Ferry;
    case ShipCategory.Fishing:
      return VesselModel.Fishing;
    case ShipCategory.Service:
      return length > 0 && length < 45 ? VesselModel.Tug : VesselModel.Generic;
    case ShipCategory.HighSpeed:
      return length >= 40 ? VesselModel.Ferry : VesselModel.PilotBoat;
    case ShipCategory.Pleasure:
      return length >= 24 ? VesselModel.MotorYacht : VesselModel.SailingYacht;
    case ShipCategory.Military:
      return VesselModel.Patrol;
    case ShipCategory.Other:
      return VesselModel.Generic;
    default:
      return VesselModel.Unknown;
  }
}

/** A stand-in for a ship whose model is not decided yet, by its category and length. */
export function genericVesselModel(category: number, lengthM = 0): VesselModel {
  const model = vesselModelFor({ category, lengthM });
  return model === VesselModel.Unknown ? VesselModel.Generic : model;
}
