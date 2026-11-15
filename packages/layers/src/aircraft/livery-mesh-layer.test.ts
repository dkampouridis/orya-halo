import { AIRCRAFT_LIVERIES, NEUTRAL_LIVERY } from "@orya-halo/schema";
import type { AircraftLivery } from "@orya-halo/schema";
import { describe, expect, it } from "vite-plus/test";
import { MODEL_LIFT, hexToRgb, liftColour } from "./livery-colour.ts";
import {
  LIFTED,
  PALETTE_WIDTH,
  SMALL_MODEL_PX,
  dorsalStripKind,
  liveryPaletteData,
  liverySmallness,
} from "./livery-mesh-layer.ts";

const texel = (data: Uint8Array, row: number, t: number): number[] =>
  Array.from(data.subarray((row * PALETTE_WIDTH + t) * 4, (row * PALETTE_WIDTH + t) * 4 + 4));

const byte = (v: number): number => Math.round(v * 255);
const byName = (name: string): AircraftLivery => {
  const l = AIRCRAFT_LIVERIES.find((s) => s.name === name);
  if (!l) throw new Error(name);
  return l;
};

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
    // No nose, rear colour or cheatline: all flagged off in alpha.
    expect(texel(data, 0, 5)[3]).toBe(0);
    expect(texel(data, 0, 6)[3]).toBe(0);
    expect(texel(data, 0, 7)[3]).toBe(0);
    // The strip along the top of a small model carries the fin's colours (kind 1).
    expect(texel(data, 0, 18)).toEqual([255, 0, 0, 128]);
  });

  it("keeps a lifted copy of every colour for small models, with the same alpha", () => {
    const data = liveryPaletteData(AIRCRAFT_LIVERIES);
    AIRCRAFT_LIVERIES.forEach((_, row) => {
      for (let t = 0; t < 8; t++)
        expect(texel(data, row, t + LIFTED)[3]).toBe(texel(data, row, t)[3]);
    });
    // Lufthansa's navy fin: lighter on a small model, and as painted otherwise.
    const row = byName("Lufthansa").id;
    expect(texel(data, row, 2).slice(0, 3)).toEqual([0x05, 0x16, 0x4d]);
    expect(texel(data, row, 2 + LIFTED).slice(0, 3)).toEqual(
      liftColour(hexToRgb("#05164d"), MODEL_LIFT).map(byte),
    );
    // White stays white.
    expect(texel(data, row, LIFTED)).toEqual(texel(data, row, 0));
  });

  it("lays out a painted nose, a rear fuselage with its extent, and a cheatline", () => {
    const data = liveryPaletteData([
      {
        id: 0,
        name: "Nose and rear",
        codes: [],
        top: "#ffffff",
        tail: "#ff6600",
        nose: "#ff6600",
        rear: { color: "#c6007e", to: 0.2, from: 0.1, above: 0 },
        stripe: { color: "#d6001c", lo: -0.2, hi: 0.2, from: 0.3, to: 0.8 },
      },
    ]);
    expect(texel(data, 0, 5)).toEqual([255, 102, 0, 255]);
    // How far forward the rear colour reaches, in alpha; where it starts and its lower edge.
    expect(texel(data, 0, 6)).toEqual([198, 0, 126, 51]);
    expect(texel(data, 0, 16)).toEqual([byte(0.1), 128, 0, 255]);
    expect(texel(data, 0, 7)).toEqual([214, 0, 28, 255]);
    expect(texel(data, 0, 17)).toEqual([byte(0.4), byte(0.6), byte(0.3), byte(0.8)]);
  });

  it("paints a rear colour all the way round, from the tip of the tail, by default", () => {
    const data = liveryPaletteData([byName("Ryanair")]);
    expect(texel(data, 0, 16).slice(0, 2)).toEqual([0, 0]);
    // Lufthansa's starts ahead of the tail cone's tip, and only above the waist.
    const lh = liveryPaletteData([byName("Lufthansa")]);
    expect(texel(lh, 0, 16)[0]).toBeGreaterThan(0);
    expect(texel(lh, 0, 16)[1]).toBeGreaterThan(0);
  });

  it("gives every scheme a nose, rear and strip texel the shader can read", () => {
    const data = liveryPaletteData(AIRCRAFT_LIVERIES);
    AIRCRAFT_LIVERIES.forEach((l, row) => {
      expect(texel(data, row, 5)[3]).toBe(l.nose ? 255 : 0);
      if (l.rear) expect(texel(data, row, 6)[3]).toBeGreaterThan(0);
      else expect(texel(data, row, 6)[3]).toBe(0);
      expect(texel(data, row, 18)[3]).toBe(byte(dorsalStripKind(l) / 2));
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

describe("dorsalStripKind", () => {
  it("lays the fin's colours along the top where the fin is coloured, else the mark", () => {
    // Unknown airlines get no strip: the neutral grey stays plain.
    expect(dorsalStripKind(NEUTRAL_LIVERY)).toBe(0);
    // A black fin on a white aircraft has no hue, but stands apart: its colours.
    expect(dorsalStripKind(byName("Air Canada"))).toBe(1);
    expect(dorsalStripKind(byName("Air New Zealand"))).toBe(1);
    // A grey fin barely darker than the fuselage: none.
    expect(dorsalStripKind({ ...NEUTRAL_LIVERY, tail: "#c9ced3" })).toBe(0);
    // A coloured fin: its colours, second colour and all (British Airways' red).
    expect(dorsalStripKind(byName("British Airways"))).toBe(1);
    expect(dorsalStripKind(byName("Emirates"))).toBe(1);
    // A white fin: the colour that marks the airline.
    expect(dorsalStripKind(byName("Air France"))).toBe(2);
    expect(dorsalStripKind(byName("Norwegian"))).toBe(2);
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
