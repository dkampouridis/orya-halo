import { describe, expect, it } from "vite-plus/test";
import { EARTH, buildStyle } from "./style.ts";

const style = buildStyle({
  tiles: "halo-tiles://tiles/{z}/{x}/{y}",
  maxZoom: 5,
  attribution: "© OpenStreetMap",
});
const layer = (id: string) => style.layers.find((l) => l.id === id);

describe("buildStyle", () => {
  it("draws a globe with the design's land and water", () => {
    expect(style.projection).toEqual({ type: "globe" });
    expect(layer("background")?.paint).toMatchObject({ "background-color": EARTH.water });
    expect(layer("earth")?.paint).toMatchObject({ "fill-color": EARTH.land });
    expect(layer("water")?.paint).toMatchObject({ "fill-color": EARTH.water });
    expect(EARTH.land).toBe("#10151c");
    expect(EARTH.water).toBe("#070b11");
  });

  it("draws borders in ice-white at 20%", () => {
    expect(layer("boundaries_country")?.paint).toMatchObject({
      "line-color": "rgba(233, 239, 246, 0.2)",
    });
  });

  it("needs no glyph server and no sprite sheet", () => {
    expect(style.glyphs).toBeUndefined();
    expect(style.sprite).toBeUndefined();
    for (const l of style.layers) {
      if (l.type !== "symbol") continue;
      expect(l.layout?.["icon-image"], l.id).toBeUndefined();
      // Every label is set in the font declared by the style itself.
      expect(JSON.stringify(l.layout?.["text-font"] ?? ["Archivo"]), l.id).toContain("Archivo");
    }
    expect(Object.keys(style["font-faces"] ?? {})).toEqual(["Archivo"]);
  });

  it("leaves out land cover, points of interest and road shields", () => {
    for (const id of ["landcover", "pois", "roads_shields", "roads_oneway"])
      expect(layer(id), id).toBeUndefined();
  });

  it("keeps labels in sentence case", () => {
    for (const l of style.layers) {
      if (l.type === "symbol") expect(l.layout?.["text-transform"], l.id).toBeUndefined();
    }
  });

  it("has a label layer for the sky and night shading to sit beneath", () => {
    const firstSymbol = style.layers.findIndex((l) => l.type === "symbol");
    expect(firstSymbol).toBeGreaterThan(0);
    // Nothing that fills or strokes the ground comes after the first label.
    expect(style.layers.slice(firstSymbol).every((l) => l.type === "symbol")).toBe(true);
  });

  it("credits the map data on the source", () => {
    const source = style.sources.protomaps;
    expect(source).toMatchObject({ type: "vector", maxzoom: 5, attribution: "© OpenStreetMap" });
  });

  it("switches MapLibre's own atmosphere off", () => {
    // MapLibre's atmosphere stays off (the engine draws the rim); the sky is the design's, not white.
    expect(style.sky?.["atmosphere-blend"]).toBe(0);
    expect(style.sky?.["horizon-color"]).not.toBe("#ffffff");
  });
});
