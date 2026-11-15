/**
 * What the data worker runs. This file is the one place to register feeds.
 *
 * - `createSources`: every `SourcePlugin` the worker schedules for a
 *   configuration. Plugins with `transport: "gateway"` are not fetched; they
 *   describe a gateway layer (schema, attribution, `detail()`).
 * - `createPlaceSearch`: the gazetteer lookup merged into search results.
 *
 * The synthetic load-test sources are not listed here: the worker adds them
 * itself when `DataConfig.synthetic` is set.
 *
 * Not registered, on purpose: Windy Webcams. Its API terms forbid publishing
 * the key, and anything compiled into this bundle is published.
 */
import type { DataConfig, SearchResult, SourcePlugin } from "@orya-halo/schema";
import {
  CELESTRAK_GP_URL,
  SourceError,
  createCelestrakSource,
  createFirmsSource,
  createPlaceIndex,
  digitrafficWeathercams,
  gatewayAircraft,
  gatewayShips,
  gibsImergPrecipitation,
  gibsTrueColour,
  hkTrafficCameras,
  isSourceError,
  osmCables,
  rainViewerRadar,
  usgsQuakes,
} from "@orya-halo/sources";

/**
 * Finds places by name. Return results with `type: "place"` and a `score` on
 * the same 0 to 100 scale entity matches use (exact 100, prefix about 90,
 * substring about 40). May be async; the worker gives it 1.5 s.
 */
export type PlaceSearch = (
  query: string,
  limit: number,
  near?: { lon: number; lat: number },
) => SearchResult[] | Promise<SearchResult[]>;

export const FIRMS_NEEDS_GATEWAY_KEY =
  "Wildfires need a free NASA FIRMS key on the gateway. Add FIRMS_MAP_KEY to its .env file.";
export const FIRMS_NEEDS_GATEWAY =
  "Wildfires need the Orya Halo gateway, which keeps the NASA FIRMS key private. Set VITE_GATEWAY_URL and reload.";

/** HTTP base of a gateway given its WebSocket address. */
export function gatewayHttpBase(gatewayUrl: string): string {
  return gatewayUrl.replace(/\/+$/, "").replace(/^ws/i, "http");
}

/**
 * What the gateway's wildfire proxy said when it had no file to give, as the
 * error the runner understands. The proxy answers with a status and
 * `{"error":{"code":"..."}}` (apps/gateway/src/firms.rs); by the time the
 * FIRMS plugin has thrown, that body is the tail of its message.
 */
export function firmsProxyError(status: number | undefined, message: string): SourceError | null {
  const code = /"code"\s*:\s*"([a-z_]+)"/.exec(message)?.[1];
  switch (code) {
    case "needs_key":
      // No key at all, or one that FIRMS turned down: either way the operator has to act.
      return new SourceError(
        "needs-key",
        /reject/i.test(message)
          ? "NASA FIRMS rejected the gateway's key. Check FIRMS_MAP_KEY in the gateway's .env file."
          : FIRMS_NEEDS_GATEWAY_KEY,
        status,
      );
    case "unavailable":
      return new SourceError(
        "http",
        "Wildfires are off while the gateway runs in mock mode.",
        status,
      );
    case "upstream_limited":
      return new SourceError(
        "http",
        "NASA FIRMS says the gateway's key is over its request limit.",
        status,
      );
    case "upstream_error":
      return new SourceError(
        "http",
        "The gateway could not get wildfire data from NASA FIRMS.",
        status,
      );
    default:
      return null;
  }
}

/**
 * Wildfires. FIRMS needs a key that must not reach the browser, so the
 * request goes through the gateway's proxy, which adds it. With no gateway
 * there is nowhere safe to keep the key, and the layer says so.
 */
