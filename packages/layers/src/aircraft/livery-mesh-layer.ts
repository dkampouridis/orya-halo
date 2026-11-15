/**
 * deck.gl's SimpleMeshLayer, painting airline colour schemes on the aircraft
 * meshes from `aircraft-mesh.ts`.
 *
 * The schemes are a small texture (`liveryPalette`): one row per scheme,
 * one texel per colour. Each instance's `getColor` carries its scheme's row
 * in red and "selected" in green; each vertex carries its part and where on
 * the part it is (see `MeshPart`). The fragment shader looks the colours up
 * and draws the belly line, the fin's second colour and the windows there,
 * so their edges stay sharp however close the camera is.
 *
 * The shaders are SimpleMeshLayer's own (deck.gl 9.4) with that added. With
 * no palette texture the layer draws `getColor` as SimpleMeshLayer would.
 */
import { SimpleMeshLayer } from "@deck.gl/mesh-layers";
import type { Device, Texture } from "@luma.gl/core";
import { AIRCRAFT_LIVERIES } from "@orya-halo/schema";
import type { AircraftLivery } from "@orya-halo/schema";

/** Texels per scheme in the palette, see `liveryPaletteData`. */
export const PALETTE_WIDTH = 8;

const ACCENT_CODE = { top: 1, bottom: 2, rear: 3, front: 4 } as const;

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * The palette's pixels, RGBA, `PALETTE_WIDTH` texels per scheme:
 * 0 top colour, belly line ((sine + 1) / 2) in alpha;
 * 1 belly colour, accent kind (0 none, 1 top, 2 bottom, 3 rear, 4 front) in alpha;
 * 2 fin colour, accent split in alpha; 3 accent colour; 4 engines.
 */
export function liveryPaletteData(liveries: readonly AircraftLivery[]): Uint8Array {
  const data = new Uint8Array(liveries.length * PALETTE_WIDTH * 4);
  liveries.forEach((l, row) => {
    const put = (texel: number, color: string, alpha: number): void => {
      const o = (row * PALETTE_WIDTH + texel) * 4;
      data.set([...rgb(color), Math.round(Math.min(Math.max(alpha, 0), 1) * 255)], o);
    };
    const bellyLine = l.belly ? (l.bellyLine ?? -0.3) : -1;
    put(0, l.top, (bellyLine + 1) / 2);
    put(1, l.belly ?? l.top, l.accent ? ACCENT_CODE[l.accent.on] / 255 : 0);
    put(2, l.tail, l.accent?.split ?? 0);
    put(3, l.accent?.color ?? l.tail, 1);
    put(4, l.engines ?? "#c4ccd2", 1);
  });
  return data;
}

/** The palette texture for every scheme in `AIRCRAFT_LIVERIES`. The caller destroys it. */
export function createLiveryPalette(device: Device): Texture {
  return device.createTexture({
    id: "aircraft-liveries",
    data: liveryPaletteData(AIRCRAFT_LIVERIES),
    width: PALETTE_WIDTH,
    height: AIRCRAFT_LIVERIES.length,
    format: "rgba8unorm",
    mipLevels: 1,
    sampler: { minFilter: "nearest", magFilter: "nearest" },
  });
}

const VS = /* glsl */ `#version 300 es
#define SHADER_NAME aircraft-livery-mesh-layer-vs
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
flat out int vLivery;
void main(void) {
  geometry.worldPosition = instancePositions;
  geometry.uv = texCoords;
  geometry.pickingColor = picking_getPickingColorFromInstanceID();
  vTexCoord = texCoords;
  vPart = colors;
  vLivery = int(instanceColors.r * 255.0 + 0.5);
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
#define SHADER_NAME aircraft-livery-mesh-layer-fs
precision highp float;
uniform sampler2D sampler;
in vec2 vTexCoord;
in vec3 cameraPosition;
in vec3 normals_commonspace;
in vec4 position_commonspace;
in vec4 vColor;
in vec3 vPart;
flat in int vLivery;
out vec4 fragColor;

const vec3 WING = vec3(0.79, 0.81, 0.83);
const vec3 DARK = vec3(0.16, 0.17, 0.18);
const vec3 GLASS = vec3(0.10, 0.13, 0.16);

vec4 palette(int texel) {
  int rows = textureSize(sampler, 0).y;
  return texelFetch(sampler, ivec2(texel, clamp(vLivery, 0, rows - 1)), 0);
}

// 0 below edge, 1 above it, with a pixel's width of blending.
float above(float x, float edge) {
  float w = max(fwidth(x), 1e-4);
  return smoothstep(edge - w, edge + w, x);
}

float between(float x, float lo, float hi) {
  return above(x, lo) * (1.0 - above(x, hi));
}

vec3 fuselage(int part) {
  float a = vPart.y;
  float fromNose = vPart.z;
  float cabin = vTexCoord.x;
  vec4 top = palette(0);
  vec3 c = mix(palette(1).rgb, top.rgb, above(a, top.a * 2.0 - 1.0));
  float glass = 0.0;
  if (part == 0) {
    // A row of cabin windows: dots when close, a dark line when they are too small to tell apart.
    float row = between(a, 0.30, 0.44) * between(cabin, 0.03, 0.96);
    float pitch = fromNose * 8.0;
    float blur = clamp(fwidth(pitch) * 1.5, 0.0, 1.0);
    float dots = mix(between(fract(pitch), 0.25, 0.75), 0.5, blur);
    glass = row * dots * 0.85;
    // Flight-deck windows on the nose.
    glass = max(glass, between(fromNose, 0.52, 0.86) * between(a, 0.16, 0.5));
  } else if (part == 6) {
    // A light aircraft's cabin: glazed above the waist at the front of the cabin.
    glass = between(cabin, 0.55, 1.02) * above(a, 0.2);
  } else {
    // A helicopter's nose is mostly glass.
    glass = above(cabin, 0.62) * above(a, -0.3);
  }
  return mix(c, GLASS, glass);
}

vec3 fin() {
  vec3 tail = palette(2).rgb;
  float kind = palette(1).a * 255.0;
  float split = palette(2).a;
  float height = vPart.y;
  float chord = vPart.z;
  float accent = 0.0;
  if (kind > 0.5 && kind < 1.5) accent = above(height, split);
  else if (kind > 1.5 && kind < 2.5) accent = 1.0 - above(height, split);
  else if (kind > 2.5 && kind < 3.5) accent = above(chord, split);
  else if (kind > 3.5) accent = 1.0 - above(chord, split);
  return mix(tail, palette(3).rgb, accent);
}

vec3 livery() {
  int part = int(vPart.x + 0.5);
  if (part == 0 || part == 6 || part == 7) return fuselage(part);
  if (part == 2) return fin();
  if (part == 3) return palette(4).rgb;
  if (part == 4) return DARK;
  if (part == 5) return palette(2).rgb;
  return WING;
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
    color = vec4(livery(), vColor.a);
    // The selected aircraft, a touch brighter.
    color.rgb = mix(color.rgb, vec3(1.0), vColor.g * 0.18);
  }
  DECKGL_FILTER_COLOR(color, geometry);
  vec3 lightColor = lighting_getLightColor(color.rgb, cameraPosition, position_commonspace.xyz, normal);
  fragColor = vec4(lightColor, color.a * layer.opacity);
}
`;

export class LiveryMeshLayer<D> extends SimpleMeshLayer<D> {
  static override layerName = "LiveryMeshLayer";

  override getShaders() {
    return { ...super.getShaders(), vs: VS, fs: FS };
  }
}
