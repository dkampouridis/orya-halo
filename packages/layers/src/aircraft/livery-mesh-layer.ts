/**
 * deck.gl's SimpleMeshLayer, painting airline colour schemes on the aircraft
 * meshes from `aircraft-mesh.ts`.
 *
 * The schemes are a small texture (`liveryPalette`): one row per scheme, a
 * few texels per colour and its parameters. Each instance's `getColor`
 * carries its scheme's row in red, "selected" in green and how small it is
 * drawn in blue (see `liverySmallness`); each vertex carries its part and
 * where on the part it is (see `MeshPart`). The fragment shader looks the
 * colours up and draws the belly line, the fin's second colour, the nose, the
 * rear fuselage, the cheatline and the windows there, so their edges stay
 * sharp however close the camera is.
 *
 * A model a few dozen pixels long is mostly white from above, as most
 * airliners are, and the fin that carries most airlines' colour is edge-on:
 * at country zoom a fin is a speck a pixel or two wide, the same speck for
 * every red-finned airline. So while a model is small, like a map symbol,
 * its colours are exaggerated:
 *
 * - a strip along the top of the fuselage, from the tail forward to about
 *   half its length, carries the fin's colours (its second colour where the
 *   fin has one, laid out as on the fin), or the scheme's mark where the fin
 *   is white or grey (`liveryMark`);
 * - the fin is drawn thicker when seen from above, less so as it is seen
 *   side-on, where its colour already shows;
 * - dark colours are drawn lighter (`liftColour`, hue and chroma kept), so
 *   navy reads as blue rather than black on a few pixels.
 *
 * All of it eases off as the model grows on screen (`SMALL_MODEL_PX`) and is
 * gone well before the 3D view's close-up, which shows the scheme as it is.
 *
 * The shaders are SimpleMeshLayer's own (deck.gl 9.4) with that added. With
 * no palette texture the layer draws `getColor` as SimpleMeshLayer would.
 */
import { SimpleMeshLayer } from "@deck.gl/mesh-layers";
import type { Device, Texture } from "@luma.gl/core";
import { AIRCRAFT_LIVERIES, liveryMark } from "@orya-halo/schema";
import type { AircraftLivery } from "@orya-halo/schema";
import { MODEL_LIFT, hexToRgb, liftColour, rgbToOklch } from "./livery-colour.ts";
import type { Rgb } from "./livery-colour.ts";

/** Texels per scheme in the palette, see `liveryPaletteData`. */
export const PALETTE_WIDTH = 24;
/** How far along a scheme's row the small-size (lifted) copies of its colours begin. */
export const LIFTED = 8;

const ACCENT_CODE = { top: 1, bottom: 2, rear: 3, front: 4 } as const;
const DEFAULT_ENGINES = "#c4ccd2";

/** A small model's fin is drawn up to this many times its true thickness, seen from above. */
export const SMALL_FIN_THICKNESS = 4;

/** Below this length on screen, pixels, a model gets the full small-size treatment; above the second, none. */
export const SMALL_MODEL_PX: readonly [number, number] = [40, 200];

/**
 * The strip along the top of a small model's fuselage: where it starts and
 * how far forward it reaches at full smallness, as shares of the fuselage's
 * length from the tail.
 */
export const DORSAL_STRIP: readonly [number, number] = [0.03, 0.5];

/**
 * How much of the small-size treatment a model this many pixels long gets:
 * 1 up to `SMALL_MODEL_PX[0]`, easing to 0 at `SMALL_MODEL_PX[1]`. The layer
 * hands it over in the blue of `getColor`, 0..255.
 */
export function liverySmallness(lengthPx: number): number {
  const [lo, hi] = SMALL_MODEL_PX;
  const t = Math.min(Math.max((lengthPx - lo) / (hi - lo), 0), 1);
  return 1 - t * t * (3 - 2 * t);
}

/** A fin this much darker or lighter than the fuselage top (OKLCH lightness) is worth a strip even without a hue. */
const FIN_CONTRAST = 0.3;

/**
 * How the small-size strip along the top is painted: 1 the fin's colours,
 * where the fin is the airline's mark or, with no hue at all, stands well
 * apart from the fuselage (Air Canada's black); 2 the airline's mark, where
 * the fin is white or grey; 0 not at all (unknown airlines among them).
 */
