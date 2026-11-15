import { describe, expect, test } from "vite-plus/test";
import {
  BLEND_SECONDS,
  EntityKind,
  LAYERS,
  MAX_EXTRAPOLATION_S,
  createRenderBatch,
  extrapolate,
  hashId,
  hexToRgb,
  layerDef,
  layerForKind,
} from "../src/index.ts";

function oneAircraft(heading: number, speed: number, lon = 0, lat = 0) {
  const batch = createRenderBatch(EntityKind.Aircraft, 1, 1_000_000);
  batch.positions.set([lon, lat, 10_000]);
  batch.motion.set([heading, speed, 5, 0]);
  batch.blend.set([0, 0, -1000]);
  return batch;
}

describe("extrapolate", () => {
  test("holds position at the fix time", () => {
    expect(extrapolate(oneAircraft(90, 250), 0, 1_000_000)).toEqual([0, 0, 10_000]);
  });

  test("moves east along the equator at ground speed", () => {
    // 250 m/s for 10 s is 2.5 km; one degree of longitude at the equator is ~111.195 km.
    const [lon, lat, alt] = extrapolate(oneAircraft(90, 250), 0, 1_010_000);
    expect(lon).toBeCloseTo(2.5 / 111.195, 4);
    expect(lat).toBeCloseTo(0, 6);
    expect(alt).toBeCloseTo(10_050, 3);
  });

  test("longitude steps widen with latitude", () => {
    const [lonEq] = extrapolate(oneAircraft(90, 250, 0, 0), 0, 1_010_000);
    const [lon60] = extrapolate(oneAircraft(90, 250, 0, 60), 0, 1_010_000);
    expect(lon60 / lonEq).toBeCloseTo(2, 2);
  });

  test("stops projecting after the kind's limit", () => {
    const limit = MAX_EXTRAPOLATION_S[EntityKind.Aircraft];
    const atLimit = extrapolate(oneAircraft(0, 200), 0, 1_000_000 + limit * 1000);
    const wayPast = extrapolate(oneAircraft(0, 200), 0, 1_000_000 + limit * 10_000);
    expect(wayPast).toEqual(atLimit);
  });

  test("does not move backwards before the fix time", () => {
    expect(extrapolate(oneAircraft(0, 200), 0, 900_000)).toEqual([0, 0, 10_000]);
  });

  test("unknown heading means no horizontal motion", () => {
    const [lon, lat] = extrapolate(oneAircraft(Number.NaN, 200), 0, 1_010_000);
    expect([lon, lat]).toEqual([0, 0]);
  });

  test("a correction eases out smoothly and is gone after the blend window", () => {
    const batch = oneAircraft(0, 0);
    batch.blend.set([1, -1, 0]);
    expect(extrapolate(batch, 0, 1_000_000).slice(0, 2)).toEqual([1, -1]);
    const [mid] = extrapolate(batch, 0, 1_000_000 + (BLEND_SECONDS * 1000) / 2);
    expect(mid).toBeCloseTo(0.5, 6);
    expect(extrapolate(batch, 0, 1_000_000 + BLEND_SECONDS * 1000).slice(0, 2)).toEqual([0, 0]);
  });

  test("wraps across the antimeridian and clamps at the poles", () => {
    const [lon] = extrapolate(oneAircraft(90, 250, 179.99, 0), 0, 1_010_000);
    expect(lon).toBeLessThan(-179.9);
    const [, lat] = extrapolate(oneAircraft(0, 250, 0, 89.999), 0, 1_040_000);
    expect(lat).toBe(90);
  });

  test("things that never move stay put", () => {
    const batch = createRenderBatch(EntityKind.Quake, 1, 0);
    batch.positions.set([10, 20, -5000]);
    batch.motion.set([45, 100, 0, 0]);
    expect(extrapolate(batch, 0, 60_000)).toEqual([10, 20, -5000]);
  });
});

describe("layer registry", () => {
  test("every layer has a unique id, hotkey and a valid colour", () => {
    expect(new Set(LAYERS.map((l) => l.id)).size).toBe(LAYERS.length);
    expect(new Set(LAYERS.map((l) => l.hotkey)).size).toBe(LAYERS.length);
    for (const layer of LAYERS) expect(layer.accent).toMatch(/^#[0-9a-f]{6}$/);
  });

  test("entity layers map to and from their kind", () => {
    expect(layerForKind(EntityKind.Ship).id).toBe("ships");
    expect(layerDef("quakes").kind).toBe(EntityKind.Quake);
    for (const layer of LAYERS) if (layer.shape === "entities") expect(layer.kind).toBeDefined();
    expect(layerForKind(EntityKind.Cable).id).toBe("cables");
  });

  test("hexToRgb", () => {
    expect(hexToRgb("#4fe3ff")).toEqual([0x4f, 0xe3, 0xff]);
  });

  test("hashId is stable and unsigned", () => {
    expect(hashId("us7000abcd")).toBe(hashId("us7000abcd"));
    expect(hashId("us7000abcd")).not.toBe(hashId("us7000abce"));
    expect(hashId("ü")).toBeGreaterThanOrEqual(0);
  });
});
