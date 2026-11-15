/**
 * The satellite layer end to end inside the worker's runner: the real
 * CelesTrak plugin from @orya-halo/sources, the runner, the response cache
 * and holds, with a scripted network. What is checked is what a visitor
 * sees (layer state and message, entities) and what CelesTrak sees (every
 * request it gets).
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type {
  DataConfig,
  EntityUpdate,
  LayerId,
  SourceContext,
  SourcePlugin,
} from "@orya-halo/schema";
import { EntityKind, LAYER_IDS } from "@orya-halo/schema";
import { CELESTRAK_GP_URL } from "@orya-halo/sources";
import type { SatelliteElements } from "@orya-halo/sources";
import { MemoryResponseCache } from "./fetching.ts";
import type { ResponseCache } from "./fetching.ts";
import type { FeedState } from "./layers.ts";
import { satellites } from "./registry.ts";
import { SourceRunner } from "./runner.ts";
import type { RunnerHost } from "./runner.ts";
import { fakeSource, makeUpdate, sourceError } from "./testing.ts";

const fixture = (name: string) =>
  readFileSync(
    new URL(`../../../../packages/sources/src/satellites/fixtures/${name}`, import.meta.url),
    "utf8",
  );
/** Recorded from CelesTrak on 2026-11-14: GROUP=stations, 18 objects. Stands in for a live answer. */
const LIVE_CSV = fixture("stations.csv");
/** A recorded cut of GROUP=active, 44 objects. Stands in for the bundled snapshot. */
const SNAPSHOT_CSV = fixture("mixed.csv");
const ASSETS = "https://halo.example/";
const SNAPSHOT_URL = `${ASSETS}data/satellites.csv`;
const GATEWAY_URL = "https://gateway.example/v1/proxy/celestrak/active.csv";
/** 2026-11-14T12:00:00Z. */
const T0 = 1_794_657_600_000;
const HOUR = 3_600_000;
const SNAPSHOT_MESSAGE =
  "Showing satellite orbits from 14 November. Fresher data is temporarily unavailable.";

type Answer = () => Response | Promise<Response>;

interface Host extends RunnerHost {
  states: FeedState[];
  updates: EntityUpdate[];
  requests: string[];
  /** How each URL is answered; anything not listed fails as a dead network would. */
  answers: Map<string, Answer>;
  last(): FeedState | undefined;
  count(url: string): number;
}

function host(cache: ResponseCache | null): Host {
  const h: Host = {
    states: [],
    updates: [],
    requests: [],
    answers: new Map(),
    last: () => h.states.at(-1),
    count: (url) => h.requests.filter((r) => r === url).length,
    now: () => Date.now(),
    isLive: () => true,
    view: () => undefined,
    key: () => undefined,
    assetBase: ASSETS,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      h.requests.push(url);
      if (init?.signal?.aborted) throw init.signal.reason;
      const answer = h.answers.get(url);
      if (!answer) throw new TypeError("Failed to fetch");
      return answer();
    }) as typeof fetch,
    cache,
    online: () => true,
    onEntities: (_plugin, update) => h.updates.push(update),
    onEvents: () => {},
    onPaths: () => {},
    onTiles: () => {},
    onState: (_plugin, state) => {
      if (state) h.states.push(state);
    },
    onStopped: () => {},
  };
  return h;
}

function config(gatewayUrl: string | null): DataConfig {
  return {
    gatewayUrl,
    assetBase: ASSETS,
    keys: {},
    layers: Object.fromEntries(LAYER_IDS.map((id) => [id, true])) as Record<LayerId, boolean>,
    historyMs: 30 * 60_000,
  };
}

function start(h: Host, plugin: SourcePlugin = satellites(config(null))): SourceRunner {
  const runner = new SourceRunner([plugin], h, { random: () => 0.5 });
  runner.setLayerEnabled(plugin.layer, true);
  return runner;
}

const csv =
  (body: string, status = 200): Answer =>
  () =>
    new Response(body, { status });
