/**
 * Edge cases of the ship rules and the ship batch value: the limits of each
 * packed field, float32 exactness, inputs no feed should send but one may,
 * the gateway's type names (shared table with the Rust tests), and naming
 * rules that must not fire.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  ShipCategory,
  VESSEL_MODELS,
  VESSEL_SCHEMES,
  VesselModel,
  aircraftValue,
  genericVesselModel,
  isCarCarrierName,
  normaliseShipName,
  shipValue,
  shipValueFor,
  splitAircraftValue,
  splitShipValue,
  vesselModel,
  vesselModelFor,
  vesselScheme,
  vesselSchemeFor,
} from "../src/index.ts";

const { Cargo, Tanker, Passenger, Service } = ShipCategory;

interface TypeRow {
  from: number;
  to: number;
  typeName: string;
  category: number;
  model: keyof typeof VesselModel;
}

const AIS_TYPES = (
  JSON.parse(readFileSync(new URL("fixtures/ais-ship-types.json", import.meta.url), "utf8")) as {
    types: TypeRow[];
  }
).types;

const schemeOf = (name: string, category: number, lengthM = 300): string =>
  vesselScheme(vesselSchemeFor({ name, category, lengthM }).scheme).name;

/** What `schemeOf` says when no operator or role matched: scheme 0. */
const NO_SCHEME = vesselScheme(0).name;

describe("ship value limits", () => {
  test("every field at its maximum is 2^24 - 1, still an exact float32", () => {
    const max = shipValue({ lengthM: 510, beamM: 63, model: 15 as VesselModel, scheme: 63 });
    expect(max).toBe(2 ** 24 - 1);
    expect(Math.fround(max)).toBe(max);
    expect(splitShipValue(max)).toEqual({ lengthM: 510, beamM: 63, model: 15, scheme: 63 });
  });

  test("every packed value survives a Float32Array, field by field", () => {
    const f32 = new Float32Array(1);
    for (let length = 0; length <= 510; length += 34) {
      for (let beam = 0; beam <= 63; beam += 7) {
        for (let model = 0; model <= 15; model++) {
          for (const scheme of [0, 1, 15, 16, 31, 32, 62, 63]) {
            const v = shipValue({
              lengthM: length,
              beamM: beam,
              model: model as VesselModel,
              scheme,
            });
            f32[0] = v;
            expect(f32[0]).toBe(v);
            expect(splitShipValue(f32[0])).toEqual({ lengthM: length, beamM: beam, model, scheme });
          }
        }
      }
    }
  });

  test("lengths over 510 m and AIS's 1022 m ceiling clamp to 510 m", () => {
    for (const lengthM of [511, 600, 1022, 1e9]) {
      expect(splitShipValue(shipValue({ lengthM, beamM: 0, model: 0, scheme: 0 })).lengthM).toBe(
        510,
      );
    }
  });

  test("beams over 63 m clamp to 63 m without spilling into the model", () => {
    // AIS reports port and starboard separately, 0..63 m each, so a beam can read up to 126 m.
    for (const beamM of [64, 100, 126]) {
      const v = splitShipValue(
        shipValue({ lengthM: 400, beamM, model: VesselModel.Tanker, scheme: 5 }),
      );
      expect(v).toEqual({ lengthM: 400, beamM: 63, model: VesselModel.Tanker, scheme: 5 });
    }
  });

  test("an odd length rounds to the nearest 2 m step; under a metre it reads as unknown", () => {
    const length = (lengthM: number) =>
      splitShipValue(shipValue({ lengthM, beamM: 0, model: 0, scheme: 0 })).lengthM;
    expect(length(333)).toBe(334);
    expect(length(1)).toBe(2);
    expect(length(0.9)).toBe(0);
    expect(length(-50)).toBe(0);
  });

  test("model and scheme numbers past their bits clamp instead of overflowing", () => {
    expect(
      splitShipValue(shipValue({ lengthM: 100, beamM: 20, model: 16 as VesselModel, scheme: 64 })),
    ).toEqual({
      lengthM: 100,
      beamM: 20,
      model: 15,
      scheme: 63,
    });
    // 15 fits the four bits but names no model: the layers must fall back.
    expect(vesselModel(15)).toBeUndefined();
    expect(VESSEL_MODELS.length).toBe(14);
    expect(VESSEL_SCHEMES.length).toBeLessThanOrEqual(64);
  });

  test("values that are not a packed ship read as all unknown", () => {
    for (const value of [0, -1, -16_777_215, 2 ** 24, 2 ** 30, Number.NaN, Infinity, -Infinity]) {
      expect(splitShipValue(value)).toEqual({ lengthM: 0, beamM: 0, model: 0, scheme: 0 });
    }
    // A fraction (a value that went through arithmetic) is truncated, not rounded up into the next field.
    expect(splitShipValue(255.9).lengthM).toBe(510);
    expect(splitShipValue(255.9).beamM).toBe(0);
  });

  // A non-finite field is unknown; it must not take the fields packed beside it.
  test("a non-finite length or beam is unknown, and keeps the model and scheme", () => {
    for (const bad of [Number.NaN, Infinity]) {
      const v = shipValue({ lengthM: bad, beamM: 30, model: VesselModel.Tanker, scheme: 3 });
      expect(Number.isFinite(v)).toBe(true);
      expect(splitShipValue(v).model).toBe(VesselModel.Tanker);
      const w = shipValueFor({ category: Tanker, lengthM: 250, beamM: bad });
      expect(splitShipValue(w).model).toBe(VesselModel.Tanker);
    }
  });

  test("a ship value and an aircraft value of the same number read differently, by design", () => {
    // The kinds share one value column; only the kind says how to read it.
    const ship = shipValue({ lengthM: 200, beamM: 32, model: VesselModel.Bulk, scheme: 20 });
    expect(splitAircraftValue(ship)).toEqual({ model: 0, livery: 0 }); // above 65535: not an aircraft's
    const aircraft = aircraftValue(7, 42);
    expect(splitShipValue(aircraft).lengthM).toBe(14);
    expect(Math.fround(aircraftValue(255, 255))).toBe(65_535);
  });
});

