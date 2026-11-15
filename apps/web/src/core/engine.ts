/**
 * The rendering engine's public face.
 *
 * `src/engine` implements this with MapLibre and deck.gl. Nothing outside
 * `src/engine` imports either library: the HUD and the app controller talk to
 * the globe only through `HaloEngine`, which keeps React out of the render
 * loop and keeps the map libraries in their own lazy chunk.
 */
import type {
  ClockState,
  DensityGrid,
  EntityRef,
  LayerId,
  Attribution,
  PathSet,
  RenderBatch,
  TileOverlay,
  Track,
  ViewState,
} from "@orya-halo/schema";

export interface CameraTarget {
  lon: number;
  lat: number;
  zoom?: number;
  bearing?: number;
  pitch?: number;
}

export interface FlyOptions {
  /** Milliseconds. Defaults to a duration scaled by distance. */
  durationMs?: number;
  /** Skip the animation (used for reduced motion and the first frame). */
  instant?: boolean;
}

/** How much the renderer spends per frame. The engine may lower it itself. */
export type QualityTier = "high" | "balanced" | "low";

export interface PickInfo {
  ref: EntityRef;
  layer: LayerId;
  /** Short label for the hover tag, when the engine already knows one. */
  label?: string;
  /** Screen position in CSS pixels, relative to the engine's container. */
  x: number;
  y: number;
  lon: number;
  lat: number;
}

/** What the engine can tell the app about its own health. */
export interface EngineStatus {
  /**
   * `full`: street-level tiles are available. `low-zoom`: only the bundled
   * whole-world extract. `missing`: no tiles at all; the globe is a plain
   * dark sphere under the sky, the night side and the data layers.
   */
  basemap: "full" | "low-zoom" | "missing";
  /** `context-lost` while the browser has taken the WebGL context away. */
  graphics: "ok" | "context-lost";
  /** One plain sentence for the person looking at the globe; absent when all is well. */
  message?: string;
  /** What whoever runs this copy of the app can do about it. */
  hint?: string;
}

export interface EngineEvents {
  /** Camera settled after a move. Throttled; not per frame. */
  view: ViewState;
  /** Click or tap on an object (or on nothing: null). */
  pick: PickInfo | null;
  /** Pointer resting on an object (or leaving it: null). */
  hover: PickInfo | null;
  /** Double-click or double-tap on the globe: dive towards this point. */
  dive: { lon: number; lat: number };
  /** Any direct manipulation of the globe. Cancels follow mode and idle orbit. */
  interact: undefined;
  /** Frames per second over the last second, for the dev overlay. */
  fps: number;
  /** The engine changed quality tier to protect the frame rate. */
  quality: QualityTier;
  /** First frame with the globe visible. */
  ready: undefined;
  /** The base map or the graphics context changed state. */
  status: EngineStatus;
}

export interface EngineOptions {
  container: HTMLElement;
  /** Camera to start from. */
  initialView?: CameraTarget;
  reducedMotion: boolean;
  quality: QualityTier;
  /** Base URL for static assets (tiles, textures). */
  assetBase: string;
  /** Layers visible on the first frame. */
  layers: Record<LayerId, boolean>;
}

export interface HaloEngine {
  /** Data in. Each call replaces what the engine holds for that kind or layer. */
  setBatch(batch: RenderBatch): void;
  setDensity(grid: DensityGrid): void;
  setPaths(layer: LayerId, paths: PathSet): void;
  setTiles(layer: LayerId, overlay: TileOverlay | null): void;
  /** Recorded and live track of the selected object; null clears it. */
  setTrack(track: Track | null): void;

  setLayerVisible(layer: LayerId, visible: boolean): void;
  /** The moment to render. In `live` mode the engine advances time itself. */
  setClock(clock: ClockState): void;
  /** Draw the selection reticle on this object; null clears it. */
  setSelection(ref: EntityRef | null): void;
  /** Keep the camera locked on the selection until the person moves the globe. */
  setFollowing(following: boolean): void;
  setQuality(tier: QualityTier): void;
  setReducedMotion(reduced: boolean): void;
  /** Slow automatic rotation, for the opening shot and idle mode. */
  setOrbiting(orbiting: boolean): void;
  /**
   * Credits for the data layers currently shown, drawn in the on-map
   * attribution next to the base map's own. They stay visible when the HUD
   * fades, because several licences require credit on the map itself.
   */
  setCredits(credits: Attribution[]): void;
  /** Insets (CSS px) covered by HUD panels, so targets centre in the clear area. */
  setPadding(padding: { top: number; right: number; bottom: number; left: number }): void;

  /** Glide the camera. Resolves when the move ends or is interrupted. */
  flyTo(target: CameraTarget, options?: FlyOptions): Promise<void>;
  /** Glide to an entity's current position and frame it. */
  flyToEntity(ref: EntityRef, options?: FlyOptions): Promise<void>;
  getView(): ViewState;
  getStatus(): EngineStatus;
  /** Where the entity is drawn right now, or null if it is not loaded. */
  locate(ref: EntityRef): { lon: number; lat: number; alt: number } | null;
  /** Screen position of a coordinate, or null when it is behind the globe. */
  project(lon: number, lat: number, alt?: number): { x: number; y: number } | null;

  on<K extends keyof EngineEvents>(
    type: K,
    handler: (payload: EngineEvents[K]) => void,
  ): () => void;
  destroy(): void;
}

/** Implemented by `src/engine/index.ts` and loaded with a dynamic import. */
export type CreateEngine = (options: EngineOptions) => Promise<HaloEngine>;
