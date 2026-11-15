import { NIGHT_FULL, NIGHT_START } from "./solar.ts";

/**
 * Two full-screen passes draw everything that is not map data.
 *
 * The first multiplies: it lifts the daylit side of the planet towards the
 * point under the sun, so the globe reads as a lit sphere and the terminator
 * has something to stand against. The second darkens and adds: night
 * shading, city lights and the terminator glow on the planet, the starfield
 * and atmosphere rim outside it.
 *
 * Each pixel's view ray is intersected with the planet analytically (a unit
 * sphere under globe projection, the z = 0 plane once MapLibre has eased into
 * Mercator at street level), so nothing depends on MapLibre's tile meshes or
 * its internal shader prelude: only on the projection matrix it documents for
 * custom layers. The rays' end points are unprojected on the CPU in 64-bit
 * and interpolated, which is exact because the near and far planes map
 * affinely to the screen.
 */
export const spaceVS = /* glsl */ `#version 300 es
in vec2 a_pos;
in vec3 a_near;
in vec3 a_far;
out vec3 v_near;
out vec3 v_far;
void main() {
  v_near = a_near;
  v_far = a_far;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

/** How much brighter the ground is directly under the sun than at the terminator (docs/mockup/NOTES.md, deviation 7). */
export const DAY_LIFT = 0.6;

/** Ray set-up and the planet intersection, shared by both passes. */
const surface = /* glsl */ `
precision highp float;

in vec3 v_near;
in vec3 v_far;
out vec4 fragColor;

uniform float u_flat;        // 1 when MapLibre renders in Mercator
uniform vec3 u_sun;          // unit vector to the sun, globe frame
uniform float u_night;       // 0..1 strength of the day/night treatment

const float PI = 3.141592653589793;

struct Surface {
  bool hit;
  vec3 origin;
  vec3 dir;
  vec3 normal;     // surface normal in the globe frame
  float grazing;   // 0 looking straight down, 1 at the limb
  float miss;      // how far the ray passes above the surface, planet radii
};

Surface haloSurface() {
  Surface s;
  s.origin = v_near;
  s.dir = normalize(v_far - v_near);
  s.grazing = 0.0;
  if (u_flat > 0.5) {
    float t = abs(s.dir.z) > 1e-9 ? -s.origin.z / s.dir.z : -1.0;
    s.hit = t > 0.0;
    vec2 m = s.origin.xy + s.dir.xy * t;
    float lon = (m.x * 2.0 - 1.0) * PI;
    float lat = atan(sinh(PI * (1.0 - 2.0 * m.y)));
    s.normal = vec3(sin(lon) * cos(lat), sin(lat), cos(lon) * cos(lat));
    s.miss = 1.0;
  } else {
    float b = dot(s.origin, s.dir);
    float c = dot(s.origin, s.origin) - 1.0;
    float disc = b * b - c;
    float t = -b - sqrt(max(disc, 0.0));
    s.hit = disc > 0.0 && t > 0.0;
    s.normal = normalize(s.origin + s.dir * t);
    s.grazing = 1.0 - clamp(dot(s.normal, -s.dir), 0.0, 1.0);
    s.miss = sqrt(max(c + 1.0 - b * b, 0.0)) - 1.0;
  }
  return s;
}
`;

/**
 * Daylight. Blended as destination * (1 + source), so the map keeps its own
 * colours and contrast and only gains light: land `#10151c` reaches about
 * `#1a222d` under the sun and is untouched at the terminator.
 */
export const liftFS = /* glsl */ `#version 300 es
${surface}
void main() {
  Surface s = haloSurface();
  if (!s.hit || u_night <= 0.0) discard;
  float sunSine = dot(s.normal, u_sun);
  if (sunSine <= 0.0) discard;
  // Rises quickly past the terminator, then eases towards the subsolar point.
  float lift = ${DAY_LIFT.toFixed(2)} * pow(sunSine, 0.6) * u_night;
  fragColor = vec4(vec3(lift), 0.0);
}
`;

