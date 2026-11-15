import { describe, expect, test } from "vite-plus/test";
import { EntityKind } from "@orya-halo/schema";
import { IdMap } from "./idmap.ts";
import { EntityStore, searchKey } from "./store.ts";
import { seededRandom } from "./synthetic.ts";
import { makeUpdate } from "./testing.ts";

const K = EntityKind.Aircraft;

function idsOf(store: EntityStore): number[] {
  return [...store.ids.subarray(0, store.count)].sort((a, b) => a - b);
}

describe("IdMap", () => {
  test("agrees with a Map under random inserts, overwrites and deletes", () => {
    const random = seededRandom(42);
    const map = new IdMap(4);
    const model = new Map<number, number>();
    for (let step = 0; step < 50_000; step++) {
      // A small id space forces collisions, long probe runs and deletions inside them.
      const id = Math.floor(random() * 700) * 0x10001;
      if (random() < 0.55) {
        const value = Math.floor(random() * 1e6);
        map.set(id, value);
        model.set(id, value);
      } else {
        expect(map.delete(id)).toBe(model.delete(id));
      }
      if (step % 997 === 0) {
        expect(map.size).toBe(model.size);
        for (const [key, value] of model) expect(map.get(key)).toBe(value);
      }
    }
    for (let id = 0; id < 700; id++)
      expect(map.get(id * 0x10001)).toBe(model.get(id * 0x10001) ?? -1);
  });

  test("holds ids above 2^31", () => {
    const map = new IdMap();
    map.set(0xfffffffe, 7);
    expect(map.get(0xfffffffe)).toBe(7);
    expect(map.get(0x7ffffffe)).toBe(-1);
  });
});

