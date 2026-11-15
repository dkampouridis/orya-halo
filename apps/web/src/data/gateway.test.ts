import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { latLngToCell } from "h3-js";
import {
  EntityKind,
  FRAME_FLAG_DEFLATE,
  HEADER_BYTES,
  LAYER_IDS,
  UpstreamStatus,
  aircraftLiveryForCallsign,
  aircraftModelForType,
  encodeDensity,
  encodeEvents,
  encodeMeta,
  encodeRemove,
  encodeStats,
  encodeUpsert,
  inflateFrame,
  VesselModel,
  splitAircraftValue,
  splitShipValue,
  updateToUpsert,
  vesselScheme,
} from "@orya-halo/schema";
import type {
  ClientMessage,
  DataConfig,
  DataMessage,
  HaloEvent,
  LayerId,
  LayerState,
  RenderBatch,
  ViewState,
} from "@orya-halo/schema";
import { GATEWAY_SOURCE, parseGatewayEntity, parseGatewaySearch } from "./gateway.ts";
import type { SocketLike } from "./gateway.ts";
import { DataRuntime } from "./runtime.ts";
import { makeUpdate } from "./testing.ts";

/** Answers recorded from the gateway in mock mode on 2026-11-14 (tracks cut to their first points). */
function recorded(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

const T0 = 1_800_000_000_000;
const A = EntityKind.Aircraft;
const S = EntityKind.Ship;

class MockSocket implements SocketLike {
  binaryType = "";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  sent: ClientMessage[] = [];
  closed = false;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    if (this.closed) throw new Error("socket is closed");
    this.sent.push(JSON.parse(data) as ClientMessage);
  }

  close(): void {
    this.closed = true;
  }

  /** Server side: a JSON control message. */
  text(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  /** Server side: a binary frame. */
  frame(buffer: ArrayBuffer): void {
    this.onmessage?.({ data: buffer });
  }

  /** Server side: the connection drops. */
  drop(): void {
    this.closed = true;
    this.onclose?.();
  }

  hello(overrides: Record<string, unknown> = {}): void {
    this.onopen?.();
    this.text({
      t: "hello",
      v: 1,
      tickMs: 1000,
      maxCells: 2000,
      densityRes: 2,
      layers: {
        aircraft: {
          status: UpstreamStatus.Ok,
          attribution: "Aircraft positions: adsb.lol contributors (ODbL)",
        },
        ships: { status: UpstreamStatus.Ok, attribution: "Ship positions: AISStream" },
      },
      ...overrides,
    });
  }

  get subs(): Extract<ClientMessage, { t: "sub" }>[] {
    return this.sent.filter((m): m is Extract<ClientMessage, { t: "sub" }> => m.t === "sub");
  }
}

interface Harness {
  runtime: DataRuntime;
  sockets: MockSocket[];
  messages: DataMessage[];
  requests: string[];
  respond: (url: string) => Response | Promise<Response>;
  socket(): MockSocket;
  batches(kind: EntityKind): RenderBatch[];
  layer(id: LayerId): LayerState | undefined;
}

async function harness(
  overrides: Partial<DataConfig> = {},
  enabled: LayerId[] = ["aircraft", "ships"],
): Promise<Harness> {
  const sockets: MockSocket[] = [];
  const messages: DataMessage[] = [];
  const h: Harness = {
    sockets,
    messages,
    requests: [],
    respond: () => new Response("null", { status: 404 }),
    runtime: new DataRuntime({
      plugins: [],
      placeSearch: null,
      fetch: (async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : input.toString();
        h.requests.push(url);
        return h.respond(url);
      }) as typeof fetch,
      createSocket: (url) => {
        const socket = new MockSocket(url);
        sockets.push(socket);
        return socket;
      },
      cache: null,
      random: () => 1,
    }),
    socket: () => sockets[sockets.length - 1],
    batches: (kind) =>
      messages.flatMap((m) => (m.type === "batch" && m.batch.kind === kind ? [m.batch] : [])),
    layer: (id) => {
      const found = messages.filter((m) => m.type === "layer" && m.layer === id).pop();
      return found?.type === "layer" ? found.state : undefined;
    },
  };
  h.runtime.listen((message) => messages.push(message));
  const layers = Object.fromEntries(LAYER_IDS.map((id) => [id, enabled.includes(id)])) as Record<
    LayerId,
    boolean
  >;
  await h.runtime.init({
    gatewayUrl: "ws://gateway.test",
    assetBase: "/",
    keys: {},
    layers,
    historyMs: 30 * 60_000,
    ...overrides,
  });
  return h;
}

function upsert(
  kind: EntityKind,
  timeMs: number,
  full: boolean,
  rows: { id: number; lon: number; lat: number; heading?: number; speed?: number; age?: number }[],
): ArrayBuffer {
  return encodeUpsert({
    kind,
    timeMs,
    full,
    count: rows.length,
    ids: rows.map((r) => r.id),
    lonE7: rows.map((r) => Math.round(r.lon * 1e7)),
    latE7: rows.map((r) => Math.round(r.lat * 1e7)),
    alt: rows.map(() => 1400),
    heading: rows.map((r) => (r.heading === undefined ? 0xffff : r.heading * 100)),
    speed: rows.map((r) => (r.speed ?? 0) * 10),
    vrate: rows.map(() => 0),
    age: rows.map((r) => r.age ?? 0),
    category: rows.map(() => 3),
    entityFlags: rows.map(() => 0),
  });
}

function viewAt(bounds: [number, number, number, number], zoom: number, global = false): ViewState {
  return {
    lon: (bounds[0] + bounds[2]) / 2,
    lat: (bounds[1] + bounds[3]) / 2,
    zoom,
    bearing: 0,
    pitch: 0,
    bounds,
    global,
  };
}

