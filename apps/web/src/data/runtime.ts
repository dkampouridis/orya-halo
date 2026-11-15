/**
 * The data runtime: everything the data worker does, with no Worker in sight.
 *
 * It owns the entity stores and wires the pieces together: sources and the
 * gateway feed the stores, the batch builders turn changes into GPU-ready
 * batches at a bounded rate, the history rings record keyframes for the time
 * scrubber, and search and detail read the stores directly. The worker entry
 * (`data.worker.ts`) only exposes this over Comlink; tests drive it as is.
 *
 * Nothing here runs per frame. Every timer is armed by an event (data in, a
 * view change, a keyframe falling due) and the runtime is idle in between.
 */
import {
  ENTITY_KINDS,
  EntityKind,
  LAYERS,
  batchTransferables,
  layerDef,
  layerForKind,
} from "@orya-halo/schema";
import type {
  Attribution,
  ClockState,
  DataConfig,
  DataMessage,
  DataWorkerApi,
  DensityGrid,
  DetailMedia,
  EntityDetail,
  EntityMeta,
  EntityRef,
  EntitySummary,
  EntityUpdate,
  GatewayLayer,
  HaloEvent,
  LayerId,
  PathSet,
  SchemaField,
  SearchResult,
  SourceContext,
  SourcePlugin,
  SourceSummary,
  TileOverlay,
  Track,
  ViewState,
} from "@orya-halo/schema";
import { BatchBuilder } from "./batch.ts";
import {
  GATEWAY_SCHEMAS,
  buildDetail,
  buildSummary,
  detailFields,
  gatewaySchema,
  mergeDetail,
} from "./detail.ts";
import { createPolicyFetch } from "./fetching.ts";
import type { ResponseCache } from "./fetching.ts";
import { GATEWAY_LAYERS, GATEWAY_SOURCE, GatewayClient, kindOfGatewayLayer } from "./gateway.ts";
import type { GatewayEntity, SocketLike } from "./gateway.ts";
import { HISTORY_PROFILES, HistoryRing } from "./history.ts";
import { LayerStates } from "./layers.ts";
import type { AircraftPhotos } from "./photos.ts";
import type { PlaceSearch } from "./registry.ts";
import { SourceRunner } from "./runner.ts";
import type { RunnerOptions } from "./runner.ts";
import { DEFAULT_SEARCH_LIMIT, mergeResults, searchStores } from "./search.ts";
import { EntityStore } from "./store.ts";
import { createSyntheticSources } from "./synthetic.ts";
import { TrackBuffer } from "./track.ts";

/** Receives every message with the buffers that should be transferred, not copied. */
export type MessageSink = (message: DataMessage, transfer: Transferable[]) => void;

export interface RuntimeDeps {
  /** Source plugins to run, or how to choose them for a configuration (see `registry.ts`). */
  plugins: readonly SourcePlugin[] | ((config: DataConfig) => readonly SourcePlugin[]);
  placeSearch: PlaceSearch | null;
  /** Builds the place search once the configuration is known; replaces `placeSearch`. */
  placeSearchFor?: (config: DataConfig) => PlaceSearch | null;
  /** Photo lookup for the aircraft detail panel; absent or null for none. */
  photos?: AircraftPhotos | null;
  fetch: typeof fetch;
  createSocket: (url: string) => SocketLike;
  /** Where raw responses of `cacheTtl` sources persist; null disables caching. */
  cache: ResponseCache | null;
  random?: () => number;
  runner?: RunnerOptions;
  /**
   * Shortest time between batches, per kind, milliseconds. Defaults to one
   * second, or a plugin's `recomputeRate` when that is shorter.
   */
  batchIntervalMs?: Partial<Record<EntityKind, number>>;
}

/** Most batches per second for a kind, unless a plugin's `recomputeRate` asks for more. */
const DEFAULT_BATCH_INTERVAL_MS = 1000;
/**
 * Wait this long after the first change before building, so the frames of
 * one gateway tick (upsert, meta, remove) land in one batch.
 */
const COALESCE_MS = 25;
/** How long an entity may go unreported before it is dropped. 0 keeps it until its source says otherwise. */
const EXPIRY_MS: Record<EntityKind, number> = {
  [EntityKind.Aircraft]: 5 * 60_000,
  [EntityKind.Ship]: 30 * 60_000,
  [EntityKind.Satellite]: 0,
  [EntityKind.Quake]: 0,
  [EntityKind.Webcam]: 0,
  [EntityKind.Fire]: 0,
  [EntityKind.Cable]: 0,
};
const DEFAULT_HISTORY_MS = 30 * 60_000;
/** The first keyframe comes early so the scrubber has something to hold on to. */
const FIRST_KEYFRAME_MS = 5_000;
/** While scrubbing, rebuild at most this often however fast the handle moves. */
const SCRUB_INTERVAL_MS = 50;
/** After this long hidden, positions on screen are too old to ease from. */
const HIDDEN_RESET_MS = 5_000;
const DETAIL_TIMEOUT_MS = 2_500;
const GATEWAY_DETAIL_TIMEOUT_MS = 1_500;
/** How long the panel waits for a photo. A slower one is kept and shown on the next refresh. */
const PHOTO_WAIT_MS = 1_200;
/** How long the gateway's own list of its sources is trusted before it is asked again. */
const GATEWAY_SOURCES_TTL_MS = 60_000;
/** Two positions closer than this, in degrees, are the same fix (the wire carries 1e-7). */
const SAME_FIX_DEG = 1e-5;
const REMOTE_SEARCH_DEBOUNCE_MS = 150;
const REMOTE_SEARCH_TIMEOUT_MS = 1_200;
const PLACE_SEARCH_TIMEOUT_MS = 1_500;
/** A predicted track (an orbit) is recomputed this often while it is shown. */
const PLUGIN_TRACK_REFRESH_MS = 30_000;
const MAX_SEEN_EVENTS = 2048;
const MAX_PENDING_META = 4096;
const GATEWAY_FEED = "gateway";
const NO_GATEWAY =
  "Live traffic is offline. No gateway is configured; satellites and earthquakes still work.";

