import { Layer, project32 } from "@deck.gl/core";
import type { DefaultProps, LayerProps } from "@deck.gl/core";
import { Geometry, Model } from "@luma.gl/engine";
import type { ShaderModule } from "@luma.gl/shadertools";
import { headingProbeDegrees } from "../maths.ts";
import { haloCommonVS } from "../shaders/common.glsl.ts";

/** One ring. The engine mutates these in place every frame; the layer reads them when it draws. */
export interface Reticle {
  visible: boolean;
  lon: number;
  lat: number;
  /** Metres, already multiplied by whatever altitude scale the object's layer uses. */
  alt: number;
  /** Degrees clockwise from north; NaN draws a closed ring with no gap. */
  heading: number;
  /** Ring diameter in pixels. */
  diameter: number;
  /** 0..1 */
  opacity: number;
  /** 0..1: how much of the circumference is drawn (the selection ring draws itself in). */
  reveal: number;
  /** 0..255 per channel. */
  color: [number, number, number];
}

export function createReticle(diameter: number, color: [number, number, number]): Reticle {
  return {
    visible: false,
    lon: 0,
    lat: 0,
    alt: 0,
    heading: Number.NaN,
    diameter,
    opacity: 1,
    reveal: 1,
    color,
  };
}

export interface ReticleLayerProps extends LayerProps {
  /** Rings to draw. Read every frame; mutate the objects rather than replacing the array. */
  reticles: Reticle[];
}

const defaultProps: DefaultProps<ReticleLayerProps> = {
  reticles: { type: "array", value: [], compare: false },
};

const uniformBlock = /* glsl */ `\
layout(std140) uniform reticleUniforms {
  vec3 positionHigh;
  float heading;
  vec3 positionLow;
  float hasHeading;
  vec3 color;
  float radiusPx;
  float opacity;
  float reveal;
  float probeDeg;
} reticle;
`;

type ReticleUniformProps = {
  positionHigh: [number, number, number];
  positionLow: [number, number, number];
  color: [number, number, number];
  heading: number;
  hasHeading: number;
  radiusPx: number;
  opacity: number;
  reveal: number;
  probeDeg: number;
};

const reticleUniforms = {
  name: "reticle",
  vs: uniformBlock,
  fs: uniformBlock,
  uniformTypes: {
    positionHigh: "vec3<f32>",
    heading: "f32",
    positionLow: "vec3<f32>",
    hasHeading: "f32",
    color: "vec3<f32>",
    radiusPx: "f32",
    opacity: "f32",
    reveal: "f32",
    probeDeg: "f32",
  },
} as const satisfies ShaderModule<ReticleUniformProps>;

/** Pixels of quad beyond the ring, for its glow and antialiasing. */
const MARGIN = 6;

const vs = /* glsl */ `\
#version 300 es
#define SHADER_NAME halo-reticle-vertex

in vec2 positions;
out vec2 vPx;
out float vVisibility;

const float DEG = 0.017453292519943295;

${haloCommonVS}

void main(void) {
  float h = reticle.heading * DEG;
  float cosLat = max(cos(reticle.positionHigh.y * DEG), 0.01);
  vec3 probe = vec3(sin(h) / cosLat, cos(h), 0.0) * reticle.probeDeg;

  // The position arrives split into a 32-bit value and its rounding error, so
  // the ring sits exactly on its object at street level too.
  vec3 common0;
  vec3 common1;
  if (project.projectionMode == PROJECTION_MODE_WEB_MERCATOR_AUTO_OFFSET) {
    common0 = project_position(reticle.positionHigh, reticle.positionLow);
    common1 = project_position(reticle.positionHigh, reticle.positionLow + probe);
  } else {
    common0 = project_position(reticle.positionHigh + reticle.positionLow);
    common1 = project_position(reticle.positionHigh + reticle.positionLow + probe);
  }
  geometry.worldPosition = reticle.positionHigh;
  geometry.position = vec4(common0, 1.0);

  vec4 clip0 = project_common_position_to_clipspace(vec4(common0, 1.0));
  vec4 clip1 = project_common_position_to_clipspace(vec4(common1, 1.0));
  vec2 ahead = halo_clip_delta_px(clip0, clip1);
  float len = length(ahead);
  vec2 dir = len > 1.0e-4 ? ahead / len : vec2(0.0, 1.0);
  vec2 side = vec2(-dir.y, dir.x);

  float extent = reticle.radiusPx + ${MARGIN.toFixed(1)};
  // vPx: x along the heading, y to its left, in pixels.
  vPx = positions * extent;
  vVisibility = halo_visibility(common0);

  gl_Position = clip0;
  gl_Position.xy += halo_px_to_clip((dir * vPx.x + side * vPx.y), clip0.w);
}
`;

