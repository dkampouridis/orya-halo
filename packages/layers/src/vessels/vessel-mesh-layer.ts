/**
 * deck.gl's SimpleMeshLayer, painting vessel colour schemes on the meshes
 * from `vessel-mesh.ts`.
 *
 * The schemes are a small texture (`vesselPalette`): one row per scheme, one
 * texel per colour. Each instance's `getColor` carries its scheme's row in
 * red, "selected" in green and a per-ship number in blue (which containers
 * are which colour); each vertex carries its part and where on the part it
 * is (see `ShipPart`). The fragment shader looks the colours up and draws
 * the hull band, the bow stripe, window rows and container boxes there, so
 * their edges stay sharp however close the camera is.
 *
 * The shaders are SimpleMeshLayer's own (deck.gl 9.4) with that added, like
 * `livery-mesh-layer.ts` for aircraft. With no palette texture the layer
 * draws `getColor` as SimpleMeshLayer would.
 */
import { SimpleMeshLayer } from "@deck.gl/mesh-layers";
import type { Device, Texture } from "@luma.gl/core";
import { VESSEL_SCHEMES } from "@orya-halo/schema";
import type { VesselScheme } from "@orya-halo/schema";

/** Texels per scheme in the palette, see `vesselPaletteData`. */
export const VESSEL_PALETTE_WIDTH = 9;

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * The palette's pixels, RGBA, `VESSEL_PALETTE_WIDTH` texels per scheme:
 * 0 hull, the band's top (share of the freeboard) in alpha;
 * 1 band colour (the hull's when there is none);
 * 2 deck; 3 superstructure;
 * 4 funnel, its top band's share in alpha; 5 funnel top;
 * 6 container colour, the share of boxes in it in alpha;
 * 7 accent; 8 bow stripe, 255 in alpha when there is one.
 */
export function vesselPaletteData(schemes: readonly VesselScheme[]): Uint8Array {
  const data = new Uint8Array(schemes.length * VESSEL_PALETTE_WIDTH * 4);
  schemes.forEach((s, row) => {
    const put = (texel: number, color: string, alpha: number): void => {
      const o = (row * VESSEL_PALETTE_WIDTH + texel) * 4;
      data.set([...rgb(color), Math.round(Math.min(Math.max(alpha, 0), 1) * 255)], o);
    };
    put(0, s.hull, s.band?.below ?? 0);
    put(1, s.band?.color ?? s.hull, 1);
    put(2, s.deck, 1);
    put(3, s.superstructure, 1);
    put(4, s.funnel, s.funnelTop?.share ?? 0);
    put(5, s.funnelTop?.color ?? s.funnel, 1);
    put(6, s.boxes?.color ?? s.hull, s.boxes?.share ?? 0);
    put(7, s.accent, 1);
    put(8, s.stripe ?? s.hull, s.stripe ? 1 : 0);
  });
  return data;
}

/** The palette texture for every scheme in `VESSEL_SCHEMES`. The caller destroys it. */
export function createVesselPalette(device: Device): Texture {
  return device.createTexture({
    id: "vessel-schemes",
    data: vesselPaletteData(VESSEL_SCHEMES),
    width: VESSEL_PALETTE_WIDTH,
    height: VESSEL_SCHEMES.length,
    format: "rgba8unorm",
    mipLevels: 1,
    sampler: { minFilter: "nearest", magFilter: "nearest" },
  });
}

const VS = /* glsl */ `#version 300 es
#define SHADER_NAME vessel-scheme-mesh-layer-vs
in vec3 positions;
in vec3 normals;
in vec3 colors;
in vec2 texCoords;
in vec3 instancePositions;
in vec3 instancePositions64Low;
in vec4 instanceColors;
in vec3 instanceModelMatrixCol0;
in vec3 instanceModelMatrixCol1;
in vec3 instanceModelMatrixCol2;
in vec3 instanceTranslation;
out vec2 vTexCoord;
out vec3 cameraPosition;
out vec3 normals_commonspace;
out vec4 position_commonspace;
out vec4 vColor;
out vec3 vPart;
flat out int vScheme;
flat out float vSeed;
void main(void) {
  geometry.worldPosition = instancePositions;
  geometry.uv = texCoords;
  geometry.pickingColor = picking_getPickingColorFromInstanceID();
  vTexCoord = texCoords;
  vPart = colors;
  vScheme = int(instanceColors.r * 255.0 + 0.5);
  vSeed = floor(instanceColors.b * 255.0 + 0.5);
  cameraPosition = project.cameraPosition;
  vColor = instanceColors;
  mat3 instanceModelMatrix = mat3(instanceModelMatrixCol0, instanceModelMatrixCol1, instanceModelMatrixCol2);
  vec3 pos = (instanceModelMatrix * positions) * simpleMesh.sizeScale + instanceTranslation;
  if (simpleMesh.composeModelMatrix) {
    DECKGL_FILTER_SIZE(pos, geometry);
    normals_commonspace = project_normal(instanceModelMatrix * normals);
    geometry.worldPosition += pos;
    gl_Position = project_position_to_clipspace(pos + instancePositions, instancePositions64Low, vec3(0.0), position_commonspace);
    geometry.position = position_commonspace;
  } else {
    pos = project_size(pos);
    DECKGL_FILTER_SIZE(pos, geometry);
    gl_Position = project_position_to_clipspace(instancePositions, instancePositions64Low, pos, position_commonspace);
    geometry.position = position_commonspace;
    normals_commonspace = project_normal(instanceModelMatrix * normals);
  }
  geometry.normal = normals_commonspace;
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);
  DECKGL_FILTER_COLOR(vColor, geometry);
}
`;

const FS = /* glsl */ `#version 300 es
#define SHADER_NAME vessel-scheme-mesh-layer-fs
precision highp float;
uniform sampler2D sampler;
in vec2 vTexCoord;
in vec3 cameraPosition;
in vec3 normals_commonspace;
in vec4 position_commonspace;
in vec4 vColor;
in vec3 vPart;
flat in int vScheme;
flat in float vSeed;
out vec4 fragColor;

const vec3 DARK = vec3(0.15, 0.16, 0.17);
const vec3 GLASS = vec3(0.09, 0.12, 0.15);
const vec3 SAIL = vec3(0.95, 0.94, 0.9);
const vec3 LIGHT = vec3(0.78, 0.8, 0.81);
// Container colours seen in any port: rust, blues, greens, greys, white, orange, yellow, magenta, brown.
const vec3 BOXES[12] = vec3[12](
  vec3(0.55, 0.19, 0.14), vec3(0.13, 0.31, 0.56), vec3(0.19, 0.42, 0.24), vec3(0.54, 0.56, 0.58),
  vec3(0.86, 0.87, 0.86), vec3(0.82, 0.42, 0.13), vec3(0.85, 0.65, 0.14), vec3(0.67, 0.1, 0.42),
  vec3(0.11, 0.37, 0.39), vec3(0.42, 0.29, 0.18), vec3(0.3, 0.62, 0.78), vec3(0.37, 0.13, 0.17)
);

vec4 palette(int texel) {
  int rows = textureSize(sampler, 0).y;
  return texelFetch(sampler, ivec2(texel, clamp(vScheme, 0, rows - 1)), 0);
}

// 0 below edge, 1 above it, with a pixel's width of blending.
float above(float x, float edge) {
  float w = max(fwidth(x), 1e-4);
  return smoothstep(edge - w, edge + w, x);
}

float between(float x, float lo, float hi) {
  return above(x, lo) * (1.0 - above(x, hi));
}

// 0..1 from three whole numbers, in integer arithmetic: a float hash of
// numbers this large comes out different from one pixel to the next.
float hash(vec3 v) {
  uvec3 q = uvec3(ivec3(floor(v + 0.5)) + 65536);
  uint h = q.x * 1664525u ^ q.y * 1013904223u ^ q.z * 22695477u;
  h ^= h >> 16;
  h *= 2246822519u;
  h ^= h >> 13;
  h *= 3266489917u;
  h ^= h >> 16;
  return float(h & 0xffffffu) / 16777216.0;
}

vec3 hull() {
  float h = vPart.y;
  float u = vPart.z;
  vec4 top = palette(0);
  vec3 c = top.a > 0.002 ? mix(palette(1).rgb, top.rgb, above(h, top.a)) : top.rgb;
  vec4 stripe = palette(8);
  if (stripe.a > 0.5) {
    // A broad band and a narrow one, leaning aft as they rise.
    float d = u + h * 0.035;
    c = mix(c, stripe.rgb, max(between(d, 0.79, 0.825), between(d, 0.832, 0.842)));
  }
  return c;
}

vec3 superstructure() {
  vec3 c = palette(3).rgb;
  if (vPart.y > 0.5) return c * 0.94;
  float kind = vPart.z;
  if (kind < 0.5) return c;
  float up = vTexCoord.y / 2.8;
  float rowBlur = clamp(fwidth(up) * 2.0, 0.0, 1.0);
  float glass;
  if (kind < 1.5) {
    // Rows of windows: dots when close, a dark line when they are too small to tell apart.
    float row = mix(between(fract(up), 0.42, 0.72), 0.3, rowBlur);
    float along = vTexCoord.x / 1.8;
    float colBlur = clamp(fwidth(along) * 1.5, 0.0, 1.0);
    float col = mix(between(fract(along), 0.2, 0.8), 0.6, colBlur);
    glass = row * col * step(0.9, vTexCoord.y);
  } else {
    // A band of glass on every deck: a bridge, or a cruise ship's balconies.
    glass = mix(between(fract(up), 0.32, 0.82), 0.5, rowBlur) * step(0.6, vTexCoord.y);
  }
  return mix(c, GLASS, glass * 0.85);
}

vec3 funnel() {
  vec4 f = palette(4);
  return f.a > 0.002 ? mix(f.rgb, palette(5).rgb, above(vPart.y, 1.0 - f.a)) : f.rgb;
}

vec3 containers() {
  vec2 p = vTexCoord;
  vec2 cell = floor(p);
  // One colour per box: on the ends a cell is a row by a tier, on the sides a whole 40 ft box by a tier.
  float r = hash(vec3(cell.x + vPart.y * 64.0, cell.y + vPart.z * 128.0, vSeed));
  // A stack's top shows its highest boxes, whatever the tier: one row of colours across.
  if (vPart.z > 1.5) r = hash(vec3(cell.x + vPart.y * 64.0, 999.0, vSeed));
  vec4 line = palette(6);
  vec3 c = r < line.a ? line.rgb : BOXES[int(r * 4096.0) % 12];
  // Seams between boxes, fading out when they are smaller than a pixel.
  vec2 f = fract(p);
  vec2 w = fwidth(p);
  float seam = (1.0 - between(f.x, 0.04, 0.96)) * clamp(1.0 - w.x * 3.0, 0.0, 1.0);
  seam = max(seam, (1.0 - between(f.y, 0.04, 0.96)) * clamp(1.0 - w.y * 3.0, 0.0, 1.0));
  return c * (1.0 - 0.45 * seam);
}

vec3 scheme() {
  int part = int(vPart.x + 0.5);
  if (part == 0) return hull();
  if (part == 1) return palette(2).rgb;
  if (part == 2) return superstructure();
  if (part == 3) return funnel();
  if (part == 4) return containers();
  if (part == 5) return DARK;
  if (part == 6) return palette(7).rgb;
  if (part == 7) return palette(2).rgb * 0.82;
  if (part == 8) return SAIL;
  return LIGHT;
}

void main(void) {
  geometry.uv = vTexCoord;
  vec3 normal;
  if (simpleMesh.flatShading) {
    normal = normalize(cross(dFdx(position_commonspace.xyz), dFdy(position_commonspace.xyz)));
  } else {
    normal = normals_commonspace;
  }
  vec4 color = vColor;
  if (simpleMesh.hasTexture) {
    color = vec4(scheme(), vColor.a);
    // The selected ship, a touch brighter.
    color.rgb = mix(color.rgb, vec3(1.0), vColor.g * 0.18);
  }
  DECKGL_FILTER_COLOR(color, geometry);
  vec3 lightColor = lighting_getLightColor(color.rgb, cameraPosition, position_commonspace.xyz, normal);
  fragColor = vec4(lightColor, color.a * layer.opacity);
}
`;

export class VesselMeshLayer<D> extends SimpleMeshLayer<D> {
  static override layerName = "VesselMeshLayer";

  override getShaders() {
    return { ...super.getShaders(), vs: VS, fs: FS };
  }
}
