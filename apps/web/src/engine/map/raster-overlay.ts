/**
 * One raster overlay (rain radar, satellite imagery) on the map.
 *
 * An animated overlay has a frame per moment; the time scrubber walks
 * through them. Only the frame being shown is ever requested: providers
 * count requests per address (RainViewer: 100 a minute), and thirteen frames
 * of a screenful of tiles each would spend that in one drag of the tape.
 *
 * Two MapLibre raster sources take turns. The new frame loads into the one
 * that is hidden, and when its tiles are in, the two cross-fade. While the
 * scrubber is moving, nothing is requested until it has rested on a frame
 * for a moment, and never more than one frame is in flight.
 *
 * `maxzoom` on the source is what keeps a provider's deepest zoom honoured:
 * past it MapLibre stretches the deepest tiles it has instead of asking for
 * ones that do not exist.
 */
import type { TileOverlay } from "@orya-halo/schema";
import type { Map as MapLibreMap, MapSourceDataEvent, RasterTileSource } from "maplibre-gl";

/** The tape must rest on a frame this long before its tiles are requested. */
export const FRAME_DWELL_MS = 220;
/** Give up waiting for a frame's tiles after this long and show what has arrived. */
export const FRAME_TIMEOUT_MS = 6000;
/** Cross-fade between frames. */
export const FRAME_FADE_MS = 260;

/**
 * Decides when a wanted frame may start loading. Pure: the caller tells it
 * the time, so it can be tested without a map.
 */
export class FrameSwitcher {
  /** What is on screen ("" before the first frame). */
  front = "";
  /** What is loading into the hidden source, if anything. */
  loading: string | null = null;
  private loadingSince = 0;
  private wanted = "";
  private wantedSince = 0;
  private readonly dwellMs: number;
  private readonly timeoutMs: number;

  constructor(dwellMs = FRAME_DWELL_MS, timeoutMs = FRAME_TIMEOUT_MS) {
    this.dwellMs = dwellMs;
    this.timeoutMs = timeoutMs;
  }

  /** The frame the clock asks for now. */
  want(key: string, nowMs: number): void {
    if (key === this.wanted) return;
    this.wanted = key;
    this.wantedSince = nowMs;
  }

  /** True while there is something left to do, so the caller keeps polling. */
  get busy(): boolean {
    return this.loading !== null || (this.wanted !== "" && this.wanted !== this.front);
  }

  /** The frame to start loading now, or null. Call once per animation frame while `busy`. */
  next(nowMs: number): string | null {
    if (this.loading !== null || this.wanted === this.front || this.wanted === "") return null;
    // The first frame has nothing to wait behind.
    if (this.front !== "" && nowMs - this.wantedSince < this.dwellMs) return null;
    this.loading = this.wanted;
    this.loadingSince = nowMs;
    return this.loading;
  }

  /** True when the frame in flight has taken too long and should be shown as it is. */
  timedOut(nowMs: number): boolean {
    return this.loading !== null && nowMs - this.loadingSince > this.timeoutMs;
  }

  /** The frame in flight is ready (or has timed out): it becomes the one on screen. */
  settle(): string {
    if (this.loading !== null) {
      this.front = this.loading;
      this.loading = null;
    }
    return this.front;
  }

  /** The frame in flight was abandoned; it will be asked for again. */
  abandon(): void {
    this.loading = null;
  }

  /** Nothing is on screen any more, e.g. the sources were rebuilt. What is wanted is kept. */
  clear(): void {
    this.front = "";
    this.loading = null;
  }
}

const SLOTS = ["a", "b"] as const;

export interface RasterOverlayOptions {
  /** Unique within the map, e.g. the layer id. */
  name: string;
  /** The style layer to insert beneath, or undefined for the top. Asked for whenever layers are added. */
  before: () => string | undefined;
  visible: boolean;
  reducedMotion: boolean;
}

