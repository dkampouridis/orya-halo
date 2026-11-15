import { Layer, picking, project32 } from "@deck.gl/core";
import type { DefaultProps, LayerProps, UpdateParameters } from "@deck.gl/core";
import { Geometry, Model } from "@luma.gl/engine";
import { MOTION_SIZE, POSITION_SIZE } from "@orya-halo/schema";
import type { DensityGrid, RenderBatch } from "@orya-halo/schema";
import { sizeAtZoom } from "../maths.ts";
import { MARKER_MODE, markersFS, markersUniforms, markersVS } from "./markers-shaders.ts";
import type { MarkersUniformProps } from "./markers-shaders.ts";

export type MarkerMode = keyof typeof MARKER_MODE;

/**
 * Columns for a set of fixed points, in the form deck.gl takes as binary
 * data. All three columns (`instancePositions`, `instanceValues`,
 * `instanceTimes`) must be present and `length` long.
 */
export interface MarkerSource {
  length: number;
  /** Times in `instanceTimes` are seconds relative to this, Unix epoch milliseconds. */
  epochMs: number;
  attributes: Record<
    string,
    { value: Float32Array; size: number; stride?: number; offset?: number }
  >;
}

const batchCache = new WeakMap<RenderBatch, MarkerSource>();
const densityCache = new WeakMap<DensityGrid, MarkerSource>();
const EMPTY: MarkerSource = { length: 0, epochMs: 0, attributes: {} };

/** A `RenderBatch` of things that stay put (earthquakes, webcams, fires) as marker columns. */
export function markersFromBatch(batch: RenderBatch | null): MarkerSource {
  if (!batch || batch.count === 0) return EMPTY;
  let source = batchCache.get(batch);
  if (!source) {
    source = {
      length: batch.count,
      epochMs: batch.epochMs,
      attributes: {
        instancePositions: { value: batch.positions, size: POSITION_SIZE },
        instanceValues: { value: batch.values, size: 1 },
        // The fix time is the fourth float of each motion record.
        instanceTimes: { value: batch.motion, size: 1, stride: MOTION_SIZE * 4, offset: 3 * 4 },
      },
    };
    batchCache.set(batch, source);
  }
  return source;
}

/** A density grid as marker columns; counts become the per-marker value. */
export function markersFromDensity(grid: DensityGrid | null): MarkerSource {
  if (!grid || grid.count === 0) return EMPTY;
  let source = densityCache.get(grid);
  if (!source) {
    source = {
      length: grid.count,
      epochMs: 0,
      attributes: {
        instancePositions: { value: grid.positions, size: 2 },
        // One bulk conversion per grid: vertex attributes are read as floats.
        instanceValues: { value: Float32Array.from(grid.counts), size: 1 },
        // Cells have no time; every column still needs a full-length buffer.
        instanceTimes: { value: new Float32Array(grid.count), size: 1 },
      },
    };
    densityCache.set(grid, source);
  }
  return source;
}

export interface MarkersLayerProps extends LayerProps {
  source: MarkerSource;
  mode: MarkerMode;
  /** The moment to render, Unix epoch milliseconds. Called once per frame. */
  getTimeMs: () => number;
  /** Layer accent, 0..255 per channel. */
  color: [number, number, number];
  /** Radius in pixels at the top of `sizeZoomRange` (beacon and ember; ripples size themselves by magnitude). */
  sizePixels?: number;
  /** Zoom range over which marks grow from `sizeScaleRange[0]` to `[1]` times their size. */
  sizeZoomRange?: [number, number];
  sizeScaleRange?: [number, number];
  /** Ripple: seconds over which a mark fades to its resting opacity. */
  fadeSeconds?: number;
  /** Ember and glow: the value that maps to full strength. */
  valueMax?: number;
  /** Glow: ground radius of one cell, metres. */
  radiusMeters?: number;
  /** Strength of the additive halo. */
  intensity?: number;
  /** Fade the whole layer out between these two zoom levels; null keeps it at every zoom. */
  fadeOutZoom?: [number, number] | null;
  /** Halve the ripple rate. */
  slowMotion?: boolean;
  /**
   * Treat each mark's value as a zoom rank: the lowest zoom at which it is
   * drawn. Webcams carry one, so a far view shows the few cameras that have
   * room and the rest appear as the view closes in.
   */
  valueIsZoomRank?: boolean;
}

