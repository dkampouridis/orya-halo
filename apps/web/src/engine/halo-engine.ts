/**
 * The engine: a MapLibre globe with deck.gl data layers over it.
 *
 * Two canvases, on purpose. MapLibre owns the base map, the sky and the
 * day/night shading and repaints only when the camera or the sun moves.
 * deck.gl owns a transparent canvas above it and repaints every frame, which
 * costs one instanced draw call per kind because all motion is in the vertex
 * shader. A static camera therefore never re-rasterises the map.
 */
import {
  _GlobeView as GlobeView,
  _GlobeViewport as GlobeViewport,
  WebMercatorViewport,
} from "@deck.gl/core";
import type { Layer, PickingInfo } from "@deck.gl/core";
import { PathLayer } from "@deck.gl/layers";
import { MapboxOverlay } from "@deck.gl/mapbox";
import {
  HorizonExtension,
  MarkersLayer,
  MoversLayer,
  ReticleLayer,
  createReticle,
  globeCommon,
  haloVisibility,
  AircraftModelsLayer,
  prepareAircraftMeshes,
  warmAircraftModelsLayer,
  ShipModelsLayer,
  prepareVesselMeshes,
  shipModelOf,
  warmShipModelsLayer,
  markersFromBatch,
  markersFromDensity,
  moverGlyphScale,
  sizeAtZoom,
} from "@orya-halo/layers";
import type { MarkerMode, MoverGlyph, Reticle } from "@orya-halo/layers";
import {
  EntityKind,
  aircraftModel,
  genericAircraftModel,
  LAYERS,
  MOTION_SIZE,
  STYLE_SIZE,
  createRenderBatch,
  extrapolate,
  hexToRgb,
  indexOfId,
  layerDef,
  layerForKind,
} from "@orya-halo/schema";
import type {
  Attribution,
  ClockState,
  DensityGrid,
  EntityRef,
  LayerId,
  PathSet,
  RenderBatch,
  TileOverlay,
  Track,
  ViewState,
} from "@orya-halo/schema";
import { Map as MapLibreMap, addProtocol, removeProtocol, setWorkerUrl } from "maplibre-gl";
import type { MapMouseEvent } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import type {
  CameraTarget,
  EngineEvents,
  EngineOptions,
  FlyOptions,
  HaloEngine,
  PickInfo,
  QualityTier,
} from "../core/engine.ts";
import {
  FADE_MS,
  GLOBE_MAX_ZOOM,
  chaseCamera,
  approach,
  flyDurationMs,
  followCentre,
  framingZoom,
  globeFitsView,
  normaliseBounds,
  orbitRate,
} from "./camera.ts";
import type { Insets } from "./camera.ts";
import { CreditLine, mergeCredits } from "./credits.ts";
import type { Credit } from "./credits.ts";
import { Emitter } from "./emitter.ts";
import "./engine.css";
import { RasterOverlay } from "./map/raster-overlay.ts";
import { EARTH, buildStyle } from "./map/style.ts";
import { BASEMAP_CREDITS, TILE_PROTOCOL, createTileSetup, joinAsset } from "./map/tiles.ts";
import type { TileSetup } from "./map/tiles.ts";
import { clamp, wrapLon } from "./maths.ts";
import { overlayTiles } from "./overlays.ts";
import { piecesOf, preparePaths } from "./paths.ts";
import type { PreparedPaths } from "./paths.ts";
import { QUALITY, QualityGovernor, RefreshRateEstimate, costlier } from "./quality.ts";
import { describeStatus } from "./status.ts";
import type { EngineStatus } from "./status.ts";
import { sunDirection } from "./sky/solar.ts";
import { SpaceLayer } from "./sky/space-layer.ts";
import type { SpaceLayerState } from "./sky/space-layer.ts";

type Rgb = [number, number, number];

/** deck.gl's binary form of a set of paths. */
interface BinaryPaths {
  length: number;
  startIndices: Uint32Array;
  attributes: { getPath: { value: Float32Array; size: number } };
}

function binaryPaths(prepared: PreparedPaths): BinaryPaths {
  return {
    length: prepared.length,
    startIndices: prepared.startIndices,
    attributes: { getPath: { value: prepared.positions, size: prepared.size } },
  };
}

/** `--halo`: the ring colour for selection and hover. A design token, not a layer colour. */
const HALO: Rgb = hexToRgb("#bcd9ff");
const RIM: Rgb = hexToRgb(EARTH.rim);
const LIGHTS_TEXTURE = "textures/black-marble-2016-01deg-gray.jpg";
/** The same lights at 8192 x 4096 (about 5 km a pixel), for desktop GPUs; see SpaceLayer. */
const LIGHTS_TEXTURE_HD = "textures/black-marble-2016-8k-gray.jpg";
/** NASA asks to be acknowledged as the source of the Black Marble night lights (see scripts/fetch-textures.mjs). */
const LIGHTS_CREDIT: Credit = {
  text: "Night lights: NASA Earth Observatory",
  url: "https://science.nasa.gov/earth/earth-observatory/earth-at-night/maps/",
};
/** NASA asks GIBS users to acknowledge it; the imagery is Blue Marble (see map/style.ts). */
const IMAGERY_CREDIT: Credit = {
  text: "Imagery: NASA Blue Marble, GIBS",
  url: "https://nasa-gibs.github.io/gibs-api-docs/",
};
const DEG = Math.PI / 180;

/** A 40 m airliner's model is drawn this long while its true size is smaller; none is shorter than the minimum. */
const MODEL_TARGET_PX: [number, number] = [26, 48];
const MODEL_MIN_PX: [number, number] = [14, 22];
/** Zoom range over which models grow from the first to the second of those sizes. */
const MODEL_SIZE_ZOOM: [number, number] = [5.6, 9];

/**
 * deck.gl's near plane, in viewport heights from the camera (its default is
 * 0.5, which cut away aircraft flying high under a tilted camera). Closer
 * costs depth precision: at the 3D view's distance the chased aircraft is a
 * few hundred metres away and needs the closest; elsewhere that would leave
 * models kilometres away with too little depth to tell wing from fuselage.
 */
const NEAR_Z_MULTIPLIER = 0.02;
const NEAR_Z_MULTIPLIER_CHASE = 0.001;

/**
 * The 3D view. The camera looks down at CHASE_PITCH degrees along the
 * aircraft's track, turned CHASE_SIDE_DEG off it for a three-quarter view,
 * CHASE_DISTANCE_PER_SIZE times the aircraft's size behind it (so every type
 * fills about the same share of the screen). It eases to that pose with
 * this half-life.
 */
const CHASE_PITCH = 76;
const CHASE_SIDE_DEG = -22;
const CHASE_DISTANCE_PER_SIZE = 4.5;
const CHASE_EASE_MS = 450;
/** While a hand is on the 3D view, the camera follows it this quickly. */
const CHASE_DRAG_EASE_MS = 60;
/** How far the wheel can pull the 3D view's camera back, as a multiple of its starting distance. */
const CHASE_ZOOM_MAX = 50;
/** Pitch the 3D view can be dragged between: nearly straight down to nearly level. */
const CHASE_PITCH_RANGE: [number, number] = [12, 82];
/**
 * On deck.gl's globe a vertex is stored relative to the Earth's centre in
 * 32-bit floats, about 0.75 m apart: a 1.7 m fuselage seen from 70 m away
 * comes out jagged. So the chased aircraft is drawn at least this long, and
 * the camera stands back by the same factor: the same picture on screen,
 * with the rounding a fraction of a pixel.
 */
const CHASE_MIN_DRAWN_M = 260;
/** MapLibre's own pitch limit outside the 3D view. */
const MAX_PITCH = 70;

/**
 * Zoom range over which aircraft turn from flat glyphs into 3D models of
 * their types: the glyph fades out as the model fades in.
 */
const MODEL_ZOOM: [number, number] = [5.6, 6.6];

/**
 * Zoom range over which ships turn from flat glyphs into 3D models of their
 * kinds. Later than aircraft: ships crowd coasts and ports, and below this
 * a model is a handful of pixels, no more telling than the glyph.
 */
const SHIP_MODEL_ZOOM: [number, number] = [7.5, 8.5];
/** The ship glyph's sizes grow with this ease, as the movers layer's default does. */
const SHIP_GLYPH_EASE = 1.6;

/** Smallest ring diameters, pixels; rings grow to clear larger silhouettes. */
const HOVER_RING_PX = 18;
const SELECT_RING_PX = 28;
const RING_MAX_PX = 96;

/** Narrower than this, the HUD stacks along the bottom edge (DESIGN.md, "Phones"). */
const PHONE_WIDTH = 720;

const accent = (id: LayerId): Rgb => hexToRgb(layerDef(id).accent);
const unit = (c: Rgb): Rgb => [c[0] / 255, c[1] / 255, c[2] / 255];

interface MoverStyle {
  glyph: MoverGlyph;
  sizePixels: [number, number];
  sizeZoomRange: [number, number];
  tailSeconds: number;
  tailMinPixels: number;
  tailMaxPixels: number;
  referenceSpeed: number;
  /** 1 draws objects at their true height above the globe, 0 on the surface. */
  altitudeScale: number;
  /** How much to dim objects at the limb; 0 for things that orbit above it. */
  limbFade: number;
  /** Far view: brightness of the brightest points, and of the dimmest as a share of that. */
  farGain: number;
  farDim: number;
  /** Far view: radius of a point of light, pixels. */
  farPointPixels: number;
  /** Far view: how much objects seen against space, past the limb, are dimmed. */
  spaceDim: number;
}

/** How each moving kind is drawn. Colours come from the layer registry. */
const MOVERS: Partial<Record<EntityKind, MoverStyle>> = {
  [EntityKind.Aircraft]: {
    glyph: "aircraft",
    // Silhouettes need more pixels than arrows did to read as what they are.
    sizePixels: [1.15, 12],
    sizeZoomRange: [1.6, 8.5],
    tailSeconds: 75,
    tailMinPixels: 9,
    tailMaxPixels: 64,
    referenceSpeed: 250,
    altitudeScale: 1,
    limbFade: 0.7,
    farGain: 0.78,
    farDim: 0.24,
    farPointPixels: 0.95,
    spaceDim: 0,
  },
  [EntityKind.Ship]: {
    glyph: "ship",
    // Close in, ships whose length is known grow past this to their true size.
    sizePixels: [1.1, 14],
    sizeZoomRange: [1.8, 9],
    tailSeconds: 600,
    tailMinPixels: 5,
    tailMaxPixels: 40,
    referenceSpeed: 12,
    altitudeScale: 0,
    limbFade: 0.7,
    farGain: 0.7,
    farDim: 0.26,
    farPointPixels: 0.9,
    spaceDim: 0,
  },
  [EntityKind.Satellite]: {
    glyph: "satellite",
    sizePixels: [1.2, 10],
    sizeZoomRange: [1.5, 6.5],
    // No tail: behind a satellite's panels it turned the icon into a T, and
    // satellites visibly cross the screen without one.
    tailSeconds: 10,
    tailMinPixels: 0,
    tailMaxPixels: 0,
    referenceSpeed: 7600,
    altitudeScale: 1,
    limbFade: 0,
    // Satellites are the quietest layer from afar: a faint dust of points
    // round the planet, fainter still where they hang against space.
    farGain: 0.8,
    farDim: 0.22,
    farPointPixels: 0.85,
    spaceDim: 0.4,
  },
};

interface MarkerStyle {
  mode: MarkerMode;
  sizePixels: number;
  /** The batch's values are zoom ranks: each mark appears from its own zoom. */
  zoomRank?: boolean;
}

const MARKERS: Partial<Record<EntityKind, MarkerStyle>> = {
  [EntityKind.Quake]: { mode: "ripple", sizePixels: 12 },
  // Webcam sources rank every camera by how crowded its surroundings are.
  [EntityKind.Webcam]: { mode: "beacon", sizePixels: 7, zoomRank: true },
  [EntityKind.Fire]: { mode: "ember", sizePixels: 3.6 },
};

