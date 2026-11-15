/**
 * Aircraft as 3D models of their real types.
 *
 * Close in, each aircraft in view is drawn as the model of its type
 * (`aircraftModelForType`, carried in the batch's fourth style byte), placed
 * where the flat glyph would be: the same dead reckoning (`extrapolate`), so
 * model, tail and picking area stay together. It is turned to its heading,
 * pitched by its climb or descent and banked by its rate of turn.
 *
 * Models are drawn larger than life until true size is large enough to see,
 * with every aircraft scaled by the same factor, so an A380 still dwarfs an
 * A320 and a Cessna stays small, though never smaller than `minPixels`.
 *
 * Positions are worked out on the CPU each frame, so the layer only takes the
 * aircraft near the view (at most `maxModels`, nearest the centre first). The
 * engine shows it at zooms where that is a few hundred at most.
 */
import { CompositeLayer } from "@deck.gl/core";
import type { DefaultProps, Layer, LayerProps, UpdateParameters, Viewport } from "@deck.gl/core";
import { SimpleMeshLayer } from "@deck.gl/mesh-layers";
import {
  AIRCRAFT_MODELS,
  EntityFlag,
  MOTION_SIZE,
  STYLE_SIZE,
  aircraftModel,
  extrapolate,
  genericAircraftModel,
} from "@orya-halo/schema";
import type { RenderBatch } from "@orya-halo/schema";
import { globeCommon, haloVisibility } from "../maths.ts";
import { buildAircraftMesh } from "./aircraft-mesh.ts";
import type { AircraftMesh } from "./aircraft-mesh.ts";

const DEG = Math.PI / 180;
const G = 9.81;
/** Aircraft searched per frame for ones in view, and how far beyond the screen the search reaches. */
const SCAN_CHUNK = 4000;
/** New aircraft types given a mesh layer per frame. */
const NEW_TYPES_PER_FRAME = 3;
const NONE: Placed[] = [];
const SCAN_MARGIN_PX = 320;

interface ScanState {
  /** The batch `list` indexes into. */
  seq: number;
  /** Where the pass in progress has got to, and the ids it has found so far. */
  cursor: number;
  building: Set<number>;
  /** What the last finished pass found, by id, and where those are in the current batch. */
  found: Set<number>;
  list: number[];
  /** Types whose mesh layer has been made, kept (empty when unused) while this layer lives. */
  alive: Set<number>;
}
/** At true scale, a model smaller than this on screen is not drawn. */
const MIN_VISIBLE_PX = 2;
/** An airliner this long (metres) is drawn `targetPixels` long while its true size is smaller. */
const REFERENCE_M = 40;

export interface AircraftModelsLayerProps extends LayerProps {
  batch: RenderBatch | null;
  /** The time to place aircraft at, epoch milliseconds. A new value every frame moves them. */
  timeMs: number;
  /** Rate of turn by aircraft id, degrees a second (positive: turning right). Banks the model. */
  turnRates?: ReadonlyMap<number, number>;
  /** Metres of altitude drawn per metre of real altitude, as the glyphs use. */
  altitudeScale?: number;
  /** Length on screen of a 40 m airliner while true size is smaller, pixels. */
  targetPixels?: number;
  /** No model is drawn shorter than this, pixels. */
  minPixels?: number;
  maxModels?: number;
  color?: [number, number, number];
  /** Id drawn in `selectedColor`. */
  selectedId?: number | null;
  /** Extra scale for the selected aircraft, on top of the rest (the 3D view's close-up). */
  selectedScale?: number;
  selectedColor?: [number, number, number];
}

interface Placed {
  position: [number, number, number];
  orientation: [number, number, number];
  scale: [number, number, number];
  selected: boolean;
}

const defaultProps: DefaultProps<AircraftModelsLayerProps> = {
  batch: { type: "object", value: null },
  timeMs: { type: "number", value: 0 },
  turnRates: { type: "object", value: new Map<number, number>() },
  altitudeScale: { type: "number", value: 1 },
  targetPixels: { type: "number", value: 48 },
  minPixels: { type: "number", value: 22 },
  maxModels: { type: "number", value: 400 },
  color: { type: "color", value: [226, 236, 242] },
  selectedId: { type: "object", value: null },
  selectedScale: { type: "number", value: 1 },
  selectedColor: { type: "color", value: [255, 255, 255] },
};

/** One mesh per model, built on first use and kept: they never change. */
const meshes = new Map<number, AircraftMesh>();
function meshFor(id: number): AircraftMesh | null {
  let mesh = meshes.get(id);
  if (!mesh) {
    const spec = aircraftModel(id);
    if (!spec) return null;
    mesh = buildAircraftMesh(spec);
    meshes.set(id, mesh);
  }
  return mesh;
}

export class AircraftModelsLayer extends CompositeLayer<Required<AircraftModelsLayerProps>> {
  static override layerName = "AircraftModelsLayer";
  static override defaultProps = defaultProps;

