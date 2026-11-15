/**
 * Colour schemes for the 3D ships.
 *
 * Each is a few flat colours: hull (with an optional second colour along
 * the waterline), deck, superstructure, funnel and its top band, the
 * colour most of a container ship's boxes are, and an accent for cranes,
 * lifeboats and a coast guard's bow stripe. They are simplified impressions
 * of how a type of ship, or a line's ships, look from a distance, not copies
 * of any livery: no logo, name, emblem or artwork is drawn, and no operator
 * has made or endorsed them.
 *
 * Ids 0 to 15 are the colours by type, one per `VesselModel` (0 for a ship
 * of unknown type). The rest are operators and roles, picked from the ship's
 * name where a fleet's naming identifies its operator beyond doubt ("MAERSK
 * …", "MSC …", "EVER …"), or from its AIS type (law enforcement, search and
 * rescue). A ship's batch value carries its scheme, 0 meaning "by type"
 * (`shipValue`).
 */
import { ShipCategory } from "./kinds.ts";
import { VesselModel, normaliseShipName, vesselModelFor } from "./vessel-types.ts";
import type { VesselInfo } from "./vessel-types.ts";

export interface VesselScheme {
  readonly id: number;
  /** The type, line or role, for the record; never drawn. */
  readonly name: string;
  /** Hull sides, `#rrggbb`. */
  readonly hull: string;
  /** A second hull colour from the waterline up to `below` of the freeboard (0..1). */
  readonly band?: { readonly color: string; readonly below: number };
  readonly deck: string;
  readonly superstructure: string;
  readonly funnel: string;
  /** The funnel's top `share` (0..1) in another colour. */
  readonly funnelTop?: { readonly color: string; readonly share: number };
  /** The colour `share` (0..1) of the containers are; the rest are mixed. */
  readonly boxes?: { readonly color: string; readonly share: number };
  /** Cranes, lifeboats, A-frames. */
  readonly accent: string;
  /** A slanted band across the bow, as coast guards paint. */
  readonly stripe?: string;
}

/** The first scheme id that is not a colour-by-type. */
export const FIRST_OPERATOR_SCHEME = 16;

const WHITE = "#f1f2f0";
const CREAM = "#ece7da";
const DECK_RED = "#7a3a2c";
const DECK_GREEN = "#55705a";
const DECK_GREY = "#7d8287";
const TEAK = "#a77b4f";
const SAFETY_ORANGE = "#e8661c";
const CRANE_YELLOW = "#dcae2a";
const BLACK = "#1f2124";
const NAVY = "#17284a";

type Colours = Omit<VesselScheme, "id" | "name">;
const S = (name: string, colours: Colours): Omit<VesselScheme, "id"> => ({ name, ...colours });