async function deflate(frame: ArrayBuffer, extraFlags = 0): Promise<ArrayBuffer> {
  const stream = new Blob([new Uint8Array(frame, HEADER_BYTES)])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  const body = new Uint8Array(await new Response(stream).arrayBuffer());
  const out = new Uint8Array(HEADER_BYTES + body.length);
  out.set(new Uint8Array(frame, 0, HEADER_BYTES));
  out.set(body, HEADER_BYTES);
  const view = new DataView(out.buffer);
  view.setUint16(4, view.getUint16(4, true) | FRAME_FLAG_DEFLATE | extraFlags, true);
  return out.buffer;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("gateway client", () => {
  test("connects to the stream endpoint and subscribes to the whole world after hello", async () => {
    const h = await harness();
    expect(h.sockets).toHaveLength(1);
    // `z=1` asks the gateway for per-frame compression.
    expect(h.socket().url).toBe("ws://gateway.test/v1/stream?v=1&z=1");
    expect(h.socket().binaryType).toBe("arraybuffer");
    expect(h.layer("aircraft")?.status).toBe("loading");
    // Straight to "loading": no flash of "offline" while the first attempt is in the air.
    const first = h.messages.flatMap((m) =>
      m.type === "layer" && (m.layer === "aircraft" || m.layer === "ships") ? [m.state.status] : [],
    );
    expect(first).toEqual(["loading", "loading"]);
    // Nothing is sent before the server has said hello.
    expect(h.socket().sent).toEqual([]);
    h.socket().hello();
    expect(h.socket().subs).toEqual([
      { t: "sub", layers: ["aircraft", "ships"], res: 0, cells: [], points: true, density: true },
    ]);
    h.runtime.dispose();
  });

  test("hello, a FULL upsert, deltas and removes keep the store in step", async () => {
    const h = await harness();
    const socket = h.socket();
    socket.hello();

    socket.frame(
      upsert(A, T0, true, [
        { id: 0x4ca123, lon: -6.27, lat: 53.42, heading: 90, speed: 220 },
        { id: 0x400abc, lon: -0.45, lat: 51.47, heading: 270, speed: 70 },
        { id: 0x3c6444, lon: 8.57, lat: 50.03 },
      ]),
    );
    socket.frame(
      encodeMeta(A, T0, [
        { id: 0x4ca123, fields: { label: "RYR4TK", registration: "EI-DCL", typeCode: "B738" } },
        { id: 0x400abc, fields: { label: "BAW117" } },
      ]),
    );
    const store = h.runtime.storeOf(A);
    expect(store?.count).toBe(3);
    const i = store?.indexOf(0x4ca123) as number;
    expect(store?.lon[i]).toBeCloseTo(-6.27, 5);
    expect(store?.speed[i]).toBeCloseTo(220, 3);
    expect(store?.alt[i]).toBeCloseTo(1400 * 7.62, 1);
    expect(Number.isNaN(store?.heading[store.indexOf(0x3c6444)] as number)).toBe(true);
    expect(store?.meta[i]).toEqual({ label: "RYR4TK", registration: "EI-DCL", typeCode: "B738" });
    expect(store?.ownerOf(i)).toBe(GATEWAY_SOURCE);
    // An aircraft's value carries its type's 3D model and its airline's colours.
    const ryanair = {
      model: aircraftModelForType("B738"),
      livery: aircraftLiveryForCallsign("RYR4TK"),
    };
    expect(ryanair.model).toBeGreaterThan(0);
    expect(ryanair.livery).toBeGreaterThan(0);
    expect(splitAircraftValue(store?.value[i] as number)).toEqual(ryanair);
    expect(splitAircraftValue(store?.value[store.indexOf(0x400abc)] as number)).toEqual({
      model: 0,
      livery: aircraftLiveryForCallsign("BAW117"),
    });

    // One batch for the tick, not one per frame.
    await vi.advanceTimersByTimeAsync(100);
    expect(h.batches(A)).toHaveLength(1);
    expect(h.batches(A)[0].count).toBe(3);
    // ...which hands both to the renderer in the third and fourth style bytes.
    const first = h.batches(A)[0];
    const j = Array.from(first.ids).indexOf(0x4ca123);
    expect([first.style[j * 4 + 2], first.style[j * 4 + 3]]).toEqual([
      ryanair.livery,
      ryanair.model,
    ]);
    expect(h.layer("aircraft")).toMatchObject({ status: "live", count: 3 });

    // A delta: one moved, one is new.
    vi.setSystemTime(T0 + 1000);
    socket.frame(
      upsert(A, T0 + 1000, false, [
        { id: 0x4ca123, lon: -6.25, lat: 53.42, heading: 92, speed: 221 },
        { id: 0x4b1805, lon: 8.55, lat: 47.45 },
      ]),
    );
    expect(store?.count).toBe(4);
    expect(store?.lon[store.indexOf(0x4ca123)]).toBeCloseTo(-6.25, 5);
    // Meta sent once stays when the position moves.
    expect(store?.meta[store.indexOf(0x4ca123)]?.label).toBe("RYR4TK");

    socket.frame(encodeRemove(A, T0 + 1000, [0x400abc, 0x3c6444]));
    expect(store?.count).toBe(2);
    expect(store?.indexOf(0x400abc)).toBe(-1);

    await vi.advanceTimersByTimeAsync(1000);
    const batches = h.batches(A);
    expect(batches).toHaveLength(2);
    expect([...batches[1].ids].sort((a, b) => a - b)).toEqual(
      [0x4b1805, 0x4ca123].sort((a, b) => a - b),
    );
    expect(batches[1].seq).toBe(batches[0].seq + 1);
    h.runtime.dispose();
  });

  test("a ship's meta becomes its length, beam, 3D model and colours", async () => {
    const h = await harness();
    const socket = h.socket();
    socket.hello();
    // The test frames' category is 3: passenger ships.
    socket.frame(upsert(S, T0, true, [{ id: 255_805_000, lon: 9.9, lat: 53.5, heading: 120 }]));
    socket.frame(
      encodeMeta(S, T0, [
        {
          id: 255_805_000,
          fields: {
            label: "MSC WORLD EUROPA",
            lengthM: "333",
            widthM: "47",
            typeName: "Passenger ship",
          },
        },
      ]),
    );
    const store = h.runtime.storeOf(S);
    const i = store?.indexOf(255_805_000) as number;
    const v = splitShipValue(store?.value[i] as number);
    expect(v).toMatchObject({ lengthM: 334, beamM: 47, model: VesselModel.Cruise });
    expect(vesselScheme(v.scheme).name).toBe("MSC Cruises");

    // A later message with only a name keeps the dimensions it already gave.
    socket.frame(encodeMeta(S, T0, [{ id: 255_805_000, fields: { destination: "HAMBURG" } }]));
    expect(splitShipValue(store?.value[i] as number).lengthM).toBe(334);

    await vi.advanceTimersByTimeAsync(1100);
    const batch = h.batches(S).at(-1) as RenderBatch;
    const j = Array.from(batch.ids).indexOf(255_805_000);
    // The glyph's length byte (over 400 m), and the model in the fourth byte.
    expect(batch.style[j * 4 + 2]).toBe(Math.round((334 / 400) * 255));
    expect(batch.style[j * 4 + 3]).toBe(VesselModel.Cruise);
    expect(batch.values[j]).toBe(store?.value[i]);
    h.runtime.dispose();
  });

  test("a later FULL frame drops whatever it does not list", async () => {
    const h = await harness();
    h.socket().hello();
    h.socket().frame(
      upsert(S, T0, true, [
        { id: 244660000, lon: 4, lat: 52 },
        { id: 235000001, lon: 1, lat: 51 },
      ]),
    );
    h.socket().frame(
      upsert(S, T0, true, [
        { id: 235000001, lon: 1, lat: 51 },
        { id: 211000002, lon: 9, lat: 54 },
      ]),
    );
    const store = h.runtime.storeOf(S);
    expect([...(store?.ids.subarray(0, store.count) ?? [])].sort((a, b) => a - b)).toEqual([
      211000002, 235000001,
    ]);
    h.runtime.dispose();
  });

  test("fix times come from the frame time and each entity's age", async () => {
    const h = await harness();
    h.socket().hello();
    h.socket().frame(upsert(A, T0 - 200, true, [{ id: 1, lon: 0, lat: 0, age: 7 }]));
    expect(h.runtime.storeOf(A)?.fixTimeMs[0]).toBe(T0 - 200 - 7000);
    h.runtime.dispose();
  });

  test("a ship's length from meta goes into its value, and survives later upserts", async () => {
    const h = await harness();
    h.socket().hello();
    h.socket().frame(upsert(S, T0, true, [{ id: 244660000, lon: 4, lat: 52 }]));
    h.socket().frame(
      encodeMeta(S, T0, [{ id: 244660000, fields: { label: "STENA HOLLANDICA", lengthM: "240" } }]),
    );
    h.socket().frame(upsert(S, T0 + 1000, false, [{ id: 244660000, lon: 4.01, lat: 52 }]));
    expect(splitShipValue(h.runtime.storeOf(S)?.value[0] as number).lengthM).toBe(240);
    h.runtime.dispose();
  });

  test("meta that arrives before its entity is kept and attached", async () => {
    const h = await harness();
    h.socket().hello();
    h.socket().frame(encodeMeta(A, T0, [{ id: 77, fields: { label: "EARLY1" } }]));
    h.socket().frame(upsert(A, T0, true, [{ id: 77, lon: 1, lat: 1 }]));
    expect(h.runtime.storeOf(A)?.meta[0]?.label).toBe("EARLY1");
    h.runtime.dispose();
  });

  test("stats set the worldwide total and map upstream trouble onto the layer", async () => {
    const h = await harness();
    h.socket().hello();
    h.socket().frame(upsert(A, T0, true, [{ id: 1, lon: 0, lat: 0 }]));
    h.socket().frame(
      encodeStats(T0, [
        { kind: A, status: UpstreamStatus.Ok, total: 11_842 },
        { kind: S, status: UpstreamStatus.NeedsKey, total: 0 },
      ]),
    );
    await vi.advanceTimersByTimeAsync(1100);
    expect(h.layer("aircraft")).toMatchObject({
      status: "live",
      count: 1,
      total: 11_842,
      updatedMs: T0,
    });
    expect(h.layer("ships")).toMatchObject({
      status: "needs-key",
      message: "Ships need an API key. Add it to the gateway's .env file.",
    });

    h.socket().frame(
      encodeStats(T0 + 1000, [
        { kind: A, status: UpstreamStatus.Degraded, total: 11_800 },
        { kind: S, status: UpstreamStatus.Down, total: 0 },
      ]),
    );
    await vi.advanceTimersByTimeAsync(1100);
    expect(h.layer("aircraft")).toMatchObject({
      status: "degraded",
      message: "Aircraft are updating slowly or incompletely right now.",
    });
    expect(h.layer("ships")).toMatchObject({
      status: "offline",
      message: "Ships are offline. The gateway can't reach its provider right now.",
    });
    h.runtime.dispose();
  });

  test("a layer the gateway was not serving keeps its own message through a reconnect", async () => {
    const h = await harness();
    h.socket().hello({
      layers: {
        aircraft: { status: UpstreamStatus.Ok, attribution: "a" },
        ships: { status: UpstreamStatus.NeedsKey, attribution: "s" },
      },
    });
    h.socket().drop();
    expect(h.layer("aircraft")?.status).toBe("degraded");
    expect(h.layer("ships")).toMatchObject({
      status: "needs-key",
      message: "Ships need an API key. Add it to the gateway's .env file.",
    });
    h.runtime.dispose();
  });

  test("the status in hello applies before any stats arrive", async () => {
    const h = await harness();
    h.socket().hello({
      layers: {
        aircraft: { status: UpstreamStatus.Ok, attribution: "a" },
        ships: { status: UpstreamStatus.Off, attribution: "s" },
      },
    });
    expect(h.layer("ships")).toMatchObject({
      status: "offline",
      message: "Ships are switched off on this gateway.",
    });
    h.runtime.dispose();
  });

  test("density frames become density messages with transferable buffers", async () => {
    const h = await harness();
    h.socket().hello();
    const transfers: Transferable[][] = [];
    h.runtime.listen((message, transfer) => {
      h.messages.push(message);
      transfers.push(transfer);
    });
    h.socket().frame(
      encodeDensity({
        kind: A,
        timeMs: T0,
        res: 2,
        cellLo: [1, 2, 3],
        cellHi: [9, 9, 9],
        lon: [10, 20, 30],
        lat: [1, 2, 3],
        counts: [5, 40, 12],
      }),
    );
    const message = h.messages.find((m) => m.type === "density");
    if (message?.type !== "density") throw new Error("no density message");
    expect(message.grid).toMatchObject({ kind: A, res: 2, count: 3, max: 40 });
    expect([...message.grid.positions]).toEqual([10, 1, 20, 2, 30, 3]);
    expect([...message.grid.counts]).toEqual([5, 40, 12]);
    const moved = transfers[transfers.length - 1];
    expect(moved).toContain(message.grid.positions.buffer);
    expect(moved).toContain(message.grid.counts.buffer);
    h.runtime.dispose();
  });

  test("events are passed on once each", async () => {
    const h = await harness();
    h.socket().hello();
    const squawk: HaloEvent = {
      id: "emergency-4ca123",
      topic: "emergency",
      timeMs: T0,
      title: "RYR4TK is squawking 7700",
      ref: { kind: A, id: 0x4ca123 },
      severity: 2,
    };
    h.socket().frame(encodeEvents(T0, [squawk]));
    h.socket().frame(
      encodeEvents(T0 + 1000, [
        squawk,
        {
          id: "emergency-400abc",
          topic: "emergency",
          timeMs: T0 + 1000,
          title: "BAW117 is squawking 7600",
        },
      ]),
    );
    const events = h.messages.flatMap((m) => (m.type === "events" ? m.events : []));
    expect(events.map((e) => e.id)).toEqual(["emergency-4ca123", "emergency-400abc"]);
    h.runtime.dispose();
  });

  test("batches carry their buffers in the transfer list", async () => {
    const h = await harness();
    const transfers: Transferable[][] = [];
    h.runtime.listen((message, transfer) => {
      if (message.type === "batch") transfers.push(transfer);
    });
    h.socket().hello();
    h.socket().frame(upsert(A, T0, true, [{ id: 1, lon: 0, lat: 0 }]));
    await vi.advanceTimersByTimeAsync(100);
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toHaveLength(6);
    h.runtime.dispose();
  });

  test("the view drives the subscription: debounced, by resolution, and only when it changes", async () => {
    const h = await harness();
    const socket = h.socket();
    socket.hello();
    const bounds: [number, number, number, number] = [-2, 50.5, 1.5, 52.5];
    h.runtime.setView(viewAt(bounds, 7.2));
    h.runtime.setView(viewAt(bounds, 7.3));
    // Still settling: nothing yet.
    expect(socket.subs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(socket.subs).toHaveLength(2);
    const sub = socket.subs[1];
    expect(sub.res).toBe(3);
    expect(sub.density).toBe(false);
    expect(sub.points).toBe(true);
    expect(sub.cells.length).toBeGreaterThan(0);
    expect(sub.cells).toContain(latLngToCell(51.5, -0.1, 3));

    // The camera moved a hair: same cells, so no new subscription.
    h.runtime.setView(viewAt([-1.99, 50.51, 1.51, 52.51], 7.3));
    await vi.advanceTimersByTimeAsync(300);
    expect(socket.subs).toHaveLength(2);

    // Pulling out to the globe goes back to the whole world, with density.
    h.runtime.setView(viewAt([-180, -90, 180, 90], 1.5, true));
    await vi.advanceTimersByTimeAsync(300);
    expect(socket.subs[2]).toMatchObject({ res: 0, cells: [], density: true });
    h.runtime.dispose();
  });

  test("the server's maxCells caps the subscription", async () => {
    const h = await harness();
    h.socket().hello({ maxCells: 40 });
    h.runtime.setView(viewAt([-10, 40, 15, 55], 6.5));
    await vi.advanceTimersByTimeAsync(300);
    const sub = h.socket().subs[1];
    expect(sub.cells.length).toBeLessThanOrEqual(40);
    expect(sub.res).toBeLessThan(3);
    h.runtime.dispose();
  });

  test("switching a layer off resubscribes without it and empties its store", async () => {
    const h = await harness();
    h.socket().hello();
    h.socket().frame(upsert(S, T0, true, [{ id: 244660000, lon: 4, lat: 52 }]));
    await vi.advanceTimersByTimeAsync(100);
    h.runtime.setLayerEnabled("ships", false);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.socket().subs[1].layers).toEqual(["aircraft"]);
    expect(h.runtime.storeOf(S)?.count).toBe(0);
    const batches = h.batches(S);
    expect(batches[batches.length - 1].count).toBe(0);
    expect(h.layer("ships")).toEqual({ status: "off", count: null });
    // A straggler frame for the layer that was just switched off is ignored.
    h.socket().frame(upsert(S, T0, false, [{ id: 244660000, lon: 4, lat: 52 }]));
    expect(h.runtime.storeOf(S)?.count).toBe(0);
    h.runtime.dispose();
  });

  test("with every gateway layer off the socket is closed, and reopened on demand", async () => {
    const h = await harness();
    h.socket().hello();
    h.runtime.setLayerEnabled("aircraft", false);
    h.runtime.setLayerEnabled("ships", false);
    expect(h.socket().closed).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.sockets).toHaveLength(1);
    h.runtime.setLayerEnabled("aircraft", true);
    expect(h.sockets).toHaveLength(2);
    // A fresh connection is "loading", not a failure, and old data is not called live.
    expect(h.layer("aircraft")).toEqual({ status: "loading", count: 0 });
    h.socket().hello();
    expect(h.layer("aircraft")?.status).toBe("loading");
    expect(h.socket().subs[0].layers).toEqual(["aircraft"]);
    h.runtime.dispose();
  });

  test("reconnects with backoff after a drop and resubscribes with the same view", async () => {
    const h = await harness();
    h.socket().hello();
    h.runtime.setView(viewAt([-2, 50.5, 1.5, 52.5], 7.2));
    await vi.advanceTimersByTimeAsync(300);
    const wanted = h.socket().subs[1];
    h.socket().frame(upsert(A, T0, true, [{ id: 1, lon: 0, lat: 51 }]));
    await vi.advanceTimersByTimeAsync(100);

    h.socket().drop();
    // Positions stay on screen while it reconnects.
    expect(h.layer("aircraft")).toMatchObject({
      status: "degraded",
      message: "Live traffic lost its connection. Reconnecting now.",
    });
    expect(h.runtime.storeOf(A)?.count).toBe(1);

    // First retry after 1 s (jitter pinned to the top of its range).
    await vi.advanceTimersByTimeAsync(999);
    expect(h.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(2);
    h.sockets[1].drop();
    // Then 2 s, then 4 s.
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.sockets).toHaveLength(3);
    h.sockets[2].drop();
    await vi.advanceTimersByTimeAsync(3999);
    expect(h.sockets).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(4);

    h.socket().hello();
    expect(h.socket().subs).toEqual([wanted]);
    h.socket().frame(upsert(A, Date.now(), true, [{ id: 2, lon: 0, lat: 51 }]));
    expect([...(h.runtime.storeOf(A)?.ids.subarray(0, 1) ?? [])]).toEqual([2]);
    await vi.advanceTimersByTimeAsync(1100);
    expect(h.layer("aircraft")?.status).toBe("live");
    h.runtime.dispose();
  });

  test("the retry delay is capped", async () => {
    const h = await harness();
    for (let i = 0; i < 12; i++) {
      h.socket().drop();
      await vi.advanceTimersByTimeAsync(30_000);
    }
    // Twelve failures, each followed by at most a 30 s wait: a socket every time.
    expect(h.sockets).toHaveLength(13);
    h.runtime.dispose();
  });

  test("when the gateway stays away, the layers go offline and their objects are cleared", async () => {
    const h = await harness();
    h.socket().hello();
    h.socket().frame(upsert(A, T0, true, [{ id: 1, lon: 0, lat: 51 }]));
    await vi.advanceTimersByTimeAsync(100);
    h.socket().drop();
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(2000);
      if (!h.socket().closed) h.socket().drop();
    }
    expect(h.runtime.storeOf(A)?.count).toBe(0);
    expect(h.layer("aircraft")).toMatchObject({
      status: "offline",
      message:
        "Live traffic is offline. The gateway isn't reachable; satellites and earthquakes still work.",
    });
    const batches = h.batches(A);
    expect(batches[batches.length - 1].count).toBe(0);
    h.runtime.dispose();
  });

  test("a gateway that was never reachable reads as offline after the first failed attempt", async () => {
    const h = await harness();
    expect(h.layer("aircraft")?.status).toBe("loading");
    h.socket().drop();
    expect(h.layer("aircraft")).toMatchObject({
      status: "offline",
      message:
        "Live traffic is offline. The gateway isn't reachable; satellites and earthquakes still work.",
    });
    expect(h.layer("ships")?.status).toBe("offline");
    h.runtime.dispose();
  });

  test("with no gateway configured the layers say so and no socket is opened", async () => {
    const h = await harness({ gatewayUrl: null });
    expect(h.sockets).toHaveLength(0);
    expect(h.layer("aircraft")).toEqual({
      status: "offline",
      count: 0,
      message:
        "Live traffic is offline. No gateway is configured; satellites and earthquakes still work.",
    });
    h.runtime.dispose();
  });

  test("pings measure latency, and a silent socket is replaced", async () => {
    const h = await harness();
    const socket = h.socket();
    socket.hello();
    await vi.advanceTimersByTimeAsync(15_000);
    const ping = socket.sent.find((m) => m.t === "ping");
    expect(ping).toEqual({ t: "ping", id: 1 });
    vi.setSystemTime(Date.now() + 42);
    socket.text({ t: "pong", id: 1 });
    expect(h.runtime.gatewayClient?.latencyMs).toBe(42);
    // No frames, no pongs: after 45 s of silence the client gives up on it.
    await vi.advanceTimersByTimeAsync(61_000);
    expect(socket.closed).toBe(true);
    expect(h.sockets.length).toBeGreaterThan(1);
    h.runtime.dispose();
  });

  test("a frame with a deflated body is inflated and applied in order", async () => {
    vi.useRealTimers();
    const h = await harness();
    h.socket().hello();
    const now = Date.now();
    const compressed = await deflate(
      upsert(A, now, true, [
        { id: 1, lon: 10, lat: 10 },
        { id: 2, lon: 20, lat: 20 },
      ]),
    );
    h.socket().frame(compressed);
    // Sent right behind it, uncompressed: it must not overtake the frame still inflating.
    h.socket().frame(encodeRemove(A, now, [1]));
    h.socket().frame(upsert(A, now + 1, false, [{ id: 3, lon: 30, lat: 30 }]));
    await vi.waitFor(() => expect(h.runtime.storeOf(A)?.count).toBe(2));
    const store = h.runtime.storeOf(A);
    expect([...(store?.ids.subarray(0, 2) ?? [])].sort((a, b) => a - b)).toEqual([2, 3]);
    expect(h.runtime.gatewayClient?.skippedFrames).toBe(0);
    h.runtime.dispose();
  });

  test("inflateFrame restores the original frame", async () => {
    vi.useRealTimers();
    const original = updateToUpsert(
      makeUpdate(A, "x", T0, [{ id: 5, lon: 1, lat: 2, heading: 3, speed: 4 }], { full: true }),
    );
    const restored = await inflateFrame(await deflate(original));
    expect(new Uint8Array(restored)).toEqual(new Uint8Array(original));
  });

  test("a frame with unknown header flags is skipped, not misread", async () => {
    const h = await harness();
    h.socket().hello();
    const frame = upsert(A, T0, true, [{ id: 1, lon: 0, lat: 0 }]);
    new DataView(frame).setUint16(4, 0x0001 | 0x0040, true);
    h.socket().frame(frame);
    expect(h.runtime.storeOf(A)?.count).toBe(0);
    expect(h.runtime.gatewayClient?.skippedFrames).toBe(1);
    // Garbage and unknown frame types are dropped the same way.
    h.socket().frame(new ArrayBuffer(8));
    const unknown = encodeRemove(A, T0, []);
    new DataView(unknown).setUint8(2, 99);
    h.socket().frame(unknown);
    expect(h.runtime.gatewayClient?.skippedFrames).toBe(2);
    h.socket().frame(upsert(A, T0, true, [{ id: 1, lon: 0, lat: 0 }]));
    expect(h.runtime.storeOf(A)?.count).toBe(1);
    h.runtime.dispose();
  });

  test("a device clock that is off is corrected for, so dead reckoning stays in step", async () => {
    const h = await harness();
    h.socket().hello();
    // The server's clock reads 90 s behind this device's.
    h.socket().frame(upsert(A, T0 - 90_000, true, [{ id: 1, lon: 0, lat: 0, age: 2 }]));
    expect(h.runtime.gatewayClient?.skewMs).toBe(90_000);
    expect(h.runtime.storeOf(A)?.fixTimeMs[0]).toBe(T0 - 2000);
    h.runtime.dispose();
  });

  test("ordinary network delay is not mistaken for clock skew", async () => {
    const h = await harness();
    h.socket().hello();
    h.socket().frame(upsert(A, T0 - 300, true, [{ id: 1, lon: 0, lat: 0 }]));
    expect(h.runtime.gatewayClient?.skewMs).toBe(0);
    expect(h.runtime.storeOf(A)?.fixTimeMs[0]).toBe(T0 - 300);
    h.runtime.dispose();
  });

  test("attributions from hello are listed for the attribution page", async () => {
    const h = await harness();
    h.socket().hello();
    const list = await h.runtime.getAttributions();
    expect(list).toEqual([
      expect.objectContaining({
        id: "gateway-aircraft",
        layer: "aircraft",
        attribution: "Aircraft positions: adsb.lol contributors (ODbL)",
        attributionUrl: "http://gateway.test/v1/attribution",
      }),
      expect.objectContaining({
        id: "gateway-ships",
        layer: "ships",
        attribution: "Ship positions: AISStream",
      }),
    ]);
    h.runtime.dispose();
  });

  test("detail merges the gateway's facts, route, credit and exact fix time with local state", async () => {
    vi.useRealTimers();
    const h = await harness();
    h.socket().hello();
    const now = Date.now();
    h.socket().frame(
      upsert(A, now, true, [{ id: 0x4ca123, lon: -6.27, lat: 53.42, heading: 90, speed: 220 }]),
    );
    h.socket().frame(encodeMeta(A, now, [{ id: 0x4ca123, fields: { label: "RYR4TK" } }]));
    h.respond = (url) =>
      url.endsWith(`/v1/entity/aircraft/${0x4ca123}`)
        ? Response.json({
            kind: 1,
            id: 0x4ca123,
            layer: "aircraft",
            lon: -6.27,
            lat: 53.42,
            alt: 10668,
            heading: 90,
            speed: 220,
            vrate: 0,
            // The frame could only say "0 s old"; the gateway knows it to the millisecond.
            fixTimeMs: now - 640,
            category: 3,
            flags: 0,
            meta: { label: "RYR4TK", registration: "EI-DCL", typeName: "Boeing 737-800" },
            track: [],
            source: "adsb-lol",
            attribution: {
              text: "Contains information from adsb.lol (ODbL)",
              url: "https://www.adsb.lol/",
            },
            origin: { code: "DUB", name: "Dublin", lon: -6.27, lat: 53.4213 },
            destination: { code: "STN", name: "London Stansted", lon: 0.235, lat: 51.885 },
            routeAttribution: "Route data: Virtual Radar Server standing data (CC0)",
          })
        : new Response("", { status: 404 });
    const detail = await h.runtime.getDetail({ kind: A, id: 0x4ca123 });
    // One request, with the kind spelled as the gateway documents it.
    expect(h.requests).toEqual([`http://gateway.test/v1/entity/aircraft/${0x4ca123}`]);
    expect(detail).toMatchObject({
      layer: "aircraft",
      title: "RYR4TK",
      subtitle: "Boeing 737-800 · EI-DCL",
      origin: { code: "DUB", name: "Dublin", lon: -6.27, lat: 53.4213 },
      destination: { code: "STN", name: "London Stansted" },
      // The feed this aircraft came from, not the layer's general credit from hello.
      attribution: {
        text: "Contains information from adsb.lol (ODbL)",
        url: "https://www.adsb.lol/",
      },
      fixTimeMs: now - 640,
    });
    const fields = Object.fromEntries((detail?.fields ?? []).map((f) => [f.key, f]));
    expect(fields.registration.value).toBe("EI-DCL");
    expect(fields.speed).toMatchObject({ label: "Ground speed", value: "428", unit: "kt" });
    expect(fields.alt).toMatchObject({ value: "35,000", unit: "ft" });
    expect(fields.id.value).toBe("4CA123");
    // What the gateway told us is kept for search and the next selection.
    expect(h.runtime.storeOf(A)?.meta[0]?.registration).toBe("EI-DCL");
    h.runtime.dispose();
  });

  test("the gateway's fix time is not used when it describes a different fix", async () => {
    vi.useRealTimers();
    const h = await harness();
    h.socket().hello();
    const now = Date.now();
    h.socket().frame(upsert(A, now, true, [{ id: 7, lon: 10, lat: 50, heading: 90, speed: 200 }]));
    // The gateway has moved on by a tick; this client has not seen that frame yet.
    h.respond = () =>
      Response.json({
        lon: 10.003,
        lat: 50,
        alt: 0,
        heading: 90,
        speed: 200,
        vrate: 0,
        fixTimeMs: now + 1000,
        meta: {},
        track: [],
      });
    const detail = await h.runtime.getDetail({ kind: A, id: 7 });
    expect(detail?.lon).toBeCloseTo(10, 5);
    expect(detail?.fixTimeMs).toBe(now);
    h.runtime.dispose();
  });

  test("detail for an object that is not loaded comes from the gateway alone", async () => {
    vi.useRealTimers();
    const h = await harness();
    h.socket().hello();
    const ship = recorded("gateway-entity-ship");
    h.respond = (url) =>
      url.endsWith("/v1/entity/ship/200000273")
        ? Response.json(ship)
        : Response.json(
            {
              error: {
                code: "not_found",
                message: "Nothing with that id is being tracked right now.",
              },
            },
            { status: 404 },
          );
    const detail = await h.runtime.getDetail({ kind: S, id: 200000273 });
    expect(h.requests).toEqual(["http://gateway.test/v1/entity/ship/200000273"]);
    expect(detail).toMatchObject({
      layer: "ships",
      title: "MOCK VESSEL 21",
      subtitle: "Cargo ship",
      lon: expect.closeTo(114.0551598, 4),
      lat: expect.closeTo(22.3043475, 4),
      heading: expect.closeTo(255.15, 3),
      speed: 0,
      fixTimeMs: ship.fixTimeMs,
      attribution: { text: "Simulated traffic, not real ships" },
    });
    const fields = Object.fromEntries((detail?.fields ?? []).map((f) => [f.key, f]));
    expect(fields.navStatus.value).toBe("Moored");
    expect(fields.lengthM).toMatchObject({ value: "274", unit: "m", numeric: 274 });
    expect(fields.id.value).toBe("200000273");
    // The gateway no longer tracks it: one request, no guessing at other spellings.
    expect(await h.runtime.getDetail({ kind: S, id: 2 })).toBeNull();
    expect(h.requests).toHaveLength(2);
    h.runtime.dispose();
  });

  test("a fix older than the wire can say keeps its time when it is sent again", async () => {
    const h = await harness();
    h.socket().hello();
    // A moored ship whose last report is older than 255 s: the age column is at its ceiling.
    h.socket().frame(
      upsert(S, T0, true, [{ id: 5, lon: 24.9, lat: 60.1, speed: 3, heading: 0, age: 255 }]),
    );
    const store = h.runtime.storeOf(S);
    expect(store?.fixTimeMs[0]).toBe(T0 - 255_000);
    // Ten minutes on, a new subscription makes the gateway send the same fix again.
    vi.setSystemTime(T0 + 600_000);
    h.socket().frame(
      upsert(S, T0 + 600_000, true, [
        { id: 5, lon: 24.9, lat: 60.1, speed: 3, heading: 0, age: 255 },
      ]),
    );
    // "At least 255 s old", not "exactly 255 s old as of now": the time must not creep forward.
    expect(store?.fixTimeMs[0]).toBe(T0 - 255_000);
    // A genuinely new position is taken, with the best time the frame can give.
    h.socket().frame(
      upsert(S, T0 + 600_000, false, [
        { id: 5, lon: 24.95, lat: 60.1, speed: 3, heading: 0, age: 255 },
      ]),
    );
    expect(store?.lon[0]).toBeCloseTo(24.95, 5);
    expect(store?.fixTimeMs[0]).toBe(T0 + 600_000 - 255_000);
    h.runtime.dispose();
  });

  test("the attribution page lists what the gateway says it is running", async () => {
    const h = await harness();
    h.socket().hello();
    h.respond = (url) =>
      url.endsWith("/v1/attribution")
        ? Response.json(recorded("gateway-attribution"))
        : new Response("", { status: 404 });
    const list = await h.runtime.getAttributions();
    expect(list.map((s) => [s.id, s.layer, s.attribution])).toEqual([
      ["gateway-mock-aircraft", "aircraft", "Simulated traffic, not real aircraft"],
      ["gateway-mock-ships", "ships", "Simulated traffic, not real ships"],
    ]);
    expect(list[0]).toMatchObject({ name: "Simulated aircraft", licence: "Synthetic data" });
    // Asked once; the answer is reused for a while.
    await h.runtime.getAttributions();
    expect(h.requests.filter((url) => url.endsWith("/v1/attribution"))).toHaveLength(1);
    h.runtime.dispose();
  });

  test("search asks the gateway too, merges, and drops a superseded lookup", async () => {
    const h = await harness();
    h.socket().hello();
    h.socket().frame(upsert(A, T0, true, [{ id: 0x4ca123, lon: -6.27, lat: 53.42 }]));
    h.socket().frame(encodeMeta(A, T0, [{ id: 0x4ca123, fields: { label: "RYR4TK" } }]));
    h.respond = () =>
      Response.json({
        query: "ryr",
        results: [
          {
            kind: 1,
            id: 0x4ca123,
            layer: "aircraft",
            title: "RYR4TK",
            subtitle: null,
            lon: -6.2,
            lat: 53.4,
            score: 80,
          },
          {
            kind: 1,
            id: 0x4ca999,
            layer: "aircraft",
            title: "RYR81",
            subtitle: "EI-ABC · B738",
            lon: 12,
            lat: 41,
            score: 80,
          },
        ],
      });

    const first = h.runtime.search("ry");
    // The next keystroke lands before the debounce: the first lookup never leaves.
    const second = h.runtime.search("ryr");
    expect((await first).map((r) => r.title)).toEqual(["RYR4TK"]);
    await vi.advanceTimersByTimeAsync(200);
    const results = await second;
    expect(h.requests).toEqual(["http://gateway.test/v1/search?q=ryr"]);
    // The loaded aircraft appears once (the local copy), the remote-only one is added.
    expect(results.map((r) => r.title)).toEqual(["RYR4TK", "RYR81"]);
    expect(results[0].lon).toBeCloseTo(-6.27, 5);
    expect(results[1]).toMatchObject({
      type: "entity",
      ref: { kind: A, id: 0x4ca999 },
      layer: "aircraft",
      subtitle: "EI-ABC · B738",
    });
    h.runtime.dispose();
  });

  test("a slow gateway search does not hold up local results", async () => {
    const h = await harness();
    h.socket().hello();
    h.socket().frame(upsert(A, T0, true, [{ id: 1, lon: 0, lat: 0 }]));
    h.socket().frame(encodeMeta(A, T0, [{ id: 1, fields: { label: "SLOW1" } }]));
    h.respond = () => new Promise<Response>(() => {});
    const pending = h.runtime.search("slow");
    await vi.advanceTimersByTimeAsync(1400);
    expect((await pending).map((r) => r.title)).toEqual(["SLOW1"]);
    h.runtime.dispose();
  });
});