/** Draw order, bottom to top. */
const MARKER_ORDER: readonly EntityKind[] = [EntityKind.Fire, EntityKind.Webcam, EntityKind.Quake];
const MOVER_ORDER: readonly EntityKind[] = [
  EntityKind.Ship,
  EntityKind.Aircraft,
  EntityKind.Satellite,
];

/** Approximate H3 cell edge length in metres by resolution, for sizing density blobs. */
const H3_EDGE_M = [1_281_000, 483_000, 183_000, 69_000, 26_000, 9_900, 3_700];

/**
 * deck.gl draw state shared by the Orya Halo layers. They are drawn in order
 * with no depth test and output premultiplied colour, so a fragment can add
 * light without covering what is under it (alpha 0, colour above 0): that is
 * how glows and the density underlay build up.
 */
const GLOW_PARAMETERS = {
  depthCompare: "always",
  depthWriteEnabled: false,
  cullMode: "none",
  blend: true,
  // luma.gl only applies blend factors when an operation is named alongside them.
  blendColorOperation: "add",
  blendAlphaOperation: "add",
  blendColorSrcFactor: "one",
  blendColorDstFactor: "one-minus-src-alpha",
  blendAlphaSrcFactor: "one",
  blendAlphaDstFactor: "one-minus-src-alpha",
} as const;

const FLAT_PARAMETERS = {
  depthCompare: "always",
  depthWriteEnabled: false,
  cullMode: "none",
} as const;

const HOVER_PICK_INTERVAL_MS = 70;
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_PX = 28;
const SELECT_DRAW_MS = 240;
/** The terminator creeps a quarter of a degree a minute; repainting the map this often keeps it current. */
const SKY_REFRESH_MS = 20_000;
/** Switching "Day and night" on or off fades over this long. */
const NIGHT_FADE_MS = 320;
/** How much the night side is darkened: from orbit, and at street level. */
const NIGHT_SHADE_ORBIT = 0.84;
const NIGHT_SHADE_STREET = 0.5;
/** Engaging follow glides the camera onto the object over this long. */
const FOLLOW_ENGAGE_MS = 450;
/** A zoom, bearing or pitch change asked for while following eases in over this long. */
const FOLLOW_ADJUST_MS = 450;
/** A camera target this close to the followed object (pixels) is a change of framing, not a trip elsewhere. */
const FOLLOW_NEAR_PX = 60;
/** Padding changes ease with this half-life while the engine moves the camera every frame. */
const PADDING_HALF_LIFE_MS = 55;
/** The longest the engine waits for its shaders and the lights image before handing the globe over anyway. */
const WARM_UP_LIMIT_MS = 5000;
/** How long to wait before trying to rebuild the data canvas after its context was lost, and how often. */
const CANVAS_RETRY_MS = [0, 500, 1500, 4000, 10_000];
const NO_PADDING: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** Brightness of one cell of the low-zoom density underlay at full glow. */
const DENSITY_INTENSITY = 0.14;

function sameInsets(a: Partial<Insets>, b: Insets): boolean {
  return (
    (a.top ?? 0) === b.top &&
    (a.right ?? 0) === b.right &&
    (a.bottom ?? 0) === b.bottom &&
    (a.left ?? 0) === b.left
  );
}

/** The tightest turn from one bearing to another, degrees, in -180..180. */
function bearingDelta(from: number, to: number): number {
  return ((((to - from + 180) % 360) + 360) % 360) - 180;
}

const sameRef = (a: EntityRef | null, b: EntityRef | null): boolean =>
  a === b || (a !== null && b !== null && a.kind === b.kind && a.id === b.id);

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

function readEnv(name: string): string | undefined {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  const value = env?.[name];
  return value && value.length > 0 ? value : undefined;
}

export class HaloEngineImpl implements HaloEngine {
  private readonly events = new Emitter<EngineEvents>();
  private readonly root: HTMLDivElement;
  private map!: MapLibreMap;
  private overlay!: MapboxOverlay;
  private space!: SpaceLayer;
  private readonly sky: SpaceLayerState;
  private readonly horizon = new HorizonExtension();

  private readonly batches = new Map<EntityKind, RenderBatch>();
  private readonly density = new Map<EntityKind, DensityGrid>();
  private readonly paths = new Map<LayerId, PathSet>();
  /** Raster overlays by layer: what was asked for, and its sources once the style can take them. */
  private readonly overlays = new Map<
    LayerId,
    { description: TileOverlay; raster: RasterOverlay | null }
  >();
  private tiles: TileSetup | null = null;
  private creditLine: CreditLine | null = null;
  /** Credits for the data layers on show, as the app last gave them. */
  private credits: Credit[] = [];
  private status: EngineStatus = { basemap: "low-zoom", graphics: "ok" };
  private track: Track | null = null;
  private readonly visible: Record<LayerId, boolean>;

  private clock: ClockState = { mode: "live", timeMs: Date.now() };
  /** Added to the wall clock in live mode, for a caller whose "live" is not this machine's now. */
  private liveOffsetMs = 0;
  private skyTimeMs = Number.NaN;
  private nightTarget: number;

  private selection: EntityRef | null = null;
  private selectedAt = 0;
  private hover: PickInfo | null = null;
  private following = false;
  /** The 3D view: riding behind the followed aircraft. */
  private chasing = false;
  private chaseRestore = 0;
  /** Camera to chased aircraft, metres: eased from where the camera was to the 3D view's distance. */
  private chaseDistanceM = 0;
  /** The 3D view's own bearing and pitch, about the aircraft (the map's are about its centre). */
  private chaseBearing = 0;
  private chasePitch = 0;
  /** What the hand has asked of the 3D view: distance as a multiple, a turn about the aircraft, a pitch. */
  private chaseZoom = 1;
  private chaseYaw = 0;
  private chasePitchGoal = CHASE_PITCH;
  private chaseDrag: { id: number; x: number; y: number; yaw: number; pitch: number } | null = null;
  /** MapLibre's own camera controls, off while the 3D view has the camera. */
  private savedHandlers: { name: string; enabled: boolean }[] | null = null;
  private followFrom: { lon: number; lat: number; startedAt: number } | null = null;
  /** A change of zoom, bearing or pitch asked for while following, eased in by the frame loop. */
  private followAdjust: {
    zoom: [number, number];
    bearing: [number, number];
    pitch: [number, number];
    startedAt: number;
    durationMs: number;
    resolve: () => void;
  } | null = null;
  private readonly centre: [number, number] = [0, 0];
  private orbiting = false;
  /** Insets the HUD covers, as last asked for; the map's own padding eases towards it. */
  private padding: Insets = NO_PADDING;
  /** The map's padding is behind `padding` and waits for a moment when easing it will not cut a move short. */
  private paddingDue = false;
  private quality: QualityTier;
  private reducedMotion: boolean;
  private readonly governor = new QualityGovernor();
  private readonly refresh = new RefreshRateEstimate();
  private mapContextLost = false;
  private dataContextLost = false;
  private dataCanvas: HTMLCanvasElement | null = null;
  /**
   * While true, one of every kind of data layer is drawn (invisibly) so that
   * its shader program is compiled. Programs are compiled and linked where
   * they are first used, on the main thread, and under Direct3D that takes
   * the better part of a second for the set: paid here, before the globe is
   * handed over, it is part of loading; paid when the first data arrives, it
   * is a freeze in the middle of the opening shot.
   */
  private warming = true;
  private warmDraws = 0;
  private warmed: (() => void) | null = null;
  private canvasAttempts = 0;
  private canvasTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly reported = new Set<string>();

  private readonly hoverRing: Reticle = createReticle(HOVER_RING_PX, HALO);
  private readonly selectRing: Reticle = createReticle(SELECT_RING_PX, HALO);
  private readonly reticles: Reticle[] = [this.hoverRing, this.selectRing];
  private readonly locateIndex = new Map<EntityKind, { seq: number; id: number; index: number }>();
  private readonly scratch: [number, number, number] = [0, 0, 0];

  private layers: Layer[] = [];
  private layersDirty = true;
  /** More aircraft or ships in view than get a model: their glyph bodies stay on. */
  private modelsOverflow = false;
  private shipModelsOverflow = false;
  /** Where the aircraft models layer sits in `layers`, or -1 when it is not drawn. */
  private modelsIndex = -1;
  /** Where the ship models layer sits in `layers`, or -1 when it is not drawn. */
  private shipModelsIndex = -1;
  /** Rate of turn by aircraft id, degrees a second, from successive fixes: banks the models. */
  private turnRates = new Map<number, number>();
  private lastHeadings = new Map<number, { heading: number; fixMs: number }>();
  private isPicking = false;
  private pointer: { x: number; y: number } | null = null;
  private hoverDirty = false;
  private lastHoverPick = 0;
  private lastClick: { time: number; x: number; y: number } | null = null;
  private lastInteract = 0;

  private frameHandle = 0;
  private lastFrame = 0;
  private fpsFrames = 0;
  private fpsSince = 0;
  private mapRendered = false;
  private viewport: GlobeViewport | WebMercatorViewport | null = null;
  private lastViewEmit = 0;
  private viewTimer: ReturnType<typeof setTimeout> | null = null;
  private flight: { resolve: () => void; token: number } | null = null;
  private flightToken = 0;
  private fadeTimers: ReturnType<typeof setTimeout>[] = [];
  private ready = false;
  private loaded = false;
  private destroyed = false;
  private readonly cleanup: (() => void)[] = [];

  private readonly options: EngineOptions;

  private constructor(options: EngineOptions) {
    this.options = options;
    this.visible = { ...options.layers };
    this.quality = options.quality;
    // The tier asked for is the most the governor will ever spend.
    this.governor.setCeiling(options.quality);
    this.reducedMotion = options.reducedMotion;
    this.nightTarget = this.visible.nightlights ? 1 : 0;
    this.sky = {
      sun: sunDirection(this.now()),
      night: this.nightTarget,
      shade: NIGHT_SHADE_ORBIT,
      lights: 0,
      stars: QUALITY[this.quality].stars,
      faintStars: QUALITY[this.quality].faintStars,
      lightsFine: QUALITY[this.quality].lightsFine,
      rim: 1,
      rimColor: unit(RIM),
      lightColor: unit(accent("nightlights")),
    };
    this.root = document.createElement("div");
    this.root.className = "halo-engine";
    options.container.appendChild(this.root);
  }

  /** Build the engine and resolve once the globe can draw. */
  static async create(options: EngineOptions): Promise<HaloEngineImpl> {
    const engine = new HaloEngineImpl(options);
    await engine.start();
    return engine;
  }

  // ── Setup ────────────────────────────────────────────────────────────────

