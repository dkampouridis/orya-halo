/**
 * The seam between the data worker and the main thread.
 *
 * The worker owns every entity store. The main thread owns the map and the
 * HUD. They talk only through `DataWorkerApi` (calls in) and `DataMessage`
 * (messages out), so either side can be replaced or tested alone.
 */
import type { EntityMeta, EntityRef, RenderBatch } from "./entity.ts";
import type { EntityKind, LayerId } from "./kinds.ts";
import type { HaloEvent } from "./protocol.ts";
import type { Attribution, PathSet, TileOverlay } from "./source.ts";

export type LayerStatus =
  /** Switched off by the user. */
  | "off"
  /** Switched on, first data not in yet. */
  | "loading"
  | "live"
  /** Showing data, but late or partial. */
  | "degraded"
  /** Needs an API key the deployment has not configured. */
  | "needs-key"
  /** The gateway or provider cannot be reached. */
  | "offline"
  | "error";

export interface LayerState {
  status: LayerStatus;
  /** Objects currently loaded for this layer; null when not countable. */
  count: number | null;
  /** Worldwide total when the provider reports one (gateway layers). */
  total?: number | null;
  /** One plain sentence explaining a non-live status, ready to show. */
  message?: string;
  /** When data last arrived, Unix epoch milliseconds. */
  updatedMs?: number;
}

export interface ViewState {
  lon: number;
  lat: number;
  zoom: number;
  bearing: number;
  pitch: number;
  /** west, south, east, north. West may exceed east across the antimeridian. */
  bounds: [number, number, number, number];
  /** True when the whole visible hemisphere is in view. */
  global: boolean;
}

export interface ClockState {
  /** `live` follows wall time. `scrub` shows `timeMs` and holds there. */
  mode: "live" | "scrub";
  /** The moment being shown, Unix epoch milliseconds. */
  timeMs: number;
}

/** Per-cell counts for the low-zoom glow underlay. */
export interface DensityGrid {
  kind: EntityKind;
  res: number;
  count: number;
  /** Flat lon, lat pairs of cell centres. */
  positions: Float32Array;
  counts: Uint32Array;
  /** Largest value in `counts`, for normalising brightness. */
  max: number;
}

/** A recorded track: where one object has been. */
export interface Track {
  ref: EntityRef;
  count: number;
  /** Flat lon, lat, alt (m) triples, oldest first. */
  positions: Float32Array;
  /** Unix epoch milliseconds per vertex. */
  timesMs: Float64Array;
}

/** One row in the detail panel. */
export interface DetailField {
  key: string;
  label: string;
  /** Already formatted for display, units excluded. */
  value: string;
  unit?: string;
  /** Raw number when the field is numeric, so the HUD can animate changes. */
  numeric?: number;
}

export interface DetailMedia {
  type: "image" | "video" | "embed";
  url: string;
  /** Page to open when the media is clicked; required by most providers. */
  link?: string;
  credit?: string;
  alt: string;
}

export interface NearbyEntity {
  ref: EntityRef;
  label: string;
  distanceKm: number;
}

/** Everything the detail panel shows for one selection. */
export interface EntityDetail {
  ref: EntityRef;
  layer: LayerId;
  /** Main heading: callsign, ship name, satellite name, place. */
  title: string;
  /** Second line: aircraft type, ship type, orbit class, magnitude. */
  subtitle?: string;
  lon: number;
  lat: number;
  alt: number;
  heading: number | null;
  speed: number;
  /** When the position was observed. */
  fixTimeMs: number;
  /** Identity and static facts, in display order. */
  fields: DetailField[];
  origin?: { code: string; name?: string; lon?: number; lat?: number };
  destination?: { code: string; name?: string; lon?: number; lat?: number };
  media?: DetailMedia[];
  nearby?: NearbyEntity[];
  /** Provider credit for this object's data. */
  attribution: Attribution;
  /** Link to the provider's own page for this object. */
  sourceUrl?: string;
  meta?: EntityMeta;
}

/** What the hover tag shows: a name and at most one number. */
export interface EntitySummary {
  ref: EntityRef;
  layer: LayerId;
  title: string;
  /** Already formatted, e.g. "10,972". */
  value?: string;
  unit?: string;
}

export interface SearchResult {
  /** `entity` selects an object. `place` flies the camera to a location. */
  type: "entity" | "place";
  ref?: EntityRef;
  layer?: LayerId;
  title: string;
  subtitle?: string;
  lon: number;
  lat: number;
  /** Suggested zoom when flying to a place. */
  zoom?: number;
  /** Higher is better. */
  score: number;
}

/** Messages the worker posts to the main thread. Buffers are transferred. */
export type DataMessage =
  | { type: "batch"; batch: RenderBatch }
  | { type: "density"; grid: DensityGrid }
  | { type: "paths"; layer: LayerId; paths: PathSet }
  | { type: "tiles"; layer: LayerId; overlay: TileOverlay | null }
  | { type: "layer"; layer: LayerId; state: LayerState }
  | { type: "events"; events: HaloEvent[] }
  | { type: "track"; track: Track | null }
  | { type: "history"; fromMs: number; toMs: number };

export interface DataConfig {
  /** WebSocket URL of the gateway, or null to run without one. */
  gatewayUrl: string | null;
  /** Base URL for static assets (cables, cities). */
  assetBase: string;
  /** API keys available to browser-side sources, by environment variable name. */
  keys: Record<string, string | undefined>;
  layers: Record<LayerId, boolean>;
  /** How much history to keep for the time scrubber, milliseconds. */
  historyMs: number;
  /** Which provider feeds the rain layer. RainViewer is real radar; IMERG is fully open but hours behind. */
  radarSource?: "rainviewer" | "imerg";
  /**
   * Where satellite elements come from when a gateway is configured: its shared
   * CelesTrak cache (the default), or CelesTrak directly from each browser, for
   * gateways on hosts that cannot reach CelesTrak. Without a gateway, always direct.
   */
  satelliteSource?: "gateway" | "direct";
  /** Add this many synthetic movers per gateway layer, for load testing. */
  synthetic?: number;
}

/** What the worker exposes to the main thread (wrapped with Comlink). */
export interface DataWorkerApi {
  init(config: DataConfig): Promise<void>;
  /** Register the single message sink. Call before `init`. */
  listen(sink: (message: DataMessage) => void): void;
  setLayerEnabled(layer: LayerId, enabled: boolean): void;
  /** Called when the camera settles; drives viewport subscriptions. */
  setView(view: ViewState): void;
  setClock(clock: ClockState): void;
  /** Start streaming the recorded and live track of one entity; null stops. */
  setTracked(ref: EntityRef | null): void;
  getDetail(ref: EntityRef): Promise<EntityDetail | null>;
  /** Name and one number for the hover tag. Local and cheap: no network. */
  getSummary(ref: EntityRef): Promise<EntitySummary | null>;
  search(query: string, near?: { lon: number; lat: number }): Promise<SearchResult[]>;
  /** Every source in use, for the attribution page. */
  getAttributions(): Promise<SourceSummary[]>;
  dispose(): void;
}

/** Summary of one source plugin for the attribution page. */
export interface SourceSummary {
  id: string;
  name: string;
  layer: LayerId;
  licence: string;
  licenceUrl: string;
  attribution: string;
  attributionUrl: string;
  notes?: string;
  docs: string;
}
