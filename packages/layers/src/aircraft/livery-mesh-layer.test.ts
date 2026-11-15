import { AIRCRAFT_LIVERIES } from "@orya-halo/schema";
import type { AircraftLivery } from "@orya-halo/schema";
import { describe, expect, it } from "vite-plus/test";
import { PALETTE_WIDTH, liveryPaletteData } from "./livery-mesh-layer.ts";

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