function wildfires(config: DataConfig): SourcePlugin {
  // `cacheTtl` is for asking FIRMS itself. The proxy is ours: it keeps its
  // own copy, rations its own requests and tells the browser's HTTP cache how
  // long an answer is good for, so a failure there may be retried as usual.
  const { cacheTtl: _cacheTtl, ...proxied } = createFirmsSource({
    proxyUrl: config.gatewayUrl
      ? `${gatewayHttpBase(config.gatewayUrl)}/v1/proxy/firms`
      : "https://gateway.invalid",
  });
  if (!config.gatewayUrl) {
    // Kept only for its description: licence, credit, schema, detail.
    return {
      ...proxied,
      refreshRate: 0,
      fetch: () => Promise.reject(new SourceError("needs-key", FIRMS_NEEDS_GATEWAY)),
    } as SourcePlugin;
  }
  return {
    ...proxied,
    async fetch(ctx) {
      try {
        return await proxied.fetch?.(ctx);
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        if (isSourceError(error)) throw firmsProxyError(error.status, error.message) ?? error;
        // No answer at all: it is the gateway that is out of reach, not NASA.
        if (error instanceof TypeError || (error as { name?: unknown })?.name === "TimeoutError") {
          throw new SourceError("http", "Wildfires are offline. The gateway isn't reachable.");
        }
        throw error;
      }
    },
  } as SourcePlugin;
}

/** Where the satellite snapshot shipped with the app lives (`apps/web/public/data/satellites.csv`). */
export function satelliteSnapshotUrl(assetBase: string): string {
  return `${assetBase.replace(/\/+$/, "")}/data/satellites.csv`;
}

/**
 * Satellites. With a gateway, elements come from its shared CelesTrak cache,
 * so every visitor behind one address costs CelesTrak one download per
 * update between them; without one, from CelesTrak directly. Either way the
 * bundled snapshot stands in whenever current elements cannot be had.
 */
export function satellites(config: DataConfig): SourcePlugin {
  const fallbackUrl = satelliteSnapshotUrl(config.assetBase);
  if (!config.gatewayUrl) {
    return createCelestrakSource({ url: CELESTRAK_GP_URL, fallbackUrl }) as SourcePlugin;
  }
  const proxied = createCelestrakSource({
    url: `${gatewayHttpBase(config.gatewayUrl)}/v1/proxy/celestrak/active.csv`,
    fallbackUrl,
  });
  // The gateway rations CelesTrak for everybody and asks browsers to keep its
  // answer for an hour, so an hour is enough here too: a gateway that comes
  // back (or leaves mock mode) is asked again after one, not three.
  return { ...proxied, cacheTtl: SATELLITE_PROXY_TTL_MS } as SourcePlugin;
}

/** How long the browser keeps the gateway's satellite elements, and waits after it fails. */
export const SATELLITE_PROXY_TTL_MS = 3_600_000;

/** Source plugins the worker runs for this configuration, in the order they are started. */
export function createSources(config: DataConfig): SourcePlugin[] {
  return [
    gatewayAircraft,
    gatewayShips,
    satellites(config),
    usgsQuakes,
    osmCables,
    // One rain source at a time: real radar by default, NASA's satellite estimate on request.
    config.radarSource === "imerg" ? gibsImergPrecipitation : rainViewerRadar,
    gibsTrueColour,
    wildfires(config),
    // The two keyless, openly licensed camera feeds.
    digitrafficWeathercams,
    hkTrafficCameras,
  ] as SourcePlugin[];
}

/**
 * Bring a place index score onto the scale entity matches use. The index
 * ranks on its own scale (a hundred per match tier, a few points for
 * population and nearness, three hundred more when the name alone covers the
 * query), which would put every place above every aircraft.
 */
export function placeScore(raw: number): number {
  const nameOnly = raw >= 400;
  const rest = nameOnly ? raw - 300 : raw;
  const tier = Math.min(3, Math.max(1, Math.floor(rest / 100)));
  // Population and nearness, at most about 44 points: enough to order places, never to change tier.
  const within = Math.min(Math.max(rest - tier * 100, 0), 45) * 0.2;
  const base = tier === 3 ? 88 : tier === 2 ? 70 : 50;
  return base + within - (nameOnly ? 0 : 15);
}

/** City search over the bundled gazetteer, loaded on first use. */
export function createPlaceSearch(config: DataConfig, fetchFn: typeof fetch): PlaceSearch {
  const index = createPlaceIndex(config.assetBase, fetchFn);
  return async (query, limit, near) => {
    // A failed load rejects here, the worker shows entity results alone, and the next search tries again.
    if (!index.loaded) await index.load();
    return index.search(query, limit, near).map((place) => ({
      ...place,
      score: placeScore(place.score),
    }));
  };
}