  private readonly scratch: [number, number, number] = [0, 0, 0];
  private readonly common: [number, number, number] = [0, 0, 0];

  override initializeState(): void {
    // The search for aircraft in view; see `renderLayers`.
    const state: ScanState = {
      seq: -1,
      cursor: 0,
      building: new Set(),
      found: new Set(),
      list: [],
      alive: new Set(),
    };
    this.setState(state);
  }

  override shouldUpdateState({ changeFlags }: UpdateParameters<this>): boolean {
    return changeFlags.somethingChanged;
  }

  /**
   * Indices of the aircraft that can be on screen until the next scan: in
   * view with a wide margin, on this side of the globe, and (where nothing is
   * enlarged, as in the 3D view) large enough to see at all.
   */
  private scan(
    batch: RenderBatch,
    viewport: Viewport,
    from: number,
    to: number,
    out: Set<number>,
  ): void {
    const { timeMs, altitudeScale, targetPixels, minPixels, selectedId } = this.props;
    const globe = (viewport as { projectionMode?: number }).projectionMode === 2;
    const trueScale = targetPixels <= 0 && minPixels <= 0;
    const margin = SCAN_MARGIN_PX;
    for (let i = from; i < to; i++) {
      const [lon, lat, alt] = extrapolate(batch, i, timeMs, this.scratch);
      const drawnAlt = alt * altitudeScale;
      const [x, y, z] = viewport.project([lon, lat, drawnAlt]);
      if (
        !(x > -margin && x < viewport.width + margin && y > -margin && y < viewport.height + margin)
      )
        continue;
      if (!(z < 1)) continue;
      if (
        globe &&
        haloVisibility(viewport.cameraPosition, globeCommon(lon, lat, drawnAlt, this.common)) < 0.5
      )
        continue;
      if (trueScale && batch.ids[i] !== selectedId) {
        // How big it would be drawn there: a point 100 m east, projected too.
        const dLon = 100 / (111_320 * Math.max(Math.cos(lat * DEG), 0.01));
        const [x2, y2] = viewport.project([lon + dLon, lat, drawnAlt]);
        const s = i * STYLE_SIZE;
        const spec = aircraftModel(batch.style[s + 3] || genericAircraftModel(batch.style[s]));
        const size = spec ? Math.max(spec.lengthM, spec.spanM) : 40;
        if ((Math.hypot(x2 - x, y2 - y) / 100) * size < MIN_VISIBLE_PX) continue;
      }
      out.add(batch.ids[i]);
    }
  }

