/**
 * The `fetch` handed to source plugins: timeout, one quick retry, respect
 * for `Retry-After`, and on-disk caching for sources that declare `cacheTtl`.
 * Sources with a `cacheTtl` get no quick retry: their providers limit how
 * often a client may ask, and some count every refused request against it.
 *
 * Caching sits at the HTTP layer on purpose. A plugin's parsed raw data can
 * hold anything (class instances, typed arrays, closures), but the response
 * it was parsed from is always bytes. Caching those bytes means a reload
 * inside the TTL replays the response through the plugin's own parser without
 * touching the provider, whatever the plugin keeps in memory.
 */

export interface CachedResponse {
  response: Response;
  /** When the response was stored, Unix epoch milliseconds. */
  storedMs: number;
}

/** Where raw responses persist. Implementations must never throw. */
export interface ResponseCache {
  match(url: string): Promise<CachedResponse | null>;
  put(url: string, response: Response, nowMs: number): Promise<void>;
  delete(url: string): Promise<void>;
}

const STORED_HEADER = "x-halo-stored-ms";
/** Bodies larger than this are not worth holding in the memory fallback. */
const MEMORY_MAX_BODY_BYTES = 16 * 1024 * 1024;
const MEMORY_MAX_ENTRIES = 32;

/** Cache API backed store: survives reloads. */
class DiskResponseCache implements ResponseCache {
  private readonly storage: CacheStorage;
  private readonly name: string;
  private opened: Promise<Cache> | null = null;

  constructor(storage: CacheStorage, name: string) {
    this.storage = storage;
    this.name = name;
  }

  private open(): Promise<Cache> {
    this.opened ??= this.storage.open(this.name);
    return this.opened;
  }

  async match(url: string): Promise<CachedResponse | null> {
    try {
      const cache = await this.open();
      const response = await cache.match(url);
      if (!response) return null;
      // An entry without our timestamp was not written by this store: its age is unknown.
      const stamp = response.headers.get(STORED_HEADER);
      const storedMs = stamp === null ? Number.NaN : Number(stamp);
      if (!Number.isFinite(storedMs)) return null;
      return { response, storedMs };
    } catch {
      // Private windows and storage pressure can break the Cache API at any time.
      return null;
    }
  }

  async put(url: string, response: Response, nowMs: number): Promise<void> {
    try {
      const body = await response.arrayBuffer();
      const headers = new Headers(response.headers);
      headers.set(STORED_HEADER, String(nowMs));
      const cache = await this.open();
      await cache.put(url, new Response(body, { status: 200, headers }));
    } catch {
      // Quota or an opaque response: carry on uncached.
    }
  }

  async delete(url: string): Promise<void> {
    try {
      const cache = await this.open();
      await cache.delete(url);
    } catch {
      // Nothing to remove from a cache that cannot be opened.
    }
  }
}

/** Fallback when the Cache API is missing: holds for the session only. */
export class MemoryResponseCache implements ResponseCache {
  private readonly entries = new Map<
    string,
    { body: ArrayBuffer; headers: [string, string][]; storedMs: number }
  >();

  async match(url: string): Promise<CachedResponse | null> {
    const entry = this.entries.get(url);
    if (!entry) return null;
    return {
      response: new Response(entry.body.slice(0), { status: 200, headers: entry.headers }),
      storedMs: entry.storedMs,
    };
  }

  async put(url: string, response: Response, nowMs: number): Promise<void> {
    try {
      const body = await response.arrayBuffer();
      if (body.byteLength > MEMORY_MAX_BODY_BYTES) return;
      this.entries.delete(url);
      if (this.entries.size >= MEMORY_MAX_ENTRIES) {
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined) this.entries.delete(oldest);
      }
      this.entries.set(url, { body, headers: [...response.headers], storedMs: nowMs });
    } catch {
      // A body that cannot be read is simply not cached.
    }
  }

  async delete(url: string): Promise<void> {
    this.entries.delete(url);
  }
}

/** The best cache this environment offers. */
export function openResponseCache(name = "halo-sources-v1"): ResponseCache {
  const storage = (globalThis as { caches?: CacheStorage }).caches;
  return storage ? new DiskResponseCache(storage, name) : new MemoryResponseCache();
}

export interface FetchPolicy {
  /** The real `fetch`. */
  fetch: typeof fetch;
  /** Aborts every request made through this policy. */
  signal: AbortSignal;
  /** Longest wait for response headers, per try. */
  timeoutMs: number;
  cache: ResponseCache | null;
  /** 0 disables caching. */
  cacheTtlMs: number;
  /** Wall clock. */
  now(): number;
  /** The provider asked us to stay away until this time. */
  onRetryAfter?(untilMs: number): void;
  /** Status of the last response that came off the network. */
  onStatus?(status: number): void;
  /**
   * An expired cached copy was served because the network failed. `status`
   * is the provider's answer, or 0 when there was none.
   */
  onStale?(status: number): void;
  /** A response was written to the cache under `url`. */
  onStored?(url: string): void;
  /**
   * False to send each request once and never retry on the spot. For
   * providers that count refused requests against the client.
   */
  quickRetry?: boolean;
  /**
   * True to answer from the cache alone, whatever its age, and fail any
   * request the cache cannot answer with `offlineError`. Used while a
   * provider has told us to stay away.
   */
  cacheOnly?: boolean;
  /** What a `cacheOnly` request with no cached copy rejects with. */
  offlineError?(): unknown;
  /**
   * Base URL of the app's own static files. Requests under it are not the
   * provider's to ration: they go straight out, uncached and unreported,
   * even when `cacheOnly` is set. Bundled fallbacks (the satellite snapshot)
   * are read this way.
   */
  assetBase?: string;
}

