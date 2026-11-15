import { Layer, picking, project32 } from "@deck.gl/core";
import type { DefaultProps, LayerProps, UpdateParameters } from "@deck.gl/core";
import { Geometry, Model } from "@luma.gl/engine";
import {
  BLEND_SIZE,
  MAX_EXTRAPOLATION_S,
  MOTION_SIZE,
  POSITION_SIZE,
  STYLE_SIZE,
} from "@orya-halo/schema";
import type { RenderBatch } from "@orya-halo/schema";
import { headingProbeDegrees, sizeAtZoom } from "../maths.ts";
import { farness } from "../maths.ts";
import { GLYPH, QUAD_PAD, moversFS, moversUniforms, moversVS } from "./movers-shaders.ts";
import type { MoversUniformProps } from "./movers-shaders.ts";

export type MoverGlyph = keyof typeof GLYPH;

export interface MoversLayerProps extends LayerProps {
  /** The objects to draw. A new batch object means new buffers; the same object means nothing is uploaded. */
  batch: RenderBatch | null;
  /** The moment to render, Unix epoch milliseconds. Called once per frame. */
  getTimeMs: () => number;
  /** Layer accent, 0..255 per channel. */
  color: [number, number, number];
  glyph: MoverGlyph;
  /** Glyph half-size in pixels at the low and high end of `sizeZoomRange`. */
  sizePixels?: [number, number];
  sizeZoomRange?: [number, number];
  /** Exponent on the size ramp; above 1 holds glyphs small for longer as you zoom in. */
  sizeEase?: number;
  /** Draw comet tails. */
  tail?: boolean;
  /** A tail covers the ground travelled in this many seconds, */
  tailSeconds?: number;
  /** ...but never less than this at full `referenceSpeed`, nor more than `tailMaxPixels`. */
  tailMinPixels?: number;
  tailMaxPixels?: number;
  /** Tails grow in between these zoom levels; from orbit a tail is only clutter. */
  tailZoomRange?: [number, number];
  /** Speed, m/s, at which the minimum tail reaches full length. */
  referenceSpeed?: number;
  /** Strength of the soft halo around each glyph, 0 turns it off (and shrinks every quad to fit the bare glyph). */
  glow?: number;
  /**
   * Zoom range over which glyphs turn into points of light: at and below the
   * first zoom the layer is all points, at and above the second all glyphs.
   * Null keeps glyphs at every zoom.
   */
  farZoomRange?: [number, number] | null;
  /**
   * Zoom range over which objects stop differing in brightness by rank. It
   * should reach further in than `farZoomRange`: small glyphs crowd too.
   */
  rankZoomRange?: [number, number] | null;
  /** Far view: brightness of the brightest points, 0..1. */
  farGain?: number;
  /** Far view: brightness of the dimmest points as a share of the brightest. */
  farDim?: number;
  /** Far view: radius of a point, pixels. */
  farPointPixels?: number;
  /** Far view: 0..1, how much objects seen against space (past the limb) are dimmed. */
  spaceDim?: number;
  /**
   * Far view: 0..1, the share of objects, faintest first, not drawn at all.
   * They are the ones that add least to the picture, and skipping them halves
   * the vertex work where it is greatest. They return as the view closes in.
   */
  farThin?: number;
  /** 0..1: dim objects seen edge-on at the limb of the globe, where they crowd together. */
  limbFade?: number;
  /** Multiplier on altitude; 0 pins objects to the surface. */
  altitudeScale?: number;
  /** Colour of the ring drawn around objects flagged as emergencies, 0..255. */
  emergencyColor?: [number, number, number];
  /** Halve the emergency pulse rate. */
  slowMotion?: boolean;
}

const defaultProps: DefaultProps<MoversLayerProps> = {
  batch: { type: "object", value: null, compare: 0 },
  getTimeMs: { type: "function", value: () => Date.now(), compare: false },
  color: { type: "array", value: [255, 255, 255] },
  glyph: "chevron",
  sizePixels: { type: "array", value: [3, 9] },
  sizeZoomRange: { type: "array", value: [2, 8] },
  sizeEase: 1.6,
  tail: true,
  tailSeconds: 60,
  tailMinPixels: 10,
  tailMaxPixels: 56,
  tailZoomRange: { type: "array", value: [2, 4.5] },
  referenceSpeed: 250,
  glow: 1,
  farZoomRange: { type: "array", value: [2.2, 4.4], optional: true },
  rankZoomRange: { type: "array", value: [3.4, 5.8], optional: true },
  farGain: 0.8,
  farDim: 0.3,
  farPointPixels: 0.9,
  spaceDim: 0,
  farThin: 0,
  altitudeScale: 1,
  limbFade: 0,
  emergencyColor: { type: "array", value: [255, 255, 255] },
  slowMotion: false,
};

interface BatchData {
  length: number;
  attributes: Record<string, { value: Float32Array | Uint8Array; size: number }>;
}

const EMPTY: BatchData = { length: 0, attributes: {} };
const dataCache = new WeakMap<RenderBatch, BatchData>();

