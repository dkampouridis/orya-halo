import { describe, expect, it } from "vite-plus/test";
import {
  GLYPH_LIFT,
  MODEL_LIFT,
  darkenColour,
  hexToRgb,
  liftColour,
  oklchToRgb,
  rgbDistance,
  rgbToOklch,
} from "./livery-colour.ts";

describe("OKLCH", () => {
  it("round-trips sRGB colours", () => {
    for (const hex of ["#05164d", "#5c0632", "#ff6600", "#00a1de", "#f3f5f7", "#1b1b1b"]) {
      const c = hexToRgb(hex);
      const back = oklchToRgb(...rgbToOklch(c));
      expect(rgbDistance(c, back)).toBeLessThan(1e-3);
    }
  });

  it("gives white a lightness of 1 and no chroma", () => {
    const [L, C] = rgbToOklch([1, 1, 1]);
    expect(L).toBeCloseTo(1, 3);
    expect(C).toBeLessThan(1e-3);
  });
});

describe("liftColour", () => {
  it("lifts lightness only: hue kept, chroma kept where the gamut allows", () => {
    for (const hex of ["#05164d", "#073590", "#00643c", "#4d148c"]) {
      const before = rgbToOklch(hexToRgb(hex));
      const after = rgbToOklch(liftColour(hexToRgb(hex), MODEL_LIFT));
      expect(after[0]).toBeGreaterThan(before[0]);
      expect(after[2]).toBeCloseTo(before[2], 1);
      expect(after[1]).toBeLessThanOrEqual(before[1] + 0.01);
    }
  });

  it("keeps dark colours in order, so navies stay apart", () => {
    const L = (hex: string) => rgbToOklch(liftColour(hexToRgb(hex), MODEL_LIFT))[0];
    expect(L("#05164d")).toBeLessThan(L("#073590") - 0.03);
    expect(L("#073590")).toBeLessThan(L("#1f3c88") + 0.01);
  });

  it("does not turn maroon pink", () => {
    // Qatar's maroon, lifted: still darker than Wizz Air's magenta.
    const qatar = rgbToOklch(liftColour(hexToRgb("#5c0632"), GLYPH_LIFT));
    expect(qatar[0]).toBeLessThan(rgbToOklch(hexToRgb("#c6007e"))[0]);
    expect(qatar[0]).toBeLessThanOrEqual(GLYPH_LIFT.redTo);
  });

  it("leaves white, greys, black and light colours as they are", () => {
    for (const hex of ["#f3f5f7", "#c4ccd2", "#1b1b1b", "#ffcc00", "#e2ecf2"]) {
      expect(liftColour(hexToRgb(hex), MODEL_LIFT)).toEqual(hexToRgb(hex));
    }
  });
});

describe("darkenColour", () => {
  it("lowers lightness and keeps hue", () => {
    const c = hexToRgb("#70cbf4");
    const d = darkenColour(c, 0.2);
    expect(rgbToOklch(d)[0]).toBeCloseTo(rgbToOklch(c)[0] - 0.2, 3);
    expect(rgbToOklch(d)[2]).toBeCloseTo(rgbToOklch(c)[2], 1);
  });
});
