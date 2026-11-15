/**
 * The hover summary, the detail rows a plugin curates, the rows added for
 * gateway layers, and the aircraft photo in the detail panel.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { EntityKind, LAYER_IDS, UpstreamStatus, encodeMeta, encodeUpsert } from "@orya-halo/schema";
import type {
  DataMessage,
  DetailMedia,
  EntityDetail,
  LayerId,
  PathSet,
  SchemaField,
  SourcePlugin,
} from "@orya-halo/schema";
import { buildDetail, buildSummary, gatewaySchema, mergeDetail } from "./detail.ts";
import type { SocketLike } from "./gateway.ts";
import type { AircraftPhotos } from "./photos.ts";
import { DataRuntime } from "./runtime.ts";
import { EntityStore } from "./store.ts";
import { fakeSource, makeUpdate } from "./testing.ts";

const T0 = 1_800_000_000_000;

function storeWith(kind: EntityKind, row: Parameters<typeof makeUpdate>[3][number]): EntityStore {
  const store = new EntityStore(kind);
  store.apply(makeUpdate(kind, "test", T0, [row], { full: true }), T0);
  return store;
}

describe("buildSummary", () => {
  test("aircraft: callsign and altitude in metres", () => {
    const store = storeWith(EntityKind.Aircraft, {
      id: 0x4ca7b5,
      alt: 10_972.8,
      speed: 230,
      meta: { label: "RYR4TK" },
    });
    expect(buildSummary(store, 0)).toEqual({
      ref: { kind: EntityKind.Aircraft, id: 0x4ca7b5 },
      layer: "aircraft",
      title: "RYR4TK",
      value: "10,973",
      unit: "m",
    });
  });

  test("ships: name and speed in knots", () => {
    const store = storeWith(EntityKind.Ship, {
      id: 230949000,
      speed: 5.4,
      meta: { label: "HELGA" },
    });
    expect(buildSummary(store, 0)).toMatchObject({
      layer: "ships",
      title: "HELGA",
      value: "10.5",
      unit: "kn",
    });
  });

  test("satellites: name and altitude in kilometres", () => {
    const store = storeWith(EntityKind.Satellite, {
      id: 25544,
      alt: 422_674,
      meta: { label: "ISS (ZARYA)" },
    });
    expect(buildSummary(store, 0)).toMatchObject({
      layer: "satellites",
      title: "ISS (ZARYA)",
      value: "423",
      unit: "km",
    });
  });

  test("earthquakes: place and magnitude, written as seismologists write it", () => {
    const store = storeWith(EntityKind.Quake, {
      id: 7,
      value: 6.4,
      alt: -17_000,
      meta: { label: "30 km WSW of Lata, Solomon Islands" },
    });
    const summary = buildSummary(store, 0);
    expect(summary).toMatchObject({
      layer: "quakes",
      title: "30 km WSW of Lata, Solomon Islands",
      value: "M6.4",
    });
    expect(summary.unit).toBeUndefined();
  });

  test("other kinds have a name and no number; an unnamed object is named by kind and id", () => {
    const webcam = buildSummary(
      storeWith(EntityKind.Webcam, { id: 9, value: 3, meta: { label: "Sotkamo Pohjavaara" } }),
      0,
    );
    expect(webcam).toEqual({
      ref: { kind: EntityKind.Webcam, id: 9 },
      layer: "webcams",
      title: "Sotkamo Pohjavaara",
    });
    const fire = buildSummary(
      storeWith(EntityKind.Fire, {
        id: 11,
        value: 54.2,
        meta: { label: "Fire at 12.30°S, 131.00°E" },
      }),
      0,
    );
    expect(fire.value).toBeUndefined();
    const unnamed = buildSummary(storeWith(EntityKind.Aircraft, { id: 0xabc123, alt: 300 }), 0);
    expect(unnamed).toMatchObject({ title: "Aircraft ABC123", value: "300", unit: "m" });
  });
});

describe("mergeDetail with a plugin's own schema", () => {
  const schema: SchemaField[] = [
    { key: "label", label: "Place", type: "string" },
    { key: "magnitude", label: "Magnitude", type: "number" },
    { key: "timeMs", label: "Time", type: "time" },
    { key: "url", label: "USGS event page", type: "url" },
  ];
  const base = (): EntityDetail => {
    const store = storeWith(EntityKind.Quake, {
      id: 1,
      value: 6.4,
      meta: {
        label: "Off Honshu",
        magnitude: 6.4,
        timeMs: T0 - 60_000,
        url: "https://earthquake.usgs.gov/1",
      },
    });
    return buildDetail(store, 0, schema, { text: "USGS", url: "" }, [store]);
  };

  test("a plugin that restates its schema's rows has chosen them: its list is the list", () => {
    // What the earthquake plugin does: every schema row except the time, which is in its subtitle.
    const merged = mergeDetail(
      base(),
      {
        subtitle: "Magnitude 6.4, 2027-01-15 08:00 UTC",
        fields: [
          { key: "magnitude", label: "Magnitude", value: "6.4", numeric: 6.4 },
          { key: "url", label: "USGS event page", value: "https://earthquake.usgs.gov/1" },
        ],
      },
      schema,
    );
    expect(merged.fields.map((f) => f.key)).toEqual(["magnitude", "url"]);
  });

  test("rows the plugin's schema does not cover survive a curated list, after it", () => {
    const withExtra = base();
    withExtra.fields.push({ key: "id", label: "ICAO address", value: "ABC123" });
    const merged = mergeDetail(
      withExtra,
      {
        fields: [
          { key: "magnitude", label: "Magnitude", value: "6.4" },
          { key: "felt", label: "Felt reports", value: "12" },
        ],
      },
      schema,
    );
    expect(merged.fields.map((f) => f.key)).toEqual(["magnitude", "felt", "id"]);
  });

  test("a plugin that only adds rows keeps the schema's rows, and its additions follow", () => {
    const merged = mergeDetail(
      base(),
      { fields: [{ key: "felt", label: "Felt reports", value: "412" }] },
      schema,
    );
    expect(merged.fields.map((f) => f.key)).toEqual([
      "label",
      "magnitude",
      "timeMs",
      "url",
      "felt",
    ]);
  });
});

describe("gatewaySchema", () => {
  test("adds the rows a gateway plugin leaves to the wire, once", () => {
    const plugin: SchemaField[] = [{ key: "label", label: "Callsign", type: "string" }];
    expect(gatewaySchema(EntityKind.Aircraft, plugin).map((f) => f.key)).toEqual([
      "label",
      "vrate",
      "id",
    ]);
    expect(gatewaySchema(EntityKind.Ship, plugin).map((f) => f.key)).toEqual(["label", "id"]);
    const own: SchemaField[] = [...plugin, { key: "id", label: "Hex", type: "string" }];
    expect(gatewaySchema(EntityKind.Aircraft, own).map((f) => f.label)).toEqual([
      "Callsign",
      "Hex",
      "Vertical rate",
    ]);
    expect(gatewaySchema(EntityKind.Quake, plugin)).toBe(plugin);
  });

  test("vertical rate in metres per second keeps one decimal", () => {
    const store = storeWith(EntityKind.Aircraft, { id: 1, vrate: -3.25, alt: 3000 });
    const detail = buildDetail(
      store,
      0,
      gatewaySchema(EntityKind.Aircraft, []),
      { text: "", url: "" },
      [store],
    );
    expect(detail.fields).toEqual([
      { key: "vrate", label: "Vertical rate", value: "-3.3", unit: "m/s", numeric: -3.25 },
      { key: "id", label: "ICAO address", value: "000001" },
    ]);
  });
});

class Socket implements SocketLike {
  binaryType = "";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  send(): void {}
  close(): void {}
  hello(): void {
    this.onmessage?.({
      data: JSON.stringify({
        t: "hello",
        v: 1,
        tickMs: 1000,
        maxCells: 2000,
        densityRes: 2,
        layers: {
          aircraft: { status: UpstreamStatus.Ok, attribution: "adsb.lol (ODbL)" },
          ships: { status: UpstreamStatus.Ok, attribution: "Digitraffic" },
        },
      }),
    });
  }
}

const PHOTO: DetailMedia = {
  type: "image",
  url: "https://t.plnspttrs.net/00000/0000001_0123456789_280.jpg",
  link: "https://www.planespotters.net/photo/0000001/d-test?utm_source=api",
  credit: "Photo © Example Photographer, Planespotters.net",
  alt: "Photograph of aircraft 3C65A1",
};

async function withGateway(photos: AircraftPhotos | null, plugins: SourcePlugin[] = []) {
  const sockets: Socket[] = [];
  const messages: DataMessage[] = [];
  const runtime = new DataRuntime({
    plugins,
    placeSearch: null,
    fetch: (async () => new Response("", { status: 404 })) as typeof fetch,
    createSocket: () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    },
    cache: null,
    random: () => 1,
    photos,
  });
  runtime.listen((message) => messages.push(message));
  await runtime.init({
    gatewayUrl: "ws://gateway.test",
    assetBase: "/",
    keys: {},
    layers: Object.fromEntries(
      LAYER_IDS.map((id) => [id, id === "aircraft" || id === "ships" || id === "cables"]),
    ) as Record<LayerId, boolean>,
    historyMs: 30 * 60_000,
  });
  const socket = sockets[0];
  socket.hello();
  const frame = (kind: EntityKind, id: number) =>
    encodeUpsert({
      kind,
      timeMs: Date.now(),
      full: true,
      count: 1,
      ids: [id],
      lonE7: [86_000_000],
      latE7: [500_000_000],
      alt: [1400],
      heading: [9000],
      speed: [2200],
      vrate: [-4],
      age: [0],
      category: [3],
      entityFlags: [0],
    });
  socket.onmessage?.({ data: frame(EntityKind.Aircraft, 0x3c65a1) });
  socket.onmessage?.({
    data: encodeMeta(EntityKind.Aircraft, Date.now(), [
      { id: 0x3c65a1, fields: { label: "DLH400", registration: "D-AIMA" } },
    ]),
  });
  socket.onmessage?.({ data: frame(EntityKind.Ship, 230949000) });
  return { runtime, messages };
}

describe("aircraft photo in the detail panel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a photo that answers in time is the panel's media, with its credit and link", async () => {
    const asked: number[] = [];
    const photos: AircraftPhotos = {
      peek: () => undefined,
      lookup: async (icao) => {
        asked.push(icao);
        return PHOTO;
      },
    };
    const { runtime } = await withGateway(photos);
    const pending = runtime.getDetail({ kind: EntityKind.Aircraft, id: 0x3c65a1 });
    await vi.advanceTimersByTimeAsync(10);
    const detail = await pending;
    expect(detail?.title).toBe("DLH400");
    expect(detail?.media).toEqual([PHOTO]);
    expect(asked).toEqual([0x3c65a1]);
    // Ships are not aircraft: nobody is asked.
    const ship = runtime.getDetail({ kind: EntityKind.Ship, id: 230949000 });
    await vi.advanceTimersByTimeAsync(10);
    expect((await ship)?.media).toBeUndefined();
    expect(asked).toHaveLength(1);
    runtime.dispose();
  });

  test("a slow photo does not hold the panel; it is there on the next refresh", async () => {
    let done: ((media: DetailMedia) => void) | null = null;
    let cached: DetailMedia | null = null;
    const photos: AircraftPhotos = {
      peek: () => cached ?? undefined,
      lookup: () =>
        cached
          ? Promise.resolve(cached)
          : new Promise((resolve) => {
              done = (media) => {
                cached = media;
                resolve(media);
              };
            }),
    };
    const { runtime } = await withGateway(photos);
    const first = runtime.getDetail({ kind: EntityKind.Aircraft, id: 0x3c65a1 });
    // The photo wait is 1.2 s; the gateway's own detail (a 404 here) answered at once.
    await vi.advanceTimersByTimeAsync(1300);
    const detail = await first;
    expect(detail?.title).toBe("DLH400");
    expect(detail?.media).toBeUndefined();
    (done as ((media: DetailMedia) => void) | null)?.(PHOTO);
    const second = runtime.getDetail({ kind: EntityKind.Aircraft, id: 0x3c65a1 });
    await vi.advanceTimersByTimeAsync(10);
    expect((await second)?.media).toEqual([PHOTO]);
    runtime.dispose();
  });

  test("with no photo source the panel simply has no media", async () => {
    const { runtime } = await withGateway(null);
    const pending = runtime.getDetail({ kind: EntityKind.Aircraft, id: 0x3c65a1 });
    await vi.advanceTimersByTimeAsync(10);
    expect((await pending)?.media).toBeUndefined();
    runtime.dispose();
  });

  test("a gateway layer's plugin schema is completed with the vertical rate and the address", async () => {
    const plugin: SourcePlugin = {
      ...fakeSource({ id: "gateway-aircraft", layer: "aircraft", transport: "gateway" }),
      schema: [
        { key: "label", label: "Callsign", type: "string" },
        { key: "registration", label: "Registration", type: "string" },
      ],
    };
    const { runtime } = await withGateway(null, [plugin]);
    const pending = runtime.getDetail({ kind: EntityKind.Aircraft, id: 0x3c65a1 });
    await vi.advanceTimersByTimeAsync(10);
    const detail = await pending;
    expect(detail?.fields.map((f) => [f.label, f.value, f.unit])).toEqual([
      ["Callsign", "DLH400", undefined],
      ["Registration", "D-AIMA", undefined],
      ["Vertical rate", "-2.0", "m/s"],
      ["ICAO address", "3C65A1", undefined],
    ]);
    runtime.dispose();
  });
});

describe("getSummary through the runtime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("answers from what is loaded: entities, paths, and null for anything else", async () => {
    const paths: PathSet = {
      count: 1,
      ids: Uint32Array.of(199927125),
      startIndices: Uint32Array.of(0, 2),
      positions: Float32Array.of(-40, 45, -10, 50),
      names: ["Atlantic Crossing 1 (AC1)"],
    };
    const cables = fakeSource({
      id: "osm-cables",
      layer: "cables",
      transport: "static",
      refreshRate: 0,
      fetch: async () => 1,
      normalise: () => ({ type: "paths", paths }),
    });
    const { runtime } = await withGateway(null, [cables]);
    await vi.advanceTimersByTimeAsync(10);
    expect(await runtime.getSummary({ kind: EntityKind.Aircraft, id: 0x3c65a1 })).toEqual({
      ref: { kind: EntityKind.Aircraft, id: 0x3c65a1 },
      layer: "aircraft",
      title: "DLH400",
      value: "10,668",
      unit: "m",
    });
    expect(await runtime.getSummary({ kind: EntityKind.Ship, id: 230949000 })).toMatchObject({
      title: "Ship 230949000",
      // The helper frame gives everything 220 m/s; what matters is the unit and the decimal.
      value: "427.6",
      unit: "kn",
    });
    expect(await runtime.getSummary({ kind: EntityKind.Cable, id: 199927125 })).toEqual({
      ref: { kind: EntityKind.Cable, id: 199927125 },
      layer: "cables",
      title: "Atlantic Crossing 1 (AC1)",
    });
    expect(await runtime.getSummary({ kind: EntityKind.Aircraft, id: 1 })).toBeNull();
    expect(await runtime.getSummary({ kind: EntityKind.Cable, id: 1 })).toBeNull();
    runtime.dispose();
  });
});
