import { describe, expect, it } from "vite-plus/test";
import {
  EntityKind,
  STYLE_SIZE,
  ShipCategory,
  VESSEL_MODELS,
  VesselModel,
  aircraftValue,
  createRenderBatch,
  shipValue,
  vesselModel,
} from "@orya-halo/schema";
import { GLYPH_SCALE, moverGlyphScale, moversVS } from "../movers/movers-shaders.ts";
import { shipModelOf } from "./ship-models-layer.ts";

/** A one-ship batch with these style bytes and value. */
function one(style: [number, number, number, number], value: number) {
  const batch = createRenderBatch(EntityKind.Ship, 1, 0);
  batch.style.set(style);
  batch.values[0] = value;
  return batch;
}

const spec = (id: number) => vesselModel(id) as NonNullable<ReturnType<typeof vesselModel>>;

describe("shipModelOf", () => {
  it("takes the model, length and beam from the value", () => {
    const value = shipValue({ lengthM: 300, beamM: 48, model: VesselModel.Container, scheme: 16 });
    const m = shipModelOf(one([ShipCategory.Cargo, 0, 191, VesselModel.Container], value), 0);
    expect(m.spec.id).toBe(VesselModel.Container);
    expect(m.lengthM).toBe(300);
    expect(m.beamM).toBe(48);
  });

  it("with nothing known, draws the category's stand-in at its typical size", () => {
    for (const category of Object.values(ShipCategory)) {
      const m = shipModelOf(one([category, 0, 0, 0], 0), 0);
      expect(m.spec.id).not.toBe(VesselModel.Unknown);
      expect(m.lengthM).toBe(m.spec.lengthM);
      expect(m.beamM).toBeCloseTo(m.spec.beamM, 6);
    }
    expect(shipModelOf(one([ShipCategory.Tanker, 0, 0, 0], 0), 0).spec.id).toBe(VesselModel.Tanker);
    expect(shipModelOf(one([ShipCategory.Unknown, 0, 0, 0], 0), 0).spec.id).toBe(
      VesselModel.Generic,
    );
  });

  it("reads the length byte when the value has none (a feed that only sends length)", () => {
    const m = shipModelOf(one([ShipCategory.Passenger, 0, 255, 0], 0), 0);
    expect(m.lengthM).toBe(400);
    // 400 m and a passenger ship: the cruise ship stand-in, not the ferry.
    expect(m.spec.id).toBe(VesselModel.Cruise);
  });

  it("a model id past the list (15 fits the bits) falls back to the generic vessel", () => {
    const value = shipValue({ lengthM: 100, beamM: 0, model: 15 as VesselModel, scheme: 0 });
    const m = shipModelOf(one([ShipCategory.Cargo, 0, 64, 15], value), 0);
    expect(m.spec.id).toBe(VESSEL_MODELS[VESSEL_MODELS.length - 1].id);
    expect(m.spec.name).toBe("Vessel");
    expect(m.lengthM).toBe(100);
  });

  it("a beam far off the model's proportions is held to them", () => {
    const tanker = spec(VesselModel.Tanker);
    const typical = (250 * tanker.beamM) / tanker.lengthM;
    const wide = shipModelOf(
      one([2, 0, 159, 2], shipValue({ lengthM: 250, beamM: 63, model: 2, scheme: 0 })),
      0,
    );
    expect(wide.beamM).toBeCloseTo(Math.min(63, typical * 1.6), 6);
    const narrow = shipModelOf(
      one([2, 0, 159, 2], shipValue({ lengthM: 250, beamM: 3, model: 2, scheme: 0 })),
      0,
    );
    expect(narrow.beamM).toBeCloseTo(typical * 0.6, 6);
  });

  it("a value that is not a ship's (an aircraft's, NaN) is ignored, not misread", () => {
    for (const value of [Number.NaN, -1, 2 ** 25]) {
      const m = shipModelOf(one([ShipCategory.Tanker, 0, 0, 0], value), 0);
      expect(m.spec.id).toBe(VesselModel.Tanker);
      expect(Number.isFinite(m.lengthM) && Number.isFinite(m.beamM)).toBe(true);
    }
    // An aircraft value is a small number: read as a ship's it is 2 m steps of length, nothing else.
    const m = shipModelOf(one([ShipCategory.Tanker, 0, 0, 0], aircraftValue(7, 0)), 0);
    expect(m.lengthM).toBe(14);
  });
});

describe("glyph sizes from the style bytes", () => {
  it("an aircraft's livery byte does not change its glyph size", () => {
    for (const livery of [0, 1, 42, 255]) {
      expect(moverGlyphScale("aircraft", 3, livery)).toBe(GLYPH_SCALE.aircraft[3]);
    }
  });

  it("a ship's length byte does, within the shader's limits", () => {
    expect(moverGlyphScale("ship", ShipCategory.Cargo, 0)).toBe(
      GLYPH_SCALE.ship[ShipCategory.Cargo],
    );
    expect(moverGlyphScale("ship", ShipCategory.Cargo, 1)).toBe(0.55);
    expect(moverGlyphScale("ship", ShipCategory.Cargo, 255)).toBe(
      Math.min(Math.sqrt(400 / 150), 1.5),
    );
    expect(moverGlyphScale("ship", ShipCategory.Cargo, 96)).toBeCloseTo(
      Math.sqrt(((96 / 255) * 400) / 150),
      6,
    );
  });

  it("only the aircraft branch of the shared shader paints an airline colour", () => {
    // style.z is a livery for aircraft and a length for ships: the mark must be gated on the glyph.
    const gate = /if \(movers\.glyph < 0\.5[^)]*\) \{\s*int livery = int\(instanceStyle\.z/;
    expect(moversVS).toMatch(gate);
    expect(moversVS.match(/AIRLINE_MARK\[livery\]/g)?.length).toBe(1);
  });

  it("the style layout is four bytes", () => {
    expect(STYLE_SIZE).toBe(4);
  });
});
