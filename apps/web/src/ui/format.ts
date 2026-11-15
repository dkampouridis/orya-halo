/**
 * Words and numbers as the HUD writes them. Pure functions, no DOM.
 */

/** A real minus sign: it shares the digits' width in Martian Mono, a hyphen does not. */
export const MINUS = "−";

/** Grouped thousands and a fixed number of decimals. Never "-0". */
export function formatNumber(value: number, decimals = 0): string {
  if (!Number.isFinite(value)) return "";
  const fixed = Math.abs(value).toFixed(decimals);
  const [whole, fraction] = fixed.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const body = fraction ? `${grouped}.${fraction}` : grouped;
  const zero = Number(fixed) === 0;
  return value < 0 && !zero ? `${MINUS}${body}` : body;
}

/** Decimals a formatted figure was written with: "1,204.50" is 2, "37" is 0. */
export function decimalsOf(text: string): number {
  const at = text.lastIndexOf(".");
  if (at < 0) return 0;
  const tail = text.slice(at + 1);
  return /^\d+$/.test(tail) ? tail.length : 0;
}

/** The number a formatted figure stands for, or NaN when it is not one ("2026-11-14", "n/a"). */
export function parseFigure(text: string): number {
  const cleaned = text.trim().replace(/,/g, "").replace(MINUS, "-");
  return /^-?\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : Number.NaN;
}

/** Where a number tween stands at `t` (0..1): ease-out, and exactly the target at the end. */
export function tweenValue(from: number, to: number, t: number): number {
  if (t >= 1) return to;
  if (t <= 0) return from;
  const eased = 1 - (1 - t) ** 3;
  return from + (to - from) * eased;
}

const two = (n: number): string => String(n).padStart(2, "0");

/** UTC wall clock, "19:42:07". */
export function clockText(ms: number): string {
  const d = new Date(ms);
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
}

/** UTC hours and minutes, "19:40". */
export function hourMinute(ms: number): string {
  const d = new Date(ms);
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

export interface Span {
  value: number;
  unit: "s" | "min" | "h" | "d";
}

/** A duration in its largest sensible unit: 90 s is "2 min", 5 400 s is "2 h". */
export function spanOf(ms: number): Span {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return { value: Math.round(s), unit: "s" };
  if (s < 3600) return { value: Math.round(s / 60), unit: "min" };
  if (s < 86_400) return { value: Math.round(s / 3600), unit: "h" };
  return { value: Math.round(s / 86_400), unit: "d" };
}

/** "2 min ago", or "just now" inside the first minute. For sentences, not readouts. */
export function agoText(ms: number): string {
  if (ms < 60_000) return "just now";
  const span = spanOf(ms);
  return `${span.value} ${span.unit} ago`;
}

/** "51.48° N, 0.46° W". */
export function positionText(lat: number, lon: number, decimals = 2): string {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(decimals)}° ${ns}, ${Math.abs(lon).toFixed(decimals)}° ${ew}`;
}

/** The same position in words, for the screen-reader announcement. */
export function positionSpoken(lat: number, lon: number): string {
  const ns = lat >= 0 ? "north" : "south";
  const ew = lon >= 0 ? "east" : "west";
  return `${Math.abs(lat).toFixed(1)} degrees ${ns}, ${Math.abs(lon).toFixed(1)} degrees ${ew}`;
}

/** Great-circle distance in kilometres. */
export function distanceKm(
  a: { lon: number; lat: number },
  b: { lon: number; lat: number },
): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Join class names, skipping the empty ones. */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}
