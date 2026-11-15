import { BLEND_SECONDS, EARTH_RADIUS_M } from "@orya-halo/schema";
import type { ShaderModule } from "@luma.gl/shadertools";
import { haloCommonVS, haloShapesFS } from "../shaders/common.glsl.ts";

const uniformBlock = /* glsl */ `\
layout(std140) uniform moversUniforms {
  float time;
  float maxDt;
  float sizePx;
  float probeDeg;
  float tailSeconds;
  float tailMinPx;
  float tailMaxPx;
  float refSpeed;
  float altitudeScale;
  float glow;
  float glyph;
  float pulse;
  float limbFade;
  float pad;
  float far;
  float ranked;
  float farGain;
  float farDim;
  float farPointPx;
  float spaceDim;
  float thin;
  float body;
  vec3 color;
  vec3 emergencyColor;
} movers;
`;

export type MoversUniformProps = {
  /** Render time in seconds relative to the batch epoch. */
  time: number;
  /** Longest extrapolation for this kind, seconds. */
  maxDt: number;
  sizePx: number;
  probeDeg: number;
  tailSeconds: number;
  tailMinPx: number;
  tailMaxPx: number;
  refSpeed: number;
  altitudeScale: number;
  glow: number;
  glyph: number;
  /** Phase 0..1 of the emergency pulse. */
  pulse: number;
  /** 0..1: how much objects seen edge-on at the limb are dimmed. */
  limbFade: number;
  /** Half-extent of each quad, in glyph half-sizes. */
  pad: number;
  /** 0 close in, 1 from orbit: how far the glyphs have turned into points of light. */
  far: number;
  /** 0 close in, 1 from afar: how much objects differ in brightness by rank. Reaches further in than `far`. */
  ranked: number;
  /** Brightness of the brightest points in the far view. */
  farGain: number;
  /** Brightness of the dimmest points in the far view, as a share of the brightest. */
  farDim: number;
  /** Radius of a far-view point, pixels. */
  farPointPx: number;
  /** 0..1: how much objects seen against space, past the limb, are dimmed in the far view. */
  spaceDim: number;
  /** 0..1: the share of objects, faintest first, left undrawn in the far view. For the cheapest tier. */
  thin: number;
  /** 0..1: how much of the glyph itself is drawn; the tail is not affected. */
  body: number;
  color: [number, number, number];
  emergencyColor: [number, number, number];
};

export const moversUniforms = {
  name: "movers",
  vs: uniformBlock,
  fs: uniformBlock,
  uniformTypes: {
    time: "f32",
    maxDt: "f32",
    sizePx: "f32",
    probeDeg: "f32",
    tailSeconds: "f32",
    tailMinPx: "f32",
    tailMaxPx: "f32",
    refSpeed: "f32",
    altitudeScale: "f32",
    glow: "f32",
    glyph: "f32",
    pulse: "f32",
    limbFade: "f32",
    pad: "f32",
    far: "f32",
    ranked: "f32",
    farGain: "f32",
    farDim: "f32",
    farPointPx: "f32",
    spaceDim: "f32",
    thin: "f32",
    body: "f32",
    color: "vec3<f32>",
    emergencyColor: "vec3<f32>",
  },
} as const satisfies ShaderModule<MoversUniformProps>;

/** Silhouette families understood by the shaders; each picks its shape and size by category. */
export const GLYPH = { aircraft: 0, ship: 1, satellite: 2 } as const;

/**
 * Size of each silhouette by category, as a share of the layer's size. Index
 * is the category code (`AircraftCategory`, `ShipCategory`, `SatelliteCategory`
 * in @orya-halo/schema). The shaders and `moverGlyphScale` both read these.
 */
