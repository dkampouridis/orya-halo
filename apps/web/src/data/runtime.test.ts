import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { EntityKind, LAYER_IDS, extrapolate, indexOfId } from "@orya-halo/schema";
import type {
  DataConfig,
  DataMessage,
  EntityDetail,
  HaloEvent,
  LayerId,
  LayerState,
  PathSet,
  RenderBatch,
  SearchResult,
  SourceContext,
  SourcePlugin,
  Track,
} from "@orya-halo/schema";
import type { PlaceSearch } from "./registry.ts";
import { DataRuntime } from "./runtime.ts";
import { fakeSource, makeUpdate } from "./testing.ts";

const T0 = 1_800_000_000_000;
const A = EntityKind.Aircraft;
const S = EntityKind.Ship;

interface Booted {
  runtime: DataRuntime;
  messages: DataMessage[];
  transfers: Transferable[][];
  batches(kind: EntityKind): RenderBatch[];
  layer(id: LayerId): LayerState | undefined;
  tracks(): (Track | null)[];
}

async function boot(
  options: {
    plugins?: SourcePlugin[];
    placeSearch?: PlaceSearch | null;
    enabled?: LayerId[];
    config?: Partial<DataConfig>;
    batchIntervalMs?: Partial<Record<EntityKind, number>>;
  } = {},
): Promise<Booted> {
  const messages: DataMessage[] = [];
  const transfers: Transferable[][] = [];
  const runtime = new DataRuntime({
    plugins: options.plugins ?? [],
    placeSearch: options.placeSearch ?? null,
    fetch: (async () => new Response("{}")) as typeof fetch,
    createSocket: () => {
      throw new Error("no gateway in this test");
    },
    cache: null,
    random: () => 0.5,
    ...(options.batchIntervalMs ? { batchIntervalMs: options.batchIntervalMs } : {}),
  });
  runtime.listen((message, transfer) => {
    messages.push(message);
    transfers.push(transfer);
  });
  const enabled = options.enabled ?? ["aircraft", "ships"];
  const layers = Object.fromEntries(LAYER_IDS.map((id) => [id, enabled.includes(id)])) as Record<
    LayerId,
    boolean
  >;
  await runtime.init({
    gatewayUrl: null,
    assetBase: "/assets/",
    keys: {},
    layers,
    historyMs: 30 * 60_000,
    ...options.config,
  });
  return {
    runtime,
    messages,
    transfers,
    batches: (kind) =>
      messages.flatMap((m) => (m.type === "batch" && m.batch.kind === kind ? [m.batch] : [])),
    layer: (id) => {
      const found = messages.filter((m) => m.type === "layer" && m.layer === id).pop();
      return found?.type === "layer" ? found.state : undefined;
    },
    tracks: () => messages.flatMap((m) => (m.type === "track" ? [m.track] : [])),
  };
}

function metres(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(
    (a[1] - b[1]) * 111_195,
    (a[0] - b[0]) * 111_195 * Math.cos((a[1] * Math.PI) / 180),
  );
}

/** A satellite-like compute source: one object circling the equator, positioned from the clock. */
function orbiter(recomputeRate = 1000): SourcePlugin {
  const position = (t: number) => (((((t / 1000) * 0.06) % 360) + 540) % 360) - 180;
  return {
    ...fakeSource({
      id: "test-orbits",
      layer: "satellites",
      transport: "compute",
      refreshRate: 0,
      recomputeRate,
      fetch: async () => ({ elements: "tle" }),
      normalise: (_raw, ctx) => ({
        type: "entities",
        update: makeUpdate(
          EntityKind.Satellite,
          "test-orbits",
          ctx.now(),
          [
            {
              id: 25544,
              lon: position(ctx.now()),
              lat: 0,
              alt: 420_000,
              heading: 90,
              speed: 6670,
              value: 92.9,
              meta: ISS,
            },
          ],
          { full: true },
        ),
      }),
    }),
    track: (_raw, id, ctx) => {
      const now = ctx.now();
      return {
        ref: { kind: EntityKind.Satellite, id },
        count: 3,
        positions: Float32Array.from([
          position(now),
          0,
          420_000,
          position(now + 60_000),
          0,
          420_000,
          position(now + 120_000),
          0,
          420_000,
        ]),
        timesMs: Float64Array.from([now, now + 60_000, now + 120_000]),
      };
    },
  };
}

