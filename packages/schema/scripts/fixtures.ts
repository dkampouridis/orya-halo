/**
 * Deterministic sample frames. `gen-fixtures.ts` writes them to
 * packages/schema/fixtures/*.bin; the TypeScript and Rust codecs are both
 * tested against those bytes, which keeps the two implementations in step.
 */
import {
  EntityKind,
  UpstreamStatus,
  encodeDensity,
  encodeEvents,
  encodeMeta,
  encodeRemove,
  encodeStats,
  encodeUpsert,
} from "../src/index.ts";

export const FIXTURE_TIME_MS = 1_794_000_000_123;

export function buildFixtures(): Record<string, ArrayBuffer> {
  return {
    "upsert-aircraft": encodeUpsert({
      kind: EntityKind.Aircraft,
      timeMs: FIXTURE_TIME_MS,
      full: true,
      count: 3,
      ids: [0x4ca7b5, 0xa1b2c3, 0x000001],
      lonE7: [-3_456_789, 1_800_000_000, -1_800_000_000],
      latE7: [515_074_000, -338_688_000, 900_000_000],
      alt: [1400, -4, 32767],
      heading: [9_050, 0, 0xffff],
      speed: [2_345, 0, 65_535],
      vrate: [-12, 0, 127],
      age: [0, 3, 255],
      category: [4, 1, 0],
      entityFlags: [0, 1, 0b1010],
    }),
    "upsert-ship-delta": encodeUpsert({
      kind: EntityKind.Ship,
      timeMs: FIXTURE_TIME_MS + 1000,
      full: false,
      count: 1,
      ids: [230_123_456],
      lonE7: [249_384_000],
      latE7: [601_699_000],
      alt: [0],
      heading: [27_015],
      speed: [62],
      vrate: [0],
      age: [12],
      category: [3],
      entityFlags: [0],
    }),
    "upsert-empty": encodeUpsert({
      kind: EntityKind.Aircraft,
      timeMs: FIXTURE_TIME_MS,
      full: true,
      count: 0,
      ids: [],
      lonE7: [],
      latE7: [],
      alt: [],
      heading: [],
      speed: [],
      vrate: [],
      age: [],
      category: [],
      entityFlags: [],
    }),
    remove: encodeRemove(EntityKind.Aircraft, FIXTURE_TIME_MS, [0x4ca7b5, 0xffffffff]),
    meta: encodeMeta(EntityKind.Aircraft, FIXTURE_TIME_MS, [
      {
        id: 0x4ca7b5,
        fields: {
          label: "EIN4KD",
          registration: "EI-DVM",
          typeCode: "A320",
          operator: "Aer Lingus",
        },
      },
      { id: 0xa1b2c3, fields: { label: "Zürich ✈ 東京", squawk: "7700" } },
      { id: 7, fields: {} },
    ]),
    density: encodeDensity({
      kind: EntityKind.Ship,
      timeMs: FIXTURE_TIME_MS,
      res: 2,
      cellLo: [0xffffffff, 0x1fffffff],
      cellHi: [0x0820007f, 0x08283473],
      lon: [-122.5, 2.25],
      lat: [37.75, 48.875],
      counts: [42, 100_000],
    }),
    stats: encodeStats(FIXTURE_TIME_MS, [
      { kind: EntityKind.Aircraft, status: UpstreamStatus.Ok, total: 12_345 },
      { kind: EntityKind.Ship, status: UpstreamStatus.NeedsKey, total: 0 },
    ]),
    events: encodeEvents(FIXTURE_TIME_MS, [
      {
        id: "emergency-4ca7b5",
        topic: "emergency",
        timeMs: FIXTURE_TIME_MS,
        title: "EIN4KD is squawking 7700 over the Irish Sea",
        lon: -5.1,
        lat: 53.4,
        ref: { kind: EntityKind.Aircraft, id: 0x4ca7b5 },
        severity: 2,
      },
    ]),
  };
}
