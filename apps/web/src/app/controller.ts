/**
 * The controller is the only code that knows the store, the engine and the
 * data worker at once. It carries messages between them and owns behaviour
 * that spans all three: selection, follow, the clock, the opening shot, idle.
 *
 * It starts the data worker straight away and loads the engine (MapLibre,
 * deck.gl) with a dynamic import, so the HUD shell is interactive first.
 */
import { LAYER_IDS, layerForKind } from "@orya-halo/schema";
import type {
  Attribution,
  DataMessage,
  EntityRef,
  HaloEvent,
  LayerId,
  Track,
} from "@orya-halo/schema";
import type { DataClient } from "../core/data.ts";
import type { HaloEngine, PickInfo } from "../core/engine.ts";
import { onIntent, useHalo } from "../core/store.ts";
import type { HaloState, Intent, TrackSeries } from "../core/store.ts";
import { assetBase, dataConfig } from "./config.ts";
import { guessRegion, midnightLongitude } from "./region.ts";
import { provideServices } from "../core/services.ts";
import type { SourceSummary } from "@orya-halo/schema";
import { formatUrlState, parseUrlState, shareUrl } from "./url.ts";

/** Seconds without input before the HUD fades. */
const IDLE_FADE_MS = 8_000;
/** Seconds without input before the globe starts to drift and tour live events. */
const IDLE_ORBIT_MS = 60_000;
/** Pause between automatic visits to notable events while idle. */
const IDLE_TOUR_MS = 40_000;
/** With a detail panel open the fade waits longer: someone may be reading it. */
const IDLE_FADE_READING_MS = 30_000;
/** How often the open detail panel is refreshed with live values. */
const DETAIL_REFRESH_MS = 2_000;

/**
 * Short credits for the on-map line, by source id. Licences ask for credit
 * on the map; the full wording lives on the attribution page. Sources not
 * listed fall back to their provider name.
 */
/**
 * Short on-map credits by source id. Plugin ids and, while a gateway is
 * connected, its upstreams (`gateway-` plus the id in `/v1/attribution`). An empty
 * text means no credit is required (route data is CC0).
 */
const MAP_CREDITS: Record<string, string> = {
  "gateway-aircraft": "adsb.lol (ODbL)",
  "gateway-ships": "Fintraffic CC BY 4.0",
  // The gateway's own upstreams, as the data worker names them.
  "gateway-adsb-lol": "adsb.lol (ODbL)",
  "gateway-vrs-standing-data": "",
  "gateway-digitraffic": "Fintraffic CC BY 4.0",
  "gateway-aisstream": "AISStream.io",
  "gateway-nasa-firms": "NASA FIRMS",
  "gateway-celestrak-gp": "CelesTrak",
  "celestrak-gp": "CelesTrak",
  "usgs-quakes": "USGS",
  "osm-cables": "© OpenStreetMap",
  "rainviewer-radar": "RainViewer",
  "gibs-imerg": "NASA GIBS",
  "gibs-truecolour": "NASA GIBS",
  "nasa-firms": "NASA FIRMS",
  "digitraffic-weathercams": "Fintraffic CC BY 4.0",
  "hk-traffic-cameras": "Transport Department, HKSAR",
  "sg-lta-traffic-images": "Traffic Images: LTA, Singapore ODL 1.0",
  "drivebc-highwaycams": "DriveBC, OGL – British Columbia",
  "calgary-traffic-cameras": "City of Calgary, OGL – Calgary",
  "austin-traffic-cameras": "City of Austin",
};

const SERIES_POINTS = 96;
const DEG = Math.PI / 180;

/** Altitude over time for things that fly, speed over ground for ships. */
export function trackSeries(track: Track): TrackSeries | null {
  const n = track.count;
  if (n < 3) return null;
  const ship = track.ref.kind === 2;
  const step = Math.max(1, Math.floor(n / SERIES_POINTS));
  const timesMs: number[] = [];
  const values: number[] = [];
  for (let i = ship ? step : 0; i < n; i += step) {
    const p = i * 3;
    if (ship) {
      const q = (i - step) * 3;
      const dt = (track.timesMs[i] - track.timesMs[i - step]) / 1000;
      if (!(dt > 0)) continue;
      const lat = track.positions[p + 1] * DEG;
      const dLat = (track.positions[p + 1] - track.positions[q + 1]) * DEG;
      const dLon =
        (((track.positions[p] - track.positions[q] + 540) % 360) - 180) * DEG * Math.cos(lat);
      values.push((Math.hypot(dLat, dLon) * 6_371_008.8) / dt);
    } else {
      values.push(track.positions[p + 2]);
    }
    timesMs.push(track.timesMs[i]);
  }
  return values.length >= 3 ? { measure: ship ? "speed" : "altitude", timesMs, values } : null;
}