  private async start(): Promise<void> {
    const { options } = this;
    // Under a bundler the worker is not next to the main module, so say where it is.
    setWorkerUrl(workerUrl);

    const tiles = await createTileSetup({
      assetBase: options.assetBase,
      pmtilesUrl: readEnv("VITE_PMTILES_URL"),
      apiKey: readEnv("VITE_PROTOMAPS_KEY"),
    });
    if (this.destroyed) return;
    this.tiles = tiles;
    this.publishStatus();
    addProtocol(TILE_PROTOCOL, tiles.load);
    this.cleanup.push(() => removeProtocol(TILE_PROTOCOL));

    const view = options.initialView ?? { lon: 0, lat: 20, zoom: 1.6 };
    this.map = new MapLibreMap({
      container: this.root,
      style: buildStyle({
        tiles: tiles.template,
        maxZoom: tiles.maxZoom,
        attribution: tiles.attribution,
      }),
      center: [view.lon, view.lat],
      zoom: view.zoom ?? 1.6,
      bearing: view.bearing ?? 0,
      pitch: view.pitch ?? 0,
      minZoom: 0.6,
      maxZoom: 18,
      maxPitch: MAX_PITCH,
      attributionControl: false,
      // The engine emits `dive` on a double click instead of zooming a step.
      doubleClickZoom: false,
      pixelRatio: this.pixelRatio(),
      fadeDuration: this.mapFadeMs(),
      // The engine applies reduced motion itself (camera cross-fades), so
      // MapLibre must not also shorten its animations from the OS setting.
      reduceMotion: false,
      canvasContextAttributes: { antialias: false, powerPreference: "high-performance" },
    });
    if (this.padding !== NO_PADDING) this.map.setPadding(this.padding);
    this.creditLine = new CreditLine(this.root);
    this.refreshCredits();
    this.updateCreditLift();

    this.space = new SpaceLayer(
      this.sky,
      joinAsset(options.assetBase, LIGHTS_TEXTURE),
      joinAsset(options.assetBase, LIGHTS_TEXTURE_HD),
    );
    this.mountDataCanvas();

    this.bindMapEvents();
    this.bindDomEvents();

    // Shaders compiled and the lights decoded before the globe is handed
    // over, so neither lands in the opening shot. Neither is worth waiting
    // long for: the globe works without them, a little later.
    const warm = Promise.race([
      Promise.all([
        new Promise<void>((resolve) => {
          this.warmed = resolve;
        }),
        this.space.loadLights(),
      ]),
      new Promise<void>((resolve) => setTimeout(resolve, WARM_UP_LIMIT_MS)),
    ]);
    this.rebuildLayers();

    await new Promise<void>((resolve) => {
      // A slow or missing tile source must not leave the caller waiting for
      // ever: after a while the engine is handed over and the sky and any
      // overlays are installed whenever the style does finish loading.
      const timer = setTimeout(resolve, 8000);
      this.map.once("load", () => {
        clearTimeout(timer);
        if (!this.destroyed) this.onStyleReady();
        resolve();
      });
    });
    await warm;
    this.endWarmUp();
    if (this.destroyed) return;
    this.lastFrame = performance.now();
    this.fpsSince = this.lastFrame;
    this.frameHandle = requestAnimationFrame(this.frame);
  }

  private endWarmUp(): void {
    if (!this.warming) return;
    this.warming = false;
    this.layersDirty = true;
    const done = this.warmed;
    this.warmed = null;
    done?.();
  }

  private warmSet: Layer[] | null = null;

  /**
   * One layer of each kind with a single object in it, drawn at no opacity.
   * The real layers share their shaders, and the compiled programs stay in
   * the device's cache after these are dropped.
   */
  private warmLayers(): Layer[] {
    if (this.warmSet) return this.warmSet;
    const batch = createRenderBatch(EntityKind.Aircraft, 1, Date.now());
    batch.ids[0] = 1;
    batch.motion[0] = 90;
    batch.motion[1] = 200;
    const marks = createRenderBatch(EntityKind.Quake, 1, Date.now());
    marks.values[0] = 5;
    const line: BinaryPaths = {
      length: 1,
      startIndices: new Uint32Array([0]),
      attributes: { getPath: { value: new Float32Array([0, 0, 1, 1]), size: 2 } },
    };
    const ring = createReticle(18, HALO);
    ring.visible = true;
    ring.heading = 0;
    // Drawn, and discarded by the fragment shader: below its cut-off.
    ring.opacity = 1e-4;
    this.warmSet = [
      new PathLayer({
        id: "warm-paths",
        data: line,
        positionFormat: "XY",
        _pathType: "open",
        // Invisible by its colour, not by layer opacity, and set up like the
        // real cable layer: measured, a path layer warmed at opacity 0 still
        // cost the first real one a 200 ms stall on its first draw.
        getColor: [0, 0, 0, 0],
        getWidth: 1,
        widthUnits: "pixels",
        widthMinPixels: 1,
        pickable: true,
        extensions: [this.horizon],
        parameters: FLAT_PARAMETERS,
      }),
      new MarkersLayer({
        id: "warm-markers",
        source: markersFromBatch(marks),
        mode: "ripple",
        getTimeMs: this.now,
        color: [0, 0, 0],
        opacity: 0,
        parameters: GLOW_PARAMETERS,
      }),
      new MoversLayer({
        id: "warm-movers",
        batch,
        getTimeMs: this.now,
        color: [0, 0, 0],
        glyph: "aircraft",
        opacity: 0,
        parameters: GLOW_PARAMETERS,
      }),
      new ReticleLayer({ id: "warm-reticle", reticles: [ring], parameters: GLOW_PARAMETERS }),
      warmAircraftModelsLayer("warm-models"),
      warmShipModelsLayer("warm-ship-models"),
    ];
    return this.warmSet;
  }

  /**
   * The data canvas: deck.gl in a canvas of its own above the map. Built at
   * start, and again whenever its WebGL context is lost: a fresh canvas gets
   * a fresh context, which is quicker and surer than waiting for the browser
   * to hand the old one back, and deck.gl has no way to restore one.
   */
  private mountDataCanvas(): void {
    this.overlay = new MapboxOverlay({
      interleaved: false,
      // The overlay's own globe view ("mapbox" is the id it looks for), with a
      // near plane much closer than deck.gl's default of half the screen
      // height. That default sits a third of the way from the camera to the
      // ground: with the camera tilted, a cruising aircraft below it was
      // clipped away, glyph, ring and model alike. The map is always a globe.
      // (MapboxOverlay reads `views` but its props type leaves them out.)
      ...({ views: this.globeView(false) } as object),
      layers: [],
      useDevicePixels: this.pixelRatio(),
      pickingRadius: 0,
      parameters: FLAT_PARAMETERS,
      // deck.gl would otherwise run a picking pass on every pointer move; the
      // engine picks on its own throttled schedule.
      layerFilter: ({ isPicking }) => !isPicking || this.isPicking,
      onAfterRender: () => {
        // Two draws: the first compiles, the second proves the programs are usable.
        if (this.warming && this.layers.length > 0 && ++this.warmDraws >= 2) this.endWarmUp();
      },
      onDeviceInitialized: () => {
        if (this.destroyed) return;
        // deck.gl makes its canvas along with its device, so this is the first moment it can be watched.
        this.watchDataCanvas();
        this.dataContextLost = false;
        this.canvasAttempts = 0;
        this.layersDirty = true;
        this.publishStatus();
      },
      onError: (error) => this.onDataCanvasError(error),
    });
    this.map.addControl(this.overlay);
    this.watchDataCanvas();
    this.layersDirty = true;
  }

  private watchDataCanvas(): void {
    const canvas = this.overlay.getCanvas();
    if (!canvas || canvas === this.dataCanvas) return;
    this.dataCanvas?.removeEventListener("webglcontextlost", this.onDataContextLost);
    this.dataCanvas = canvas;
    canvas.addEventListener("webglcontextlost", this.onDataContextLost);
  }

  private readonly onDataContextLost = (): void => {
    if (this.destroyed || this.dataContextLost) return;
    this.dataContextLost = true;
    // A canvas without a context is painted as a white placeholder; over a black sky that is a flash.
    if (this.dataCanvas) this.dataCanvas.style.visibility = "hidden";
    this.canvasAttempts = 0;
    this.publishStatus();
    this.scheduleDataCanvas();
  };

  private onDataCanvasError(error: Error): void {
    if (this.destroyed) return;
    // No context to be had yet (the GPU process may still be restarting): try again, a little later each time.
    if (this.dataContextLost) {
      this.scheduleDataCanvas();
      return;
    }
    this.report("data canvas", error.message);
  }

  private scheduleDataCanvas(): void {
    if (this.canvasAttempts >= CANVAS_RETRY_MS.length) return;
    const wait = CANVAS_RETRY_MS[this.canvasAttempts++];
    if (this.canvasTimer) clearTimeout(this.canvasTimer);
    this.canvasTimer = setTimeout(() => {
      this.canvasTimer = null;
      if (this.destroyed) return;
      this.dataCanvas?.removeEventListener("webglcontextlost", this.onDataContextLost);
      this.dataCanvas = null;
      try {
        this.map.removeControl(this.overlay);
      } catch {
        // deck.gl could not tidy up a context that no longer exists; the canvas is gone either way.
      }
      this.reticleLayer = null;
      this.layers = [];
      this.mountDataCanvas();
    }, wait);
  }

  /** The style is in (first load, or rebuilt after the map's context came back): add what lives in it. */
  private onStyleReady(): void {
    if (this.destroyed || this.mapContextLost) return;
    this.loaded = true;
    this.installSpaceLayer();
    const now = performance.now();
    for (const [layer, entry] of this.overlays) {
      if (entry.raster) entry.raster.rebuild(now);
      else this.showOverlay(layer);
    }
    this.updateSky(true);
  }

  private installSpaceLayer(): void {
    if (this.map.getLayer(this.space.id)) return;
    this.map.addLayer(this.space, this.firstLabelLayer());
  }

  /** The style layer the sky and overlays sit beneath: the first label layer. */
  private firstLabelLayer(): string | undefined {
    return this.map.getStyle().layers.find((l) => l.type === "symbol")?.id;
  }

  /** One console line per distinct problem, however many tiles or frames repeat it. */
  private report(what: string, message: string): void {
    const key = `${what}: ${message}`;
    if (this.reported.has(key) || this.reported.size > 20) return;
    this.reported.add(key);
    console.warn(`Orya Halo ${key}`);
  }

  private bindMapEvents(): void {
    const { map } = this;
    map.on("render", () => {
      this.mapRendered = true;
    });
    map.on("move", () => {
      this.viewport = null;
      this.updateSky(false);
      // A hover is a claim about what is under the pointer; a moving camera can make it false.
      if (this.hover) this.hoverDirty = true;
    });
    map.on("resize", () => {
      this.viewport = null;
    });
    map.on("moveend", () => {
      this.scheduleViewEmit(120);
      // The camera has stopped somewhere new: what is under the resting pointer may have changed.
      if (this.pointer) this.hoverDirty = true;
    });
    map.on("mousemove", (e) => {
      this.pointer = { x: e.point.x, y: e.point.y };
      this.hoverDirty = true;
    });
    map.on("mouseout", () => {
      this.pointer = null;
      this.hoverDirty = true;
    });
    map.on("click", (e) => this.onClick(e));
    // MapLibre drops its whole style when the context goes and rebuilds it
    // from a snapshot when the context returns. A snapshot cannot hold a
    // custom layer, so the sky is added again, and the overlays' sources are
    // put back by the objects that manage them.
    //
    // The sky layer is taken out just before MapLibre takes its snapshot (a
    // capturing listener on the canvas runs ahead of MapLibre's own), which
    // spares the console the warning MapLibre prints for a custom layer it
    // cannot restore.
    const canvas = map.getCanvas();
    const beforeSnapshot = (): void => {
      if (this.loaded && map.getLayer(this.space.id)) map.removeLayer(this.space.id);
    };
    canvas.addEventListener("webglcontextlost", beforeSnapshot, { capture: true });
    this.cleanup.push(() =>
      canvas.removeEventListener("webglcontextlost", beforeSnapshot, { capture: true }),
    );
    map.on("webglcontextlost", () => {
      this.mapContextLost = true;
      this.loaded = false;
      // Hidden until it can draw again, so the black of space shows rather
      // than the white placeholder browsers paint for a canvas with no context.
      map.getCanvas().style.visibility = "hidden";
      this.space.contextLost();
      for (const entry of this.overlays.values()) entry.raster?.forget();
      this.publishStatus();
    });
    map.on("webglcontextrestored", () => {
      this.mapContextLost = false;
      map.getCanvas().style.visibility = "";
      this.publishStatus();
      map.once("style.load", () => this.onStyleReady());
    });
    map.on("error", (e) => {
      const source = (e as { sourceId?: string }).sourceId;
      // A provider that is down fails every tile; say so once per source.
      this.report(source ? `map source ${source}` : "map", e.error?.message ?? "error");
    });
  }

  private bindDomEvents(): void {
    const target = this.map.getCanvasContainer();
    this.bindChaseControls(target);
    const interact = (): void => this.onInteract();
    const options: AddEventListenerOptions = { passive: true, capture: true };
    for (const type of ["pointerdown", "wheel", "touchstart"] as const) {
      target.addEventListener(type, interact, options);
      this.cleanup.push(() => target.removeEventListener(type, interact, options));
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key.startsWith("Arrow") || e.key === "+" || e.key === "-" || e.key === "=")
        this.onInteract();
    };
    target.addEventListener("keydown", onKey, options);
    this.cleanup.push(() => target.removeEventListener("keydown", onKey, options));

