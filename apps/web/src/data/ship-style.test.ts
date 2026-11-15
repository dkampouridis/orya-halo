/**
 * The style bytes and values the glyph shader and the 3D layers read, for
 * aircraft and ships, from live batches and from history replay. The glyph
 * shader is shared, so each kind's bytes must mean what that kind's branch
 * of the shader expects: aircraft [category, flags, livery, model], ships
 * [category, flags, length over 400 m, model].
 */
import { describe, expect, test } from "vite-plus/test";
import {
  EntityKind,
  STYLE_SIZE,
  ShipCategory,
  VesselModel,
  aircraftValue,
  shipValue,
} from "@orya-halo/schema";
import type { RenderBatch } from "@orya-halo/schema";
import { BatchBuilder, liveryByte, modelByte, shipModelByte, styleValue } from "./batch.ts";
import { HISTORY_PROFILES, HistoryRing } from "./history.ts";
import type { HistoryProfile } from "./history.ts";
import { EntityStore } from "./store.ts";
import { makeUpdate } from "./testing.ts";

const T0 = 1_800_000_000_000;
const A = EntityKind.Aircraft;
const S = EntityKind.Ship;

interface Row {
  id: number;
  value: number;
  category: number;
  flags?: number;
}

function storeOf(kind: EntityKind, rows: readonly Row[]): EntityStore {
  const store = new EntityStore(kind);
  store.apply(
    makeUpdate(
      kind,
      "test",
      T0,
      rows.map((r, i) => ({ ...r, lon: 4 + i * 0.01, lat: 52, heading: 90, speed: 5 })),
    ),
    T0,
  );
  return store;
}

function styleOf(batch: RenderBatch, id: number): number[] {
  const i = Array.from(batch.ids).indexOf(id);
  expect(i).toBeGreaterThanOrEqual(0);
  return Array.from(batch.style.subarray(i * STYLE_SIZE, i * STYLE_SIZE + STYLE_SIZE));
}

function valueOf(batch: RenderBatch, id: number): number {
  return batch.values[Array.from(batch.ids).indexOf(id)];
}

function replay(kind: EntityKind, store: EntityStore): RenderBatch {
  const ring = new HistoryRing(kind, 30 * 60_000, HISTORY_PROFILES[kind] as HistoryProfile);
  ring.record(store, T0);
  const batch = ring.reconstruct(T0, 1);
  if (!batch) throw new Error("nothing recorded");
  return batch;
}

const SHIPS: Row[] = [
  // Unknown dimensions, model and scheme: the glyph sizes it by category.
  { id: 1, value: 0, category: ShipCategory.Cargo },
  // Static data told us everything.
  {
    id: 2,
    value: shipValue({ lengthM: 200, beamM: 32, model: VesselModel.Bulk, scheme: 20 }),
    category: ShipCategory.Cargo,
  },
  // Model known, length not (a tug that sent its type but no dimensions).
  {
    id: 3,
    value: shipValue({ lengthM: 0, beamM: 0, model: VesselModel.Tug, scheme: 0 }),
    category: ShipCategory.Service,
  },
  // Every field at its ceiling.
  { id: 4, value: 2 ** 24 - 1, category: ShipCategory.Tanker, flags: 1 },
  // Longer than the 400 m the length byte spans.
  {
    id: 5,
    value: shipValue({ lengthM: 458, beamM: 63, model: VesselModel.Container, scheme: 63 }),
    category: ShipCategory.Cargo,
  },
];

const AIRCRAFT: Row[] = [
  { id: 0x100, value: 0, category: 3 },
  { id: 0x101, value: aircraftValue(7, 42), category: 3 },
  // The largest aircraft value: model 255, livery 255.
  { id: 0x102, value: aircraftValue(255, 255), category: 5, flags: 2 },
  // Livery only: an airline we know, an aircraft type we do not.
  { id: 0x103, value: aircraftValue(0, 9), category: 3 },
];

