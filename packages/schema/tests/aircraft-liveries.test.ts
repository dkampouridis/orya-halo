import { describe, expect, test } from "vite-plus/test";
import {
  AIRCRAFT_LIVERIES,
  AIRCRAFT_MODELS,
  NEUTRAL_LIVERY,
  aircraftLivery,
  aircraftLiveryForCallsign,
  aircraftValue,
  airlineOfCallsign,
  liveryMark,
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
      for (const c of [l.top, l.belly, l.tail, l.engines, l.accent?.color, l.nose, l.rear?.color]) {
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
      if (l.rear) {
        // Past the tail cone, and well short of the nose: it is the fin's colour carried forward.
        expect(l.rear.to).toBeGreaterThan(0);
        expect(l.rear.to).toBeLessThan(0.5);
      }
    }
  });

  test("each airline's mark is its first coloured paint", () => {
    const byName = (name: string) => {
      const l = AIRCRAFT_LIVERIES.find((s) => s.name === name);
      if (!l) throw new Error(name);
      return l;
    };
    // White aircraft are known by the fin.
    expect(liveryMark(byName("easyJet"))).toBe("#ff6600");
    expect(liveryMark(byName("Wizz Air"))).toBe("#c6007e");
    expect(liveryMark(byName("Lufthansa"))).toBe("#05164d");
    // Painted all over: the fuselage colour, however pale.
    expect(liveryMark(byName("KLM"))).toBe("#00a1de");
    expect(liveryMark(byName("Korean Air"))).toBe("#a7d5ee");
    expect(liveryMark(byName("DHL"))).toBe("#ffcc00");
    // A white fin: its second colour. A grey one: the engines.
    expect(liveryMark(byName("Air France"))).toBe("#002157");
    expect(liveryMark(byName("Vueling"))).toBe("#ffcc00");
    // Only white, grey and black: no mark.
    expect(liveryMark(byName("Air Canada"))).toBeNull();
    expect(liveryMark(NEUTRAL_LIVERY)).toBeNull();
    // Every scheme with any colour at all has one.
    for (const l of AIRCRAFT_LIVERIES.slice(1)) {
      const mark = liveryMark(l);
      if (mark)
        expect([l.top, l.tail, l.accent?.color, l.rear?.color, l.belly, l.engines]).toContain(mark);
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
    expect(nameFor("UAE34E")).toBe("Emirates");
    expect(nameFor("PGT81UD")).toBe("Pegasus");
    expect(nameFor("TKJ1569")).toBe("AJet");
    // A regional flown in its parent airline's colours.
    expect(nameFor("ENY3456")).toBe("American Airlines");
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
