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

float halo_sd_box(vec2 p, vec2 c, vec2 h) {
  vec2 d = abs(p - c) - h;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

float halo_sd_capsule(vec2 p, vec2 a, vec2 b, float r) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)) - r;
}

// ── Silhouettes, seen from above, pointing along +x, inside the unit circle ──
// Polygons are written out in full rather than folded about the axis: a folded
// polygon has an edge along the axis, and that edge would show as a line in
// the outline the shader draws.

// Airliner: fuselage, swept wings, tailplane.
float halo_sd_airliner(vec2 p) {
  float body = halo_sd_capsule(p, vec2(-0.86, 0.0), vec2(0.88, 0.0), 0.105);
  float d = dot(p - vec2(0.30, 0.10), p - vec2(0.30, 0.10));
  float s = 1.0;
  halo_edge(p, vec2(0.30, 0.10), vec2(-0.20, 0.96), d, s);
  halo_edge(p, vec2(-0.20, 0.96), vec2(-0.36, 0.96), d, s);
  halo_edge(p, vec2(-0.36, 0.96), vec2(-0.16, 0.10), d, s);
  halo_edge(p, vec2(-0.16, 0.10), vec2(-0.16, -0.10), d, s);
  halo_edge(p, vec2(-0.16, -0.10), vec2(-0.36, -0.96), d, s);
  halo_edge(p, vec2(-0.36, -0.96), vec2(-0.20, -0.96), d, s);
  halo_edge(p, vec2(-0.20, -0.96), vec2(0.30, -0.10), d, s);
  halo_edge(p, vec2(0.30, -0.10), vec2(0.30, 0.10), d, s);
  float wings = s * sqrt(d);
  d = dot(p - vec2(-0.64, 0.06), p - vec2(-0.64, 0.06));
  s = 1.0;
  halo_edge(p, vec2(-0.64, 0.06), vec2(-0.86, 0.40), d, s);
  halo_edge(p, vec2(-0.86, 0.40), vec2(-0.97, 0.40), d, s);
  halo_edge(p, vec2(-0.97, 0.40), vec2(-0.88, 0.06), d, s);
  halo_edge(p, vec2(-0.88, 0.06), vec2(-0.88, -0.06), d, s);
  halo_edge(p, vec2(-0.88, -0.06), vec2(-0.97, -0.40), d, s);
  halo_edge(p, vec2(-0.97, -0.40), vec2(-0.86, -0.40), d, s);
  halo_edge(p, vec2(-0.86, -0.40), vec2(-0.64, -0.06), d, s);
  halo_edge(p, vec2(-0.64, -0.06), vec2(-0.64, 0.06), d, s);
  float tail = s * sqrt(d);
  return min(body, min(wings, tail));
}

// Light aircraft, glider or drone: straight high wing, short fuselage.
float halo_sd_lightplane(vec2 p) {
  float body = halo_sd_capsule(p, vec2(-0.80, 0.0), vec2(0.70, 0.0), 0.11);
  float wing = halo_sd_box(p, vec2(0.16, 0.0), vec2(0.13, 0.98));
  float tail = halo_sd_box(p, vec2(-0.76, 0.0), vec2(0.08, 0.34));
  return min(body, min(wing, tail));
}

// Fast jet: one delta wing on a long fuselage.
float halo_sd_delta(vec2 p) {
  float body = halo_sd_capsule(p, vec2(-0.90, 0.0), vec2(0.95, 0.0), 0.09);
  float d = dot(p - vec2(0.42, 0.0), p - vec2(0.42, 0.0));
  float s = 1.0;
  halo_edge(p, vec2(0.42, 0.0), vec2(-0.72, 0.72), d, s);
  halo_edge(p, vec2(-0.72, 0.72), vec2(-0.84, 0.72), d, s);
  halo_edge(p, vec2(-0.84, 0.72), vec2(-0.84, -0.72), d, s);
  halo_edge(p, vec2(-0.84, -0.72), vec2(-0.72, -0.72), d, s);
  halo_edge(p, vec2(-0.72, -0.72), vec2(0.42, 0.0), d, s);
  return min(body, s * sqrt(d));
}

// Helicopter: cabin, tail boom and the rotor disc as a thin ring.
float halo_sd_rotorcraft(vec2 p) {
  float cabin = halo_sd_capsule(p, vec2(-0.20, 0.0), vec2(0.34, 0.0), 0.2);
  float boom = halo_sd_capsule(p, vec2(-0.95, 0.0), vec2(-0.20, 0.0), 0.05);
  float disc = abs(length(p - vec2(0.06, 0.0)) - 0.82) - 0.035;
  return min(min(cabin, boom), disc);
}

// Hull: pointed bow, parallel sides, a squared-off stern. beam is the half-width.
float halo_sd_ship(vec2 p, float beam) {
  vec2 bow = vec2(1.0, 0.0);
  vec2 a = vec2(0.45, beam);
  vec2 b = vec2(-0.9, beam);
  vec2 c = vec2(-1.0, beam * 0.6);
  vec2 e = vec2(-1.0, -beam * 0.6);
  vec2 f = vec2(-0.9, -beam);
  vec2 g = vec2(0.45, -beam);
  float d = dot(p - bow, p - bow);
  float s = 1.0;
  halo_edge(p, bow, a, d, s);
  halo_edge(p, a, b, d, s);
  halo_edge(p, b, c, d, s);
  halo_edge(p, c, e, d, s);
  halo_edge(p, e, f, d, s);
  halo_edge(p, f, g, d, s);
  halo_edge(p, g, bow, d, s);
  return s * sqrt(d);
}

// Satellite: a body with a solar panel either side of the track.
float halo_sd_satellite(vec2 p) {
  vec2 q = vec2(p.x, abs(p.y));
  // A chunky body and thin wings: at a dozen pixels it still reads as -■-.
  float body = halo_sd_box(p, vec2(0.0), vec2(0.3, 0.3));
  float panel = halo_sd_box(q, vec2(0.0, 0.72), vec2(0.15, 0.28));
  float strut = halo_sd_box(q, vec2(0.0, 0.37), vec2(0.04, 0.08));
  return min(body, min(panel, strut));
}
`;
