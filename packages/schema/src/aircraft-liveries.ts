/**
 * Airline colour schemes for the 3D aircraft.
 *
 * Each is a few flat colours: the fuselage's top and belly, the fin (with an
 * optional second colour on part of it) and the engines. They are simplified
 * impressions of how an airline's aircraft look from a distance, not copies
 * of its livery: no logo, name, emblem or artwork is drawn, and no airline
 * has made or endorsed them.
 *
 * The scheme comes from the callsign: an airline flight's callsign is its
 * operator's three-letter ICAO designator and a flight number ("BAW834",
 * "RYR1"). Aircraft without one, or whose operator is not listed, get the
 * neutral scheme, id 0.
 *
 * An aircraft's batch `value` carries both the model and the scheme
 * (`aircraftValue`), and the render batch gives each a byte.
 */

export type LiveryAccent =
  /** The fin's upper part, above `split` of its height. */
  | "top"
  /** The fin's lower part, below `split` of its height. */
  | "bottom"
  /** The fin's trailing part, behind `split` of its chord. */
  | "rear";

export interface AircraftLivery {
  readonly id: number;
  /** The operator, for the record; never drawn. */
  readonly name: string;
  /** ICAO airline designators flown in this scheme. */
  readonly codes: readonly string[];
  /** Upper fuselage, `#rrggbb`. */
  readonly top: string;
  /** Lower fuselage, below `bellyLine`; the top colour when absent. */
  readonly belly?: string;
  /**
   * Where the belly colour begins: the sine of the angle round the fuselage
   * from the side, -1 at the keel, 0 at the widest point, 1 on top.
   */
  readonly bellyLine?: number;
  readonly tail: string;
  readonly accent?: { readonly color: string; readonly on: LiveryAccent; readonly split: number };
  /** Engine nacelles; the default is light grey. */
  readonly engines?: string;
}

const WHITE = "#f3f5f7";

/** The scheme for aircraft whose airline is not known: the app's own light grey. */
export const NEUTRAL_LIVERY: AircraftLivery = {
  id: 0,
  name: "Neutral",
  codes: [],
  top: "#e2ecf2",
  tail: "#e2ecf2",
  engines: "#c4ccd2",
};

const L = (
  name: string,
  codes: string[],
  scheme: Omit<AircraftLivery, "id" | "name" | "codes">,
): Omit<AircraftLivery, "id"> => ({ name, codes, ...scheme });

