import { AIRCRAFT_LIVERIES, liveryMark } from "@orya-halo/schema";
import { describe, expect, it } from "vite-plus/test";
import { AIRLINE_MARKS, GLYPH_SCALE, moverGlyphScale, moversVS } from "./movers-shaders.ts";

describe("moverGlyphScale", () => {
  it("sizes aircraft and satellites by category", () => {
    expect(moverGlyphScale("aircraft", 4, 0)).toBe(1.22); // heavy
    expect(moverGlyphScale("aircraft", 1, 0)).toBe(0.7); // light
    expect(moverGlyphScale("satellite", 1, 0)).toBe(1.9); // station
    expect(moverGlyphScale("satellite", 7, 0)).toBe(0.5); // debris
  });

  it("sizes ships by length when it is known, by category when not", () => {
    const lengthByte = (m: number) => Math.round((m / 400) * 255);
    expect(moverGlyphScale("ship", 1, lengthByte(150))).toBeCloseTo(1, 1);
    // Never smaller or larger than the symbol range, however short or long.
    expect(moverGlyphScale("ship", 7, lengthByte(8))).toBe(0.55);
    expect(moverGlyphScale("ship", 1, 255)).toBe(1.5);
    expect(moverGlyphScale("ship", 2, 0)).toBe(GLYPH_SCALE.ship[2]);
  });

  it("treats an unknown category as the last known one rather than failing", () => {
    expect(moverGlyphScale("aircraft", 200, 0)).toBe(GLYPH_SCALE.aircraft.at(-1));
    expect(moverGlyphScale("satellite", -3, 0)).toBe(GLYPH_SCALE.satellite[0]);
  });

  it("hands the shader the same tables", () => {
    expect(moversVS).toContain(
      `float AIRCRAFT_SCALE[10] = float[10](0.950, 0.700, 0.880, 1.000, 1.220`,
    );
    expect(moversVS).toContain(`float SATELLITE_SCALE[8] = float[8](0.900, 1.900`);
  });
});

describe("AIRLINE_MARKS", () => {
  it("has an entry for every colour scheme, in id order, and the shader the same table", () => {
    expect(AIRLINE_MARKS.length).toBe(AIRCRAFT_LIVERIES.length);
    expect(moversVS).toContain(`vec4 AIRLINE_MARK[${AIRCRAFT_LIVERIES.length}]`);
  });

  it("leaves unknown airlines and colourless schemes in the layer colour", () => {
    expect(AIRLINE_MARKS[0]).toBeNull();
    AIRCRAFT_LIVERIES.forEach((l, i) => {
      if (i > 0) expect(AIRLINE_MARKS[i] === null).toBe(liveryMark(l) === null);
    });
  });

  it("keeps each mark's hue and brightens dark ones to show on a dark map", () => {
    const lufthansa = AIRCRAFT_LIVERIES.findIndex((l) => l.name === "Lufthansa");
    const mark = AIRLINE_MARKS[lufthansa];
    if (!mark) throw new Error("no mark");
    // Navy #05164d: brighter, still blue, channels in the same proportion.
    expect(Math.max(...mark)).toBeCloseTo(0.82, 5);
    expect(mark[2]).toBeGreaterThan(mark[1]);
    expect(mark[0] / mark[2]).toBeCloseTo(0x05 / 0x4d, 5);
    for (const m of AIRLINE_MARKS) {
      if (m) for (const v of m) expect(v).toBeLessThanOrEqual(1);
    }
  });
});