/** Colours by type, index = `VesselModel` id. */
const BY_TYPE: readonly Omit<VesselScheme, "id">[] = [
  S("Unknown", {
    hull: "#33414f",
    deck: DECK_GREY,
    superstructure: WHITE,
    funnel: "#33414f",
    accent: SAFETY_ORANGE,
  }),
  S("Container ship", {
    hull: "#2b3d55",
    deck: DECK_GREY,
    superstructure: WHITE,
    funnel: "#2b3d55",
    funnelTop: { color: BLACK, share: 0.2 },
    accent: SAFETY_ORANGE,
  }),
  S("Tanker", {
    hull: "#5b2a22",
    band: { color: BLACK, below: 0.18 },
    deck: DECK_RED,
    superstructure: WHITE,
    funnel: "#2a2c30",
    accent: SAFETY_ORANGE,
  }),
  S("Bulk carrier", {
    hull: "#232629",
    band: { color: "#7b2a22", below: 0.12 },
    deck: DECK_RED,
    superstructure: WHITE,
    funnel: "#232629",
    accent: CRANE_YELLOW,
  }),
  S("Car carrier", {
    hull: "#e3e5e6",
    band: { color: "#1d3557", below: 0.42 },
    deck: DECK_GREY,
    superstructure: "#e3e5e6",
    funnel: "#1d3557",
    accent: SAFETY_ORANGE,
  }),
  S("Cruise ship", {
    hull: WHITE,
    deck: "#3f8fb3",
    superstructure: WHITE,
    funnel: WHITE,
    funnelTop: { color: BLACK, share: 0.18 },
    accent: SAFETY_ORANGE,
  }),
  S("Passenger ferry", {
    hull: WHITE,
    band: { color: "#1f3a63", below: 0.45 },
    deck: DECK_GREY,
    superstructure: WHITE,
    funnel: WHITE,
    funnelTop: { color: "#1f3a63", share: 0.3 },
    accent: SAFETY_ORANGE,
  }),
  S("General cargo ship", {
    hull: "#3c5a48",
    deck: DECK_GREEN,
    superstructure: WHITE,
    funnel: "#3c5a48",
    funnelTop: { color: BLACK, share: 0.2 },
    accent: CRANE_YELLOW,
  }),
  S("Fishing vessel", {
    hull: "#a6312a",
    deck: DECK_GREY,
    superstructure: WHITE,
    funnel: "#a6312a",
    accent: SAFETY_ORANGE,
  }),
  S("Tug", {
    hull: BLACK,
    deck: DECK_RED,
    superstructure: WHITE,
    funnel: "#c8282a",
    funnelTop: { color: BLACK, share: 0.25 },
    accent: SAFETY_ORANGE,
  }),
  S("Pilot boat", {
    hull: BLACK,
    deck: DECK_GREY,
    superstructure: "#e2401c",
    funnel: "#e2401c",
    accent: WHITE,
  }),
  S("Patrol vessel", {
    hull: "#8b949b",
    deck: "#5e656b",
    superstructure: "#9aa2a8",
    funnel: "#8b949b",
    funnelTop: { color: BLACK, share: 0.12 },
    accent: "#5e656b",
  }),
  S("Sailing yacht", {
    hull: WHITE,
    deck: TEAK,
    superstructure: WHITE,
    funnel: WHITE,
    accent: "#f4f1e8",
  }),
  S("Motor yacht", {
    hull: WHITE,
    band: { color: "#2b3442", below: 0.12 },
    deck: TEAK,
    superstructure: WHITE,
    funnel: WHITE,
    accent: "#9aa4ad",
  }),
  S("Vessel", {
    hull: "#2f4157",
    deck: DECK_GREY,
    superstructure: WHITE,
    funnel: "#2f4157",
    funnelTop: { color: BLACK, share: 0.2 },
    accent: SAFETY_ORANGE,
  }),
  // Spare, so the operator schemes start at 16.
  S("Spare", {
    hull: "#33414f",
    deck: DECK_GREY,
    superstructure: WHITE,
    funnel: "#33414f",
    accent: SAFETY_ORANGE,
  }),
];

