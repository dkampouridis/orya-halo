/**
 * The detail panel's sparkline: a selection's recent altitude or speed as one
 * hairline. Pure maths and words, no DOM, so every edge case has a test.
 */
import type { LayerId } from "@orya-halo/schema";
import type { TrackSeries } from "../core/store.ts";
import { formatNumber, spanOf } from "./format.ts";
import type { Span } from "./format.ts";

export interface SparkBox {
  width: number;
  height: number;
  /** Kept clear on every side, so the line's end dot is never clipped. */
  pad: number;
}

export interface SparkGeometry {
  /** SVG path data in the box's coordinates. */
  d: string;
  /** Where the newest point is drawn. */
  end: { x: number; y: number };
  min: number;
  max: number;
  last: number;
  /** The vertical scale: rounded outward, so it holds while new points stay inside it. */
  domain: [number, number];
  /** Time from the first point drawn to the last. */
  spanMs: number;
}

/** The finite, time-ordered points of a series; anything else is dropped rather than drawn. */
export function cleanSeries(
  timesMs: readonly number[],
  values: readonly number[],
): { t: number; v: number }[] {
  const points: { t: number; v: number }[] = [];
  const n = Math.min(timesMs.length, values.length);
  for (let i = 0; i < n; i++) {
    const t = timesMs[i];
    const v = values[i];
    if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
    // A sample that does not move time forward cannot be placed on a time axis.
    if (points.length > 0 && t <= points[points.length - 1].t) continue;
    points.push({ t, v });
  }
  return points;
}

/** A round step near `raw`: 1, 2 or 5 times a power of ten. */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
}

/**
 * The line for a series, or null when there is nothing worth drawing: fewer
 * than two usable points, or a change smaller than `minRange` (a level
 * cruise, a ship at anchor), which would only magnify noise into a shape.
 */
export function sparkGeometry(
  series: Pick<TrackSeries, "timesMs" | "values">,
  box: SparkBox,
  minRange: number,
): SparkGeometry | null {
  const points = cleanSeries(series.timesMs, series.values);
  if (points.length < 2) return null;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    if (p.v < min) min = p.v;
    if (p.v > max) max = p.v;
  }
  if (!(max - min >= minRange)) return null;

  // Rounded outward to a round step of about a tenth of the range: a new point inside these
  // bounds leaves every earlier point where it was drawn, and the line still fills the strip.
  const step = niceStep((max - min) / 10);
  let lo = Math.floor(min / step) * step;
  let hi = Math.ceil(max / step) * step;
  if (hi === lo) hi = lo + step;
  // Floating point can leave a bound a hair inside the data.
  lo = Math.min(lo, min);
  hi = Math.max(hi, max);

  const t0 = points[0].t;
  const spanMs = points[points.length - 1].t - t0;
  const innerW = box.width - 2 * box.pad;
  const innerH = box.height - 2 * box.pad;
  const round = (n: number): number => Math.round(n * 10) / 10;
  const xy = (p: { t: number; v: number }): { x: number; y: number } => ({
    x: round(box.pad + ((p.t - t0) / spanMs) * innerW),
    y: round(box.pad + ((hi - p.v) / (hi - lo)) * innerH),
  });

  let d = "";
  let end = { x: 0, y: 0 };
  for (const p of points) {
    end = xy(p);
    d += `${d ? "L" : "M"}${end.x} ${end.y}`;
  }
  return { d, end, min, max, last: points[points.length - 1].v, domain: [lo, hi], spanMs };
}

const FEET_PER_METRE = 1 / 0.3048;
const KNOTS_PER_MPS = 1 / 0.514444;

export interface SparkScale {
  /** Label for the caption, before any time span. */
  measure: "Altitude" | "Speed";
  unit: "m" | "ft" | "km" | "kt";
  /** Spoken unit for the accessible description. */
  unitWords: string;
  /** SI value (metres or m/s) to the shown unit. */
  convert: (si: number) => number;
  decimals: number;
  /** Smallest change, in SI units, that the line is drawn for. */
  minRange: number;
  /** Satellites' series is the predicted orbit, not a recorded history. */
  orbit: boolean;
}

/**
 * Units and thresholds for a selection's series. Aircraft altitude follows the
 * unit of the panel's own altitude readout (feet when the source reports feet),
 * so the strip and the number above it agree.
 */
export function sparkScale(
  measure: TrackSeries["measure"],
  layer: LayerId | null,
  altitudeUnit?: string,
): SparkScale {
  if (measure === "speed") {
    return {
      measure: "Speed",
      unit: "kt",
      unitWords: "knots",
      convert: (v) => v * KNOTS_PER_MPS,
      decimals: 1,
      // Half a knot: below that it is drift, not a change of speed.
      minRange: 0.25,
      orbit: false,
    };
  }
  if (layer === "satellites") {
    return {
      measure: "Altitude",
      unit: "km",
      unitWords: "kilometres",
      convert: (v) => v / 1000,
      decimals: 0,
      minRange: 1000,
      orbit: true,
    };
  }
  const feet = altitudeUnit === "ft";
  return {
    measure: "Altitude",
    unit: feet ? "ft" : "m",
    unitWords: feet ? "feet" : "metres",
    convert: feet ? (v) => v * FEET_PER_METRE : (v) => v,
    decimals: 0,
    // About a hundred feet: transponder altitude steps by 25.
    minRange: 30,
    orbit: false,
  };
}

export interface SparkWords {
  /** "Altitude, last" and a span, or "Altitude over one orbit" with no span. */
  lead: string;
  span: Span | null;
  /** The lowest and highest figures drawn, or one figure (`high` null) when they read the same. */
  range: { low: string; high: string | null };
  unit: string;
  /** The whole strip as one sentence, for assistive tech. */
  description: string;
}

/** Caption and description for a drawn line, honest about what the series is. */
export function sparkWords(geometry: SparkGeometry, scale: SparkScale): SparkWords {
  const low = formatNumber(scale.convert(geometry.min), scale.decimals);
  const high = formatNumber(scale.convert(geometry.max), scale.decimals);
  const now = formatNumber(scale.convert(geometry.last), scale.decimals);
  const range = low === high ? { low: now, high: null } : { low, high };
  const span = scale.orbit ? null : spanOf(geometry.spanMs);
  const lead = scale.orbit ? `${scale.measure} over one orbit` : `${scale.measure}, last`;
  const spanWords = span
    ? ` over the last ${span.value} ${SPAN_WORDS[span.unit]}`
    : " over one orbit";
  const description = `${scale.measure}${spanWords}: between ${low} and ${high} ${scale.unitWords}, ${scale.orbit ? "now" : "currently"} ${now}.`;
  return { lead, span, range, unit: scale.unit, description };
}

const SPAN_WORDS: Record<Span["unit"], string> = {
  s: "seconds",
  min: "minutes",
  h: "hours",
  d: "days",
};