describe("EntityStore", () => {
  test("a delta upserts and leaves the rest alone", () => {
    const store = new EntityStore(K);
    store.apply(
      makeUpdate(
        K,
        "a",
        1000,
        [
          { id: 1, lon: 10 },
          { id: 2, lon: 20 },
        ],
        { full: true },
      ),
      1000,
    );
    store.apply(
      makeUpdate(K, "a", 2000, [
        { id: 2, lon: 21 },
        { id: 3, lon: 30 },
      ]),
      2000,
    );
    expect(idsOf(store)).toEqual([1, 2, 3]);
    expect(store.lon[store.indexOf(2)]).toBe(21);
    expect(store.lon[store.indexOf(1)]).toBe(10);
  });

  test("a full update drops what its source no longer reports", () => {
    const store = new EntityStore(K);
    store.apply(makeUpdate(K, "a", 1000, [{ id: 1 }, { id: 2 }, { id: 3 }], { full: true }), 1000);
    store.apply(makeUpdate(K, "a", 2000, [{ id: 2 }, { id: 4 }], { full: true }), 2000);
    expect(idsOf(store)).toEqual([2, 4]);
    expect(store.indexOf(1)).toBe(-1);
  });

  test("an empty full update empties the source", () => {
    const store = new EntityStore(K);
    store.apply(makeUpdate(K, "a", 1000, [{ id: 1 }, { id: 2 }], { full: true }), 1000);
    store.apply(makeUpdate(K, "a", 2000, [], { full: true }), 2000);
    expect(store.count).toBe(0);
  });

  test("removed ids are dropped", () => {
    const store = new EntityStore(K);
    store.apply(makeUpdate(K, "a", 1000, [{ id: 1 }, { id: 2 }, { id: 3 }]), 1000);
    store.apply(makeUpdate(K, "a", 2000, [], { removed: [2, 99] }), 2000);
    expect(idsOf(store)).toEqual([1, 3]);
  });

  test("one source's full update does not drop another source's entities", () => {
    const store = new EntityStore(K);
    store.apply(makeUpdate(K, "a", 1000, [{ id: 1 }, { id: 2 }], { full: true }), 1000);
    store.apply(makeUpdate(K, "b", 1000, [{ id: 10 }, { id: 11 }], { full: true }), 1000);
    store.apply(makeUpdate(K, "a", 2000, [{ id: 2 }], { full: true }), 2000);
    expect(idsOf(store)).toEqual([2, 10, 11]);
  });

  test("an entity two sources report survives until both let go", () => {
    const store = new EntityStore(K);
    store.apply(makeUpdate(K, "a", 1000, [{ id: 5 }], { full: true }), 1000);
    store.apply(makeUpdate(K, "b", 1000, [{ id: 5 }], { full: true }), 1000);
    expect(store.count).toBe(1);
    store.apply(makeUpdate(K, "a", 2000, [], { full: true }), 2000);
    expect(store.indexOf(5)).not.toBe(-1);
    store.apply(makeUpdate(K, "b", 2000, [], { removed: [5] }), 2000);
    expect(store.count).toBe(0);
  });

  test("removeSource drops only what that source alone reports", () => {
    const store = new EntityStore(K);
    store.apply(makeUpdate(K, "a", 1000, [{ id: 1 }, { id: 2 }]), 1000);
    store.apply(makeUpdate(K, "b", 1000, [{ id: 2 }, { id: 3 }]), 1000);
    store.removeSource("a");
    expect(idsOf(store)).toEqual([2, 3]);
  });

  test("the newest fix wins, whichever source and whatever order", () => {
    const store = new EntityStore(K);
    store.apply(makeUpdate(K, "a", 5000, [{ id: 1, lon: 50, fixTimeMs: 5000 }]), 5000);
    // An older observation arrives late from another feed.
    store.apply(makeUpdate(K, "b", 5100, [{ id: 1, lon: 40, fixTimeMs: 4000 }]), 5100);
    expect(store.lon[0]).toBe(50);
    expect(store.ownerOf(0)).toBe("a");
    store.apply(makeUpdate(K, "b", 6000, [{ id: 1, lon: 60, fixTimeMs: 6000 }]), 6000);
    expect(store.lon[0]).toBe(60);
    expect(store.ownerOf(0)).toBe("b");
  });

  test("a source may take its own entity back in time, as a replaying source does", () => {
    const store = new EntityStore(EntityKind.Satellite);
    store.apply(
      makeUpdate(EntityKind.Satellite, "orbits", 9000, [{ id: 25544, lon: 90, fixTimeMs: 9000 }], {
        full: true,
      }),
      9000,
    );
    store.apply(
      makeUpdate(EntityKind.Satellite, "orbits", 9100, [{ id: 25544, lon: 30, fixTimeMs: 2000 }], {
        full: true,
      }),
      9100,
    );
    expect(store.lon[0]).toBe(30);
    expect(store.fixTimeMs[0]).toBe(2000);
  });

  test("an identical fix does not mark the entity as changed", () => {
    const store = new EntityStore(K);
    const update = makeUpdate(K, "a", 1000, [
      { id: 1, lon: 1, lat: 2, heading: Number.NaN, speed: 3 },
    ]);
    store.apply(update, 1000);
    store.dirty[0] = 0;
    store.changed = false;
    expect(store.apply(update, 2000)).toBe(0);
    expect(store.changed).toBe(false);
    expect(store.dirty[0]).toBe(0);
  });

  test("entities that go unreported expire, the rest stay", () => {
    const store = new EntityStore(K);
    store.apply(makeUpdate(K, "a", 0, [{ id: 1 }, { id: 2 }, { id: 3 }]), 0);
    store.apply(makeUpdate(K, "a", 50_000, [{ id: 2 }]), 50_000);
    expect(store.expire(70_000, 60_000)).toBe(2);
    expect(idsOf(store)).toEqual([2]);
    expect(store.expire(70_000, 0)).toBe(0);
  });

  test("meta merges per entity and keeps fields the update does not mention", () => {
    const store = new EntityStore(K);
    store.apply(
      makeUpdate(K, "a", 1000, [{ id: 1, meta: { label: "RYR123", registration: "EI-ABC" } }]),
      1000,
    );
    store.apply(
      makeUpdate(K, "a", 2000, [{ id: 1, meta: { label: "RYR456", operator: "Ryanair" } }]),
      2000,
    );
    expect(store.meta[0]).toEqual({ label: "RYR456", registration: "EI-ABC", operator: "Ryanair" });
    expect(store.keys[0]).toBe("ryr456\nei-abc");
    expect(store.mergeMeta(1, { squawk: "7700" })).toBe(true);
    expect(store.meta[0]?.squawk).toBe("7700");
    expect(store.mergeMeta(404, { label: "nobody" })).toBe(false);
  });

  test("meta and search keys follow their entity through swap-remove", () => {
    const store = new EntityStore(K);
    store.apply(
      makeUpdate(K, "a", 1000, [
        { id: 1, meta: { label: "One" } },
        { id: 2, meta: { label: "Two" } },
        { id: 3, meta: { label: "Three" } },
      ]),
      1000,
    );
    store.removeIds([1], "a");
    expect(store.count).toBe(2);
    for (let i = 0; i < store.count; i++) {
      expect(store.meta[i]?.label).toBe(store.ids[i] === 2 ? "Two" : "Three");
      expect(store.keys[i]).toBe(store.ids[i] === 2 ? "two" : "three");
    }
  });

  test("searchKey puts the label first and skips repeats and blanks", () => {
    expect(searchKey({ label: "BAW12", callsign: "BAW12", registration: "G-XWBA", imo: "" })).toBe(
      "baw12\ng-xwba",
    );
    expect(searchKey(undefined)).toBe("");
  });

  test("keepValue protects a value set from meta", () => {
    const store = new EntityStore(EntityKind.Ship);
    store.apply(makeUpdate(EntityKind.Ship, "gateway", 1000, [{ id: 7 }]), 1000, {
      keepValue: true,
    });
    store.setValue(7, 300);
    store.apply(makeUpdate(EntityKind.Ship, "gateway", 2000, [{ id: 7, lon: 1 }]), 2000, {
      keepValue: true,
    });
    expect(store.value[0]).toBe(300);
  });

  test("matches a Map model under random operations from three sources", () => {
    const random = seededRandom(7);
    const store = new EntityStore(K);
    const sources = ["a", "b", "c"];
    // Model: id -> the newest fix and who still reports it.
    const model = new Map<
      number,
      { lon: number; fix: number; owner: string; by: Set<string>; label?: string }
    >();
    let now = 1_000_000;

    const drop = (id: number, source: string) => {
      const entry = model.get(id);
      if (!entry || !entry.by.has(source)) return;
      entry.by.delete(source);
      if (entry.by.size === 0) model.delete(id);
    };

    for (let step = 0; step < 3000; step++) {
      now += 500;
      const source = sources[Math.floor(random() * sources.length)];
      const full = random() < 0.15;
      const n = Math.floor(random() * 40);
      const rows = [];
      const seen = new Set<number>();
      for (let i = 0; i < n; i++) {
        const id = 1 + Math.floor(random() * 300);
        if (seen.has(id)) continue;
        seen.add(id);
        const fix = now - Math.floor(random() * 5000);
        const lon = Math.fround(random() * 360 - 180);
        const withLabel = random() < 0.2;
        rows.push({
          id,
          lon,
          fixTimeMs: fix,
          ...(withLabel ? { meta: { label: `L${id}-${step}` } } : {}),
        });
        const entry = model.get(id);
        if (!entry)
          model.set(id, {
            lon,
            fix,
            owner: source,
            by: new Set([source]),
            ...(withLabel ? { label: `L${id}-${step}` } : {}),
          });
        else {
          entry.by.add(source);
          // Newest wins between sources; a source may revise its own fix.
          if (fix >= entry.fix || entry.owner === source) {
            entry.lon = lon;
            entry.fix = fix;
            entry.owner = source;
          }
          if (withLabel) entry.label = `L${id}-${step}`;
        }
      }
      const removed: number[] = [];
      if (!full && random() < 0.5) {
        for (let i = 0; i < 10; i++) {
          const id = 1 + Math.floor(random() * 300);
          if (seen.has(id)) continue;
          removed.push(id);
          drop(id, source);
        }
      }
      if (full) {
        for (const [id, entry] of model)
          if (entry.by.has(source) && !seen.has(id)) drop(id, source);
      }
      store.apply(makeUpdate(K, source, now, rows, { full, removed }), now);

      if (step % 50 === 0 || step === 2999) {
        expect(store.count).toBe(model.size);
        for (const [id, entry] of model) {
          const i = store.indexOf(id);
          expect(i).toBeGreaterThanOrEqual(0);
          expect(store.ids[i]).toBe(id);
          expect(store.lon[i]).toBe(entry.lon);
          expect(store.fixTimeMs[i]).toBe(entry.fix);
          expect(store.ownerOf(i)).toBe(entry.owner);
          expect(store.meta[i]?.label).toBe(entry.label);
        }
        // Every index maps back to itself: no orphans left by swap-remove.
        for (let i = 0; i < store.count; i++) expect(store.indexOf(store.ids[i])).toBe(i);
      }
    }
  });
});