const origin = (runner: SourceRunner) =>
  (runner.raw("celestrak-gp") as SatelliteElements | undefined)?.origin;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("satellites in the runner", () => {
  test("CelesTrak answers: live, and the snapshot is never read", async () => {
    const h = host(new MemoryResponseCache());
    h.answers.set(CELESTRAK_GP_URL, csv(LIVE_CSV));
    h.answers.set(SNAPSHOT_URL, csv(SNAPSHOT_CSV));
    const runner = start(h);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.last()).toMatchObject({ status: "live" });
    expect(h.last()?.message).toBeUndefined();
    expect(h.updates.at(-1)?.count).toBe(18);
    expect(origin(runner)).toBe("live");
    expect(h.requests).toEqual([CELESTRAK_GP_URL]);
    runner.dispose();
  });

  test("CelesTrak out of reach: the snapshot at once, degraded with its date, and CelesTrak left alone", async () => {
    const h = host(new MemoryResponseCache());
    h.answers.set(SNAPSHOT_URL, csv(SNAPSHOT_CSV));
    const runner = start(h);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.last()).toEqual({ status: "degraded", message: SNAPSHOT_MESSAGE });
    expect(h.updates.at(-1)?.count).toBe(44);
    expect(origin(runner)).toBe("snapshot");
    // The empty-layer "offline" state never showed in between.
    expect(h.states.map((s) => s.status)).toEqual(["loading", "degraded"]);
    // Recomputed every second like live elements, still saying where they are from.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.updates.length).toBeGreaterThanOrEqual(4);
    expect(h.last()).toEqual({ status: "degraded", message: SNAPSHOT_MESSAGE });
    // A request that got no answer may have been a refusal without CORS headers: wait a while.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.count(CELESTRAK_GP_URL)).toBe(1);
    expect(h.count(SNAPSHOT_URL)).toBe(1);
    runner.dispose();
  });

  test("a 403 shows the snapshot and holds CelesTrak off, across a reload", async () => {
    const cache = new MemoryResponseCache();
    const first = host(cache);
    const refusal =
      "GP data has not updated since your last successful\ndownload of GROUP=active at 2026-11-14 10:10:22 UTC.\nData is updated once every 2 hours.";
    first.answers.set(CELESTRAK_GP_URL, csv(refusal, 403));
    first.answers.set(SNAPSHOT_URL, csv(SNAPSHOT_CSV));
    const runner = start(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(first.last()).toEqual({ status: "degraded", message: SNAPSHOT_MESSAGE });
    expect(origin(runner)).toBe("snapshot");
    expect(runner.schedule()[0].holdUntilMs).toBe(T0 + 6 * HOUR);
    runner.dispose();

    // A reload an hour later: the hold is read back before anything is sent.
    vi.setSystemTime(T0 + HOUR);
    const second = host(cache);
    second.answers.set(CELESTRAK_GP_URL, csv(LIVE_CSV));
    second.answers.set(SNAPSHOT_URL, csv(SNAPSHOT_CSV));
    const again = start(second);
    await vi.advanceTimersByTimeAsync(0);
    expect(second.last()).toEqual({ status: "degraded", message: SNAPSHOT_MESSAGE });
    expect(second.requests).toEqual([SNAPSHOT_URL]);
    // Switching the layer off and on is no way round the hold either.
    again.setLayerEnabled("satellites", false);
    again.setLayerEnabled("satellites", true);
    await vi.advanceTimersByTimeAsync(4 * HOUR);
    expect(second.count(CELESTRAK_GP_URL)).toBe(0);
    // Once the hold is over, CelesTrak is asked again and the layer goes live.
    await vi.advanceTimersByTimeAsync(1.5 * HOUR);
    expect(second.count(CELESTRAK_GP_URL)).toBe(1);
    expect(second.last()).toMatchObject({ status: "live" });
    expect(origin(again)).toBe("live");
    again.dispose();
  });

  test("a slow download: the snapshot within the fallback delay, then a quiet swap to live", async () => {
    const h = host(new MemoryResponseCache());
    h.answers.set(
      CELESTRAK_GP_URL,
      () => new Promise((resolve) => setTimeout(() => resolve(new Response(LIVE_CSV)), 8_000)),
    );
    h.answers.set(SNAPSHOT_URL, csv(SNAPSHOT_CSV));
    const runner = start(h);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.last()).toEqual({ status: "loading" });
    await vi.advanceTimersByTimeAsync(600);
    expect(h.last()).toEqual({ status: "degraded", message: SNAPSHOT_MESSAGE });
    expect(origin(runner)).toBe("snapshot");
    await vi.advanceTimersByTimeAsync(7_000);
    expect(h.last()).toMatchObject({ status: "live" });
    expect(h.last()?.message).toBeUndefined();
    expect(origin(runner)).toBe("live");
    expect(h.updates.at(-1)?.count).toBe(18);
    expect(h.requests).toEqual([CELESTRAK_GP_URL, SNAPSHOT_URL]);
    // The swap does not bring the snapshot back on the next recompute.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.last()).toMatchObject({ status: "live" });
    expect(h.updates.at(-1)?.count).toBe(18);
    runner.dispose();
  });

  test("a reload inside the cache lifetime is live from the cache, with no request at all", async () => {
    const cache = new MemoryResponseCache();
    const first = host(cache);
    first.answers.set(CELESTRAK_GP_URL, csv(LIVE_CSV));
    const runner1 = start(first);
    await vi.advanceTimersByTimeAsync(0);
    runner1.dispose();
    expect(first.requests).toEqual([CELESTRAK_GP_URL]);

    vi.setSystemTime(T0 + 2 * HOUR);
    const second = host(cache);
    const runner = start(second);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(second.last()).toMatchObject({ status: "live" });
    expect(second.requests).toEqual([]);
    runner.dispose();
  });

  test("an older cached copy beats the snapshot when CelesTrak cannot be reached", async () => {
    const cache = new MemoryResponseCache();
    const first = host(cache);
    first.answers.set(CELESTRAK_GP_URL, csv(LIVE_CSV));
    const runner = start(first);
    await vi.advanceTimersByTimeAsync(0);
    runner.dispose();

    // A day later the copy is past its lifetime and the network is down.
    vi.setSystemTime(T0 + 24 * HOUR);
    const second = host(cache);
    second.answers.set(SNAPSHOT_URL, csv(SNAPSHOT_CSV));
    const again = start(second);
    await vi.advanceTimersByTimeAsync(0);
    expect(second.last()?.status).toBe("degraded");
    expect(second.updates.at(-1)?.count).toBe(18);
    expect(second.requests).toEqual([CELESTRAK_GP_URL]);
    again.dispose();
  });

  test("with a gateway, elements come from its proxy, and its refusal is handled the same way", async () => {
    const h = host(new MemoryResponseCache());
    const mock = JSON.stringify({
      error: { code: "unavailable", message: "The gateway runs in mock mode." },
    });
    h.answers.set(
      GATEWAY_URL,
      () => new Response(mock, { status: 503, headers: { "retry-after": "600" } }),
    );
    h.answers.set(SNAPSHOT_URL, csv(SNAPSHOT_CSV));
    const runner = start(h, satellites(config("wss://gateway.example")));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.last()).toEqual({ status: "degraded", message: SNAPSHOT_MESSAGE });
    expect(h.requests).toEqual([GATEWAY_URL, SNAPSHOT_URL]);
    expect(h.count(CELESTRAK_GP_URL)).toBe(0);
    // An HTTP error waits out the cache lifetime, an hour for the gateway.
    expect(runner.schedule()[0].holdUntilMs).toBe(T0 + HOUR);
    await vi.advanceTimersByTimeAsync(HOUR - 60_000);
    expect(h.count(GATEWAY_URL)).toBe(1);
    h.answers.set(GATEWAY_URL, csv(LIVE_CSV));
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(h.count(GATEWAY_URL)).toBe(2);
    expect(h.last()).toMatchObject({ status: "live" });
    runner.dispose();
  });
});

