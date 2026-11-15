import { describe, expect, test } from "vite-plus/test";
import {
  BLEND_SECONDS,
  EntityKind,
  batchTransferables,
  extrapolate,
  indexOfId,
  shipValue,
} from "@orya-halo/schema";
import { BatchBuilder, styleValue } from "./batch.ts";
import { EntityStore } from "./store.ts";
import { makeUpdate, randomUpdate } from "./testing.ts";

const K = EntityKind.Aircraft;
const T0 = 1_800_000_000_000;

/** Metres between two lon/lat points, flat-earth: fine at these distances. */
function metres(a: readonly number[], b: readonly number[]): number {
  const dLat = (a[1] - b[1]) * 111_195;
  const dLon = (a[0] - b[0]) * 111_195 * Math.cos((a[1] * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

describe("BatchBuilder", () => {
  test("writes the store's columns into interleaved attributes", () => {
    const store = new EntityStore(K);
    store.apply(
      makeUpdate(K, "a", T0, [
        {
          id: 0x4ca123,
          lon: 12.5,
          lat: 41.9,
          alt: 10_000,
          heading: 90,
          speed: 230,
          vrate: -5,
          fixTimeMs: T0 - 2000,
          category: 3,
          flags: 2,
        },
      ]),
      T0,
    );
    const batch = new BatchBuilder(K).build(store, T0);
    expect(batch.kind).toBe(K);
    expect(batch.count).toBe(1);
    expect(batch.seq).toBe(1);
    expect(batch.epochMs).toBe(T0);
    expect([...batch.ids]).toEqual([0x4ca123]);
    expect([...batch.positions]).toEqual([12.5, Math.fround(41.9), 10_000]);
    expect([...batch.motion]).toEqual([90, 230, -5, -2]);
    expect([...batch.style]).toEqual([3, 2, 0, 0]);
    expect(store.changed).toBe(false);
    // Six separate buffers, ready to move to the main thread.
    expect(new Set(batchTransferables(batch)).size).toBe(6);
  });

  test("a new entity starts exactly on its fix, with no offset", () => {
    const store = new EntityStore(K);
    store.apply(makeUpdate(K, "a", T0, [{ id: 1, lon: 5, lat: 5, heading: 0, speed: 200 }]), T0);
    const batch = new BatchBuilder(K).build(store, T0);
    expect(batch.blend[0]).toBe(0);
    expect(batch.blend[1]).toBe(0);
    expect(extrapolate(batch, 0, T0)).toEqual([5, 5, 0]);
  });

  test("a corrected fix does not jump: old and new batches agree at the update time", () => {
    const store = new EntityStore(K);
    const builder = new BatchBuilder(K);
    // Heading east at 250 m/s; the next fix shows it actually turned north-east and is 600 m off.
    store.apply(
      makeUpdate(K, "a", T0, [
        { id: 1, lon: 10, lat: 50, alt: 11_000, heading: 90, speed: 250, fixTimeMs: T0 },
      ]),
      T0,
    );
    const first = builder.build(store, T0);

    const t1 = T0 + 4000;
    store.apply(
      makeUpdate(K, "a", t1, [
        {
          id: 1,
          lon: 10.0105,
          lat: 50.0054,
          alt: 11_000,
          heading: 45,
          speed: 240,
          fixTimeMs: t1 - 700,
        },
      ]),
      t1,
    );
    const second = builder.build(store, t1);

    const before = extrapolate(first, 0, t1);
    const after = extrapolate(second, 0, t1);
    // The uncorrected paths really do disagree here, by hundreds of metres...
    expect(second.blend[0]).not.toBe(0);
    expect(Math.hypot(second.blend[0], second.blend[1]) * 111_195).toBeGreaterThan(100);
    // ...yet the object is drawn in the same place by both batches.
    expect(metres(before, after)).toBeLessThan(0.5);
  });

  test("the correction eases out and the object converges on the new path", () => {
    const store = new EntityStore(K);
    const builder = new BatchBuilder(K);
    store.apply(
      makeUpdate(K, "a", T0, [{ id: 1, lon: 10, lat: 50, heading: 90, speed: 250, fixTimeMs: T0 }]),
      T0,
    );
    builder.build(store, T0);
    const t1 = T0 + 4000;
    const fix = { id: 1, lon: 10.0105, lat: 50.0054, heading: 45, speed: 240, fixTimeMs: t1 - 700 };
    store.apply(makeUpdate(K, "a", t1, [fix]), t1);
    const second = builder.build(store, t1);

    // The pure new path: the same fix in a fresh store, never blended.
    const clean = new EntityStore(K);
    clean.apply(makeUpdate(K, "a", t1, [fix]), t1);
    const truth = new BatchBuilder(K).build(clean, t1);

    let previous = Number.POSITIVE_INFINITY;
    for (let ms = 0; ms <= BLEND_SECONDS * 1000; ms += 150) {
      const gap = metres(extrapolate(second, 0, t1 + ms), extrapolate(truth, 0, t1 + ms));
      // Monotonic: it only ever closes on the new path.
      expect(gap).toBeLessThanOrEqual(previous + 1e-6);
      previous = gap;
    }
    const after = t1 + BLEND_SECONDS * 1000 + 1;
    expect(metres(extrapolate(second, 0, after), extrapolate(truth, 0, after))).toBeLessThan(0.05);
  });

  test("a correction that arrives mid-blend still starts where the object is drawn", () => {
    const store = new EntityStore(K);
    const builder = new BatchBuilder(K);
    store.apply(
      makeUpdate(K, "a", T0, [{ id: 1, lon: 0, lat: 0, heading: 90, speed: 200, fixTimeMs: T0 }]),
      T0,
    );
    builder.build(store, T0);
    const t1 = T0 + 1000;
    store.apply(
      makeUpdate(K, "a", t1, [
        { id: 1, lon: 0.004, lat: 0.003, heading: 80, speed: 210, fixTimeMs: t1 },
      ]),
      t1,
    );
    const second = builder.build(store, t1);
    // 0.6 s later the first correction is still easing out when another fix lands.
    const t2 = t1 + 600;
    store.apply(
      makeUpdate(K, "a", t2, [
        { id: 1, lon: 0.0049, lat: 0.0025, heading: 100, speed: 190, fixTimeMs: t2 },
      ]),
      t2,
    );
    const third = builder.build(store, t2);
    expect(metres(extrapolate(second, 0, t2), extrapolate(third, 0, t2))).toBeLessThan(0.5);
  });

  test("continuity holds for every entity of a large update", () => {
    const store = new EntityStore(K);
    const builder = new BatchBuilder(K);
    store.apply(randomUpdate(K, "a", T0, 2000, 11, { full: true }), T0);
    const first = builder.build(store, T0);
    const t1 = T0 + 5000;
    // Same ids, entirely different fixes nearby: every entity needs a correction.
    const next = randomUpdate(K, "a", t1, 2000, 11, { full: true });
    for (let i = 0; i < next.count; i++) {
      next.columns.lon[i] = first.positions[i * 3] + 0.01;
      next.columns.lat[i] = first.positions[i * 3 + 1] - 0.01;
      next.columns.fixTimeMs[i] = t1 - 300;
    }
    store.apply(next, t1);
    const second = builder.build(store, t1);
    let worst = 0;
    for (let i = 0; i < first.count; i++) {
      const j = indexOfId(second, first.ids[i]);
      worst = Math.max(worst, metres(extrapolate(first, i, t1), extrapolate(second, j, t1)));
    }
    // Float32 degrees are good to about a metre near 180 degrees of longitude.
    expect(worst).toBeLessThan(2.5);
  });

  test("an entity that was not updated keeps its place across batches and epochs", () => {
    const store = new EntityStore(K);
    const builder = new BatchBuilder(K);
    store.apply(
      makeUpdate(K, "a", T0, [
        { id: 1, lon: 100, lat: 30, heading: 270, speed: 240, fixTimeMs: T0 - 1500 },
        { id: 2, lon: -70, lat: -20, heading: 10, speed: 220, fixTimeMs: T0 },
      ]),
      T0,
    );
    const first = builder.build(store, T0);
    // Twenty minutes and many batches later, only entity 2 has moved on.
    let latest = first;
    for (let step = 1; step <= 20; step++) {
      const t = T0 + step * 60_000;
      store.apply(
        makeUpdate(K, "a", t, [
          { id: 2, lon: -70 + step * 0.01, lat: -20, heading: 10, speed: 220, fixTimeMs: t },
        ]),
        t,
      );
      latest = builder.build(store, t);
    }
    expect(latest.epochMs).toBe(T0 + 20 * 60_000);
    expect(latest.epochMs).not.toBe(first.epochMs);
    const i = indexOfId(latest, 1);
    // Re-based times: the fix is the same instant, expressed against a new epoch.
    expect(latest.epochMs + latest.motion[i * 4 + 3] * 1000).toBeCloseTo(T0 - 1500, 0);
    for (const t of [T0 + 5000, T0 + 30_000]) {
      expect(metres(extrapolate(first, 0, t), extrapolate(latest, i, t))).toBeLessThan(0.1);
    }
  });

  test("fix times keep millisecond precision an hour into a session", () => {
    const store = new EntityStore(EntityKind.Ship);
    const builder = new BatchBuilder(EntityKind.Ship);
    const late = T0 + 3_600_000;
    store.apply(
      makeUpdate(EntityKind.Ship, "a", late, [
        { id: 1, heading: 0, speed: 10, fixTimeMs: late - 1234 },
      ]),
      late,
    );
    const batch = builder.build(store, late + 0.4);
    expect(batch.epochMs + batch.motion[3] * 1000).toBeCloseTo(late - 1234, 1);
  });

  test("a teleport snaps instead of gliding across the map", () => {
    const store = new EntityStore(K);
    const builder = new BatchBuilder(K);
    store.apply(
      makeUpdate(K, "a", T0, [{ id: 1, lon: 0, lat: 0, heading: 0, speed: 200, fixTimeMs: T0 }]),
      T0,
    );
    builder.build(store, T0);
    store.apply(
      makeUpdate(K, "a", T0 + 1000, [
        { id: 1, lon: 3, lat: 2, heading: 0, speed: 200, fixTimeMs: T0 + 1000 },
      ]),
      T0 + 1000,
    );
    const batch = builder.build(store, T0 + 1000);
    expect([batch.blend[0], batch.blend[1]]).toEqual([0, 0]);
  });

  test("a correction across the antimeridian takes the short way round", () => {
    const store = new EntityStore(K);
    const builder = new BatchBuilder(K);
    store.apply(
      makeUpdate(K, "a", T0, [
        { id: 1, lon: 179.999, lat: 0, heading: 90, speed: 200, fixTimeMs: T0 },
      ]),
      T0,
    );
    builder.build(store, T0);
    store.apply(
      makeUpdate(K, "a", T0 + 1000, [
        { id: 1, lon: -179.998, lat: 0, heading: 90, speed: 200, fixTimeMs: T0 + 1000 },
      ]),
      T0 + 1000,
    );
    const batch = builder.build(store, T0 + 1000);
    expect(Math.abs(batch.blend[0])).toBeLessThan(0.01);
    expect(batch.blend[0]).not.toBe(0);
  });

  test("resetDrawn starts over with no easing", () => {
    const store = new EntityStore(K);
    const builder = new BatchBuilder(K);
    store.apply(
      makeUpdate(K, "a", T0, [{ id: 1, lon: 0, lat: 0, heading: 90, speed: 200, fixTimeMs: T0 }]),
      T0,
    );
    builder.build(store, T0);
    store.apply(
      makeUpdate(K, "a", T0 + 1000, [
        { id: 1, lon: 0.01, lat: 0.01, heading: 90, speed: 200, fixTimeMs: T0 + 1000 },
      ]),
      T0 + 1000,
    );
    store.resetDrawn();
    const batch = builder.build(store, T0 + 1000);
    expect([batch.blend[0], batch.blend[1]]).toEqual([0, 0]);
  });

  test("sequence numbers rise, including for empty batches", () => {
    const store = new EntityStore(K);
    const builder = new BatchBuilder(K);
    expect(builder.build(store, T0).seq).toBe(1);
    expect(builder.empty(T0).seq).toBe(2);
    expect(builder.nextSeq()).toBe(3);
  });

  test("styleValue maps each kind's scalar onto a byte", () => {
    expect(styleValue(EntityKind.Quake, 5)).toBe(128);
    expect(styleValue(EntityKind.Quake, 12)).toBe(255);
    // A ship's value packs its length with its beam, model and colours.
    expect(
      styleValue(EntityKind.Ship, shipValue({ lengthM: 200, beamM: 32, model: 3, scheme: 20 })),
    ).toBe(128);
    expect(styleValue(EntityKind.Satellite, 1440)).toBe(255);
    expect(styleValue(EntityKind.Fire, 0)).toBe(0);
    expect(styleValue(EntityKind.Fire, 999)).toBe(255);
    expect(styleValue(EntityKind.Aircraft, 42)).toBe(0);
    expect(styleValue(EntityKind.Quake, Number.NaN)).toBe(0);
  });
});
