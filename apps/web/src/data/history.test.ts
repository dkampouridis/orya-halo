import { describe, expect, test } from "vite-plus/test";
import {
  EARTH_RADIUS_M,
  EntityKind,
  VesselModel,
  extrapolate,
  indexOfId,
  shipValue,
} from "@orya-halo/schema";
import { HISTORY_PROFILES, HistoryRing } from "./history.ts";
import type { HistoryProfile } from "./history.ts";
import { EntityStore } from "./store.ts";
import { makeUpdate } from "./testing.ts";

const K = EntityKind.Aircraft;
const T0 = 1_800_000_000_000;
const MB = 1024 * 1024;
const AIRCRAFT = HISTORY_PROFILES[EntityKind.Aircraft] as HistoryProfile;
const SHIPS = HISTORY_PROFILES[EntityKind.Ship] as HistoryProfile;
const DEG = Math.PI / 180;

/** A straight-line flight: where it truly is at time t. */
function truth(
  lon0: number,
  lat0: number,
  heading: number,
  speed: number,
  t: number,
): [number, number] {
  const dist = (speed * (t - T0)) / 1000;
  const lat = lat0 + (dist * Math.cos(heading * DEG)) / EARTH_RADIUS_M / DEG;
  const lon =
    lon0 + (dist * Math.sin(heading * DEG)) / (EARTH_RADIUS_M * Math.cos(lat0 * DEG)) / DEG;
  return [lon, lat];
}

function metres(a: readonly number[], b: readonly number[]): number {
  return Math.hypot((a[1] - b[1]) * 111_195, (a[0] - b[0]) * 111_195 * Math.cos(a[1] * DEG));
}

function small(overrides: Partial<HistoryProfile> = {}): HistoryProfile {
  return { intervalMs: 10_000, budgetBytes: 4 * MB, hasAlt: true, speedUnit: 1.5, ...overrides };
}