describe("fallback in the runner, for any plugin", () => {
  const update = (n: number, ctx: { now(): number }) => ({
    type: "entities" as const,
    update: makeUpdate(EntityKind.Quake, "fake", ctx.now(), [{ id: n }]),
  });

  test("a fallback that cannot help leaves the failure state as it was", async () => {
    const h = host(null);
    const plugin = fakeSource({
      cacheTtl: HOUR,
      refreshRate: 6 * HOUR,
      fetch: async () => {
        throw sourceError("blocked", "Test Provider refused the request (HTTP 403).", 403);
      },
      fallback: async () => {
        throw new TypeError("nothing offline");
      },
      normalise: (raw, ctx) => update(raw as number, ctx),
    });
    const runner = start(h, plugin);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.last()?.status).toBe("offline");
    expect(h.last()?.message).toContain("refused the request");
    runner.dispose();
  });

  test("an empty message still makes a sentence, and a fallback is tried once per session", async () => {
    const h = host(null);
    let tries = 0;
    const plugin = fakeSource({
      refreshRate: 60_000,
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
      fallback: async (_ctx: SourceContext) => {
        tries++;
        return { raw: 5, message: "" };
      },
      normalise: (raw, ctx) => update(raw as number, ctx),
    });
    const runner = start(h, plugin);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.last()).toEqual({ status: "degraded", message: "Earthquakes may be out of date." });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(tries).toBe(1);
    expect(h.last()?.status).toBe("degraded");
    runner.dispose();
  });

  test("a fallback that finishes after the layer is switched off shows nothing", async () => {
    const h = host(null);
    let release: (() => void) | null = null;
    const plugin = fakeSource({
      refreshRate: 60_000,
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
      fallback: () =>
        new Promise((resolve) => {
          release = () => resolve({ raw: 1, message: "Old." });
        }),
      normalise: (raw, ctx) => update(raw as number, ctx),
    });
    const runner = start(h, plugin);
    await vi.advanceTimersByTimeAsync(0);
    runner.setLayerEnabled(plugin.layer, false);
    (release as (() => void) | null)?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.updates).toHaveLength(0);
    runner.dispose();
  });

  test("the fallback context never reaches the provider, only the cache and the app's files", async () => {
    const h = host(new MemoryResponseCache());
    h.answers.set(`${ASSETS}bundled.json`, () => new Response("3"));
    let seen: string[] = [];
    const plugin = fakeSource({
      cacheTtl: HOUR,
      refreshRate: 6 * HOUR,
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
      fallback: async (ctx) => {
        const provider = await ctx.fetch("https://provider.example/feed.json").then(
          () => "answered",
          () => "refused",
        );
        const own = await (await ctx.fetch(`${ctx.assetBase}bundled.json`)).json();
        seen = [provider, String(own)];
        return { raw: own as number, message: "Bundled data." };
      },
      normalise: (raw, ctx) => update(raw as number, ctx),
    });
    const runner = start(h, plugin);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(["refused", "3"]);
    expect(h.requests).toEqual([`${ASSETS}bundled.json`]);
    expect(h.last()).toEqual({ status: "degraded", message: "Bundled data." });
    runner.dispose();
  });
});
