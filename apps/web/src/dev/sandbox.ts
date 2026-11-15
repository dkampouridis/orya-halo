/**
 * Engine sandbox and performance harness. Mounts the engine on its own, with
 * synthetic data, so it can be developed and profiled without the rest of the
 * app. Open /sandbox.html; everything is driven by the query string:
 *
 *   n=20000        moving objects (aircraft, ships, satellites)
 *   interval=1000  milliseconds between batches (0 sends one batch and stops)
 *   lon, lat, zoom, pitch, bearing   starting camera
 *   t=2026-06-21T12:00:00Z           scrub the clock to a moment (default: live)
 *   quality=high|balanced|low
 *   pin=1          hold that tier: the governor is switched off, to time one tier on its own
 *   rm=1           reduced motion
 *   layers=aircraft,ships,...        only these layers on; layers=all for every data layer
 *                                    (default: the layers the app starts with)
 *   select=aircraft                  select the object of that layer nearest the view centre
 *   follow=1, orbit=1, chase=1 (the 3D view behind a selected aircraft)
 *   pad=top,right,bottom,left        camera padding in CSS pixels, as the HUD would set it
 *   credits=long   several long credits, to see the credit line wrap (default: one short one)
 *   overlay=radar  an animated raster overlay with thirteen frames; its tiles come from a
 *                  host that does not exist, so it only shows under scripts/check-overlays.mjs
 *   hud=0          hide the statistics readout
 *   modelgrid=1    every 3D aircraft model in a row-by-row grid at the starting camera,
 *                  all heading north-east, in place of the synthetic aircraft
 *                  (modelgrid=bank adds a 25-degree bank and a climb to every other one)
 *
 * Keys: 1-0 toggle layers, F follow, O orbit, Q cycle quality, M reduced motion, L live/scrub.
 * `window.__halo` exposes the engine and frame statistics for scripts/shot.mjs.
 */
import {
  createRenderBatch,
  AIRCRAFT_MODELS,
  EntityKind,
  LAYERS,
  LAYER_IDS,
  layerDef,
  layerForKind,
} from "@orya-halo/schema";
import type { Attribution, EntityRef, LayerId, RenderBatch, TileOverlay } from "@orya-halo/schema";
import type { HaloEngine, PickInfo, QualityTier } from "../core/engine.ts";
import type { EngineStatus } from "../engine/status.ts";
import {
  SyntheticWorld,
  syntheticCables,
  syntheticFires,
  syntheticQuakes,
  syntheticWebcams,
} from "./synthetic.ts";

