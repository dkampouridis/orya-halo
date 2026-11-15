import type { ShaderModule } from "@luma.gl/shadertools";
import { haloCommonVS } from "../shaders/common.glsl.ts";

const uniformBlock = /* glsl */ `\
layout(std140) uniform markersUniforms {
  float time;
  float mode;
  float sizePx;
  float sizeScale;
  float fadeSeconds;
  float pulse;
  float valueMax;
  float radiusMeters;
  float intensity;
  float zoom;
  float rankGate;
  vec3 color;
} markers;
`;

export type MarkersUniformProps = {
  /** Render time in seconds relative to the source epoch. */
  time: number;
  mode: number;
  sizePx: number;
  sizeScale: number;
  fadeSeconds: number;
  /** Wall-clock phase 0..1 of the ripple. */
  pulse: number;
  valueMax: number;
  radiusMeters: number;
  intensity: number;
  /** The view's zoom, for marks that only appear from a zoom of their own. */
  zoom: number;
  /** 1 when each mark's value is the lowest zoom at which it is shown. */
  rankGate: number;
  color: [number, number, number];
};

export const markersUniforms = {
  name: "markers",
  vs: uniformBlock,
  fs: uniformBlock,
  uniformTypes: {
    time: "f32",
    mode: "f32",
    sizePx: "f32",
    sizeScale: "f32",
    fadeSeconds: "f32",
    pulse: "f32",
    valueMax: "f32",
    radiusMeters: "f32",
    intensity: "f32",
    zoom: "f32",
    rankGate: "f32",
    color: "vec3<f32>",
  },
} as const satisfies ShaderModule<MarkersUniformProps>;

/** Marker styles understood by the shaders. */
export const MARKER_MODE = { ripple: 0, beacon: 1, ember: 2, glow: 3 } as const;

export const markersVS = /* glsl */ `\
#version 300 es
#define SHADER_NAME halo-markers-vertex

in vec2 positions;
in vec3 instancePositions;
in float instanceValues;
in float instanceTimes;

out vec2 vUnit;
flat out vec4 vTint;
flat out vec3 vParams; // x: one pixel in unit space, y: strength 0..1, z: per-instance phase offset

${haloCommonVS}

void main(void) {
  // Markers sit on the surface whatever their source says: an earthquake's
  // depth would otherwise put it inside the planet, behind its own horizon.
  vec3 surface = vec3(instancePositions.xy, 0.0);
  vec3 common0 = project_position(surface);
  geometry.worldPosition = surface;
  geometry.position = vec4(common0, 1.0);
  geometry.pickingColor = picking_getPickingColorFromInstanceID();

  float visibility = halo_visibility(common0);
  if (visibility <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  float radiusPx = markers.sizePx * markers.sizeScale;
  float strength = 1.0;
  float alpha = 1.0;

  if (markers.rankGate > 0.5) {
    // The value is a zoom rank: the lowest zoom at which this mark has room.
    // Below it the mark is not drawn at all (and so cannot be picked); it
    // fades in over the half zoom level before its rank rather than popping.
    float shown = smoothstep(instanceValues - 0.5, instanceValues, markers.zoom);
    if (shown <= 0.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    alpha *= shown;
    radiusPx *= mix(0.6, 1.0, shown);
  }

  if (markers.mode < 0.5) {
    // Earthquake: ring radius grows with magnitude, the whole mark fades with age.
    radiusPx = clamp(5.0 + (instanceValues - 2.5) * 4.2, 4.0, 30.0) * markers.sizeScale;
    float age = max(markers.time - instanceTimes, 0.0);
    alpha *= mix(1.0, 0.28, smoothstep(0.0, markers.fadeSeconds, age));
    // Fresh quakes ripple hard; old ones barely.
    strength = mix(1.0, 0.3, smoothstep(0.0, markers.fadeSeconds * 0.25, age));
  } else if (markers.mode < 2.5 && markers.mode > 1.5) {
    // Fire: brighter and a little larger with radiative power, on a log scale.
    strength = clamp(log(1.0 + max(instanceValues, 0.0)) / log(1.0 + markers.valueMax), 0.25, 1.0);
    radiusPx *= 0.75 + 0.5 * strength;
  } else if (markers.mode > 2.5) {
    // Density cell: a ground-sized blob, never smaller than a few pixels.
    radiusPx = max(project_size_to_pixel(markers.radiusMeters), 5.0);
    strength = pow(clamp(instanceValues / max(markers.valueMax, 1.0), 0.0, 1.0), 0.75);
    if (project.projectionMode == PROJECTION_MODE_GLOBE) {
      // Screen-facing blobs do not foreshorten, so towards the limb they would
      // pile up into a bright edge. Dim them by how obliquely they are seen.
      strength *= clamp(dot(normalize(common0), normalize(project.cameraPosition - common0)), 0.0, 1.0);
    }
  }

  float padded = radiusPx + 1.5;
  vUnit = positions * (padded / radiusPx);
  vParams = vec3(1.0 / radiusPx, strength, fract(instanceTimes * 0.1379 + instancePositions.x * 0.731));

  gl_Position = project_common_position_to_clipspace(vec4(common0, 1.0));
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);
  gl_Position.xy += halo_px_to_clip(positions * padded, gl_Position.w);

  vTint = vec4(markers.color, alpha * visibility * layer.opacity);
  DECKGL_FILTER_COLOR(vTint, geometry);
}
`;

