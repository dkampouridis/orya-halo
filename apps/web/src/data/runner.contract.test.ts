/**
 * The runner against the real plugin contract: `SourceError` codes, sources
 * whose providers ration downloads (`cacheTtl`), `viewAware` sources, tile
 * overlays and the scrubbed clock. `runner.test.ts` covers the scheduling
 * these build on.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { EntityKind } from "@orya-halo/schema";
import type {
  EntityUpdate,
  HaloEvent,
  LayerId,
  SourceContext,
  SourcePlugin,
  TileOverlay,
} from "@orya-halo/schema";
import { MemoryResponseCache, createPolicyFetch, readHold, writeHold } from "./fetching.ts";
import type { ResponseCache } from "./fetching.ts";
import type { FeedState } from "./layers.ts";
import { SourceRunner } from "./runner.ts";
import type { RunnerHost } from "./runner.ts";
import { fakeSource, makeUpdate, sourceError } from "./testing.ts";

const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;
const URL_ELEMENTS = "https://provider.example/elements.csv";

type View = NonNullable<SourceContext["view"]>;

interface Recorder extends RunnerHost {
  updates: EntityUpdate[];
  events: HaloEvent[];
  tiles: (TileOverlay | null)[];
  paths: number;
  states: Map<string, FeedState | null>;
  clock: { mode: "live" | "scrub"; timeMs: number };
  viewNow: View | undefined;
  isOnline: boolean;
  requests: string[];
  respond: (url: string) => Response | Promise<Response>;
}

function recorder(cache: ResponseCache | null = null): Recorder {
  const host: Recorder = {
    updates: [],
    events: [],
    tiles: [],
    paths: 0,
    states: new Map(),
    clock: { mode: "live", timeMs: 0 },
    viewNow: undefined,
    isOnline: true,
    requests: [],
    respond: () => new Response("{}"),
    now: () => (host.clock.mode === "scrub" ? host.clock.timeMs : Date.now()),
    isLive: () => host.clock.mode === "live",
    view: () => host.viewNow,
    key: () => undefined,
    online: () => host.isOnline,
    assetBase: "/",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      host.requests.push(url);
      if (init?.signal?.aborted) throw init.signal.reason;
      return host.respond(url);
    }) as typeof fetch,
    cache,
    onEntities: (_plugin, update) => host.updates.push(update),
    onEvents: (events) => host.events.push(...events),
    onPaths: () => {
      host.paths++;
    },
    onTiles: (_plugin, overlay) => host.tiles.push(overlay),
    onState: (plugin, state) => void host.states.set(plugin.id, state),
    onStopped: () => {},
  };
  return host;
}

const entities = (raw: unknown, ctx: { now(): number }) => ({
  type: "entities" as const,
  update: makeUpdate(EntityKind.Quake, "fake", ctx.now(), [{ id: (raw as { n: number }).n }]),
});

function run(plugins: SourcePlugin[], host: Recorder, layer: LayerId = "quakes"): SourceRunner {
  const runner = new SourceRunner(plugins, host, {
    random: () => 0.5,
    backoffBaseMs: 2000,
    backoffMaxMs: 60_000,
  });
  runner.setLayerEnabled(layer, true);
  return runner;
}

/** A source like CelesTrak: downloads rationed by the provider, refusals reported as "blocked". */
function rationed(extra: { onFetch?: () => void } = {}): SourcePlugin {
  return fakeSource({
    layer: "satellites",
    transport: "compute",
    refreshRate: 6 * HOUR,
    cacheTtl: 3 * HOUR,
    fetch: async (ctx: SourceContext) => {
      extra.onFetch?.();
      const response = await ctx.fetch(URL_ELEMENTS, { signal: ctx.signal });
      if (response.status === 403) {
        throw sourceError(
          "blocked",
          "Test Provider refused the request (HTTP 403): GP data has not updated since your last download.",
          403,
        );
      }
      if (!response.ok) {
        throw sourceError(
          "http",
          `Test Provider answered HTTP ${response.status}.`,
          response.status,
        );
      }
      const text = await response.text();
      if (!text.startsWith("{")) {
        throw sourceError("bad-data", "Test Provider sent no usable orbital elements.");
      }
      return JSON.parse(text) as unknown;
    },
    normalise: entities,
  });
}