describe("unknown kinds", () => {
  test("a category the schema does not know draws a generic vessel, never model 0", () => {
    for (const category of [10, 42, 255, -1]) {
      expect(vesselModelFor({ category })).toBe(VesselModel.Unknown);
      expect(genericVesselModel(category)).toBe(VesselModel.Generic);
      expect(splitShipValue(shipValueFor({ category, lengthM: 50 })).model).toBe(0);
    }
  });

  test("an unknown category with an unknown type name is decided by nothing else", () => {
    expect(
      vesselModelFor({ category: ShipCategory.Unknown, typeName: "Spaceship", lengthM: 300 }),
    ).toBe(VesselModel.Unknown);
  });
});

describe("the gateway's AIS type names", () => {
  test("the shared table covers each code once and only codes 20 to 99", () => {
    const seen = new Set<number>();
    for (const row of AIS_TYPES) {
      for (let code = row.from; code <= row.to; code++) {
        expect(seen.has(code)).toBe(false);
        seen.add(code);
      }
    }
    expect(Math.min(...seen)).toBe(20);
    expect(Math.max(...seen)).toBe(99);
  });

  test.each(AIS_TYPES)(
    "$typeName (category $category) draws a $model with nothing else known",
    (row) => {
      const model = vesselModelFor({ category: row.category, typeName: row.typeName });
      expect(model).toBe(VesselModel[row.model]);
      expect(model).not.toBe(VesselModel.Unknown);
      // The same through the packed value the batch carries.
      expect(
        splitShipValue(shipValueFor({ category: row.category, typeName: row.typeName })).model,
      ).toBe(VesselModel[row.model]);
    },
  );

  test("a type name decides even when the category disagrees", () => {
    // A tug reported in the cargo range by a sloppy transponder still looks like a tug.
    expect(vesselModelFor({ category: Cargo, typeName: "Tug", lengthM: 30 })).toBe(VesselModel.Tug);
    expect(vesselModelFor({ category: Passenger, typeName: "Pilot vessel" })).toBe(
      VesselModel.PilotBoat,
    );
  });

  test("type names are matched whatever their case", () => {
    expect(vesselModelFor({ category: Service, typeName: "TUG" })).toBe(VesselModel.Tug);
    expect(vesselModelFor({ category: Service, typeName: "pilot VESSEL" })).toBe(
      VesselModel.PilotBoat,
    );
  });

  test("roles from the type name get their colours", () => {
    expect(
      vesselScheme(vesselSchemeFor({ category: Service, typeName: "Law enforcement" }).scheme).name,
    ).toBe("Coast guard");
    expect(
      vesselScheme(
        vesselSchemeFor({ category: Service, typeName: "Search and rescue vessel" }).scheme,
      ).name,
    ).toBe("Search and rescue");
    expect(
      vesselScheme(
        vesselSchemeFor({ category: ShipCategory.Military, typeName: "Military" }).scheme,
      ).name,
    ).toBe("Military");
    expect(vesselSchemeFor({ category: Service, typeName: "Tug" }).scheme).toBe(0);
  });
});