/** deck.gl binary data for a batch: the batch's own arrays, used as vertex buffers as they are. */
function batchData(batch: RenderBatch | null): BatchData {
  if (!batch || batch.count === 0) return EMPTY;
  let data = dataCache.get(batch);
  if (!data) {
    data = {
      length: batch.count,
      attributes: {
        instancePositions: { value: batch.positions, size: POSITION_SIZE },
        instanceMotion: { value: batch.motion, size: MOTION_SIZE },
        instanceBlend: { value: batch.blend, size: BLEND_SIZE },
        instanceStyle: { value: batch.style, size: STYLE_SIZE },
        // The ids as bytes, for the shader's stable per-object rank. A view, not a copy.
        instanceIdBytes: {
          value: new Uint8Array(batch.ids.buffer, batch.ids.byteOffset, batch.count * 4),
          size: 4,
        },
      },
    };
    dataCache.set(batch, data);
  }
  return data;
}

const toUnit = (c: readonly number[]): [number, number, number] => [
  c[0] / 255,
  c[1] / 255,
  c[2] / 255,
];

/**
 * Draws one `RenderBatch` of moving objects as instanced glyphs.
 *
 * Positions are dead-reckoned in the vertex shader from each object's last
 * fix, so a frame costs one draw call and one changed uniform (the time),
 * however many objects there are. Vertex buffers are only touched when a new
 * batch arrives.
 */
export class MoversLayer extends Layer<Required<MoversLayerProps>> {
  static override layerName = "MoversLayer";
  static override defaultProps = defaultProps;

  declare state: { model?: Model };

  constructor(props: MoversLayerProps) {
    // `data` is derived from `batch` so deck.gl's own change detection and
    // external-buffer path do the uploading.
    super({ ...props, data: batchData(props.batch) } as unknown as Required<MoversLayerProps>);
  }

  override getShaders() {
    return super.getShaders({
      vs: moversVS,
      fs: moversFS,
      modules: [project32, picking, moversUniforms],
    });
  }

  override initializeState(): void {
    this.getAttributeManager()?.addInstanced({
      instancePositions: { size: POSITION_SIZE, type: "float32", noAlloc: true },
      instanceMotion: { size: MOTION_SIZE, type: "float32", noAlloc: true },
      instanceBlend: { size: BLEND_SIZE, type: "float32", noAlloc: true },
      instanceStyle: { size: STYLE_SIZE, type: "uint8", noAlloc: true },
      instanceIdBytes: { size: 4, type: "uint8", noAlloc: true },
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
    const {
      batch,
      getTimeMs,
      color,
      glyph,
      sizePixels,
      sizeZoomRange,
      tail,
      emergencyColor,
      slowMotion,
    } = this.props;
    const model = this.state.model;
    if (!model || !batch || batch.count === 0) return;

    const timeMs = getTimeMs();
    const zoom = this.context.viewport.zoom;
    const pulsePeriodMs = slowMotion ? 2800 : 1400;
    const far = farness(zoom, this.props.farZoomRange);
    // Tails belong to glyphs: a point of light has no direction to trail behind.
    const tailScale = tail ? sizeAtZoom(zoom, this.props.tailZoomRange, [0, 1]) * (1 - far) : 0;
    const uniforms: MoversUniformProps = {
      time: (timeMs - batch.epochMs) / 1000,
      maxDt: MAX_EXTRAPOLATION_S[batch.kind],
      sizePx: sizeAtZoom(zoom, sizeZoomRange, sizePixels, this.props.sizeEase),
      probeDeg: headingProbeDegrees(zoom),
      tailSeconds: this.props.tailSeconds,
      tailMinPx: this.props.tailMinPixels * tailScale,
      tailMaxPx: this.props.tailMaxPixels * tailScale,
      refSpeed: this.props.referenceSpeed,
      altitudeScale: this.props.altitudeScale,
      glow: this.props.glow,
      glyph: GLYPH[glyph],
      limbFade: this.props.limbFade,
      pad: this.props.glow > 0 ? QUAD_PAD.glow : QUAD_PAD.bare,
      far,
      ranked: farness(zoom, this.props.rankZoomRange),
      farGain: this.props.farGain,
      farDim: this.props.farDim,
      farPointPx: this.props.farPointPixels,
      spaceDim: this.props.spaceDim,
      thin: this.props.farThin,
      // Wall-clock phase: the pulse keeps beating while the data clock is scrubbed or paused.
      pulse: (performance.now() % pulsePeriodMs) / pulsePeriodMs,
      color: toUnit(color),
      emergencyColor: toUnit(emergencyColor),
    };
    model.shaderInputs.setProps({ movers: uniforms });
    model.draw(this.context.renderPass);
  }

  private buildModel(): Model {
    return new Model(this.context.device, {
      ...this.getShaders(),
      id: this.props.id,
      bufferLayout: this.getAttributeManager()!.getBufferLayouts(),
      geometry: new Geometry({
        topology: "triangle-strip",
        // x runs tail to nose (0..1), y across (-1..1).
        attributes: { positions: { size: 2, value: new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]) } },
      }),
      isInstanced: true,
    });
  }
}
