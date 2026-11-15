/**
 * Layer state: what the dock shows for each layer.
 *
 * A layer can have several feeds (the gateway and a plugin, or two plugins).
 * Each reports its own state; this folds them into one `LayerState` per
 * layer and emits it at most about once a second.
 */
import { LAYERS, layerDef } from "@orya-halo/schema";
import type { LayerId, LayerState, LayerStatus } from "@orya-halo/schema";

export interface FeedState {
  status: LayerStatus;
  /** Plain words for anything other than `live`, ready to show. */
  message?: string;
  /** When this feed last delivered data. */
  updatedMs?: number;
  /** Object count for feeds that are not entity stores (paths). */
  count?: number | null;
  /** Worldwide total, when the feed knows one. */
  total?: number | null;
}

const MIN_EMIT_MS = 1000;

/** Best first: the layer shows the healthiest thing any of its feeds can claim. */
const RANK: Record<LayerStatus, number> = {
  live: 0,
  degraded: 1,
  loading: 2,
  "needs-key": 3,
  offline: 4,
  error: 5,
  off: 6,
};

const SINGULAR: ReadonlySet<LayerId> = new Set(["radar", "imagery", "nightlights"]);

/** Layer label with the verb agreeing: "Ships are", "Rain radar is". */
export function layerSubject(layer: LayerId, plural: string, singular: string): string {
  return `${layerDef(layer).label} ${SINGULAR.has(layer) ? singular : plural}`;
}

interface Entry {
  enabled: boolean;
  feeds: Map<string, FeedState>;
  last: LayerState | null;
  lastEmitMs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class LayerStates {
  private readonly entries = new Map<LayerId, Entry>();
  private readonly emit: (layer: LayerId, state: LayerState) => void;
  private readonly countFor: (layer: LayerId) => number | null;

  /**
   * `countFor` returns the loaded object count of an entity layer, or null
   * for layers whose count comes from a feed.
   */
  constructor(
    emit: (layer: LayerId, state: LayerState) => void,
    countFor: (layer: LayerId) => number | null,
  ) {
    this.emit = emit;
    this.countFor = countFor;
    for (const def of LAYERS) {
      this.entries.set(def.id, {
        enabled: false,
        feeds: new Map(),
        last: null,
        lastEmitMs: 0,
        timer: null,
      });
    }
  }

  private entry(layer: LayerId): Entry {
    return this.entries.get(layer) as Entry;
  }

  /**
   * Switch a layer on or off. With `announce` false nothing is emitted yet:
   * the caller registers the layer's feeds first and then calls `touch`, so
   * the HUD never sees the moment in between when a layer has no feed.
   */
  setEnabled(layer: LayerId, enabled: boolean, announce = true): void {
    const entry = this.entry(layer);
    entry.enabled = enabled;
    if (announce) this.touch(layer, true);
  }

  /** Report one feed's state. Pass null to forget the feed. */
  setFeed(layer: LayerId, feed: string, state: FeedState | null): void {
    const entry = this.entry(layer);
    const previous = entry.feeds.get(feed);
    if (state === null) entry.feeds.delete(feed);
    else entry.feeds.set(feed, state);
    // A change of status should not wait behind the one-second throttle.
    this.touch(layer, previous?.status !== state?.status);
  }

  feed(layer: LayerId, feed: string): FeedState | undefined {
    return this.entry(layer).feeds.get(feed);
  }

  /** The state as it would be emitted now. */
  current(layer: LayerId): LayerState {
    const entry = this.entry(layer);
    if (!entry.enabled) return { status: "off", count: null };
    const def = layerDef(layer);
    if (entry.feeds.size === 0) {
      // Nothing to fetch: the engine draws the terminator itself.
      if (def.shape === "computed") return { status: "live", count: null };
      return {
        status: "error",
        count: null,
        message: `${layerSubject(layer, "aren't", "isn't")} available in this build.`,
      };
    }

    let best: FeedState | null = null;
    let trouble: FeedState | null = null;
    let updatedMs = 0;
    let feedCount: number | null = null;
    let total: number | null | undefined;
    for (const state of entry.feeds.values()) {
      if (best === null || RANK[state.status] < RANK[best.status]) best = state;
      if (state.status === "offline" || state.status === "error" || state.status === "degraded") {
        if (trouble === null || RANK[state.status] > RANK[trouble.status]) trouble = state;
      }
      if (state.updatedMs !== undefined && state.updatedMs > updatedMs) updatedMs = state.updatedMs;
      if (typeof state.count === "number") feedCount = (feedCount ?? 0) + state.count;
      if (state.total !== undefined && state.total !== null) total = state.total;
    }
    const chosen = best as FeedState;
    // One feed working and another failing is partial data: say so.
    const partial = chosen.status === "live" && trouble !== null;
    const status: LayerStatus = partial ? "degraded" : chosen.status;
    const message = partial ? trouble?.message : chosen.message;

    const stored = this.countFor(layer);
    const state: LayerState = { status, count: stored ?? feedCount };
    if (total !== undefined) state.total = total;
    if (message !== undefined && status !== "live") state.message = message;
    if (updatedMs > 0) state.updatedMs = updatedMs;
    return state;
  }

  /** Note that a layer's count or freshness moved. `urgent` skips the throttle. */
  touch(layer: LayerId, urgent = false): void {
    const entry = this.entry(layer);
    const now = Date.now();
    const wait = urgent ? 0 : entry.lastEmitMs + MIN_EMIT_MS - now;
    if (wait <= 0) {
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      this.flush(layer);
    } else if (entry.timer === null) {
      entry.timer = setTimeout(() => {
        entry.timer = null;
        this.flush(layer);
      }, wait);
    }
  }

  private flush(layer: LayerId): void {
    const entry = this.entry(layer);
    const state = this.current(layer);
    const last = entry.last;
    if (
      last !== null &&
      last.status === state.status &&
      last.count === state.count &&
      last.total === state.total &&
      last.message === state.message &&
      last.updatedMs === state.updatedMs
    ) {
      return;
    }
    entry.last = state;
    entry.lastEmitMs = Date.now();
    this.emit(layer, state);
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.timer = null;
    }
  }
}
