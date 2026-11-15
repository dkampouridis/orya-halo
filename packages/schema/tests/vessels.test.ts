import { describe, expect, test } from "vite-plus/test";
import {
  FIRST_OPERATOR_SCHEME,
  ShipCategory,
  VESSEL_MODELS,
  VESSEL_SCHEMES,
  VesselModel,
  genericVesselModel,
  isCarCarrierName,
  shipValue,
  shipValueFor,
  splitShipValue,
  vesselModel,
  vesselModelFor,
  vesselScheme,
  vesselSchemeFor,
  vesselSchemeModel,
} from "../src/index.ts";

const { Cargo, Tanker, Passenger, Fishing, Service, HighSpeed, Pleasure, Military, Other } =
  ShipCategory;

const schemeName = (name: string, category: number, lengthM = 300): string =>
  vesselScheme(vesselSchemeFor({ name, category, lengthM }).scheme).name;

describe("vessel models", () => {
  test("ids are their place in the list and fit the value's four bits", () => {
    VESSEL_MODELS.forEach((m, i) => expect(m.id).toBe(i + 1));
    expect(VESSEL_MODELS.length).toBeLessThan(16);
    for (const id of Object.values(VesselModel)) {
      if (id !== VesselModel.Unknown) expect(vesselModel(id)?.id).toBe(id);
    }
  });

  test("the finer AIS ship types come before the category", () => {
    const at = (typeName: string, category: number, lengthM = 30): number =>
      vesselModelFor({ category, typeName, lengthM });
    expect(at("Tug", Service)).toBe(VesselModel.Tug);
    expect(at("Towing vessel", Service)).toBe(VesselModel.Tug);
    expect(at("Pilot vessel", Service, 18)).toBe(VesselModel.PilotBoat);
    expect(at("Port tender", Service)).toBe(VesselModel.PilotBoat);
    expect(at("Law enforcement", Service, 90)).toBe(VesselModel.Patrol);
    expect(at("Search and rescue vessel", Service, 14)).toBe(VesselModel.PilotBoat);
    expect(at("Sailing vessel", Pleasure, 12)).toBe(VesselModel.SailingYacht);
    expect(at("Pleasure craft", Pleasure, 35)).toBe(VesselModel.MotorYacht);
    expect(at("Fishing vessel", Fishing)).toBe(VesselModel.Fishing);
    expect(at("High-speed craft", HighSpeed, 70)).toBe(VesselModel.Ferry);
    expect(at("Dredger or underwater operations", Other, 90)).toBe(VesselModel.Generic);
  });

  test("cargo ships are told apart by name, then by their proportions", () => {
    const cargo = (lengthM: number, beamM: number, name = "SOME SHIP"): number =>
      vesselModelFor({ category: Cargo, lengthM, beamM, name });
    expect(cargo(90, 14)).toBe(VesselModel.GeneralCargo);
    // A Panamax container ship is long and slim; a Kamsarmax bulk carrier is not.
    expect(cargo(294, 32)).toBe(VesselModel.Container);
    expect(cargo(229, 32)).toBe(VesselModel.Bulk);
    expect(cargo(180, 30)).toBe(VesselModel.Bulk);
    // The largest container ships are wide, but no capesize is that long.
    expect(cargo(400, 61)).toBe(VesselModel.Container);
    expect(cargo(292, 45)).toBe(VesselModel.Bulk);
    // No dimensions yet.
    expect(vesselModelFor({ category: Cargo })).toBe(VesselModel.GeneralCargo);
    // Car carriers by their fleets' names.
    expect(cargo(200, 32, "AURIGA LEADER")).toBe(VesselModel.CarCarrier);
    expect(cargo(200, 32, "DRIVE GREEN HIGHWAY")).toBe(VesselModel.CarCarrier);
    expect(cargo(200, 32, "HOEGH TARGET")).toBe(VesselModel.CarCarrier);
    // Too small to be a car carrier, whatever its name.
    expect(cargo(80, 13, "TEAM LEADER")).toBe(VesselModel.GeneralCargo);
  });

  test("the other categories", () => {
    expect(vesselModelFor({ category: Tanker, lengthM: 180 })).toBe(VesselModel.Tanker);
    expect(vesselModelFor({ category: Passenger, lengthM: 290 })).toBe(VesselModel.Cruise);
    expect(vesselModelFor({ category: Passenger, lengthM: 190 })).toBe(VesselModel.Ferry);
    expect(vesselModelFor({ category: Service, lengthM: 32 })).toBe(VesselModel.Tug);
    expect(vesselModelFor({ category: Service, lengthM: 80 })).toBe(VesselModel.Generic);
    expect(vesselModelFor({ category: Pleasure, lengthM: 12 })).toBe(VesselModel.SailingYacht);
    expect(vesselModelFor({ category: Military, lengthM: 130 })).toBe(VesselModel.Patrol);
    expect(vesselModelFor({ category: ShipCategory.Unknown })).toBe(VesselModel.Unknown);
    expect(genericVesselModel(ShipCategory.Unknown)).toBe(VesselModel.Generic);
    expect(genericVesselModel(Tanker)).toBe(VesselModel.Tanker);
  });

  test("car carrier names need the whole word", () => {
    expect(isCarCarrierName("MORNING ACE")).toBe(true);
    expect(isCarCarrierName("PALACE")).toBe(false);
    expect(isCarCarrierName("LEADERSHIP")).toBe(false);
    expect(isCarCarrierName("hoegh  trigger")).toBe(true);
  });
});