const sameRef = (a: EntityRef | null, b: EntityRef | null): boolean =>
  a === b || (a !== null && b !== null && a.kind === b.kind && a.id === b.id);

const enabledLayers = (layers: HaloState["layers"]): LayerId[] =>
  LAYER_IDS.filter((id) => layers[id].enabled);

export interface Controller {
  destroy(): void;
}

export async function startController(container: HTMLElement): Promise<Controller> {
  const store = useHalo;
  const actions = store.getState().actions;
  const cleanups: (() => void)[] = [];
  let destroyed = false;

  // --- Starting state: URL first, then defaults ------------------------------
  const url = parseUrlState(location.hash);
  if (url.layers) {
    const wanted = new Set(url.layers);
    for (const id of LAYER_IDS) actions.setLayerEnabled(id, wanted.has(id));
  }
  const motionQuery = matchMedia("(prefers-reduced-motion: reduce)");
  actions.setReducedMotion(motionQuery.matches);
  const onMotionChange = () => actions.setReducedMotion(motionQuery.matches);
  motionQuery.addEventListener("change", onMotionChange);
  cleanups.push(() => motionQuery.removeEventListener("change", onMotionChange));

  const layerFlags = () =>
    Object.fromEntries(LAYER_IDS.map((id) => [id, store.getState().layers[id].enabled])) as Record<
      LayerId,
      boolean
    >;

  // --- Data worker ------------------------------------------------------------
  // Messages that arrive before the engine exists are kept (latest per kind or
  // layer) and replayed once it does.
  let engine: HaloEngine | null = null;
  const pending = new Map<string, DataMessage>();

  const toEngine = (message: DataMessage): boolean => {
    if (!engine) return false;
    switch (message.type) {
      case "batch":
        engine.setBatch(message.batch);
        return true;
      case "density":
        engine.setDensity(message.grid);
        return true;
      case "paths":
        engine.setPaths(message.layer, message.paths);
        return true;
      case "tiles":
        // The overlay's credit reaches the map through `setCredits`, in its short form.
        engine.setTiles(
          message.layer,
          message.overlay ? { ...message.overlay, attribution: undefined } : null,
        );
        return true;
      case "track":
        engine.setTrack(message.track);
        return true;
      default:
        return true;
    }
  };

  const pendingKey = (message: DataMessage): string | null => {
    switch (message.type) {
      case "batch":
        return `batch:${message.batch.kind}`;
      case "density":
        return `density:${message.grid.kind}`;
      case "paths":
      case "tiles":
        return `${message.type}:${message.layer}`;
      case "track":
        return "track";
      default:
        return null;
    }
  };

  const onData = (message: DataMessage): void => {
    switch (message.type) {
      case "layer":
        actions.setLayerState(message.layer, message.state);
        if (message.layer === "aircraft" || message.layer === "ships") {
          const { aircraft, ships } = store.getState().layers;
          const reachable = (s: string) => s === "live" || s === "degraded" || s === "needs-key";
          actions.setGatewayOnline(reachable(aircraft.status) || reachable(ships.status));
        }
        return;
      case "events":
        actions.pushEvents(message.events);
        return;
      case "history":
        actions.setHistory({ fromMs: message.fromMs, toMs: message.toMs });
        return;
      case "track":
        actions.setTrackSeries(message.track ? trackSeries(message.track) : null);
        if (!toEngine(message)) pending.set("track", message);
        return;
      default: {
        if (!toEngine(message)) {
          const key = pendingKey(message);
          if (key) pending.set(key, message);
        }
      }
    }
  };

  const { createDataClient } = await import("../data/index.ts");
  const data: DataClient = await createDataClient(dataConfig(layerFlags()));
  cleanups.push(data.onMessage(onData));
  cleanups.push(() => data.dispose());

  provideServices({
    search: (query) => {
      const view = store.getState().view;
      return data.api.search(query, view ? { lon: view.lon, lat: view.lat } : undefined);
    },
    getAttributions: () => data.api.getAttributions(),
    shareUrl: () => {
      const s = store.getState();
      return shareUrl(s.view, enabledLayers(s.layers), s.selection);
    },
  });
  cleanups.push(() => provideServices(null));

  // --- Engine -----------------------------------------------------------------
  const skipIntro = Boolean(url.view) || store.getState().reducedMotion;
  const region = guessRegion();
  const openingView = url.view ?? {
    lon: skipIntro ? region.lon : midnightLongitude(),
    lat: skipIntro ? region.lat : 18,
    zoom: skipIntro ? 2.4 : 1.5,
  };

  const { createEngine } = await import("../engine/index.ts");
  if (destroyed) {
    data.dispose();
    return { destroy() {} };
  }
  const created = await createEngine({
    container,
    initialView: openingView,
    reducedMotion: store.getState().reducedMotion,
    quality: store.getState().quality,
    assetBase,
    layers: layerFlags(),
  });
  engine = created;
  cleanups.push(() => created.destroy());
  for (const message of pending.values()) toEngine(message);
  pending.clear();

  // --- On-map credits for whatever is showing ---------------------------------------
  let sources: SourceSummary[] = [];
  const applyCredits = (): void => {
    const layers = store.getState().layers;
    const seen = new Set<string>();
    const credits: Attribution[] = [];
    for (const source of sources) {
      const text = MAP_CREDITS[source.id] ?? source.name;
      const layer = layers[source.layer];
      // Credit what is on screen: a layer that is off, still loading or
      // offline shows none of the provider's data.
      const showing = layer.enabled && (layer.status === "live" || layer.status === "degraded");
      if (!showing || !text || seen.has(text)) continue;
      seen.add(text);
      credits.push({ text, url: source.attributionUrl });
    }
    created.setCredits(credits);
  };
  void data.api.getAttributions().then((list) => {
    if (destroyed) return;
    sources = list;
    applyCredits();
  });

  // --- Engine events ------------------------------------------------------------
  let lastInputMs = performance.now();
  let orbitingForIdle = false;
  let introDone = skipIntro;
  let introTimer = 0;

  const finishIntro = (fly: boolean): void => {
    if (introDone) return;
    introDone = true;
    clearTimeout(introTimer);
    created.setOrbiting(false);
    actions.setIntro("arrive");
    const land = () => !destroyed && actions.setIntro("done");
    if (fly)
      void created
        .flyTo({ lon: region.lon, lat: region.lat, zoom: 2.6 }, { durationMs: 2600 })
        .then(land);
    else land();
  };

  const noteInput = (): void => {
    lastInputMs = performance.now();
    if (store.getState().idle) actions.setIdle(false);
    if (orbitingForIdle) {
      orbitingForIdle = false;
      created.setOrbiting(false);
    }
    // Any input ends the opening shot where it stands.
    if (!introDone) finishIntro(false);
  };

  cleanups.push(
    created.on("view", (view) => {
      actions.setView(view);
      void data.api.setView(view);
      scheduleUrlUpdate();
    }),
    created.on("pick", (pick) => actions.select(pick ? pick.ref : null)),
    created.on("hover", (hover) => showHover(hover)),
    created.on("dive", ({ lon, lat }) => {
      const zoom = Math.min(created.getView().zoom + 2.5, 15);
      void created.flyTo({ lon, lat, zoom });
    }),
    created.on("interact", () => {
      noteInput();
      if (store.getState().following) actions.setFollowing(false);
    }),
    created.on("fps", (fps) => actions.setFps(fps)),
    created.on("quality", (quality) => actions.setQuality(quality)),
    created.on("status", (status) => actions.setEngineStatus(status)),
    created.on("chaseEnded", () => actions.setChase(false)),
  );

  actions.setEngineStatus(created.getStatus());

  // Hover tag: the engine knows where, the worker knows the name.
  let hoverToken = 0;
  const showHover = (hover: PickInfo | null): void => {
    const token = ++hoverToken;
    if (!hover || hover.label) {
      actions.setHover(hover ? { ...hover, title: hover.label } : null);
      return;
    }
    actions.setHover(hover);
    void data.api.getSummary(hover.ref).then((summary) => {
      if (token !== hoverToken || !summary) return;
      const tail = summary.value
        ? `  ${summary.value}${summary.unit ? ` ${summary.unit}` : ""}`
        : "";
      actions.setHover({
        ...hover,
        label: `${summary.title}${tail}`,
        title: summary.title,
        value: summary.value,
        unit: summary.unit,
      });
    });
  };

  // --- Store → engine and worker ---------------------------------------------------
  cleanups.push(
    store.subscribe(
      (s) => s.layers,
      (layers, previous) => {
        for (const id of LAYER_IDS) {
          if (layers[id].enabled === previous[id].enabled) continue;
          created.setLayerVisible(id, layers[id].enabled);
          void data.api.setLayerEnabled(id, layers[id].enabled);
          scheduleUrlUpdate();
        }
        applyCredits();
      },
    ),
    store.subscribe(
      (s) => s.clock,
      (clock, previous) => {
        created.setClock(clock);
        // The live clock ticks every second; the worker only needs mode changes and scrub moves.
        if (clock.mode === "scrub" || previous.mode !== clock.mode) void data.api.setClock(clock);
      },
    ),
    store.subscribe(
      (s) => s.following,
      (following) => created.setFollowing(following),
    ),
    store.subscribe(
      (s) => s.chase,
      (chase) => created.setChase(chase),
    ),
    store.subscribe(
      (s) => s.reducedMotion,
      (reduced) => created.setReducedMotion(reduced),
    ),
    store.subscribe(
      (s) => s.selection,
      (selection, previous) => {
        if (sameRef(selection, previous)) return;
        onSelection(selection);
      },
    ),
  );

  // --- Selection ---------------------------------------------------------------------
  let detailTimer = 0;
  let selectionToken = 0;

  const loadDetail = async (ref: EntityRef, token: number, first: boolean): Promise<void> => {
    try {
      const detail = await data.api.getDetail(ref);
      if (token !== selectionToken) return;
      if (detail) actions.setDetail(detail, "ready");
      else if (first) actions.setDetail(null, "missing");
    } catch {
      if (token === selectionToken && first) actions.setDetail(null, "missing");
    }
  };

  /** Keep camera targets clear of whatever the HUD has open over the globe. */
  const applyPadding = (selection: EntityRef | null): void => {
    const phone = window.innerWidth < 720;
    // On a phone the detail sheet reports what it covers; frame above it.
    const sheet = phone ? (store.getState().bottomInset ?? 0) : 0;
    created.setPadding({
      top: 64,
      left: phone ? 0 : 240,
      right: selection && !phone ? 372 : 0,
      bottom: phone ? Math.max(selection ? 280 : 120, sheet + 8) : 72,
    });
  };
  applyPadding(null);
  cleanups.push(
    store.subscribe(
      (s) => s.bottomInset,
      () => applyPadding(store.getState().selection),
    ),
  );
  // Crossing the phone breakpoint swaps the HUD's layout, and with it the insets.
  let resizeFrame = 0;
  const onResize = (): void => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => applyPadding(store.getState().selection));
  };
  window.addEventListener("resize", onResize);
  cleanups.push(() => {
    window.removeEventListener("resize", onResize);
    cancelAnimationFrame(resizeFrame);
  });

  const onSelection = (selection: EntityRef | null): void => {
    const token = ++selectionToken;
    applyPadding(selection);
    clearInterval(detailTimer);
    created.setSelection(selection);
    void data.api.setTracked(selection);
    scheduleUrlUpdate();
    if (!selection) {
      created.setTrack(null);
      return;
    }
    const layer = layerForKind(selection.kind).id;
    if (!store.getState().layers[layer].enabled) actions.setLayerEnabled(layer, true);
    void created.flyToEntity(selection);
    void loadDetail(selection, token, true);
    detailTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadDetail(selection, token, false);
    }, DETAIL_REFRESH_MS);
  };
  cleanups.push(() => clearInterval(detailTimer));

  // --- Camera requests from the HUD -----------------------------------------------------
  const onCameraIntent = (intent: Intent): void => {
    noteInput();
    const view = created.getView();
    switch (intent.type) {
      case "fly":
        actions.setFollowing(false);
        void created.flyTo({
          lon: intent.lon,
          lat: intent.lat,
          zoom: intent.zoom ?? Math.max(view.zoom, 5),
        });
        break;
      case "fly-entity":
        void created.flyToEntity(intent.ref);
        break;
      case "reset-north":
        void created.flyTo(
          { lon: view.lon, lat: view.lat, zoom: view.zoom, bearing: 0, pitch: 0 },
          { durationMs: 600 },
        );
        break;
      case "zoom":
        void created.flyTo(
          {
            lon: view.lon,
            lat: view.lat,
            zoom: Math.min(Math.max(view.zoom + intent.delta, 0.8), 18),
          },
          { durationMs: 450 },
        );
        break;
      case "home":
        actions.setFollowing(false);
        void created.flyTo({ lon: region.lon, lat: region.lat, zoom: 2.6, bearing: 0, pitch: 0 });
        break;
    }
  };
  cleanups.push(onIntent(onCameraIntent));

  // --- Shareable URL -----------------------------------------------------------------------
  let urlTimer = 0;
  const scheduleUrlUpdate = (): void => {
    clearTimeout(urlTimer);
    urlTimer = window.setTimeout(() => {
      const s = store.getState();
      if (s.intro !== "done") return;
      history.replaceState(null, "", formatUrlState(s.view, enabledLayers(s.layers), s.selection));
    }, 400);
  };
  cleanups.push(() => clearTimeout(urlTimer));

  // --- Clock, idle fade, idle tour -------------------------------------------------------------
  const inputEvents = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"] as const;
  for (const type of inputEvents) window.addEventListener(type, noteInput, { passive: true });
  cleanups.push(() => {
    for (const type of inputEvents) window.removeEventListener(type, noteInput);
  });

  let lastTourMs = 0;
  let toured = new Set<string>();
  const tourTarget = (events: HaloEvent[]): HaloEvent | undefined =>
    events.find(
      (e) =>
        e.lon !== undefined && e.lat !== undefined && !toured.has(e.id) && (e.severity ?? 0) >= 1,
    ) ?? events.find((e) => e.lon !== undefined && e.lat !== undefined && !toured.has(e.id));

  const heartbeat = window.setInterval(() => {
    const now = performance.now();
    const s = store.getState();
    actions.tick(Date.now());
    if (s.intro !== "done" || document.visibilityState !== "visible") return;

    const quietMs = now - lastInputMs;
    // Reading a panel, typing a search or riding along with something is not idleness.
    const engaged = s.searchOpen || s.overlay !== "none" || s.following;
    const fadeAfter = s.selection ? IDLE_FADE_READING_MS : IDLE_FADE_MS;
    if (!s.idle && !engaged && quietMs > fadeAfter) actions.setIdle(true);

    if (engaged || s.reducedMotion || quietMs < IDLE_ORBIT_MS || s.selection) return;
    if (!orbitingForIdle) {
      orbitingForIdle = true;
      created.setOrbiting(true);
      lastTourMs = now;
      return;
    }
    if (now - lastTourMs > IDLE_TOUR_MS) {
      lastTourMs = now;
      const target = tourTarget(s.events);
      if (!target) {
        toured = new Set();
        return;
      }
      toured.add(target.id);
      created.setOrbiting(false);
      void created
        .flyTo(
          { lon: target.lon as number, lat: target.lat as number, zoom: 4.2 },
          { durationMs: 5000 },
        )
        .then(() => {
          if (orbitingForIdle && !destroyed) created.setOrbiting(true);
        });
    }
  }, 1000);
  cleanups.push(() => clearInterval(heartbeat));

  // --- Opening shot ----------------------------------------------------------------------------
  // Let the first data settle so a batch arriving mid-flight never hitches the camera.
  const sendFirstView = () => void data.api.setView(created.getView());
  sendFirstView();

  if (skipIntro) {
    actions.setIntro("done");
    if (url.selection) actions.select(url.selection);
  } else {
    actions.setIntro("globe");
    created.setOrbiting(true);
    introTimer = window.setTimeout(() => finishIntro(true), 2400);
    cleanups.push(() => clearTimeout(introTimer));
  }

  return {
    destroy() {
      destroyed = true;
      for (const cleanup of cleanups.reverse()) cleanup();
      engine = null;
    },
  };
}
