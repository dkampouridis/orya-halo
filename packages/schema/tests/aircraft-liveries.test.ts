import { describe, expect, test } from "vite-plus/test";
import {
  AIRCRAFT_LIVERIES,
  AIRCRAFT_MODELS,
  NEUTRAL_LIVERY,
  aircraftLivery,
  aircraftLiveryForCallsign,
  aircraftValue,
  airlineOfCallsign,
  splitAircraftValue,
} from "../src/index.ts";

const nameFor = (callsign: string): string =>
  aircraftLivery(aircraftLiveryForCallsign(callsign)).name;

describe("airline colour schemes", () => {
  test("ids are their place in the list, 0 is neutral, and each fits in a byte", () => {
    AIRCRAFT_LIVERIES.forEach((l, i) => expect(l.id).toBe(i));
    expect(AIRCRAFT_LIVERIES[0]).toBe(NEUTRAL_LIVERY);
    expect(AIRCRAFT_LIVERIES.length).toBeLessThan(256);
    expect(new Set(AIRCRAFT_LIVERIES.map((l) => l.name)).size).toBe(AIRCRAFT_LIVERIES.length);
  });

  test("every designator is three letters and belongs to one scheme", () => {
    const codes = AIRCRAFT_LIVERIES.flatMap((l) => l.codes);
    for (const code of codes) expect(code).toMatch(/^[A-Z]{3}$/);
    expect(new Set(codes).size).toBe(codes.length);
  });

  test("colours are #rrggbb and the numbers are in range", () => {
    for (const l of AIRCRAFT_LIVERIES) {
      for (const c of [l.top, l.belly, l.tail, l.engines, l.accent?.color]) {
        if (c !== undefined) expect(c).toMatch(/^#[0-9a-f]{6}$/);
      }
      if (l.bellyLine !== undefined) {
        expect(l.belly).toBeDefined();
        expect(Math.abs(l.bellyLine)).toBeLessThanOrEqual(1);
      }
      if (l.accent) {
        expect(l.accent.split).toBeGreaterThan(0);
        expect(l.accent.split).toBeLessThan(1);
      }
    }
  });

  test("the airline comes from a flight callsign", () => {
    expect(airlineOfCallsign("BAW834")).toBe("BAW");
    expect(airlineOfCallsign("EZY83TD")).toBe("EZY");
    expect(airlineOfCallsign("RYR1")).toBe("RYR");
    expect(airlineOfCallsign(" aee602 ")).toBe("AEE");
    // Registrations and private callsigns are not airline flights.
    expect(airlineOfCallsign("GATYS")).toBeNull();
    expect(airlineOfCallsign("N123AB")).toBeNull();
    expect(airlineOfCallsign("DLH")).toBeNull();
    expect(airlineOfCallsign("BAW 834")).toBeNull();
    expect(airlineOfCallsign("")).toBeNull();
    expect(airlineOfCallsign(undefined)).toBeNull();
  });

  test("callsigns map to their airline's scheme, unknown ones to neutral", () => {
    expect(nameFor("RYR4TK")).toBe("Ryanair");
    expect(nameFor("RUK12")).toBe("Ryanair");
    expect(nameFor("BAW117")).toBe("British Airways");
    expect(nameFor("AEE602")).toBe("Aegean Airlines");
    expect(nameFor("DLH400")).toBe("Lufthansa");
    expect(nameFor("ZZZ123")).toBe("Neutral");
    expect(nameFor("GATYS")).toBe("Neutral");
    expect(aircraftLivery(9999)).toBe(NEUTRAL_LIVERY);
  });

  test("an aircraft's value carries its model and scheme", () => {
    for (const model of [0, 1, AIRCRAFT_MODELS.length]) {
      for (const livery of [0, 1, AIRCRAFT_LIVERIES.length - 1]) {
        const value = aircraftValue(model, livery);
        // The store keeps values as 32-bit floats.
        expect(splitAircraftValue(Math.fround(value))).toEqual({ model, livery });
      }
    }
    expect(splitAircraftValue(0)).toEqual({ model: 0, livery: 0 });
    expect(splitAircraftValue(-3)).toEqual({ model: 0, livery: 0 });
    expect(splitAircraftValue(Number.NaN)).toEqual({ model: 0, livery: 0 });
  });
});