export const markersFS = /* glsl */ `\
#version 300 es
#define SHADER_NAME halo-markers-fragment
precision highp float;

in vec2 vUnit;
flat in vec4 vTint;
flat in vec3 vParams;

out vec4 fragColor;

// GLSL leaves smoothstep undefined when the first edge is the larger one, so
// falling edges are written as one minus a rising edge throughout.
float ringLine(float r, float at, float halfWidth, float px) {
  return 1.0 - smoothstep(halfWidth, halfWidth + px, abs(r - at));
}

void main(void) {
  geometry.uv = vUnit;
  float r = length(vUnit);
  float px = vParams.x;
  float strength = vParams.y;

  if (picking.isActive > 0.5) {
    float reach = markers.mode < 0.5 ? 0.62 : 0.85;
    if (markers.mode > 2.5 || r > reach) discard;
    fragColor = vec4(1.0);
    DECKGL_FILTER_COLOR(fragColor, geometry);
    return;
  }

  vec3 base = vTint.rgb;
  vec3 rgb = vec3(0.0);
  float alpha = 0.0;

  if (markers.mode < 0.5) {
    // Epicentre dot, a steady ring, and two ripples running out to the edge.
    float dot0 = 1.0 - smoothstep(0.13 - px, 0.13 + px, r);
    float steady = ringLine(r, 0.44, px * 0.75, px);
    float fill = (1.0 - smoothstep(0.0, 0.44, r)) * 0.16;
    float ripples = 0.0;
    for (int k = 0; k < 2; k++) {
      float phase = fract(markers.pulse + vParams.z + float(k) * 0.5);
      float at = mix(0.44, 0.97, phase);
      ripples += ringLine(r, at, px * 0.6, px * 1.5) * pow(1.0 - phase, 1.6);
    }
    alpha = max(max(dot0, steady), max(fill, ripples * strength));
    rgb = base * alpha;
  } else if (markers.mode < 1.5) {
    // Webcam: a point with a soft beacon halo and a faint ring.
    float core = 1.0 - smoothstep(0.3 - px, 0.3 + px, r);
    float ring = ringLine(r, 0.78, px * 0.5, px) * 0.4;
    float halo = exp(-r * r * 5.0) * 0.3 * markers.intensity;
    alpha = max(core, ring);
    rgb = base * alpha + base * halo;
  } else if (markers.mode < 2.5) {
    // Fire: a steady ember, no flicker.
    float core = 1.0 - smoothstep(0.42 - px, 0.42 + px, r);
    float halo = exp(-r * r * 4.2) * 0.32 * strength * markers.intensity;
    alpha = core * mix(0.7, 1.0, strength);
    rgb = mix(base, vec3(1.0, 0.92, 0.8), 0.35 * strength * core) * alpha + base * halo;
  } else {
    // Density: additive only, so overlapping cells build up a soft glow.
    float g = exp(-r * r * 3.0) * (1.0 - smoothstep(0.55, 1.0, r));
    rgb = base * g * strength * markers.intensity;
  }

  fragColor = vec4(rgb, alpha) * vTint.a;
  if (max(fragColor.a, max(fragColor.r, max(fragColor.g, fragColor.b))) < 0.004) discard;
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`;