describe("HistoryRing", () => {
  test("is empty until the first keyframe", () => {
    const ring = new HistoryRing(K, 60_000, small());
    expect(ring.range()).toBeNull();
    expect(ring.reconstruct(T0, 1)).toBeNull();
  });

  test("reproduces a keyframe to within quantisation", () => {
    const ring = new HistoryRing(K, 60_000, small());
    const store = new EntityStore(K);
    store.apply(
      makeUpdate(K, "a", T0, [
        {
          id: 1,
          lon: 12.345678,
          lat: 41.876543,
          alt: 10_668,
          heading: 123,
          speed: 231,
          category: 4,
          flags: 2,
          fixTimeMs: T0,
        },
        { id: 2, lon: -179.9, lat: -89.5, alt: -50, speed: 0, fixTimeMs: T0 },
      ]),
      T0,
    );
    ring.record(store, T0);
    const batch = ring.reconstruct(T0, 9) as NonNullable<ReturnType<HistoryRing["reconstruct"]>>;
    expect(batch.count).toBe(2);
    expect(batch.seq).toBe(9);
    const i = indexOfId(batch, 1);
    expect(
      metres([batch.positions[i * 3], batch.positions[i * 3 + 1]], [12.345678, 41.876543]),
    ).toBeLessThan(3);
    expect(batch.positions[i * 3 + 2]).toBe(10_668);
    expect(batch.motion[i * 4]).toBeCloseTo(123, 0);
    expect(batch.motion[i * 4 + 1]).toBeCloseTo(231, 0);
    expect([batch.style[i * 4], batch.style[i * 4 + 1]]).toEqual([4, 2]);
    const j = indexOfId(batch, 2);
    expect(Number.isNaN(batch.motion[j * 4])).toBe(true);
    expect(batch.positions[j * 3 + 2]).toBe(-50);
    // The replayed batch draws where it says: the fix time is the scrubbed time.
    expect(metres(extrapolate(batch, i, T0), [12.345678, 41.876543])).toBeLessThan(3);
  });

  test("reconstructs between keyframes close to the true path", () => {
    const ring = new HistoryRing(K, 10 * 60_000, small({ intervalMs: 20_000 }));
    const store = new EntityStore(K);
    const flights = [
      { id: 1, lon: 2, lat: 48, heading: 77, speed: 245 },
      { id: 2, lon: -75, lat: 40, heading: 200, speed: 180 },
      { id: 3, lon: 139, lat: 35, heading: 310, speed: 90 },
    ];
    // Fixes every 5 s for five minutes; a keyframe every 20 s.
    for (let t = T0; t <= T0 + 300_000; t += 5000) {
      store.apply(
        makeUpdate(
          K,
          "a",
          t,
          flights.map((f) => {
            const [lon, lat] = truth(f.lon, f.lat, f.heading, f.speed, t);
            return {
              id: f.id,
              lon,
              lat,
              alt: 9000,
              heading: f.heading,
              speed: f.speed,
              fixTimeMs: t,
            };
          }),
        ),
        t,
      );
      if ((t - T0) % 20_000 === 0) ring.record(store, t);
    }
    let worst = 0;
    for (let t = T0; t <= T0 + 300_000; t += 3700) {
      const batch = ring.reconstruct(t, 1) as NonNullable<ReturnType<HistoryRing["reconstruct"]>>;
      expect(batch.count).toBe(3);
      for (const f of flights) {
        const i = indexOfId(batch, f.id);
        worst = Math.max(
          worst,
          metres(extrapolate(batch, i, t), truth(f.lon, f.lat, f.heading, f.speed, t)),
        );
      }
    }
    // 24-bit lon/lat plus float32 degrees: a few metres, at any point in the five minutes.
    expect(worst).toBeLessThan(12);
  });

  test("dead-reckons fixes that are older than the keyframe", () => {
    const ring = new HistoryRing(K, 60_000, small());
    const store = new EntityStore(K);
    // The fix is 8 s old when the keyframe is taken: the record must hold where it is now.
    store.apply(
      makeUpdate(K, "a", T0, [{ id: 1, lon: 0, lat: 0, heading: 90, speed: 250, fixTimeMs: T0 }]),
      T0,
    );
    ring.record(store, T0 + 8000);
    const batch = ring.reconstruct(T0 + 8000, 1) as NonNullable<
      ReturnType<HistoryRing["reconstruct"]>
    >;
    expect(
      metres([batch.positions[0], batch.positions[1]], truth(0, 0, 90, 250, T0 + 8000)),
    ).toBeLessThan(3);
  });

  test("coasts past the newest keyframe and clamps before the oldest", () => {
    const ring = new HistoryRing(K, 60_000, small());
    const store = new EntityStore(K);
    store.apply(
      makeUpdate(K, "a", T0, [{ id: 1, lon: 0, lat: 0, heading: 0, speed: 200, fixTimeMs: T0 }]),
      T0,
    );
    ring.record(store, T0);
    const later = ring.reconstruct(T0 + 6000, 1) as NonNullable<
      ReturnType<HistoryRing["reconstruct"]>
    >;
    expect(later.positions[1] * 111_195).toBeCloseTo(1200, -2);
    const earlier = ring.reconstruct(T0 - 60_000, 1) as NonNullable<
      ReturnType<HistoryRing["reconstruct"]>
    >;
    expect(earlier.positions[1]).toBeCloseTo(0, 4);
  });

  test("wraps around: the oldest keyframes fall off and the range moves on", () => {
    // 60 s of history at 10 s spacing is seven keyframes.
    const ring = new HistoryRing(K, 60_000, small());
    expect(ring.frames).toBe(7);
    const store = new EntityStore(K);
    for (let k = 0; k < 25; k++) {
      const t = T0 + k * 10_000;
      store.apply(makeUpdate(K, "a", t, [{ id: 1, lon: k, lat: 10, fixTimeMs: t }]), t);
      ring.record(store, t);
    }
    expect(ring.keyframes).toBe(7);
    expect(ring.range()).toEqual({ fromMs: T0 + 18 * 10_000, toMs: T0 + 24 * 10_000 });
    // Each surviving keyframe still holds its own position, in order.
    for (let k = 18; k <= 24; k++) {
      const batch = ring.reconstruct(T0 + k * 10_000, 1) as NonNullable<
        ReturnType<HistoryRing["reconstruct"]>
      >;
      expect(batch.positions[0]).toBeCloseTo(k, 4);
    }
    // Halfway between two keyframes is halfway between their positions.
    const mid = ring.reconstruct(T0 + 20.5 * 10_000, 1) as NonNullable<
      ReturnType<HistoryRing["reconstruct"]>
    >;
    expect(mid.positions[0]).toBeCloseTo(20.5, 4);
    // Scrubbing before the window lands on the oldest keyframe, not on stale data.
    const before = ring.reconstruct(T0, 1) as NonNullable<ReturnType<HistoryRing["reconstruct"]>>;
    expect(before.positions[0]).toBeCloseTo(18, 4);
  });

  test("an object that left is still there when scrubbing back, and gone after", () => {
    const ring = new HistoryRing(K, 120_000, small());
    const store = new EntityStore(K);
    store.apply(
      makeUpdate(
        K,
        "a",
        T0,
        [
          { id: 1, lon: 1, lat: 1 },
          { id: 2, lon: 2, lat: 2 },
        ],
        { full: true },
      ),
      T0,
    );
    ring.record(store, T0);
    ring.record(store, T0 + 10_000);
    store.apply(
      makeUpdate(K, "a", T0 + 15_000, [{ id: 2, lon: 2, lat: 2 }], { full: true }),
      T0 + 15_000,
    );
    ring.record(store, T0 + 20_000);
    ring.record(store, T0 + 30_000);
    const past = ring.reconstruct(T0 + 5000, 1) as NonNullable<
      ReturnType<HistoryRing["reconstruct"]>
    >;
    expect([...past.ids].sort((a, b) => a - b)).toEqual([1, 2]);
    const present = ring.reconstruct(T0 + 25_000, 1) as NonNullable<
      ReturnType<HistoryRing["reconstruct"]>
    >;
    expect([...present.ids]).toEqual([2]);
  });

  test("an object that appears mid-window is absent before it arrived", () => {
    const ring = new HistoryRing(K, 120_000, small());
    const store = new EntityStore(K);
    store.apply(makeUpdate(K, "a", T0, [{ id: 1 }]), T0);
    ring.record(store, T0);
    store.apply(makeUpdate(K, "a", T0 + 10_000, [{ id: 2, lon: 5 }]), T0 + 10_000);
    ring.record(store, T0 + 10_000);
    expect([...(ring.reconstruct(T0 + 4000, 1)?.ids ?? [])]).toEqual([1]);
    expect([...(ring.reconstruct(T0 + 10_000, 1)?.ids ?? [])].sort((a, b) => a - b)).toEqual([
      1, 2,
    ]);
  });

  test("the default budgets hold 20,000 aircraft and 50,000 ships within 48 MB", () => {
    const aircraft = new HistoryRing(EntityKind.Aircraft, 30 * 60_000, AIRCRAFT);
    const ships = new HistoryRing(EntityKind.Ship, 30 * 60_000, SHIPS);
    expect(AIRCRAFT.budgetBytes + SHIPS.budgetBytes).toBe(48 * MB);
    expect(aircraft.intervalMs).toBe(20_000);
    expect(aircraft.frames).toBe(91);
    expect(ships.intervalMs).toBe(60_000);
    expect(ships.frames).toBe(31);
    expect(aircraft.maxSlots).toBeGreaterThanOrEqual(20_000 * 1.4);
    expect(ships.maxSlots).toBeGreaterThanOrEqual(50_000 * 1.2);
  });

  test("never allocates past its budget, however many objects pass through", () => {
    const profile = small({ budgetBytes: 2 * MB, intervalMs: 10_000 });
    const ring = new HistoryRing(K, 120_000, profile);
    const store = new EntityStore(K);
    let peak = 0;
    // 3,000 live at a time, and the whole population turns over every ten keyframes.
    for (let k = 0; k < 400; k++) {
      const t = T0 + k * 10_000;
      const first = k * 300;
      const rows = [];
      for (let i = 0; i < 3000; i++)
        rows.push({ id: first + i + 1, lon: (i % 360) - 180, lat: (i % 160) - 80, fixTimeMs: t });
      store.apply(makeUpdate(K, "a", t, rows, { full: true }), t);
      ring.record(store, t);
      peak = Math.max(peak, ring.bytes);
    }
    expect(peak).toBeLessThanOrEqual(profile.budgetBytes);
    expect(ring.slots).toBeLessThanOrEqual(ring.maxSlots);
    // The live set is always replayable, budget or not.
    const latest = ring.reconstruct(T0 + 399 * 10_000, 1) as NonNullable<
      ReturnType<HistoryRing["reconstruct"]>
    >;
    expect(latest.count).toBe(3000);
    expect(ring.dropped).toBe(0);
  });

  test("memory stops growing once the population is steady", () => {
    const ring = new HistoryRing(K, 120_000, small({ budgetBytes: 16 * MB }));
    const store = new EntityStore(K);
    const sizes: number[] = [];
    for (let k = 0; k < 300; k++) {
      const t = T0 + k * 10_000;
      const first = k * 20;
      const rows = [];
      for (let i = 0; i < 2000; i++) rows.push({ id: first + i + 1, fixTimeMs: t });
      store.apply(makeUpdate(K, "a", t, rows, { full: true }), t);
      ring.record(store, t);
      sizes.push(ring.bytes);
    }
    // Slots of objects that aged out of the window are reused: flat after warm-up.
    expect(sizes[299]).toBe(sizes[60]);
    expect(ring.slots).toBeLessThan(4096 + 1);
  });

  test("when every slot is live, the excess is counted and left out", () => {
    const ring = new HistoryRing(K, 60_000, small({ budgetBytes: 400_000 }));
    const store = new EntityStore(K);
    const n = ring.maxSlots + 500;
    const rows = [];
    for (let i = 0; i < n; i++) rows.push({ id: i + 1 });
    store.apply(makeUpdate(K, "a", T0, rows), T0);
    ring.record(store, T0);
    expect(ring.dropped).toBe(500);
    expect(ring.reconstruct(T0, 1)?.count).toBe(ring.maxSlots);
    expect(ring.bytes).toBeLessThanOrEqual(400_000);
  });

  test("a slot reused by a newcomer does not replay its previous owner", () => {
    const ring = new HistoryRing(K, 60_000, small({ budgetBytes: 400_000 }));
    const store = new EntityStore(K);
    const n = ring.maxSlots;
    const rows = [];
    for (let i = 0; i < n; i++) rows.push({ id: i + 1, lon: 10, lat: 10 });
    store.apply(makeUpdate(K, "a", T0, rows, { full: true }), T0);
    ring.record(store, T0);
    // Entity 1 leaves; entity 999999 arrives and, with the ring full, takes its slot.
    const next = rows.slice(1).concat([{ id: 999_999, lon: -50, lat: -50 }]);
    store.apply(makeUpdate(K, "a", T0 + 10_000, next, { full: true }), T0 + 10_000);
    ring.record(store, T0 + 10_000);
    const old = ring.reconstruct(T0, 1) as NonNullable<ReturnType<HistoryRing["reconstruct"]>>;
    expect(indexOfId(old, 999_999)).toBe(-1);
    const now = ring.reconstruct(T0 + 10_000, 1) as NonNullable<
      ReturnType<HistoryRing["reconstruct"]>
    >;
    const i = indexOfId(now, 999_999);
    expect(now.positions[i * 3]).toBeCloseTo(-50, 3);
  });

  test("a longer window stretches the keyframe spacing instead of the budget", () => {
    const ring = new HistoryRing(EntityKind.Aircraft, 6 * 60 * 60_000, AIRCRAFT);
    expect(ring.intervalMs).toBeGreaterThan(AIRCRAFT.intervalMs);
    expect(ring.maxSlots).toBeGreaterThanOrEqual(4096);
    expect((ring.frames - 1) * ring.intervalMs).toBeGreaterThanOrEqual(6 * 60 * 60_000);
  });

  test("returns the recorded track of one entity, oldest first", () => {
    const ring = new HistoryRing(K, 120_000, small());
    const store = new EntityStore(K);
    for (let k = 0; k < 6; k++) {
      const t = T0 + k * 10_000;
      const rows = [{ id: 7, lon: k * 0.1, lat: 20, alt: 1000 + k, fixTimeMs: t }];
      // A second entity so the scan has something to skip; it leaves halfway.
      if (k < 3) rows.push({ id: 8, lon: 50, lat: 50, alt: 0, fixTimeMs: t });
      store.apply(makeUpdate(K, "a", t, rows, { full: true }), t);
      ring.record(store, t);
    }
    const track = ring.track(7);
    expect(track.count).toBe(6);
    expect([...track.timesMs.subarray(0, 6)]).toEqual(
      [0, 1, 2, 3, 4, 5].map((k) => T0 + k * 10_000),
    );
    expect(track.positions[5 * 3]).toBeCloseTo(0.5, 4);
    expect(track.positions[5 * 3 + 2]).toBe(1005);
    expect(ring.track(8).count).toBe(3);
    expect(ring.track(12345).count).toBe(0);
  });

  test("ships are recorded without altitude, at a finer speed step", () => {
    const value = shipValue({ lengthM: 180, beamM: 28, model: VesselModel.Ferry, scheme: 0 });
    const ring = new HistoryRing(EntityKind.Ship, 30 * 60_000, SHIPS);
    const store = new EntityStore(EntityKind.Ship);
    store.apply(
      makeUpdate(EntityKind.Ship, "a", T0, [
        { id: 244660000, lon: 4.1, lat: 52, heading: 270, speed: 7.3, value },
      ]),
      T0,
    );
    ring.record(store, T0);
    const batch = ring.reconstruct(T0, 1) as NonNullable<ReturnType<HistoryRing["reconstruct"]>>;
    expect(batch.motion[1]).toBeCloseTo(7.3, 0);
    expect(batch.positions[2]).toBe(0);
    expect(batch.values[0]).toBe(value);
    // Replayed ships keep their glyph length and 3D model, as live batches have them.
    expect(batch.style[2]).toBe(Math.round((180 / 400) * 255));
    expect(batch.style[3]).toBe(VesselModel.Ferry);
  });
});