/** Drives the two sources and their cross-fade for one overlay. */
export class RasterOverlay {
  private readonly map: MapLibreMap;
  private readonly name: string;
  private readonly before: () => string | undefined;
  private overlay: TileOverlay;
  private visible: boolean;
  private fadeMs: number;
  private readonly switcher = new FrameSwitcher();
  /** Which of the two sources is on screen. */
  private frontSlot = 0;
  private tiles: string[] = [];
  private built = false;
  /** When the source that has just faded out can be switched off, or null. */
  private retireAt: number | null = null;

  private readonly onSourceData = (e: MapSourceDataEvent): void => {
    // Only a tile arriving says anything: the source also reports when its
    // description changes, before a single tile has been asked for.
    if (!e.tile || this.switcher.loading === null) return;
    const back = this.sourceId(1 - this.frontSlot);
    if (e.sourceId === back && this.map.isSourceLoaded(back)) this.swap(performance.now());
  };

  /** Nothing left to load anywhere on the map, so the frame in flight is in (or needed no tiles). */
  private readonly onIdle = (): void => {
    if (this.switcher.loading !== null) this.swap(performance.now());
  };

  constructor(map: MapLibreMap, overlay: TileOverlay, options: RasterOverlayOptions) {
    this.map = map;
    this.overlay = overlay;
    this.name = options.name;
    this.before = options.before;
    this.visible = options.visible;
    this.fadeMs = options.reducedMotion ? 0 : FRAME_FADE_MS;
  }

  private sourceId(slot: number): string {
    return `halo-raster-${this.name}-${SLOTS[slot]}`;
  }

  /** Style layer ids, bottom first. */
  get layerIds(): string[] {
    return SLOTS.map((_, slot) => this.sourceId(slot));
  }

  /** The overlay as last described. */
  get description(): TileOverlay {
    return this.overlay;
  }

  private get opacity(): number {
    return Math.min(Math.max(this.overlay.opacity, 0), 1);
  }

  /**
   * Replace the overlay's description. A refreshed frame list keeps the
   * sources and the tiles they hold; a different tile grid starts again.
   */
  update(overlay: TileOverlay): void {
    const sameGrid =
      overlay.tileSize === this.overlay.tileSize &&
      overlay.minZoom === this.overlay.minZoom &&
      overlay.maxZoom === this.overlay.maxZoom;
    this.overlay = overlay;
    if (!sameGrid) this.remove();
    else if (this.built && this.map.getLayer(this.sourceId(this.frontSlot)))
      this.map.setPaintProperty(this.sourceId(this.frontSlot), "raster-opacity", this.opacity);
  }

  /** Show `tiles` (a frame's URL templates). Call whenever the clock or the overlay changes. */
  show(tiles: string[], nowMs: number): void {
    if (tiles.length === 0) return;
    this.tiles = tiles;
    this.switcher.want(tiles[0], nowMs);
    this.tick(nowMs);
  }

  /** True while a frame is waiting, loading or fading; `tick` wants calling each animation frame. */
  get busy(): boolean {
    return this.visible && (this.switcher.busy || this.retireAt !== null);
  }

  tick(nowMs: number): void {
    // A hidden overlay requests nothing; it catches up when it is shown.
    if (!this.visible) return;
    if (this.retireAt !== null) {
      if (nowMs < this.retireAt) return;
      this.retireAt = null;
      const back = this.sourceId(1 - this.frontSlot);
      // Out of the style, so it stops asking for tiles as the camera moves.
      if (this.map.getLayer(back)) this.map.setLayoutProperty(back, "visibility", "none");
    }
    if (this.switcher.timedOut(nowMs)) this.swap(nowMs);
    if (this.switcher.next(nowMs) === null) return;
    if (!this.built) {
      // First frame: straight into the front source, no cross-fade to wait for.
      this.build(this.tiles);
      this.switcher.settle();
      return;
    }
    const id = this.sourceId(1 - this.frontSlot);
    const back = this.map.getSource(id) as RasterTileSource | undefined;
    if (!back || !this.map.getLayer(id)) {
      this.switcher.settle();
      return;
    }
    back.setTiles(this.tiles);
    this.map.setLayoutProperty(id, "visibility", "visible");
    this.map.once("idle", this.onIdle);
  }

