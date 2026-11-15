/**
 * Words and numbers for the detail panel and search results: how an entity
 * is named when it has no label, what its category is called, and how a raw
 * SI value becomes the figure a person reads.
 */
import { EntityKind, layerForKind } from "@orya-halo/schema";
import type { EntityMeta } from "@orya-halo/schema";

/** An id as people write it: ICAO addresses in hex, everything else decimal. */
export function idText(kind: EntityKind, id: number): string {
  if (kind === EntityKind.Aircraft) return id.toString(16).toUpperCase().padStart(6, "0");
  return String(id);
}

const AIRCRAFT_CATEGORIES = [
  "",
  "Light aircraft",
  "Medium aircraft",
  "Large aircraft",
  "Heavy aircraft",
  "High-performance aircraft",
  "Helicopter",
  "Glider",
  "Drone",
  "Ground vehicle",
];
const SHIP_CATEGORIES = [
  "",
  "Cargo ship",
  "Tanker",
  "Passenger ship",
  "Fishing vessel",
  "Service vessel",
  "High-speed craft",
  "Pleasure craft",
  "Military vessel",
  "Vessel",
];
const SATELLITE_CATEGORIES = [
  "Satellite",
  "Space station",
  "Constellation satellite",
  "Navigation satellite",
  "Earth observation satellite",
  "Science satellite",
  "Geostationary satellite",
  "Debris",
];

/** Plain name of a category code, or an empty string when it says nothing. */
export function categoryName(kind: EntityKind, category: number): string {
  switch (kind) {
    case EntityKind.Aircraft:
      return AIRCRAFT_CATEGORIES[category] ?? "";
    case EntityKind.Ship:
      return SHIP_CATEGORIES[category] ?? "";
    case EntityKind.Satellite:
      return SATELLITE_CATEGORIES[category] ?? "";
    default:
      return "";
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

/** Heading for an entity: its label, or its kind and id when it has none. */
export function entityTitle(kind: EntityKind, id: number, meta: EntityMeta | undefined): string {
  const label = text(meta?.label) || text(meta?.name);
  if (label !== "") return label;
  const noun = layerForKind(kind).noun;
  return `${noun.charAt(0).toUpperCase()}${noun.slice(1)} ${idText(kind, id)}`;
}

/** Second line: the most telling facts we have, most specific first. */
export function entitySubtitle(
  kind: EntityKind,
  category: number,
  meta: EntityMeta | undefined,
): string | undefined {
  const parts: string[] = [];
  const type = text(meta?.typeName) || text(meta?.typeCode) || categoryName(kind, category);
  if (type !== "") parts.push(type);
  const extra = text(meta?.operator) || text(meta?.registration) || text(meta?.country);
  if (extra !== "" && extra !== type) parts.push(extra);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** A number as a person reads it: grouped thousands, no more decimals than it deserves. */
export function formatNumber(value: number, decimals?: number): string {
  if (!Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  const digits = decimals ?? (abs >= 100 ? 0 : abs >= 10 ? 1 : 2);
  const fixed = value.toFixed(digits);
  const trimmed = decimals === undefined && digits > 0 ? fixed.replace(/\.?0+$/, "") : fixed;
  const [whole, fraction] = trimmed.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  // "-0" reads as a mistake.
  const sign = grouped === "-0" && !fraction ? "0" : grouped;
  return fraction ? `${sign}.${fraction}` : sign;
}

/** What a column holds, so a display unit can be converted from SI. */
export type Quantity = "speed" | "length" | "rate" | "angle" | "none";

const SPEED: Record<string, number> = {
  "m/s": 1,
  kt: 1 / 0.514444,
  kn: 1 / 0.514444,
  knots: 1 / 0.514444,
  "km/h": 3.6,
  kph: 3.6,
  mph: 2.236936,
  "km/s": 0.001,
};
const LENGTH: Record<string, number> = {
  m: 1,
  km: 0.001,
  ft: 3.28084,
  nm: 1 / 1852,
  nmi: 1 / 1852,
  mi: 1 / 1609.344,
};
const RATE: Record<string, number> = { "m/s": 1, "ft/min": 196.8504, fpm: 196.8504 };

/**
 * Convert an SI column value to the schema's display unit. Unknown units are
 * left alone: better the true SI figure than a wrong conversion.
 */
export function convert(value: number, quantity: Quantity, unit: string | undefined): number {
  if (unit === undefined) return value;
  const table =
    quantity === "speed"
      ? SPEED
      : quantity === "length"
        ? LENGTH
        : quantity === "rate"
          ? RATE
          : null;
  const factor = table?.[unit];
  return factor === undefined ? value : value * factor;
}

/** UTC date and time, to the minute. */
export function formatTime(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
