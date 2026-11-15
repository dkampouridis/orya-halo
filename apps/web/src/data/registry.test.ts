import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import type { DataConfig, LayerId, SourceContext, SourcePlugin } from "@orya-halo/schema";
import { LAYER_IDS } from "@orya-halo/schema";
import {
  FIRMS_NEEDS_GATEWAY,
  FIRMS_NEEDS_GATEWAY_KEY,
  createPlaceSearch,
  createSources,
  firmsProxyError,
  gatewayHttpBase,
  placeScore,
  satelliteSnapshotUrl,
} from "./registry.ts";

function config(overrides: Partial<DataConfig> = {}): DataConfig {
  return {
    gatewayUrl: "wss://gateway.example/",
    assetBase: "https://halo.example/",
    keys: {},
    layers: Object.fromEntries(LAYER_IDS.map((id) => [id, true])) as Record<LayerId, boolean>,
    historyMs: 30 * 60_000,
    ...overrides,
  };
}

/** A context whose `fetch` answers every request the same way and remembers the URLs. */
function context(
  answer: () => Response | Promise<Response>,
): SourceContext & { requests: string[] } {
  const requests: string[] = [];
  return {
    requests,
    fetch: (async (input: RequestInfo | URL) => {
      requests.push(input instanceof Request ? input.url : input.toString());
      return answer();
    }) as typeof fetch,
    now: () => Date.UTC(2026, 10, 14, 17),
    signal: new AbortController().signal,
    assetBase: "https://halo.example/",
  };
}

const rejection = (promise: Promise<unknown> | undefined) =>
  (promise ?? Promise.resolve()).then(
    () => null,
    (error: unknown) => error as { name: string; code: string; message: string; status?: number },
  );

describe("createSources", () => {
  test("registers one plugin per feed, and only keyless ones", () => {
    const plugins = createSources(config());
    expect(plugins.map((p) => [p.id, p.layer])).toEqual([
      ["gateway-aircraft", "aircraft"],
      ["gateway-ships", "ships"],
      ["celestrak-gp", "satellites"],
      ["usgs-quakes", "quakes"],
      ["osm-cables", "cables"],
      ["rainviewer-radar", "radar"],
      ["gibs-truecolour", "imagery"],
      ["nasa-firms", "fires"],
      ["digitraffic-weathercams", "webcams"],
      ["hk-traffic-cameras", "webcams"],
      ["sg-lta-traffic-images", "webcams"],
      ["drivebc-highwaycams", "webcams"],
      ["calgary-traffic-cameras", "webcams"],
      ["austin-traffic-cameras", "webcams"],
    ]);
    // Windy's terms forbid publishing its key, and nothing here may need a key in the bundle.
    expect(plugins.some((p) => p.id.includes("windy"))).toBe(false);
    expect(plugins.filter((p) => p.requiresKey !== undefined)).toEqual([]);
    // Every licence allows showing the data.
    expect(plugins.every((p) => p.licence.display)).toBe(true);
  });

  test("the rain layer follows radarSource", () => {
    const radar = (source: DataConfig["radarSource"]) =>
      createSources(config({ radarSource: source }))
        .filter((p) => p.layer === "radar")
        .map((p) => p.id);
    expect(radar(undefined)).toEqual(["rainviewer-radar"]);
    expect(radar("rainviewer")).toEqual(["rainviewer-radar"]);
    expect(radar("imerg")).toEqual(["gibs-imerg"]);
  });

  test("the HTTP base of a gateway follows its WebSocket address", () => {
    expect(gatewayHttpBase("ws://localhost:8787")).toBe("http://localhost:8787");
    expect(gatewayHttpBase("wss://gateway.example/")).toBe("https://gateway.example");
  });
});