const ISS = { label: "ISS (ZARYA)" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DataRuntime with synthetic traffic", () => {
  test("fills both gateway layers with moving objects and reports them live", async () => {
    const b = await boot({ config: { synthetic: 400 } });
    await vi.advanceTimersByTimeAsync(1200);
    const aircraft = b.batches(A);
    const ships = b.batches(S);
    expect(aircraft[0].count).toBe(400);
    expect(ships[0].count).toBe(400);
    expect(b.layer("aircraft")).toMatchObject({ status: "live", count: 400 });
    expect(b.layer("ships")).toMatchObject({ status: "live", count: 400 });

    // Speeds a person would believe: airliners and light aircraft, ships under 25 knots.
    const first = aircraft[0];
    let fast = 0;
    for (let i = 0; i < first.count; i++) {
      const speed = first.motion[i * 4 + 1];
      expect(speed).toBeGreaterThan(50);
      expect(speed).toBeLessThan(270);
      if (speed > 190) fast++;
      expect(Math.abs(first.positions[i * 3 + 1])).toBeLessThanOrEqual(75);
    }
    expect(fast).toBeGreaterThan(250);
    for (let i = 0; i < ships[0].count; i++) expect(ships[0].motion[i * 4 + 1]).toBeLessThan(13);
    b.runtime.dispose();
  });

  test("emits about one batch a second per kind, each continuous with the last", async () => {
    const b = await boot({ config: { synthetic: 300 } });
    await vi.advanceTimersByTimeAsync(10_500);
    const batches = b.batches(A);
    expect(batches.length).toBeGreaterThanOrEqual(9);
    expect(batches.length).toBeLessThanOrEqual(11);
    let corrected = 0;
    for (let k = 1; k < batches.length; k++) {
      const previous = batches[k - 1];
      const next = batches[k];
      expect(next.seq).toBe(previous.seq + 1);
      for (let i = 0; i < previous.count; i += 7) {
        const j = indexOfId(next, previous.ids[i]);
        // Where the new batch starts drawing is where the old one was drawing.
        expect(
          metres(extrapolate(previous, i, next.epochMs), extrapolate(next, j, next.epochMs)),
        ).toBeLessThan(2.5);
        if (next.blend[j * 3] !== 0 || next.blend[j * 3 + 1] !== 0) corrected++;
      }
    }
    // Updates arrive in subsets, and a new heading means a real correction to ease out.
    expect(corrected).toBeGreaterThan(20);
    b.runtime.dispose();
  });

  test("the batch rate per kind can be configured", async () => {
    const b = await boot({ config: { synthetic: 50 }, batchIntervalMs: { [A]: 4000 } });
    await vi.advanceTimersByTimeAsync(20_500);
    expect(b.batches(A).length).toBeGreaterThanOrEqual(5);
    expect(b.batches(A).length).toBeLessThanOrEqual(6);
    expect(b.batches(S).length).toBeGreaterThanOrEqual(19);
    b.runtime.dispose();
  });

  test("without a gateway or synthetic traffic, the gateway layers explain themselves", async () => {
    const b = await boot();
    expect(b.layer("aircraft")).toMatchObject({
      status: "offline",
      message: expect.stringContaining("No gateway is configured"),
    });
    b.runtime.dispose();
  });

  test("layers with nothing registered say so; the terminator needs no data", async () => {
    const b = await boot({ enabled: ["quakes", "nightlights", "radar"] });
    expect(b.layer("quakes")).toEqual({
      status: "error",
      count: null,
      message: "Earthquakes aren't available in this build.",
    });
    expect(b.layer("radar")).toEqual({
      status: "error",
      count: null,
      message: "Rain radar isn't available in this build.",
    });
    expect(b.layer("nightlights")).toEqual({ status: "live", count: null });
    expect(b.layer("aircraft")).toEqual({ status: "off", count: null });
    b.runtime.dispose();
  });

  test("layer state messages are throttled to about one a second", async () => {
    const b = await boot({ config: { synthetic: 100 } });
    await vi.advanceTimersByTimeAsync(20_000);
    const states = b.messages.filter((m) => m.type === "layer" && m.layer === "aircraft");
    expect(states.length).toBeGreaterThan(5);
    expect(states.length).toBeLessThanOrEqual(24);
    b.runtime.dispose();
  });
});

