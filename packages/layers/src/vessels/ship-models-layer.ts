/**
 * Ships as 3D models of their kinds.
 *
 * Close in, each ship in view is drawn as the model of its kind
 * (`vesselModelFor`, carried in the ship's batch value), placed where the
 * flat glyph would be: the same dead reckoning (`extrapolate`), so model,
 * tail and picking area stay together. It sits on the water, turned to its
 * heading (or course), and is scaled to its own length and beam where AIS
 * gave them, the model's typical ones where not.
 *
 * While true size is too small to see, each model is drawn exactly as long
 * as the glyph it replaces (the glyph's rule: `moverGlyphScale` times the
 * layer's size, or true length once that is larger), so the cross-fade
 * between them shows no jump.
 *
 * Each is painted in its operator's or role's colours, or its type's
 * (`vessel-schemes.ts` in the schema).
 *
 * Positions are worked out on the CPU each frame, so the layer only takes
 * the ships near the view (at most `maxModels`, nearest the centre first),
 * found by a search that covers the batch a slice per frame.
 */
import { CompositeLayer } from "@deck.gl/core";
import type { DefaultProps, Layer, LayerProps, UpdateParameters, Viewport } from "@deck.gl/core";
import type { Texture } from "@luma.gl/core";
import {
  MOTION_SIZE,
  STYLE_SIZE,
  VESSEL_MODELS,
  extrapolate,
  genericVesselModel,
  splitShipValue,
  vesselModel,
} from "@orya-halo/schema";
import type { RenderBatch, VesselModelSpec } from "@orya-halo/schema";
import { globeCommon, haloVisibility } from "../maths.ts";
import { moverGlyphScale } from "../movers/movers-shaders.ts";
import { buildVesselMesh } from "./vessel-mesh.ts";
import type { VesselMesh } from "./vessel-mesh.ts";
import { VesselMeshLayer, createVesselPalette } from "./vessel-mesh-layer.ts";

const DEG = Math.PI / 180;
/** Ships searched per frame for ones in view. */
const SCAN_CHUNK = 4000;
/** How far beyond the screen the search reaches, pixels. */
const SCAN_MARGIN_PX = 320;
/** New vessel kinds given a mesh layer per frame. */
const NEW_KINDS_PER_FRAME = 3;
/** At true scale, a model smaller than this on screen is not drawn. */
const MIN_VISIBLE_PX = 2;
const NONE: Placed[] = [];
const MATERIAL = {
  ambient: 0.45,
  diffuse: 0.6,
  shininess: 24,
  specularColor: [150, 160, 170] as [number, number, number],
};

interface ScanState {
  seq: number;
  cursor: number;
  building: Set<number>;
  found: Set<number>;
  list: number[];
  /** Kinds whose mesh layer has been made, kept (empty when unused) while this layer lives. */
  alive: Set<number>;
  palette: Texture | null;
}

export interface ShipModelsLayerProps extends LayerProps {
  batch: RenderBatch | null;
  /** The time to place ships at, epoch milliseconds. */
  timeMs: number;
  /**
   * The ship glyph's size at this zoom for a scale of 1, pixels (the movers
   * layer's `sizePx`): a model is never drawn shorter than its glyph. 0
   * draws every ship at true size.
   */
  glyphPixels?: number;
  maxModels?: number;
  /**
   * Called each frame with whether more were in view than `maxModels`. The
   * engine then keeps the glyph bodies, so the ones without a model still show.
   */
  onOverflow?: ((overflow: boolean) => void) | null;
  /** Id drawn a little brighter. */
  selectedId?: number | null;
  /** Extra scale for the selected ship (the 3D view's close-up). */
  selectedScale?: number;
}

interface Placed {
  position: [number, number, number];
  orientation: [number, number, number];
  scale: [number, number, number];
  /** Scheme row in red, "selected" in green, a per-ship number in blue. */
  color: [number, number, number, number];
}

const defaultProps: DefaultProps<ShipModelsLayerProps> = {
  batch: { type: "object", value: null },
  timeMs: { type: "number", value: 0 },
  glyphPixels: { type: "number", value: 14 },
  maxModels: { type: "number", value: 400 },
  onOverflow: { type: "function", value: null, compare: false },
  selectedId: { type: "object", value: null },
  selectedScale: { type: "number", value: 1 },
};

/** One mesh per kind, built on first use and kept: they never change. */
const meshes = new Map<number, VesselMesh>();
function meshFor(id: number): VesselMesh | null {
  let mesh = meshes.get(id);
  if (!mesh) {
    const spec = vesselModel(id);
    if (!spec) return null;
    mesh = buildVesselMesh(spec);
    meshes.set(id, mesh);
  }
  return mesh;
}

