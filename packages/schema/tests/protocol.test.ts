import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import {
  EntityKind,
  FrameType,
  HEADER_BYTES,
  META_MAX_FIELD_BYTES,
  ProtocolError,
  UPSERT_RECORD_BYTES,
  UpstreamStatus,
  createColumns,
  decodeFrame,
  encodeMeta,
  encodeUpsert,
  metaToMap,
  readHeader,
  updateToUpsert,
  upsertToUpdate,
} from "../src/index.ts";
import type {
  DensityFrame,
  EventsFrame,
  MetaFrame,
  RemoveFrame,
  StatsFrame,
  UpsertFrame,
} from "../src/index.ts";
import { FIXTURE_TIME_MS, buildFixtures } from "../scripts/fixtures.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const fixtures = buildFixtures();

describe("golden fixtures", () => {
  // The Rust gateway reads the same files, so a drift here is a protocol break.
  for (const [name, buffer] of Object.entries(fixtures)) {
    test(`${name}.bin matches the encoder byte for byte`, () => {
      const onDisk = readFileSync(join(fixtureDir, `${name}.bin`));
      expect(Buffer.from(buffer).equals(onDisk)).toBe(true);
    });
  }
});

describe("header", () => {
  test("round-trips type, kind, flags, time and count", () => {
    const header = readHeader(fixtures["upsert-aircraft"]);
    expect(header).toEqual({
      type: FrameType.Upsert,
      kind: EntityKind.Aircraft,
      flags: 1,
      timeMs: FIXTURE_TIME_MS,
      count: 3,
      aux: 0,
    });
  });

  test("rejects bad magic, unknown versions and short buffers", () => {
    const bad = new Uint8Array(fixtures.remove.slice(0));
    bad[0] = 0x00;
    expect(() => decodeFrame(bad.buffer)).toThrow(ProtocolError);
    const future = new Uint8Array(fixtures.remove.slice(0));
    future[1] = 99;
    expect(() => decodeFrame(future.buffer)).toThrow(/version 99/);
    expect(() => decodeFrame(new ArrayBuffer(8))).toThrow(ProtocolError);
  });

  test("rejects unknown frame types", () => {
    const odd = new Uint8Array(fixtures.remove.slice(0));
    odd[2] = 200;
    expect(() => decodeFrame(odd.buffer)).toThrow(/Unknown frame type/);
  });
});