describe("DataRuntime clock and history", () => {
  test("announces the recorded range as keyframes accumulate", async () => {
    const b = await boot({ config: { synthetic: 50 } });
    await vi.advanceTimersByTimeAsync(5_100);
    const first = b.messages.find((m) => m.type === "history");
    expect(first).toEqual({ type: "history", fromMs: T0 + 5000, toMs: T0 + 5000 });
    await vi.advanceTimersByTimeAsync(120_000);
    const latest = b.messages.filter((m) => m.type === "history").pop();
    expect(latest).toMatchObject({ fromMs: T0 + 5000, toMs: T0 + 125_000 });
    b.runtime.dispose();
  });

  test("scrubbing replays recorded positions, freezes live batches and resumes cleanly", async () => {
    const b = await boot({ config: { synthetic: 200 } });
    await vi.advanceTimersByTimeAsync(180_000);
    // Remember a live batch from the past to compare the replay against.
    const live = b.batches(A).find((batch) => batch.epochMs >= T0 + 60_000) as RenderBatch;
    const scrubTo = live.epochMs + 500;

    const before = b.batches(A).length;
    b.runtime.setClock({ mode: "scrub", timeMs: scrubTo });
    await vi.advanceTimersByTimeAsync(60);
    const replay = b.batches(A)[before];
    expect(replay.epochMs).toBe(scrubTo);
    expect(replay.count).toBe(200);
    expect(replay.seq).toBeGreaterThan(b.batches(A)[before - 1].seq);
    let worst = 0;
    for (let i = 0; i < live.count; i++) {
      const j = indexOfId(replay, live.ids[i]);
      expect(j).toBeGreaterThanOrEqual(0);
      worst = Math.max(
        worst,
        metres(extrapolate(replay, j, scrubTo), extrapolate(live, i, scrubTo)),
      );
    }
    // Twenty-second keyframes of aircraft that keep nudging their heading: a few hundred metres.
    expect(worst).toBeLessThan(1500);
    // A replayed batch holds still at the scrubbed time and eases nothing.
    expect(replay.motion[3]).toBe(0);
    expect(replay.blend[0]).toBe(0);

    // The feed keeps arriving, but nothing live is drawn over the replay.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(b.batches(A).length).toBe(before + 1);
    expect(b.batches(S).filter((batch) => batch.epochMs > T0 + 180_000)).toHaveLength(0);
    // Dragging the handle rebuilds, at most every 50 ms.
    for (let i = 1; i <= 10; i++) b.runtime.setClock({ mode: "scrub", timeMs: scrubTo + i * 100 });
    await vi.advanceTimersByTimeAsync(60);
    expect(b.batches(A).length).toBe(before + 2);
    expect(b.batches(A)[before + 1].epochMs).toBe(scrubTo + 1000);

    b.runtime.setClock({ mode: "live", timeMs: Date.now() });
    await vi.advanceTimersByTimeAsync(10);
    const resumed = b.batches(A)[before + 2];
    expect(resumed.epochMs).toBe(Date.now() - 10);
    expect(resumed.count).toBe(200);
    // Straight to the live fixes: no glide from wherever the replay left things.
    for (let i = 0; i < resumed.count; i++) expect(resumed.blend[i * 3]).toBe(0);
    // And live batches flow again, with blending back.
    await vi.advanceTimersByTimeAsync(3000);
    expect(b.batches(A).length).toBeGreaterThanOrEqual(before + 5);
    b.runtime.dispose();
  });

  test("live clock ticks from the main thread change nothing", async () => {
    const b = await boot({ config: { synthetic: 50 } });
    await vi.advanceTimersByTimeAsync(3000);
    const count = b.messages.length;
    b.runtime.setClock({ mode: "live", timeMs: Date.now() });
    b.runtime.setClock({ mode: "live", timeMs: Date.now() + 1000 });
    expect(b.messages.length).toBe(count);
    b.runtime.dispose();
  });

  test("a clock-driven source is recomputed for the scrubbed moment", async () => {
    const b = await boot({ plugins: [orbiter()], enabled: ["satellites"] });
    await vi.advanceTimersByTimeAsync(3100);
    const live = b.batches(EntityKind.Satellite);
    expect(live.length).toBe(4);
    expect(b.layer("satellites")).toMatchObject({ status: "live", count: 1 });

    const past = T0 - 20 * 60_000;
    b.runtime.setClock({ mode: "scrub", timeMs: past });
    await vi.advanceTimersByTimeAsync(60);
    const replay = b.batches(EntityKind.Satellite).pop() as RenderBatch;
    expect(replay.epochMs).toBe(past);
    // 0.06 degrees of longitude a second, twenty minutes earlier.
    const expected = (((((past / 1000) * 0.06) % 360) + 540) % 360) - 180;
    expect(replay.positions[0]).toBeCloseTo(expected, 3);
    expect([replay.blend[0], replay.blend[1]]).toEqual([0, 0]);
    // Standing still on the tape: no further recomputes.
    const count = b.batches(EntityKind.Satellite).length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(b.batches(EntityKind.Satellite).length).toBe(count);

    b.runtime.setClock({ mode: "live", timeMs: Date.now() });
    await vi.advanceTimersByTimeAsync(1100);
    const back = b.batches(EntityKind.Satellite).pop() as RenderBatch;
    expect(back.epochMs).toBeGreaterThan(T0);
    expect(b.batches(EntityKind.Satellite).length).toBeGreaterThan(count);
    b.runtime.dispose();
  });

  test("a clock-driven source sets the batch rate for its kind", async () => {
    const b = await boot({ plugins: [orbiter(250)], enabled: ["satellites"] });
    await vi.advanceTimersByTimeAsync(2050);
    // Recomputed four times a second, drawn four times a second.
    expect(b.batches(EntityKind.Satellite).length).toBeGreaterThanOrEqual(8);
    const batches = b.batches(EntityKind.Satellite);
    const last = batches[batches.length - 1];
    const previous = batches[batches.length - 2];
    // Each recompute is a correction of the last straight-line guess, eased, never a jump.
    expect(
      metres(extrapolate(previous, 0, last.epochMs), extrapolate(last, 0, last.epochMs)),
    ).toBeLessThan(3);
    b.runtime.dispose();
  });

  test("while the tab is hidden nothing is sent; on return the latest state is", async () => {
    const b = await boot({ config: { synthetic: 100 } });
    await vi.advanceTimersByTimeAsync(3000);
    b.runtime.setVisible(false);
    const count = b.batches(A).length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(b.batches(A).length).toBe(count);
    b.runtime.setVisible(true);
    await vi.advanceTimersByTimeAsync(50);
    const batches = b.batches(A);
    expect(batches.length).toBeGreaterThan(count);
    const fresh = batches[batches.length - 1];
    expect(fresh.epochMs).toBeGreaterThan(T0 + 120_000);
    // Two minutes on, nothing eases from where it was drawn before.
    for (let i = 0; i < fresh.count; i++) expect(fresh.blend[i * 3]).toBe(0);
    b.runtime.dispose();
  });
});