/** Operators and roles, from id 16. */
const OPERATORS: readonly Omit<VesselScheme, "id">[] = [
  // Roles.
  S("Coast guard", {
    hull: WHITE,
    deck: DECK_GREY,
    superstructure: WHITE,
    funnel: WHITE,
    funnelTop: { color: BLACK, share: 0.15 },
    accent: SAFETY_ORANGE,
    stripe: "#d9381e",
  }),
  S("Canadian Coast Guard", {
    hull: "#c1272d",
    deck: DECK_GREY,
    superstructure: WHITE,
    funnel: "#c1272d",
    accent: SAFETY_ORANGE,
  }),
  S("Search and rescue", {
    hull: NAVY,
    deck: DECK_GREY,
    superstructure: SAFETY_ORANGE,
    funnel: SAFETY_ORANGE,
    accent: WHITE,
  }),
  S("Military", {
    hull: "#7f888f",
    deck: "#575e64",
    superstructure: "#8b949b",
    funnel: "#7f888f",
    funnelTop: { color: BLACK, share: 0.12 },
    accent: "#575e64",
  }),
  S("Research vessel", {
    hull: WHITE,
    band: { color: NAVY, below: 0.2 },
    deck: DECK_GREY,
    superstructure: WHITE,
    funnel: WHITE,
    funnelTop: { color: BLACK, share: 0.15 },
    accent: SAFETY_ORANGE,
  }),
  // Container lines.
  S("Maersk", {
    hull: "#42a3c9",
    deck: DECK_GREY,
    superstructure: WHITE,
    funnel: "#42a3c9",
    boxes: { color: "#5b95b4", share: 0.6 },
    accent: SAFETY_ORANGE,
  }),
  S("MSC", {
    hull: "#1b1c1f",
    deck: DECK_GREY,
    superstructure: CREAM,
    funnel: "#e9be1b",
    funnelTop: { color: "#1b1c1f", share: 0.25 },
    boxes: { color: "#c9a33a", share: 0.45 },
    accent: SAFETY_ORANGE,
  }),
  S("CMA CGM", {
    hull: "#11295a",
    deck: DECK_GREY,
    superstructure: WHITE,
    funnel: WHITE,
    funnelTop: { color: "#11295a", share: 0.3 },
    boxes: { color: "#1f4b96", share: 0.5 },
    accent: SAFETY_ORANGE,
  }),
  S("COSCO", {
    hull: "#1f4c9a",
    deck: DECK_GREY,
    superstructure: WHITE,
    funnel: "#1f4c9a",
    funnelTop: { color: BLACK, share: 0.15 },
    boxes: { color: "#2d5eaa", share: 0.45 },
    accent: SAFETY_ORANGE,
  }),
  S("Evergreen", {
    hull: "#1f6a3b",
    deck: DECK_GREY,
    superstructure: WHITE,
    funnel: WHITE,
    funnelTop: { color: "#1f6a3b", share: 0.3 },
    boxes: { color: "#2d7a42", share: 0.6 },
    accent: SAFETY_ORANGE,
  }),
  S("Yang Ming", {
    hull: "#2b2e34",
    deck: DECK_GREY,
    superstructure: WHITE,
    funnel: "#e8b10c",
    funnelTop: { color: "#2b2e34", share: 0.2 },
    boxes: { color: "#8b949b", share: 0.4 },
    accent: SAFETY_ORANGE,
  }),
  S("HMM", {
    hull: "#152a5c",
    deck: DECK_GREY,
    superstructure: WHITE,
    funnel: "#ee6a22",
    funnelTop: { color: "#152a5c", share: 0.2 },
    boxes: { color: "#e06a2a", share: 0.35 },
    accent: SAFETY_ORANGE,
  }),
  S("ONE", {
    hull: "#c4167a",
    deck: DECK_GREY,
    superstructure: WHITE,
    funnel: "#c4167a",
    boxes: { color: "#c4167a", share: 0.65 },
    accent: SAFETY_ORANGE,
  }),
  S("ZIM", {
    hull: "#1e3f7a",
    deck: DECK_GREY,
    superstructure: WHITE,
    funnel: WHITE,
    funnelTop: { color: "#1e3f7a", share: 0.3 },
    boxes: { color: "#2a5aa8", share: 0.3 },
    accent: SAFETY_ORANGE,
  }),
  // Car carriers.
  S("Höegh Autoliners", {
    hull: "#1c2f52",
    deck: DECK_GREY,
    superstructure: WHITE,
    funnel: "#1c2f52",
    accent: SAFETY_ORANGE,
  }),
  S("Hyundai Glovis", {
    hull: WHITE,
    band: { color: "#0d3b8c", below: 0.35 },
    deck: DECK_GREY,
    superstructure: WHITE,
    funnel: "#0d3b8c",
    accent: SAFETY_ORANGE,
  }),
  // Cruise lines.
  S("Carnival", {
    hull: WHITE,
    deck: "#3f8fb3",
    superstructure: WHITE,
    funnel: "#d3202a",
    funnelTop: { color: "#1b3f8f", share: 0.4 },
    accent: SAFETY_ORANGE,
  }),
  S("Royal Caribbean", {
    hull: WHITE,
    band: { color: "#1a2f6b", below: 0.15 },
    deck: "#3f8fb3",
    superstructure: WHITE,
    funnel: WHITE,
    funnelTop: { color: "#1a2f6b", share: 0.35 },
    accent: SAFETY_ORANGE,
  }),
  S("Costa", {
    hull: WHITE,
    deck: "#3f8fb3",
    superstructure: WHITE,
    funnel: "#f2c315",
    funnelTop: { color: "#1b4a9b", share: 0.2 },
    accent: SAFETY_ORANGE,
  }),
  S("MSC Cruises", {
    hull: WHITE,
    band: { color: "#14213d", below: 0.15 },
    deck: "#3f8fb3",
    superstructure: WHITE,
    funnel: "#14213d",
    accent: SAFETY_ORANGE,
  }),
  S("Holland America", {
    hull: "#14254a",
    deck: TEAK,
    superstructure: WHITE,
    funnel: WHITE,
    funnelTop: { color: "#14254a", share: 0.3 },
    accent: SAFETY_ORANGE,
  }),
  S("Cunard", {
    hull: "#17181b",
    band: { color: "#a3242a", below: 0.1 },
    deck: TEAK,
    superstructure: WHITE,
    funnel: "#c8202a",
    funnelTop: { color: "#17181b", share: 0.22 },
    accent: SAFETY_ORANGE,
  }),
  S("Disney", {
    hull: "#14213d",
    deck: TEAK,
    superstructure: WHITE,
    funnel: "#c8202a",
    funnelTop: { color: "#17181b", share: 0.15 },
    accent: CRANE_YELLOW,
  }),
  S("Norwegian Cruise Line", {
    hull: WHITE,
    band: { color: "#1b3a73", below: 0.2 },
    deck: "#3f8fb3",
    superstructure: WHITE,
    funnel: "#1b3a73",
    accent: SAFETY_ORANGE,
  }),
  S("Celebrity", {
    hull: WHITE,
    band: { color: "#1f2a44", below: 0.12 },
    deck: "#3f8fb3",
    superstructure: WHITE,
    funnel: "#1f2a44",
    accent: SAFETY_ORANGE,
  }),
  S("AIDA", {
    hull: WHITE,
    deck: "#3f8fb3",
    superstructure: WHITE,
    funnel: "#1b4f9c",
    accent: SAFETY_ORANGE,
  }),
  // Ferries.
  S("Viking Line", {
    hull: "#c8202a",
    deck: DECK_GREY,
    superstructure: WHITE,
    funnel: "#c8202a",
    accent: SAFETY_ORANGE,
  }),
  S("DFDS", {
    hull: "#152a52",
    deck: DECK_GREY,
    superstructure: WHITE,
    funnel: "#152a52",
    accent: SAFETY_ORANGE,
  }),
];