const fs = /* glsl */ `\
#version 300 es
#define SHADER_NAME halo-reticle-fragment
precision highp float;

in vec2 vPx;
in float vVisibility;
out vec4 fragColor;

const float PI = 3.141592653589793;
// Half-width of the gap that points along the heading, radians.
const float GAP = 0.44;

void main(void) {
  float r = length(vPx);
  float d = abs(r - reticle.radiusPx);
  float line = 1.0 - smoothstep(0.55, 1.35, d);
  float glow = exp(-d * 0.75) * 0.22;

  // Angle from the heading, 0..2*PI going round.
  float angle = atan(vPx.y, vPx.x);
  float around = angle < 0.0 ? angle + 2.0 * PI : angle;
  float mask = 1.0;
  if (reticle.hasHeading > 0.5) {
    float fromGap = min(around, 2.0 * PI - around);
    mask *= smoothstep(GAP - 0.05, GAP + 0.05, fromGap);
    // Draw in from one lip of the gap round to the other.
    float progress = (around - GAP) / (2.0 * PI - 2.0 * GAP);
    mask *= step(progress, reticle.reveal);
  } else {
    mask *= step(around / (2.0 * PI), reticle.reveal);
  }

  float a = (line + glow) * mask * reticle.opacity * vVisibility;
  if (a < 0.004) discard;
  fragColor = vec4(reticle.color * a, line * mask * reticle.opacity * vVisibility);
}
`;

/**
 * The halo reticle: a thin ring around the hovered or selected object with a
 * gap pointing along its heading. It draws from live `Reticle` objects, so
 * tracking an object costs a uniform update per frame and no layer churn.
 */
export class ReticleLayer extends Layer<Required<ReticleLayerProps>> {
  static override layerName = "ReticleLayer";
  static override defaultProps = defaultProps;

  declare state: { model?: Model };

  override getShaders() {
    return super.getShaders({ vs, fs, modules: [project32, reticleUniforms] });
  }

  override initializeState(): void {
    this.state.model = new Model(this.context.device, {
      ...this.getShaders(),
      id: this.props.id,
      geometry: new Geometry({
        topology: "triangle-strip",
        attributes: {
          positions: { size: 2, value: new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]) },
        },
      }),
      isInstanced: true,
    });
  }

  // One instance, no per-instance attributes: everything arrives as uniforms.
  override getNumInstances(): number {
    return 1;
  }

  override draw(): void {
    const model = this.state.model;
    if (!model) return;
    const probeDeg = headingProbeDegrees(this.context.viewport.zoom);
    for (const r of this.props.reticles) {
      if (!r.visible || r.opacity <= 0) continue;
      const hasHeading = Number.isFinite(r.heading);
      const lon = Math.fround(r.lon);
      const lat = Math.fround(r.lat);
      const uniforms: ReticleUniformProps = {
        positionHigh: [lon, lat, r.alt],
        positionLow: [r.lon - lon, r.lat - lat, 0],
        color: [r.color[0] / 255, r.color[1] / 255, r.color[2] / 255],
        heading: hasHeading ? r.heading : 0,
        hasHeading: hasHeading ? 1 : 0,
        radiusPx: r.diameter / 2,
        opacity: r.opacity,
        reveal: r.reveal,
        probeDeg,
      };
      model.shaderInputs.setProps({ reticle: uniforms });
      model.draw(this.context.renderPass);
    }
  }
}