describe("vessel colour schemes", () => {
  test("ids are their place in the list, the types come first, and all fit six bits", () => {
    VESSEL_SCHEMES.forEach((s, i) => expect(s.id).toBe(i));
    expect(VESSEL_SCHEMES.length).toBeLessThanOrEqual(64);
    for (const m of VESSEL_MODELS) expect(VESSEL_SCHEMES[m.id].name).toBe(m.name);
    expect(VESSEL_SCHEMES[FIRST_OPERATOR_SCHEME - 1].name).toBe("Spare");
    for (const s of VESSEL_SCHEMES) {
      for (const c of [s.hull, s.deck, s.superstructure, s.funnel, s.accent])
        expect(c).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  test("container lines by the start of the name", () => {
    expect(schemeName("MAERSK ESSEN", Cargo)).toBe("Maersk");
    expect(schemeName("EMMA MAERSK", Cargo)).toBe("Maersk");
    expect(schemeName("MSC GULSUN", Cargo)).toBe("MSC");
    expect(schemeName("CMA CGM JACQUES SAADE", Cargo)).toBe("CMA CGM");
    expect(schemeName("COSCO SHIPPING UNIVERSE", Cargo)).toBe("COSCO");
    expect(schemeName("EVER GIVEN", Cargo)).toBe("Evergreen");
    expect(schemeName("YM WITNESS", Cargo)).toBe("Yang Ming");
    expect(schemeName("HMM ALGECIRAS", Cargo)).toBe("HMM");
    expect(schemeName("ONE APUS", Cargo)).toBe("ONE");
    expect(schemeName("ZIM SAMMY OFER", Cargo)).toBe("ZIM");
    // Punctuation and case do not matter.
    expect(schemeName("msc  gülsün", Cargo)).toBe("MSC");
    expect(schemeName("Ever-Given", Cargo)).toBe("Evergreen");
  });

  test("no false positives from names that only contain an operator's letters", () => {
    expect(schemeName("ATLANTIC MSC", Cargo)).toBe("Unknown");
    expect(schemeName("MSCL PRIDE", Cargo)).toBe("Unknown");
    expect(schemeName("EVEREST SPIRIT", Cargo)).toBe("Unknown");
    expect(schemeName("EVERGLADES", Cargo)).toBe("Unknown");
    expect(schemeName("YMIR", Cargo)).toBe("Unknown");
    expect(schemeName("ONEGA", Cargo)).toBe("Unknown");
    expect(schemeName("ZIMBABWE STAR", Cargo)).toBe("Unknown");
    expect(schemeName("HMMS VALIANT", Cargo)).toBe("Unknown");
    expect(schemeName("MAERSKLINE", Cargo)).toBe("Unknown");
    expect(schemeName("COSTAL TRADER", Passenger)).toBe("Unknown");
    // "ONE" is a word: a small cargo ship called "ONE …" is not the line's.
    expect(schemeName("ONE LOVE", Cargo, 60)).toBe("Unknown");
  });

  test("a name is only trusted in the category its fleet sails in", () => {
    // Maersk's tankers and supply ships, and an MSC-named tug, are not the container line.
    expect(schemeName("MAERSK TANGIER", Tanker)).toBe("Unknown");
    expect(schemeName("MAERSK HANDLER", Service, 70)).toBe("Unknown");
    // MSC's cruise ships have their own colours.
    expect(schemeName("MSC WORLD EUROPA", Passenger)).toBe("MSC Cruises");
  });

  test("cruise lines and ferries", () => {
    expect(schemeName("CARNIVAL JUBILEE", Passenger)).toBe("Carnival");
    expect(schemeName("WONDER OF THE SEAS", Passenger)).toBe("Royal Caribbean");
    expect(schemeName("COSTA SMERALDA", Passenger)).toBe("Costa");
    expect(schemeName("NIEUW STATENDAM", Passenger)).toBe("Holland America");
    expect(schemeName("ROTTERDAM", Passenger)).toBe("Holland America");
    // A small Dutch ferry ending in "DAM" is not Holland America's.
    expect(schemeName("SCHIEDAM", Passenger, 60)).toBe("Unknown");
    expect(schemeName("QUEEN MARY 2", Passenger)).toBe("Cunard");
    expect(schemeName("VIKING GRACE", Passenger, 218)).toBe("Viking Line");
    // Viking's ocean cruise ships share the prefix, not the colours.
    expect(schemeName("VIKING STAR", Passenger, 228)).toBe("Unknown");
    expect(schemeName("CROWN SEAWAYS", Passenger, 170)).toBe("DFDS");
  });

  test("each scheme belongs on a model", () => {
    const on = (name: string): number => {
      const scheme = VESSEL_SCHEMES.find((s) => s.name === name);
      if (!scheme) throw new Error(name);
      return vesselSchemeModel(scheme.id);
    };
    expect(on("Tanker")).toBe(VesselModel.Tanker);
    expect(on("Unknown")).toBe(VesselModel.Generic);
    expect(on("Maersk")).toBe(VesselModel.Container);
    expect(on("Carnival")).toBe(VesselModel.Cruise);
    expect(on("Viking Line")).toBe(VesselModel.Ferry);
    expect(on("Höegh Autoliners")).toBe(VesselModel.CarCarrier);
    expect(on("Coast guard")).toBe(VesselModel.Patrol);
    expect(on("Research vessel")).toBe(VesselModel.Generic);
  });

  test("roles from the name or the AIS type", () => {
    expect(schemeName("USCGC HEALY", Other, 128)).toBe("Coast guard");
    expect(schemeName("CCGS AMUNDSEN", Other, 98)).toBe("Canadian Coast Guard");
    expect(schemeName("RV SONNE", Other, 116)).toBe("Research vessel");
    expect(schemeName("R/V ATLANTIS", Other, 83)).toBe("Research vessel");
    const role = (typeName: string, category: number): string =>
      vesselScheme(vesselSchemeFor({ category, typeName }).scheme).name;
    expect(role("Law enforcement", Service)).toBe("Coast guard");
    expect(role("Search and rescue vessel", Service)).toBe("Search and rescue");
    expect(role("Military", Military)).toBe("Military");
    expect(role("Tug", Service)).toBe("Unknown");
  });
});

describe("ship values", () => {
  test("round-trip every field and stay an exact float32", () => {
    const cases = [
      { lengthM: 400, beamM: 61, model: VesselModel.Container, scheme: 63 },
      { lengthM: 510, beamM: 63, model: VesselModel.Generic, scheme: 63 },
      { lengthM: 12, beamM: 4, model: VesselModel.SailingYacht, scheme: 0 },
      { lengthM: 0, beamM: 0, model: VesselModel.Unknown, scheme: 0 },
    ];
    for (const c of cases) {
      const v = shipValue(c);
      expect(Math.fround(v)).toBe(v);
      expect(v).toBeLessThan(2 ** 24);
      expect(splitShipValue(v)).toEqual(c);
      expect(splitShipValue(new Float32Array([v])[0])).toEqual(c);
    }
  });

  test("length goes in 2 m steps; out-of-range fields are clamped", () => {
    expect(splitShipValue(shipValue({ lengthM: 183, beamM: 0, model: 0, scheme: 0 })).lengthM).toBe(
      184,
    );
    const big = splitShipValue(
      shipValue({ lengthM: 900, beamM: 99, model: 99 as VesselModel, scheme: 99 }),
    );
    expect(big).toEqual({ lengthM: 510, beamM: 63, model: 15, scheme: 63 });
    expect(splitShipValue(Number.NaN).lengthM).toBe(0);
    expect(splitShipValue(-5)).toEqual({ lengthM: 0, beamM: 0, model: 0, scheme: 0 });
  });

  test("shipValueFor puts it all together", () => {
    const v = splitShipValue(
      shipValueFor({ category: Cargo, name: "EVER GIVEN", lengthM: 400, beamM: 59 }),
    );
    expect(v.model).toBe(VesselModel.Container);
    expect(vesselScheme(v.scheme).name).toBe("Evergreen");
    expect(v.lengthM).toBe(400);
    expect(v.beamM).toBe(59);
    // A short "MSC" ship is still a container ship: the line's name says so.
    const feeder = splitShipValue(shipValueFor({ category: Cargo, name: "MSC ROSA", lengthM: 98 }));
    expect(feeder.model).toBe(VesselModel.Container);
    const tanker = splitShipValue(shipValueFor({ category: Tanker, lengthM: 250, beamM: 44 }));
    expect(tanker).toEqual({ lengthM: 250, beamM: 44, model: VesselModel.Tanker, scheme: 0 });
  });
});