/** Every scheme, id = place in the list. */
export const VESSEL_SCHEMES: readonly VesselScheme[] = [
  ...BY_TYPE.map((s, i) => ({ ...s, id: i })),
  ...OPERATORS.map((s, i) => ({ ...s, id: FIRST_OPERATOR_SCHEME + i })),
];

const schemeId = (name: string): number => {
  const found = VESSEL_SCHEMES.find((s) => s.name === name);
  if (!found || found.id < FIRST_OPERATOR_SCHEME) throw new Error(`No vessel scheme "${name}"`);
  return found.id;
};

export function vesselScheme(id: number): VesselScheme {
  return VESSEL_SCHEMES[id] ?? VESSEL_SCHEMES[0];
}

interface NameRule {
  scheme: string;
  /** Tested on the name in upper case with single spaces (`normaliseShipName`). */
  test: RegExp;
  /** The categories it is trusted for: the same name prefix can mean another fleet elsewhere. */
  categories: readonly number[];
  /** The model its ships are, when the rule says so. */
  model?: VesselModel;
  minLengthM?: number;
}

const { Cargo, Passenger } = ShipCategory;

/**
 * Names that identify an operator. Each is anchored to a whole word at the
 * start or end of the name, and only trusted for the category the fleet
 * sails in: "MAERSK …" tankers and supply ships are not the container line.
 */
