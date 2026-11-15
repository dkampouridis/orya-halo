/**
 * Aircraft types and the 3D models they are drawn with.
 *
 * Each model is generated from published dimensions (length, span, fuselage
 * width, wing sweep and chord, engine size and layout, tail layout), so
 * every type keeps its real proportions without any third-party artwork.
 * Dimensions are facts, not anyone's design; no livery or logo is drawn.
 *
 * The worker maps an aircraft's ICAO type designator (adsb.lol's `t`) to a
 * model id with `aircraftModelForType`; the engine builds one mesh per id.
 * Id 0 means "not known": the engine then picks a generic model by the
 * aircraft's ADS-B category (`genericAircraftModel`).
 */
import { AircraftCategory } from "./kinds.ts";

export type EngineMount =
  /** Under the wings, at `spanShare` of the half-span. */
  | "wing"
  /** On the rear fuselage, either side. */
  | "rear"
  /** One in the nose (single-engine propeller aircraft). */
  | "nose"
  /** Two under the wings and one in the tail (MD-11, DC-10). */
  | "wing-tail";

export interface AircraftModelSpec {
  readonly id: number;
  readonly name: string;
  /** Overall length and wingspan, metres. */
  readonly lengthM: number;
  readonly spanM: number;
  /** Fuselage width and height, metres. */
  readonly fuselageWidthM: number;
  readonly fuselageHeightM: number;
  /** Share of the length, from the nose, raised by an upper deck (747); 0 for none. */
  readonly humpShare?: number;
  readonly wing: {
    /** Leading-edge sweep, degrees. */
    readonly sweepDeg: number;
    /** Chord where the wing meets the fuselage, metres. */
    readonly rootChordM: number;
    /** Tip chord over root chord. */
    readonly taper: number;
    readonly position: "low" | "high";
    readonly dihedralDeg: number;
    /** Where the wing root's leading edge is, as a share of the length from the nose. */
    readonly rootShare: number;
    /** Winglet height, metres; 0 for none. */
    readonly wingletM?: number;
  };
  readonly tail: {
    readonly kind: "low" | "t";
    /** Fin height above the fuselage, metres. */
    readonly finHeightM: number;
    /** Tailplane span, metres. */
    readonly spanM: number;
  };
  readonly engines: {
    readonly count: number;
    readonly mount: EngineMount;
    readonly kind: "jet" | "prop";
    /** Nacelle (or for propellers, the propeller disc) diameter, metres. */
    readonly diameterM: number;
    readonly lengthM: number;
    /** Distance from the centreline as a share of the half-span, one per engine pair. */
    readonly spanShare?: readonly number[];
  };
  /** Helicopters only: main rotor diameter, metres. */
  readonly rotorM?: number;
}

type Jet = Omit<AircraftModelSpec, "id" | "name" | "lengthM" | "spanM">;

const narrowbody: Jet = {
  fuselageWidthM: 3.95,
  fuselageHeightM: 4.14,
  wing: {
    sweepDeg: 27,
    rootChordM: 6.1,
    taper: 0.24,
    position: "low",
    dihedralDeg: 5,
    rootShare: 0.36,
    wingletM: 2.4,
  },
  tail: { kind: "low", finHeightM: 5.9, spanM: 12.45 },
  engines: {
    count: 2,
    mount: "wing",
    kind: "jet",
    diameterM: 2.2,
    lengthM: 4.4,
    spanShare: [0.33],
  },
};

const boeing737: Jet = {
  ...narrowbody,
  fuselageWidthM: 3.76,
  fuselageHeightM: 4.01,
  wing: { ...narrowbody.wing, rootChordM: 5.4, wingletM: 2.5 },
  tail: { kind: "low", finHeightM: 6.0, spanM: 14.35 },
  engines: { ...narrowbody.engines, diameterM: 2.05, lengthM: 4.1, spanShare: [0.3] },
};