describe("satellites", () => {
  const satellitePlugin = (overrides: Partial<DataConfig> = {}) =>
    createSources(config(overrides)).find((p) => p.layer === "satellites") as SourcePlugin;
  const csv = readFileSync(
    new URL("../../../../packages/sources/src/satellites/fixtures/stations.csv", import.meta.url),
    "utf8",
  );

  test("with a gateway, elements come from its CelesTrak cache", async () => {
    const plugin = satellitePlugin({ gatewayUrl: "wss://gateway.example/" });
    const ctx = context(() => new Response(csv));
    await plugin.fetch?.(ctx);
    expect(ctx.requests).toEqual(["https://gateway.example/v1/proxy/celestrak/active.csv"]);
    // The same id either way, so a hold outlives a change of configuration. The gateway
    // rations CelesTrak itself, so the browser keeps its answer for an hour, not three.
    expect([plugin.id, plugin.cacheTtl]).toEqual(["celestrak-gp", 3_600_000]);
    expect(satellitePlugin({ gatewayUrl: null }).cacheTtl).toBe(3 * 3_600_000);
  });

  test("without one, from CelesTrak itself", async () => {
    const plugin = satellitePlugin({ gatewayUrl: null });
    const ctx = context(() => new Response(csv));
    await plugin.fetch?.(ctx);
    expect(ctx.requests).toEqual([
      "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=CSV",
    ]);
  });

  test("satelliteSource direct skips the gateway's cache", async () => {
    const plugin = satellitePlugin({
      gatewayUrl: "wss://gateway.example/",
      satelliteSource: "direct",
    });
    const ctx = context(() => new Response(csv));
    await plugin.fetch?.(ctx);
    expect(ctx.requests).toEqual([
      "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=CSV",
    ]);
    expect(plugin.cacheTtl).toBe(3 * 3_600_000);
  });

  test("either way the bundled snapshot is the fallback", async () => {
    for (const gatewayUrl of ["ws://localhost:8787", null]) {
      for (const assetBase of ["https://halo.example/", "https://halo.example/app"]) {
        const plugin = satellitePlugin({ gatewayUrl, assetBase });
        // The fallback first looks for an older copy of the live answer, then the snapshot.
        let calls = 0;
        const ctx = context(() =>
          ++calls === 1 ? new Response("", { status: 404 }) : new Response(csv),
        );
        const result = await plugin.fallback?.(ctx);
        expect(ctx.requests[1]).toBe(`${assetBase.replace(/\/$/, "")}/data/satellites.csv`);
        expect(result?.message).toMatch(/^Showing satellite orbits from \d+ November\./);
      }
    }
    expect(satelliteSnapshotUrl("/")).toBe("/data/satellites.csv");
  });
});

describe("wildfires", () => {
  const fires = (overrides: Partial<DataConfig> = {}) =>
    createSources(config(overrides)).find((p) => p.layer === "fires");

  test("with a gateway, the file comes from its proxy and no key is involved", async () => {
    const plugin = fires();
    const csv = readFileSync(
      new URL(
        "../../../../packages/sources/src/fires/fixtures/modis-global-24h.csv",
        import.meta.url,
      ),
      "utf8",
    );
    const ctx = context(() => new Response(csv));
    const raw = await plugin?.fetch?.(ctx);
    expect(ctx.requests).toEqual(["https://gateway.example/v1/proxy/firms/MODIS_NRT/world/2"]);
    expect(plugin?.requiresKey).toBeUndefined();
    // The proxy is ours and caches for everyone: the runner's rationing is not wanted on top.
    expect(plugin?.cacheTtl).toBeUndefined();
    const output = plugin?.normalise(raw, { now: () => Date.UTC(2026, 10, 14, 18) });
    expect(output?.type).toBe("entities");
    // The fixture is a few rows cut from a recorded world file.
    expect(output?.type === "entities" && output.update.count).toBeGreaterThan(5);
  });

  test("the gateway's answers are turned into what the layer should say", async () => {
    const answers: [number, string, string, string][] = [
      // Recorded from the gateway on 2026-11-14 (no key, then mock mode); the 502s are from its source.
      [
        503,
        '{"error":{"code":"needs_key","message":"Wildfires need a NASA FIRMS map key. Set FIRMS_MAP_KEY on the gateway and restart it."}}',
        "needs-key",
        FIRMS_NEEDS_GATEWAY_KEY,
      ],
      [
        503,
        '{"error":{"code":"needs_key","message":"NASA FIRMS rejected the gateway\'s map key. Check FIRMS_MAP_KEY on the gateway and restart it."}}',
        "needs-key",
        "NASA FIRMS rejected the gateway's key. Check FIRMS_MAP_KEY in the gateway's .env file.",
      ],
      [
        503,
        '{"error":{"code":"unavailable","message":"The wildfire proxy is off in mock mode."}}',
        "http",
        "Wildfires are off while the gateway runs in mock mode.",
      ],
      [
        502,
        '{"error":{"code":"upstream_limited","message":"NASA FIRMS says the gateway\'s map key is over its request limit. Wildfires will retry in ten minutes."}}',
        "http",
        "NASA FIRMS says the gateway's key is over its request limit.",
      ],
      [
        502,
        '{"error":{"code":"upstream_error","message":"NASA FIRMS could not be reached or sent something unexpected. Wildfires will retry in a minute."}}',
        "http",
        "The gateway could not get wildfire data from NASA FIRMS.",
      ],
    ];
    for (const [status, body, code, message] of answers) {
      const error = await rejection(
        fires()?.fetch?.(context(() => new Response(body, { status }))),
      );
      expect(error).toMatchObject({ name: "SourceError", code, message, status });
    }
    expect(FIRMS_NEEDS_GATEWAY_KEY).toBe(
      "Wildfires need a free NASA FIRMS key on the gateway. Add FIRMS_MAP_KEY to its .env file.",
    );
    // Something the proxy does not say (an older gateway without the route) stays as the plugin put it.
    const missing = await rejection(
      fires()?.fetch?.(context(() => new Response("", { status: 404 }))),
    );
    expect(missing).toMatchObject({ code: "http", status: 404 });
    expect(firmsProxyError(500, "NASA FIRMS answered HTTP 500.")).toBeNull();
  });

  test("a gateway that cannot be reached is named as the gateway, not as NASA", async () => {
    const error = await rejection(
      fires()?.fetch?.(
        context(() => {
          throw new TypeError("Failed to fetch");
        }),
      ),
    );
    expect(error).toMatchObject({
      name: "SourceError",
      code: "http",
      message: "Wildfires are offline. The gateway isn't reachable.",
    });
  });

  test("a request cut off by switching the layer off is not dressed up as an outage", async () => {
    const abort = new AbortController();
    const ctx = {
      ...context(() => new Response("")),
      signal: abort.signal,
      fetch: (async () => {
        abort.abort(new DOMException("Layer switched off", "AbortError"));
        throw abort.signal.reason;
      }) as typeof fetch,
    };
    const error = await rejection(fires()?.fetch?.(ctx));
    expect(error?.name).toBe("AbortError");
  });

  test("without a gateway the layer says it needs one, and asks nobody", async () => {
    const plugin = fires({ gatewayUrl: null });
    const ctx = context(() => new Response("latitude,longitude"));
    const error = await rejection(plugin?.fetch?.(ctx));
    expect(error).toMatchObject({
      name: "SourceError",
      code: "needs-key",
      message: FIRMS_NEEDS_GATEWAY,
    });
    expect(ctx.requests).toEqual([]);
    // Still described for the attribution page.
    expect(plugin).toMatchObject({ id: "nasa-firms", layer: "fires", refreshRate: 0 });
    expect(plugin?.requiresKey).toBeUndefined();
    expect(plugin?.attribution.text).toContain("NASA FIRMS");
  });
});

