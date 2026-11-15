/**
 * Livery colours made easier to see on a few pixels, for the small 3D
 * aircraft and the aircraft glyphs' tails.
 *
 * Dark colours are lifted in lightness only, in OKLCH (Björn Ottosson's
 * perceptual space), so their hue and chroma stay: navy becomes a deeper
 * blue rather than the same bright blue as every other navy, and maroon a
 * lighter maroon rather than pink. The lift compresses the dark end instead
 * of setting every dark colour to one lightness, so two navies that differ
 * still differ. Reds, magentas and oranges, whose hue turns to pink as they
 * lighten, are lifted to a lower target.
 */

export type Rgb = [number, number, number];

/** sRGB `#rrggbb` to 0..1 channels. */
export function hexToRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number): number =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * Math.max(c, 0) ** (1 / 2.4) - 0.055;

/** sRGB (0..1) to OKLCH: lightness 0..1, chroma, hue in radians. */
export function rgbToOklch(rgb: Rgb): [number, number, number] {
  const [r, g, b] = rgb.map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}

/** OKLCH to linear-light sRGB, possibly out of gamut. */
function oklchToLinear(L: number, C: number, h: number): Rgb {
  const A = C * Math.cos(h);
  const B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** OKLCH to sRGB (0..1), giving up chroma where the colour is out of gamut, never hue or lightness. */
export function oklchToRgb(L: number, C: number, h: number): Rgb {
  const inGamut = (c: Rgb): boolean => c.every((v) => v >= -1e-4 && v <= 1 + 1e-4);
  let lo = 0;
  let hi = C;
  if (!inGamut(oklchToLinear(L, C, h))) {
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear(L, mid, h))) lo = mid;
      else hi = mid;
    }
  } else lo = C;
  const lin = oklchToLinear(L, lo, h);
  return lin.map((v) => Math.min(Math.max(toGamma(v), 0), 1)) as Rgb;
}

/** True for colours a lift turns pink: reds, magentas and oranges (OKLCH hue about -40 to 75 degrees). */
function reddish(C: number, h: number): boolean {
  const deg = (h * 180) / Math.PI;
  return C > 0.04 && deg > -40 && deg < 75;
}

/** Lightness at and above which a colour is left alone, and how much of the gap below is closed. */
export interface Lift {
  /** Target lightness for most hues. */
  readonly to: number;
  /** Target lightness for reds, magentas and oranges. */
  readonly redTo: number;
  /** Share of the gap to the target that is closed, 0..1: below 1 keeps dark colours apart. */
  readonly closes: number;
}

/** For the small 3D models, lit and on a white fuselage. */
export const MODEL_LIFT: Lift = { to: 0.56, redTo: 0.5, closes: 0.35 };
/** For the glyphs' tails, solid on a dark map. */
export const GLYPH_LIFT: Lift = { to: 0.74, redTo: 0.6, closes: 0.6 };

/**
 * A colour with a hue made light enough to read on a few pixels: its OKLCH
 * lightness raised part way to the lift's target, hue and chroma kept.
 * White, greys and black, and colours already that light, are unchanged.
 */
export function liftColour(rgb: Rgb, lift: Lift): Rgb {
  const [L, C, h] = rgbToOklch(rgb);
  if (C < 0.03) return [...rgb];
  const to = reddish(C, h) ? lift.redTo : lift.to;
  if (L >= to) return [...rgb];
  return oklchToRgb(to - (to - L) * (1 - lift.closes), C, h);
}

/** Lower a colour's lightness, hue and chroma kept, by `by` (OKLCH lightness). */
export function darkenColour(rgb: Rgb, by: number): Rgb {
  const [L, C, h] = rgbToOklch(rgb);
  return oklchToRgb(Math.max(L - by, 0), C, h);
}

export function rgbDistance(a: Rgb, b: Rgb): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