describe("DataRuntime tracks", () => {
  test("tracking sends the recorded path and extends it with new fixes", async () => {
    const b = await boot({ config: { synthetic: 30 } });
    await vi.advanceTimersByTimeAsync(130_000);
    const id = b.batches(A)[0].ids[0];
    b.runtime.setTracked({ kind: A, id });
    const first = b.tracks()[0] as Track;
    expect(first.ref).toEqual({ kind: A, id });
    // Keyframes at 5 s, 25 s, ... 125 s, plus the current fix.
    expect(first.count).toBeGreaterThanOrEqual(7);
    for (let i = 1; i < first.count; i++)
      expect(first.timesMs[i]).toBeGreaterThan(first.timesMs[i - 1]);
    expect(first.positions.length).toBe(first.count * 3);
    // The buffers are handed over, not copied.
    const transfer = b.transfers[b.messages.findIndex((m) => m.type === "track")];
    expect(transfer).toEqual([first.positions.buffer, first.timesMs.buffer]);

    await vi.advanceTimersByTimeAsync(30_000);
    const latest = b.tracks().pop() as Track;
    expect(latest.count).toBeGreaterThan(first.count);
    expect(latest.timesMs[latest.count - 1]).toBeGreaterThan(T0 + 150_000);

    b.runtime.setTracked(null);
    expect(b.tracks().pop()).toBeNull();
    const count = b.tracks().length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(b.tracks().length).toBe(count);
    b.runtime.dispose();
  });

  test("a plugin's own track (an orbit) is sent, and refreshed as time passes", async () => {
    const b = await boot({ plugins: [orbiter()], enabled: ["satellites"] });
    await vi.advanceTimersByTimeAsync(1500);
    b.runtime.setTracked({ kind: EntityKind.Satellite, id: 25544 });
    const first = b.tracks()[0] as Track;
    // The live fix followed by the plugin's prediction for the next two minutes.
    expect(first.count).toBeGreaterThanOrEqual(3);
    expect(first.timesMs[first.count - 1]).toBe(Date.now() + 120_000);
    await vi.advanceTimersByTimeAsync(31_000);
    const later = b.tracks().pop() as Track;
    expect(later.timesMs[later.count - 1]).toBeGreaterThan(first.timesMs[first.count - 1] + 25_000);
    b.runtime.dispose();
  });

  test("switching the tracked layer off stops the track", async () => {
    const b = await boot({ config: { synthetic: 10 } });
    await vi.advanceTimersByTimeAsync(2000);
    b.runtime.setTracked({ kind: A, id: b.batches(A)[0].ids[0] });
    b.runtime.setLayerEnabled("aircraft", false);
    expect(b.tracks().pop()).toBeNull();
    b.runtime.dispose();
  });
});