const regionalJet: Jet = {
  fuselageWidthM: 3.0,
  fuselageHeightM: 3.35,
  wing: {
    sweepDeg: 25,
    rootChordM: 4.4,
    taper: 0.3,
    position: "low",
    dihedralDeg: 5,
    rootShare: 0.38,
    wingletM: 1.6,
  },
  tail: { kind: "low", finHeightM: 4.8, spanM: 10.4 },
  engines: {
    count: 2,
    mount: "wing",
    kind: "jet",
    diameterM: 1.75,
    lengthM: 3.9,
    spanShare: [0.3],
  },
};

const rearJet: Jet = {
  fuselageWidthM: 2.69,
  fuselageHeightM: 2.85,
  wing: {
    sweepDeg: 27,
    rootChordM: 4.2,
    taper: 0.3,
    position: "low",
    dihedralDeg: 4,
    rootShare: 0.45,
    wingletM: 1.2,
  },
  tail: { kind: "t", finHeightM: 4.4, spanM: 8.5 },
  engines: { count: 2, mount: "rear", kind: "jet", diameterM: 1.45, lengthM: 3.2 },
};

const widebodyTwin: Jet = {
  fuselageWidthM: 6.2,
  fuselageHeightM: 6.6,
  wing: {
    sweepDeg: 33,
    rootChordM: 13.0,
    taper: 0.18,
    position: "low",
    dihedralDeg: 6,
    rootShare: 0.33,
  },
  tail: { kind: "low", finHeightM: 9.2, spanM: 21.5 },
  engines: {
    count: 2,
    mount: "wing",
    kind: "jet",
    diameterM: 3.6,
    lengthM: 6.8,
    spanShare: [0.32],
  },
};

const highWingTurboprop: Jet = {
  fuselageWidthM: 2.8,
  fuselageHeightM: 2.9,
  wing: {
    sweepDeg: 3,
    rootChordM: 2.6,
    taper: 0.6,
    position: "high",
    dihedralDeg: 1,
    rootShare: 0.4,
  },
  tail: { kind: "t", finHeightM: 4.4, spanM: 7.3 },
  engines: {
    count: 2,
    mount: "wing",
    kind: "prop",
    diameterM: 3.9,
    lengthM: 4.6,
    spanShare: [0.3],
  },
};

const piston: Jet = {
  fuselageWidthM: 1.1,
  fuselageHeightM: 1.4,
  wing: {
    sweepDeg: 0,
    rootChordM: 1.6,
    taper: 0.7,
    position: "high",
    dihedralDeg: 2,
    rootShare: 0.3,
  },
  tail: { kind: "low", finHeightM: 1.5, spanM: 3.4 },
  engines: { count: 1, mount: "nose", kind: "prop", diameterM: 1.9, lengthM: 1.2 },
};

const bizjet: Jet = {
  fuselageWidthM: 1.7,
  fuselageHeightM: 1.85,
  wing: {
    sweepDeg: 18,
    rootChordM: 2.6,
    taper: 0.4,
    position: "low",
    dihedralDeg: 4,
    rootShare: 0.42,
    wingletM: 0.9,
  },
  tail: { kind: "t", finHeightM: 2.8, spanM: 6.0 },
  engines: { count: 2, mount: "rear", kind: "jet", diameterM: 0.95, lengthM: 2.6 },
};

let next = 1;
const model = (
  name: string,
  lengthM: number,
  spanM: number,
  base: Jet,
  more: Partial<Jet> = {},
): AircraftModelSpec => ({
  id: next++,
  name,
  lengthM,
  spanM,
  ...base,
  ...more,
});