describe("upsert", () => {
  test("decodes every column, including extremes", () => {
    const frame = decodeFrame(fixtures["upsert-aircraft"]) as UpsertFrame;
    expect(frame.type).toBe(FrameType.Upsert);
    expect(frame.full).toBe(true);
    expect(Array.from(frame.ids)).toEqual([0x4ca7b5, 0xa1b2c3, 1]);
    expect(Array.from(frame.lonE7)).toEqual([-3_456_789, 1_800_000_000, -1_800_000_000]);
    expect(Array.from(frame.latE7)).toEqual([515_074_000, -338_688_000, 900_000_000]);
    expect(Array.from(frame.alt)).toEqual([1400, -4, 32767]);
    expect(Array.from(frame.heading)).toEqual([9050, 0, 0xffff]);
    expect(Array.from(frame.speed)).toEqual([2345, 0, 65535]);
    expect(Array.from(frame.vrate)).toEqual([-12, 0, 127]);
    expect(Array.from(frame.age)).toEqual([0, 3, 255]);
    expect(Array.from(frame.category)).toEqual([4, 1, 0]);
    expect(Array.from(frame.entityFlags)).toEqual([0, 1, 10]);
  });

  test("is exactly header plus 22 bytes per entity", () => {
    expect(fixtures["upsert-aircraft"].byteLength).toBe(HEADER_BYTES + 3 * UPSERT_RECORD_BYTES);
    expect(fixtures["upsert-empty"].byteLength).toBe(HEADER_BYTES);
  });

  test("views the message buffer instead of copying", () => {
    const buffer = fixtures["upsert-aircraft"].slice(0);
    const frame = decodeFrame(buffer) as UpsertFrame;
    expect(frame.ids.buffer).toBe(buffer);
    expect(frame.lonE7.buffer).toBe(buffer);
  });

  test("an empty full upsert decodes to zero-length columns", () => {
    const frame = decodeFrame(fixtures["upsert-empty"]) as UpsertFrame;
    expect(frame.count).toBe(0);
    expect(frame.full).toBe(true);
    expect(frame.ids.length).toBe(0);
  });

  test("a delta upsert is not flagged full", () => {
    const frame = decodeFrame(fixtures["upsert-ship-delta"]) as UpsertFrame;
    expect(frame.full).toBe(false);
    expect(frame.kind).toBe(EntityKind.Ship);
  });

  test("rejects a frame whose count overruns the buffer", () => {
    const truncated = fixtures["upsert-aircraft"].slice(0, HEADER_BYTES + 10);
    expect(() => decodeFrame(truncated)).toThrow(/truncated/);
  });

  test("converts wire units to SI", () => {
    const update = upsertToUpdate(decodeFrame(fixtures["upsert-aircraft"]) as UpsertFrame, "test");
    const c = update.columns;
    expect(c.lon[0]).toBeCloseTo(-0.3456789, 5);
    expect(c.lat[0]).toBeCloseTo(51.5074, 4);
    expect(c.alt[0]).toBeCloseTo(1400 * 7.62, 1); // 35,000 ft
    expect(c.heading[0]).toBeCloseTo(90.5, 3);
    expect(c.speed[0]).toBeCloseTo(234.5, 2);
    expect(c.vrate[0]).toBeCloseTo(-6, 5);
    expect(c.fixTimeMs[1]).toBe(FIXTURE_TIME_MS - 3000);
    expect(Number.isNaN(c.heading[2])).toBe(true);
    expect(update.source).toBe("test");
  });

  test("SI columns survive a round trip within quantisation error", () => {
    const columns = createColumns(2);
    columns.ids.set([10, 20]);
    columns.lon.set([-179.99999, 23.727539]);
    columns.lat.set([-89.5, 37.98381]);
    columns.alt.set([11_582.4, 0]);
    columns.heading[0] = 359.999;
    columns.heading[1] = Number.NaN;
    columns.speed.set([257.2, 7.5]);
    columns.vrate.set([-9.8, 0]);
    columns.fixTimeMs.set([FIXTURE_TIME_MS - 2000, FIXTURE_TIME_MS - 900_000]);
    columns.category.set([3, 1]);
    columns.flags.set([2, 1]);
    const buffer = updateToUpsert({
      kind: EntityKind.Aircraft,
      source: "t",
      timeMs: FIXTURE_TIME_MS,
      full: false,
      count: 2,
      columns,
    });
    const back = upsertToUpdate(decodeFrame(buffer) as UpsertFrame, "t").columns;
    expect(back.lon[0]).toBeCloseTo(-179.99999, 4);
    expect(back.lat[1]).toBeCloseTo(37.98381, 4);
    expect(back.alt[0]).toBeCloseTo(11_582.4, 0);
    expect(back.heading[0]).toBe(0); // 359.999 rounds to 360, which wraps to north
    expect(Number.isNaN(back.heading[1])).toBe(true);
    expect(back.speed[0]).toBeCloseTo(257.2, 1);
    expect(back.vrate[0]).toBeCloseTo(-10, 5);
    expect(back.fixTimeMs[0]).toBe(FIXTURE_TIME_MS - 2000);
    expect(back.fixTimeMs[1]).toBe(FIXTURE_TIME_MS - 255_000); // age saturates
    expect(Array.from(back.flags)).toEqual([2, 1]);
  });

  test("out-of-range values clamp instead of wrapping", () => {
    const columns = createColumns(1);
    columns.alt[0] = 1e9;
    columns.speed[0] = 1e9;
    columns.vrate[0] = -1e9;
    columns.fixTimeMs[0] = FIXTURE_TIME_MS + 60_000; // fix from the future
    const frame = decodeFrame(
      updateToUpsert({
        kind: EntityKind.Aircraft,
        source: "t",
        timeMs: FIXTURE_TIME_MS,
        full: false,
        count: 1,
        columns,
      }),
    ) as UpsertFrame;
    expect(frame.alt[0]).toBe(32767);
    expect(frame.speed[0]).toBe(65535);
    expect(frame.vrate[0]).toBe(-127);
    expect(frame.age[0]).toBe(0);
  });
});