describe("gateway JSON", () => {
  test("reads a recorded aircraft document", () => {
    const entity = parseGatewayEntity(recorded("gateway-entity-aircraft"));
    expect(entity).toMatchObject({
      lon: -32.606203,
      lat: 38.142486,
      alt: 11849.1,
      heading: 271.91,
      speed: 214.2,
      vrate: 0,
      fixTimeMs: 1794676339653,
      category: 2,
      flags: 0,
      meta: { label: "BAW2478", registration: "M-0001", squawk: "2000", typeCode: "AT76" },
      attribution: { text: "Simulated traffic, not real aircraft", url: "" },
    });
    // Rows are lon, lat, alt, time.
    expect(entity?.track).toEqual({
      positions: [-32.5792751, 38.1417754, 11849.1],
      timesMs: [1794676328000],
    });
    expect(entity?.origin).toBeUndefined();
  });

  test("reads an unknown heading, a route, and skips track rows it cannot place", () => {
    const entity = parseGatewayEntity({
      lon: 1,
      lat: 2,
      alt: 3,
      heading: null,
      speed: 5,
      vrate: -1.5,
      fixTimeMs: 6,
      meta: { label: "X", empty: "", nested: { no: true } },
      track: [[1, 2, 3, 1000], [1.1, 2.1, null, 2000], ["bad"], [1, 2, 3]],
      origin: { code: "ATH", name: "Athens", lon: 23.94, lat: 37.94 },
      destination: { code: "", name: "nowhere" },
    });
    expect(entity?.heading).toBeNull();
    expect(entity?.meta).toEqual({ label: "X" });
    expect(entity?.track).toEqual({ positions: [1, 2, 3, 1.1, 2.1, 0], timesMs: [1000, 2000] });
    expect(entity?.origin).toEqual({ code: "ATH", name: "Athens", lon: 23.94, lat: 37.94 });
    expect(entity?.destination).toBeUndefined();
  });

  test("anything that is not an entity document is refused", () => {
    expect(parseGatewayEntity("nope")).toBeNull();
    expect(parseGatewayEntity(null)).toBeNull();
    // The error body of a 404.
    expect(parseGatewayEntity({ error: { code: "not_found", message: "Nothing" } })).toBeNull();
    // A position with no fix time cannot be dead-reckoned.
    expect(parseGatewayEntity({ lon: 1, lat: 2 })).toBeNull();
  });

  test("reads recorded search results, skipping what it cannot place", () => {
    const results = parseGatewaySearch(recorded("gateway-search"));
    expect(results).toHaveLength(4);
    expect(results[0]).toEqual({
      type: "entity",
      ref: { kind: 2, id: 200000273 },
      layer: "ships",
      title: "MOCK VESSEL 21",
      subtitle: "MMSI 200000273",
      lon: 114.0551598,
      lat: 22.3043475,
      score: 50,
    });
    expect(
      parseGatewaySearch({
        results: [
          { kind: 9, id: 1, lon: 0, lat: 0, title: "not a kind the gateway serves" },
          { kind: 1, id: 2, title: "no position" },
          { kind: 1, id: 0xabc123, lon: 1, lat: 2, title: "", subtitle: null, score: 100 },
        ],
      }),
    ).toEqual([
      {
        type: "entity",
        ref: { kind: 1, id: 0xabc123 },
        layer: "aircraft",
        title: "ABC123",
        lon: 1,
        lat: 2,
        score: 100,
      },
    ]);
    expect(parseGatewaySearch(null)).toEqual([]);
    expect(parseGatewaySearch([{ kind: 1, id: 1, lon: 0, lat: 0 }])).toEqual([]);
  });
});