/** Every model, by id (index = id - 1). */
export const AIRCRAFT_MODELS: readonly AircraftModelSpec[] = [
  /* 1 */ model("Airbus A319", 33.84, 35.8, narrowbody),
  /* 2 */ model("Airbus A320", 37.57, 35.8, narrowbody),
  /* 3 */ model("Airbus A321", 44.51, 35.8, narrowbody),
  /* 4 */ model("Boeing 737-700", 33.6, 35.9, boeing737),
  /* 5 */ model("Boeing 737-800", 39.5, 35.9, boeing737),
  /* 6 */ model("Boeing 737-900", 42.1, 35.9, boeing737),
  /* 7 */ model("Airbus A220", 38.7, 35.1, narrowbody, {
    fuselageWidthM: 3.7,
    fuselageHeightM: 3.7,
    wing: { ...narrowbody.wing, rootChordM: 5.6, wingletM: 0 },
    engines: { ...narrowbody.engines, diameterM: 2.15, lengthM: 4.0 },
  }),
  /* 8 */ model("Embraer E175", 31.68, 26.0, regionalJet, {
    fuselageWidthM: 3.0,
    engines: { ...regionalJet.engines, diameterM: 1.5, lengthM: 3.5 },
  }),
  /* 9 */ model("Embraer E190/E195", 37.5, 28.72, regionalJet),
  /* 10 */ model("Bombardier CRJ", 33.0, 24.0, rearJet),
  /* 11 */ model("ATR 72", 27.17, 27.05, highWingTurboprop),
  /* 12 */ model("ATR 42", 22.67, 24.57, highWingTurboprop, {
    engines: { ...highWingTurboprop.engines, diameterM: 3.6 },
  }),
  /* 13 */ model("De Havilland Dash 8", 32.83, 28.42, highWingTurboprop, {
    fuselageWidthM: 2.7,
    tail: { kind: "t", finHeightM: 5.1, spanM: 8.8 },
    engines: { ...highWingTurboprop.engines, diameterM: 4.1, lengthM: 5.6, spanShare: [0.29] },
  }),
  /* 14 */ model("Boeing 777", 73.9, 64.8, widebodyTwin, {
    engines: { ...widebodyTwin.engines, diameterM: 3.9, lengthM: 7.3 },
  }),
  /* 15 */ model("Boeing 787", 62.8, 60.1, widebodyTwin, {
    fuselageWidthM: 5.77,
    fuselageHeightM: 5.97,
    wing: { ...widebodyTwin.wing, rootChordM: 11.0 },
    tail: { kind: "low", finHeightM: 8.6, spanM: 19.5 },
    engines: { ...widebodyTwin.engines, diameterM: 3.3, lengthM: 5.6 },
  }),
  /* 16 */ model("Airbus A330", 63.66, 60.3, widebodyTwin, {
    fuselageWidthM: 5.64,
    fuselageHeightM: 5.64,
    wing: { ...widebodyTwin.wing, sweepDeg: 31, rootChordM: 10.6, wingletM: 2.7 },
    tail: { kind: "low", finHeightM: 9.0, spanM: 19.4 },
    engines: { ...widebodyTwin.engines, diameterM: 3.0, lengthM: 5.6, spanShare: [0.33] },
  }),
  /* 17 */ model("Airbus A350", 66.8, 64.75, widebodyTwin, {
    fuselageWidthM: 5.96,
    fuselageHeightM: 6.09,
    wing: { ...widebodyTwin.wing, rootChordM: 12.0, wingletM: 1.6 },
    tail: { kind: "low", finHeightM: 9.3, spanM: 19.5 },
    engines: { ...widebodyTwin.engines, diameterM: 3.4, lengthM: 5.8 },
  }),
  /* 18 */ model("Airbus A380", 72.72, 79.75, widebodyTwin, {
    fuselageWidthM: 7.14,
    fuselageHeightM: 8.41,
    wing: { ...widebodyTwin.wing, sweepDeg: 35, rootChordM: 17.7, taper: 0.2, wingletM: 1.4 },
    tail: { kind: "low", finHeightM: 13.0, spanM: 30.4 },
    engines: {
      count: 4,
      mount: "wing",
      kind: "jet",
      diameterM: 3.3,
      lengthM: 6.5,
      spanShare: [0.33, 0.62],
    },
  }),
  /* 19 */ model("Boeing 747", 70.66, 64.44, widebodyTwin, {
    fuselageWidthM: 6.5,
    fuselageHeightM: 6.6,
    humpShare: 0.32,
    wing: { ...widebodyTwin.wing, sweepDeg: 39, rootChordM: 14.8, wingletM: 1.8 },
    tail: { kind: "low", finHeightM: 10.0, spanM: 22.2 },
    engines: {
      count: 4,
      mount: "wing",
      kind: "jet",
      diameterM: 2.9,
      lengthM: 5.8,
      spanShare: [0.4, 0.68],
    },
  }),
  /* 20 */ model("Boeing 757", 47.32, 38.05, narrowbody, {
    fuselageWidthM: 3.76,
    fuselageHeightM: 4.01,
    wing: { ...narrowbody.wing, rootChordM: 7.5, wingletM: 0 },
    tail: { kind: "low", finHeightM: 7.0, spanM: 15.2 },
    engines: { ...narrowbody.engines, diameterM: 2.6, lengthM: 5.0, spanShare: [0.33] },
  }),
  /* 21 */ model("Boeing 767", 54.94, 47.57, widebodyTwin, {
    fuselageWidthM: 5.03,
    fuselageHeightM: 5.41,
    wing: { ...widebodyTwin.wing, sweepDeg: 32, rootChordM: 8.6 },
    tail: { kind: "low", finHeightM: 8.0, spanM: 18.6 },
    engines: { ...widebodyTwin.engines, diameterM: 2.8, lengthM: 5.0, spanShare: [0.33] },
  }),
  /* 22 */ model("Airbus A300/A310", 54.08, 44.84, widebodyTwin, {
    fuselageWidthM: 5.64,
    fuselageHeightM: 5.64,
    wing: { ...widebodyTwin.wing, sweepDeg: 29, rootChordM: 9.0 },
    tail: { kind: "low", finHeightM: 8.2, spanM: 16.3 },
    engines: { ...widebodyTwin.engines, diameterM: 2.8, lengthM: 5.2 },
  }),
  /* 23 */ model("McDonnell Douglas MD-11", 61.6, 51.97, widebodyTwin, {
    fuselageWidthM: 6.02,
    fuselageHeightM: 6.02,
    wing: { ...widebodyTwin.wing, sweepDeg: 36, rootChordM: 10.7, wingletM: 2.3 },
    tail: { kind: "low", finHeightM: 8.0, spanM: 18.0 },
    engines: {
      count: 3,
      mount: "wing-tail",
      kind: "jet",
      diameterM: 2.8,
      lengthM: 5.4,
      spanShare: [0.35],
    },
  }),
  /* 24 */ model("Boeing 717 / MD-80", 40.0, 30.0, rearJet, {
    fuselageWidthM: 3.34,
    fuselageHeightM: 3.61,
    wing: { ...rearJet.wing, rootChordM: 6.0, wingletM: 0 },
    tail: { kind: "t", finHeightM: 5.5, spanM: 12.2 },
    engines: { ...rearJet.engines, diameterM: 1.75, lengthM: 4.6 },
  }),
  /* 25 */ model("Airbus A340", 68.0, 61.5, widebodyTwin, {
    fuselageWidthM: 5.64,
    fuselageHeightM: 5.64,
    wing: { ...widebodyTwin.wing, sweepDeg: 31, rootChordM: 10.6, wingletM: 2.7 },
    tail: { kind: "low", finHeightM: 9.0, spanM: 19.4 },
    engines: {
      count: 4,
      mount: "wing",
      kind: "jet",
      diameterM: 2.6,
      lengthM: 5.2,
      spanShare: [0.36, 0.64],
    },
  }),
  /* 26 */ model("Light business jet", 15.6, 16.2, bizjet),
  /* 27 */ model("Large business jet", 30.0, 28.6, bizjet, {
    fuselageWidthM: 2.6,
    fuselageHeightM: 2.6,
    wing: { ...bizjet.wing, sweepDeg: 34, rootChordM: 5.4, taper: 0.3, wingletM: 1.6 },
    tail: { kind: "t", finHeightM: 4.6, spanM: 10.0 },
    engines: { ...bizjet.engines, diameterM: 1.5, lengthM: 3.8 },
  }),
  /* 28 */ model("Single-engine high wing", 8.28, 11.0, piston),
  /* 29 */ model("Single-engine low wing", 7.6, 10.8, piston, {
    wing: { ...piston.wing, position: "low", dihedralDeg: 6 },
  }),
  /* 30 */ model("Twin turboprop", 14.2, 17.65, piston, {
    fuselageWidthM: 1.6,
    fuselageHeightM: 1.7,
    wing: {
      sweepDeg: 2,
      rootChordM: 2.3,
      taper: 0.45,
      position: "low",
      dihedralDeg: 6,
      rootShare: 0.36,
    },
    tail: { kind: "t", finHeightM: 2.6, spanM: 5.6 },
    engines: {
      count: 2,
      mount: "wing",
      kind: "prop",
      diameterM: 2.4,
      lengthM: 2.8,
      spanShare: [0.3],
    },
  }),
  /* 31 */ model("Single turboprop", 11.5, 15.9, piston, {
    fuselageWidthM: 1.6,
    fuselageHeightM: 1.8,
    engines: { count: 1, mount: "nose", kind: "prop", diameterM: 2.7, lengthM: 2.0 },
  }),
  /* 32 */ model("Lockheed C-130 Hercules", 29.79, 40.41, highWingTurboprop, {
    fuselageWidthM: 4.3,
    fuselageHeightM: 4.4,
    wing: { ...highWingTurboprop.wing, rootChordM: 4.9, taper: 0.5 },
    tail: { kind: "low", finHeightM: 6.0, spanM: 16.0 },
    engines: {
      count: 4,
      mount: "wing",
      kind: "prop",
      diameterM: 4.1,
      lengthM: 4.8,
      spanShare: [0.27, 0.53],
    },
  }),
  /* 33 */ model("Helicopter", 12.0, 11.0, piston, {
    fuselageWidthM: 1.7,
    fuselageHeightM: 2.0,
    engines: { count: 0, mount: "nose", kind: "jet", diameterM: 0, lengthM: 0 },
    tail: { kind: "low", finHeightM: 1.4, spanM: 2.2 },
    rotorM: 10.8,
  }),
  /* 34 */ model("Glider", 7.0, 18.0, piston, {
    fuselageWidthM: 0.7,
    fuselageHeightM: 0.8,
    wing: {
      sweepDeg: 0,
      rootChordM: 1.0,
      taper: 0.4,
      position: "high",
      dihedralDeg: 3,
      rootShare: 0.33,
    },
    tail: { kind: "t", finHeightM: 1.2, spanM: 2.8 },
    engines: { count: 0, mount: "nose", kind: "prop", diameterM: 0, lengthM: 0 },
  }),
  /* 35 */ model("Fighter jet", 15.0, 9.8, bizjet, {
    fuselageWidthM: 1.4,
    fuselageHeightM: 1.6,
    wing: {
      sweepDeg: 40,
      rootChordM: 5.0,
      taper: 0.25,
      position: "low",
      dihedralDeg: 0,
      rootShare: 0.38,
    },
    tail: { kind: "low", finHeightM: 3.0, spanM: 5.6 },
    engines: { count: 0, mount: "nose", kind: "jet", diameterM: 0, lengthM: 0 },
  }),
];

