/**
 * GLSL shared by every Orya Halo point layer. It relies on deck.gl's `project`
 * module being included first.
 */

/**
 * `halo_visibility(common)`: 1 when a common-space point can be seen from the
 * camera, 0 when the planet is in the way, with a soft fade for points just
 * over the limb. The data layers draw into their own canvas above the map and
 * share no depth buffer with it, so occlusion by the globe is done here,
 * analytically: the segment from the camera to the point either dips inside
 * the sphere or it does not. `haloVisibility` in `maths.ts` mirrors it.
 *
 * `halo_px_to_clip(px, w)`: an offset in CSS pixels as a clip-space offset for
 * a vertex whose clip w is `w`, so billboards keep an exact pixel size
 * anywhere in the perspective view.
 */
export const haloCommonVS = /* glsl */ `\
const float HALO_LIMB_INNER = 0.9990;
const float HALO_LIMB_OUTER = 0.99995;

float halo_visibility(vec3 commonPosition) {
  if (project.projectionMode != PROJECTION_MODE_GLOBE) {
    return 1.0;
  }
  vec3 camera = project.cameraPosition;
  vec3 ray = commonPosition - camera;
  float t = clamp(-dot(camera, ray) / max(dot(ray, ray), 1e-12), 0.0, 1.0);
  float nearest = length(camera + ray * t);
  return smoothstep(GLOBE_RADIUS * HALO_LIMB_INNER, GLOBE_RADIUS * HALO_LIMB_OUTER, nearest);
}

vec2 halo_px_to_clip(vec2 px, float w) {
  return px * (2.0 * project.devicePixelRatio) / project.viewportSize * w;
}

// Clip-space difference of two projected points as CSS pixels (y up).
vec2 halo_clip_delta_px(vec4 a, vec4 b) {
  return (b.xy / b.w - a.xy / a.w) * project.viewportSize / (2.0 * project.devicePixelRatio);
}
`;

/** Signed distance helpers used by the glyph fragment shaders. */
export const haloShapesFS = /* glsl */ `\
// Distance to segment a-b, and winding bookkeeping for a polygon edge (after Inigo Quilez).
void halo_edge(vec2 p, vec2 a, vec2 b, inout float d, inout float s) {
  vec2 e = b - a;
  vec2 w = p - a;
  vec2 q = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
  d = min(d, dot(q, q));
  bvec3 c = bvec3(p.y >= a.y, p.y < b.y, e.x * w.y > e.y * w.x);
  if (all(c) || all(not(c))) s = -s;
}

// Dart pointing along +x: nose, two swept wing tips and a notch at the tail.
float halo_sd_chevron(vec2 p) {
  vec2 nose = vec2(1.0, 0.0);
  vec2 left = vec2(-0.82, 0.74);
  vec2 notch = vec2(-0.36, 0.0);
  vec2 right = vec2(-0.82, -0.74);
  float d = dot(p - nose, p - nose);
  float s = 1.0;
  halo_edge(p, nose, left, d, s);
  halo_edge(p, left, notch, d, s);
  halo_edge(p, notch, right, d, s);
  halo_edge(p, right, nose, d, s);
  return s * sqrt(d);
}

// Narrow hull pointing along +x: pointed bow, parallel sides, square stern.
float halo_sd_hull(vec2 p) {
  vec2 bow = vec2(1.0, 0.0);
  vec2 a = vec2(0.3, 0.36);
  vec2 b = vec2(-0.95, 0.36);
  vec2 c = vec2(-0.95, -0.36);
  vec2 e = vec2(0.3, -0.36);
  float d = dot(p - bow, p - bow);
  float s = 1.0;
  halo_edge(p, bow, a, d, s);
  halo_edge(p, a, b, d, s);
  halo_edge(p, b, c, d, s);
  halo_edge(p, c, e, d, s);
  halo_edge(p, e, bow, d, s);
  return s * sqrt(d);
}

float halo_sd_diamond(vec2 p) {
  return (abs(p.x) + abs(p.y) - 0.86) * 0.70710678;
}

float halo_sd_circle(vec2 p, float r) {
  return length(p) - r;
}
`;
