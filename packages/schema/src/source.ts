/**
 * The data source plugin contract.
 *
 * Every feed in Orya Halo, whatever its transport, is described by one
 * `SourcePlugin`. A plugin states where data comes from, how often, under
 * which licence, and how to turn the provider's format into the app's
 * normalised shapes. Plugins hold no state and touch no DOM, so they run in
 * a worker, in Node tests and (ported) in the gateway alike.
 */
import type { EntityMeta, EntityUpdate } from "./entity.ts";
import type { LayerId } from "./kinds.ts";
import type { HaloEvent } from "./protocol.ts";
import type { EntityDetail, Track } from "./runtime.ts";

/** What the provider's terms permit. Mirrors docs/DATA_LICENCES.md. */
export interface LicenceInfo {
  /** Licence or terms name, e.g. "ODbL 1.0", "Public domain (USGS)". */
  readonly name: string;
  /** Link to the licence or terms text. */
  readonly url: string;
  /** Showing the data to the public in an app. Must be true to ship. */
  readonly display: boolean;
  /** Passing the raw data on to third parties (e.g. through our gateway). */
  readonly redistribution: boolean;
  /** Use in a commercial product. Orya Halo is non-commercial either way. */
  readonly commercial: boolean;
  /** Conditions worth knowing: share-alike, caching limits, link-back rules. */
  readonly notes?: string;
  /** ISO date the terms were last checked by a human or agent. */
  readonly verified: string;
}

/**
 * How a plugin reports a failure the app can explain. Plugins throw an Error
 * whose `name` is "SourceError" with one of these codes and a plain,
 * one-sentence `message` fit to show as it is. The runner maps the code to a
 * layer status: "needs-key" → needs-key; "blocked" → offline, and wait a full
 * refresh interval before trying again (never retry at once: some providers
 * count errors against the client); "http" → retry with backoff; "bad-data" → error.
 */
export type SourceErrorCode = "needs-key" | "blocked" | "http" | "bad-data";

export interface Attribution {
  /** Text shown on the attribution page and, where required, on the map. */
  readonly text: string;
  readonly url: string;
  /** True when the terms require credit on the map itself, not just a page. */
  readonly onMap?: boolean;
}

/** One field of a source's normalised output, for docs and the detail panel. */
export interface SchemaField {
  readonly key: string;
  readonly label: string;
  readonly type: "string" | "number" | "boolean" | "time" | "url";
  /** Display unit, e.g. "m", "kt", "km". */
  readonly unit?: string;
}

/** Static line geometry (undersea cables, orbit tracks) in deck.gl binary form. */
export interface PathSet {
  count: number;
  ids: Uint32Array;
  /** Index into `positions` (in vertices) where each path starts; length `count + 1`. */
  startIndices: Uint32Array;
  /** Flat lon, lat pairs (degrees). */
  positions: Float32Array;
  /** Per-path label, parallel to `ids`. */
  names: string[];
  /** Per-path facts for the detail panel, parallel to `ids`. */
  meta?: (Record<string, string | number | boolean | null> | undefined)[];
}

/** A raster tile overlay, optionally animated through time. */
export interface TileOverlay {
  /** URL template with `{z}`, `{x}`, `{y}`. */
  tiles: string[];
  tileSize: 256 | 512;
  minZoom: number;
  maxZoom: number;
  /** 0..1. */
  opacity: number;
  /** Timestamped frames, oldest first, for the time scrubber. */
  frames?: { timeMs: number; tiles: string[] }[];
  /** When the imagery was captured or generated, if it is a single frame. */
  timeMs?: number;
  /** Credit that must be visible on the map while the overlay is shown. */
  attribution?: Attribution;
}

export type SourceOutput =
  | { type: "entities"; update: EntityUpdate; events?: HaloEvent[] }
  | { type: "paths"; paths: PathSet }
  | { type: "tiles"; overlay: TileOverlay };

export type SourceTransport =
  /** Polled over HTTP from the browser worker. */
  | "fetch"
  /** Pushed over a socket or event stream opened by the worker. */
  | "stream"
  /** Arrives through the Orya Halo gateway (aircraft, ships). */
  | "gateway"
  /** Computed locally from elements or ephemerides (satellites). */
  | "compute"
  /** Bundled static asset, refreshed at build time (cables). */
  | "static";