export function dorsalStripKind(livery: AircraftLivery): 0 | 1 | 2 {
  const mark = liveryMark(livery);
  if (mark) return mark === livery.tail ? 1 : 2;
  const contrast = Math.abs(
    rgbToOklch(hexToRgb(livery.tail))[0] - rgbToOklch(hexToRgb(livery.top))[0],
  );
  return contrast > FIN_CONTRAST ? 1 : 0;
}

const clamp01 = (x: number): number => Math.min(Math.max(x, 0), 1);

/**
 * The palette's pixels, RGBA, `PALETTE_WIDTH` texels per scheme. Texels 0
 * to 7 are colours as painted, and the same eight from `LIFTED` on are as
 * drawn on a small model (`liftColour`), with the same alpha:
 *
 * 0 top colour, belly line ((sine + 1) / 2) in alpha;
 * 1 belly colour, accent kind (0 none, 1 top, 2 bottom, 3 rear, 4 front) in alpha;
 * 2 fin colour, accent split in alpha; 3 accent colour; 4 engines;
 * 5 nose colour, 1 in alpha when the nose is painted, 0 when not;
 * 6 rear fuselage colour, how far forward it reaches in alpha, 0 when not painted;
 * 7 cheatline colour, 1 in alpha when there is one.
 *
 * Then parameters: 16 the rear fuselage colour's start and (sine + 1) / 2 of
 * its lower edge (0: all the way round); 17 the cheatline's lower and upper
 * edge ((sine + 1) / 2), start and end; 18 the small-size strip's colour
 * (lifted), its kind (`dorsalStripKind`) / 2 in alpha.
 */