interface KindState {
  store: EntityStore;
  builder: BatchBuilder;
  layer: LayerId;
  intervalMs: number;
  lastBatchMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Gateway meta that arrived before its entity. */
  pendingMeta: Map<number, EntityMeta>;
}

interface PathRecord {
  plugin: SourcePlugin;
  ids: Uint32Array;
  names: string[];
  lower: string[];
  meta: PathSet["meta"];
  /** lon, lat of each path's middle vertex: where the camera goes. */
  anchors: Float32Array;
  updatedMs: number;
}

/** Resolves with `fallback` if `promise` takes longer than `ms` or rejects. */
function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

export class DataRuntime implements DataWorkerApi {
  private readonly deps: RuntimeDeps;
  private sink: MessageSink | null = null;
  private config: DataConfig | null = null;
  private disposed = false;

  private readonly kinds = new Map<EntityKind, KindState>();
  private readonly storeList: EntityStore[] = [];
  private readonly rings = new Map<EntityKind, HistoryRing>();
  private readonly historyTimers: ReturnType<typeof setTimeout>[] = [];
  private readonly layers: LayerStates;
  private readonly enabled = new Map<LayerId, boolean>();
  private plugins: SourcePlugin[] = [];
  private placeSearch: PlaceSearch | null = null;
  private gatewaySources: { atMs: number; list: SourceSummary[] } | null = null;
  private runner: SourceRunner | null = null;
  private gateway: GatewayClient | null = null;
  private readonly paths = new Map<LayerId, PathRecord>();

  private clock: ClockState = { mode: "live", timeMs: 0 };
  private view: ViewState | null = null;
  private visible = true;
  private hiddenSinceMs = 0;
  private scrubTimer: ReturnType<typeof setTimeout> | null = null;
  private lastScrubMs = 0;

  private readonly seenEvents = new Set<string>();
  private readonly seenEventOrder: string[] = [];

  private tracked: EntityRef | null = null;
  private trackBuffer: TrackBuffer | null = null;
  private pluginTrack: Track | null = null;
  private trackTimer: ReturnType<typeof setTimeout> | null = null;

  private searchAbort: AbortController | null = null;

  constructor(deps: RuntimeDeps) {
    this.deps = deps;
    for (const kind of ENTITY_KINDS) {
      const store = new EntityStore(kind);
      this.storeList.push(store);
      this.kinds.set(kind, {
        store,
        builder: new BatchBuilder(kind),
        layer: layerForKind(kind).id,
        intervalMs: deps.batchIntervalMs?.[kind] ?? DEFAULT_BATCH_INTERVAL_MS,
        lastBatchMs: 0,
        timer: null,
        pendingMeta: new Map(),
      });
    }
    this.layers = new LayerStates(
      (layer, state) => this.post({ type: "layer", layer, state }),
      (layer) => {
        const kind = layerDef(layer).kind;
        const state = kind === undefined ? undefined : this.kinds.get(kind);
        return state ? state.store.count : null;
      },
    );
  }

  // ---------------------------------------------------------------- API

  listen(sink: MessageSink): void {
    this.sink = sink;
  }

  async init(config: DataConfig): Promise<void> {
    if (this.config !== null) throw new Error("The data runtime is already initialised");
    this.config = config;
    this.clock = { mode: "live", timeMs: Date.now() };
    const synthetic = createSyntheticSources(config.synthetic ?? 0);
    const chosen =
      typeof this.deps.plugins === "function" ? this.deps.plugins(config) : this.deps.plugins;
    this.plugins = [...chosen, ...synthetic];
    this.placeSearch = this.deps.placeSearchFor
      ? this.deps.placeSearchFor(config)
      : this.deps.placeSearch;

    for (const plugin of this.plugins) {
      // A clock-driven source sets its kind's batch rate: every recompute is drawn.
      const kind = layerDef(plugin.layer).kind;
      const state = kind === undefined ? undefined : this.kinds.get(kind);
      if (state && plugin.recomputeRate !== undefined && plugin.recomputeRate > 0) {
        state.intervalMs = Math.min(state.intervalMs, plugin.recomputeRate);
      }
    }

    this.runner = new SourceRunner(this.plugins, this.runnerHost(), {
      random: this.deps.random,
      ...this.deps.runner,
    });

    if (config.gatewayUrl) {
      this.gateway = new GatewayClient({
        url: config.gatewayUrl,
        createSocket: this.deps.createSocket,
        fetch: this.deps.fetch,
        host: this.gatewayHost(),
        random: this.deps.random,
      });
    }

    const historyMs = config.historyMs > 0 ? config.historyMs : DEFAULT_HISTORY_MS;
    for (const kind of ENTITY_KINDS) {
      const profile = HISTORY_PROFILES[kind];
      if (!profile) continue;
      const ring = new HistoryRing(kind, historyMs, profile);
      this.rings.set(kind, ring);
      const tick = () => {
        if (this.disposed) return;
        this.historyTimers[index] = setTimeout(tick, ring.intervalMs);
        this.keyframe(kind, ring);
      };
      const index = this.historyTimers.push(setTimeout(tick, FIRST_KEYFRAME_MS)) - 1;
    }

    for (const def of LAYERS) this.setLayerEnabled(def.id, config.layers[def.id] === true);
  }

  setLayerEnabled(layer: LayerId, enabled: boolean): void {
    const was = this.enabled.get(layer);
    if (this.config === null || was === enabled) return;
    this.enabled.set(layer, enabled);
    // Announced at the end, once the feeds below have had their say.
    this.layers.setEnabled(layer, enabled, false);
    // A layer that starts switched off has nothing to stop or clear.
    if (was === undefined && !enabled) {
      this.layers.touch(layer, true);
      return;
    }
    const def = layerDef(layer);

    if (def.viaGateway) {
      const gatewayLayer = layer as GatewayLayer;
      if (this.gateway) this.gateway.setLayerEnabled(gatewayLayer, enabled);
      else if (
        enabled &&
        !this.plugins.some((p) => p.layer === layer && p.transport !== "gateway")
      ) {
        // No gateway and nothing else to draw from: say why the layer is empty.
        this.layers.setFeed(layer, GATEWAY_FEED, { status: "offline", message: NO_GATEWAY });
      }
    }
    this.runner?.setLayerEnabled(layer, enabled);

    if (!enabled) {
      const state = def.kind === undefined ? undefined : this.kinds.get(def.kind);
      if (state) {
        // Empty the store and tell the renderer at once; do not wait for the batch timer.
        state.store.clear();
        state.store.changed = false;
        state.pendingMeta.clear();
        if (state.timer !== null) clearTimeout(state.timer);
        state.timer = null;
        const batch = state.builder.empty(Date.now());
        this.post({ type: "batch", batch }, batchTransferables(batch));
      }
      if (def.shape === "tiles") this.post({ type: "tiles", layer, overlay: null });
      this.paths.delete(layer);
      if (this.tracked && def.kind === this.tracked.kind) this.setTracked(null);
    }
    this.layers.touch(layer, true);
  }

