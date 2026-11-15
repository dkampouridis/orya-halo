/**
 * UI state. Small on purpose: entity data never enters React. The store holds
 * what the HUD shows (which layers are on, what is selected, the clock) and
 * the app controller mirrors changes to the engine and the data worker.
 */
import { EntityKind, LAYERS } from "@orya-halo/schema";
import type {
  ClockState,
  EntityDetail,
  EntityRef,
  HaloEvent,
  LayerId,
  LayerState,
  SearchResult,
  ViewState,
} from "@orya-halo/schema";
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { EngineStatus, PickInfo, QualityTier } from "./engine.ts";

export interface LayerUiState extends LayerState {
  enabled: boolean;
}

/** The hover tag: where it is, and what it says once the worker has answered. */
export interface HoverState extends PickInfo {
  title?: string;
  /** One formatted number, e.g. "10,972". */
  value?: string;
  unit?: string;
}

/** A downsampled history of the selection, for the detail panel's sparkline. */
export interface TrackSeries {
  /** What `values` measures: altitude in metres or speed over ground in m/s. */
  measure: "altitude" | "speed";
  timesMs: number[];
  values: number[];
}

export type Overlay = "none" | "attribution" | "shortcuts";

/** Phases of the opening shot. */
export type IntroPhase = "stars" | "globe" | "arrive" | "done";

export interface HaloState {
  layers: Record<LayerId, LayerUiState>;
  selection: EntityRef | null;
  /** Detail for the selection; null while loading or when nothing is selected. */
  detail: EntityDetail | null;
  detailStatus: "idle" | "loading" | "ready" | "missing";
  following: boolean;
  /** The 3D view: the camera rides behind the selected aircraft. Implies `following`. */
  chase: boolean;
  hover: HoverState | null;
  /** History of the selection for the sparkline, or null when there is none. */
  trackSeries: TrackSeries | null;
  /** Why the globe could not start, in one plain sentence; null when it did. */
  startError: string | null;
  /** The engine's own health: base map and graphics context. Null until it exists. */
  engineStatus: EngineStatus | null;
  clock: ClockState;
  /** Range the time tape can reach, or null before any history exists. */
  history: { fromMs: number; toMs: number } | null;
  view: ViewState | null;
  /** Newest first, capped. */
  events: HaloEvent[];
  intro: IntroPhase;
  /** True after a while without input: the HUD fades out. */
  idle: boolean;
  overlay: Overlay;
  searchOpen: boolean;
  sound: boolean;
  reducedMotion: boolean;
  quality: QualityTier;
  fps: number;
  /** False when the realtime gateway cannot be reached. */
  gatewayOnline: boolean;
  /**
   * How much of the bottom edge the HUD covers on a phone (the detail sheet at
   * its current stop), in CSS pixels; null when the default layout applies.
   * The camera frames above it and the on-map credits sit clear of it.
   */
  bottomInset: number | null;
}

export interface HaloActions {
  toggleLayer(layer: LayerId): void;
  setLayerEnabled(layer: LayerId, enabled: boolean): void;
  setLayerState(layer: LayerId, state: LayerState): void;
  /** Select an object (or clear with null). The controller flies there and loads detail. */
  select(ref: EntityRef | null): void;
  setDetail(detail: EntityDetail | null, status: HaloState["detailStatus"]): void;
  setFollowing(following: boolean): void;
  /** Ride behind the selected aircraft or ship (or stop). Only those can be chased. */
  setChase(chase: boolean): void;
  setHover(hover: HoverState | null): void;
  setTrackSeries(series: TrackSeries | null): void;
  setStartError(message: string | null): void;
  setEngineStatus(status: EngineStatus | null): void;
  /** Scrub to a moment in the buffered history. */
  scrubTo(timeMs: number): void;
  goLive(): void;
  /** Advance the live clock; called by the controller about once a second. */
  tick(nowMs: number): void;
  setHistory(history: HaloState["history"]): void;
  setView(view: ViewState): void;
  pushEvents(events: HaloEvent[]): void;
  setIntro(phase: IntroPhase): void;
  setIdle(idle: boolean): void;
  setOverlay(overlay: Overlay): void;
  setSearchOpen(open: boolean): void;
  setSound(on: boolean): void;
  setReducedMotion(reduced: boolean): void;
  setQuality(quality: QualityTier): void;
  setFps(fps: number): void;
  setGatewayOnline(online: boolean): void;
  setBottomInset(pixels: number | null): void;
  /** Open a search result: select the entity or fly to the place. */
  openResult(result: SearchResult): void;
}

export type HaloStore = HaloState & { actions: HaloActions };

const MAX_EVENTS = 40;

export function defaultLayers(): Record<LayerId, LayerUiState> {
  const layers = {} as Record<LayerId, LayerUiState>;
  for (const def of LAYERS) {
    layers[def.id] = {
      enabled: def.defaultOn,
      status: def.defaultOn ? "loading" : "off",
      count: null,
    };
  }
  return layers;
}

/**
 * Requests the HUD makes that the controller carries out (camera moves).
 * Kept out of the state so components do not re-render on them.
 */