export const GLYPH_SCALE = {
  // unknown, light, medium, large, heavy, fast jet, rotorcraft, glider, drone, ground vehicle
  aircraft: [0.95, 0.7, 0.88, 1.0, 1.22, 0.85, 0.82, 0.72, 0.55, 0.5],
  // ships whose length is not known: unknown, cargo, tanker, passenger, fishing,
  // service, high-speed, pleasure, military, other
  ship: [0.85, 1.05, 1.1, 1.05, 0.7, 0.65, 0.75, 0.6, 0.95, 0.8],
  // other, station, constellation, navigation, Earth observation, science, geostationary, debris
  satellite: [0.9, 1.9, 0.8, 1.0, 1.0, 1.0, 1.1, 0.5],
} as const satisfies Record<keyof typeof GLYPH, readonly number[]>;

const glslArray = (values: readonly number[]): string =>
  `float[${values.length}](${values.map((v) => v.toFixed(3)).join(", ")})`;

/**
 * How large one object's silhouette is drawn, as a share of its layer's size,
 * from its render style bytes: the category, and for ships the length byte
 * (length over 400 m). The same rule as the vertex shader, minus a ship's true
 * scale close in, which depends on the view.
 */
export function moverGlyphScale(
  glyph: keyof typeof GLYPH,
  category: number,
  value: number,
): number {
  const table = GLYPH_SCALE[glyph];
  const scale = table[Math.min(Math.max(Math.trunc(category), 0), table.length - 1)] ?? 1;
  if (glyph === "ship" && value > 0) {
    const lengthM = (value / 255) * 400;
    return Math.min(Math.max(Math.sqrt(lengthM / 150), 0.55), 1.5);
  }
  return scale;
}

/**
 * Half-extent of the quad around a glyph, in glyph half-sizes. The glow
 * reaches furthest; without it the quad only has to hold the shape and its
 * antialiased edge, which is a fifth of the pixels. An emergency ring needs
 * the most room, but only the few objects that carry one pay for it.
 */
export const QUAD_PAD = { glow: 2.4, bare: 1.35, ring: 3.2 } as const;

/**
 * Dead reckoning on the GPU. This is `extrapolate()` from
 * `@orya-halo/schema`, line for line: advance the fix along its heading for
 * the clamped time since the fix, add the eased correction, clamp latitude.
 * The constants are imported from the schema so the two cannot drift.
 *
 * The far view. From orbit there are thousands of objects in a few hundred
 * pixels, and drawn alike they are confetti. So as `far` rises each glyph
 * turns into a small point of added light: where traffic is thin the points
 * are faint specks, where it is dense they pile up and the corridor glows,
 * which is the density read straight off the picture. Objects also differ in
 * brightness there, by a rank hashed from their id (stable from batch to
 * batch), so a few carry the layer and the rest sit back, the way a sky has
 * few bright stars and many faint ones. The ranking reaches a little further
 * in than the points do (`ranked`), so a region crowded with small glyphs is
 * calmed the same way. Close in, every object is drawn at full strength.
 */