  setView(view: ViewState): void {
    this.view = view;
    this.gateway?.setView(view);
    this.runner?.viewChanged();
  }

  setClock(clock: ClockState): void {
    const previous = this.clock;
    this.clock = { mode: clock.mode, timeMs: clock.timeMs };
    if (clock.mode === "live") {
      // In live mode the main thread ticks the clock every second; only the
      // change of mode matters here.
      if (previous.mode === "live") return;
      if (this.scrubTimer !== null) clearTimeout(this.scrubTimer);
      this.scrubTimer = null;
      for (const state of this.kinds.values()) {
        // What is on screen is a replay: start again from the fixes, no easing.
        state.store.resetDrawn();
        this.scheduleBatch(state, 0);
      }
      this.runner?.clockChanged();
      return;
    }
    if (previous.mode === "scrub" && previous.timeMs === clock.timeMs) return;
    if (previous.mode === "live") {
      // Live batches still waiting must not land on top of the replay.
      for (const kind of this.rings.keys()) {
        const state = this.kinds.get(kind) as KindState;
        if (state.timer !== null) clearTimeout(state.timer);
        state.timer = null;
      }
    }
    if (this.scrubTimer !== null) return;
    const wait = Math.max(0, this.lastScrubMs + SCRUB_INTERVAL_MS - Date.now());
    this.scrubTimer = setTimeout(() => {
      this.scrubTimer = null;
      this.scrub();
    }, wait);
  }

  setTracked(ref: EntityRef | null): void {
    if (this.trackTimer !== null) clearTimeout(this.trackTimer);
    this.trackTimer = null;
    this.pluginTrack = null;
    this.tracked = ref ? { kind: ref.kind, id: ref.id } : null;
    if (ref === null) {
      this.trackBuffer = null;
      this.post({ type: "track", track: null });
      return;
    }
    const buffer = new TrackBuffer();
    this.trackBuffer = buffer;
    const recorded = this.rings.get(ref.kind)?.track(ref.id);
    if (recorded) buffer.addAll(recorded.positions, recorded.timesMs, recorded.count);
    const state = this.kinds.get(ref.kind);
    const i = state ? state.store.indexOf(ref.id) : -1;
    if (state && i !== -1) {
      buffer.add(
        state.store.lon[i],
        state.store.lat[i],
        state.store.alt[i],
        state.store.fixTimeMs[i],
      );
    }
    this.refreshPluginTrack();
    this.emitTrack();

    // The gateway remembers further back than this session does.
    if (this.gateway && state && i !== -1 && state.store.ownerOf(i) === GATEWAY_SOURCE) {
      const tracked = this.tracked;
      void within(
        this.gateway.fetchEntity(ref.kind, ref.id),
        GATEWAY_DETAIL_TIMEOUT_MS * 2,
        null,
      ).then((entity) => {
        if (this.tracked !== tracked || !entity || entity.track === null) return;
        const skew = this.gateway?.skewMs ?? 0;
        const times = skew === 0 ? entity.track.timesMs : entity.track.timesMs.map((t) => t + skew);
        buffer.addAll(entity.track.positions, times);
        this.emitTrack();
      });
    }
  }