export function liveryPaletteData(liveries: readonly AircraftLivery[]): Uint8Array {
  const data = new Uint8Array(liveries.length * PALETTE_WIDTH * 4);
  liveries.forEach((l, row) => {
    const put = (texel: number, rgba: readonly number[]): void => {
      const o = (row * PALETTE_WIDTH + texel) * 4;
      data.set(
        rgba.map((v) => Math.round(clamp01(v) * 255)),
        o,
      );
    };
    const paint = (texel: number, hex: string, alpha: number): void => {
      const c = hexToRgb(hex);
      put(texel, [...c, alpha]);
      put(texel + LIFTED, [...liftColour(c, MODEL_LIFT), alpha]);
    };
    const bellyLine = l.belly ? (l.bellyLine ?? -0.3) : -1;
    paint(0, l.top, (bellyLine + 1) / 2);
    paint(1, l.belly ?? l.top, l.accent ? ACCENT_CODE[l.accent.on] / 255 : 0);
    paint(2, l.tail, l.accent?.split ?? 0);
    paint(3, l.accent?.color ?? l.tail, 1);
    paint(4, l.engines ?? DEFAULT_ENGINES, 1);
    paint(5, l.nose ?? l.top, l.nose ? 1 : 0);
    paint(6, l.rear?.color ?? l.tail, l.rear?.to ?? 0);
    paint(7, l.stripe?.color ?? l.top, l.stripe ? 1 : 0);
    const rearAbove = l.rear?.above ?? -1;
    put(16, [l.rear?.from ?? 0, rearAbove > -1 ? (rearAbove + 1) / 2 : 0, 0, 1]);
    const s = l.stripe;
    put(17, s ? [(s.lo + 1) / 2, (s.hi + 1) / 2, s.from ?? 0.25, s.to ?? 0.9] : [0, 0, 0, 0]);
    const kind = dorsalStripKind(l);
    const mark = liveryMark(l);
    const strip: Rgb = mark ? liftColour(hexToRgb(mark), MODEL_LIFT) : [0, 0, 0];
    put(18, [...strip, kind / 2]);
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
const float FIN_THICKNESS = ${SMALL_FIN_THICKNESS.toFixed(2)};

// Where a point of the model (model frame, metres before scaling) lands on screen, in NDC.
vec2 screenOf(mat3 model, vec3 local) {
  vec3 pos = (model * local) * simpleMesh.sizeScale + instanceTranslation;
  vec4 placed;
  vec4 clip = simpleMesh.composeModelMatrix
    ? project_position_to_clipspace(pos + instancePositions, instancePositions64Low, vec3(0.0), placed)
    : project_position_to_clipspace(instancePositions, instancePositions64Low, project_size(pos), placed);
  return clip.xy / clip.w;
}

// How side-on the model is seen: 0 from straight above, 1 from the side.
// The model's up axis is foreshortened to nothing from above and drawn at
// full length from the side, against the longer of its other two axes.
float sideOn(mat3 model) {
  vec2 c = screenOf(model, vec3(0.0));
  float up = length(screenOf(model, vec3(0.0, 0.0, 4.0)) - c);
  float along = length(screenOf(model, vec3(4.0, 0.0, 0.0)) - c);
  float across = length(screenOf(model, vec3(0.0, 4.0, 0.0)) - c);
  return clamp(up / max(max(along, across), 1e-9), 0.0, 1.0);
}

void main(void) {
  geometry.worldPosition = instancePositions;
  geometry.uv = texCoords;
  geometry.pickingColor = picking_getPickingColorFromInstanceID();
  vTexCoord = texCoords;
  vPart = colors;
  vLivery = int(instanceColors.r * 255.0 + 0.5);
  cameraPosition = project.cameraPosition;
  vColor = instanceColors;
  vec3 local = positions;
  vec3 normal = normals;
  mat3 instanceModelMatrix = mat3(instanceModelMatrixCol0, instanceModelMatrixCol1, instanceModelMatrixCol2);
  // A small model's fin, thicker so its colour shows from above (the fin
  // stands on y = 0); seen from the side it shows anyway, and a thick fin
  // would read as a wedge.
  if (simpleMesh.hasTexture && colors.x > 1.5 && colors.x < 2.5 && instanceColors.b > 0.0) {
    float above = 1.0 - smoothstep(0.3, 0.8, sideOn(instanceModelMatrix));
    float k = mix(1.0, FIN_THICKNESS, instanceColors.b * above);
    local.y *= k;
    normal = normalize(vec3(normal.x, normal.y / k, normal.z));
  }
  vec3 pos = (instanceModelMatrix * local) * simpleMesh.sizeScale + instanceTranslation;
  if (simpleMesh.composeModelMatrix) {
    DECKGL_FILTER_SIZE(pos, geometry);
    normals_commonspace = project_normal(instanceModelMatrix * normal);
    geometry.worldPosition += pos;
    gl_Position = project_position_to_clipspace(pos + instancePositions, instancePositions64Low, vec3(0.0), position_commonspace);
    geometry.position = position_commonspace;
  } else {
    pos = project_size(pos);
    DECKGL_FILTER_SIZE(pos, geometry);
    gl_Position = project_position_to_clipspace(instancePositions, instancePositions64Low, pos, position_commonspace);
    geometry.position = position_commonspace;
    normals_commonspace = project_normal(instanceModelMatrix * normal);
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
const int LIFTED = ${LIFTED};
const float STRIP_FROM = ${DORSAL_STRIP[0].toFixed(3)};
const float STRIP_TO = ${DORSAL_STRIP[1].toFixed(3)};

vec4 palette(int texel) {
  int rows = textureSize(sampler, 0).y;
  return texelFetch(sampler, ivec2(texel, clamp(vLivery, 0, rows - 1)), 0);
}

// A livery colour as drawn: on a small model, its lifted copy (dark colours
// lighter, hue kept), easing to the colour as painted as the model grows.
vec3 colour(int texel) {
  return mix(palette(texel).rgb, palette(texel + LIFTED).rgb, vColor.b);
}

// 0 below edge, 1 above it, with a pixel's width of blending.
float above(float x, float edge) {
  float w = max(fwidth(x), 1e-4);
  return smoothstep(edge - w, edge + w, x);
}

float between(float x, float lo, float hi) {
  return above(x, lo) * (1.0 - above(x, hi));
}

// The fin's colours at a height (root 0, tip 1) and chord (leading edge 0, trailing 1).
vec3 finColour(float height, float chord) {
  vec3 tail = colour(2);
  float kind = palette(1).a * 255.0;
  float split = palette(2).a;
  float accent = 0.0;
  if (kind > 0.5 && kind < 1.5) accent = above(height, split);
  else if (kind > 1.5 && kind < 2.5) accent = 1.0 - above(height, split);
  else if (kind > 2.5 && kind < 3.5) accent = above(chord, split);
  else if (kind > 3.5) accent = 1.0 - above(chord, split);
  return mix(tail, colour(3), accent);
}

// A small model's strip along the top of the fuselage, from the tail
// forward, narrowing towards its front. It carries the fin's colours as if
// the fin were laid flat along the top (its leading edge forward, its tip
// along the middle), or the scheme's mark where the fin has no colour.
// It shortens and fades as the model grows.
vec3 dorsal(vec3 c, float a, float u) {
  float s = vColor.b;
  vec4 strip = palette(18);
  if (s <= 0.0 || strip.a <= 0.0) return c;
  float reach = mix(STRIP_FROM + 0.1, STRIP_TO, s);
  float along = clamp((reach - u) / (reach - STRIP_FROM), 0.0, 1.0);
  float edge = mix(0.9, 0.3, smoothstep(0.0, 0.4, along));
  float on = above(a, edge) * (1.0 - above(u, reach)) * smoothstep(0.0, 0.35, s);
  if (on <= 0.0) return c;
  vec3 paint = strip.a < 0.75
    ? finColour(clamp((a - edge) / max(1.0 - edge, 1e-3), 0.0, 1.0), 1.0 - along)
    : strip.rgb;
  return mix(c, paint, on);
}

vec3 fuselage(int part) {
  float a = vPart.y;
  float fromNose = vPart.z;
  float cabin = vTexCoord.x;
  float u = vTexCoord.y;
  vec4 top = palette(0);
  vec3 c = mix(colour(1), colour(0), above(a, top.a * 2.0 - 1.0));
  float glass = 0.0;
  if (part == 0) {
    // The nose cone, below and ahead of the flight deck windows.
    float nose = palette(5).a;
    if (nose > 0.0) c = mix(c, colour(5), nose * (1.0 - above(fromNose, 0.5 - 0.14 * a)));
    // The fin's colour carried onto the rear fuselage, further along the top.
    float rearTo = palette(6).a;
    if (rearTo > 0.0) {
      vec4 span = palette(16);
      float rear = 1.0 - above(u, rearTo + 0.05 * a);
      if (span.r > 0.0) rear *= above(u, span.r);
      if (span.g > 0.0) rear *= above(a, span.g * 2.0 - 1.0);
      c = mix(c, colour(6), rear);
    }
    // A cheatline along the side.
    if (palette(7).a > 0.0) {
      vec4 band = palette(17);
      c = mix(c, colour(7), between(a, band.r * 2.0 - 1.0, band.g * 2.0 - 1.0) * between(u, band.b, band.a));
    }
    // A row of cabin windows: dots when close, a dark line when they are too small to tell apart.
    float row = between(a, 0.30, 0.44) * between(cabin, 0.03, 0.96);
    float pitch = fromNose * 8.0;
    float blur = clamp(fwidth(pitch) * 1.5, 0.0, 1.0);
    float dots = mix(between(fract(pitch), 0.25, 0.75), 0.5, blur);
    glass = row * dots * 0.85;
    // Flight-deck windows on the nose.
    glass = max(glass, between(fromNose, 0.52, 0.86) * between(a, 0.16, 0.5));
    return dorsal(mix(c, GLASS, glass), a, u);
  } else if (part == 6) {
    // A light aircraft's cabin: glazed above the waist at the front of the cabin.
    glass = between(cabin, 0.55, 1.02) * above(a, 0.2);
  } else {
    // A helicopter's nose is mostly glass.
    glass = above(cabin, 0.62) * above(a, -0.3);
  }
  return mix(c, GLASS, glass);
}

vec3 livery() {
  int part = int(vPart.x + 0.5);
  if (part == 0 || part == 6 || part == 7) return fuselage(part);
  if (part == 2) return finColour(vPart.y, vPart.z);
  if (part == 3) return colour(4);
  if (part == 4) return DARK;
  if (part == 5) return colour(2);
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
