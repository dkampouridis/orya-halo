/**
 * Airline colour schemes for the 3D aircraft.
 *
 * Each is a few flat colours: the fuselage's top and belly, the fin (with an
 * optional second colour on part of it), the engines, and where the airline
 * paints them, the nose, the fin's colour carried onto the rear fuselage and
 * a cheatline along the side. They are simplified
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
  | "rear"
  /** The fin's leading part, ahead of `split` of its chord. */
  | "front";

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
  /** The nose cone, ahead of the flight deck windows, where the airline paints it. */
  readonly nose?: string;
  /**
   * A colour carried from the fin onto the rear fuselage, measured as shares
   * of the fuselage's length from the tip of the tail cone (0) to the nose
   * (1); the tail cone is about the last quarter. It runs from `from`
   * (default 0: the whole tail cone) forward to `to`, reaching a little
   * further along the top than the belly, and round the fuselage above
   * `above` (the sine of the angle round from the side, as `bellyLine`;
   * default -1, all the way round).
   */
  readonly rear?: {
    readonly color: string;
    readonly to: number;
    readonly from?: number;
    readonly above?: number;
  };
  /**
   * A cheatline: a band along the side between the sines `lo` and `hi`
   * (as `bellyLine`), from `from` to `to` of the fuselage's length from the
   * tail (default the whole cabin, 0.25 to 0.9).
   */
  readonly stripe?: {
    readonly color: string;
    readonly lo: number;
    readonly hi: number;
    readonly from?: number;
    readonly to?: number;
  };
  /**
   * The colour that says which airline this is, where it is not the first
   * coloured paint (see `liveryMark`).
   */
  readonly mark?: string;
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
    // The blue belly sweeps up into the fin at the back.
    rear: { color: "#073590", to: 0.29 },
  }),
  L("easyJet", ["EZY", "EJU", "EZS"], {
    top: WHITE,
    tail: "#ff6600",
    engines: "#ff6600",
    // Checked against public sources, 2026-11-15: no orange nose cone; the orange runs from the fin onto the rear fuselage.
    rear: { color: "#ff6600", to: 0.3 },
  }),
  L("Wizz Air", ["WZZ", "WMT", "WUK", "WAZ"], {
    top: WHITE,
    tail: "#c6007e",
    accent: { color: "#2b2a72", on: "bottom", split: 0.35 },
    // Magenta and violet sweep over the rear fuselage.
    rear: { color: "#c6007e", to: 0.35 },
  }),
  L("Lufthansa", ["DLH", "CLH", "LHX"], {
    top: WHITE,
    tail: "#05164d",
    // Checked against public sources, 2026-11-15: white engines; the dark blue fin runs onto the top of the rear
    // fuselage, the tail cone behind it stays white.
    engines: WHITE,
    rear: { color: "#05164d", from: 0.1, to: 0.31, above: -0.25 },
  }),
  L("Air France", ["AFR", "HOP"], {
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
    // Checked against public sources, 2026-11-15: a Runway Gray belly, Rhapsody Blue engines.
    belly: "#9ea2a6",
    bellyLine: -0.3,
    tail: "#00205b",
    engines: "#0033a0",
  }),
  L("Delta Air Lines", ["DAL", "EDV"], {
    top: WHITE,
    belly: "#003366",
    bellyLine: -0.35,
    tail: "#c8102e",
    accent: { color: "#003366", on: "bottom", split: 0.3 },
  }),
  L("American Airlines", ["AAL", "ENY", "PDT", "JIA"], {
    top: "#c5cbd1",
    tail: "#0078d2",
    accent: { color: "#c30019", on: "rear", split: 0.5 },
    engines: "#c5cbd1",
  }),
  L("Qatar Airways", ["QTR"], {
    // Checked against public sources, 2026-11-15: a light grey top over a white belly.
    top: "#d9d9db",
    belly: WHITE,
    bellyLine: -0.25,
    tail: "#5c0632",
    // The maroon at the fin's root, kept small (not confirmed further forward).
    rear: { color: "#5c0632", from: 0.08, to: 0.27, above: 0.3 },
  }),
  L("Turkish Airlines", ["THY"], {
    top: WHITE,
    belly: "#c3c8ce",
    bellyLine: -0.3,
    tail: "#c8102e",
  }),
  L("Aegean Airlines", ["AEE"], {
    top: WHITE,
    tail: "#1f3c88",
    engines: "#1f3c88",
    // Checked against public sources, 2026-11-15: the deep blue fin carries down onto the fuselage.
    rear: { color: "#1f3c88", from: 0.06, to: 0.29, above: -0.2 },
  }),
  L("Swiss", ["SWR"], { top: WHITE, tail: "#e30613" }),
  L("Austrian Airlines", ["AUA"], {
    top: WHITE,
    tail: "#d81e05",
    // Checked against public sources, 2026-11-15: the red fin runs onto the rear fuselage.
    rear: { color: "#d81e05", to: 0.3 },
  }),
  L("Iberia", ["IBE", "IBS", "ANE"], {
    top: WHITE,
    tail: "#d7192d",
    accent: { color: "#fcb913", on: "bottom", split: 0.35 },
  }),
  L("SAS", ["SAS"], {
    top: "#e7e9ee",
    tail: "#000f60",
    // Checked against public sources, 2026-11-15: beige engines; the fin's blue carried onto the rear fuselage.
    engines: "#c9b99a",
    rear: { color: "#000f60", to: 0.3 },
  }),
  L("Qantas", ["QFA", "QLK"], {
    top: WHITE,
    tail: "#e0001b",
    // Checked against public sources, 2026-11-15: the red fin runs down over the tail cone onto the rear fuselage.
    rear: { color: "#e0001b", to: 0.32 },
  }),
  // Checked against public sources, 2026-11-15: red engines.
  L("Virgin Atlantic", ["VIR"], { top: "#eef0f3", tail: "#e10a0a", engines: "#e10a0a" }),
  // Checked against public sources, 2026-11-15: green engines.
  L("Transavia", ["TRA", "TVF"], { top: WHITE, tail: "#00b562", engines: "#00b562" }),
  // Checked against public sources, 2026-11-15: red engines.
  L("Jet2", ["EXS"], { top: WHITE, tail: "#d0021b", engines: "#d0021b" }),
  L("TUI", ["TOM", "TUI", "TFL", "JAF"], { top: WHITE, tail: "#70cbf4", engines: "#70cbf4" }),
  L("LOT Polish Airlines", ["LOT"], { top: WHITE, tail: "#11397e" }),
  L("Korean Air", ["KAL"], {
    top: "#a7d5ee",
    // Checked against public sources, 2026-11-15: a white belly.
    belly: WHITE,
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
  L("Norwegian", ["NAX", "NOZ", "NSZ"], {
    top: WHITE,
    // Checked against public sources, 2026-11-15: a white fin with a red top; the red nose is right.
    tail: WHITE,
    accent: { color: "#d81939", on: "top", split: 0.8 },
    nose: "#d81939",
  }),
  // Gulf and Middle East.
  L("Emirates", ["UAE"], {
    top: WHITE,
    tail: "#00843d",
    accent: { color: "#d71921", on: "front", split: 0.3 },
  }),
  L("Etihad Airways", ["ETD"], { top: "#ece6dc", tail: "#a8875b", engines: "#ece6dc" }),
  L("flydubai", ["FDB"], {
    top: WHITE,
    belly: "#1a3a8f",
    bellyLine: -0.2,
    tail: "#1a3a8f",
    accent: { color: "#f58220", on: "rear", split: 0.6 },
  }),
  L("Air Arabia", ["ABY", "ADY", "MAC", "RBG"], {
    top: WHITE,
    tail: "#e2231a",
    // Checked against public sources, 2026-11-15: the fin's red carried onto the rear fuselage.
    rear: { color: "#e2231a", to: 0.3 },
  }),
  L("Oman Air", ["OMA"], { top: WHITE, tail: "#006e6e" }),
  L("Gulf Air", ["GFA"], { top: WHITE, tail: "#a6192e" }),
  L("Royal Jordanian", ["RJA"], { top: "#d9d9db", tail: "#2b2b2b" }),
  L("El Al", ["ELY"], { top: WHITE, tail: "#0b2a5a" }),
  // Checked against public sources, 2026-11-15: the current scheme, a white body with a green fin and engines
  // (the 1996 scheme had a sand belly and a blue fin).
  L("Saudia", ["SVA"], { top: WHITE, tail: "#00704a", engines: "#00704a" }),
  // Turkey, Caucasus and Central Asia.
  L("Pegasus", ["PGT"], {
    top: WHITE,
    // Checked against public sources, 2026-11-15: no red on the fin.
    tail: "#fdb913",
    engines: "#fdb913",
    rear: { color: "#fdb913", to: 0.28 },
  }),
  L("AJet", ["TKJ"], { top: WHITE, tail: "#0b2d63", engines: "#0b2d63" }),
  L("SunExpress", ["SXS"], { top: WHITE, tail: "#f7a600" }),
  L("Azerbaijan Airlines", ["AHY"], { top: WHITE, tail: "#0098c3" }),
  L("Aeroflot", ["AFL"], {
    top: WHITE,
    // Checked against public sources, 2026-11-15: a grey belly.
    belly: "#c3c8ce",
    bellyLine: -0.3,
    tail: "#0039a6",
    accent: { color: "#d52b1e", on: "bottom", split: 0.33 },
  }),
  // Africa.
  L("EgyptAir", ["MSR"], { top: WHITE, tail: "#1c3768" }),
  // Checked against public sources, 2026-11-15: a white fin carrying a crimson swallow, drawn as a flat
  // crimson on the fin's trailing part.
  L("Air Algérie", ["DAH"], {
    top: WHITE,
    tail: WHITE,
    accent: { color: "#e4241c", on: "rear", split: 0.35 },
  }),
  // Checked against public sources, 2026-11-15: a white fin with a red gazelle leaping up it, drawn as a flat
  // red over the fin's upper part.
  L("Tunisair", ["TAR"], {
    top: WHITE,
    tail: WHITE,
    accent: { color: "#e2001a", on: "top", split: 0.5 },
  }),
  // Checked against public sources, 2026-11-15: red and green on the fin, after Morocco's colours.
  L("Royal Air Maroc", ["RAM"], {
    top: WHITE,
    tail: "#c8102e",
    accent: { color: "#006233", on: "rear", split: 0.62 },
  }),
  L("Ethiopian Airlines", ["ETH"], {
    top: WHITE,
    tail: "#007a3d",
    accent: { color: "#da121a", on: "rear", split: 0.66 },
  }),
  // Europe.
  L("ITA Airways", ["ITY"], {
    top: "#0a4da2",
    tail: "#0a4da2",
    // Checked against public sources, 2026-11-15: white engines; the tricolour is a stripe on the rudder.
    accent: { color: "#008c45", on: "rear", split: 0.82 },
    engines: WHITE,
  }),
  L("Vueling", ["VLG"], { top: WHITE, tail: "#4c4c4c", engines: "#ffcc00" }),
  L("Eurowings", ["EWG"], { top: WHITE, tail: "#9e1a5b" }),
  L("Air Europa", ["AEA"], { top: WHITE, tail: "#00326e", engines: "#00326e" }),
  // Checked against public sources, 2026-11-15: teal engines.
  L("Aer Lingus", ["EIN", "EAI"], { top: WHITE, tail: "#00747a", engines: "#00747a" }),
  L("TAP Air Portugal", ["TAP"], {
    top: WHITE,
    tail: "#e30613",
    accent: { color: "#00a651", on: "bottom", split: 0.4 },
  }),
  L("Brussels Airlines", ["BEL"], { top: WHITE, tail: "#d31045" }),
  L("Edelweiss", ["EDW"], { top: WHITE, tail: "#e2001a" }),
  L("airBaltic", ["BTI"], {
    top: WHITE,
    tail: "#c4d600",
    engines: "#c4d600",
    // Checked against public sources, 2026-11-15: the fin's lime carried onto the rear fuselage.
    rear: { color: "#c4d600", to: 0.3 },
  }),
  L("Luxair", ["LGL"], { top: WHITE, tail: "#00a3e0" }),
  L("Croatia Airlines", ["CTN"], { top: WHITE, tail: "#003f87" }),
  L("TAROM", ["ROT"], { top: WHITE, tail: "#002e6d" }),
  L("Icelandair", ["ICE"], { top: WHITE, tail: "#003a7d" }),
  L("Sky Express", ["SEH"], { top: WHITE, tail: "#2a2c6b" }),
  L("KM Malta Airlines", ["KMM"], { top: WHITE, tail: "#cf142b" }),
  L("DHL", ["DHK", "BCS", "DAE", "DHX"], {
    top: "#ffcc00",
    tail: "#ffcc00",
    accent: { color: "#d40511", on: "bottom", split: 0.3 },
    engines: "#ffcc00",
  }),
  // Checked against public sources, 2026-11-15: a silver body and fin with a red stripe along the side, not a red fin.
  L("VistaJet", ["VJT"], {
    top: "#c9ced3",
    tail: "#c9ced3",
    engines: "#c9ced3",
    stripe: { color: "#d6001c", lo: -0.12, hi: 0.06, from: 0.12, to: 0.92 },
    mark: "#d6001c",
  }),
  // Asia and Oceania.
  L("Air India", ["AIC"], {
    top: WHITE,
    tail: "#c8102e",
    accent: { color: "#5b2c6f", on: "bottom", split: 0.35 },
  }),
  L("China Southern", ["CSN"], { top: WHITE, tail: "#0f5aa8" }),
  L("ANA", ["ANA"], { top: WHITE, tail: "#13448f" }),
  L("Thai Airways", ["THA"], { top: WHITE, tail: "#5c2483" }),
  L("Garuda Indonesia", ["GIA"], { top: WHITE, tail: "#0094a8" }),
  // Checked against public sources, 2026-11-15: silver engines.
  L("Air New Zealand", ["ANZ"], { top: WHITE, tail: "#111111", engines: "#b8bec4" }),
  // The Americas.
  // Checked against public sources, 2026-11-15: a white body with a red fin and engines, not an all-red body.
  L("Avianca", ["AVA"], { top: WHITE, tail: "#da291c", engines: "#da291c" }),
  L("LATAM", ["LAN", "TAM", "LPE"], {
    top: WHITE,
    tail: "#1b0088",
    accent: { color: "#e8114b", on: "rear", split: 0.6 },
  }),
  L("Aeroméxico", ["AMX"], { top: WHITE, tail: "#0b2343" }),
  L("Volaris", ["VOI"], { top: WHITE, tail: "#5f259f" }),
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

/** True for a colour with a hue to it: not white, grey or black. */
function chromatic(hex: string): boolean {
  const n = Number.parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const hi = Math.max(...c);
  const lo = Math.min(...c);
  // Korean Air's pale sky blue, at 0.3, is the palest that has to count.
  return hi >= 40 && (hi - lo) / hi >= 0.25;
}

/**
 * The colour that says which airline this is from a distance, or null when
 * the scheme has none (only white, greys and black). It is the scheme's
 * `mark` where it has one, else the first coloured one of: the fuselage top
 * (an aircraft painted all over), the fin, the fin's second colour, the rear
 * fuselage, the cheatline, the belly, the engines. Small glyphs carry it on
 * their rear half, and small 3D models along the top of the fuselage.
 */
export function liveryMark(livery: AircraftLivery): string | null {
  const candidates = [
    livery.mark,
    livery.top,
    livery.tail,
    livery.accent?.color,
    livery.rear?.color,
    livery.stripe?.color,
    livery.belly,
    livery.engines,
  ];
  return candidates.find((c): c is string => c !== undefined && chromatic(c)) ?? null;
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
