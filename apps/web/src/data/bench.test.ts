/**
 * Benchmarks for the data runtime's hot paths. Skipped in a normal test run;
 * measure with:
 *
 *   HALO_BENCH=1 vp test run src/data/bench.test.ts
 *
 * Each figure is the median of several runs after warm-up, on one thread.
 */
import { describe, expect, test } from "vite-plus/test";
import { EntityKind, decodeFrame, updateToUpsert, upsertToUpdate } from "@orya-halo/schema";
import type { EntityUpdate, UpsertFrame, ViewState } from "@orya-halo/schema";
import { BatchBuilder } from "./batch.ts";
import { cellsForView } from "./cells.ts";
import { nearbyEntities } from "./detail.ts";
import { HISTORY_PROFILES, HistoryRing } from "./history.ts";
import type { HistoryProfile } from "./history.ts";
import { searchStores } from "./search.ts";
import { EntityStore } from "./store.ts";
import { randomUpdate } from "./testing.ts";

const enabled = typeof process !== "undefined" && process.env.HALO_BENCH === "1";
const T0 = 1_800_000_000_000;
const A = EntityKind.Aircraft;
const S = EntityKind.Ship;

const rows: [string, string][] = [];

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

/** Time `run`, calling `prepare` (untimed) before each pass. Returns the median, ms. */
function measure(
  name: string,
  run: () => unknown,
  prepare: () => void = () => {},
  passes = 15,
): number {
  for (let i = 0; i < 4; i++) {
    prepare();
    run();
  }
  const samples: number[] = [];
  for (let i = 0; i < passes; i++) {
    prepare();
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  const ms = median(samples);
  rows.push([name, `${ms.toFixed(2)} ms`]);
  return ms;
}

/** The same entities a moment later: every fix moved, as after a full-world tick. */
function moved(update: EntityUpdate, dtMs: number): EntityUpdate {
  const columns = {
    ...update.columns,
    lon: update.columns.lon.slice(),
    lat: update.columns.lat.slice(),
    fixTimeMs: update.columns.fixTimeMs.slice(),
  };
  for (let i = 0; i < update.count; i++) {
    columns.lon[i] += 0.01;
    columns.lat[i] += 0.005;
    columns.fixTimeMs[i] += dtMs;
  }
  return { ...update, timeMs: update.timeMs + dtMs, columns, full: false };
}

function filled(
  kind: EntityKind,
  count: number,
  labels = false,
): { store: EntityStore; base: EntityUpdate } {
  const store = new EntityStore(kind);
  const base = randomUpdate(kind, "gateway", T0, count, 5, { full: true, labels });
  store.apply(base, T0);
  return { store, base };
}

describe.skipIf(!enabled)("benchmarks", () => {
  test("stores", () => {
    const { store, base } = filled(A, 20_000);
    let step = 0;
    let next = base;
    const ms = measure(
      "apply a 20k-entity delta (every fix changed)",
      () => store.apply(next, T0 + step * 1000),
      () => {
        step++;
        next = moved(next, 1000);
      },
    );
    expect(store.count).toBe(20_000);

    // The path a gateway frame really takes: bytes to columns to the store.
    const wire = filled(A, 20_000);
    let frameStep = 0;
    let frame = updateToUpsert(wire.base);
    measure(
      "decode a 20k Upsert frame and apply it",
      () =>
        wire.store.apply(
          upsertToUpdate(decodeFrame(frame) as UpsertFrame, "gateway"),
          T0 + frameStep * 1000,
          { keepValue: true },
        ),
      () => {
        frameStep++;
        frame = updateToUpsert(moved(wire.base, frameStep * 1000));
      },
    );

    const big = new EntityStore(A);
    measure(
      "apply a 100k-entity full update into an empty store",
      () => big.apply(fullUpdate, T0),
      () => big.clear(),
      7,
    );
    expect(ms).toBeLessThan(50);
  });

  const fullUpdate = randomUpdate(A, "gateway", T0, 100_000, 9, { full: true });

  test("batches", () => {
    for (const count of [20_000, 100_000]) {
      const { store, base } = filled(A, count);
      const builder = new BatchBuilder(A);
      builder.build(store, T0);
      const label = count === 20_000 ? "20k" : "100k";
      let step = 0;
      let next = base;
      measure(
        `build a ${label} batch, every entity corrected (blend for all)`,
        () => builder.build(store, T0 + step * 1000 + 30),
        () => {
          step++;
          next = moved(next, 1000);
          store.apply(next, T0 + step * 1000);
        },
        count === 20_000 ? 15 : 9,
      );
      measure(
        `build a ${label} batch, nothing corrected (re-base only)`,
        () => builder.build(store, T0 + step * 1000 + 60),
        () => {
          step++;
        },
        count === 20_000 ? 15 : 9,
      );
      // The usual case: a third of the fleet reported since the last batch.
      const third = randomUpdate(A, "gateway", T0, Math.floor(count / 3), 5, { full: false });
      let partial = third;
      measure(
        `build a ${label} batch, a third corrected`,
        () => builder.build(store, T0 + step * 1000 + 30),
        () => {
          step++;
          partial = moved(partial, 1000);
          store.apply(partial, T0 + step * 1000);
        },
        count === 20_000 ? 15 : 9,
      );
    }
  });

  test("search", () => {
    const aircraft = filled(A, 50_000, true).store;
    const ships = new EntityStore(S);
    ships.apply(
      randomUpdate(S, "gateway", T0, 50_000, 6, { full: true, labels: true, idBase: 200_000_000 }),
      T0,
    );
    const stores = [aircraft, ships];
    expect(aircraft.count + ships.count).toBe(100_000);
    measure('search 100k entities: callsign prefix ("ryr")', () => searchStores(stores, "ryr"));
    measure('search 100k entities: substring ("r-1a")', () => searchStores(stores, "r-1a"));
    measure('search 100k entities: digits, id and text ("2000")', () =>
      searchStores(stores, "2000"),
    );
    measure('search 100k entities: one letter, half the world matches ("a")', () =>
      searchStores(stores, "a"),
    );
    measure('search 100k entities: no match ("zzzzzz")', () => searchStores(stores, "zzzzzz"));
    measure("search 100k entities: prefix, ranked by distance", () =>
      searchStores(stores, "ryr", 20, { lon: 2, lat: 48 }),
    );
    measure("nearby: 5 nearest of 100k within 150 km", () =>
      nearbyEntities(stores, { kind: A, id: 1 }, 2, 48),
    );
  });

  test("history", () => {
    const aircraftProfile = HISTORY_PROFILES[A] as HistoryProfile;
    const shipProfile = HISTORY_PROFILES[S] as HistoryProfile;
    const aircraft = filled(A, 20_000);
    const ring = new HistoryRing(A, 30 * 60_000, aircraftProfile);
    let frame = 0;
    let next = aircraft.base;
    // Fill the whole ring first, so the figures are for steady state.
    for (; frame < ring.frames + 5; frame++) {
      next = moved(next, ring.intervalMs);
      aircraft.store.apply(next, T0 + frame * ring.intervalMs);
      ring.record(aircraft.store, T0 + frame * ring.intervalMs);
    }
    measure(
      "history: record a 20k-aircraft keyframe",
      () => ring.record(aircraft.store, T0 + frame * ring.intervalMs),
      () => {
        frame++;
      },
    );
    const range = ring.range() as { fromMs: number; toMs: number };
    let at = 0;
    measure(
      "history: reconstruct 20k aircraft at a scrubbed time",
      () => ring.reconstruct(range.fromMs + ((at * 7919) % (range.toMs - range.fromMs)), 1),
      () => {
        at++;
      },
    );
    measure("history: recorded track of one aircraft", () =>
      ring.track(aircraft.base.columns.ids[123]),
    );

    const ships = filled(S, 50_000);
    const shipRing = new HistoryRing(S, 30 * 60_000, shipProfile);
    for (let f = 0; f < shipRing.frames + 2; f++)
      shipRing.record(ships.store, T0 + f * shipRing.intervalMs);
    const shipRange = shipRing.range() as { fromMs: number; toMs: number };
    measure(
      "history: reconstruct 50k ships at a scrubbed time",
      () => shipRing.reconstruct(shipRange.fromMs + 12_345, 1),
      undefined,
      9,
    );

    const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    rows.push([
      "history memory: 20k aircraft, 91 keyframes",
      `${mb(ring.bytes)} of ${mb(aircraftProfile.budgetBytes)}`,
    ]);
    rows.push([
      "history memory: 50k ships, 31 keyframes",
      `${mb(shipRing.bytes)} of ${mb(shipProfile.budgetBytes)}`,
    ]);
    rows.push([
      "store memory: 20k aircraft / 50k ships",
      `${mb(aircraft.store.bytes)} / ${mb(ships.store.bytes)}`,
    ]);
    expect(ring.bytes).toBeLessThanOrEqual(aircraftProfile.budgetBytes);
    expect(shipRing.bytes).toBeLessThanOrEqual(shipProfile.budgetBytes);
    expect(ring.dropped + shipRing.dropped).toBe(0);
  });

  test("viewport cells", () => {
    const view = (bounds: [number, number, number, number], zoom: number): ViewState => ({
      lon: 0,
      lat: 0,
      zoom,
      bearing: 0,
      pitch: 0,
      bounds,
      global: false,
    });
    measure("cells: regional view at resolution 3", () =>
      cellsForView(view([-2, 50.5, 1.5, 52.5], 7), 2000),
    );
    measure("cells: continental view at resolution 2", () =>
      cellsForView(view([-12, 35, 30, 60], 5), 2000),
    );
    measure("cells: wide pitched view that must coarsen", () =>
      cellsForView(view([-40, 15, 50, 70], 6.5), 2000),
    );
  });

  test("report", () => {
    const width = Math.max(...rows.map(([name]) => name.length));
    console.log(`\n${rows.map(([name, value]) => `${name.padEnd(width)}  ${value}`).join("\n")}\n`);
    expect(rows.length).toBeGreaterThan(10);
  });
});