const defaultProps: DefaultProps<MarkersLayerProps> = {
  source: { type: "object", value: EMPTY, compare: 0 },
  mode: "beacon",
  getTimeMs: { type: "function", value: () => Date.now(), compare: false },
  color: { type: "array", value: [255, 255, 255] },
  sizePixels: 7,
  sizeZoomRange: { type: "array", value: [1, 7] },
  sizeScaleRange: { type: "array", value: [0.5, 1.4] },
  fadeSeconds: 86_400,
  valueMax: 300,
  radiusMeters: 100_000,
  intensity: 1,
  fadeOutZoom: { type: "array", value: null, optional: true },
  slowMotion: false,
  valueIsZoomRank: false,
};

const RIPPLE_PERIOD_MS = 2600;

/**
 * Fixed points drawn as instanced, screen-facing marks: rippling rings for
 * earthquakes, beacons for webcams, embers for fires, and soft additive blobs
 * for the low-zoom density underlay.
 */
export class MarkersLayer extends Layer<Required<MarkersLayerProps>> {
  static override layerName = "MarkersLayer";
  static override defaultProps = defaultProps;

  declare state: { model?: Model };

  constructor(props: MarkersLayerProps) {
    super({ ...props, data: props.source } as unknown as Required<MarkersLayerProps>);
  }

  override getShaders() {
    return super.getShaders({
      vs: markersVS,
      fs: markersFS,
      modules: [project32, picking, markersUniforms],
    });
  }

  override initializeState(): void {
    this.getAttributeManager()?.addInstanced({
      instancePositions: { size: 3, type: "float32", noAlloc: true },
      instanceValues: { size: 1, type: "float32", noAlloc: true },
      instanceTimes: { size: 1, type: "float32", noAlloc: true },
    });
    this.state.model = this.buildModel();
  }

  override updateState(params: UpdateParameters<this>): void {
    super.updateState(params);
    if (params.changeFlags.extensionsChanged) {
      this.state.model?.destroy();
      this.state.model = this.buildModel();
      this.getAttributeManager()?.invalidateAll();
    }
  }

  override draw(): void {
    const { source, mode, getTimeMs, color, slowMotion } = this.props;
    const model = this.state.model;
    if (!model || source.length === 0) return;

    const zoom = this.context.viewport.zoom;
    const fade = this.props.fadeOutZoom;
    const presence = fade
      ? 1 - Math.min(Math.max((zoom - fade[0]) / (fade[1] - fade[0]), 0), 1)
      : 1;
    if (presence <= 0) return;

    const period = slowMotion ? RIPPLE_PERIOD_MS * 2 : RIPPLE_PERIOD_MS;
    const uniforms: MarkersUniformProps = {
      time: (getTimeMs() - source.epochMs) / 1000,
      mode: MARKER_MODE[mode],
      sizePx: this.props.sizePixels,
      sizeScale: sizeAtZoom(zoom, this.props.sizeZoomRange, this.props.sizeScaleRange),
      fadeSeconds: this.props.fadeSeconds,
      pulse: (performance.now() % period) / period,
      valueMax: this.props.valueMax,
      radiusMeters: this.props.radiusMeters,
      intensity: this.props.intensity * presence,
      zoom,
      rankGate: this.props.valueIsZoomRank ? 1 : 0,
      color: [color[0] / 255, color[1] / 255, color[2] / 255],
    };
    model.shaderInputs.setProps({ markers: uniforms });
    model.draw(this.context.renderPass);
  }

  private buildModel(): Model {
    return new Model(this.context.device, {
      ...this.getShaders(),
      id: this.props.id,
      bufferLayout: this.getAttributeManager()!.getBufferLayouts(),
      geometry: new Geometry({
        topology: "triangle-strip",
        attributes: {
          positions: { size: 2, value: new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]) },
        },
      }),
      isInstanced: true,
    });
  }
}