  override renderLayers(): Layer[] {
    const { batch, timeMs, altitudeScale, maxModels, turnRates, selectedId } = this.props;
    const viewport = this.context.viewport;
    if (!batch || batch.count === 0) return [];

    // deck.gl's PROJECTION_MODE.GLOBE; class names do not survive minification.
    const globe = (viewport as { projectionMode?: number }).projectionMode === 2;
    const width = viewport.width;
    const height = viewport.height;
    const margin = 80;
    // Pixels per metre at the view centre, measured: two points 100 m apart
    // on the ground, projected. One scale for every aircraft drawn.
    const pixelsPerMeter = measurePixelsPerMeter(viewport);
    if (!(pixelsPerMeter > 0)) return [];
    const exaggerate = Math.max(1, this.props.targetPixels / (REFERENCE_M * pixelsPerMeter));

    // Which aircraft can be on screen: a wide search over the whole batch,
    // a slice per frame so no frame pays for all of it (a pass over 30,000
    // aircraft takes eight frames, in which an aircraft covers a few tens of
    // metres, well inside the search's extra margin). Each frame places only
    // what the last finished pass found. Found aircraft are kept by id, so a
    // new batch, which orders them afresh, only needs them looked up again.
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

    // The selected aircraft never waits for a pass to find it.
    const chosen = selectedId === null ? -1 : batch.ids.indexOf(selectedId);
    const indices = chosen >= 0 && !scan.list.includes(chosen) ? [...scan.list, chosen] : scan.list;

    // Candidates: on screen (with a margin for the model's size), nearest the centre first.
    const candidates: { i: number; d: number; lon: number; lat: number; alt: number }[] = [];
    for (const i of indices) {
      if (i >= batch.count) continue;
      const [lon, lat, alt] = extrapolate(batch, i, timeMs, this.scratch);
      const drawnAlt = alt * altitudeScale;
      const [x, y, z] = viewport.project([lon, lat, drawnAlt]);
      if (!(x > -margin && x < width + margin && y > -margin && y < height + margin)) continue;
      // Behind the camera, or on the far side of the globe (which projects onto the screen too).
      if (!(z < 1)) continue;
      if (
        globe &&
        haloVisibility(viewport.cameraPosition, globeCommon(lon, lat, drawnAlt, this.common)) < 0.5
      )
        continue;
      const dx = x - width / 2;
      const dy = y - height / 2;
      candidates.push({ i, d: dx * dx + dy * dy, lon, lat, alt: drawnAlt });
    }
    candidates.sort((a, b) => a.d - b.d);
    if (candidates.length > maxModels) candidates.length = maxModels;

    const groups = new Map<number, Placed[]>();
    for (const c of candidates) {
      const i = c.i;
      const s = i * STYLE_SIZE;
      const model = batch.style[s + 3] || genericAircraftModel(batch.style[s]);
      const spec = aircraftModel(model) ?? AIRCRAFT_MODELS[1];
      const m = i * MOTION_SIZE;
      const heading = batch.motion[m];
      const speed = batch.motion[m + 1];
      const vrate = batch.motion[m + 2];
      const onGround = (batch.style[s + 1] & EntityFlag.Stationary) !== 0;
      const hdg = Number.isFinite(heading) ? heading : 0;
      // Climb angle from the vertical rate; nose down is positive pitch in deck.gl's frame.
      const climb = onGround ? 0 : Math.atan2(vrate, Math.max(speed, 40)) / DEG;
      const turn = onGround ? 0 : (turnRates?.get(batch.ids[i]) ?? 0);
      // Coordinated turn: tan(bank) = v * omega / g.
      const bank = Math.atan((Math.max(speed, 0) * turn * DEG) / G) / DEG;
      // The larger of length and span: a glider is short but very wide.
      const floor = this.props.minPixels / (Math.max(spec.lengthM, spec.spanM) * pixelsPerMeter);
      const selected = selectedId !== null && batch.ids[i] === selectedId;
      const k = Math.max(exaggerate, floor) * (selected ? this.props.selectedScale : 1);
      let list = groups.get(spec.id);
      if (!list) {
        list = [];
        groups.set(spec.id, list);
      }
      list.push({
        position: [c.lon, c.lat, c.alt],
        // Yaw turns the nose (+x) anticlockwise from east. On the globe deck.gl
        // lays mesh offsets out along west, south and up (its frame's x and y
        // are `-east` and `-north`), so there the yaw is half a turn more.
        orientation: [-clamp(climb, -15, 15), (globe ? 270 : 90) - hdg, clamp(bank, -30, 30)],
        scale: [k, k, k],
        selected,
      });
    }

    // Each type is a mesh layer of its own, and making one (its buffers, its
    // model) costs a millisecond or two: twenty at once is a visible stall.
    // So at most NEW_TYPES_PER_FRAME are made a frame, and a type's layer is
    // kept, empty, once made. The models fade in from nothing as the view
    // closes in, so a type that waits a frame or two is never seen missing.
    let budget = NEW_TYPES_PER_FRAME;
    for (const id of groups.keys()) {
      if (scan.alive.has(id)) continue;
      if (budget-- <= 0) break;
      scan.alive.add(id);
    }
    const layers: Layer[] = [];
    const { color, selectedColor } = this.props;
    for (const id of scan.alive) {
      const placed = groups.get(id) ?? NONE;
      const mesh = meshFor(id);
      if (!mesh) continue;
      layers.push(
        new SimpleMeshLayer<Placed>(
          this.getSubLayerProps({
            id: `model-${id}`,
            data: placed,
            mesh,
            getPosition: (d: Placed) => d.position,
            getOrientation: (d: Placed) => d.orientation,
            getScale: (d: Placed) => d.scale,
            getColor: (d: Placed) => (d.selected ? selectedColor : color),
            material: {
              ambient: 0.42,
              diffuse: 0.62,
              shininess: 48,
              specularColor: [190, 210, 225],
            },
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
 * Build the meshes not built yet while `timeLeft()` says there is time, so
 * the first zoom in does not pay for them. True when every one is built.
 */
export function prepareAircraftMeshes(timeLeft: () => number): boolean {
  for (const spec of AIRCRAFT_MODELS) {
    if (meshes.has(spec.id)) continue;
    if (timeLeft() <= 2) return false;
    meshFor(spec.id);
  }
  return true;
}

/**
 * A mesh layer drawn once during the engine's warm-up, so its shaders are
 * compiled before the first model appears. Sub-pixel and transparent.
 */
export function warmAircraftModelsLayer(id: string): Layer {
  const mesh = meshFor(AIRCRAFT_MODELS[1].id) as AircraftMesh;
  return new SimpleMeshLayer<number>({
    id,
    data: [0],
    mesh,
    getPosition: () => [0, 0, 0],
    getScale: [1e-6, 1e-6, 1e-6],
    getColor: [0, 0, 0, 0],
    material: { ambient: 0.42, diffuse: 0.62, shininess: 48, specularColor: [190, 210, 225] },
    parameters: { depthWriteEnabled: false, depthCompare: "always", cullMode: "none" },
  });
}