const params = new URLSearchParams(location.search);
const num = (key: string, fallback: number): number => {
  const raw = params.get(key);
  const value = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

const moverCount = Math.max(0, Math.round(num("n", 20000)));
const interval = num("interval", 1000);
const scrubTo = params.get("t") ? Date.parse(params.get("t") as string) : Number.NaN;
const startMs = Number.isFinite(scrubTo) ? scrubTo : Date.now();
const quality = (params.get("quality") as QualityTier | null) ?? "high";
const reducedMotion = params.get("rm") === "1";

const only = params.get("layers")?.split(",").filter(Boolean);
const layers = {} as Record<LayerId, boolean>;
for (const id of LAYER_IDS) {
  const def = layerDef(id);
  layers[id] = !only
    ? def.defaultOn
    : only.includes("all")
      ? def.shape !== "tiles"
      : only.includes(id);
}

/** The sandbox's own data is made up, and says so on the map. */
const CREDITS: Attribution[] = [
  { text: "Synthetic sandbox data", url: "https://example.org/sandbox" },
];
const LONG_CREDITS: Attribution[] = [
  { text: "Aircraft positions: a community receiver network", url: "https://example.org/aircraft" },
  { text: "Satellite elements: an orbital catalogue", url: "https://example.org/satellites" },
  { text: "Earthquakes: a national seismic survey", url: "https://example.org/quakes" },
  { text: "Undersea cables: an open cable map", url: "https://example.org/cables" },
  { text: "Unlinked credit", url: "not a link" },
];

/** Host for the test overlay's tiles. Nothing answers there; scripts/check-overlays.mjs stands in for it. */
export const OVERLAY_HOST = "https://tiles.halo-sandbox.invalid";

/** Thirteen frames ten minutes apart, ending at `nowMs`, shaped like the rain radar's. */
function testOverlay(nowMs: number): TileOverlay {
  const frames = Array.from({ length: 13 }, (_, i) => ({
    timeMs: nowMs - (12 - i) * 600_000,
    tiles: [`${OVERLAY_HOST}/radar/f${i}/{z}/{x}/{y}.png`],
  }));
  return {
    tiles: frames[12].tiles,
    tileSize: 512,
    minZoom: 0,
    maxZoom: 7,
    opacity: 0.7,
    frames,
    timeMs: nowMs,
    attribution: { text: "Test radar tiles", url: "https://example.org/radar", onMap: true },
  };
}

interface FrameStats {
  fps: number;
  quality: QualityTier;
  /** Every tier change the engine made by itself, with the seconds since start. */
  qualityLog: { at: number; tier: QualityTier }[];
  /** Milliseconds between animation frames over the last sampling window. */
  frameMs: { mean: number; p50: number; p95: number; p99: number; max: number; samples: number };
  ready: boolean;
  status: EngineStatus | null;
  lastPick: PickInfo | null;
  lastHover: PickInfo | null;
  counts: Record<string, number>;
}

const stats: FrameStats = {
  fps: 0,
  quality,
  qualityLog: [],
  frameMs: { mean: 0, p50: 0, p95: 0, p99: 0, max: 0, samples: 0 },
  ready: false,
  status: null,
  lastPick: null,
  lastHover: null,
  counts: {},
};

/** Frame-to-frame times, measured the same way a person would see them: by animation frames. */
class FrameMeter {
  private samples: number[] = [];
  private last = 0;
  private handle = 0;

  start(): void {
    this.samples = [];
    this.last = 0;
    cancelAnimationFrame(this.handle);
    const tick = (now: number): void => {
      if (this.last) this.samples.push(now - this.last);
      this.last = now;
      this.handle = requestAnimationFrame(tick);
    };
    this.handle = requestAnimationFrame(tick);
  }

  read(): FrameStats["frameMs"] {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const at = (q: number): number =>
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
    const mean = sorted.reduce((sum, v) => sum + v, 0) / Math.max(sorted.length, 1);
    return {
      mean,
      p50: at(0.5),
      p95: at(0.95),
      p99: at(0.99),
      max: sorted[sorted.length - 1] ?? 0,
      samples: sorted.length,
    };
  }
}

async function main(): Promise<void> {
  // The HUD loads the interface typeface in the app; here the credit line
  // needs it too. Development only, so the font stays out of the measured build.
  if (import.meta.env.DEV) void import("@fontsource-variable/archivo/standard.css");
  const container = document.getElementById("globe") as HTMLElement;
  const readout = document.getElementById("stats") as HTMLElement;
  if (params.get("hud") === "0") readout.hidden = true;

  // The engine is a dynamic import here too, exactly as the app loads it.
  const { createEngine } = await import("../engine/index.ts");
  const engine: HaloEngine = await createEngine({
    container,
    initialView: {
      lon: num("lon", 12),
      lat: num("lat", 28),
      zoom: num("zoom", 1.7),
      pitch: num("pitch", 0),
      bearing: num("bearing", 0),
    },
    reducedMotion,
    quality,
    assetBase: import.meta.env.BASE_URL,
    layers,
  });

  const world = new SyntheticWorld({ movers: moverCount }, startMs);
  const clock = {
    mode: Number.isFinite(scrubTo) ? ("scrub" as const) : ("live" as const),
    timeMs: startMs,
  };
  engine.setClock(clock);
  const worldNow = (): number => (clock.mode === "live" ? Date.now() : clock.timeMs);

  const pad = params.get("pad")?.split(",").map(Number);
  if (pad?.length === 4 && pad.every(Number.isFinite))
    engine.setPadding({ top: pad[0], right: pad[1], bottom: pad[2], left: pad[3] });
  engine.setCredits(params.get("credits") === "long" ? LONG_CREDITS : CREDITS);
  if (params.get("overlay") === "radar") {
    layers.radar = true;
    engine.setLayerVisible("radar", true);
    engine.setTiles("radar", testOverlay(startMs));
  }

  stats.status = engine.getStatus();
  engine.on("status", (status) => {
    stats.status = status;
  });

  const latest = new Map<EntityKind, RenderBatch>();
  const gridMode = params.get("modelgrid");
  const push = (): void => {
    for (const batch of world.batches(worldNow())) {
      if (gridMode && batch.kind === EntityKind.Aircraft) {
        const grid = modelGrid(num("lon", 0), num("lat", 0), worldNow(), gridMode === "bank");
        latest.set(grid.kind, grid);
        stats.counts.aircraft = grid.count;
        engine.setBatch(grid);
        continue;
      }
      latest.set(batch.kind, batch);
      stats.counts[layerForKind(batch.kind).id] = batch.count;
      engine.setBatch(batch);
    }
    const density = world.density(EntityKind.Aircraft);
    if (density) engine.setDensity(density);
  };
  push();
  if (interval > 0) setInterval(push, interval);

  const quakes = syntheticQuakes(startMs);
  engine.setBatch(quakes);
  engine.setBatch(syntheticFires(startMs));
  engine.setBatch(syntheticWebcams(startMs));
  engine.setPaths("cables", syntheticCables());
  stats.counts.quakes = quakes.count;

  let selection: EntityRef | null = null;
  let following = params.get("follow") === "1";
  let orbiting = params.get("orbit") === "1";

  const select = (ref: EntityRef | null): void => {
    selection = ref;
    engine.setSelection(ref);
    engine.setTrack(ref ? world.track(ref.kind, ref.id, worldNow()) : null);
    if (!ref) following = false;
    engine.setFollowing(following);
  };

  engine.on("pick", (info) => {
    stats.lastPick = info;
    select(info?.ref ?? null);
  });
  engine.on("hover", (info) => {
    stats.lastHover = info;
  });
  engine.on("dive", ({ lon, lat }) => {
    void engine.flyTo({ lon, lat, zoom: Math.min(engine.getView().zoom + 2.5, 16) });
  });
  engine.on("interact", () => {
    following = false;
    orbiting = false;
  });
  engine.on("fps", (fps) => {
    stats.fps = fps;
  });
  const startedAt = performance.now();
  engine.on("quality", (tier) => {
    stats.quality = tier;
    stats.qualityLog.push({ at: Math.round((performance.now() - startedAt) / 100) / 10, tier });
  });
  if (params.get("pin") === "1") {
    // Reaching into the engine, for measurement only: with the governor
    // answering "stay" every time, a tier can be timed without it changing.
    (engine as unknown as { governor: { sample: () => null } }).governor.sample = () => null;
  }
  engine.on("ready", () => {
    stats.ready = true;
  });

  // ?select=aircraft: choose the object of that layer nearest the centre of the view.
  const selectLayer = params.get("select") as LayerId | null;
  if (selectLayer) {
    const kind = layerDef(selectLayer).kind;
    const batch = kind === undefined ? undefined : latest.get(kind);
    if (kind !== undefined && batch) {
      const view = engine.getView();
      let best = -1;
      let bestDistance = Infinity;
      for (let i = 0; i < batch.count; i++) {
        const dLon = ((batch.positions[i * 3] - view.lon + 540) % 360) - 180;
        const dLat = batch.positions[i * 3 + 1] - view.lat;
        const d = dLon * dLon * Math.cos((view.lat * Math.PI) / 180) ** 2 + dLat * dLat;
        // A selection demo wants something that shows its heading gap.
        if (d < bestDistance && !Number.isNaN(batch.motion[i * 4]) && batch.motion[i * 4 + 1] > 0) {
          bestDistance = d;
          best = i;
        }
      }
      if (best >= 0) select({ kind, id: batch.ids[best] });
    }
  }
  engine.setFollowing(following);
  // chase=1: the 3D view behind the selected aircraft (needs select=aircraft).
  if (params.get("chase") === "1") engine.setChase(true);
  engine.setOrbiting(orbiting);

  window.addEventListener("keydown", (e) => {
    const layer = LAYERS.find((l) => l.hotkey === e.key);
    if (layer) {
      layers[layer.id] = !layers[layer.id];
      engine.setLayerVisible(layer.id, layers[layer.id]);
      return;
    }
    switch (e.key.toLowerCase()) {
      case "f":
        following = !following && selection !== null;
        engine.setFollowing(following);
        break;
      case "o":
        orbiting = !orbiting;
        engine.setOrbiting(orbiting);
        break;
      case "q": {
        const tiers: QualityTier[] = ["high", "balanced", "low"];
        stats.quality = tiers[(tiers.indexOf(stats.quality) + 1) % tiers.length];
        engine.setQuality(stats.quality);
        break;
      }
      case "m":
        engine.setReducedMotion(!document.documentElement.classList.toggle("rm-off"));
        break;
      case "l":
        clock.mode = clock.mode === "live" ? "scrub" : "live";
        clock.timeMs = Date.now() - (clock.mode === "scrub" ? 6 * 3600_000 : 0);
        engine.setClock(clock);
        break;
    }
  });

  const meter = new FrameMeter();
  meter.start();
  setInterval(() => {
    stats.frameMs = meter.read();
    const f = stats.frameMs;
    const view = engine.getView();
    readout.textContent = [
      `${stats.fps.toFixed(0)} fps   ${f.mean.toFixed(1)} ms mean   ${f.p95.toFixed(1)} ms p95   ${f.max.toFixed(0)} ms max`,
      `quality ${stats.quality}   movers ${moverCount.toLocaleString("en")}   dpr ${window.devicePixelRatio}`,
      `zoom ${view.zoom.toFixed(2)}   ${view.lat.toFixed(2)}, ${view.lon.toFixed(2)}   ${view.global ? "global" : "regional"}`,
      selection
        ? `selected ${layerForKind(selection.kind).noun} ${selection.id}${following ? " (following)" : ""}`
        : "",
      stats.status?.message ?? "",
      stats.status?.hint ?? "",
    ]
      .filter(Boolean)
      .join("\n");
  }, 500);

  Object.assign(window, {
    __halo: {
      engine,
      stats,
      world,
      select,
      /** Restart frame timing; call after the scene has settled. */
      resetMeter: () => meter.start(),
      readMeter: () => meter.read(),
    },
  });
}

main().catch((error) => {
  console.error(error);
  const readout = document.getElementById("stats");
  if (readout) readout.textContent = `Engine failed to start: ${String(error)}`;
});

/**
 * Every aircraft model once, in rows of seven 900 m apart around (lon, lat),
 * heading 45 degrees at 1,000 m, standing still so the picture is steady.
 */
function modelGrid(lon: number, lat: number, nowMs: number, bank: boolean): RenderBatch {
  const n = AIRCRAFT_MODELS.length;
  const batch = createRenderBatch(EntityKind.Aircraft, n, nowMs, 1);
  const metresPerDegLat = 111_320;
  const metresPerDegLon = 111_320 * Math.cos((lat * Math.PI) / 180);
  for (let i = 0; i < n; i++) {
    const col = i % 7;
    const row = Math.floor(i / 7);
    batch.ids[i] = 900_000 + i;
    batch.positions[i * 3] = lon + ((col - 3) * 900) / metresPerDegLon;
    batch.positions[i * 3 + 1] = lat + ((2 - row) * 900) / metresPerDegLat;
    batch.positions[i * 3 + 2] = 1000;
    batch.motion[i * 4] = 45;
    // A centimetre a second: still to the eye, but moving, so select=aircraft can pick one.
    batch.motion[i * 4 + 1] = 0.01;
    batch.motion[i * 4 + 2] = bank && i % 2 === 1 ? 8 : 0;
    batch.motion[i * 4 + 3] = 0;
    batch.blend[i * 3 + 2] = -1e6;
    batch.style[i * 4] = 3;
    batch.style[i * 4 + 3] = AIRCRAFT_MODELS[i].id;
  }
  return batch;
}
