import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { EntityKind } from "@orya-halo/schema";
import type {
  EntityUpdate,
  HaloEvent,
  LayerId,
  SourceContext,
  SourcePlugin,
} from "@orya-halo/schema";
import {
  MemoryResponseCache,
  createPolicyFetch,
  openResponseCache,
  parseRetryAfter,
} from "./fetching.ts";
import type { ResponseCache } from "./fetching.ts";
import type { FeedState } from "./layers.ts";
import { SourceRunner } from "./runner.ts";
import type { RunnerHost } from "./runner.ts";
import { fakeSource, makeUpdate } from "./testing.ts";

const T0 = 1_800_000_000_000;

interface Recorder extends RunnerHost {
  updates: EntityUpdate[];
  events: HaloEvent[];
  states: Map<string, FeedState | null>;
  stateLog: (FeedState["status"] | "cleared")[];
  stopped: string[];
  clock: { mode: "live" | "scrub"; timeMs: number };
  requests: string[];
  respond: (url: string) => Response | Promise<Response>;
}

function recorder(cache: ResponseCache | null = null, keys: Record<string, string> = {}): Recorder {
  const host: Recorder = {
    updates: [],
    events: [],
    states: new Map(),
    stateLog: [],
    stopped: [],
    clock: { mode: "live", timeMs: 0 },
    requests: [],
    respond: () => new Response("{}"),
    now: () => (host.clock.mode === "scrub" ? host.clock.timeMs : Date.now()),
    isLive: () => host.clock.mode === "live",
    view: () => undefined,
    key: (name) => keys[name],
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
    onPaths: () => {},
    onTiles: () => {},
    onState: (plugin, state) => {
      host.states.set(plugin.id, state);
      host.stateLog.push(state ? state.status : "cleared");
    },
    onStopped: (plugin) => host.stopped.push(plugin.id),
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SourceRunner", () => {
  test("fetches at once, then every refreshRate", async () => {
    const host = recorder();
    let n = 0;
    const runner = run(
      [fakeSource({ refreshRate: 10_000, fetch: async () => ({ n: ++n }), normalise: entities })],
      host,
    );
    expect(host.states.get("fake")?.status).toBe("loading");
    await vi.advanceTimersByTimeAsync(0);
    expect(n).toBe(1);
    expect(host.states.get("fake")?.status).toBe("live");
    // Jitter is fixed at +2.5% here, so the second fetch is due at 10.25 s.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(n).toBe(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(n).toBe(2);
    await vi.advanceTimersByTimeAsync(10_250 * 3);
    expect(n).toBe(5);
    expect(host.updates).toHaveLength(5);
    runner.dispose();
  });

  test("a static source is fetched once", async () => {
    const host = recorder();
    let n = 0;
    const runner = run(
      [
        fakeSource({
          refreshRate: 0,
          transport: "static",
          fetch: async () => ({ n: ++n }),
          normalise: entities,
        }),
      ],
      host,
    );
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(n).toBe(1);
    runner.dispose();
  });

  test("backs off exponentially after failures and recovers", async () => {
    const host = recorder();
    const calls: number[] = [];
    let failing = true;
    const runner = run(
      [
        fakeSource({
          refreshRate: 10_000,
          fetch: async () => {
            calls.push(Date.now() - T0);
            if (failing) throw new TypeError("Failed to fetch");
            return { n: 1 };
          },
          normalise: entities,
        }),
      ],
      host,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(host.states.get("fake")?.status).toBe("offline");
    expect(host.states.get("fake")?.message).toBe(
      "Earthquakes are offline. Test Provider isn't reachable, so we'll keep trying.",
    );
    // 2 s, 4 s, 8 s, 16 s, 32 s, then capped at 60 s.
    await vi.advanceTimersByTimeAsync(200_000);
    expect(calls.slice(0, 8)).toEqual([0, 2000, 6000, 14_000, 30_000, 62_000, 122_000, 182_000]);
    failing = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.states.get("fake")?.status).toBe("live");
    // Back on the normal cadence, and the next failure starts the backoff from the bottom.
    const recovered = calls.length;
    await vi.advanceTimersByTimeAsync(10_250);
    expect(calls.length).toBe(recovered + 1);
    failing = true;
    await vi.advanceTimersByTimeAsync(10_250 + 2000 + 4000);
    const failed = calls.slice(recovered + 1);
    expect(failed.slice(1, 3).map((t) => t - failed[0])).toEqual([2000, 6000]);
    // It has shown data before, so now it is late rather than offline.
    expect(host.states.get("fake")?.status).toBe("degraded");
    expect(host.states.get("fake")?.message).toBe(
      "Earthquakes may be out of date. Test Provider isn't responding, so we'll keep trying.",
    );
    runner.dispose();
  });

  test("waits at least as long as Retry-After asks", async () => {
    const host = recorder();
    host.respond = () =>
      new Response("slow down", { status: 429, headers: { "retry-after": "120" } });
    const calls: number[] = [];
    const runner = run(
      [
        fakeSource({
          refreshRate: 10_000,
          fetch: async (ctx: SourceContext) => {
            calls.push(Date.now() - T0);
            const response = await ctx.fetch("https://example.org/feed");
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return { n: 1 };
          },
          normalise: entities,
        }),
      ],
      host,
    );
    await vi.advanceTimersByTimeAsync(119_000);
    expect(calls).toEqual([0]);
    // One request went out: a 429 with Retry-After is not retried on the spot.
    expect(host.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(calls).toEqual([0, 120_000]);
    expect(host.states.get("fake")?.status).toBe("offline");
    runner.dispose();
  });

  test("a refused request is an error, with a hint when the key is the likely cause", async () => {
    const host = recorder();
    host.respond = () => new Response("no", { status: 403 });
    const runner = run(
      [
        fakeSource({
          fetch: async (ctx: SourceContext) => {
            const response = await ctx.fetch("https://example.org/feed");
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return { n: 1 };
          },
          normalise: entities,
        }),
      ],
      host,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(host.states.get("fake")).toEqual({
      status: "error",
      message:
        "Earthquakes couldn't be loaded. Test Provider refused the request. Check the API key.",
    });
    runner.dispose();
  });

  test("data that cannot be normalised is an error, not a crash", async () => {
    const host = recorder();
    const runner = run(
      [
        fakeSource({
          fetch: async () => ({ n: 1 }),
          normalise: () => {
            throw new Error("unexpected shape");
          },
        }),
      ],
      host,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(host.states.get("fake")?.status).toBe("error");
    expect(host.states.get("fake")?.message).toBe(
      "Earthquakes couldn't be read. Test Provider sent data in a form we don't recognise.",
    );
    runner.dispose();
  });

  test("switching the layer off aborts the request in flight and stops polling", async () => {
    const host = recorder();
    let signal: AbortSignal | null = null;
    let n = 0;
    const runner = run(
      [
        fakeSource({
          refreshRate: 5000,
          fetch: (ctx: SourceContext) => {
            n++;
            signal = ctx.signal;
            // Never settles on its own, like a hung connection.
            return new Promise((_, reject) =>
              ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason)),
            );
          },
          normalise: entities,
        }),
      ],
      host,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(n).toBe(1);
    expect((signal as AbortSignal | null)?.aborted).toBe(false);
    runner.setLayerEnabled("quakes", false);
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    expect(host.stopped).toEqual(["fake"]);
    expect(host.states.get("fake")).toBeNull();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(n).toBe(1);
    // The aborted request must not have been reported as a failure.
    expect(host.stateLog).toEqual(["loading", "cleared"]);
    runner.dispose();
  });

  test("a result that arrives after off-and-on-again is discarded", async () => {
    const host = recorder();
    const resolvers: ((raw: unknown) => void)[] = [];
    const runner = run(
      [
        fakeSource({
          refreshRate: 0,
          fetch: () => new Promise((resolve) => resolvers.push(resolve)),
          normalise: entities,
        }),
      ],
      host,
    );
    runner.setLayerEnabled("quakes", false);
    runner.setLayerEnabled("quakes", true);
    expect(resolvers).toHaveLength(2);
    resolvers[0]({ n: 111 });
    await vi.advanceTimersByTimeAsync(0);
    expect(host.updates).toHaveLength(0);
    resolvers[1]({ n: 222 });
    await vi.advanceTimersByTimeAsync(0);
    expect(host.updates.map((u) => u.columns.ids[0])).toEqual([222]);
    runner.dispose();
  });

  test("a source that hangs is cut off by the timeout and retried", async () => {
    const host = recorder();
    let n = 0;
    const runner = new SourceRunner(
      [
        fakeSource({
          refreshRate: 10_000,
          fetch: () => (++n === 1 ? new Promise(() => {}) : Promise.resolve({ n })),
          normalise: entities,
        }),
      ],
      host,
      { random: () => 0.5, fetchTimeoutMs: 5000, backoffBaseMs: 2000 },
    );
    runner.setLayerEnabled("quakes", true);
    await vi.advanceTimersByTimeAsync(4999);
    expect(host.states.get("fake")?.status).toBe("loading");
    await vi.advanceTimersByTimeAsync(1);
    expect(host.states.get("fake")?.status).toBe("offline");
    await vi.advanceTimersByTimeAsync(2000);
    expect(n).toBe(2);
    expect(host.states.get("fake")?.status).toBe("live");
    runner.dispose();
  });

  test("a missing key is reported in plain words and nothing is fetched", async () => {
    const host = recorder();
    let n = 0;
    const plugin = fakeSource({
      layer: "fires",
      requiresKey: "FIRMS_MAP_KEY",
      fetch: async () => ({ n: ++n }),
      normalise: entities,
    });
    const runner = run([plugin], host, "fires");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(n).toBe(0);
    expect(host.states.get("fake")).toEqual({
      status: "needs-key",
      message:
        "Wildfires need a key from Test Provider. Add FIRMS_MAP_KEY to your .env file and reload.",
    });
    runner.dispose();
  });

  test("a configured key reaches the plugin", async () => {
    const host = recorder(null, { FIRMS_MAP_KEY: "abc123" });
    let seen: string | undefined;
    const plugin = fakeSource({
      layer: "fires",
      requiresKey: "FIRMS_MAP_KEY",
      fetch: async (ctx: SourceContext) => {
        seen = ctx.key;
        return { n: 1 };
      },
      normalise: entities,
    });
    const runner = run([plugin], host, "fires");
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toBe("abc123");
    expect(host.states.get("fake")?.status).toBe("live");
    runner.dispose();
  });

  test("does not poll while the tab is hidden, and catches up on return", async () => {
    const host = recorder();
    const calls: number[] = [];
    const runner = run(
      [
        fakeSource({
          refreshRate: 10_000,
          fetch: async () => {
            calls.push(Date.now() - T0);
            return { n: calls.length };
          },
          normalise: entities,
        }),
      ],
      host,
    );
    await vi.advanceTimersByTimeAsync(1000);
    runner.setVisible(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls).toEqual([0]);
    runner.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    // Overdue by minutes: fetched the moment the tab is back, then on schedule again.
    expect(calls).toEqual([0, 601_000]);
    await vi.advanceTimersByTimeAsync(10_250);
    expect(calls).toHaveLength(3);
    runner.dispose();
  });

  test("returning before a poll is due does not fetch early", async () => {
    const host = recorder();
    let n = 0;
    const runner = run(
      [fakeSource({ refreshRate: 10_000, fetch: async () => ({ n: ++n }), normalise: entities })],
      host,
    );
    await vi.advanceTimersByTimeAsync(1000);
    runner.setVisible(false);
    await vi.advanceTimersByTimeAsync(3000);
    runner.setVisible(true);
    await vi.advanceTimersByTimeAsync(6000);
    expect(n).toBe(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(n).toBe(2);
    runner.dispose();
  });

  test("re-normalises on recomputeRate without fetching again", async () => {
    const host = recorder();
    let fetches = 0;
    const runner = run(
      [
        fakeSource({
          layer: "satellites",
          transport: "compute",
          refreshRate: 3_600_000,
          recomputeRate: 1000,
          fetch: async () => ({ n: ++fetches }),
          normalise: entities,
        }),
      ],
      host,
      "satellites",
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(host.updates).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetches).toBe(1);
    expect(host.updates).toHaveLength(6);
    // Each pass is stamped with the clock at that moment.
    expect(host.updates.map((u) => u.timeMs - T0)).toEqual([0, 1000, 2000, 3000, 4000, 5000]);
    runner.dispose();
  });

  test("while scrubbing, recomputes only when the clock moves, at the scrubbed time", async () => {
    const host = recorder();
    const runner = run(
      [
        fakeSource({
          layer: "satellites",
          transport: "compute",
          refreshRate: 3_600_000,
          recomputeRate: 1000,
          fetch: async () => ({ n: 1 }),
          normalise: entities,
        }),
      ],
      host,
      "satellites",
    );
    await vi.advanceTimersByTimeAsync(0);
    host.clock = { mode: "scrub", timeMs: T0 - 600_000 };
    runner.clockChanged();
    expect(host.updates).toHaveLength(2);
    expect(host.updates[1].timeMs).toBe(T0 - 600_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(host.updates).toHaveLength(2);
    host.clock = { mode: "live", timeMs: 0 };
    runner.clockChanged();
    await vi.advanceTimersByTimeAsync(2000);
    expect(host.updates).toHaveLength(5);
    runner.dispose();
  });

  test("recomputing pauses while hidden", async () => {
    const host = recorder();
    const runner = run(
      [
        fakeSource({
          layer: "satellites",
          transport: "compute",
          refreshRate: 0,
          recomputeRate: 1000,
          fetch: async () => ({ n: 1 }),
          normalise: entities,
        }),
      ],
      host,
      "satellites",
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(host.updates).toHaveLength(3);
    runner.setVisible(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.updates).toHaveLength(3);
    runner.setVisible(true);
    expect(host.updates).toHaveLength(4);
    runner.dispose();
  });

  test("routes events alongside entities", async () => {
    const host = recorder();
    const event: HaloEvent = {
      id: "q1",
      topic: "quake",
      timeMs: T0,
      title: "Magnitude 6.1 near Tonga",
    };
    const runner = run(
      [
        fakeSource({
          fetch: async () => ({ n: 1 }),
          normalise: (raw, ctx) => ({ ...entities(raw, ctx), events: [event] }),
        }),
      ],
      host,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(host.events).toEqual([event]);
    runner.dispose();
  });

  test("opens a stream, forwards its data and reopens it after an error", async () => {
    const host = recorder();
    const opened: {
      onData: (raw: unknown) => void;
      onError: (error: Error) => void;
      closed: boolean;
    }[] = [];
    const runner = run(
      [
        fakeSource({
          refreshRate: 0,
          stream: (_ctx, onData, onError) => {
            const handle = { onData, onError, closed: false };
            opened.push(handle);
            return () => {
              handle.closed = true;
            };
          },
          normalise: entities,
        }),
      ],
      host,
    );
    expect(opened).toHaveLength(1);
    opened[0].onData({ n: 5 });
    opened[0].onData({ n: 6 });
    expect(host.updates.map((u) => u.columns.ids[0])).toEqual([5, 6]);
    expect(host.states.get("fake")?.status).toBe("live");
    opened[0].onError(new Error("socket closed"));
    expect(opened[0].closed).toBe(true);
    expect(host.states.get("fake")?.status).toBe("degraded");
    await vi.advanceTimersByTimeAsync(2000);
    expect(opened).toHaveLength(2);
    // Data from the dead stream is ignored.
    opened[0].onData({ n: 99 });
    expect(host.updates).toHaveLength(2);
    runner.setLayerEnabled("quakes", false);
    expect(opened[1].closed).toBe(true);
    runner.dispose();
  });

  test("gateway plugins are described, not fetched", async () => {
    const host = recorder();
    let n = 0;
    const runner = run(
      [
        fakeSource({
          layer: "aircraft",
          transport: "gateway",
          fetch: async () => ({ n: ++n }),
          normalise: entities,
        }),
      ],
      host,
      "aircraft",
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(n).toBe(0);
    expect(host.states.size).toBe(0);
    runner.dispose();
  });

  test("a cacheTtl source does not hit the network again inside its TTL, even after a restart", async () => {
    const cache = new MemoryResponseCache();
    const body = JSON.stringify({ n: 42 });
    const plugin = () =>
      fakeSource({
        refreshRate: 60_000,
        cacheTtl: 2 * 3_600_000,
        fetch: async (ctx: SourceContext) =>
          (await ctx.fetch("https://example.org/elements.json")).json(),
        normalise: entities,
      });
    const first = recorder(cache);
    first.respond = () => new Response(body, { headers: { "content-type": "application/json" } });
    const runner = run([plugin()], first);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    // Polled ten times, downloaded once.
    expect(first.updates.length).toBeGreaterThanOrEqual(10);
    expect(first.requests).toHaveLength(1);
    runner.dispose();

    // "Reload": a new runner and host over the same persistent cache.
    const second = recorder(cache);
    second.respond = () => new Response(body);
    const again = run([plugin()], second);
    await vi.advanceTimersByTimeAsync(0);
    expect(second.requests).toHaveLength(0);
    expect(second.updates[0].columns.ids[0]).toBe(42);
    // Past the TTL the provider is asked again.
    await vi.advanceTimersByTimeAsync(2 * 3_600_000);
    expect(second.requests).toHaveLength(1);
    again.dispose();
  });

  test("when the network fails, an expired cached copy is served and the layer is marked late", async () => {
    const cache = new MemoryResponseCache();
    const host = recorder(cache);
    host.respond = () => new Response(JSON.stringify({ n: 7 }));
    const runner = run(
      [
        fakeSource({
          refreshRate: 60_000,
          cacheTtl: 30_000,
          fetch: async (ctx: SourceContext) =>
            (await ctx.fetch("https://example.org/feed.json")).json(),
          normalise: entities,
        }),
      ],
      host,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(host.states.get("fake")?.status).toBe("live");
    host.respond = () => {
      throw new TypeError("Failed to fetch");
    };
    await vi.advanceTimersByTimeAsync(65_000);
    expect(host.updates.length).toBe(2);
    expect(host.states.get("fake")?.status).toBe("degraded");
    runner.dispose();
  });
});

describe("policy fetch", () => {
  test("retries a network failure once, then gives up", async () => {
    let calls = 0;
    const controller = new AbortController();
    const policyFetch = createPolicyFetch({
      fetch: (async () => {
        calls++;
        throw new TypeError("Failed to fetch");
      }) as typeof fetch,
      signal: controller.signal,
      timeoutMs: 1000,
      cache: null,
      cacheTtlMs: 0,
      now: () => Date.now(),
    });
    const outcome = policyFetch("https://example.org").then(
      () => "ok",
      (error: Error) => error.name,
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(await outcome).toBe("TypeError");
    expect(calls).toBe(2);
  });

  test("times out a request that never answers", async () => {
    const controller = new AbortController();
    const policyFetch = createPolicyFetch({
      fetch: ((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
        )) as typeof fetch,
      signal: controller.signal,
      timeoutMs: 1000,
      cache: null,
      cacheTtlMs: 0,
      now: () => Date.now(),
    });
    const outcome = policyFetch("https://example.org").then(
      () => "ok",
      (error: Error) => error.name,
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(await outcome).toBe("TimeoutError");
  });

  test("the Cache API store round-trips a response with its age, and shrugs off a broken cache", async () => {
    // A stand-in for CacheStorage: just enough of the interface the store uses.
    const held = new Map<string, Response>();
    const storage = {
      open: async () => ({
        match: async (url: string) => held.get(url)?.clone(),
        put: async (url: string, response: Response) => void held.set(url, response),
      }),
    };
    const globals = globalThis as { caches?: unknown };
    const original = globals.caches;
    globals.caches = storage;
    try {
      const cache = openResponseCache();
      expect(cache).not.toBeInstanceOf(MemoryResponseCache);
      expect(await cache.match("https://example.org/a")).toBeNull();
      await cache.put(
        "https://example.org/a",
        new Response("payload", { headers: { "content-type": "text/plain" } }),
        T0,
      );
      const hit = await cache.match("https://example.org/a");
      expect(hit?.storedMs).toBe(T0);
      expect(hit?.response.headers.get("content-type")).toBe("text/plain");
      expect(await hit?.response.text()).toBe("payload");
      // An entry someone else wrote, with no timestamp, is not trusted.
      held.set("https://example.org/b", new Response("?"));
      expect(await cache.match("https://example.org/b")).toBeNull();

      globals.caches = {
        open: async () => {
          throw new Error("storage is unavailable");
        },
      };
      const broken = openResponseCache();
      expect(await broken.match("https://example.org/a")).toBeNull();
      await expect(
        broken.put("https://example.org/a", new Response("x"), T0),
      ).resolves.toBeUndefined();
    } finally {
      globals.caches = original;
    }
    // With no Cache API at all, the session-only store stands in.
    if (original === undefined) expect(openResponseCache()).toBeInstanceOf(MemoryResponseCache);
  });

  test("reads Retry-After as seconds or as a date", () => {
    expect(parseRetryAfter("30", T0)).toBe(30_000);
    expect(parseRetryAfter(new Date(T0 + 90_000).toUTCString(), T0)).toBe(90_000);
    expect(parseRetryAfter("soon", T0)).toBeNull();
    expect(parseRetryAfter(null, T0)).toBeNull();
    // A provider cannot park us for a day.
    expect(parseRetryAfter("86400", T0)).toBe(3_600_000);
  });
});