/** The model a ship is drawn with, and its length and beam in metres. */
export function shipModelOf(
  batch: RenderBatch,
  i: number,
): { spec: VesselModelSpec; lengthM: number; beamM: number } {
  const s = i * STYLE_SIZE;
  const v = splitShipValue(batch.values[i]);
  const byteLength = (batch.style[s + 2] / 255) * 400;
  const known = v.lengthM || byteLength;
  const id = v.model || batch.style[s + 3] || genericVesselModel(batch.style[s], known);
  const spec = vesselModel(id) ?? VESSEL_MODELS[VESSEL_MODELS.length - 1];
  const lengthM = known || spec.lengthM;
  // A beam more than half again off the model's proportions is a bad report, not a ship.
  const typical = (lengthM * spec.beamM) / spec.lengthM;
  const beamM = v.beamM ? clamp(v.beamM, typical * 0.6, typical * 1.6) : typical;
  return { spec, lengthM, beamM };
}

export class ShipModelsLayer extends CompositeLayer<Required<ShipModelsLayerProps>> {
  static override layerName = "ShipModelsLayer";
  static override defaultProps = defaultProps;

  private readonly scratch: [number, number, number] = [0, 0, 0];
  private readonly common: [number, number, number] = [0, 0, 0];

  override initializeState(): void {
    const state: ScanState = {
      seq: -1,
      cursor: 0,
      building: new Set(),
      found: new Set(),
      list: [],
      alive: new Set(),
      palette: createVesselPalette(this.context.device),
    };
    this.setState(state);
  }

  override finalizeState(context: Parameters<CompositeLayer["finalizeState"]>[0]): void {
    super.finalizeState(context);
    (this.state as unknown as ScanState).palette?.destroy();
  }

  override shouldUpdateState({ changeFlags }: UpdateParameters<this>): boolean {
    return changeFlags.somethingChanged;
  }

  /** Whether ship `i` is on this side of the globe at screen point (x, y, z). */
  private onScreen(
    viewport: Viewport,
    globe: boolean,
    lon: number,
    lat: number,
    x: number,
    y: number,
    z: number,
    margin: number,
  ): boolean {
    if (
      !(x > -margin && x < viewport.width + margin && y > -margin && y < viewport.height + margin)
    )
      return false;
    if (!(z < 1)) return false;
    return (
      !globe ||
      haloVisibility(viewport.cameraPosition, globeCommon(lon, lat, 0, this.common)) >= 0.5
    );
  }

  private scan(
    batch: RenderBatch,
    viewport: Viewport,
    from: number,
    to: number,
    out: Set<number>,
  ): void {
    const { timeMs, glyphPixels, selectedId } = this.props;
    const globe = (viewport as { projectionMode?: number }).projectionMode === 2;
    for (let i = from; i < to; i++) {
      const [lon, lat] = extrapolate(batch, i, timeMs, this.scratch);
      const [x, y, z] = viewport.project([lon, lat, 0]);
      if (!this.onScreen(viewport, globe, lon, lat, x, y, z, SCAN_MARGIN_PX)) continue;
      if (glyphPixels <= 0 && batch.ids[i] !== selectedId) {
        // At true size, skip ships too small to see.
        const dLon = 100 / (111_320 * Math.max(Math.cos(lat * DEG), 0.01));
        const [x2, y2] = viewport.project([lon + dLon, lat, 0]);
        if ((Math.hypot(x2 - x, y2 - y) / 100) * shipModelOf(batch, i).lengthM < MIN_VISIBLE_PX)
          continue;
      }
      out.add(batch.ids[i]);
    }
  }

