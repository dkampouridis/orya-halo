import { describe, expect, test } from "vite-plus/test";
import {
  AIRCRAFT_MODELS,
  AircraftCategory,
  aircraftModel,
  aircraftModelForType,
  genericAircraftModel,
} from "../src/index.ts";

const nameOf = (code: string): string | undefined =>
  aircraftModel(aircraftModelForType(code))?.name;

describe("aircraft models", () => {
  test("ids are their place in the list, and names are unique", () => {
    AIRCRAFT_MODELS.forEach((m, i) => expect(m.id).toBe(i + 1));
    expect(new Set(AIRCRAFT_MODELS.map((m) => m.name)).size).toBe(AIRCRAFT_MODELS.length);
    // The id travels in one byte of the render batch.
    expect(AIRCRAFT_MODELS.length).toBeLessThan(256);
  });

  test("common types map to their own models", () => {
    expect(nameOf("A20N")).toBe("Airbus A320");
    expect(nameOf("B738")).toBe("Boeing 737-800");
    expect(nameOf("B38M")).toBe("Boeing 737-800");
    expect(nameOf("B77W")).toBe("Boeing 777");
    expect(nameOf("A388")).toBe("Airbus A380");
    expect(nameOf("B789")).toBe("Boeing 787");
    expect(nameOf("AT76")).toBe("ATR 72");
    expect(nameOf("C172")).toBe("Single-engine high wing");
    expect(nameOf("EC35")).toBe("Helicopter");
  });

  test("designators are read leniently, and unknown ones are 0", () => {
    expect(nameOf(" a20n ")).toBe("Airbus A320");
    expect(aircraftModelForType("ZZZZ")).toBe(0);
    expect(aircraftModelForType("")).toBe(0);
    expect(aircraftModelForType(undefined)).toBe(0);
  });

  test("every ADS-B category has a stand-in", () => {
    for (const category of Object.values(AircraftCategory)) {
      expect(aircraftModel(genericAircraftModel(category))).toBeDefined();
    }
    expect(aircraftModel(genericAircraftModel(AircraftCategory.Heavy))?.name).toBe("Boeing 777");
    expect(aircraftModel(genericAircraftModel(AircraftCategory.Rotorcraft))?.name).toBe(
      "Helicopter",
    );
  });

  test("dimensions are physically plausible", () => {
    for (const m of AIRCRAFT_MODELS) {
      expect(m.lengthM, m.name).toBeGreaterThan(5);
      expect(m.lengthM, m.name).toBeLessThan(90);
      expect(m.spanM, m.name).toBeGreaterThan(5);
      expect(m.fuselageWidthM, m.name).toBeLessThan(m.lengthM / 4);
      expect(m.wing.rootChordM, m.name).toBeLessThan(m.lengthM / 2);
      for (const share of m.engines.spanShare ?? []) expect(share, m.name).toBeLessThan(0.8);
    }
  });
});