const NAME_RULES: readonly NameRule[] = [
  { scheme: "Maersk", test: /^MAERSK |^[A-Z0-9 ]+ MAERSK$/, categories: [Cargo], model: 1 },
  { scheme: "MSC", test: /^MSC /, categories: [Cargo], model: 1 },
  { scheme: "MSC Cruises", test: /^MSC /, categories: [Passenger], model: 5 },
  { scheme: "CMA CGM", test: /^CMA CGM /, categories: [Cargo], model: 1 },
  { scheme: "COSCO", test: /^COSCO /, categories: [Cargo], model: 1 },
  { scheme: "Evergreen", test: /^EVER /, categories: [Cargo], model: 1 },
  { scheme: "Yang Ming", test: /^YM /, categories: [Cargo], model: 1 },
  { scheme: "HMM", test: /^HMM /, categories: [Cargo], model: 1 },
  // "ONE" is an ordinary word too: only big cargo ships named "ONE …" are the line's.
  { scheme: "ONE", test: /^ONE /, categories: [Cargo], model: 1, minLengthM: 150 },
  { scheme: "ZIM", test: /^ZIM /, categories: [Cargo], model: 1 },
  { scheme: "Höegh Autoliners", test: /^HOEGH /, categories: [Cargo], model: 4 },
  { scheme: "Hyundai Glovis", test: /^GLOVIS /, categories: [Cargo], model: 4 },
  { scheme: "Carnival", test: /^CARNIVAL /, categories: [Passenger], model: 5 },
  { scheme: "Royal Caribbean", test: / OF THE SEAS$/, categories: [Passenger], model: 5 },
  { scheme: "Costa", test: /^COSTA /, categories: [Passenger], model: 5 },
  {
    scheme: "Holland America",
    test: /^(NIEUW )?[A-Z]+DAM$/,
    categories: [Passenger],
    model: 5,
    minLengthM: 200,
  },
  {
    scheme: "Cunard",
    test: /^QUEEN (MARY 2|ELIZABETH|VICTORIA|ANNE)$/,
    categories: [Passenger],
    model: 5,
    minLengthM: 200,
  },
  { scheme: "Disney", test: /^DISNEY /, categories: [Passenger], model: 5 },
  { scheme: "Norwegian Cruise Line", test: /^NORWEGIAN /, categories: [Passenger], model: 5 },
  { scheme: "Celebrity", test: /^CELEBRITY /, categories: [Passenger], model: 5 },
  { scheme: "AIDA", test: /^AIDA[A-Z]+$/, categories: [Passenger], model: 5 },
  // Viking Line's ferries by name: Viking's ocean cruise ships share the prefix.
  {
    scheme: "Viking Line",
    test: /^VIKING (GRACE|GLORY|CINDERELLA|XPRS|AMORELLA|MARIELLA|GABRIELLA|ROSELLA)$/,
    categories: [Passenger],
    model: 6,
  },
  { scheme: "DFDS", test: / SEAWAYS$/, categories: [Passenger], model: 6 },
  { scheme: "DFDS", test: / SEAWAYS$/, categories: [Cargo], model: 4 },
  // Roles.
  { scheme: "Coast guard", test: /^(USCGC|KBV) /, categories: [] },
  { scheme: "Canadian Coast Guard", test: /^CCGS /, categories: [] },
  { scheme: "Search and rescue", test: /^RNLB /, categories: [] },
  { scheme: "Research vessel", test: /^(RV|R\/V|RRS) /, categories: [] },
];

