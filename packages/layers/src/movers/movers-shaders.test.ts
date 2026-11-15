import { AIRCRAFT_LIVERIES, liveryMark } from "@orya-halo/schema";
import { describe, expect, it } from "vite-plus/test";
import { hexToRgb, rgbDistance, rgbToOklch } from "../aircraft/livery-colour.ts";
import type { Rgb } from "../aircraft/livery-colour.ts";
import {
  AIRLINE_MARKS,
  GLYPH_SCALE,
  MARK_CYAN_DISTANCE,
  glyphMarkColour,
  moverGlyphScale,
  moversFS,
  moversVS,
} from "./movers-shaders.ts";

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

  const markOf = (name: string): Rgb => {
    const mark = AIRLINE_MARKS[AIRCRAFT_LIVERIES.findIndex((l) => l.name === name)];
    if (!mark) throw new Error(`no mark for ${name}`);
    return mark;
  };

  it("keeps each mark's hue and lifts dark ones to show on a dark map", () => {
    // Navy #05164d: lighter, the same hue.
    const navy = hexToRgb("#05164d");
    const lufthansa = markOf("Lufthansa");
    expect(rgbToOklch(lufthansa)[0]).toBeGreaterThan(rgbToOklch(navy)[0] + 0.15);
    expect(rgbToOklch(lufthansa)[2]).toBeCloseTo(rgbToOklch(navy)[2], 1);
    for (const m of AIRLINE_MARKS) {
      if (m) for (const v of m) expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("keeps maroon a maroon and dark blues apart", () => {
    // Qatar's maroon stays clear of Wizz Air's magenta and Eurowings' raspberry.
    const qatar = markOf("Qatar Airways");
    expect(rgbDistance(qatar, markOf("Wizz Air"))).toBeGreaterThan(0.25);
    expect(rgbDistance(qatar, markOf("Eurowings"))).toBeGreaterThan(0.15);
    // Navy stays darker than royal blue.
    expect(rgbToOklch(markOf("Lufthansa"))[0]).toBeLessThan(rgbToOklch(markOf("Ryanair"))[0]);
  });

  it("keeps every mark clear of the aircraft layer's cyan", () => {
    const cyan = hexToRgb("#4fe3ff");
    for (const m of AIRLINE_MARKS)
      if (m) expect(rgbDistance(m, cyan)).toBeGreaterThanOrEqual(MARK_CYAN_DISTANCE - 1e-3);
    // The light blues that were next to it are darkened, not lifted.
    for (const name of ["TUI", "KLM", "Luxair"]) {
      const l = AIRCRAFT_LIVERIES.find((s) => s.name === name);
      const hex = l && liveryMark(l);
      if (!hex) throw new Error(name);
      expect(rgbToOklch(glyphMarkColour(hex))[0]).toBeLessThan(rgbToOklch(hexToRgb(hex))[0]);
    }
  });

  it("paints the rear half, tailplane included, and names the emergency ring apart", () => {
    expect(moversFS).toContain("const float MARK_FROM = -0.1;");
    expect(moversFS).toContain("float alarm = max(ring, steady);");
  });
});