  override renderLayers(): Layer[] {
    const { batch, timeMs, maxModels, selectedId, glyphPixels } = this.props;
    const viewport = this.context.viewport;
    if (!batch || batch.count === 0) return [];
    // deck.gl's PROJECTION_MODE.GLOBE; class names do not survive minification.
    const globe = (viewport as { projectionMode?: number }).projectionMode === 2;
    const pixelsPerMeter = measurePixelsPerMeter(viewport);
    if (!(pixelsPerMeter > 0)) return [];

    // The search for ships in view, a slice of the batch per frame (see the
    // aircraft models layer, which does the same).
    const scan = this.state as unknown as ScanState;
    if (scan.seq !== batch.seq) {
      scan.seq = batch.seq;
      scan.list = [];
      if (scan.cursor > batch.count) scan.cursor = 0;
      for (let i = 0; i < batch.count; i++) if (scan.found.has(batch.ids[i])) scan.list.push(i);
    }
    const end = Math.min(scan.cursor + SCAN_CHUNK, batch.count);
    this.scan(batch, viewport, scan.cursor, end, scan.building);
    scan.cursor = end;
    if (scan.cursor >= batch.count) {
      scan.found = scan.building;
      scan.building = new Set();
      scan.cursor = 0;
      scan.list = [];
      for (let i = 0; i < batch.count; i++) if (scan.found.has(batch.ids[i])) scan.list.push(i);
    }
    const chosen = selectedId === null ? -1 : batch.ids.indexOf(selectedId);
    const indices = chosen >= 0 && !scan.list.includes(chosen) ? [...scan.list, chosen] : scan.list;

    const width = viewport.width;
    const height = viewport.height;
    const candidates: { i: number; d: number; lon: number; lat: number }[] = [];
    for (const i of indices) {
      if (i >= batch.count) continue;
      const [lon, lat] = extrapolate(batch, i, timeMs, this.scratch);
      const [x, y, z] = viewport.project([lon, lat, 0]);
      if (!this.onScreen(viewport, globe, lon, lat, x, y, z, 80)) continue;
      const dx = x - width / 2;
      const dy = y - height / 2;
      candidates.push({ i, d: dx * dx + dy * dy, lon, lat });
    }
    candidates.sort((a, b) => a.d - b.d);
    const overflow = candidates.length > maxModels;
    if (overflow) candidates.length = maxModels;
    this.props.onOverflow?.(overflow);

    const groups = new Map<number, Placed[]>();
    for (const c of candidates) {
      const i = c.i;
      const s = i * STYLE_SIZE;
      const { spec, lengthM, beamM } = shipModelOf(batch, i);
      const heading = batch.motion[i * MOTION_SIZE];
      const hdg = Number.isFinite(heading) ? heading : 0;
      // As long as the glyph: its size times its scale, at least (the glyph's quad is two sizes long).
      const glyphLength =
        2 * glyphPixels * moverGlyphScale("ship", batch.style[s], batch.style[s + 2]);
      const selected = selectedId !== null && batch.ids[i] === selectedId;
      const k =
        Math.max(1, glyphLength / (lengthM * pixelsPerMeter)) *
        (selected ? this.props.selectedScale : 1);
      const sx = lengthM / spec.lengthM;
      const sy = beamM / spec.beamM;
      let list = groups.get(spec.id);
      if (!list) {
        list = [];
        groups.set(spec.id, list);
      }
      list.push({
        position: [c.lon, c.lat, 0],
        // On the globe deck.gl lays mesh offsets out west, south, up: half a turn more yaw.
        orientation: [0, (globe ? 270 : 90) - hdg, 0],
        scale: [sx * k, sy * k, Math.sqrt(sx * sy) * k],
        color: [
          splitShipValue(batch.values[i]).scheme || spec.id,
          selected ? 255 : 0,
          batch.ids[i] & 255,
          255,
        ],
      });
    }

    // Making a mesh layer costs a millisecond or two: a few new kinds a frame.
    let budget = NEW_KINDS_PER_FRAME;
    for (const id of groups.keys()) {
      if (scan.alive.has(id)) continue;
      if (budget-- <= 0) break;
      scan.alive.add(id);
    }
    const layers: Layer[] = [];
    for (const id of scan.alive) {
      const mesh = meshFor(id);
      if (!mesh) continue;
      layers.push(
        new VesselMeshLayer<Placed>(
          this.getSubLayerProps({
            id: `ship-${id}`,
            data: groups.get(id) ?? NONE,
            mesh,
            texture: scan.palette,
            getPosition: (d: Placed) => d.position,
            getOrientation: (d: Placed) => d.orientation,
            getScale: (d: Placed) => d.scale,
            getColor: (d: Placed) => d.color,
            material: MATERIAL,
            pickable: false,
            parameters: { depthWriteEnabled: true, depthCompare: "less-equal", cullMode: "none" },
          }),
        ),
      );
    }
    return layers;
  }
}

function measurePixelsPerMeter(viewport: Viewport): number {
  const [lon, lat] = viewport.unproject([viewport.width / 2, viewport.height / 2]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return 0;
  const dLon = 100 / (111_320 * Math.max(Math.cos(lat * DEG), 0.01));
  const a = viewport.project([lon, lat, 0]);
  const b = viewport.project([lon + dLon, lat, 0]);
  return Math.hypot(b[0] - a[0], b[1] - a[1]) / 100;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}

/**
 * Build the vessel meshes not built yet while `timeLeft()` says there is
 * time, so the first zoom in does not pay for them. True when all are built.
 */
export function prepareVesselMeshes(timeLeft: () => number): boolean {
  for (const spec of VESSEL_MODELS) {
    if (meshes.has(spec.id)) continue;
    if (timeLeft() <= 2) return false;
    meshFor(spec.id);
  }
  return true;
}

/**
 * A mesh layer drawn during warm-up and kept while ships are on, so its
 * shaders stay compiled before the first model appears. Sub-pixel and transparent.
 */
export function warmShipModelsLayer(id: string): Layer {
  const mesh = meshFor(VESSEL_MODELS[VESSEL_MODELS.length - 1].id) as VesselMesh;
  return new VesselMeshLayer<number>({
    id,
    data: [0],
    mesh,
    getPosition: () => [0, 0, 0],
    getScale: [1e-6, 1e-6, 1e-6],
    getColor: [0, 0, 0, 0],
    material: MATERIAL,
    parameters: { depthWriteEnabled: false, depthCompare: "always", cullMode: "none" },
  });
}