/** Everything a plugin may use. No globals, so tests can inject fakes. */
export interface SourceContext {
  /** `fetch` with the app's timeout and retry policy applied. */
  fetch: typeof fetch;
  /** Current time, Unix epoch milliseconds. Scrubbed time when replaying. */
  now(): number;
  /** API key for this source, when it declares `requiresKey`. */
  key?: string;
  /** Aborted when the layer is switched off or the app shuts down. */
  signal: AbortSignal;
  /** Base URL for the app's own static assets. */
  assetBase: string;
  /** Viewport, for sources that can query by area. */
  view?: {
    lon: number;
    lat: number;
    zoom: number;
    bounds: [west: number, south: number, east: number, north: number];
  };
}

export interface SourcePlugin<TRaw = unknown> {
  /** Unique id, kebab-case, e.g. "usgs-quakes". */
  readonly id: string;
  /** Human name of the provider, e.g. "USGS Earthquake Hazards Program". */
  readonly name: string;
  readonly layer: LayerId;
  readonly transport: SourceTransport;
  /** Fields of the normalised output. */
  readonly schema: readonly SchemaField[];
  /**
   * Milliseconds between `fetch` calls. Must respect the provider's rate
   * limit with margin. 0 for `stream`, `gateway` and one-shot `static` sources.
   */
  readonly refreshRate: number;
  readonly licence: LicenceInfo;
  readonly attribution: Attribution;
  /**
   * For sources whose output depends on the clock (orbits): milliseconds
   * between re-running `normalise` on the last raw data. `ctx.now()` returns
   * the scrubbed time when replaying, so these sources replay for free.
   */
  readonly recomputeRate?: number;
  /**
   * Milliseconds the runner may keep a raw response on disk and must not
   * refetch within, even across page reloads. Set it when the provider's
   * policy limits how often a client may download the same data.
   */
  readonly cacheTtl?: number;
  /**
   * True when `fetch` uses `ctx.view`: the runner refetches (no more often
   * than `refreshRate` allows) once the camera settles somewhere new.
   */
  readonly viewAware?: boolean;
  /** Name of the environment variable holding the API key, if one is needed. */
  readonly requiresKey?: string;
  /** Link to the provider's API documentation. */
  readonly docs: string;

  /** Pull one batch of raw data. Present for `fetch`, `compute` and `static`. */
  fetch?(ctx: SourceContext): Promise<TRaw>;
  /**
   * Something to show when `fetch` cannot deliver, found without asking the
   * provider: an older copy, or a snapshot bundled with the app. The runner
   * calls it when nothing is on screen yet and `fetch` has failed, is held
   * back, or has not answered within a couple of seconds. Its `fetch`
   * answers from the runner's response cache and the app's own assets
   * (`assetBase`) only. The output is shown as degraded with `message` (one
   * plain sentence or two) until `fetch` succeeds; when `fetch` is next tried
   * does not change.
   */
  fallback?(ctx: SourceContext): Promise<{ raw: TRaw; message: string }>;
  /** Open a push feed. Returns a function that closes it. Present for `stream`. */
  stream?(
    ctx: SourceContext,
    onData: (raw: TRaw) => void,
    onError: (error: Error) => void,
  ): () => void;
  /** Turn the provider's format into normalised output. Pure and synchronous. */
  normalise(raw: TRaw, ctx: Pick<SourceContext, "now">): SourceOutput;
  /** Predicted or recorded path of one entity, e.g. a satellite's orbit. */
  track?(raw: TRaw, id: number, ctx: Pick<SourceContext, "now">): Track | null;
  /**
   * Detail beyond the entity's meta fields: subtitle, media, links, route.
   * May fetch (a quake's detail document, a webcam's current image).
   */
  detail?(
    id: number,
    meta: EntityMeta | undefined,
    ctx: SourceContext,
  ): Partial<EntityDetail> | Promise<Partial<EntityDetail>>;
}

/** Helper that keeps literal types while checking the plugin's shape. */
export function defineSource<TRaw>(plugin: SourcePlugin<TRaw>): SourcePlugin<TRaw> {
  return plugin;
}