export const moversVS = /* glsl */ `\
#version 300 es
#define SHADER_NAME halo-movers-vertex

in vec2 positions;
in vec3 instancePositions;
in vec4 instanceMotion;
in vec3 instanceBlend;
in vec4 instanceStyle;
in vec4 instanceIdBytes;

out vec2 vLocal;
flat out float vTail;
flat out vec4 vTint;
flat out float vPixel;
flat out vec3 vFlags;
flat out vec2 vShape;

const float DEG = 0.017453292519943295;
const float EARTH_RADIUS_M = ${EARTH_RADIUS_M.toFixed(1)};
const float BLEND_SECONDS = ${BLEND_SECONDS.toFixed(4)};
const float PAD_RING = ${QUAD_PAD.ring.toFixed(2)};
const float FLAG_STATIONARY = 1.0;
const float FLAG_EMERGENCY = 2.0;
const float FLAG_STALE = 8.0;

// Size by category, as a share of the layer's size: see GLYPH_SCALE.
const float AIRCRAFT_SCALE[10] = ${glslArray(GLYPH_SCALE.aircraft)};
const float SHIP_SCALE[10] = ${glslArray(GLYPH_SCALE.ship)};
const float SATELLITE_SCALE[8] = ${glslArray(GLYPH_SCALE.satellite)};
// A ship drawn at its true length stops growing here, so a quad never covers the screen.
const float TRUE_SCALE_MAX_PX = 360.0;

${haloCommonVS}

bool hasFlag(float flags, float bit) {
  return mod(floor(flags / bit), 2.0) >= 1.0;
}

// 0..1 from the four bytes of an id (after Dave Hoskins' hash12).
float halo_rank(vec4 bytes) {
  vec3 p = fract(vec3(bytes.x + bytes.y * 256.0, bytes.z + bytes.w * 256.0, bytes.x + bytes.z * 16.0) * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

void main(void) {
  float flags = instanceStyle.y;
  bool stationary = hasFlag(flags, FLAG_STATIONARY);
  bool emergency = hasFlag(flags, FLAG_EMERGENCY);
  bool stale = hasFlag(flags, FLAG_STALE);
  float rank = halo_rank(instanceIdBytes);
  // The cheapest tier leaves the faintest objects of a far view undrawn,
  // and says so here, ahead of the projections that are most of this
  // shader's cost. They return as the view closes in.
  if (!emergency && rank < movers.thin * movers.ranked) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  float heading = instanceMotion.x;
  float speed = instanceMotion.y;
  float vrate = instanceMotion.z;
  float fixT = instanceMotion.w;
  // NaN fails every comparison, so this is false for an unknown heading on any driver.
  bool hasHeading = heading > -1.0e6 && heading < 1.0e6;

  float lat = instancePositions.y;
  float cosLat = max(cos(lat * DEG), 0.01);
  float h = hasHeading ? heading * DEG : 0.0;
  vec2 forward = vec2(sin(h) / cosLat, cos(h));

  float age = movers.time - fixT;
  float dt = clamp(age, 0.0, movers.maxDt);
  vec3 delta = vec3(0.0);
  if (dt > 0.0 && speed > 0.0 && hasHeading) {
    float arcDeg = speed * dt / EARTH_RADIUS_M / DEG;
    delta.xy = forward * arcDeg;
    delta.z = vrate * dt;
  }

  float since = movers.time - instanceBlend.z;
  if (since < BLEND_SECONDS) {
    float x = clamp(since / BLEND_SECONDS, 0.0, 1.0);
    delta.xy += instanceBlend.xy * (1.0 - x * x * (3.0 - 2.0 * x));
  }
  delta.y = clamp(lat + delta.y, -90.0, 90.0) - lat;

  vec3 fix = vec3(instancePositions.xy, instancePositions.z * movers.altitudeScale);
  delta.z *= movers.altitudeScale;
  vec3 probe = vec3(forward * movers.probeDeg, 0.0);

  // At street level deck.gl projects relative to the view centre; handing the
  // small delta over as the "low part" keeps motion smooth even though a
  // 32-bit longitude only resolves about a metre.
  vec3 common0;
  vec3 common1;
  if (project.projectionMode == PROJECTION_MODE_WEB_MERCATOR_AUTO_OFFSET) {
    common0 = project_position(fix, delta);
    common1 = project_position(fix, delta + probe);
  } else {
    common0 = project_position(fix + delta);
    common1 = project_position(fix + delta + probe);
  }

  geometry.worldPosition = fix + delta;
  geometry.position = vec4(common0, 1.0);
  geometry.pickingColor = picking_getPickingColorFromInstanceID();

  float visibility = halo_visibility(common0);
  if (visibility <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  vec4 clip0 = project_common_position_to_clipspace(vec4(common0, 1.0));
  vec4 clip1 = project_common_position_to_clipspace(vec4(common1, 1.0));
  vec2 ahead = halo_clip_delta_px(clip0, clip1);
  float aheadPx = length(ahead);
  vec2 dir = aheadPx > 1.0e-4 ? ahead / aheadPx : vec2(0.0, 1.0);
  vec2 side = vec2(-dir.y, dir.x);

  // The probe tells how many pixels a metre along the heading is here, foreshortening included.
  float pxPerMeter = aheadPx / (movers.probeDeg * DEG * EARTH_RADIUS_M);

  float category = instanceStyle.x;
  int cat = int(clamp(category, 0.0, 9.0));
  float lengthM = 0.0;
  float scale;
  if (movers.glyph < 0.5) {
    scale = AIRCRAFT_SCALE[cat];
  } else if (movers.glyph < 1.5) {
    // style.z is the ship's length over 400 m, when its static data has arrived.
    lengthM = instanceStyle.z / 255.0 * 400.0;
    scale = lengthM > 0.0 ? clamp(sqrt(lengthM / 150.0), 0.55, 1.5) : SHIP_SCALE[cat];
  } else {
    scale = SATELLITE_SCALE[min(cat, 7)];
  }
  float size = movers.sizePx * scale * (emergency ? 1.25 : 1.0);
  // Close in, a ship whose length is known is drawn at that length: a
  // 400 m container ship beside a 20 m pilot boat looks it.
  if (lengthM > 0.0) size = max(size, min(0.5 * lengthM * pxPerMeter, TRUE_SCALE_MAX_PX));

  // The far view: an emergency always stands out; everything else takes its rank.
  float far = emergency ? 0.0 : movers.far;
  float ranked = emergency ? 0.0 : movers.ranked;
  float standing = mix(movers.farDim, 1.0, rank * rank * rank);
  float pointPx = movers.farPointPx * (0.8 + 0.45 * standing);

  // Tail: the ground covered in tailSeconds, in screen pixels.
  float speedNorm = clamp(speed / movers.refSpeed, 0.0, 1.0);
  float tailPx = 0.0;
  if (movers.tailMaxPx > 0.0 && hasHeading && !stationary && speed > 0.5) {
    tailPx = clamp(speed * movers.tailSeconds * pxPerMeter, movers.tailMinPx * speedNorm, movers.tailMaxPx);
  }
  float tailUnits = tailPx / size;

  // Room for the glyph and its glow, or for the point of light it becomes.
  // Never tighter than the shape plus its antialiased edge, however small the glyph.
  float pad = max(emergency ? PAD_RING : movers.pad, 1.0 + 1.2 / size);
  if (far > 0.0) pad = max(pad, 2.4 * pointPx / size);

  vec2 local = vec2(mix(-(pad + tailUnits), pad, positions.x), positions.y * pad);
  vLocal = local;
  vTail = tailUnits;
  vPixel = 1.0 / size;
  vFlags = vec3(hasHeading ? 1.0 : 0.0, emergency ? 1.0 : 0.0, pointPx);
  // Moored ships and aircraft on the ground are drawn as outlines.
  vShape = vec2(category, stationary && movers.glyph < 1.5 ? 1.0 : 0.0);

  gl_Position = clip0;
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);
  gl_Position.xy += halo_px_to_clip((dir * local.x + side * local.y) * size, clip0.w);

  // Objects whose fix has outlived the extrapolation window hold position and dim.
  float fresh = 1.0 - 0.6 * smoothstep(movers.maxDt, movers.maxDt * 2.0 + 1.0, age);
  float alpha = visibility * fresh * (stale ? 0.4 : 1.0) * (stationary ? 0.75 : 1.0);
  if (project.projectionMode == PROJECTION_MODE_GLOBE) {
    vec3 toCamera = project.cameraPosition - common0;
    if (movers.limbFade > 0.0) {
      // Towards the limb the surface is seen edge-on and everything on it
      // crowds into a thin band; dim it there so the horizon stays a line of
      // atmosphere rather than a bar of glyphs.
      float facing = dot(normalize(common0), normalize(toCamera));
      alpha *= mix(1.0 - movers.limbFade, 1.0, smoothstep(0.0, 0.3, facing));
    }
    if (movers.spaceDim > 0.0 && far > 0.0) {
      // Things in orbit show past the edge of the planet, against black,
      // where every one of them is at full contrast. How far the line of
      // sight passes from the planet's centre says whether the background is
      // ground (under one radius) or space.
      vec3 ray = normalize(-toCamera);
      float passes = length(project.cameraPosition - ray * dot(project.cameraPosition, ray));
      float inSpace = smoothstep(GLOBE_RADIUS * 0.985, GLOBE_RADIUS * 1.02, passes);
      alpha *= 1.0 - movers.spaceDim * far * inSpace;
    }
  }
  alpha *= mix(1.0, standing, ranked) * mix(1.0, movers.farGain, far);
  vTint = vec4(movers.color, alpha * layer.opacity);
  DECKGL_FILTER_COLOR(vTint, geometry);
}
`;