export const spaceFS = /* glsl */ `#version 300 es
${surface}
uniform float u_shade;       // how dark full night is, 0..1
uniform float u_lights;      // 0..1 strength of the city lights
uniform float u_lightsLod;   // texels of the lights map per radian
uniform vec2 u_lightsSize;   // the lights map's size in texels
uniform float u_fine;        // 1 on the costlier tiers: smooth magnification and a wide glow
uniform float u_stars;       // 0..1
uniform float u_faintStars;  // 1 adds the dense layer of faint stars
uniform float u_rim;         // 0..1
uniform vec3 u_rimColor;
uniform vec3 u_lightColor;
uniform sampler2D u_lightsMap;

const float NIGHT_START = ${NIGHT_START.toFixed(4)};
const float NIGHT_FULL = ${NIGHT_FULL.toFixed(4)};

vec3 hash3(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

// Stars live at infinity in the Earth's frame: turning the globe slides them
// past the limb, zooming does not move them. One candidate per cube-map cell.
float starLayer(vec3 dir, float cells, float threshold, float sizePx) {
  vec3 a = abs(dir);
  float face;
  float major;
  vec2 uv;
  if (a.x >= a.y && a.x >= a.z) {
    face = dir.x > 0.0 ? 0.0 : 1.0;
    major = a.x;
    uv = dir.yz / a.x;
  } else if (a.y >= a.z) {
    face = dir.y > 0.0 ? 2.0 : 3.0;
    major = a.y;
    uv = dir.xz / a.y;
  } else {
    face = dir.z > 0.0 ? 4.0 : 5.0;
    major = a.z;
    uv = dir.xy / a.z;
  }
  vec2 g = uv * cells;
  vec2 cell = floor(g);
  vec3 rnd = hash3(vec3(cell, face * 19.0 + cells));
  if (rnd.z < threshold) return 0.0;
  vec2 offset = fract(g) - (0.2 + 0.6 * rnd.xy);
  // Screen-space footprint keeps stars about a pixel wide at any pixel ratio.
  // It is taken from the direction, which is continuous: the grid coordinate
  // jumps at cube-face edges and its derivative would draw the seams.
  float pixel = max(length(dFdx(dir)), length(dFdy(dir))) * cells / major;
  float distPx = length(offset) / max(pixel, 1e-6);
  float brightness = (rnd.z - threshold) / (1.0 - threshold);
  return brightness * brightness * exp(-distPx * distPx / (sizePx * sizePx));
}

vec3 stars(vec3 dir) {
  float bright = starLayer(dir, 15.0, 0.55, 1.15);
  // The faint layer is nine times as many candidates; the low tier leaves it out.
  float faint = u_faintStars > 0.5 ? starLayer(dir, 46.0, 0.35, 0.8) * 0.55 : 0.0;
  // A cool/warm lean, taken from the direction so a star keeps its colour.
  vec3 tint = mix(vec3(0.78, 0.86, 1.0), vec3(1.0, 0.93, 0.84), hash3(floor(dir * 15.0)).x);
  return tint * (faint + bright);
}

// City lights. The map is NASA's Black Marble in grey, eight bits: towns sit
// in the lowest tenth of the range and the centres of large cities press
// against the top of it. Shown as it is, the towns vanish and the cities
// clip. So: drop the compression noise, lift the bottom of the range, keep
// the top nearly straight so what variation a city has survives, and stop
// short of full brightness. The colour carries density as well: sodium
// orange where light is thin, the layer's warm white where it is thick, and
// never white.
// "detail" is 1 while the map is shown at its own resolution or smaller and
// falls towards 0 as it is stretched: the lift that makes towns visible from
// orbit would, close in, only show the map's own grain.
vec3 cityLights(float raw, float wide, float detail) {
  float x = max(raw - 0.028, 0.0) / 0.972;
  float lit = 0.34 * mix(0.3, 1.0, detail) * pow(x, 0.48) + 0.58 * pow(x, 1.7);
  vec3 thin = u_lightColor * vec3(1.0, 0.82, 0.62);
  vec3 thick = mix(u_lightColor, vec3(1.0, 0.95, 0.86), 0.45);
  vec3 color = mix(thin, u_lightColor, smoothstep(0.05, 0.55, lit));
  color = mix(color, thick, smoothstep(0.7, 0.92, lit));
  // A region full of light glows as a region, without filling in its cities.
  float glow = pow(max(wide - 0.02, 0.0), 0.8) * 0.3;
  return color * lit + thin * glow;
}

// The lights map stretched without its texels showing: a cubic B-spline
// through four bilinear reads (after Sigg and Hadwiger, GPU Gems 2).
float lightsSmooth(vec2 uv) {
  vec2 st = uv * u_lightsSize - 0.5;
  vec2 i = floor(st);
  vec2 f = st - i;
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1;
  vec2 g1 = 1.0 - g0;
  vec2 h0 = (i + 0.5 - 1.0 + w1 / g0) / u_lightsSize;
  vec2 h1 = (i + 0.5 + 1.0 + w3 / g1) / u_lightsSize;
  float a = textureLod(u_lightsMap, vec2(h0.x, h0.y), 0.0).r;
  float b = textureLod(u_lightsMap, vec2(h1.x, h0.y), 0.0).r;
  float c = textureLod(u_lightsMap, vec2(h0.x, h1.y), 0.0).r;
  float d = textureLod(u_lightsMap, vec2(h1.x, h1.y), 0.0).r;
  return g0.y * (g0.x * a + g1.x * b) + g1.y * (g0.x * c + g1.x * d);
}

void main() {
  Surface s = haloSurface();
  vec3 dir = s.dir;
  vec3 origin = s.origin;
  vec3 normal = s.normal;

  if (!s.hit) {
    vec3 color = stars(dir) * u_stars;
    if (u_flat < 0.5) {
      // Thin scattering shell: a tight bright edge and a wide faint skirt,
      // brighter where the limb is sunlit.
      vec3 limb = normalize(origin - dir * dot(origin, dir));
      float lit = mix(0.42, 1.0, smoothstep(-0.25, 0.3, dot(limb, u_sun)));
      float lean = mix(1.0, lit, u_night);
      float glow = exp(-s.miss / 0.012) * 0.85 + exp(-s.miss / 0.07) * 0.2;
      // Stars do not show through the brightest part of the atmosphere.
      color = color * (1.0 - clamp(glow * 1.4, 0.0, 1.0)) + u_rimColor * glow * lean * u_rim;
    }
    fragColor = vec4(color, 1.0);
    return;
  }

  float sunSine = dot(normal, u_sun);
  float night = (1.0 - smoothstep(NIGHT_FULL, NIGHT_START, sunSine)) * u_night;

  // Darken towards night; everything below is added light.
  float shade = night * u_shade;
  vec3 light = vec3(0.0);

  if (u_lights > 0.0 && night > 0.0) {
    float lon = atan(normal.x, normal.z);
    float lat = asin(clamp(normal.y, -1.0, 1.0));
    vec2 uv = vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);
    // Level of detail from the continuous normal: the longitude wraps, so the
    // automatic derivative would spike along the antimeridian.
    float radiansPerPixel = max(length(dFdx(normal)), length(dFdy(normal)));
    float texelsPerPixel = radiansPerPixel * u_lightsLod;
    float lod = log2(max(texelsPerPixel, 1.0));
    float raw;
    if (texelsPerPixel >= 1.0 || u_fine < 0.5) {
      raw = textureLod(u_lightsMap, uv, lod).r;
    } else {
      // Stretched: ease from the plain read into the smooth one over the first doubling.
      raw = lightsSmooth(uv);
      if (texelsPerPixel > 0.5) {
        raw = mix(raw, textureLod(u_lightsMap, uv, 0.0).r, texelsPerPixel * 2.0 - 1.0);
      }
    }
    float wide = u_fine > 0.5 ? textureLod(u_lightsMap, uv, lod + 2.6).r : 0.0;
    float detail = smoothstep(0.12, 0.7, texelsPerPixel);
    light += cityLights(raw, wide, detail) * night * u_lights;
  }

  // The terminator: a soft warm band where day meets night.
  float band = exp(-pow((sunSine - 0.01) / 0.036, 2.0));
  light += u_lightColor * band * 0.05 * u_night;

  if (u_flat < 0.5) {
    // Inner rim: the atmosphere seen edge-on just inside the limb.
    float lit = mix(0.35, 1.0, smoothstep(-0.25, 0.3, sunSine));
    float lean = mix(1.0, lit, u_night);
    light += u_rimColor * (pow(s.grazing, 5.0) * 0.55 + pow(s.grazing, 14.0) * 0.4) * lean * u_rim;
  }

  fragColor = vec4(light, shade);
}
`;