  async getDetail(ref: EntityRef): Promise<EntityDetail | null> {
    if (this.config === null) return null;
    const state = this.kinds.get(ref.kind);
    if (!state) return this.pathDetail(ref);
    const store = state.store;
    let i = store.indexOf(ref.id);
    const viaGateway = this.gateway !== null && layerDef(state.layer).viaGateway;

    if (i === -1) {
      // Not loaded here (a search hit on the far side of the world): ask the gateway.
      if (!viaGateway || !this.gateway) return null;
      const remote = await within(
        this.gateway.fetchEntity(ref.kind, ref.id),
        DETAIL_TIMEOUT_MS,
        null,
      );
      if (!remote) return null;
      const detail = this.remoteDetail(ref, remote);
      return detail ? this.withPhoto(detail) : null;
    }

    const plugin = this.ownerPlugin(store, i);
    const fromGateway = store.ownerOf(i) === GATEWAY_SOURCE;
    const abort = new AbortController();
    const timer = setTimeout(
      () => abort.abort(new DOMException("Detail took too long", "TimeoutError")),
      DETAIL_TIMEOUT_MS,
    );
    // Both lookups start now and are each given a fixed time: a slow provider
    // delays the panel's extras, never the panel.
    const remoteWork =
      fromGateway && this.gateway
        ? within(
            this.gateway.fetchEntity(ref.kind, ref.id, abort.signal),
            GATEWAY_DETAIL_TIMEOUT_MS,
            null,
          )
        : Promise.resolve(null);
    const pluginWork = plugin?.detail
      ? within(
          Promise.resolve().then(() =>
            plugin.detail?.(ref.id, store.meta[i], this.detailContext(plugin, abort.signal)),
          ),
          DETAIL_TIMEOUT_MS,
          undefined,
        )
      : Promise.resolve(undefined);
    // Started now so it runs alongside the rest; it is not tied to this call's
    // lifetime, so a photo that arrives late is ready for the next refresh.
    const photoWork = fromGateway ? this.photoFor(ref) : Promise.resolve(null);

    try {
      const remote = await remoteWork;
      if (remote) this.mergeGatewayMeta(state, ref.id, remote.meta);
      const extra = await pluginWork;
      const photo = await photoWork;
      // The entity may have moved in the columns, or left, while we waited.
      i = store.indexOf(ref.id);
      if (i === -1) {
        const detail = remote ? this.remoteDetail(ref, remote) : null;
        if (detail && photo) detail.media = [photo];
        return detail;
      }
      const base = buildDetail(
        store,
        i,
        this.schemaFor(ref.kind, plugin, fromGateway),
        this.attributionFor(state.layer, plugin),
        this.storeList,
      );
      if (photo) base.media = [photo];
      const detail = mergeDetail(base, extra, plugin?.schema);
      if (remote) this.applyRemote(detail, remote);
      return detail;
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  }

  /** Name and one number for the hover tag, from what is loaded. No network. */
  async getSummary(ref: EntityRef): Promise<EntitySummary | null> {
    if (this.config === null) return null;
    const state = this.kinds.get(ref.kind);
    if (state) {
      const i = state.store.indexOf(ref.id);
      return i === -1 ? null : buildSummary(state.store, i);
    }
    for (const [layer, record] of this.paths) {
      if (layerDef(layer).kind !== ref.kind) continue;
      const p = record.ids.indexOf(ref.id);
      if (p === -1) continue;
      return {
        ref: { kind: ref.kind, id: ref.id },
        layer,
        title: record.names[p] || `${layerDef(layer).label} ${ref.id}`,
      };
    }
    return null;
  }

  async search(query: string, near?: { lon: number; lat: number }): Promise<SearchResult[]> {
    // A new keystroke makes the previous remote lookup worthless.
    this.searchAbort?.abort();
    this.searchAbort = null;
    const q = query.trim();
    if (q === "" || this.config === null) return [];

    const local = searchStores(this.storeList, q, DEFAULT_SEARCH_LIMIT, near);
    const lists: SearchResult[][] = [local, this.searchPaths(q)];
    const waits: Promise<SearchResult[]>[] = [];

    if (this.gateway?.online && GATEWAY_LAYERS.some((layer) => this.enabled.get(layer))) {
      const abort = new AbortController();
      this.searchAbort = abort;
      const gateway = this.gateway;
      const remote = new Promise<SearchResult[]>((resolve) => {
        const debounce = setTimeout(() => {
          gateway.search(q, abort.signal).then(resolve, () => resolve([]));
        }, REMOTE_SEARCH_DEBOUNCE_MS);
        // Superseded: answer at once with what is local.
        abort.signal.addEventListener("abort", () => {
          clearTimeout(debounce);
          resolve([]);
        });
      });
      waits.push(within(remote, REMOTE_SEARCH_DEBOUNCE_MS + REMOTE_SEARCH_TIMEOUT_MS, []));
    }
    const placeSearch = this.placeSearch;
    if (placeSearch) {
      const places = Promise.resolve()
        .then(() => placeSearch(q, DEFAULT_SEARCH_LIMIT, near))
        .then((results) => (Array.isArray(results) ? results : []));
      waits.push(within(places, PLACE_SEARCH_TIMEOUT_MS, []));
    }
    for (const list of await Promise.all(waits)) lists.push(list);
    return mergeResults(lists, DEFAULT_SEARCH_LIMIT);
  }

  async getAttributions(): Promise<SourceSummary[]> {
    const summaries: SourceSummary[] = [];
    const described = new Set<LayerId>();
    // The gateway knows which feeds it is really running; a plugin that
    // describes a gateway layer only knows the defaults.
    const running = await this.gatewaySourceList();
    for (const source of running) described.add(source.layer);
    summaries.push(...running);
    for (const plugin of this.plugins) {
      if (plugin.transport === "gateway") {
        if (described.has(plugin.layer)) continue;
        described.add(plugin.layer);
      }
      const summary: SourceSummary = {
        id: plugin.id,
        name: plugin.name,
        layer: plugin.layer,
        licence: plugin.licence.name,
        licenceUrl: plugin.licence.url,
        attribution: plugin.attribution.text,
        attributionUrl: plugin.attribution.url,
        docs: plugin.docs,
      };
      if (plugin.licence.notes !== undefined) summary.notes = plugin.licence.notes;
      summaries.push(summary);
    }
    if (this.gateway && this.config?.gatewayUrl) {
      const page = `${this.config.gatewayUrl.replace(/\/+$/, "").replace(/^ws/i, "http")}/v1/attribution`;
      for (const layer of GATEWAY_LAYERS) {
        const text = this.gateway.attributions[layer];
        // A registered plugin already credits this layer in full.
        if (!text || described.has(layer)) continue;
        summaries.push({
          id: `gateway-${layer}`,
          name: `${layerDef(layer).label} via the Orya Halo gateway`,
          layer,
          licence: "See the provider's terms",
          licenceUrl: page,
          attribution: text,
          attributionUrl: page,
          docs: page,
        });
      }
    }
    return summaries;
  }

  /**
   * Tab visibility, relayed by the main thread (a worker cannot see it).
   * Hidden: no polling, no batches. Visible again: catch up at once.
   */
  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.runner?.setVisible(visible);
    if (!visible) {
      this.hiddenSinceMs = Date.now();
      return;
    }
    const stale = Date.now() - this.hiddenSinceMs > HIDDEN_RESET_MS;
    for (const state of this.kinds.values()) {
      if (stale) state.store.resetDrawn();
      if (state.store.changed) this.scheduleBatch(state, 0);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.runner?.dispose();
    this.gateway?.stop();
    this.layers.dispose();
    this.searchAbort?.abort();
    for (const timer of this.historyTimers) clearTimeout(timer);
    for (const state of this.kinds.values()) {
      if (state.timer !== null) clearTimeout(state.timer);
      state.timer = null;
    }
    if (this.scrubTimer !== null) clearTimeout(this.scrubTimer);
    if (this.trackTimer !== null) clearTimeout(this.trackTimer);
    this.sink = null;
  }

  // ------------------------------------------------------- introspection

  /** The store of one kind. For tests and benchmarks. */
  storeOf(kind: EntityKind): EntityStore | undefined {
    return this.kinds.get(kind)?.store;
  }

  /** The history ring of one kind, if it is recorded. */
  ringOf(kind: EntityKind): HistoryRing | undefined {
    return this.rings.get(kind);
  }

  /**
   * Size of everything that could grow over a session, by name. The
   * flat-memory test runs an hour of traffic and checks none of these climb.
   */
  memoryStats(): Record<string, number> {
    const stats: Record<string, number> = {
      seenEvents: this.seenEvents.size,
      seenEventOrder: this.seenEventOrder.length,
      paths: this.paths.size,
      trackPoints: this.trackBuffer?.count ?? 0,
    };
    for (const [kind, state] of this.kinds) {
      stats[`store${kind}.count`] = state.store.count;
      stats[`store${kind}.bytes`] = state.store.bytes;
      stats[`store${kind}.meta`] = state.store.meta.length;
      stats[`store${kind}.keys`] = state.store.keys.length;
      stats[`store${kind}.pendingMeta`] = state.pendingMeta.size;
    }
    for (const [kind, ring] of this.rings) {
      stats[`ring${kind}.bytes`] = ring.bytes;
      stats[`ring${kind}.slots`] = ring.slots;
    }
    return stats;
  }

  /**
   * A plain snapshot of what the runtime is doing: layer states, store sizes,
   * the gateway connection and when each source next asks its provider. For
   * the development hook in `data.worker.ts` and for tests.
   */
  debugState(): Record<string, unknown> {
    const layers: Record<string, unknown> = {};
    for (const def of LAYERS) layers[def.id] = this.layers.current(def.id);
    const stores: Record<string, number> = {};
    for (const [kind, state] of this.kinds) stores[layerForKind(kind).id] = state.store.count;
    const history: Record<string, unknown> = {};
    for (const [kind, ring] of this.rings) history[layerForKind(kind).id] = ring.range();
    return {
      clock: { ...this.clock },
      view: this.view,
      layers,
      stores,
      paths: Object.fromEntries(
        [...this.paths].map(([layer, record]) => [layer, record.ids.length]),
      ),
      history,
      sources: this.runner?.schedule() ?? [],
      gateway: this.gateway
        ? {
            online: this.gateway.online,
            latencyMs: this.gateway.latencyMs,
            skewMs: this.gateway.skewMs,
            subscription: this.gateway.subscription(),
            ...this.gateway.stats,
          }
        : null,
    };
  }

  /** The gateway client, when a gateway is configured. */
  get gatewayClient(): GatewayClient | null {
    return this.gateway;
  }

  // ------------------------------------------------------------ plumbing

  private post(message: DataMessage, transfer: Transferable[] = []): void {
    if (this.disposed) return;
    this.sink?.(message, transfer);
  }

  private clockNow(): number {
    return this.clock.mode === "scrub" ? this.clock.timeMs : Date.now();
  }

  private isEnabled(layer: LayerId): boolean {
    return this.enabled.get(layer) === true;
  }

  private runnerHost() {
    const config = this.config as DataConfig;
    return {
      now: () => this.clockNow(),
      isLive: () => this.clock.mode === "live",
      view: () => this.view ?? undefined,
      key: (name: string) => config.keys[name],
      assetBase: config.assetBase,
      fetch: this.deps.fetch,
      cache: this.deps.cache,
      online: () => (globalThis.navigator as { onLine?: boolean } | undefined)?.onLine !== false,
      onEntities: (_plugin: SourcePlugin, update: EntityUpdate) => this.applyUpdate(update, false),
      onEvents: (events: HaloEvent[]) => this.onEvents(events),
      onPaths: (plugin: SourcePlugin, paths: PathSet) => this.onPaths(plugin, paths),
      onTiles: (plugin: SourcePlugin, overlay: TileOverlay | null) => {
        if (this.isEnabled(plugin.layer))
          this.post({ type: "tiles", layer: plugin.layer, overlay });
      },
      onState: (plugin: SourcePlugin, state: Parameters<LayerStates["setFeed"]>[2]) => {
        this.layers.setFeed(plugin.layer, plugin.id, state);
      },
      onStopped: (plugin: SourcePlugin) => {
        const kind = layerDef(plugin.layer).kind;
        const state = kind === undefined ? undefined : this.kinds.get(kind);
        if (!state) return;
        state.store.removeSource(plugin.id);
        if (state.store.changed) this.scheduleBatch(state);
      },
    };
  }

  private gatewayHost() {
    return {
      apply: (update: EntityUpdate, saturated: readonly number[] | null) =>
        this.applyUpdate(update, true, saturated),
      remove: (kind: EntityKind, ids: Uint32Array) => {
        const state = this.kinds.get(kind);
        if (!state) return;
        state.store.removeIds(ids, GATEWAY_SOURCE);
        if (state.store.changed) this.scheduleBatch(state);
      },
      meta: (kind: EntityKind, id: number, meta: EntityMeta) => {
        const state = this.kinds.get(kind);
        if (state) this.mergeGatewayMeta(state, id, meta);
      },
      density: (grid: DensityGrid) => {
        // A live density grid has no place on top of a replay.
        if (this.clock.mode !== "live" || !this.visible) return;
        this.post({ type: "density", grid }, [
          grid.positions.buffer as ArrayBuffer,
          grid.counts.buffer as ArrayBuffer,
        ]);
      },
      events: (events: HaloEvent[]) => this.onEvents(events),
      state: (layer: GatewayLayer, state: Parameters<LayerStates["setFeed"]>[2]) => {
        this.layers.setFeed(layer, GATEWAY_FEED, state);
      },
      clear: (layer: GatewayLayer) => {
        const state = this.kinds.get(kindOfGatewayLayer(layer));
        if (!state) return;
        state.store.removeSource(GATEWAY_SOURCE);
        state.pendingMeta.clear();
        if (state.store.changed) this.scheduleBatch(state);
      },
    };
  }

  private applyUpdate(
    update: EntityUpdate,
    fromGateway: boolean,
    saturated: readonly number[] | null = null,
  ): void {
    const state = this.kinds.get(update.kind);
    if (!state || !this.isEnabled(state.layer)) return;
    if (saturated !== null) {
      // A fix older than the wire can say arrives as "255 s old" every time it
      // is sent (after each new subscription). Taken at face value its time
      // would creep forward and dead reckoning would start over from the same
      // spot. The time we already hold for that position is the better one.
      const store = state.store;
      const c = update.columns;
      for (const row of saturated) {
        const at = store.indexOf(c.ids[row]);
        if (
          at !== -1 &&
          store.lon[at] === c.lon[row] &&
          store.lat[at] === c.lat[row] &&
          store.fixTimeMs[at] < c.fixTimeMs[row]
        ) {
          c.fixTimeMs[row] = store.fixTimeMs[at];
        }
      }
    }
    state.store.apply(update, Date.now(), fromGateway ? { keepValue: true } : undefined);
    if (fromGateway && state.pendingMeta.size > 0) {
      // Meta that overtook its entity: attach it now.
      const ids = update.columns.ids;
      for (let i = 0; i < update.count; i++) {
        const meta = state.pendingMeta.get(ids[i]);
        if (meta === undefined) continue;
        state.pendingMeta.delete(ids[i]);
        this.mergeGatewayMeta(state, ids[i], meta);
      }
    }
    if (state.store.changed) this.scheduleBatch(state);
    this.layers.touch(state.layer);
  }

  private mergeGatewayMeta(state: KindState, id: number, meta: EntityMeta): void {
    if (!state.store.mergeMeta(id, meta)) {
      if (state.pendingMeta.size >= MAX_PENDING_META) {
        const oldest = state.pendingMeta.keys().next().value;
        if (oldest !== undefined) state.pendingMeta.delete(oldest);
      }
      state.pendingMeta.set(id, meta);
      return;
    }
    if (state.store.kind === EntityKind.Ship && meta.lengthM !== undefined) {
      // Gateway frames carry no `value`; a ship's is its length.
      const length = Number(meta.lengthM);
      if (Number.isFinite(length)) state.store.setValue(id, length);
      if (state.store.changed) this.scheduleBatch(state);
    }
  }

  /** Arrange for a batch of this kind, no sooner than its rate allows. */
  private scheduleBatch(state: KindState, coalesceMs = COALESCE_MS): void {
    if (state.timer !== null || this.disposed) return;
    if (!this.visible) return;
    // While replaying, recorded kinds are drawn from history, not from the store.
    if (this.clock.mode === "scrub" && this.rings.has(state.store.kind)) return;
    const wait = Math.max(coalesceMs, state.lastBatchMs + state.intervalMs - Date.now());
    state.timer = setTimeout(() => {
      state.timer = null;
      this.flush(state);
    }, wait);
  }

  private flush(state: KindState): void {
    const store = state.store;
    if (!this.visible || !store.changed || !this.isEnabled(state.layer)) return;
    const scrubbing = this.clock.mode === "scrub";
    if (scrubbing && this.rings.has(store.kind)) return;
    const now = Date.now();
    // When replaying, the update time is the moment shown, and nothing eases:
    // each scrub step is a different instant, not a correction.
    const batch = state.builder.build(store, scrubbing ? this.clock.timeMs : now, !scrubbing);
    state.lastBatchMs = now;
    this.post({ type: "batch", batch }, batchTransferables(batch));
    this.layers.touch(state.layer);
    if (this.tracked !== null && this.tracked.kind === store.kind) this.extendTrack(store);
  }

  /** Replay step: recorded kinds from history, clock-driven sources recomputed. */
  private scrub(): void {
    if (this.clock.mode !== "scrub" || this.disposed) return;
    this.lastScrubMs = Date.now();
    const timeMs = this.clock.timeMs;
    for (const [kind, ring] of this.rings) {
      const state = this.kinds.get(kind) as KindState;
      if (!this.isEnabled(state.layer)) continue;
      const batch =
        ring.reconstruct(timeMs, state.builder.nextSeq()) ?? state.builder.empty(timeMs);
      this.post({ type: "batch", batch }, batchTransferables(batch));
    }
    this.runner?.clockChanged();
    for (const state of this.kinds.values()) {
      if (state.store.changed && !this.rings.has(state.store.kind)) {
        if (state.timer !== null) clearTimeout(state.timer);
        state.timer = null;
        this.flush(state);
      }
    }
    this.refreshPluginTrack();
    if (this.pluginTrack) this.emitTrack();
  }

  private keyframe(kind: EntityKind, ring: HistoryRing): void {
    const state = this.kinds.get(kind) as KindState;
    const now = Date.now();
    if (state.store.expire(now, EXPIRY_MS[kind]) > 0) {
      this.scheduleBatch(state);
      this.layers.touch(state.layer);
    }
    ring.record(state.store, now);
    let fromMs = Number.POSITIVE_INFINITY;
    let toMs = Number.NEGATIVE_INFINITY;
    for (const other of this.rings.values()) {
      const range = other.range();
      if (!range) continue;
      if (range.fromMs < fromMs) fromMs = range.fromMs;
      if (range.toMs > toMs) toMs = range.toMs;
    }
    if (toMs >= fromMs) this.post({ type: "history", fromMs, toMs });
  }

  private onEvents(events: HaloEvent[]): void {
    const fresh: HaloEvent[] = [];
    for (const event of events) {
      if (typeof event?.id !== "string" || this.seenEvents.has(event.id)) continue;
      this.seenEvents.add(event.id);
      this.seenEventOrder.push(event.id);
      fresh.push(event);
    }
    // Bounded memory: forget the oldest ids. A report repeated after that long is news again.
    while (this.seenEventOrder.length > MAX_SEEN_EVENTS) {
      this.seenEvents.delete(this.seenEventOrder.shift() as string);
    }
    if (fresh.length > 0) this.post({ type: "events", events: fresh });
  }

  private onPaths(plugin: SourcePlugin, paths: PathSet): void {
    if (!this.isEnabled(plugin.layer)) return;
    const anchors = new Float32Array(paths.count * 2);
    for (let p = 0; p < paths.count; p++) {
      const start = paths.startIndices[p];
      const end = paths.startIndices[p + 1];
      if (end <= start) continue;
      const middle = (start + end) >> 1;
      anchors[p * 2] = paths.positions[middle * 2];
      anchors[p * 2 + 1] = paths.positions[middle * 2 + 1];
    }
    this.paths.set(plugin.layer, {
      plugin,
      ids: paths.ids.slice(),
      names: paths.names,
      lower: paths.names.map((name) => name.toLowerCase()),
      meta: paths.meta,
      anchors,
      updatedMs: Date.now(),
    });
    // Copied, not transferred: a plugin may build its PathSet over arrays it
    // keeps in its raw data, and transferring would empty those. Paths are
    // static and sent once, so the copy is not on any hot path.
    this.post({ type: "paths", layer: plugin.layer, paths });
  }

  // -------------------------------------------------------------- tracks

  private extendTrack(store: EntityStore): void {
    const tracked = this.tracked;
    const buffer = this.trackBuffer;
    if (!tracked || !buffer) return;
    const i = store.indexOf(tracked.id);
    if (i === -1) return;
    if (buffer.add(store.lon[i], store.lat[i], store.alt[i], store.fixTimeMs[i])) this.emitTrack();
  }

  private emitTrack(): void {
    if (!this.tracked || !this.trackBuffer) return;
    const track = this.trackBuffer.toTrack(this.tracked, this.pluginTrack);
    this.post({ type: "track", track }, [
      track.positions.buffer as ArrayBuffer,
      track.timesMs.buffer as ArrayBuffer,
    ]);
  }

  /** Ask the owning plugin for its own idea of the track (a satellite's orbit). */
  private refreshPluginTrack(): void {
    const tracked = this.tracked;
    if (this.trackTimer !== null) clearTimeout(this.trackTimer);
    this.trackTimer = null;
    if (!tracked || !this.runner) return;
    const state = this.kinds.get(tracked.kind);
    const i = state ? state.store.indexOf(tracked.id) : -1;
    const plugin = state && i !== -1 ? this.ownerPlugin(state.store, i) : undefined;
    if (!plugin?.track) return;
    try {
      const raw = this.runner.raw(plugin.id);
      this.pluginTrack =
        raw === undefined ? null : plugin.track(raw, tracked.id, { now: () => this.clockNow() });
    } catch {
      this.pluginTrack = null;
    }
    // A prediction is relative to "now", so it goes stale as time passes.
    this.trackTimer = setTimeout(() => {
      this.trackTimer = null;
      if (this.tracked !== tracked) return;
      this.refreshPluginTrack();
      this.emitTrack();
    }, PLUGIN_TRACK_REFRESH_MS);
  }

  // -------------------------------------------------------------- detail

  /** The plugin that describes entity `i`: its source, or the gateway layer's descriptor. */
  private ownerPlugin(store: EntityStore, i: number): SourcePlugin | undefined {
    const source = store.ownerOf(i);
    if (source === GATEWAY_SOURCE) {
      const layer = layerForKind(store.kind).id;
      return this.plugins.find((p) => p.transport === "gateway" && p.layer === layer);
    }
    return this.plugins.find((p) => p.id === source);
  }

  private schemaFor(
    kind: EntityKind,
    plugin: SourcePlugin | undefined,
    fromGateway = false,
  ): readonly SchemaField[] {
    if (plugin && plugin.schema.length > 0) {
      return fromGateway ? gatewaySchema(kind, plugin.schema) : plugin.schema;
    }
    return GATEWAY_SCHEMAS[kind] ?? [];
  }

  /** The photo of an aircraft, if one is known or turns up within the panel's patience. */
  private photoFor(ref: EntityRef): Promise<DetailMedia | null> {
    const photos = this.deps.photos;
    if (!photos || ref.kind !== EntityKind.Aircraft) return Promise.resolve(null);
    return within(photos.lookup(ref.id), PHOTO_WAIT_MS, null);
  }

  private async withPhoto(detail: EntityDetail): Promise<EntityDetail> {
    const photo = await this.photoFor(detail.ref);
    if (photo) detail.media = [photo];
    return detail;
  }

  /** Lay what only the gateway's detail endpoint knows over a locally built detail. */
  private applyRemote(detail: EntityDetail, remote: GatewayEntity): void {
    // A frame carries the fix time as whole seconds of age, 255 at most. When
    // the gateway is describing the same fix, its time is the exact one.
    if (
      Math.abs(remote.lon - detail.lon) < SAME_FIX_DEG &&
      Math.abs(remote.lat - detail.lat) < SAME_FIX_DEG
    ) {
      detail.fixTimeMs = remote.fixTimeMs + (this.gateway?.skewMs ?? 0);
    }
    if (remote.origin) detail.origin = remote.origin;
    if (remote.destination) detail.destination = remote.destination;
    // The feed this very object came from, which may not be the layer's default.
    if (remote.attribution && remote.attribution.text !== "") {
      detail.attribution = remote.attribution;
    }
  }

  /** The feeds the gateway says it is running, as attribution entries. Empty when it does not answer. */
  private async gatewaySourceList(): Promise<SourceSummary[]> {
    const gateway = this.gateway;
    if (!gateway) return [];
    const known = this.gatewaySources;
    if (known && Date.now() - known.atMs < GATEWAY_SOURCES_TTL_MS) return known.list;
    const abort = new AbortController();
    const list = await within(
      this.deps
        .fetch(`${gateway.httpUrl}/v1/attribution`, { signal: abort.signal })
        .then((response) => (response.ok ? response.json() : null))
        .then(parseGatewaySources),
      GATEWAY_DETAIL_TIMEOUT_MS,
      [],
    );
    abort.abort();
    // An empty answer is not remembered: the gateway may just be starting.
    if (list.length > 0) this.gatewaySources = { atMs: Date.now(), list };
    return list;
  }

  private attributionFor(layer: LayerId, plugin: SourcePlugin | undefined): Attribution {
    if (plugin) return plugin.attribution;
    const text = this.gateway?.attributions[layer as GatewayLayer];
    const base = this.config?.gatewayUrl?.replace(/\/+$/, "").replace(/^ws/i, "http");
    return {
      text: text ?? `${layerDef(layer).label} data`,
      url: base ? `${base}/v1/attribution` : "",
    };
  }

  private detailContext(plugin: SourcePlugin, signal: AbortSignal): SourceContext {
    const config = this.config as DataConfig;
    return {
      fetch: createPolicyFetch({
        fetch: this.deps.fetch,
        signal,
        timeoutMs: DETAIL_TIMEOUT_MS,
        cache: this.deps.cache,
        cacheTtlMs: 0,
        now: () => Date.now(),
      }),
      now: () => this.clockNow(),
      key: plugin.requiresKey !== undefined ? config.keys[plugin.requiresKey] : undefined,
      signal,
      assetBase: config.assetBase,
      view: this.view ?? undefined,
    };
  }

  /** Detail for a gateway entity this client has not loaded, from the gateway's answer alone. */
  private remoteDetail(ref: EntityRef, remote: GatewayEntity): EntityDetail | null {
    // A one-entity store lets the usual assembly do the work.
    const store = new EntityStore(ref.kind);
    const skew = this.gateway?.skewMs ?? 0;
    store.apply(
      {
        kind: ref.kind,
        source: GATEWAY_SOURCE,
        timeMs: Date.now(),
        full: true,
        count: 1,
        columns: {
          ids: Uint32Array.of(ref.id),
          lon: Float32Array.of(remote.lon),
          lat: Float32Array.of(remote.lat),
          alt: Float32Array.of(remote.alt),
          heading: Float32Array.of(remote.heading ?? Number.NaN),
          speed: Float32Array.of(remote.speed),
          vrate: Float32Array.of(remote.vrate),
          fixTimeMs: Float64Array.of(remote.fixTimeMs + skew),
          category: Uint8Array.of(remote.category),
          flags: Uint8Array.of(remote.flags),
          value: new Float32Array(1),
        },
        meta: [remote.meta],
      },
      Date.now(),
    );
    const layer = layerForKind(ref.kind).id;
    const plugin = this.plugins.find((p) => p.transport === "gateway" && p.layer === layer);
    const detail = buildDetail(
      store,
      0,
      this.schemaFor(ref.kind, plugin, true),
      this.attributionFor(layer, plugin),
      this.storeList,
    );
    this.applyRemote(detail, remote);
    return detail;
  }

  /** Detail for a path (an undersea cable): a name, its facts, and somewhere to look. */
  private async pathDetail(ref: EntityRef): Promise<EntityDetail | null> {
    for (const [layer, record] of this.paths) {
      if (layerDef(layer).kind !== ref.kind) continue;
      const p = record.ids.indexOf(ref.id);
      if (p === -1) continue;
      const plugin = record.plugin;
      const meta = record.meta?.[p] as EntityMeta | undefined;
      // Reuse the field formatter through a throwaway one-entity store.
      const store = new EntityStore(ref.kind);
      store.apply(
        {
          kind: ref.kind,
          source: plugin.id,
          timeMs: record.updatedMs,
          full: true,
          count: 1,
          columns: {
            ids: Uint32Array.of(ref.id),
            lon: Float32Array.of(record.anchors[p * 2]),
            lat: Float32Array.of(record.anchors[p * 2 + 1]),
            alt: new Float32Array(1),
            heading: Float32Array.of(Number.NaN),
            speed: new Float32Array(1),
            vrate: new Float32Array(1),
            fixTimeMs: Float64Array.of(record.updatedMs),
            category: new Uint8Array(1),
            flags: new Uint8Array(1),
            value: new Float32Array(1),
          },
          meta: [{ ...meta, label: record.names[p] }],
        },
        record.updatedMs,
      );
      const base: EntityDetail = {
        ref: { kind: ref.kind, id: ref.id },
        layer,
        title: record.names[p] || `${layerDef(layer).label} ${ref.id}`,
        lon: record.anchors[p * 2],
        lat: record.anchors[p * 2 + 1],
        alt: 0,
        heading: null,
        speed: 0,
        fixTimeMs: record.updatedMs,
        fields: detailFields(store, 0, plugin.schema),
        attribution: plugin.attribution,
      };
      if (meta) base.meta = { ...meta };
      if (!plugin.detail) return base;
      const abort = new AbortController();
      try {
        const extra = await within(
          Promise.resolve().then(() =>
            plugin.detail?.(ref.id, store.meta[0], this.detailContext(plugin, abort.signal)),
          ),
          DETAIL_TIMEOUT_MS,
          undefined,
        );
        return mergeDetail(base, extra, plugin.schema);
      } finally {
        abort.abort();
      }
    }
    return null;
  }

  private searchPaths(query: string): SearchResult[] {
    const q = query.toLowerCase();
    const results: SearchResult[] = [];
    for (const [layer, record] of this.paths) {
      const kind = layerDef(layer).kind;
      if (kind === undefined) continue;
      for (let p = 0; p < record.lower.length && results.length < DEFAULT_SEARCH_LIMIT; p++) {
        const pos = record.lower[p].indexOf(q);
        if (pos === -1) continue;
        const name = record.lower[p];
        const score =
          pos === 0
            ? name.length === q.length
              ? 100
              : 88
            : name.charCodeAt(pos - 1) === 32
              ? 58
              : 38;
        results.push({
          type: "entity",
          ref: { kind, id: record.ids[p] },
          layer,
          title: record.names[p],
          subtitle: layerDef(layer).label,
          lon: record.anchors[p * 2],
          lat: record.anchors[p * 2 + 1],
          score,
        });
      }
    }
    return results;
  }
}

/** Read the gateway's `GET /v1/attribution`: the feeds it is running right now, with their credit. */
function parseGatewaySources(json: unknown): SourceSummary[] {
  const sources = (json as { sources?: unknown } | null)?.sources;
  if (!Array.isArray(sources)) return [];
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  const list: SourceSummary[] = [];
  for (const source of sources as Record<string, unknown>[]) {
    if (typeof source !== "object" || source === null || source.active !== true) continue;
    const layer = source.layer;
    if ((layer !== "aircraft" && layer !== "ships") || text(source.attribution) === "") continue;
    const summary: SourceSummary = {
      id: `gateway-${text(source.id)}`,
      name: text(source.name),
      layer,
      licence: text(source.licence),
      licenceUrl: text(source.licenceUrl),
      attribution: text(source.attribution),
      attributionUrl: text(source.attributionUrl),
      docs: text(source.docs),
    };
    if (text(source.notes) !== "") summary.notes = text(source.notes);
    list.push(summary);
  }
  return list;
}