const RETRY_DELAY_MS = 800;
const MAX_RETRY_AFTER_MS = 60 * 60_000;

/** `Retry-After` as a delay in milliseconds, or null. Accepts seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const text = value.trim();
  if (text === "") return null;
  let ms: number;
  if (/^\d+(\.\d+)?$/.test(text)) ms = Number(text) * 1000;
  else {
    const at = Date.parse(text);
    if (Number.isNaN(at)) return null;
    ms = at - nowMs;
  }
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

/** Thrown when a request outlives its timeout. */
export class TimeoutError extends Error {
  override name = "TimeoutError";
}

/** Resolves after `ms`, or rejects as soon as `signal` aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Build the `fetch` for one source run. */
export function createPolicyFetch(policy: FetchPolicy): typeof fetch {
  const once = async (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
  ): Promise<Response> => {
    if (policy.signal.aborted) throw policy.signal.reason;
    const controller = new AbortController();
    const forward = () => controller.abort(policy.signal.reason);
    const caller = init?.signal ?? null;
    const forwardCaller = () => controller.abort(caller?.reason);
    policy.signal.addEventListener("abort", forward, { once: true });
    caller?.addEventListener("abort", forwardCaller, { once: true });
    const timer = setTimeout(
      () => controller.abort(new TimeoutError("Request timed out")),
      policy.timeoutMs,
    );
    try {
      return await policy.fetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      policy.signal.removeEventListener("abort", forward);
      caller?.removeEventListener("abort", forwardCaller);
    }
  };

  const overNetwork = async (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
  ): Promise<Response> => {
    const quickRetry = policy.quickRetry !== false;
    let response: Response;
    let retried = false;
    try {
      response = await once(input, init);
    } catch (error) {
      if (policy.signal.aborted || !quickRetry) throw error;
      retried = true;
      await sleep(RETRY_DELAY_MS, policy.signal);
      response = await once(input, init);
    }
    const retryAfter =
      response.status === 429 || response.status === 503
        ? parseRetryAfter(response.headers.get("retry-after"), policy.now())
        : null;
    if (retryAfter !== null) {
      // Told to back off: do exactly that, and let the runner reschedule.
      policy.onRetryAfter?.(policy.now() + retryAfter);
    } else if (
      quickRetry &&
      !retried &&
      (response.status === 502 || response.status === 503 || response.status === 504)
    ) {
      await sleep(RETRY_DELAY_MS, policy.signal);
      response = await once(input, init);
    }
    policy.onStatus?.(response.status);
    return response;
  };

  return async (input, init) => {
    const url = urlOf(input);
    if (policy.assetBase && url.startsWith(policy.assetBase)) return once(input, init);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const cache = policy.cacheTtlMs > 0 && method === "GET" ? policy.cache : null;
    const offline = () =>
      policy.offlineError?.() ?? new TypeError("The network is not to be used right now");
    if (cache === null) {
      if (policy.cacheOnly) throw offline();
      return overNetwork(input, init);
    }

    const hit = await cache.match(url);
    if (hit !== null && policy.now() - hit.storedMs < policy.cacheTtlMs) return hit.response;
    if (policy.cacheOnly) {
      if (hit === null) throw offline();
      policy.onStale?.(0);
      return hit.response;
    }

    let response: Response;
    try {
      response = await overNetwork(input, init);
    } catch (error) {
      if (hit === null || policy.signal.aborted) throw error;
      policy.onStale?.(0);
      return hit.response;
    }
    if (response.ok) {
      await cache.put(url, response.clone(), policy.now());
      policy.onStored?.(url);
      return response;
    }
    if (hit === null) return response;
    // Old data beats an error page.
    policy.onStale?.(response.status);
    return hit.response;
  };
}

/** What is remembered, across reloads, about a provider that told us to stay away. */
export interface Hold {
  /** No request before this time, Unix epoch milliseconds. */
  untilMs: number;
  /** The sentence to show while waiting. */
  message: string;
}

/** Cache key of a source's hold. Never requested: `.invalid` cannot resolve. */
function holdUrl(sourceId: string): string {
  return `https://halo.invalid/hold/${encodeURIComponent(sourceId)}`;
}

/** The hold on `sourceId`, if one is still running. */
export async function readHold(
  cache: ResponseCache | null,
  sourceId: string,
  nowMs: number,
): Promise<Hold | null> {
  if (cache === null) return null;
  const hit = await cache.match(holdUrl(sourceId));
  if (hit === null) return null;
  try {
    const hold = (await hit.response.json()) as Partial<Hold>;
    if (typeof hold.untilMs !== "number" || !(hold.untilMs > nowMs)) return null;
    return { untilMs: hold.untilMs, message: typeof hold.message === "string" ? hold.message : "" };
  } catch {
    return null;
  }
}

/** Remember a hold so a reload does not ask the provider again. Null clears it. */
export async function writeHold(
  cache: ResponseCache | null,
  sourceId: string,
  hold: Hold | null,
  nowMs: number,
): Promise<void> {
  if (cache === null) return;
  if (hold === null) {
    await cache.delete(holdUrl(sourceId));
    return;
  }
  await cache.put(
    holdUrl(sourceId),
    new Response(JSON.stringify(hold), { headers: { "content-type": "application/json" } }),
    nowMs,
  );
}
