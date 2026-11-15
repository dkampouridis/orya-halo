import { VESSEL_SCHEMES } from "@orya-halo/schema";
import type { VesselScheme } from "@orya-halo/schema";
import { describe, expect, it } from "vite-plus/test";
import { VESSEL_PALETTE_WIDTH, vesselPaletteData } from "./vessel-mesh-layer.ts";

const texel = (data: Uint8Array, row: number, t: number): number[] =>
  Array.from(
    data.subarray((row * VESSEL_PALETTE_WIDTH + t) * 4, (row * VESSEL_PALETTE_WIDTH + t) * 4 + 4),
  );

describe("vesselPaletteData", () => {
  it("has a row for every scheme", () => {
    expect(vesselPaletteData(VESSEL_SCHEMES).length).toBe(
      VESSEL_SCHEMES.length * VESSEL_PALETTE_WIDTH * 4,
    );
  });

  it("lays out colours and their parameters as the shader reads them", () => {
    const scheme: VesselScheme = {
      id: 0,
      name: "Test",
      hull: "#ffffff",
      band: { color: "#102030", below: 0.5 },
      deck: "#010203",
      superstructure: "#040506",
      funnel: "#ff0000",
      funnelTop: { color: "#00ff00", share: 0.25 },
      boxes: { color: "#0000ff", share: 0.6 },
      accent: "#070809",
      stripe: "#0a0b0c",
    };
    const data = vesselPaletteData([scheme]);
    // Hull, with the band's top in alpha.
    expect(texel(data, 0, 0)).toEqual([255, 255, 255, 128]);
    expect(texel(data, 0, 1)).toEqual([16, 32, 48, 255]);
    expect(texel(data, 0, 2)).toEqual([1, 2, 3, 255]);
    expect(texel(data, 0, 3)).toEqual([4, 5, 6, 255]);
    // Funnel, with its top band's share in alpha, then the top band's colour.
    expect(texel(data, 0, 4)).toEqual([255, 0, 0, 64]);
    expect(texel(data, 0, 5)).toEqual([0, 255, 0, 255]);
    // Containers, with the share in the line's colour in alpha.
    expect(texel(data, 0, 6)).toEqual([0, 0, 255, 153]);
    expect(texel(data, 0, 7)).toEqual([7, 8, 9, 255]);
    // The bow stripe is on.
    expect(texel(data, 0, 8)).toEqual([10, 11, 12, 255]);
  });

  it("leaves out what a plain scheme does not have", () => {
    const data = vesselPaletteData([
      {
        id: 0,
        name: "Plain",
        hull: "#808080",
        deck: "#808080",
        superstructure: "#ffffff",
        funnel: "#202020",
        accent: "#ff8000",
      },
    ]);
    // No band, no funnel top, no line's boxes, no stripe: all zero in alpha.
    expect(texel(data, 0, 0)[3]).toBe(0);
    expect(texel(data, 0, 4)[3]).toBe(0);
    expect(texel(data, 0, 6)[3]).toBe(0);
    expect(texel(data, 0, 8)[3]).toBe(0);
    // The band and funnel top fall back to the hull's and funnel's own colours.
    expect(texel(data, 0, 1)).toEqual([128, 128, 128, 255]);
    expect(texel(data, 0, 5)).toEqual([32, 32, 32, 255]);
  });
});