describe("ship names", () => {
  test("normalising keeps letters, digits, slashes and single spaces", () => {
    expect(normaliseShipName("  maersk   essen ")).toBe("MAERSK ESSEN");
    expect(normaliseShipName("MSC-ANNA")).toBe("MSC ANNA");
    expect(normaliseShipName("R/V Atlantis")).toBe("R/V ATLANTIS");
    expect(normaliseShipName("EVER@@GIVEN@@@")).toBe("EVER GIVEN");
    expect(normaliseShipName(null)).toBe("");
    expect(normaliseShipName("@@@@")).toBe("");
  });

  test("names in lower case, with punctuation or AIS padding still match", () => {
    expect(schemeOf("msc gülsün", Cargo)).toBe("MSC");
    expect(schemeOf("MSC-ANNA", Cargo)).toBe("MSC");
    expect(schemeOf("ever given@@@@", Cargo)).toBe("Evergreen");
    expect(schemeOf("cma cgm jacques saadé", Cargo)).toBe("CMA CGM");
  });

  test("a letter with a diacritic reads as its ASCII spelling, never as a word break", () => {
    // Folded, not dropped: "ÉVER GREEN" is read exactly as "EVER GREEN" would be.
    expect(schemeOf("ÉVER GREEN", Cargo)).toBe(schemeOf("EVER GREEN", Cargo));
    expect(schemeOf("ÖNE WAY", Cargo, 300)).toBe(schemeOf("ONE WAY", Cargo, 300));
    expect(normaliseShipName("ÉVER GREEN")).toBe("EVER GREEN");
    expect(normaliseShipName("北京")).toBe("");
    expect(vesselSchemeFor({ category: Cargo, name: "北京", lengthM: 300 }).scheme).toBe(0);
  });

  // Letters with diacritics are folded to ASCII (AIS itself is 6-bit ASCII; other
  // feeds spell names properly).
  test("a name with diacritics matches as its ASCII spelling", () => {
    expect(schemeOf("HÖEGH TRAPPER", Cargo, 200)).toBe("Höegh Autoliners");
    expect(schemeOf("ESSEN MÆRSK", Cargo)).toBe("Maersk");
  });

  test("a letter with a diacritic inside a word is not a word break", () => {
    expect(isCarCarrierName("PLÜACE")).toBe(false);
  });

  test("car carrier suffixes need the whole word and a car carrier's size", () => {
    expect(isCarCarrierName("PEACE")).toBe(false);
    expect(isCarCarrierName("LEADER")).toBe(false); // the word alone, no fleet name before it
    expect(isCarCarrierName("ACE OF SPADES")).toBe(false);
    expect(isCarCarrierName("HOEGHX TARGET")).toBe(false);
    // A 90 m coaster called "… ACE" is a general cargo ship.
    expect(vesselModelFor({ category: Cargo, name: "BLUE ACE", lengthM: 90, beamM: 14 })).toBe(
      VesselModel.GeneralCargo,
    );
    // A tanker of the same name is still a tanker: the rule is for cargo ships only.
    expect(vesselModelFor({ category: Tanker, name: "PACIFIC LEADER", lengthM: 200 })).toBe(
      VesselModel.Tanker,
    );
  });

  test("operator prefixes that are ordinary words or other fleets' names do not fire", () => {
    expect(schemeOf("EVERGREEN STAR", Cargo)).toBe(NO_SCHEME);
    expect(schemeOf("ZIMBABWE", Cargo)).toBe(NO_SCHEME);
    expect(schemeOf("YMIR", Cargo)).toBe(NO_SCHEME);
    expect(schemeOf("ONE LOVE", Cargo, 40)).toBe(NO_SCHEME);
    expect(schemeOf("MSCA", Cargo)).toBe(NO_SCHEME);
    expect(schemeOf("AMAZING GRACE", Passenger, 300)).not.toBe("Viking Line");
    expect(schemeOf("VIKING SKY", Passenger, 228)).not.toBe("Viking Line");
    // Holland America's "…DAM" names need a cruise ship's length.
    expect(schemeOf("VOLENDAM", Passenger, 60)).not.toBe("Holland America");
    expect(schemeOf("VOLENDAM", Passenger, 237)).toBe("Holland America");
  });

  test("an empty or missing name falls back to the type's colours", () => {
    for (const name of ["", "   ", null, undefined]) {
      expect(vesselSchemeFor({ category: Cargo, name, lengthM: 300 }).scheme).toBe(0);
    }
  });
});