function viewAt(lon: number, lat: number, zoom: number, half = 10): View {
  return { lon, lat, zoom, bounds: [lon - half, lat - half, lon + half, lat + half] };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SourceError codes", () => {
  test("needs-key is shown in the plugin's words and looked at again one refresh later", async () => {
    const host = recorder();
    let calls = 0;
    const runner = run(
      [
        fakeSource({
          layer: "fires",
          refreshRate: 30 * 60_000,
          fetch: async () => {
            calls++;
            throw sourceError("needs-key", "Wildfires need a free NASA FIRMS key on the gateway.");
          },
        }),
      ],
      host,
      "fires",
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(host.states.get("fake")).toEqual({
      status: "needs-key",
      message: "Wildfires need a free NASA FIRMS key on the gateway.",
    });
    // No backoff ladder: nothing changes until somebody adds the key.
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(calls).toBe(2);
    runner.dispose();
  });

  test("blocked waits a full refresh interval, says when it will try again, and is asked exactly once", async () => {
    const host = recorder(new MemoryResponseCache());
    host.respond = () => new Response("GP data has not updated", { status: 403 });
    const runner = run([rationed()], host, "satellites");
    await vi.advanceTimersByTimeAsync(10);
    // One request: neither the policy fetch nor the runner tried a second time.
    expect(host.requests).toEqual([URL_ELEMENTS]);
    expect(host.states.get("fake")).toEqual({
      status: "offline",
      message:
        "Test Provider refused the request (HTTP 403): GP data has not updated since your last download. We'll try again in about 6 hours.",
    });
    await vi.advanceTimersByTimeAsync(6 * HOUR - 60_000);
    expect(host.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(host.requests).toHaveLength(2);
    runner.dispose();
  });

  test("a refusal is remembered across a reload and across switching the layer off and on", async () => {
    const cache = new MemoryResponseCache();
    const first = recorder(cache);
    first.respond = () => new Response("no", { status: 403 });
    const runner = run([rationed()], first, "satellites");
    await vi.advanceTimersByTimeAsync(10);
    expect(first.requests).toHaveLength(1);

    runner.setLayerEnabled("satellites", false);
    runner.setLayerEnabled("satellites", true);
    await vi.advanceTimersByTimeAsync(10);
    expect(first.requests).toHaveLength(1);
    expect(first.states.get("fake")?.status).toBe("offline");
    runner.dispose();

    // An hour later the page is reloaded: a new runner over the same Cache API.
    await vi.advanceTimersByTimeAsync(HOUR);
    const second = recorder(cache);
    second.respond = () => new Response(JSON.stringify({ n: 5 }));
    const again = run([rationed()], second, "satellites");
    await vi.advanceTimersByTimeAsync(10);
    expect(second.requests).toHaveLength(0);
    expect(second.states.get("fake")).toEqual({
      status: "offline",
      message:
        "Test Provider refused the request (HTTP 403): GP data has not updated since your last download. We'll try again in about 5 hours.",
    });
    expect(again.schedule()[0]).toMatchObject({ id: "fake", holdUntilMs: T0 + 6 * HOUR });
    // When the hold ends the provider is asked, and a good answer clears the hold for good.
    await vi.advanceTimersByTimeAsync(5 * HOUR);
    expect(second.requests).toHaveLength(1);
    expect(second.states.get("fake")?.status).toBe("live");
    expect(await readHold(cache, "fake", Date.now())).toBeNull();
    again.dispose();
  });

  test("refused with an old copy on disk: the copy is shown as late and the provider is left alone", async () => {
    const cache = new MemoryResponseCache();
    // Yesterday's download, long past its TTL.
    await cache.put(URL_ELEMENTS, new Response(JSON.stringify({ n: 77 })), T0 - 20 * HOUR);
    const first = recorder(cache);
    first.respond = () => new Response("GP data has not updated", { status: 403 });
    const runner = run([rationed()], first, "satellites");
    await vi.advanceTimersByTimeAsync(10);
    expect(first.requests).toHaveLength(1);
    expect(first.updates[0].columns.ids[0]).toBe(77);
    expect(first.states.get("fake")).toMatchObject({
      status: "degraded",
      message: "Test Provider refused the request (HTTP 403). We'll try again in about 6 hours.",
    });
    runner.dispose();

    // Reloaded two hours on: the old copy again, and still not one more request.
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    const second = recorder(cache);
    second.respond = () => new Response("GP data has not updated", { status: 403 });
    const again = run([rationed()], second, "satellites");
    await vi.advanceTimersByTimeAsync(10);
    expect(second.requests).toHaveLength(0);
    expect(second.updates[0].columns.ids[0]).toBe(77);
    expect(second.states.get("fake")).toMatchObject({
      status: "degraded",
      message: "Test Provider refused the request (HTTP 403). We'll try again in about 4 hours.",
    });
    await vi.advanceTimersByTimeAsync(4 * HOUR - 60_000);
    expect(second.requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(second.requests).toHaveLength(1);
    again.dispose();
  });

  test("an http failure keeps the plugin's sentence and backs off; a refusal that will not mend is an error", async () => {
    const host = recorder();
    const calls: number[] = [];
    let status = 503;
    const runner = run(
      [
        fakeSource({
          refreshRate: 60_000,
          fetch: async () => {
            calls.push(Date.now() - T0);
            throw sourceError("http", `USGS answered HTTP ${status}`, status);
          },
          normalise: entities,
        }),
      ],
      host,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(host.states.get("fake")).toEqual({
      status: "offline",
      message: "USGS answered HTTP 503. We'll keep trying.",
    });
    status = 404;
    await vi.advanceTimersByTimeAsync(7000);
    // 2 s, then 4 s: the usual ladder.
    expect(calls).toEqual([0, 2000, 6000]);
    expect(host.states.get("fake")).toEqual({
      status: "error",
      message: "USGS answered HTTP 404.",
    });
    runner.dispose();
  });

  test("bad-data is an error in the plugin's words", async () => {
    const host = recorder();
    const runner = run(
      [
        fakeSource({
          fetch: async () => {
            throw sourceError("bad-data", "USGS sent an earthquake feed that could not be read.");
          },
          normalise: entities,
        }),
      ],
      host,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(host.states.get("fake")).toEqual({
      status: "error",
      message: "USGS sent an earthquake feed that could not be read.",
    });
    runner.dispose();
  });

  test("a SourceError thrown while normalising is shown in the plugin's words too", async () => {
    const host = recorder();
    const runner = run(
      [
        fakeSource({
          layer: "cables",
          transport: "static",
          refreshRate: 0,
          fetch: async () => new ArrayBuffer(4),
          normalise: () => {
            throw sourceError(
              "bad-data",
              "The cable data file could not be read. Unknown version 9.",
            );
          },
        }),
      ],
      host,
      "cables",
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(host.states.get("fake")).toEqual({
      status: "error",
      message: "The cable data file could not be read. Unknown version 9.",
    });
    runner.dispose();
  });
});

describe("sources whose provider rations downloads", () => {
  test("a request that gets no answer is sent once and not repeated for a quarter of an hour", async () => {
    const host = recorder(new MemoryResponseCache());
    // In a browser a 403 without CORS headers looks exactly like this.
    host.respond = () => {
      throw new TypeError("Failed to fetch");
    };
    const runner = run([rationed()], host, "satellites");
    await vi.advanceTimersByTimeAsync(5000);
    expect(host.requests).toHaveLength(1);
    expect(host.states.get("fake")).toEqual({
      status: "offline",
      message:
        "Test Provider could not be reached, or refused the request. We'll try again in about 15 minutes.",
    });
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(host.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.requests).toHaveLength(2);
    runner.dispose();
  });

  test("with no network at all it is the usual backoff, and nothing is held against the provider", async () => {
    const cache = new MemoryResponseCache();
    const host = recorder(cache);
    host.isOnline = false;
    host.respond = () => {
      throw new TypeError("Failed to fetch");
    };
    const runner = run([rationed()], host, "satellites");
    await vi.advanceTimersByTimeAsync(10);
    expect(host.states.get("fake")?.message).toBe(
      "Satellites are offline. Test Provider isn't reachable, so we'll keep trying.",
    );
    expect(await readHold(cache, "fake", Date.now())).toBeNull();
    host.isOnline = true;
    host.respond = () => new Response(JSON.stringify({ n: 1 }));
    await vi.advanceTimersByTimeAsync(2500);
    expect(host.states.get("fake")?.status).toBe("live");
    runner.dispose();
  });

  test("a 502 is not retried on the spot, and any error answer waits out the cache lifetime", async () => {
    const host = recorder(new MemoryResponseCache());
    host.respond = () => new Response("bad gateway", { status: 502 });
    const runner = run([rationed()], host, "satellites");
    await vi.advanceTimersByTimeAsync(5000);
    expect(host.requests).toHaveLength(1);
    expect(host.states.get("fake")).toEqual({
      status: "offline",
      message: "Test Provider answered HTTP 502. We'll try again in about 3 hours.",
    });
    await vi.advanceTimersByTimeAsync(3 * HOUR - 60_000);
    expect(host.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(host.requests).toHaveLength(2);
    runner.dispose();

    // The same answer to a source with no such limits is retried at once, as before.
    const plain = recorder();
    plain.respond = () => new Response("bad gateway", { status: 502 });
    const other = run(
      [
        fakeSource({
          fetch: async (ctx: SourceContext) => {
            const response = await ctx.fetch("https://provider.example/feed");
            if (!response.ok) throw sourceError("http", "Feed answered HTTP 502.", 502);
            return { n: 1 };
          },
          normalise: entities,
        }),
      ],
      plain,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(plain.requests).toHaveLength(2);
    other.dispose();
  });

  test("an unreadable answer is thrown out of the cache, so it cannot be served again", async () => {
    const cache = new MemoryResponseCache();
    const host = recorder(cache);
    host.respond = () => new Response("<html>Maintenance</html>");
    const runner = run([rationed()], host, "satellites");
    await vi.advanceTimersByTimeAsync(10);
    expect(host.states.get("fake")).toEqual({
      status: "error",
      message: "Test Provider sent no usable orbital elements. We'll try again in about 3 hours.",
    });
    expect(await cache.match(URL_ELEMENTS)).toBeNull();
    // The next try goes to the provider rather than replaying the page it sent.
    host.respond = () => new Response(JSON.stringify({ n: 9 }));
    await vi.advanceTimersByTimeAsync(3 * HOUR + 1000);
    expect(host.requests).toHaveLength(2);
    expect(host.states.get("fake")?.status).toBe("live");
    runner.dispose();
  });

  test("the cache is consulted before the very first request after a reload", async () => {
    const cache = new MemoryResponseCache();
    await cache.put(URL_ELEMENTS, new Response(JSON.stringify({ n: 3 })), T0 - HOUR);
    const host = recorder(cache);
    host.respond = () => new Response("no", { status: 403 });
    let fetches = 0;
    const runner = run([rationed({ onFetch: () => fetches++ })], host, "satellites");
    await vi.advanceTimersByTimeAsync(10);
    expect(fetches).toBe(1);
    expect(host.requests).toHaveLength(0);
    expect(host.states.get("fake")?.status).toBe("live");
    expect(host.updates[0].columns.ids[0]).toBe(3);
    runner.dispose();
  });
});

describe("viewAware sources", () => {
  test("fetch again when the camera settles somewhere new, no sooner than refreshRate", async () => {
    const host = recorder();
    host.viewNow = viewAt(10, 50, 5);
    const seen: (number | undefined)[] = [];
    const runner = run(
      [
        fakeSource({
          layer: "webcams",
          refreshRate: 60_000,
          viewAware: true,
          fetch: async (ctx: SourceContext) => {
            seen.push(ctx.view?.lon);
            return { n: 1 };
          },
          normalise: entities,
        }),
      ],
      host,
      "webcams",
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([10]);

    // A nudge within the same picture is not a new view.
    await vi.advanceTimersByTimeAsync(10_000);
    host.viewNow = viewAt(12, 51, 5.4);
    runner.viewChanged();
    // Somewhere else entirely: due as soon as the refresh rate allows, a minute after the last fetch.
    host.viewNow = viewAt(100, 20, 5);
    runner.viewChanged();
    await vi.advanceTimersByTimeAsync(49_000);
    expect(seen).toEqual([10]);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(seen).toEqual([10, 100]);

    // The ordinary cadence carries on from there (61.5 s with this jitter), and a
    // view that has not changed asks for nothing extra.
    runner.viewChanged();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seen).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(seen).toHaveLength(3);
    runner.dispose();
  });

  test("a zoom level counts as a new view, and a one-shot source refetches at once", async () => {
    const host = recorder();
    host.viewNow = viewAt(10, 50, 5);
    let fetches = 0;
    const runner = run(
      [
        fakeSource({
          layer: "webcams",
          refreshRate: 0,
          viewAware: true,
          fetch: async () => ({ n: ++fetches }),
          normalise: entities,
        }),
      ],
      host,
      "webcams",
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetches).toBe(1);
    host.viewNow = viewAt(10, 50, 6.2, 5);
    runner.viewChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetches).toBe(2);
    runner.dispose();
  });

  test("a source that does not declare it is not handed the view, and is not refetched for it", async () => {
    const host = recorder();
    host.viewNow = viewAt(10, 50, 5);
    const seen: unknown[] = [];
    const runner = run(
      [
        fakeSource({
          layer: "webcams",
          refreshRate: 600_000,
          fetch: async (ctx: SourceContext) => {
            // What the camera-list plugins do: they would thin the list to this view for good.
            seen.push(ctx.view);
            return { n: 1 };
          },
          normalise: entities,
        }),
      ],
      host,
      "webcams",
    );
    await vi.advanceTimersByTimeAsync(0);
    host.viewNow = viewAt(114, 22, 9);
    runner.viewChanged();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seen).toEqual([undefined]);
    runner.dispose();
  });
});

describe("tile overlays", () => {
  const overlay: TileOverlay = {
    tiles: ["https://tiles.example/a/{z}/{x}/{y}.png"],
    tileSize: 256,
    minZoom: 0,
    maxZoom: 7,
    opacity: 0.7,
  };

  test("carry the plugin's credit unless the plugin set one", async () => {
    const host = recorder();
    const own = { text: "Own credit", url: "https://own.example", onMap: true };
    const runner = new SourceRunner(
      [
        fakeSource({
          id: "plain",
          layer: "radar",
          fetch: async () => 1,
          normalise: () => ({ type: "tiles", overlay }),
        }),
        fakeSource({
          id: "credited",
          layer: "imagery",
          fetch: async () => 1,
          normalise: () => ({ type: "tiles", overlay: { ...overlay, attribution: own } }),
        }),
      ],
      host,
    );
    runner.setLayerEnabled("radar", true);
    runner.setLayerEnabled("imagery", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(host.tiles[0]?.attribution).toEqual({
      text: "Test Provider",
      url: "https://example.org",
    });
    expect(host.tiles[1]?.attribution).toEqual(own);
    // The plugin's object is not written to.
    expect(overlay.attribution).toBeUndefined();
    runner.dispose();
  });

  test("an overlay that has not changed is not sent again; a changed one is", async () => {
    const host = recorder();
    let frame = "a";
    const runner = run(
      [
        fakeSource({
          layer: "radar",
          refreshRate: 10_000,
          fetch: async () => 1,
          normalise: () => ({
            type: "tiles",
            overlay: { ...overlay, tiles: [`https://tiles.example/${frame}/{z}/{x}/{y}.png`] },
          }),
        }),
      ],
      host,
      "radar",
    );
    await vi.advanceTimersByTimeAsync(25_000);
    // Three fetches, one overlay.
    expect(host.tiles).toHaveLength(1);
    frame = "b";
    await vi.advanceTimersByTimeAsync(11_000);
    expect(host.tiles).toHaveLength(2);
    // Switching off and on starts from nothing: the renderer was told the overlay is gone.
    runner.setLayerEnabled("radar", false);
    runner.setLayerEnabled("radar", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(host.tiles).toHaveLength(3);
    runner.dispose();
  });
});

describe("the scrubbed clock", () => {
  test("a source that depends on the moment is re-normalised for it, at a bounded rate", async () => {
    const host = recorder();
    let normalised = 0;
    const event: HaloEvent = {
      id: "q1",
      topic: "quake",
      timeMs: T0,
      title: "M6.1 earthquake near Tonga",
    };
    const runner = run(
      [
        fakeSource({
          refreshRate: 60_000,
          fetch: async () => ({ n: 1 }),
          normalise: (raw, ctx) => {
            normalised++;
            return { ...entities(raw, ctx), events: [event] };
          },
        }),
      ],
      host,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(normalised).toBe(1);
    expect(host.events).toHaveLength(1);
    const liveState = host.states.get("fake");

    // The scrubber is dragged: twenty clock changes in a hundred milliseconds.
    for (let i = 0; i < 20; i++) {
      host.clock = { mode: "scrub", timeMs: T0 - 600_000 + i * 1000 };
      runner.clockChanged();
      await vi.advanceTimersByTimeAsync(5);
    }
    await vi.advanceTimersByTimeAsync(300);
    // Not twenty passes, and the last one is for where the scrubber came to rest.
    expect(normalised).toBeGreaterThanOrEqual(2);
    expect(normalised).toBeLessThanOrEqual(4);
    expect(host.updates.at(-1)?.timeMs).toBe(T0 - 600_000 + 19_000);
    // A replayed moment makes no ticker lines, and is not "new data arriving".
    expect(host.events).toHaveLength(1);
    expect(host.states.get("fake")?.updatedMs).toBe(liveState?.updatedMs);

    // Nothing more happens while the clock stands still.
    const settled = normalised;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(normalised).toBe(settled);

    // Back to live: once more, for now.
    host.clock = { mode: "live", timeMs: 0 };
    const liveAt = Date.now();
    runner.clockChanged();
    await vi.advanceTimersByTimeAsync(300);
    expect(normalised).toBe(settled + 1);
    expect(host.updates.at(-1)?.timeMs).toBe(liveAt);
    runner.dispose();
  });

  test("static geometry is left alone", async () => {
    const host = recorder();
    let normalised = 0;
    const runner = run(
      [
        fakeSource({
          layer: "cables",
          transport: "static",
          refreshRate: 0,
          fetch: async () => 1,
          normalise: () => {
            normalised++;
            return {
              type: "paths",
              paths: {
                count: 1,
                ids: Uint32Array.of(1),
                startIndices: Uint32Array.of(0, 2),
                positions: Float32Array.of(0, 0, 1, 1),
                names: ["Cable"],
              },
            };
          },
        }),
      ],
      host,
      "cables",
    );
    await vi.advanceTimersByTimeAsync(0);
    host.clock = { mode: "scrub", timeMs: T0 - 600_000 };
    runner.clockChanged();
    await vi.advanceTimersByTimeAsync(1000);
    expect(normalised).toBe(1);
    expect(host.paths).toBe(1);
    runner.dispose();
  });
});

describe("policy fetch options", () => {
  const policy = (overrides: Partial<Parameters<typeof createPolicyFetch>[0]>) =>
    createPolicyFetch({
      fetch: (async () => new Response("ok")) as typeof fetch,
      signal: new AbortController().signal,
      timeoutMs: 1000,
      cache: null,
      cacheTtlMs: 0,
      now: () => Date.now(),
      ...overrides,
    });

  test("with quickRetry off, a failure or a 503 is one request", async () => {
    let calls = 0;
    const failing = policy({
      quickRetry: false,
      fetch: (async () => {
        calls++;
        throw new TypeError("Failed to fetch");
      }) as typeof fetch,
    });
    await expect(failing("https://provider.example/x")).rejects.toBeInstanceOf(TypeError);
    expect(calls).toBe(1);

    calls = 0;
    const unavailable = policy({
      quickRetry: false,
      fetch: (async () => {
        calls++;
        return new Response("", { status: 503 });
      }) as typeof fetch,
    });
    expect((await unavailable("https://provider.example/x")).status).toBe(503);
    expect(calls).toBe(1);
  });

  test("cacheOnly answers from the cache whatever its age and never touches the network", async () => {
    const cache = new MemoryResponseCache();
    await cache.put("https://provider.example/old", new Response("old"), T0 - 100 * HOUR);
    let calls = 0;
    let stale = 0;
    const offline = policy({
      cache,
      cacheTtlMs: HOUR,
      cacheOnly: true,
      offlineError: () => new Error("held"),
      onStale: () => stale++,
      fetch: (async () => {
        calls++;
        return new Response("fresh");
      }) as typeof fetch,
    });
    expect(await (await offline("https://provider.example/old")).text()).toBe("old");
    expect(stale).toBe(1);
    await expect(offline("https://provider.example/missing")).rejects.toThrow("held");
    // Not cacheable at all (a POST): refused rather than sent.
    await expect(offline("https://provider.example/old", { method: "POST" })).rejects.toThrow(
      "held",
    );
    expect(calls).toBe(0);
  });

  test("a stored response is reported, and the status behind a stale answer too", async () => {
    const cache = new MemoryResponseCache();
    const stored: string[] = [];
    const stale: number[] = [];
    let status = 200;
    const fetching = policy({
      cache,
      cacheTtlMs: 1000,
      quickRetry: false,
      onStored: (url) => stored.push(url),
      onStale: (s) => stale.push(s),
      fetch: (async () => new Response("body", { status })) as typeof fetch,
    });
    await fetching("https://provider.example/a");
    expect(stored).toEqual(["https://provider.example/a"]);
    vi.setSystemTime(T0 + 5000);
    status = 403;
    expect(await (await fetching("https://provider.example/a")).text()).toBe("body");
    expect(stale).toEqual([403]);
  });

  test("a hold is written, read back while it runs, and gone once it has passed or been cleared", async () => {
    const cache = new MemoryResponseCache();
    expect(await readHold(cache, "celestrak-gp", T0)).toBeNull();
    await writeHold(cache, "celestrak-gp", { untilMs: T0 + HOUR, message: "Refused." }, T0);
    expect(await readHold(cache, "celestrak-gp", T0 + 1000)).toEqual({
      untilMs: T0 + HOUR,
      message: "Refused.",
    });
    expect(await readHold(cache, "usgs-quakes", T0 + 1000)).toBeNull();
    expect(await readHold(cache, "celestrak-gp", T0 + HOUR)).toBeNull();
    await writeHold(cache, "celestrak-gp", null, T0);
    expect(await readHold(cache, "celestrak-gp", T0 + 1000)).toBeNull();
    // No cache at all: nothing to remember, nothing breaks.
    await writeHold(null, "x", { untilMs: T0 + HOUR, message: "" }, T0);
    expect(await readHold(null, "x", T0)).toBeNull();
  });
});