const RULES = NAME_RULES.map((r) => ({ ...r, id: schemeId(r.scheme) }));

/**
 * The model a scheme belongs on: its own for a colour-by-type, its fleet's
 * for an operator, a patrol vessel for a role (a research vessel: any vessel).
 */
export function vesselSchemeModel(id: number): VesselModel {
  if (id < FIRST_OPERATOR_SCHEME) return id > 0 && id <= 14 ? (id as VesselModel) : 14;
  const rule = RULES.find((r) => r.id === id && r.model);
  if (rule?.model) return rule.model;
  return vesselScheme(id).name === "Research vessel" ? VesselModel.Generic : VesselModel.Patrol;
}

/** An operator's or role's scheme and the model it implies, from what AIS says; scheme 0 for none. */
export function vesselSchemeFor(info: {
  category: number;
  typeName?: string | null;
  name?: string | null;
  lengthM?: number | null;
}): { scheme: number; model: VesselModel } {
  const name = normaliseShipName(info.name);
  const length = typeof info.lengthM === "number" && info.lengthM > 0 ? info.lengthM : 0;
  if (name) {
    for (const rule of RULES) {
      if (rule.categories.length > 0 && !rule.categories.includes(info.category)) continue;
      if (rule.minLengthM && !(length >= rule.minLengthM)) continue;
      if (rule.test.test(name)) return { scheme: rule.id, model: rule.model ?? 0 };
    }
  }
  const t = (info.typeName ?? "").toLowerCase();
  if (t.includes("law enforcement")) return { scheme: schemeId("Coast guard"), model: 0 };
  if (t.includes("search and rescue")) return { scheme: schemeId("Search and rescue"), model: 0 };
  if (info.category === ShipCategory.Military || t.includes("military"))
    return { scheme: schemeId("Military"), model: 0 };
  return { scheme: 0, model: 0 };
}

/**
 * A ship's batch value from what AIS has told us: its length and beam, the
 * model of its kind and its operator's or role's colours.
 */
export function shipValueFor(info: VesselInfo): number {
  const { scheme, model } = vesselSchemeFor(info);
  return shipValue({
    lengthM: info.lengthM ?? 0,
    beamM: info.beamM ?? 0,
    model: vesselModelFor(info, model),
    scheme,
  });
}

// ── A ship's batch value ──────────────────────────────────────────────────
//
// Four fields in one exact float32 integer (below 2^24): length in 2 m steps
// (8 bits, to 510 m), beam in metres (6 bits, to 63 m; AIS reports up to 126 m as
// two 6-bit sides, and the few wider ships are clamped, which the models absorb),
// model (4 bits) and scheme (6 bits).

const LENGTH_STEP_M = 2;

export interface ShipValue {
  /** Overall length and beam, metres; 0 when not known. */
  lengthM: number;
  beamM: number;
  model: VesselModel;
  /** Colour scheme; 0 means the model's own colours. */
  scheme: number;
}

/** Pack a ship's length, beam, model and scheme into its batch value. */
export function shipValue(v: ShipValue): number {
  const length = Math.min(Math.max(Math.round(v.lengthM / LENGTH_STEP_M), 0), 255);
  const beam = Math.min(Math.max(Math.round(v.beamM), 0), 63);
  const model = Math.min(Math.max(Math.trunc(v.model), 0), 15);
  const scheme = Math.min(Math.max(Math.trunc(v.scheme), 0), 63);
  return length + beam * 256 + model * 16_384 + scheme * 262_144;
}

/** The fields a ship's batch value carries. */
export function splitShipValue(value: number): ShipValue {
  const v = value > 0 && value < 16_777_216 ? Math.trunc(value) : 0;
  return {
    lengthM: (v & 0xff) * LENGTH_STEP_M,
    beamM: (v >> 8) & 0x3f,
    model: ((v >> 14) & 0xf) as VesselModel,
    scheme: (v >> 18) & 0x3f,
  };
}