describe("place search", () => {
  const places = readFileSync(new URL("../../public/data/places.bin", import.meta.url));
  const assetFetch = (requests: string[], fail = { value: false }) =>
    (async (input: RequestInfo | URL) => {
      requests.push(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      if (fail.value) return new Response("", { status: 503 });
      return new Response(
        places.buffer.slice(places.byteOffset, places.byteOffset + places.byteLength),
      );
    }) as typeof fetch;

  test("loads the gazetteer on first use and answers on the entity score scale", async () => {
    const requests: string[] = [];
    const search = createPlaceSearch(config(), assetFetch(requests));
    expect(requests).toEqual([]);
    const london = await search("london", 5);
    expect(requests).toEqual(["https://halo.example/data/places.bin"]);
    expect(london[0]).toMatchObject({
      type: "place",
      title: "London",
      subtitle: "England, United Kingdom",
    });
    expect(london[0].zoom).toBeGreaterThan(5);
    // An exact city name sits just under an exact callsign (100) and above a callsign prefix (90).
    expect(london[0].score).toBeGreaterThan(90);
    expect(london[0].score).toBeLessThan(100);
    for (const place of london) expect(place.score).toBeLessThanOrEqual(100);
    // A prefix of a name ranks below a callsign prefix (about 90) and above a substring match (40).
    const prefix = await search("lond", 5);
    expect(prefix[0].title).toBe("London");
    expect(prefix[0].score).toBeGreaterThan(60);
    expect(prefix[0].score).toBeLessThan(85);
    // Loaded once.
    expect(requests).toHaveLength(1);
  });

  test("a failed load rejects, and the next search tries again", async () => {
    const requests: string[] = [];
    const fail = { value: true };
    const search = createPlaceSearch(config(), assetFetch(requests, fail));
    await expect(search("paris", 5)).rejects.toThrow(/could not be loaded/);
    fail.value = false;
    expect((await search("paris", 5))[0]).toMatchObject({ title: "Paris" });
    expect(requests).toHaveLength(2);
  });

  test("placeScore keeps the index's order within a tier and never crosses tiers", () => {
    // The index's scale: 100 per tier (word 1, prefix 2, exact 3), up to about 44 for
    // population and nearness, and 300 more when the name alone covered the query.
    const exactBig = placeScore(300 + 300 + 38);
    const exactSmall = placeScore(300 + 300 + 5);
    const prefixBig = placeScore(300 + 200 + 38);
    const wordBig = placeScore(300 + 100 + 38);
    const neededRegion = placeScore(300 + 20);
    expect(exactBig).toBeGreaterThan(exactSmall);
    expect(exactSmall).toBeGreaterThan(prefixBig);
    expect(prefixBig).toBeGreaterThan(wordBig);
    // "paris fr": the name matched exactly but the query needed the country as well.
    expect(neededRegion).toBeLessThan(exactSmall);
    for (const score of [exactBig, exactSmall, prefixBig, wordBig, neededRegion]) {
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });
});