export type Intent =
  | { type: "fly"; lon: number; lat: number; zoom?: number }
  | { type: "fly-entity"; ref: EntityRef }
  | { type: "reset-north" }
  | { type: "zoom"; delta: number }
  | { type: "home" };

const intentListeners = new Set<(intent: Intent) => void>();

/** HUD side: ask the controller to do something to the camera. */
export function sendIntent(intent: Intent): void {
  for (const listener of intentListeners) listener(intent);
}

/** Controller side. Returns an unsubscribe function. */
export function onIntent(listener: (intent: Intent) => void): () => void {
  intentListeners.add(listener);
  return () => intentListeners.delete(listener);
}

export const useHalo = create<HaloStore>()(
  subscribeWithSelector((set, get) => ({
    layers: defaultLayers(),
    selection: null,
    detail: null,
    detailStatus: "idle",
    following: false,
    chase: false,
    hover: null,
    trackSeries: null,
    startError: null,
    engineStatus: null,
    clock: { mode: "live", timeMs: Date.now() },
    history: null,
    view: null,
    events: [],
    intro: "stars",
    idle: false,
    overlay: "none",
    searchOpen: false,
    sound: false,
    reducedMotion: false,
    quality: "high",
    fps: 0,
    gatewayOnline: false,
    bottomInset: null,

    actions: {
      toggleLayer: (layer) => get().actions.setLayerEnabled(layer, !get().layers[layer].enabled),
      setLayerEnabled: (layer, enabled) =>
        set((s) => {
          const current = s.layers[layer];
          if (current.enabled === enabled) return s;
          return {
            layers: {
              ...s.layers,
              [layer]: {
                ...current,
                enabled,
                status: enabled ? "loading" : "off",
                message: undefined,
              },
            },
          };
        }),
      setLayerState: (layer, state) =>
        set((s) => ({
          layers: { ...s.layers, [layer]: { ...state, enabled: s.layers[layer].enabled } },
        })),
      select: (ref) =>
        set((s) => {
          const same =
            ref && s.selection && ref.kind === s.selection.kind && ref.id === s.selection.id;
          if (same) return s;
          return {
            selection: ref,
            detail: null,
            detailStatus: ref ? "loading" : "idle",
            following: false,
            chase: false,
            trackSeries: null,
          };
        }),
      setDetail: (detail, status) => set({ detail, detailStatus: status }),
      setFollowing: (following) => {
        const on = following && get().selection !== null;
        // Letting go of the object ends the 3D view with it.
        set(on ? { following: true } : { following: false, chase: false });
      },
      setChase: (chase) => {
        const kind = get().selection?.kind;
        const on = chase && (kind === EntityKind.Aircraft || kind === EntityKind.Ship);
        set(on ? { chase: true, following: true } : { chase: false });
      },
      setHover: (hover) => set({ hover }),
      setTrackSeries: (trackSeries) => set({ trackSeries }),
      setStartError: (startError) => set({ startError }),
      setEngineStatus: (engineStatus) => set({ engineStatus }),
      scrubTo: (timeMs) => {
        const { history } = get();
        if (!history) return;
        const clamped = Math.min(Math.max(timeMs, history.fromMs), history.toMs);
        set({ clock: { mode: "scrub", timeMs: clamped } });
      },
      goLive: () => set({ clock: { mode: "live", timeMs: Date.now() } }),
      tick: (nowMs) => {
        if (get().clock.mode === "live") set({ clock: { mode: "live", timeMs: nowMs } });
      },
      setHistory: (history) => set({ history }),
      setView: (view) => set({ view }),
      pushEvents: (events) =>
        set((s) => {
          if (events.length === 0) return s;
          const seen = new Set(events.map((e) => e.id));
          const merged = [...events, ...s.events.filter((e) => !seen.has(e.id))];
          merged.sort((a, b) => b.timeMs - a.timeMs);
          return { events: merged.slice(0, MAX_EVENTS) };
        }),
      setIntro: (intro) => set({ intro }),
      setIdle: (idle) => set({ idle }),
      setOverlay: (overlay) => set({ overlay }),
      setSearchOpen: (searchOpen) => set({ searchOpen }),
      setSound: (sound) => set({ sound }),
      setReducedMotion: (reducedMotion) => set({ reducedMotion }),
      setQuality: (quality) => set({ quality }),
      setFps: (fps) => set({ fps }),
      setGatewayOnline: (gatewayOnline) => set({ gatewayOnline }),
      setBottomInset: (pixels) =>
        set({ bottomInset: pixels === null ? null : Math.max(0, Math.round(pixels)) }),
      openResult: (result) => {
        if (result.type === "entity" && result.ref) {
          if (result.layer) get().actions.setLayerEnabled(result.layer, true);
          get().actions.select(result.ref);
        } else {
          sendIntent({ type: "fly", lon: result.lon, lat: result.lat, zoom: result.zoom });
        }
        set({ searchOpen: false });
      },
    },
  })),
);

/** Stable reference to the actions, for use outside React and in event handlers. */
export const haloActions = (): HaloActions => useHalo.getState().actions;