  private build(tiles: string[]): void {
    const { map, overlay } = this;
    this.strip();
    this.frontSlot = 0;
    const before = this.before();
    SLOTS.forEach((_, slot) => {
      const id = this.sourceId(slot);
      map.addSource(id, {
        type: "raster",
        tiles,
        tileSize: overlay.tileSize,
        minzoom: overlay.minZoom,
        maxzoom: overlay.maxZoom,
      });
      map.addLayer(
        {
          id,
          type: "raster",
          source: id,
          // The second source stays out of the style until a second frame is
          // wanted, so a still overlay never loads its tiles twice.
          layout: { visibility: this.visible && slot === 0 ? "visible" : "none" },
          paint: {
            "raster-opacity": slot === 0 ? this.opacity : 0,
            "raster-opacity-transition": { duration: this.fadeMs, delay: 0 },
            "raster-fade-duration": this.fadeMs,
          },
        },
        before,
      );
    });
    map.on("sourcedata", this.onSourceData);
    this.built = true;
  }

  /** The hidden source has its tiles: fade it in and the old frame out. */
  private swap(nowMs: number): void {
    if (this.switcher.loading === null) return;
    const { map } = this;
    map.off("idle", this.onIdle);
    const front = this.sourceId(this.frontSlot);
    const back = this.sourceId(1 - this.frontSlot);
    this.switcher.settle();
    if (!map.getLayer(front) || !map.getLayer(back)) return;
    map.setPaintProperty(back, "raster-opacity", this.opacity);
    map.setPaintProperty(front, "raster-opacity", 0);
    this.frontSlot = 1 - this.frontSlot;
    this.retireAt = nowMs + this.fadeMs + 60;
  }

  setVisible(visible: boolean, nowMs: number): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (this.built) {
      const front = this.sourceId(this.frontSlot);
      const back = this.sourceId(1 - this.frontSlot);
      if (this.map.getLayer(front))
        this.map.setLayoutProperty(front, "visibility", visible ? "visible" : "none");
      // Whatever the other source was doing, it is done: a frame cut off
      // mid-load is asked for again when the overlay comes back.
      if (!visible && this.map.getLayer(back)) {
        this.map.setLayoutProperty(back, "visibility", "none");
        this.map.setPaintProperty(back, "raster-opacity", 0);
        this.map.off("idle", this.onIdle);
        this.switcher.abandon();
        this.retireAt = null;
      }
    }
    if (visible) this.tick(nowMs);
  }

  setReducedMotion(reduced: boolean): void {
    this.fadeMs = reduced ? 0 : FRAME_FADE_MS;
    if (!this.built) return;
    for (const id of this.layerIds) {
      if (!this.map.getLayer(id)) continue;
      this.map.setPaintProperty(id, "raster-opacity-transition", {
        duration: this.fadeMs,
        delay: 0,
      });
      this.map.setPaintProperty(id, "raster-fade-duration", this.fadeMs);
    }
  }

  /** Take the sources and layers off the map. The next `show` or `tick` builds them again. */
  remove(): void {
    this.strip();
    this.switcher.clear();
  }

  /** Sources, layers and listeners off the map; what is wanted and what was shown are left alone. */
  private strip(): void {
    const { map } = this;
    map.off("sourcedata", this.onSourceData);
    map.off("idle", this.onIdle);
    for (const id of this.layerIds) {
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
    }
    this.built = false;
    this.retireAt = null;
  }

  /**
   * The style these sources lived in is gone (the map lost its WebGL
   * context): stop listening and remember nothing is on the map. Touches no
   * style, because there is none to touch.
   */
  forget(): void {
    this.map.off("sourcedata", this.onSourceData);
    this.map.off("idle", this.onIdle);
    this.built = false;
    this.retireAt = null;
    this.switcher.clear();
  }

  /**
   * The style was rebuilt underneath (the WebGL context came back): drop
   * whatever came back with it and put the current frame up again.
   */
  rebuild(nowMs: number): void {
    this.remove();
    this.tick(nowMs);
  }
}