const SCHEMES: readonly Omit<AircraftLivery, "id">[] = [
  L("Ryanair", ["RYR", "RUK", "MAY", "RYS"], {
    top: WHITE,
    belly: "#073590",
    bellyLine: -0.2,
    tail: "#073590",
    engines: "#073590",
  }),
  L("easyJet", ["EZY", "EJU", "EZS"], { top: WHITE, tail: "#ff6600", engines: "#ff6600" }),
  L("Wizz Air", ["WZZ", "WMT", "WUK", "WAZ"], {
    top: WHITE,
    tail: "#c6007e",
    accent: { color: "#2b2a72", on: "bottom", split: 0.35 },
  }),
  L("Lufthansa", ["DLH", "CLH", "LHX"], { top: WHITE, tail: "#05164d", engines: "#05164d" }),
  L("Air France", ["AFR"], {
    top: WHITE,
    tail: WHITE,
    accent: { color: "#002157", on: "rear", split: 0.55 },
  }),
  L("KLM", ["KLM", "KLC"], {
    top: "#00a1de",
    belly: WHITE,
    bellyLine: -0.15,
    tail: "#00a1de",
    engines: "#00a1de",
  }),
  L("British Airways", ["BAW", "SHT", "CFE"], {
    top: WHITE,
    belly: "#13265c",
    bellyLine: -0.3,
    tail: "#13265c",
    accent: { color: "#c8102e", on: "rear", split: 0.5 },
  }),
  L("United Airlines", ["UAL"], {
    top: WHITE,
    belly: "#0a3c8c",
    bellyLine: -0.3,
    tail: "#00205b",
    engines: "#00205b",
  }),
  L("Delta Air Lines", ["DAL"], {
    top: WHITE,
    belly: "#003366",
    bellyLine: -0.35,
    tail: "#c8102e",
    accent: { color: "#003366", on: "bottom", split: 0.3 },
  }),
  L("American Airlines", ["AAL"], {
    top: "#c5cbd1",
    tail: "#0078d2",
    accent: { color: "#c30019", on: "rear", split: 0.5 },
    engines: "#c5cbd1",
  }),
  L("Qatar Airways", ["QTR"], {
    top: WHITE,
    belly: "#d9d9db",
    bellyLine: -0.25,
    tail: "#5c0632",
  }),
  L("Turkish Airlines", ["THY"], { top: WHITE, tail: "#c8102e" }),
  L("Aegean Airlines", ["AEE"], { top: WHITE, tail: "#1f3c88", engines: "#1f3c88" }),
  L("Swiss", ["SWR"], { top: WHITE, tail: "#e30613" }),
  L("Austrian Airlines", ["AUA"], { top: WHITE, tail: "#d81e05" }),
  L("Iberia", ["IBE", "IBS"], {
    top: WHITE,
    tail: "#d7192d",
    accent: { color: "#fcb913", on: "bottom", split: 0.35 },
  }),
  L("SAS", ["SAS"], { top: "#e7e9ee", tail: "#000f60", engines: "#000f60" }),
  L("Qantas", ["QFA", "QLK"], { top: WHITE, tail: "#e0001b" }),
  L("Virgin Atlantic", ["VIR"], { top: "#eef0f3", tail: "#e10a0a" }),
  L("Transavia", ["TRA", "TVF"], { top: WHITE, tail: "#00b562" }),
  L("Jet2", ["EXS"], { top: WHITE, tail: "#d0021b" }),
  L("TUI", ["TOM", "TUI", "TFL", "JAF"], { top: WHITE, tail: "#70cbf4", engines: "#70cbf4" }),
  L("LOT Polish Airlines", ["LOT"], { top: WHITE, tail: "#11397e" }),
  L("Korean Air", ["KAL"], {
    top: "#a7d5ee",
    belly: "#c9cdd2",
    bellyLine: -0.05,
    tail: WHITE,
  }),
  L("Cathay Pacific", ["CPA"], { top: WHITE, tail: "#00645a" }),
  L("Singapore Airlines", ["SIA"], { top: WHITE, tail: "#1d2c6d" }),
  L("Air Canada", ["ACA", "JZA"], {
    top: WHITE,
    belly: "#1b1b1b",
    bellyLine: -0.3,
    tail: "#1b1b1b",
    engines: "#1b1b1b",
  }),
  L("Alaska Airlines", ["ASA"], { top: WHITE, tail: "#01426a" }),
  L("JetBlue", ["JBU"], {
    top: WHITE,
    belly: "#003876",
    bellyLine: -0.3,
    tail: "#0033a0",
    engines: "#003876",
  }),
  L("FedEx Express", ["FDX"], {
    top: WHITE,
    belly: "#b8b8bc",
    bellyLine: -0.25,
    tail: "#4d148c",
  }),
  L("Norwegian", ["NAX", "NOZ", "NSZ"], { top: WHITE, tail: "#d81939" }),
];

/** Every scheme, id = place in the list; id 0 is `NEUTRAL_LIVERY`. */
export const AIRCRAFT_LIVERIES: readonly AircraftLivery[] = [
  NEUTRAL_LIVERY,
  ...SCHEMES.map((s, i) => ({ ...s, id: i + 1 })),
];

const BY_CODE = new Map<string, number>();
for (const livery of AIRCRAFT_LIVERIES)
  for (const code of livery.codes) BY_CODE.set(code, livery.id);

/** The airline designator in an airline flight's callsign ("BAW834" is "BAW"), or null. */
export function airlineOfCallsign(callsign: string | undefined | null): string | null {
  if (!callsign) return null;
  const c = callsign.trim().toUpperCase();
  // Three letters, then a flight number that starts with a digit (it may end in letters: "EZY83TD").
  return /^[A-Z]{3}[0-9][0-9A-Z]{0,4}$/.test(c) ? c.slice(0, 3) : null;
}

/** The colour scheme for an aircraft flying under this callsign; 0 (neutral) when unknown. */
export function aircraftLiveryForCallsign(callsign: string | undefined | null): number {
  const airline = airlineOfCallsign(callsign);
  return airline ? (BY_CODE.get(airline) ?? 0) : 0;
}

export function aircraftLivery(id: number): AircraftLivery {
  return AIRCRAFT_LIVERIES[id] ?? NEUTRAL_LIVERY;
}

/** An aircraft's batch value: its model id in the low byte, its colour scheme in the next. */
export function aircraftValue(model: number, livery: number): number {
  return (model & 0xff) + (livery & 0xff) * 256;
}

/** The model id and colour scheme an aircraft's batch value carries. */
export function splitAircraftValue(value: number): { model: number; livery: number } {
  const v = value > 0 && value < 65536 ? Math.trunc(value) : 0;
  return { model: v & 0xff, livery: v >> 8 };
}