    const onVisibility = (): void => {
      // A background tab's frames say nothing about rendering cost.
      this.governor.reset();
      this.fpsFrames = 0;
      this.fpsSince = performance.now();
    };
    document.addEventListener("visibilitychange", onVisibility);
    this.cleanup.push(() => document.removeEventListener("visibilitychange", onVisibility));

    // Dragging the window to another monitor changes the pixel ratio; both canvases follow.
    const watchPixelRatio = (): void => {
      const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      const onChange = (): void => {
        if (this.destroyed) return;
        this.applyQuality(this.quality);
        watchPixelRatio();
      };
      query.addEventListener("change", onChange, { once: true });
      this.cleanup.push(() => query.removeEventListener("change", onChange));
    };
    watchPixelRatio();
  }

  // ── Time ─────────────────────────────────────────────────────────────────

  /** The moment being rendered, Unix epoch milliseconds. */
  private readonly now = (): number =>
    this.clock.mode === "live" ? Date.now() + this.liveOffsetMs : this.clock.timeMs;

  setClock(clock: ClockState): void {
    this.clock = { mode: clock.mode, timeMs: clock.timeMs };
    if (clock.mode === "live") {
      // Live ticks arrive about once a second and a little late; only a real
      // difference from the wall clock is kept, so time never stutters.
      const offset = clock.timeMs - Date.now();
      this.liveOffsetMs = Math.abs(offset) < 5000 ? 0 : offset;
    }
    if (!this.map) return;
    this.updateSky(false);
    this.refreshOverlayFrames();
  }

  // ── Frame loop ───────────────────────────────────────────────────────────

  private readonly frame = (perfNow: number): void => {
    if (this.destroyed) return;
    this.frameHandle = requestAnimationFrame(this.frame);
    // A frame's timestamp is when the frame began, which can be earlier than the
    // `performance.now()` the loop was seeded with: the first `dt` may come out
    // negative. Everything eased by `dt` (padding, night fade, orbit) would then
    // step backwards, and padding stepping past zero makes MapLibre throw.
    const dt = clamp(perfNow - this.lastFrame, 0, 100);
    this.lastFrame = Math.max(this.lastFrame, perfNow);
    if (!this.ready) {
      // First frame after the style and the sky are in: the globe is on screen.
      this.ready = true;
      this.prepareModelsWhenIdle();
      this.events.emit("ready", undefined);
      // The starting view is a view too: whoever feeds the engine data needs it.
      this.scheduleViewEmit(0);
    }
    if (this.sky.night !== this.nightTarget) {
      const step = this.reducedMotion ? 1 : dt / NIGHT_FADE_MS;
      this.sky.night =
        this.nightTarget > this.sky.night
          ? Math.min(this.nightTarget, this.sky.night + step)
          : Math.max(this.nightTarget, this.sky.night - step);
      this.updateSky(true);
    }

    this.fpsFrames++;
    if (perfNow - this.fpsSince >= 1000) {
      const fps = (this.fpsFrames * 1000) / (perfNow - this.fpsSince);
      this.fpsFrames = 0;
      this.fpsSince = perfNow;
      this.events.emit("fps", Math.round(fps * 10) / 10);
      if (document.visibilityState === "visible" && !this.mapContextLost && !this.dataContextLost) {
        const hz = this.refresh.observe(fps, this.quality === "low");
        const next = this.governor.sample(fps, this.quality, hz);
        if (next) {
          this.applyQuality(next);
          this.events.emit("quality", next);
        }
      }
    }

    const timeMs = this.now();
    this.driveCamera(dt, perfNow);
    this.updateReticles(perfNow);
    if (this.loaded) {
      for (const entry of this.overlays.values())
        if (entry.raster?.busy) entry.raster.tick(perfNow);
    }
    if (this.hoverDirty && perfNow - this.lastHoverPick >= HOVER_PICK_INTERVAL_MS)
      this.pickHover(perfNow);
    if (Math.abs(timeMs - this.skyTimeMs) > SKY_REFRESH_MS) {
      this.updateSky(false);
      this.refreshOverlayFrames();
    }
    if (this.modelsActive() !== this.modelsIndex >= 0) this.layersDirty = true;
    if (this.shipModelsActive() !== this.shipModelsIndex >= 0) this.layersDirty = true;
    if (this.layersDirty) this.rebuildLayers();
    else if (this.modelsIndex >= 0 || this.shipModelsIndex >= 0) {
      // Models are placed on the CPU: a fresh layer each frame moves them.
      const layers = this.layers.slice();
      if (this.modelsIndex >= 0) layers[this.modelsIndex] = this.modelsLayer();
      if (this.shipModelsIndex >= 0) layers[this.shipModelsIndex] = this.shipModelsLayer();
      this.layers = layers;
      this.overlay.setProps({ layers });
    }

    // The map's own render already redraws the data canvas in step with the
    // camera; only ask for a redraw on frames where the map stays still.
    if (!this.mapRendered) this.reticleLayer?.setNeedsRedraw();
    this.mapRendered = false;
  };

  private reticleLayer: ReticleLayer | null = null;

  /** Build the 3D aircraft and vessel meshes in idle moments after start-up, a few at a time. */
  private prepareModelsWhenIdle(): void {
    const step = (deadline?: IdleDeadline): void => {
      if (this.destroyed) return;
      const started = performance.now();
      const timeLeft = deadline
        ? () => deadline.timeRemaining()
        : () => 8 - (performance.now() - started);
      if (!prepareAircraftMeshes(timeLeft) || !prepareVesselMeshes(timeLeft)) schedule();
    };
    const schedule = (): void => {
      if (typeof requestIdleCallback === "function") requestIdleCallback(step, { timeout: 2000 });
      else setTimeout(step, 50);
    };
    schedule();
  }

  /** True while the frame loop places the camera itself, every frame. */
  private drivesCamera(): boolean {
    return (this.following && this.selection !== null) || (this.orbiting && !this.reducedMotion);
  }

  private driveCamera(dt: number, perfNow: number): void {
    const map = this.map;
    // `dt` paces the orbit and the easing; follow itself is tied to the data clock, not the frame rate.
    let lon: number | null = null;
    let lat = 0;
    let zoom: number | undefined;
    let bearing: number | undefined;
    let pitch: number | undefined;

    if (this.following && this.selection) {
      const at = this.locate(this.selection);
      if (!at && this.chasing) {
        // What the 3D view rides with has left the data: leave the view, or
        // the camera would hang there with everything else drawn as for it.
        this.setChase(false);
        this.events.emit("chaseEnded", undefined);
      }
      if (at) {
        const adjust = this.followAdjust;
        if (adjust) {
          const q =
            adjust.durationMs > 0
              ? clamp((perfNow - adjust.startedAt) / adjust.durationMs, 0, 1)
              : 1;
          const k = q * q * (3 - 2 * q);
          zoom = adjust.zoom[0] + (adjust.zoom[1] - adjust.zoom[0]) * k;
          bearing = adjust.bearing[0] + bearingDelta(adjust.bearing[0], adjust.bearing[1]) * k;
          pitch = adjust.pitch[0] + (adjust.pitch[1] - adjust.pitch[0]) * k;
          if (q >= 1) {
            this.followAdjust = null;
            adjust.resolve();
          }
        }
        let chased = false;
        if (this.chasing && !adjust) {
          // The 3D view: place the camera itself, on the sphere, behind the aircraft.
          const subject = this.chaseSubject();
          const k = this.reducedMotion ? 1 : 1 - 0.5 ** (dt / CHASE_EASE_MS);
          // Bearing, pitch and distance are the view's own, about the aircraft;
          // the map's are about its centre, kilometres away, and differ.
          const b0 = this.chaseBearing;
          const goalBearing =
            (Number.isFinite(subject.heading) ? subject.heading : b0) + CHASE_SIDE_DEG;
          // A hand on the view moves the camera at once; the aircraft's own turns are eased.
          const kHand =
            this.chaseDrag && !this.reducedMotion ? 1 - 0.5 ** (dt / CHASE_DRAG_EASE_MS) : k;
          this.chaseBearing = b0 + bearingDelta(b0, goalBearing + this.chaseYaw) * kHand;
          this.chasePitch += (this.chasePitchGoal - this.chasePitch) * kHand;
          const goalDistance =
            Math.max(subject.size * CHASE_DISTANCE_PER_SIZE, 60) *
            this.chaseScale(subject.size) *
            this.chaseZoom;
          this.chaseDistanceM += (goalDistance - this.chaseDistanceM) * k;
          const camera = chaseCamera(
            at.lon,
            at.lat,
            this.drawnAltitude(this.selection.kind, at.alt),
            this.chaseBearing,
            this.chasePitch,
            this.chaseDistanceM,
            this.options.container.clientHeight,
          );
          if (camera) {
            lon = camera.lon;
            lat = camera.lat;
            bearing = camera.bearing;
            pitch = camera.pitch;
            zoom = clamp(camera.zoom, map.getMinZoom(), map.getMaxZoom());
            this.followFrom = null;
            chased = true;
          }
        }
        if (!chased) {
          // Look where the object is drawn: the position the shader gives it,
          // and, with the camera pitched, the ground beyond it that its height
          // lines up with. That keeps it in the middle of the clear area.
          const target = followCentre(
            at.lon,
            at.lat,
            this.drawnAltitude(this.selection.kind, at.alt),
            pitch ?? map.getPitch(),
            bearing ?? map.getBearing(),
            this.centre,
          );
          lon = target[0];
          lat = target[1];
          // Glide from where the camera was when follow was engaged.
          const from = this.followFrom;
          const g = from ? clamp((perfNow - from.startedAt) / FOLLOW_ENGAGE_MS, 0, 1) : 1;
          if (from && g < 1) {
            const k = g * g * (3 - 2 * g);
            lon = from.lon + wrapLon(lon - from.lon) * k;
            lat = from.lat + (lat - from.lat) * k;
          } else {
            this.followFrom = null;
          }
        }
      }
    } else if (this.orbiting && !this.reducedMotion && !this.flight) {
      const center = map.getCenter();
      lon = center.lng + (orbitRate(map.getZoom()) * dt) / 1000;
      lat = center.lat;
    }

    if (lon === null) {
      this.settlePadding();
      return;
    }
    // A move of the engine's own replaces any ease MapLibre is running, so
    // padding cannot be left to `easeTo` here: it is eased by hand, in step.
    const now = map.getPadding();
    const want = this.padding;
    const padding = sameInsets(now, want)
      ? undefined
      : {
          top: approach(now.top ?? 0, want.top, dt, PADDING_HALF_LIFE_MS, 0.25),
          right: approach(now.right ?? 0, want.right, dt, PADDING_HALF_LIFE_MS, 0.25),
          bottom: approach(now.bottom ?? 0, want.bottom, dt, PADDING_HALF_LIFE_MS, 0.25),
          left: approach(now.left ?? 0, want.left, dt, PADDING_HALF_LIFE_MS, 0.25),
        };
    this.paddingDue = false;
    map.jumpTo({ center: [lon, lat], zoom, bearing, pitch, padding });
  }

  /** Bring the map's padding up to date once nothing would be cut short by doing so. */
  private settlePadding(): void {
    if (!this.paddingDue || this.flight) return;
    const map = this.map;
    // An ease would end a drag in progress; wait for the hand to lift.
    if (map.isMoving()) return;
    this.paddingDue = false;
    if (sameInsets(map.getPadding(), this.padding)) return;
    if (this.reducedMotion) map.setPadding(this.padding);
    else map.easeTo({ padding: this.padding, duration: 260, essential: true });
  }

  // ── Sky ──────────────────────────────────────────────────────────────────

  private updateSky(force: boolean): void {
    if (!this.map) return;
    const timeMs = this.now();
    const zoom = this.map.getZoom();
    // City lights are a from-orbit effect: gone by the time a city fills the view.
    const lights = this.sky.night * (1 - smoothstep(4.8, 7.6, zoom));
    // Night is near-black from orbit, but a street map has to stay legible after dark.
    const shade =
      NIGHT_SHADE_ORBIT + (NIGHT_SHADE_STREET - NIGHT_SHADE_ORBIT) * smoothstep(6, 10, zoom);
    const q = QUALITY[this.quality];
    const stars = q.stars;
    const moved = Math.abs(timeMs - this.skyTimeMs) > 1000;
    const changed =
      force ||
      moved ||
      Math.abs(lights - this.sky.lights) > 0.004 ||
      Math.abs(shade - this.sky.shade) > 0.004 ||
      stars !== this.sky.stars ||
      q.faintStars !== this.sky.faintStars ||
      q.lightsFine !== this.sky.lightsFine;
    if (!changed) return;
    if (force || moved) {
      sunDirection(timeMs, this.sky.sun);
      this.skyTimeMs = timeMs;
    }
    this.sky.lights = lights;
    this.sky.shade = shade;
    this.sky.stars = stars;
    this.sky.faintStars = q.faintStars;
    this.sky.lightsFine = q.lightsFine;
    this.map.triggerRepaint();
  }

  // ── Data in ──────────────────────────────────────────────────────────────

  setBatch(batch: RenderBatch): void {
    this.batches.set(batch.kind, batch);
    if (batch.kind === EntityKind.Aircraft) this.updateTurnRates(batch);
    this.layersDirty = true;
  }

  /** Each aircraft's rate of turn, from the change in heading between its fixes. */
  private updateTurnRates(batch: RenderBatch): void {
    const headings = new Map<number, { heading: number; fixMs: number }>();
    const rates = new Map<number, number>();
    for (let i = 0; i < batch.count; i++) {
      const id = batch.ids[i];
      const m = i * MOTION_SIZE;
      const heading = batch.motion[m];
      const fixMs = batch.epochMs + batch.motion[m + 3] * 1000;
      if (!Number.isFinite(heading)) continue;
      headings.set(id, { heading, fixMs });
      const before = this.lastHeadings.get(id);
      const kept = this.turnRates.get(id) ?? 0;
      const dt = before ? (fixMs - before.fixMs) / 1000 : 0;
      if (before && dt >= 1 && dt <= 90) {
        const turn = (((heading - before.heading + 540) % 360) - 180) / dt;
        // Smoothed, so one noisy heading does not throw the wings about.
        rates.set(id, kept * 0.4 + turn * 0.6);
      } else if (before && dt < 1) {
        rates.set(id, kept);
      } else if (kept !== 0) {
        rates.set(id, kept * 0.5);
      }
      if (before && dt < 1) headings.set(id, before);
    }
    this.lastHeadings = headings;
    this.turnRates = rates;
  }

  /** True when aircraft should be drawn as 3D models at the current zoom. */
  private modelsActive(): boolean {
    const batch = this.batches.get(EntityKind.Aircraft);
    return (
      QUALITY[this.quality].aircraftModels > 0 &&
      this.visible.aircraft &&
      batch !== undefined &&
      batch.count > 0 &&
      this.map.getZoom() >= MODEL_ZOOM[0]
    );
  }

  /** Half the on-screen size of an aircraft's 3D model, by the models layer's own rule. */
  private modelHalfPixels(batch: RenderBatch, i: number, lon: number, lat: number): number {
    const s = i * STYLE_SIZE;
    const spec = aircraftModel(batch.style[s + 3] || genericAircraftModel(batch.style[s]));
    if (!spec) return 0;
    const a = this.project(lon, lat);
    const b = this.project(lon + 100 / (111_320 * Math.max(Math.cos(lat * DEG), 0.01)), lat);
    if (!a || !b) return 0;
    const pixelsPerMeter = Math.hypot(b.x - a.x, b.y - a.y) / 100;
    const size = Math.max(spec.lengthM, spec.spanM);
    const k = Math.max(
      1,
      this.modelPixels().target / (40 * pixelsPerMeter),
      this.modelPixels().min / (size * pixelsPerMeter),
    );
    return (size * pixelsPerMeter * k) / 2;
  }

  /** How long models are drawn at this zoom: small from a country away, larger close in. */
  private modelPixels(): { target: number; min: number } {
    const t = clamp(
      (this.map.getZoom() - MODEL_SIZE_ZOOM[0]) / (MODEL_SIZE_ZOOM[1] - MODEL_SIZE_ZOOM[0]),
      0,
      1,
    );
    return {
      target: MODEL_TARGET_PX[0] + (MODEL_TARGET_PX[1] - MODEL_TARGET_PX[0]) * t,
      min: MODEL_MIN_PX[0] + (MODEL_MIN_PX[1] - MODEL_MIN_PX[0]) * t,
    };
  }

  private modelsLayer(): AircraftModelsLayer {
    const zoom = this.map.getZoom();
    const size = this.modelPixels();
    const far = this.chasing ? smoothstep(4, 16, this.chaseZoom) : 0;
    const t = clamp((zoom - MODEL_ZOOM[0]) / (MODEL_ZOOM[1] - MODEL_ZOOM[0]), 0, 1);
    return new AircraftModelsLayer({
      id: "aircraft-models",
      batch: this.batches.get(EntityKind.Aircraft) ?? null,
      timeMs: this.now(),
      turnRates: this.turnRates,
      altitudeScale: MOVERS[EntityKind.Aircraft]?.altitudeScale ?? 1,
      selectedId: this.selection?.kind === EntityKind.Aircraft ? this.selection.id : null,
      // In the 3D view the camera is beside the aircraft: true size, nothing enlarged.
      selectedScale: this.chasing ? this.chaseScale(this.chaseSubject().size) * (1 - far) + far : 1,
      // Close behind an aircraft everything is true size; pulled far back the
      // others are enlarged again, as in the ordinary view, so they can be seen.
      targetPixels: this.chasing ? size.target * far : size.target,
      minPixels: this.chasing ? size.min * far : size.min,
      maxModels: QUALITY[this.quality].aircraftModels,
      onOverflow: (over: boolean) => {
        if (over === this.modelsOverflow) return;
        this.modelsOverflow = over;
        this.layersDirty = true;
      },
      opacity: t * t * (3 - 2 * t),
    });
  }

  /** True when ships should be drawn as 3D models at the current zoom (or one is chased). */
  private shipModelsActive(): boolean {
    const batch = this.batches.get(EntityKind.Ship);
    return (
      QUALITY[this.quality].shipModels > 0 &&
      this.visible.ships &&
      batch !== undefined &&
      batch.count > 0 &&
      (this.map.getZoom() >= SHIP_MODEL_ZOOM[0] ||
        (this.chasing && this.selection?.kind === EntityKind.Ship))
    );
  }

  private shipModelsLayer(): ShipModelsLayer {
    const zoom = this.map.getZoom();
    const style = MOVERS[EntityKind.Ship];
    const glyph = style
      ? sizeAtZoom(zoom, style.sizeZoomRange, style.sizePixels, SHIP_GLYPH_EASE)
      : 14;
    const chasingShip = this.chasing && this.selection?.kind === EntityKind.Ship;
    // As for aircraft: true size close behind the chased ship, enlarged again pulled far back.
    const far = this.chasing ? smoothstep(4, 16, this.chaseZoom) : 0;
    const t = clamp((zoom - SHIP_MODEL_ZOOM[0]) / (SHIP_MODEL_ZOOM[1] - SHIP_MODEL_ZOOM[0]), 0, 1);
    return new ShipModelsLayer({
      id: "ship-models",
      batch: this.batches.get(EntityKind.Ship) ?? null,
      timeMs: this.now(),
      glyphPixels: this.chasing ? glyph * far : glyph,
      selectedId: this.selection?.kind === EntityKind.Ship ? this.selection.id : null,
      selectedScale: chasingShip ? this.chaseScale(this.chaseSubject().size) * (1 - far) + far : 1,
      maxModels: QUALITY[this.quality].shipModels,
      onOverflow: (over: boolean) => {
        if (over === this.shipModelsOverflow) return;
        this.shipModelsOverflow = over;
        this.layersDirty = true;
      },
      opacity: chasingShip ? 1 : t * t * (3 - 2 * t),
    });
  }

  setDensity(grid: DensityGrid): void {
    this.density.set(grid.kind, grid);
    this.layersDirty = true;
  }

  setPaths(layer: LayerId, paths: PathSet): void {
    this.paths.set(layer, paths);
    this.layersDirty = true;
  }

  setTrack(track: Track | null): void {
    this.track = track && track.count > 1 ? track : null;
    this.layersDirty = true;
  }

  setTiles(layer: LayerId, overlay: TileOverlay | null): void {
    const entry = this.overlays.get(layer);
    if (!overlay) {
      if (entry?.raster) {
        if (this.loaded) entry.raster.remove();
        else entry.raster.forget();
      }
      this.overlays.delete(layer);
      this.refreshCredits();
      return;
    }
    if (entry) {
      entry.description = overlay;
      // A refreshed frame list for an overlay that is already up keeps its
      // sources (and the tiles they hold) and only moves to the right frame.
      if (this.loaded) entry.raster?.update(overlay);
    } else {
      this.overlays.set(layer, { description: overlay, raster: null });
    }
    this.showOverlay(layer);
    this.refreshCredits();
  }

  /** Put an overlay's frame for the current moment on the map, creating its sources on first use. */
  private showOverlay(layer: LayerId): void {
    const entry = this.overlays.get(layer);
    if (!entry || !this.loaded) return;
    entry.raster ??= new RasterOverlay(this.map, entry.description, {
      name: layer,
      // Imagery replaces the ground, so night falls on it; everything else
      // (radar) is information and stays readable on the night side.
      before: () =>
        layer === "imagery" && this.map.getLayer(this.space.id)
          ? this.space.id
          : this.firstLabelLayer(),
      visible: this.visible[layer],
      reducedMotion: this.reducedMotion,
    });
    entry.raster.show(overlayTiles(entry.description, this.now()).tiles, performance.now());
  }

  /** Point animated overlays at the frame nearest the clock. */
  private refreshOverlayFrames(): void {
    for (const layer of this.overlays.keys()) this.showOverlay(layer);
  }

  // ── Credits and status ───────────────────────────────────────────────────

  setCredits(credits: Attribution[]): void {
    this.credits = credits.map((c) => ({ text: c.text, url: c.url }));
    this.refreshCredits();
  }

  /** Data credits first, then whatever else is on screen, the base map's own last. */
  private refreshCredits(): void {
    if (!this.creditLine) return;
    const overlays: Credit[] = [];
    for (const [layer, entry] of this.overlays) {
      const credit = entry.description.attribution;
      if (credit && this.visible[layer]) overlays.push(credit);
    }
    const lights = this.visible.nightlights ? [LIGHTS_CREDIT] : [];
    const base = this.tiles && (this.tiles.local || this.tiles.deep) ? BASEMAP_CREDITS : [];
    // The imagery is on screen at every zoom but street level, so it is always credited.
    this.creditLine.set(mergeCredits(this.credits, overlays, lights, [IMAGERY_CREDIT], base));
  }

  /**
   * On a phone the HUD's dock and time tape run the full width of the bottom
   * edge, and would cover the credits; the bottom inset the app reports is
   * exactly their height, so the credits sit just above it. On wider screens
   * the corner is clear and they stay in it.
   */
  private updateCreditLift(): void {
    const narrow = this.options.container.clientWidth < PHONE_WIDTH;
    this.creditLine?.setLift(narrow ? this.padding.bottom : 0);
  }

  /** What is and is not working; the `status` event reports changes. */
  getStatus(): EngineStatus {
    return this.status;
  }

  private publishStatus(): void {
    const next = describeStatus({
      local: this.tiles?.local ?? true,
      deep: this.tiles?.deep ?? null,
      remoteFailed: this.tiles?.remoteFailed ?? false,
      contextLost: this.mapContextLost || this.dataContextLost,
    });
    const prev = this.status;
    if (
      next.basemap === prev.basemap &&
      next.graphics === prev.graphics &&
      next.message === prev.message &&
      next.hint === prev.hint
    )
      return;
    this.status = next;
    this.events.emit("status", next);
  }

  // ── Layers ───────────────────────────────────────────────────────────────

  setLayerVisible(layer: LayerId, visible: boolean): void {
    if (this.visible[layer] === visible) return;
    this.visible[layer] = visible;
    const def = layerDef(layer);
    if (def.shape === "tiles") {
      // Shown again, an overlay first catches up with the clock: nothing was requested while it was hidden.
      if (this.loaded) this.overlays.get(layer)?.raster?.setVisible(visible, performance.now());
    } else if (def.shape === "computed") {
      // The frame loop eases the sky towards this.
      this.nightTarget = visible ? 1 : 0;
    } else {
      this.layersDirty = true;
    }
    this.refreshCredits();
    if (!visible && this.hover?.layer === layer) this.setHover(null);
  }

  private rebuildLayers(): void {
    this.layersDirty = false;
    const q = QUALITY[this.quality];
    const layers: Layer[] = this.warming ? [...this.warmLayers()] : [];

    if (q.density) {
      for (const kind of MOVER_ORDER) {
        const grid = this.density.get(kind);
        const def = layerForKind(kind);
        if (!grid || grid.count === 0 || !this.visible[def.id]) continue;
        layers.push(
          new MarkersLayer({
            id: `density-${def.id}`,
            source: markersFromDensity(grid),
            mode: "glow",
            getTimeMs: this.now,
            color: hexToRgb(def.accent),
            valueMax: grid.max,
            radiusMeters: (H3_EDGE_M[grid.res] ?? 100_000) * 1.6,
            intensity: DENSITY_INTENSITY * q.glow,
            fadeOutZoom: [3.2, 5.2],
            parameters: GLOW_PARAMETERS,
          }),
        );
      }
    }

    const cables = this.paths.get("cables");
    if (cables && cables.count > 0 && this.visible.cables) {
      const data = this.pathData(cables);
      const prepared = this.preparedPaths(cables);
      const color = accent("cables");
      layers.push(
        new PathLayer({
          id: "paths-cables",
          data,
          positionFormat: "XY",
          _pathType: "open",
          getColor: [color[0], color[1], color[2], 150],
          getWidth: 1,
          widthUnits: "pixels",
          widthMinPixels: 1,
          pickable: true,
          extensions: [this.horizon],
          parameters: FLAT_PARAMETERS,
        }),
      );
      const selected =
        this.selection?.kind === EntityKind.Cable ? cables.ids.indexOf(this.selection.id) : -1;
      const hovered =
        this.hover?.ref.kind === EntityKind.Cable ? cables.ids.indexOf(this.hover.ref.id) : -1;
      for (const [index, id, alpha] of [
        [hovered, "paths-cables-hover", 150],
        [selected, "paths-cables-selected", 255],
      ] as const) {
        if (index < 0 || (id === "paths-cables-hover" && index === selected)) continue;
        layers.push(
          new PathLayer({
            id,
            data: this.highlightData(id, prepared, cables, index),
            positionFormat: "XY",
            _pathType: "open",
            getColor: [HALO[0], HALO[1], HALO[2], alpha],
            getWidth: 2,
            widthUnits: "pixels",
            extensions: [this.horizon],
            parameters: FLAT_PARAMETERS,
          }),
        );
      }
    }

    const track = this.track;
    // In the 3D view the track runs back under the camera and smears across the screen.
    if (track && !this.chasing) {
      const def = layerForKind(track.ref.kind);
      const color = hexToRgb(def.accent);
      layers.push(
        new PathLayer({
          id: "track",
          data: this.trackData(track),
          _pathType: "open",
          getColor: [color[0], color[1], color[2], 170],
          getWidth: 1.5,
          widthUnits: "pixels",
          extensions: [this.horizon],
          parameters: FLAT_PARAMETERS,
        }),
      );
    }

    for (const kind of MARKER_ORDER) {
      const batch = this.batches.get(kind);
      const style = MARKERS[kind];
      const def = layerForKind(kind);
      if (!batch || !style || batch.count === 0 || !this.visible[def.id]) continue;
      layers.push(
        new MarkersLayer({
          id: `markers-${def.id}`,
          source: markersFromBatch(batch),
          mode: style.mode,
          getTimeMs: this.now,
          color: hexToRgb(def.accent),
          sizePixels: style.sizePixels,
          intensity: q.glow,
          slowMotion: this.reducedMotion,
          valueIsZoomRank: style.zoomRank === true,
          pickable: true,
          parameters: GLOW_PARAMETERS,
        }),
      );
    }

    for (const kind of MOVER_ORDER) {
      const batch = this.batches.get(kind);
      const style = MOVERS[kind];
      const def = layerForKind(kind);
      if (!batch || !style || batch.count === 0 || !this.visible[def.id]) continue;
      // In the 3D view the camera looks along the horizon, where thousands of
      // satellites line up as flat glyphs and fill the sky. They return with
      // the ordinary view; the layer stays on.
      if (this.chasing && kind === EntityKind.Satellite) continue;
      layers.push(
        new MoversLayer({
          id: `movers-${def.id}`,
          batch,
          getTimeMs: this.now,
          color: hexToRgb(def.accent),
          ...style,
          // In the 3D view the camera is among the aircraft: their trails, drawn
          // flat on the screen, would only streak the sky.
          tail: q.tails && !(this.chasing && kind === EntityKind.Aircraft),
          glow: q.glow,
          farThin: q.farThin,
          slowMotion: this.reducedMotion,
          // Glyph bodies give way to models, unless more are in view than get
          // one: then the bodies stay, under the models of the nearest, so
          // none of the rest disappears (a moored ship has no tail to show).
          bodyFadeZoomRange:
            kind === EntityKind.Aircraft && q.aircraftModels > 0 && !this.modelsOverflow
              ? MODEL_ZOOM
              : kind === EntityKind.Ship && q.shipModels > 0 && !this.shipModelsOverflow
                ? SHIP_MODEL_ZOOM
                : null,
          pickable: true,
          parameters: GLOW_PARAMETERS,
        }),
      );
    }

    if (q.aircraftModels > 0 && this.visible.aircraft) {
      // Holds the 3D model shaders in luma.gl's cache (it drops a program
      // with its last layer, and a recompile is a 40 ms stall the first time
      // models appear). One transparent instance, smaller than a pixel.
      layers.push(warmAircraftModelsLayer("models-keep"));
    }
    if (q.shipModels > 0 && this.visible.ships) {
      // The same for the ship models' shaders.
      layers.push(warmShipModelsLayer("ship-models-keep"));
    }
    this.shipModelsIndex = -1;
    if (this.shipModelsActive()) {
      // Under the aircraft: drawn first, so an aircraft low over a port stays on top.
      this.shipModelsIndex = layers.length;
      layers.push(this.shipModelsLayer());
    }
    this.modelsIndex = -1;
    if (this.modelsActive()) {
      this.modelsIndex = layers.length;
      layers.push(this.modelsLayer());
    }

    this.reticleLayer = new ReticleLayer({
      id: "reticle",
      reticles: this.reticles,
      parameters: GLOW_PARAMETERS,
    });
    layers.push(this.reticleLayer);

    this.layers = layers;
    this.overlay.setProps({ layers });
  }

  private readonly preparedCache = new WeakMap<PathSet, PreparedPaths>();
  private readonly pathDataCache = new WeakMap<PathSet, BinaryPaths>();
  private readonly highlightCache = new Map<
    string,
    { from: PreparedPaths; index: number; data: BinaryPaths }
  >();
  private readonly trackCache = new WeakMap<Track, BinaryPaths>();

  /** A path set cut at the antimeridian and bent along the globe, once per set. */
  private preparedPaths(paths: PathSet): PreparedPaths {
    let prepared = this.preparedCache.get(paths);
    if (!prepared) {
      prepared = preparePaths(paths.positions, 2, paths.startIndices, paths.count);
      this.preparedCache.set(paths, prepared);
    }
    return prepared;
  }

  /** The same object for the same set, so deck.gl uploads it once. */
  private pathData(paths: PathSet): BinaryPaths {
    let data = this.pathDataCache.get(paths);
    if (!data) {
      data = binaryPaths(this.preparedPaths(paths));
      this.pathDataCache.set(paths, data);
    }
    return data;
  }

  /** One cable on its own (every path that carries its id), for the hover and selection strokes. */
  private highlightData(
    slot: string,
    from: PreparedPaths,
    paths: PathSet,
    index: number,
  ): BinaryPaths {
    const cached = this.highlightCache.get(slot);
    if (cached && cached.from === from && cached.index === index) return cached.data;
    const id = paths.ids[index];
    const data = binaryPaths(piecesOf(from, (owner) => paths.ids[owner] === id));
    this.highlightCache.set(slot, { from, index, data });
    return data;
  }

  /**
   * A track ready to draw: altitude scaled the way the track's own layer
   * draws its objects, cut where it crosses the antimeridian (an orbit does,
   * every revolution) and bent along the globe between sparse fixes.
   */
  private trackData(track: Track): BinaryPaths {
    let data = this.trackCache.get(track);
    if (!data) {
      const scale = MOVERS[track.ref.kind]?.altitudeScale ?? 0;
      const count = Math.min(track.count, Math.floor(track.positions.length / 3));
      const prepared = preparePaths(track.positions.subarray(0, count * 3), 3, [0], 1, {
        maxSegmentDeg: 2,
      });
      if (scale !== 1) {
        for (let i = 2; i < prepared.positions.length; i += 3) prepared.positions[i] *= scale;
      }
      data = binaryPaths(prepared);
      this.trackCache.set(track, data);
    }
    return data;
  }

  // ── Selection, hover, picking ────────────────────────────────────────────

  setSelection(ref: EntityRef | null): void {
    if (sameRef(ref, this.selection)) return;
    this.selection = ref ? { kind: ref.kind, id: ref.id } : null;
    this.selectedAt = performance.now();
    if (!ref) this.endFollow();
    // Cable highlights are layers; rings are not.
    this.layersDirty = true;
  }

  setFollowing(following: boolean): void {
    const next = following && this.selection !== null;
    if (next && !this.following && this.map) {
      this.cancelFlight();
      const center = this.map.getCenter();
      this.followFrom = this.reducedMotion
        ? null
        : { lon: center.lng, lat: center.lat, startedAt: performance.now() };
    }
    if (next) this.following = true;
    else this.endFollow();
  }

  setChase(chase: boolean): void {
    const kind = this.selection?.kind;
    const next =
      chase &&
      (kind === EntityKind.Aircraft || kind === EntityKind.Ship) &&
      this.selection !== null &&
      this.batchIndex(this.selection) !== null &&
      !this.destroyed;
    if (chase && !next && this.map && !this.destroyed) {
      // Asked for, but there is nothing to ride with: say so, so the app does not show it as on.
      queueMicrotask(() => this.events.emit("chaseEnded", undefined));
    }
    if (next === this.chasing || !this.map) return;
    clearTimeout(this.chaseRestore);
    if (next) {
      this.map.setMaxPitch(CHASE_PITCH + 2);
      // Swoop in from about where the camera is now.
      const zoom = this.map.getZoom();
      const lat = this.map.getCenter().lat;
      const metresPerPixel = (40_075_016.686 * Math.cos(lat * DEG)) / (512 * 2 ** zoom);
      this.chaseDistanceM = 1.5 * this.options.container.clientHeight * metresPerPixel;
      this.chaseBearing = this.map.getBearing();
      this.chasePitch = this.map.getPitch();
      this.chaseZoom = 1;
      this.chaseYaw = 0;
      this.chasePitchGoal = CHASE_PITCH;
      this.takeMapHandlers(true);
      if (!this.following) this.setFollowing(true);
      this.chasing = true;
      this.layersDirty = true;
      this.setNearPlane(true);
      return;
    }
    this.chasing = false;
    this.layersDirty = true;
    this.setNearPlane(false);
    this.takeMapHandlers(false);
    if (!this.following) {
      this.map.setMaxPitch(MAX_PITCH);
      return;
    }
    // Back out to an ordinary follow: up and away, then the usual pitch limit.
    const durationMs = this.reducedMotion ? 0 : 900;
    void this.adjustFollow(
      { lon: 0, lat: 0, zoom: Math.min(this.map.getZoom() - 3, 11), pitch: 50 },
      { durationMs },
    );
    this.chaseRestore = window.setTimeout(() => this.map?.setMaxPitch(MAX_PITCH), durationMs + 50);
  }

  /** Turn MapLibre's own camera controls off while the 3D view has the camera, and back as they were. */
  private takeMapHandlers(take: boolean): void {
    type Handler = { isEnabled(): boolean; enable(): void; disable(): void };
    const map = this.map as unknown as Record<string, Handler | undefined>;
    const names = [
      "dragPan",
      "dragRotate",
      "scrollZoom",
      "touchZoomRotate",
      "touchPitch",
      "doubleClickZoom",
      "keyboard",
      "boxZoom",
    ];
    if (take && !this.savedHandlers) {
      this.savedHandlers = names.flatMap((name) => {
        const handler = map[name];
        if (!handler) return [];
        const enabled = handler.isEnabled();
        handler.disable();
        return [{ name, enabled }];
      });
    } else if (!take && this.savedHandlers) {
      for (const { name, enabled } of this.savedHandlers) if (enabled) map[name]?.enable();
      this.savedHandlers = null;
      this.chaseDrag = null;
    }
  }

  /**
   * The 3D view's own controls. The wheel moves the camera nearer or further
   * (up to CHASE_ZOOM_MAX times); dragging sideways turns it round the
   * aircraft, dragging up lifts it towards looking straight down.
   */
  private bindChaseControls(target: HTMLElement): void {
    const onWheel = (e: WheelEvent): void => {
      if (!this.chasing) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
      this.chaseZoom = clamp(
        this.chaseZoom * Math.exp(e.deltaY * unit * 0.0015),
        1,
        CHASE_ZOOM_MAX,
      );
    };
    const onDown = (e: PointerEvent): void => {
      if (!this.chasing || e.button > 0 || this.chaseDrag) return;
      this.chaseDrag = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        yaw: this.chaseYaw,
        pitch: this.chasePitchGoal,
      };
    };
    const onMove = (e: PointerEvent): void => {
      const drag = this.chaseDrag;
      if (!this.chasing || !drag || e.pointerId !== drag.id) return;
      this.chaseYaw = drag.yaw - (e.clientX - drag.x) * 0.3;
      this.chasePitchGoal = clamp(
        drag.pitch + (e.clientY - drag.y) * 0.25,
        CHASE_PITCH_RANGE[0],
        CHASE_PITCH_RANGE[1],
      );
    };
    const onUp = (e: PointerEvent): void => {
      if (this.chaseDrag?.id === e.pointerId) this.chaseDrag = null;
    };
    const wheelOptions: AddEventListenerOptions = { passive: false, capture: true };
    target.addEventListener("wheel", onWheel, wheelOptions);
    target.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    this.cleanup.push(() => {
      target.removeEventListener("wheel", onWheel, wheelOptions);
      target.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
    });
  }

  /** The overlay's view: deck.gl's globe with the near plane for the mode the camera is in. */
  private globeView(chasing: boolean): GlobeView {
    return new GlobeView({
      id: "mapbox",
      nearZMultiplier: chasing ? NEAR_Z_MULTIPLIER_CHASE : NEAR_Z_MULTIPLIER,
    });
  }

  private setNearPlane(chasing: boolean): void {
    this.overlay?.setProps({ views: this.globeView(chasing) } as object);
  }

  /** How much the chased aircraft is enlarged in the 3D view (see CHASE_MIN_DRAWN_M). */
  private chaseScale(size: number): number {
    return Math.max(1, CHASE_MIN_DRAWN_M / size);
  }

  /** The chased aircraft's size (larger of length and span, metres; a ship's length) and heading. */
  private chaseSubject(): { size: number; heading: number } {
    const found = this.selection ? this.batchIndex(this.selection) : null;
    if (!found) return { size: 40, heading: Number.NaN };
    if (this.selection?.kind === EntityKind.Ship) {
      return {
        size: shipModelOf(found.batch, found.index).lengthM,
        heading: found.batch.motion[found.index * MOTION_SIZE],
      };
    }
    const s = found.index * STYLE_SIZE;
    const spec = aircraftModel(
      found.batch.style[s + 3] || genericAircraftModel(found.batch.style[s]),
    );
    return {
      size: spec ? Math.max(spec.lengthM, spec.spanM) : 40,
      heading: found.batch.motion[found.index * MOTION_SIZE],
    };
  }

  /** Let go of the followed object: the camera stays where it is. */
  private endFollow(): void {
    this.following = false;
    if (this.chasing) {
      this.chasing = false;
      this.layersDirty = true;
      this.setNearPlane(false);
      this.takeMapHandlers(false);
      // The hand took over: put the pitch limit back at once.
      this.map?.setMaxPitch(MAX_PITCH);
    }
    this.followFrom = null;
    const adjust = this.followAdjust;
    this.followAdjust = null;
    adjust?.resolve();
  }

  private batchIndex(ref: EntityRef): { batch: RenderBatch; index: number } | null {
    const batch = this.batches.get(ref.kind);
    if (!batch) return null;
    const cached = this.locateIndex.get(ref.kind);
    if (cached && cached.seq === batch.seq && cached.id === ref.id) {
      return cached.index >= 0 ? { batch, index: cached.index } : null;
    }
    const index = indexOfId(batch, ref.id);
    this.locateIndex.set(ref.kind, { seq: batch.seq, id: ref.id, index });
    return index >= 0 ? { batch, index } : null;
  }

  locate(ref: EntityRef): { lon: number; lat: number; alt: number } | null {
    if (ref.kind === EntityKind.Cable) {
      const cables = this.paths.get("cables");
      const index = cables ? cables.ids.indexOf(ref.id) : -1;
      if (!cables || index < 0) return null;
      // A cable has no single position; its middle vertex is a fair anchor.
      const mid = (cables.startIndices[index] + cables.startIndices[index + 1]) >> 1;
      return { lon: cables.positions[mid * 2], lat: cables.positions[mid * 2 + 1], alt: 0 };
    }
    const found = this.batchIndex(ref);
    if (!found) return null;
    const [lon, lat, alt] = extrapolate(found.batch, found.index, this.now(), this.scratch);
    return { lon, lat, alt };
  }

  /** Height at which a kind is drawn for a true altitude, metres. */
  private drawnAltitude(kind: EntityKind, alt: number): number {
    return alt * (MOVERS[kind]?.altitudeScale ?? 0);
  }

  private placeRing(ring: Reticle, ref: EntityRef | null): boolean {
    ring.visible = false;
    if (!ref || ref.kind === EntityKind.Cable || !this.visible[layerForKind(ref.kind).id])
      return false;
    const found = this.batchIndex(ref);
    if (!found) return false;
    const [lon, lat, alt] = extrapolate(found.batch, found.index, this.now(), this.scratch);
    ring.lon = lon;
    ring.lat = lat;
    ring.alt = this.drawnAltitude(ref.kind, alt);
    // Only kinds drawn with a direction get a gap in their ring.
    const style = MOVERS[ref.kind];
    ring.heading = style ? found.batch.motion[found.index * MOTION_SIZE] : Number.NaN;
    // The ring sits clear of the silhouette it marks, however large that is drawn.
    const base = ring === this.hoverRing ? HOVER_RING_PX : SELECT_RING_PX;
    if (style) {
      const s = found.index * STYLE_SIZE;
      let half =
        sizeAtZoom(this.map.getZoom(), style.sizeZoomRange, style.sizePixels) *
        moverGlyphScale(style.glyph, found.batch.style[s], found.batch.style[s + 2]);
      if (ref.kind === EntityKind.Aircraft && this.modelsIndex >= 0) {
        // A 3D model is larger than the glyph it replaces: clear that instead.
        half = Math.max(half, this.modelHalfPixels(found.batch, found.index, lon, lat));
      }
      ring.diameter = Math.min(Math.max(base, 2 * half + (base - 10)), RING_MAX_PX);
    } else {
      ring.diameter = base;
    }
    ring.visible = true;
    return true;
  }

  private updateReticles(perfNow: number): void {
    // In the 3D view the aircraft fills the screen: a ring round it is only in the way.
    if (this.placeRing(this.selectRing, this.chasing ? null : this.selection)) {
      const t = this.reducedMotion ? 1 : clamp((perfNow - this.selectedAt) / SELECT_DRAW_MS, 0, 1);
      // Ease out: quick start, gentle close.
      this.selectRing.reveal = 1 - (1 - t) ** 3;
      this.selectRing.opacity = 1;
    }
    const hoverRef = this.hover && !sameRef(this.hover.ref, this.selection) ? this.hover.ref : null;
    if (this.placeRing(this.hoverRing, hoverRef)) {
      this.hoverRing.opacity = 0.5;
      this.hoverRing.reveal = 1;
    }
  }

  private toPickInfo(info: PickingInfo | null, x: number, y: number): PickInfo | null {
    if (!info?.layer || info.index < 0) return null;
    const id = info.layer.id;
    if (id === "paths-cables") {
      const cables = this.paths.get("cables");
      if (!cables) return null;
      // deck.gl picks a piece; a cable cut at the antimeridian is several.
      const pieces = this.preparedPaths(cables);
      if (info.index >= pieces.length) return null;
      const index = pieces.owners[info.index];
      const at = info.coordinate ?? [0, 0];
      return {
        ref: { kind: EntityKind.Cable, id: cables.ids[index] },
        layer: "cables",
        label: cables.names[index],
        x,
        y,
        lon: at[0],
        lat: at[1],
      };
    }
    for (const def of LAYERS) {
      if (def.kind === undefined || (id !== `movers-${def.id}` && id !== `markers-${def.id}`))
        continue;
      const batch = this.batches.get(def.kind);
      if (!batch || info.index >= batch.count) return null;
      const [lon, lat] = extrapolate(batch, info.index, this.now(), this.scratch);
      return { ref: { kind: def.kind, id: batch.ids[info.index] }, layer: def.id, x, y, lon, lat };
    }
    return null;
  }

  private pickAt(x: number, y: number, radius: number): PickInfo | null {
    if (!this.overlay || this.layers.length === 0) return null;
    this.isPicking = true;
    try {
      return this.toPickInfo(this.overlay.pickObject({ x, y, radius }), x, y);
    } catch {
      // The data canvas is not initialised yet.
      return null;
    } finally {
      this.isPicking = false;
    }
  }

  private pickHover(perfNow: number): void {
    // Hover means the pointer is resting over something: while the globe is
    // being dragged or is flying there is no hover, and the next pick waits
    // for the camera to stop.
    if (this.map.isMoving() && !this.following && !this.orbiting) {
      this.setHover(null);
      return;
    }
    this.hoverDirty = false;
    this.lastHoverPick = perfNow;
    this.setHover(this.pointer ? this.pickAt(this.pointer.x, this.pointer.y, 5) : null);
  }

  private setHover(next: PickInfo | null): void {
    const prev = this.hover;
    if (!next && !prev) return;
    const moved =
      next &&
      prev &&
      sameRef(next.ref, prev.ref) &&
      Math.abs(next.x - prev.x) + Math.abs(next.y - prev.y) < 1;
    if (moved) return;
    const changed = !sameRef(next?.ref ?? null, prev?.ref ?? null);
    this.hover = next;
    this.map.getCanvas().style.cursor = next ? "pointer" : "";
    if (changed && (next?.ref.kind === EntityKind.Cable || prev?.ref.kind === EntityKind.Cable))
      this.layersDirty = true;
    this.events.emit("hover", next);
  }

  private onClick(e: MapMouseEvent): void {
    const { x, y } = e.point;
    const now = performance.now();
    const last = this.lastClick;
    const touch =
      (e.originalEvent as PointerEvent | undefined)?.pointerType === "touch" ||
      "touches" in (e.originalEvent ?? {});
    if (
      last &&
      now - last.time < DOUBLE_TAP_MS &&
      Math.hypot(x - last.x, y - last.y) < DOUBLE_TAP_PX
    ) {
      this.lastClick = null;
      // Off the edge of the planet MapLibre reports the nearest point on the limb; that is not a place to dive to.
      const back = this.map.project(e.lngLat);
      if (Math.hypot(back.x - x, back.y - y) < 4) {
        this.events.emit("dive", { lon: wrapLon(e.lngLat.lng), lat: e.lngLat.lat });
      }
      return;
    }
    this.lastClick = { time: now, x, y };
    this.events.emit("pick", this.pickAt(x, y, touch ? 14 : 6));
  }

  private onInteract(): void {
    // In the 3D view the hand steers the camera round the aircraft (see bindChaseControls).
    if (this.chasing) return;
    // The hand on the globe wins at once: no frame of follow or orbit after this.
    this.endFollow();
    this.orbiting = false;
    const now = performance.now();
    if (now - this.lastInteract < 200) return;
    this.lastInteract = now;
    this.events.emit("interact", undefined);
  }

  // ── Camera ───────────────────────────────────────────────────────────────

  setOrbiting(orbiting: boolean): void {
    this.orbiting = orbiting;
  }

  setPadding(padding: { top: number; right: number; bottom: number; left: number }): void {
    this.padding = {
      top: padding.top,
      right: padding.right,
      bottom: padding.bottom,
      left: padding.left,
    };
    this.updateCreditLift();
    if (!this.map || sameInsets(this.map.getPadding(), this.padding)) return;
    // Easing the padding is a camera move, and would end a flight under way
    // or be ended by the next frame of follow or orbit. Those cases pick the
    // new padding up themselves; otherwise it eases in now.
    this.paddingDue = true;
    if (!this.flight && !this.drivesCamera()) this.settlePadding();
  }

  private cancelFlight(): void {
    const flight = this.flight;
    if (!flight) return;
    this.flight = null;
    this.map.stop();
    flight.resolve();
  }

  flyTo(target: CameraTarget, options: FlyOptions = {}): Promise<void> {
    if (!this.map || this.destroyed) return Promise.resolve();
    if (this.following && this.selection && !options.instant) {
      // A new zoom, bearing or pitch for the place the camera is already
      // riding along with (the HUD's zoom buttons, "face north") changes the
      // framing and keeps following.
      const at = this.locate(this.selection);
      const here =
        at && this.project(at.lon, at.lat, this.drawnAltitude(this.selection.kind, at.alt));
      const there = this.project(target.lon, target.lat);
      if (here && there && Math.hypot(here.x - there.x, here.y - there.y) < FOLLOW_NEAR_PX)
        return this.adjustFollow(target, options);
    }
    // Any other explicit camera move outranks follow mode.
    this.endFollow();
    this.cancelFlight();
    for (const t of this.fadeTimers) clearTimeout(t);
    this.fadeTimers = [];
    this.root.style.opacity = "";

    const here = this.map.getCenter();
    const camera = {
      center: [target.lon, target.lat] as [number, number],
      zoom: target.zoom ?? this.map.getZoom(),
      bearing: target.bearing ?? this.map.getBearing(),
      pitch: target.pitch ?? this.map.getPitch(),
    };

    if (options.instant) {
      this.map.jumpTo({ ...camera, padding: this.padding });
      this.paddingDue = false;
      return Promise.resolve();
    }

    const token = ++this.flightToken;
    return new Promise<void>((resolve) => {
      const done = (): void => {
        if (this.flight?.token === token) this.flight = null;
        resolve();
      };
      // The flight carries the padding with it, so it lands framed for the HUD as it now is.
      this.paddingDue = false;
      this.flight = { resolve: done, token };

      if (this.reducedMotion) {
        // No flight: fade out, cut, fade in.
        this.root.style.opacity = "0";
        this.fadeTimers.push(
          setTimeout(() => {
            this.map.jumpTo({ ...camera, padding: this.padding });
            this.root.style.opacity = "";
          }, FADE_MS / 2),
          setTimeout(done, FADE_MS),
        );
        return;
      }

      const duration =
        options.durationMs ??
        flyDurationMs(
          { lon: here.lng, lat: here.lat, zoom: this.map.getZoom() },
          { lon: target.lon, lat: target.lat, zoom: camera.zoom },
        );
      // Starting a flight ends whatever was moving (drag inertia, an earlier
      // ease) and MapLibre reports that with its own `moveend`, so listen only
      // once this flight is under way. `moveend` then fires whether the flight
      // lands or the person takes over.
      this.map.stop();
      this.map.flyTo({
        ...camera,
        padding: this.padding,
        duration,
        essential: true,
        curve: 1.3,
      });
      this.map.once("moveend", done);
      // If the map never reports the end (context lost, tab discarded), do not leave callers waiting.
      this.fadeTimers.push(setTimeout(done, duration + 1500));
    });
  }

  /** Ease to a new zoom, bearing and pitch without letting go of the followed object. */
  private adjustFollow(target: CameraTarget, options: FlyOptions): Promise<void> {
    const map = this.map;
    const previous = this.followAdjust;
    this.followAdjust = null;
    previous?.resolve();
    return new Promise<void>((resolve) => {
      this.followAdjust = {
        zoom: [map.getZoom(), target.zoom ?? map.getZoom()],
        bearing: [map.getBearing(), target.bearing ?? map.getBearing()],
        pitch: [map.getPitch(), target.pitch ?? map.getPitch()],
        startedAt: performance.now(),
        durationMs: this.reducedMotion ? 0 : (options.durationMs ?? FOLLOW_ADJUST_MS),
        resolve,
      };
    });
  }

  flyToEntity(ref: EntityRef, options?: FlyOptions): Promise<void> {
    const at = this.locate(ref);
    if (!at) return Promise.resolve();
    const zoom = this.map.getZoom();
    const wanted = framingZoom(ref.kind);
    // Already closer than the framing zoom: keep the person's zoom, just centre.
    return this.flyTo(
      { lon: at.lon, lat: at.lat, zoom: zoom > wanted && zoom < wanted + 4 ? zoom : wanted },
      options,
    );
  }

  getView(): ViewState {
    const map = this.map;
    const center = map.getCenter();
    const zoom = map.getZoom();
    const pitch = map.getPitch();
    const canvas = map.getContainer();
    const now = map.getPadding();
    const global = globeFitsView({
      zoom,
      lat: center.lat,
      pitch,
      width: canvas.clientWidth,
      height: canvas.clientHeight,
      // Padding slides the disc across the canvas; see `globeFitsView`.
      padding: {
        top: now.top ?? 0,
        right: now.right ?? 0,
        bottom: now.bottom ?? 0,
        left: now.left ?? 0,
      },
    });
    const b = map.getBounds();
    return {
      lon: wrapLon(center.lng),
      lat: center.lat,
      zoom,
      bearing: map.getBearing(),
      pitch,
      bounds: global
        ? [-180, -90, 180, 90]
        : normaliseBounds(b.getWest(), b.getSouth(), b.getEast(), b.getNorth()),
      global,
    };
  }

  private scheduleViewEmit(delayMs: number): void {
    if (this.viewTimer) clearTimeout(this.viewTimer);
    // While following or orbiting the camera never settles; report at a steady, slow rate instead.
    const sinceLast = performance.now() - this.lastViewEmit;
    const wait = this.following || this.orbiting ? Math.max(delayMs, 1000 - sinceLast) : delayMs;
    this.viewTimer = setTimeout(() => {
      this.viewTimer = null;
      if (this.destroyed) return;
      this.lastViewEmit = performance.now();
      this.events.emit("view", this.getView());
    }, wait);
  }

  /** The deck.gl viewport matching the map's camera, as the data canvas uses it. */
  private currentViewport(): GlobeViewport | WebMercatorViewport {
    if (this.viewport) return this.viewport;
    const map = this.map;
    const center = map.getCenter();
    const container = map.getContainer();
    const options = {
      width: container.clientWidth,
      height: container.clientHeight,
      longitude: wrapLon(center.lng),
      latitude: center.lat,
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
      padding: map.getPadding(),
    };
    this.viewport =
      options.zoom > GLOBE_MAX_ZOOM ? new WebMercatorViewport(options) : new GlobeViewport(options);
    return this.viewport;
  }

  project(lon: number, lat: number, alt = 0): { x: number; y: number } | null {
    if (!this.map) return null;
    const viewport = this.currentViewport();
    if (viewport instanceof GlobeViewport) {
      const visible = haloVisibility(
        viewport.cameraPosition,
        globeCommon(lon, lat, alt, this.scratch),
      );
      if (visible < 0.5) return null;
    }
    const [x, y] = viewport.project([lon, lat, alt]);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }

  // ── Quality and motion ───────────────────────────────────────────────────

  private pixelRatio(): number {
    return Math.min(window.devicePixelRatio || 1, QUALITY[this.quality].maxPixelRatio);
  }

  /** Label and tile fade for the map: none on the low tier or under reduced motion. */
  private mapFadeMs(): number {
    return this.reducedMotion ? 0 : QUALITY[this.quality].mapFadeMs;
  }

  private applyMapFade(): void {
    // MapLibre 6.18 takes `fadeDuration` only as a constructor option and has
    // no setter; it does read the field afresh on every render (checked in
    // its source), so writing it is enough.
    (this.map as unknown as { _fadeDuration: number })._fadeDuration = this.mapFadeMs();
  }

  private applyQuality(tier: QualityTier): void {
    this.quality = tier;
    this.governor.reset();
    this.refresh.reset();
    if (!this.map) return;
    const ratio = this.pixelRatio();
    this.map.setPixelRatio(ratio);
    this.overlay.setProps({ useDevicePixels: ratio });
    this.applyMapFade();
    this.layersDirty = true;
    this.updateSky(true);
  }

  setQuality(tier: QualityTier): void {
    // What is asked for is the ceiling: the engine may go below it to hold
    // the frame rate and climbs back to it, never past it.
    this.governor.setCeiling(tier);
    if (tier !== this.quality && (costlier(this.quality, tier) || this.canAfford(tier)))
      this.applyQuality(tier);
  }

  /** A costlier tier asked for by hand is tried, unless the governor has already seen it fail. */
  private canAfford(tier: QualityTier): boolean {
    return Number.isFinite(this.governor.windowsToTry(tier));
  }

  setReducedMotion(reduced: boolean): void {
    if (reduced === this.reducedMotion) return;
    this.reducedMotion = reduced;
    this.layersDirty = true;
    if (reduced) this.followFrom = null;
    if (!this.map) return;
    // Labels and tiles stop fading in, and overlay frames cut instead of cross-fading.
    this.applyMapFade();
    if (this.loaded) {
      for (const entry of this.overlays.values()) entry.raster?.setReducedMotion(reduced);
    }
  }

  // ── Events and teardown ──────────────────────────────────────────────────

  on<K extends keyof EngineEvents>(
    type: K,
    handler: (payload: EngineEvents[K]) => void,
  ): () => void {
    return this.events.on(type, handler);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.frameHandle);
    if (this.viewTimer) clearTimeout(this.viewTimer);
    if (this.canvasTimer) clearTimeout(this.canvasTimer);
    for (const t of this.fadeTimers) clearTimeout(t);
    this.flight?.resolve();
    this.flight = null;
    this.endFollow();
    this.dataCanvas?.removeEventListener("webglcontextlost", this.onDataContextLost);
    for (const fn of this.cleanup) fn();
    this.events.clear();
    this.creditLine?.remove();
    // Removing the map removes its controls, which finalises the deck.gl canvas too.
    this.map?.remove();
    this.root.remove();
    this.batches.clear();
    this.density.clear();
    this.paths.clear();
    this.overlays.clear();
  }
}