describe("DataRuntime sources", () => {
  const quake = (id: number, title: string): HaloEvent => ({
    id: `quake-${id}`,
    topic: "quake",
    timeMs: T0,
    title,
  });

  test("events are forwarded once, however often the source repeats them", async () => {
    let poll = 0;
    const plugin = fakeSource({
      id: "usgs",
      refreshRate: 10_000,
      fetch: async () => ++poll,
      normalise: (raw, ctx) => ({
        type: "entities",
        update: makeUpdate(
          EntityKind.Quake,
          "usgs",
          ctx.now(),
          [{ id: 1, lon: 142, lat: 38, value: 6.1 }],
          { full: true },
        ),
        // Every poll repeats the whole feed; the third adds one new event.
        events:
          (raw as number) < 3
            ? [quake(1, "Magnitude 6.1 off Honshu")]
            : [quake(1, "Magnitude 6.1 off Honshu"), quake(2, "Magnitude 5.2 near Crete")],
      }),
    });
    const b = await boot({ plugins: [plugin], enabled: ["quakes"] });
    await vi.advanceTimersByTimeAsync(45_000);
    expect(poll).toBeGreaterThanOrEqual(4);
    const events = b.messages.flatMap((m) => (m.type === "events" ? m.events : []));
    expect(events.map((e) => e.id)).toEqual(["quake-1", "quake-2"]);
    expect(b.layer("quakes")).toMatchObject({ status: "live", count: 1 });
    b.runtime.dispose();
  });

  test("the remembered event ids are bounded", async () => {
    let poll = 0;
    const plugin = fakeSource({
      id: "busy",
      refreshRate: 1000,
      fetch: async () => ++poll,
      normalise: (raw, ctx) => ({
        type: "entities",
        update: makeUpdate(EntityKind.Quake, "busy", ctx.now(), [], { full: true }),
        events: Array.from({ length: 50 }, (_, i) => quake((raw as number) * 100 + i, "x")),
      }),
    });
    const b = await boot({ plugins: [plugin], enabled: ["quakes"] });
    await vi.advanceTimersByTimeAsync(200_000);
    expect(poll).toBeGreaterThan(100);
    expect(b.runtime.memoryStats().seenEvents).toBeLessThanOrEqual(2048);
    expect(b.runtime.memoryStats().seenEventOrder).toBeLessThanOrEqual(2048);
    b.runtime.dispose();
  });

  test("two sources feed one kind; switching the layer off clears both", async () => {
    const source = (id: string, ids: number[]) =>
      fakeSource({
        id,
        refreshRate: 60_000,
        fetch: async () => 1,
        normalise: (_raw, ctx) => ({
          type: "entities",
          update: makeUpdate(
            EntityKind.Quake,
            id,
            ctx.now(),
            ids.map((n) => ({ id: n })),
            { full: true },
          ),
        }),
      });
    const b = await boot({
      plugins: [source("usgs", [1, 2, 3]), source("emsc", [3, 4])],
      enabled: ["quakes"],
    });
    await vi.advanceTimersByTimeAsync(1200);
    expect(b.layer("quakes")).toMatchObject({ status: "live", count: 4 });
    expect((b.batches(EntityKind.Quake).pop() as RenderBatch).count).toBe(4);
    b.runtime.setLayerEnabled("quakes", false);
    expect((b.batches(EntityKind.Quake).pop() as RenderBatch).count).toBe(0);
    expect(b.layer("quakes")).toEqual({ status: "off", count: null });
    b.runtime.setLayerEnabled("quakes", true);
    await vi.advanceTimersByTimeAsync(1200);
    expect((b.batches(EntityKind.Quake).pop() as RenderBatch).count).toBe(4);
    b.runtime.dispose();
  });

  test("one source failing while another works reads as partial data", async () => {
    const good = fakeSource({
      id: "usgs",
      fetch: async () => 1,
      normalise: (_raw, ctx) => ({
        type: "entities",
        update: makeUpdate(EntityKind.Quake, "usgs", ctx.now(), [{ id: 1 }], { full: true }),
      }),
    });
    const bad = fakeSource({
      id: "emsc",
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const b = await boot({ plugins: [good, bad], enabled: ["quakes"] });
    await vi.advanceTimersByTimeAsync(1200);
    expect(b.layer("quakes")).toMatchObject({
      status: "degraded",
      count: 1,
      message: expect.stringContaining("Earthquakes are offline"),
    });
    b.runtime.dispose();
  });

  test("paths are sent, counted, searchable and selectable", async () => {
    const cables: PathSet = {
      count: 2,
      ids: Uint32Array.of(101, 102),
      startIndices: Uint32Array.of(0, 3, 5),
      positions: Float32Array.of(-9, 38, -30, 40, -74, 40, 103, 1, 80, 13),
      names: ["MAREA", "SeaMeWe-6"],
      meta: [
        { lengthKm: 6600, owners: "Meta, Microsoft, Telxius", rfs: 2018 },
        { lengthKm: 19_200 },
      ],
    };
    const plugin: SourcePlugin = {
      ...fakeSource({
        id: "cables",
        layer: "cables",
        transport: "static",
        refreshRate: 0,
        fetch: async () => 1,
        normalise: () => ({ type: "paths", paths: cables }),
      }),
      schema: [
        { key: "lengthKm", label: "Length", type: "number", unit: "km" },
        { key: "owners", label: "Owners", type: "string" },
        { key: "rfs", label: "In service since", type: "string" },
      ],
    };
    const b = await boot({ plugins: [plugin], enabled: ["cables"] });
    await vi.advanceTimersByTimeAsync(100);
    const message = b.messages.find((m) => m.type === "paths");
    expect(message).toMatchObject({
      type: "paths",
      layer: "cables",
      paths: { count: 2, names: ["MAREA", "SeaMeWe-6"] },
    });
    // The plugin's own arrays must still be intact afterwards.
    expect(cables.positions.length).toBe(10);
    expect(b.transfers[b.messages.indexOf(message as DataMessage)]).toEqual([]);
    expect(b.layer("cables")).toMatchObject({ status: "live", count: 2 });

    const results = await b.runtime.search("mar");
    expect(results).toEqual([
      {
        type: "entity",
        ref: { kind: EntityKind.Cable, id: 101 },
        layer: "cables",
        title: "MAREA",
        subtitle: "Undersea cables",
        lon: -30,
        lat: 40,
        score: 88,
      },
    ]);
    const detail = (await b.runtime.getDetail({ kind: EntityKind.Cable, id: 101 })) as EntityDetail;
    expect(detail).toMatchObject({
      title: "MAREA",
      layer: "cables",
      lon: -30,
      lat: 40,
      heading: null,
      attribution: { text: "Test Provider" },
    });
    expect(detail.fields).toEqual([
      { key: "lengthKm", label: "Length", value: "6,600", unit: "km", numeric: 6600 },
      { key: "owners", label: "Owners", value: "Meta, Microsoft, Telxius" },
      { key: "rfs", label: "In service since", value: "2018" },
    ]);
    expect(await b.runtime.getDetail({ kind: EntityKind.Cable, id: 999 })).toBeNull();
    b.runtime.dispose();
  });

  test("tile overlays are passed through, and withdrawn when the layer goes off", async () => {
    const overlay = {
      tiles: ["https://tiles.example/{z}/{x}/{y}.png"],
      tileSize: 256 as const,
      minZoom: 0,
      maxZoom: 7,
      opacity: 0.7,
    };
    const plugin = fakeSource({
      id: "radar",
      layer: "radar",
      fetch: async () => 1,
      normalise: () => ({ type: "tiles", overlay }),
    });
    const b = await boot({ plugins: [plugin], enabled: ["radar"] });
    await vi.advanceTimersByTimeAsync(100);
    // The plugin named no credit of its own, so the overlay carries the plugin's.
    expect(b.messages.find((m) => m.type === "tiles")).toEqual({
      type: "tiles",
      layer: "radar",
      overlay: { ...overlay, attribution: { text: "Test Provider", url: "https://example.org" } },
    });
    expect(b.layer("radar")).toMatchObject({ status: "live", count: null });
    b.runtime.setLayerEnabled("radar", false);
    expect(b.messages.filter((m) => m.type === "tiles").pop()).toEqual({
      type: "tiles",
      layer: "radar",
      overlay: null,
    });
    b.runtime.dispose();
  });

  test("sources see the clock, the latest view and the asset base", async () => {
    let seen: SourceContext | null = null;
    const plugin = fakeSource({
      refreshRate: 1000,
      viewAware: true,
      fetch: async (ctx: SourceContext) => {
        seen = ctx;
        return 1;
      },
    });
    const b = await boot({ plugins: [plugin], enabled: ["quakes"] });
    b.runtime.setView({
      lon: 10,
      lat: 20,
      zoom: 4,
      bearing: 0,
      pitch: 0,
      bounds: [0, 10, 20, 30],
      global: false,
    });
    await vi.advanceTimersByTimeAsync(1100);
    const ctx = seen as unknown as SourceContext;
    expect(ctx.assetBase).toBe("/assets/");
    expect(ctx.view).toMatchObject({ lon: 10, lat: 20, zoom: 4, bounds: [0, 10, 20, 30] });
    expect(ctx.now()).toBe(Date.now());
    b.runtime.setClock({ mode: "scrub", timeMs: T0 - 5000 });
    expect(ctx.now()).toBe(T0 - 5000);
    b.runtime.dispose();
  });
});

describe("DataRuntime detail and search", () => {
  function quakes(detail?: SourcePlugin["detail"]): SourcePlugin {
    return {
      ...fakeSource({
        id: "usgs",
        fetch: async () => 1,
        normalise: (_raw, ctx) => ({
          type: "entities",
          update: makeUpdate(
            EntityKind.Quake,
            "usgs",
            ctx.now(),
            [
              {
                id: 1,
                lon: 142.4,
                lat: 38.3,
                alt: -29_000,
                value: 6.1,
                fixTimeMs: T0 - 60_000,
                meta: { label: "M 6.1 off Honshu", place: "112 km E of Sendai" },
              },
              { id: 2, lon: 142.9, lat: 38.1, value: 4.4, meta: { label: "M 4.4 off Honshu" } },
            ],
            { full: true },
          ),
        }),
      }),
      schema: [
        { key: "value", label: "Magnitude", type: "number" },
        { key: "place", label: "Where", type: "string" },
      ],
      ...(detail ? { detail } : {}),
    };
  }

  test("detail uses the owning plugin's schema, attribution and enrichment", async () => {
    const plugin = quakes(async (id, meta, ctx) => {
      expect(id).toBe(1);
      expect(meta?.label).toBe("M 6.1 off Honshu");
      expect(ctx.assetBase).toBe("/assets/");
      return {
        subtitle: "Felt by 412 people",
        sourceUrl: "https://earthquake.usgs.gov/1",
        fields: [{ key: "felt", label: "Felt reports", value: "412", numeric: 412 }],
      };
    });
    const b = await boot({ plugins: [plugin], enabled: ["quakes"] });
    await vi.advanceTimersByTimeAsync(100);
    const detail = (await b.runtime.getDetail({ kind: EntityKind.Quake, id: 1 })) as EntityDetail;
    expect(detail).toMatchObject({
      ref: { kind: EntityKind.Quake, id: 1 },
      layer: "quakes",
      title: "M 6.1 off Honshu",
      subtitle: "Felt by 412 people",
      alt: -29_000,
      speed: 0,
      heading: null,
      fixTimeMs: T0 - 60_000,
      attribution: { text: "Test Provider", url: "https://example.org" },
      sourceUrl: "https://earthquake.usgs.gov/1",
    });
    expect(detail.fields.map((f) => [f.label, f.value])).toEqual([
      ["Magnitude", "6.1"],
      ["Where", "112 km E of Sendai"],
      ["Felt reports", "412"],
    ]);
    expect(detail.nearby).toEqual([
      {
        ref: { kind: EntityKind.Quake, id: 2 },
        label: "M 4.4 off Honshu",
        distanceKm: expect.closeTo(49, 0),
      },
    ]);
    expect(await b.runtime.getDetail({ kind: EntityKind.Quake, id: 404 })).toBeNull();
    b.runtime.dispose();
  });

  test("a slow or failing detail lookup does not hold up the panel", async () => {
    let aborted = false;
    const slow = quakes(
      (_id, _meta, ctx) =>
        new Promise(() => {
          ctx.signal.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    );
    const b = await boot({ plugins: [slow], enabled: ["quakes"] });
    await vi.advanceTimersByTimeAsync(100);
    const pending = b.runtime.getDetail({ kind: EntityKind.Quake, id: 1 });
    await vi.advanceTimersByTimeAsync(2600);
    const detail = (await pending) as EntityDetail;
    expect(detail.title).toBe("M 6.1 off Honshu");
    expect(detail.fields).toHaveLength(2);
    expect(aborted).toBe(true);
    b.runtime.dispose();

    const broken = quakes(() => {
      throw new Error("boom");
    });
    const c = await boot({ plugins: [broken], enabled: ["quakes"] });
    await vi.advanceTimersByTimeAsync(100);
    expect(
      ((await c.runtime.getDetail({ kind: EntityKind.Quake, id: 2 })) as EntityDetail).title,
    ).toBe("M 4.4 off Honshu");
    c.runtime.dispose();
  });

  test("search merges loaded objects with places", async () => {
    const calls: unknown[][] = [];
    const places: PlaceSearch = (query, limit, near) => {
      calls.push([query, limit, near]);
      const hits: SearchResult[] = [
        {
          type: "place",
          title: "Honolulu",
          subtitle: "Hawaii, United States",
          lon: -157.86,
          lat: 21.31,
          zoom: 9,
          score: 80,
        },
      ];
      return hits;
    };
    const b = await boot({ plugins: [quakes()], placeSearch: places, enabled: ["quakes"] });
    await vi.advanceTimersByTimeAsync(100);
    const results = await b.runtime.search("hon", { lon: 140, lat: 38 });
    expect(calls).toEqual([["hon", 20, { lon: 140, lat: 38 }]]);
    expect(results.map((r) => [r.type, r.title])).toEqual([
      ["place", "Honolulu"],
      // Equal matches on the name: the one nearer the camera comes first.
      ["entity", "M 6.1 off Honshu"],
      ["entity", "M 4.4 off Honshu"],
    ]);
    expect(await b.runtime.search("  ")).toEqual([]);
    b.runtime.dispose();
  });

  test("a place search that hangs or throws is left out", async () => {
    const hanging: PlaceSearch = () => new Promise(() => {});
    const b = await boot({ plugins: [quakes()], placeSearch: hanging, enabled: ["quakes"] });
    await vi.advanceTimersByTimeAsync(100);
    const pending = b.runtime.search("honshu");
    await vi.advanceTimersByTimeAsync(1600);
    expect((await pending).map((r) => r.type)).toEqual(["entity", "entity"]);
    b.runtime.dispose();

    const throwing: PlaceSearch = () => {
      throw new Error("index not loaded");
    };
    const c = await boot({ plugins: [quakes()], placeSearch: throwing, enabled: ["quakes"] });
    await vi.advanceTimersByTimeAsync(100);
    expect(await c.runtime.search("honshu")).toHaveLength(2);
    c.runtime.dispose();
  });

  test("attributions list every registered source, and synthetic traffic only when it runs", async () => {
    const b = await boot({ plugins: [quakes()], enabled: ["quakes"] });
    expect(await b.runtime.getAttributions()).toEqual([
      {
        id: "usgs",
        name: "Test Provider",
        layer: "quakes",
        licence: "Test",
        licenceUrl: "https://example.org/licence",
        attribution: "Test Provider",
        attributionUrl: "https://example.org",
        docs: "https://example.org/docs",
      },
    ]);
    b.runtime.dispose();
    const c = await boot({ config: { synthetic: 5 } });
    expect((await c.runtime.getAttributions()).map((s) => s.id)).toEqual([
      "synthetic-aircraft",
      "synthetic-ships",
    ]);
    c.runtime.dispose();
  });

  test("dispose stops everything: no timers left, no more messages", async () => {
    const b = await boot({
      plugins: [orbiter()],
      enabled: ["satellites", "aircraft", "ships"],
      config: { synthetic: 20 },
    });
    await vi.advanceTimersByTimeAsync(3000);
    b.runtime.dispose();
    const count = b.messages.length;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.messages.length).toBe(count);
  });
});

describe("DataRuntime memory", () => {
  test("an hour of churning traffic leaves every buffer and map the size it was", async () => {
    // 600 aircraft live at any time from a feed whose population turns over
    // (five leave and five arrive each second: 18,000 distinct aircraft in the
    // hour), each with meta and an event, plus steady synthetic traffic.
    let tick = 0;
    const churn = fakeSource({
      id: "churn",
      layer: "aircraft",
      refreshRate: 1000,
      fetch: async () => ++tick,
      normalise: (raw, ctx) => {
        const first = (raw as number) * 5;
        const now = ctx.now();
        const rows = [];
        for (let i = 0; i < 600; i++) {
          const id = 1_000_000 + first + i;
          rows.push({
            id,
            lon: (id % 360) - 180,
            lat: (id % 140) - 70,
            heading: id % 360,
            speed: 200,
            fixTimeMs: now,
            meta: { label: `CHN${id}` },
          });
        }
        return {
          type: "entities",
          update: makeUpdate(A, "churn", now, rows, { full: true }),
          events: [{ id: `arrival-${first}`, topic: "test", timeMs: now, title: "x" }],
        };
      },
    });
    const b = await boot({ plugins: [churn], config: { synthetic: 800, historyMs: 10 * 60_000 } });
    b.runtime.setTracked({ kind: A, id: 0xf00000 });
    let batchBytes = 0;
    const samples: Record<string, number>[] = [];
    for (let minute = 1; minute <= 60; minute++) {
      // Drop what was received, as the renderer does once a batch is replaced.
      b.messages.length = 0;
      b.transfers.length = 0;
      await vi.advanceTimersByTimeAsync(60_000);
      samples.push(b.runtime.memoryStats());
      if (minute === 60)
        for (const batch of b.batches(A))
          batchBytes = Math.max(batchBytes, batch.positions.byteLength);
    }
    expect(tick).toBeGreaterThan(3400);
    // Two lists are capped rather than windowed, and take longer than the
    // history window to fill: remembered event ids and the tracked path.
    const capped = ["seenEvents", "seenEventOrder", "trackPoints"];
    const windowed = (sample: Record<string, number>) =>
      Object.fromEntries(Object.entries(sample).filter(([key]) => !capped.includes(key)));
    // Steady state is reached once the ten-minute history window has turned over.
    const settled = samples[14];
    const end = samples[59];
    expect(windowed(end)).toEqual(windowed(settled));
    expect(windowed(samples[36])).toEqual(windowed(settled));
    expect(end.seenEvents).toBe(2048);
    expect(samples[44].seenEvents).toBe(2048);
    expect(end.seenEventOrder).toBe(2048);
    // And the sizes are the modest ones expected, not merely stable.
    expect(end[`store${A}.count`]).toBe(1400);
    expect(end[`store${A}.meta`]).toBeLessThanOrEqual(2048);
    expect(end[`store${A}.bytes`]).toBeLessThan(400_000);
    expect(end[`ring${A}.slots`]).toBeLessThanOrEqual(8192);
    expect(end.seenEvents).toBeLessThanOrEqual(2048);
    expect(end.trackPoints).toBeLessThanOrEqual(2048);
    expect(batchBytes).toBe(1400 * 12);
    b.runtime.dispose();
  }, 120_000);
});