describe("ship style bytes", () => {
  test("live batches carry the length byte and the model, never the scheme", () => {
    const batch = new BatchBuilder(S).build(storeOf(S, SHIPS), T0);
    expect(styleOf(batch, 1)).toEqual([ShipCategory.Cargo, 0, 0, 0]);
    expect(styleOf(batch, 2)).toEqual([ShipCategory.Cargo, 0, 128, VesselModel.Bulk]);
    expect(styleOf(batch, 3)).toEqual([ShipCategory.Service, 0, 0, VesselModel.Tug]);
    expect(styleOf(batch, 4)).toEqual([ShipCategory.Tanker, 1, 255, 15]);
    expect(styleOf(batch, 5)).toEqual([ShipCategory.Cargo, 0, 255, VesselModel.Container]);
    // The scheme travels only in the value, which reaches the 3D layer whole.
    for (const row of SHIPS) expect(valueOf(batch, row.id)).toBe(row.value);
  });

  test("history replay gives ships the same bytes and values as a live batch", () => {
    const store = storeOf(S, SHIPS);
    const replayed = replay(S, store);
    const live = new BatchBuilder(S).build(store, T0);
    for (const row of SHIPS) {
      expect(styleOf(replayed, row.id), `ship ${row.id}`).toEqual(styleOf(live, row.id));
      expect(valueOf(replayed, row.id)).toBe(row.value);
    }
  });

  test("the byte helpers read a ship's value as a ship", () => {
    const v = shipValue({ lengthM: 200, beamM: 32, model: VesselModel.Bulk, scheme: 20 });
    expect(styleValue(S, v)).toBe(128);
    expect(shipModelByte(v)).toBe(VesselModel.Bulk);
    // Read as an aircraft's, a ship's value is out of range and means nothing.
    expect(liveryByte(v)).toBe(0);
    expect(modelByte(v)).toBe(0);
  });
});

describe("aircraft style bytes", () => {
  test("live batches carry the livery and the model", () => {
    const batch = new BatchBuilder(A).build(storeOf(A, AIRCRAFT), T0);
    expect(styleOf(batch, 0x100)).toEqual([3, 0, 0, 0]);
    expect(styleOf(batch, 0x101)).toEqual([3, 0, 42, 7]);
    expect(styleOf(batch, 0x102)).toEqual([5, 2, 255, 255]);
    expect(styleOf(batch, 0x103)).toEqual([3, 0, 9, 0]);
    for (const row of AIRCRAFT) expect(valueOf(batch, row.id)).toBe(row.value);
  });

  test("history replay gives aircraft the same bytes and values as a live batch", () => {
    const store = storeOf(A, AIRCRAFT);
    const replayed = replay(A, store);
    const live = new BatchBuilder(A).build(store, T0);
    for (const row of AIRCRAFT) {
      expect(styleOf(replayed, row.id), `aircraft ${row.id}`).toEqual(styleOf(live, row.id));
      expect(valueOf(replayed, row.id)).toBe(row.value);
    }
  });

  test("an aircraft's livery never reaches the byte a ship's length uses, and back", () => {
    // Aircraft are not "styled" kinds: styleValue gives them nothing.
    expect(styleValue(A, aircraftValue(7, 42))).toBe(0);
    // A ship value shaped like an aircraft's (below 65536) reads as a ship's 2 m steps.
    expect(styleValue(S, aircraftValue(7, 42))).toBe(Math.round((14 / 400) * 255));
  });
});

describe("replay after the value changes", () => {
  test("static data that arrives later shows on the whole replay, model byte included", () => {
    const store = storeOf(S, [{ id: 9, value: 0, category: ShipCategory.Cargo }]);
    const ring = new HistoryRing(S, 30 * 60_000, HISTORY_PROFILES[S] as HistoryProfile);
    ring.record(store, T0);
    const later = shipValue({ lengthM: 300, beamM: 48, model: VesselModel.Container, scheme: 16 });
    store.setValue(9, later);
    const interval = (HISTORY_PROFILES[S] as HistoryProfile).intervalMs;
    ring.record(store, T0 + interval);
    const before = ring.reconstruct(T0, 1);
    const after = ring.reconstruct(T0 + interval, 1);
    if (!before || !after) throw new Error("nothing recorded");
    // The ring keeps one value per slot: a ship's size and kind do not change
    // over half an hour, so the earlier moment shows what was learnt since.
    for (const batch of [before, after]) {
      expect(valueOf(batch, 9)).toBe(later);
      expect(styleOf(batch, 9)).toEqual([ShipCategory.Cargo, 0, 191, VesselModel.Container]);
    }
  });
});