const byName = (name: string): number => {
  const found = AIRCRAFT_MODELS.find((m) => m.name === name);
  if (!found) throw new Error(`No aircraft model "${name}"`);
  return found.id;
};

/** ICAO type designators, grouped by the model that draws them. */
const DESIGNATORS: Record<string, string> = {
  "Airbus A319": "A318 A319 A19N",
  "Airbus A320": "A320 A20N",
  "Airbus A321": "A321 A21N",
  "Boeing 737-700": "B735 B736 B737 B37M B733 B734",
  "Boeing 737-800": "B738 B38M",
  "Boeing 737-900": "B739 B39M B3XM",
  "Airbus A220": "BCS1 BCS3",
  "Embraer E175": "E170 E75L E75S E175",
  "Embraer E190/E195": "E190 E195 E290 E295",
  "Bombardier CRJ": "CRJ1 CRJ2 CRJ7 CRJ9 CRJX",
  "ATR 72": "AT72 AT75 AT76",
  "ATR 42": "AT43 AT44 AT45 AT46",
  "De Havilland Dash 8": "DH8A DH8B DH8C DH8D",
  "Boeing 777": "B772 B773 B77L B77W B778 B779",
  "Boeing 787": "B788 B789 B78X",
  "Airbus A330": "A332 A333 A338 A339",
  "Airbus A350": "A359 A35K",
  "Airbus A380": "A388",
  "Boeing 747": "B741 B742 B743 B744 B748 B74S",
  "Boeing 757": "B752 B753",
  "Boeing 767": "B762 B763 B764",
  "Airbus A300/A310": "A306 A30B A310",
  "McDonnell Douglas MD-11": "MD11 DC10",
  "Boeing 717 / MD-80": "B712 MD81 MD82 MD83 MD87 MD88 MD90 DC93 DC95",
  "Airbus A340": "A342 A343 A345 A346",
  "Light business jet":
    "C25A C25B C25C C25M C500 C510 C525 C550 C560 C56X E50P E55P LJ35 LJ40 LJ45 LJ60 LJ75 PC24 HDJT SF50 BE40 PRM1",
  "Large business jet":
    "C650 C680 C68A C700 C750 CL30 CL35 CL60 GLEX GL5T GL7T GLF4 GLF5 GLF6 G280 F900 F2TH FA7X FA8X FA50 E545 E550 H25B",
  "Single-engine high wing":
    "C150 C152 C170 C172 C177 C180 C182 C185 C206 C210 P210 A210 CH60 DHC2",
  "Single-engine low wing":
    "P28A P28B P28R P32R PA46 SR20 SR22 S22T DA40 BE33 BE35 BE36 M20P M20T TB20 TBM7 TBM8 TBM9 DV20 RV7 RV8",
  "Twin turboprop":
    "BE20 BE30 B350 BE9L BE10 PA31 PA34 C340 C414 C421 DA42 DA62 BE58 DHC6 PAY2 P180 SW4",
  "Single turboprop": "C208 PC12 KODI C27J",
  "Lockheed C-130 Hercules": "C130 C30J A400",
  Helicopter:
    "EC20 EC30 EC35 EC45 EC55 EC75 H160 AS32 AS50 AS55 AS65 A109 A119 A139 A169 A189 B06 B407 B412 B429 B505 R22 R44 R66 S76 S92 H60 H500 NH90 MI8 BK17 EH10",
  Glider: "GLID ASK21 DG1T",
  "Fighter jet": "F16 F15 F18 F35 EUFI RFAL TOR GRIF M2000 HAWK T38 L39 PC21 A10",
};