export const moversFS = /* glsl */ `\
#version 300 es
#define SHADER_NAME halo-movers-fragment
precision highp float;

in vec2 vLocal;
flat in float vTail;
flat in vec4 vTint;
flat in float vPixel;
flat in vec3 vFlags;
flat in vec2 vShape;

out vec4 fragColor;

${haloShapesFS}

// Ship proportions by ShipCategory: the hull's half-beam, and the deckhouse
// (bridge or superstructure) as its centre and half-length along the hull.
//   unknown, cargo, tanker, passenger, fishing, service, high-speed, pleasure, military, other
const float SHIP_BEAM[10] = float[10](0.2, 0.2, 0.21, 0.24, 0.3, 0.34, 0.26, 0.3, 0.17, 0.22);
const vec2 SHIP_DECKHOUSE[10] = vec2[10](
  vec2(-0.72, 0.1), vec2(-0.72, 0.1), vec2(-0.74, 0.1), vec2(-0.15, 0.55), vec2(0.05, 0.16),
  vec2(0.25, 0.2), vec2(0.1, 0.25), vec2(-0.35, 0.18), vec2(0.0, 0.2), vec2(-0.6, 0.14)
);

void main(void) {
  geometry.uv = vLocal;
  vec2 p = vLocal;

  int cat = int(clamp(vShape.x, 0.0, 9.0));
  float d;
  // A part of the silhouette drawn solid: a ship's deckhouse, a satellite's body.
  float detail = 1.0e3;
  if (vFlags.x < 0.5) {
    // No heading: a neutral mark, since any silhouette would point somewhere.
    d = movers.glyph > 1.5 ? halo_sd_diamond(p) : halo_sd_circle(p, 0.55);
  } else if (movers.glyph < 0.5) {
    if (cat == 1 || cat == 7 || cat == 8) d = halo_sd_lightplane(p);
    else if (cat == 5) d = halo_sd_delta(p);
    else if (cat == 6) d = halo_sd_rotorcraft(p);
    else if (cat == 9) d = halo_sd_circle(p, 0.4);
    else d = halo_sd_airliner(p);
  } else if (movers.glyph < 1.5) {
    // A symbol first, a scale drawing last: small hulls are drawn fuller than
    // ships are, so they read as hulls and not as dashes, and take their true
    // proportions only as they grow towards their true size.
    float beam = SHIP_BEAM[cat] * mix(1.8, 1.0, smoothstep(16.0, 56.0, 1.0 / vPixel));
    d = halo_sd_ship(p, beam);
    vec2 house = SHIP_DECKHOUSE[cat];
    detail = halo_sd_box(p, vec2(house.x, 0.0), vec2(house.y, beam * 0.62));
  } else if (cat == 7) {
    // Debris: a speck, not a spacecraft.
    d = halo_sd_circle(p, 0.42);
  } else {
    d = halo_sd_satellite(p);
    detail = halo_sd_box(p, vec2(0.0), vec2(0.3, 0.3));
  }

  if (picking.isActive > 0.5) {
    // Pick the body plus a margin, so small glyphs are still easy to hit.
    if (d > 0.9) discard;
    fragColor = vec4(1.0);
    DECKGL_FILTER_COLOR(fragColor, geometry);
    return;
  }

  float far = vFlags.y > 0.5 ? 0.0 : movers.far;
  vec3 base = vTint.rgb;
  vec4 shape = vec4(0.0);

  if (far < 1.0) {
    float aa = vPixel * 0.75;
    // (A falling edge is written as one minus a rising one: GLSL leaves
    // smoothstep undefined when its first edge is the larger.)
    float core = 1.0 - smoothstep(-aa, aa, d);
    // A glyph only a few pixels across is a solid mark with no halo.
    float sizePx = 1.0 / vPixel;
    float presence = smoothstep(1.4, 4.5, sizePx);
    float glow = movers.glow * presence * exp(-max(d, 0.0) * 2.4);

    // Large enough to read as a shape, it is drawn like a vector plot: a
    // bright rim about a pixel wide round a see-through body, with its
    // deckhouse or satellite body solid. Moored and parked, the body is
    // nearly empty, so a harbour reads differently from traffic under way.
    float open = smoothstep(4.0, 9.0, sizePx);
    float inner = 1.0 - smoothstep(-aa, aa, d + 1.15 * vPixel);
    float rim = max(core - inner, 0.0);
    float part = (1.0 - smoothstep(-aa, aa, detail)) * inner;
    float body = vShape.y > 0.5 ? 0.1 : 0.36;
    float fill = mix(1.0, mix(body, 0.88, part), open);
    vec3 rimRgb = mix(base, vec3(1.0), 0.3 * open);

    // Comet tail behind the glyph: tapers and fades towards its end.
    float tail = 0.0;
    if (vTail > 0.0 && p.x < 0.0) {
      float u = clamp(-p.x / vTail, 0.0, 1.0);
      float halfWidth = mix(0.34, 0.05, u);
      float across = 1.0 - smoothstep(max(halfWidth * 0.2 - aa, 0.0), halfWidth + aa, abs(p.y));
      tail = across * pow(1.0 - u, 1.6) * 0.85 * step(-vTail, p.x);
    }

    float tailOnly = tail * (1.0 - core);
    vec3 rgb = (rimRgb * rim + base * inner * fill + base * glow * 0.42) * movers.body + base * tailOnly;
    float alpha = (rim + inner * fill) * movers.body + tailOnly * 0.8;

    if (vFlags.y > 0.5) {
      float r = length(p);
      float ringAt = mix(1.5, 2.9, movers.pulse);
      float ring = (1.0 - smoothstep(0.0, vPixel * 1.4, abs(r - ringAt))) * (1.0 - movers.pulse);
      float steady = (1.0 - smoothstep(0.0, vPixel * 1.2, abs(r - 1.5))) * 0.8;
      float mark = max(ring, steady);
      rgb += movers.emergencyColor * mark;
      alpha = max(alpha, mark);
    }
    // Small glyphs sit back a little so the planet under them stays the subject.
    shape = vec4(rgb, alpha) * mix(0.72, 1.0, presence);
  }

  vec4 point = vec4(0.0);
  if (far > 0.0) {
    // A point of light: colour and no cover, so points that overlap add up.
    float rPx = length(p) / vPixel;
    float falloff = rPx / vFlags.z;
    point = vec4(base * exp(-falloff * falloff), 0.0);
  }

  fragColor = mix(shape, point, far) * vTint.a;
  if (max(fragColor.a, max(fragColor.r, max(fragColor.g, fragColor.b))) < 0.004) discard;
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`;
