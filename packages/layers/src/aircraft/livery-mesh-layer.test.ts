import { AIRCRAFT_LIVERIES } from "@orya-halo/schema";
import type { AircraftLivery } from "@orya-halo/schema";
import { describe, expect, it } from "vite-plus/test";
import {
  PALETTE_WIDTH,
  SMALL_MODEL_PX,
  liveryPaletteData,
  liverySmallness,
} from "./livery-mesh-layer.ts";

const texel = (data: Uint8Array, row: number, t: number): number[] =>
  Array.from(data.subarray((row * PALETTE_WIDTH + t) * 4, (row * PALETTE_WIDTH + t) * 4 + 4));

describe("liveryPaletteData", () => {
  it("has a row for every scheme", () => {
    expect(liveryPaletteData(AIRCRAFT_LIVERIES).length).toBe(
      AIRCRAFT_LIVERIES.length * PALETTE_WIDTH * 4,
    );
  });

  it("lays out colours and their parameters as the shader reads them", () => {
    const scheme: AircraftLivery = {
      id: 1,
      name: "Test",
      codes: ["TST"],
      top: "#ffffff",
      belly: "#102030",
      bellyLine: 0,
      tail: "#ff0000",
      accent: { color: "#00ff00", on: "rear", split: 0.5 },
      engines: "#0000ff",
    };
    const data = liveryPaletteData([scheme]);
    // Top, with the belly line's sine mapped from -1..1 into alpha.
    expect(texel(data, 0, 0)).toEqual([255, 255, 255, 128]);
    // Belly, with the accent kind (3: rear) in alpha.
    expect(texel(data, 0, 1)).toEqual([16, 32, 48, 3]);
    // Fin, with the accent split in alpha.
    expect(texel(data, 0, 2)).toEqual([255, 0, 0, 128]);
    expect(texel(data, 0, 3)).toEqual([0, 255, 0, 255]);
    expect(texel(data, 0, 4)).toEqual([0, 0, 255, 255]);
    // No nose or rear colour: both flagged off in alpha.
    expect(texel(data, 0, 5)[3]).toBe(0);
    expect(texel(data, 0, 6)[3]).toBe(0);
  });

  it("lays out a painted nose and rear fuselage", () => {
    const data = liveryPaletteData([
      {
        id: 0,
        name: "Nose and rear",
        codes: [],
        top: "#ffffff",
        tail: "#ff6600",
        nose: "#ff6600",
        rear: { color: "#c6007e", to: 0.2 },
      },
    ]);
    expect(texel(data, 0, 5)).toEqual([255, 102, 0, 255]);
    // How far forward the rear colour reaches, in alpha.
    expect(texel(data, 0, 6)).toEqual([198, 0, 126, 51]);
  });

  it("gives every scheme a nose and rear texel the shader can read", () => {
    const data = liveryPaletteData(AIRCRAFT_LIVERIES);
    AIRCRAFT_LIVERIES.forEach((l, row) => {
      expect(texel(data, row, 5)[3]).toBe(l.nose ? 255 : 0);
      // A painted rear always reaches past the tail cone, so its alpha is never 0.
      if (l.rear) expect(texel(data, row, 6)[3]).toBeGreaterThan(0);
      else expect(texel(data, row, 6)[3]).toBe(0);
    });
  });

  it("codes an accent on the fin's leading part as 4", () => {
    const data = liveryPaletteData([
      {
        id: 0,
        name: "Flag",
        codes: [],
        top: "#ffffff",
        tail: "#00843d",
        accent: { color: "#d71921", on: "front", split: 0.3 },
      },
    ]);
    expect(texel(data, 0, 1)[3]).toBe(4);
    expect(texel(data, 0, 2)).toEqual([0, 132, 61, 77]);
  });

  it("puts a scheme without a belly colour's line below the keel", () => {
    const data = liveryPaletteData([
      { id: 0, name: "Plain", codes: [], top: "#808080", tail: "#808080" },
    ]);
    // Belly line -1, no accent, the top colour for the belly and accent.
    expect(texel(data, 0, 0)).toEqual([128, 128, 128, 0]);
    expect(texel(data, 0, 1)).toEqual([128, 128, 128, 0]);
    expect(texel(data, 0, 3)).toEqual([128, 128, 128, 255]);
  });
});

describe("liverySmallness", () => {
  it("is full for small models, none for large ones, and eases between", () => {
    const [lo, hi] = SMALL_MODEL_PX;
    expect(liverySmallness(26)).toBe(1);
    expect(liverySmallness(lo)).toBe(1);
    expect(liverySmallness(hi)).toBe(0);
    expect(liverySmallness(1200)).toBe(0);
    const mid = liverySmallness((lo + hi) / 2);
    expect(mid).toBeCloseTo(0.5, 5);
    let last = 1;
    for (let px = lo; px <= hi; px += 10) {
      expect(liverySmallness(px)).toBeLessThanOrEqual(last);
      last = liverySmallness(px);
    }
  });
});
