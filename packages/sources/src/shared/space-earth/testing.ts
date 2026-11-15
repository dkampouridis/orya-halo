/**
 * Test doubles for `SourceContext`. No network: every request is answered
 * from a table of recorded responses and logged, so tests can assert on which
 * URLs a plugin asked for and how often.
 */
import type { SourceContext } from "@orya-halo/schema";

export interface FakeResponse {
  status?: number;
  body: string;
}

export interface FakeContext extends SourceContext {
  /** Every URL requested, in order. */
  requests: string[];
}

/**
 * A context whose `fetch` answers from `routes`: the first entry whose key is
 * contained in the URL wins. Unmatched URLs get a 404.
 */
export function fakeContext(options: {
  now: number;
  key?: string;
  routes?: Record<string, FakeResponse | string>;
}): FakeContext {
  const requests: string[] = [];
  const routes = options.routes ?? {};
  const fetchFake = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);
    for (const [match, answer] of Object.entries(routes)) {
      if (!url.includes(match)) continue;
      const response = typeof answer === "string" ? { body: answer } : answer;
      return new Response(response.body, { status: response.status ?? 200 });
    }
    return new Response("Not found", { status: 404 });
  }) as typeof fetch;
  return {
    fetch: fetchFake,
    now: () => options.now,
    key: options.key,
    signal: new AbortController().signal,
    assetBase: "/",
    requests,
  };
}

/** Great-circle distance in kilometres on the mean sphere. */
export function greatCircleKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(a)));
}