const TYPE_TO_MODEL = new Map<string, number>();
for (const [name, codes] of Object.entries(DESIGNATORS)) {
  const id = byName(name);
  for (const code of codes.split(" ")) TYPE_TO_MODEL.set(code, id);
}

/** The model for an ICAO type designator such as "A20N" or "B738"; 0 when not known. */
export function aircraftModelForType(typeCode: string | undefined | null): number {
  if (!typeCode) return 0;
  return TYPE_TO_MODEL.get(typeCode.trim().toUpperCase()) ?? 0;
}

/** A stand-in for an aircraft whose type is not known, by its ADS-B category. */
export function genericAircraftModel(category: number): number {
  switch (category) {
    case AircraftCategory.Light:
      return byName("Single-engine high wing");
    case AircraftCategory.Medium:
      return byName("Embraer E175");
    case AircraftCategory.Heavy:
      return byName("Boeing 777");
    case AircraftCategory.HighPerformance:
      return byName("Fighter jet");
    case AircraftCategory.Rotorcraft:
      return byName("Helicopter");
    case AircraftCategory.Glider:
      return byName("Glider");
    case AircraftCategory.Uav:
      return byName("Single-engine low wing");
    default:
      return byName("Airbus A320");
  }
}

export function aircraftModel(id: number): AircraftModelSpec | undefined {
  return AIRCRAFT_MODELS[id - 1];
}