describe("remove, density, stats, events", () => {
  test("remove carries ids", () => {
    const frame = decodeFrame(fixtures.remove) as RemoveFrame;
    expect(Array.from(frame.ids)).toEqual([0x4ca7b5, 0xffffffff]);
  });

  test("density carries split cell indexes, centres and counts", () => {
    const frame = decodeFrame(fixtures.density) as DensityFrame;
    expect(frame.res).toBe(2);
    expect(Array.from(frame.cellLo)).toEqual([0xffffffff, 0x1fffffff]);
    expect(Array.from(frame.cellHi)).toEqual([0x0820007f, 0x08283473]);
    expect(Array.from(frame.lon)).toEqual([-122.5, 2.25]);
    expect(Array.from(frame.lat)).toEqual([37.75, 48.875]);
    expect(Array.from(frame.counts)).toEqual([42, 100_000]);
  });

  test("stats carries totals and upstream status", () => {
    const frame = decodeFrame(fixtures.stats) as StatsFrame;
    expect(frame.entries).toEqual([
      { kind: EntityKind.Aircraft, status: UpstreamStatus.Ok, total: 12_345 },
      { kind: EntityKind.Ship, status: UpstreamStatus.NeedsKey, total: 0 },
    ]);
  });

  test("events carries JSON", () => {
    const frame = decodeFrame(fixtures.events) as EventsFrame;
    expect(frame.events).toHaveLength(1);
    expect(frame.events[0].ref).toEqual({ kind: EntityKind.Aircraft, id: 0x4ca7b5 });
  });

  test("events with a corrupt body are rejected", () => {
    const bytes = new Uint8Array(fixtures.events.slice(0));
    bytes[HEADER_BYTES] = 0x7b; // "{" where "[" should be
    expect(() => decodeFrame(bytes.buffer)).toThrow(ProtocolError);
  });
});

describe("meta", () => {
  test("round-trips fields, including non-ASCII text and empty records", () => {
    const frame = decodeFrame(fixtures.meta) as MetaFrame;
    expect(frame.records).toEqual([
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
    ]);
    expect(metaToMap(frame).get(0x4ca7b5)?.label).toBe("EIN4KD");
  });

  test("field order in the input does not change the bytes", () => {
    const a = encodeMeta(EntityKind.Ship, 1, [{ id: 1, fields: { label: "A", imo: "9" } }]);
    const b = encodeMeta(EntityKind.Ship, 1, [{ id: 1, fields: { imo: "9", label: "A" } }]);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  test("long values are cut on a character boundary", () => {
    const long = "é".repeat(200); // 400 bytes
    const frame = decodeFrame(
      encodeMeta(EntityKind.Ship, 1, [{ id: 1, fields: { label: long } }]),
    ) as MetaFrame;
    const label = frame.records[0].fields.label as string;
    expect(new TextEncoder().encode(label).length).toBeLessThanOrEqual(META_MAX_FIELD_BYTES);
    expect(label).toBe("é".repeat(127));
  });

  test("unknown keys from a newer server are skipped, not fatal", () => {
    const bytes = new Uint8Array(
      encodeMeta(EntityKind.Ship, 1, [{ id: 1, fields: { label: "A", imo: "9" } }]).slice(0),
    );
    bytes[HEADER_BYTES + 5] = 250; // first field's key
    const frame = decodeFrame(bytes.buffer) as MetaFrame;
    expect(frame.records[0].fields).toEqual({ imo: "9" });
  });

  test("a truncated record is rejected", () => {
    expect(() => decodeFrame(fixtures.meta.slice(0, fixtures.meta.byteLength - 3))).toThrow(
      /truncated/,
    );
  });
});

test("columns stay aligned for odd counts, so clients can view them in place", () => {
  const n = 5;
  const z = Array.from({ length: n }, () => 0);
  const buffer = encodeUpsert({
    kind: 1,
    timeMs: 0,
    full: false,
    count: n,
    ids: z,
    lonE7: z,
    latE7: z,
    alt: z,
    heading: z,
    speed: z,
    vrate: z,
    age: z,
    category: z,
    entityFlags: z,
  });
  expect(HEADER_BYTES % 8).toBe(0);
  expect((HEADER_BYTES + n * 12) % 2).toBe(0);
  expect(() => decodeFrame(buffer)).not.toThrow();
});
