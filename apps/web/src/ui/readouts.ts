/**
 * Which numbers the detail panel shows large, per layer, and what is left
 * for the quiet list beneath. Sources name their fields differently and some
 * send none, so each readout tries the source's own field first (already in
 * its display unit) and falls back to the detail's top-level SI numbers.
 */
import type { DetailField, EntityDetail, LayerId } from "@orya-halo/schema";
import { decimalsOf, parseFigure, positionText } from "./format.ts";

export interface Readout {
  key: string;
  label: string;
  /** Shown as it is when `numeric` is absent. */
  text: string;
  /** Present when the figure can tween. */
  numeric?: number;
  decimals: number;
  unit?: string;
}

interface Pick {
  /** Field keys to look for, best first. */
  keys: readonly string[];
  /** Label when the source's own is too long or missing. */
  label?: string;
  /** Built from the top-level numbers when no field matches. */
  fallback?: (detail: EntityDetail) => Omit<Readout, "key"> | null;
}

const KNOTS_PER_MPS = 1 / 0.514444;

const altitudeM: Pick["fallback"] = (d) =>
  Number.isFinite(d.alt)
    ? { label: "Altitude", text: "", numeric: d.alt, decimals: 0, unit: "m" }
    : null;
const altitudeKm: Pick["fallback"] = (d) =>
  Number.isFinite(d.alt)
    ? { label: "Altitude", text: "", numeric: d.alt / 1000, decimals: 0, unit: "km" }
    : null;
const speedKt =
  (label: string, decimals: number): Pick["fallback"] =>
  (d) =>
    Number.isFinite(d.speed)
      ? { label, text: "", numeric: d.speed * KNOTS_PER_MPS, decimals, unit: "kt" }
      : null;
const speedKmS: Pick["fallback"] = (d) =>
  Number.isFinite(d.speed)
    ? { label: "Speed", text: "", numeric: d.speed / 1000, decimals: 2, unit: "km/s" }
    : null;
const heading =
  (label: string): Pick["fallback"] =>
  (d) =>
    d.heading !== null && Number.isFinite(d.heading)
      ? { label, text: "", numeric: d.heading, decimals: 0, unit: "°" }
      : null;

/** Two to four readouts per layer, most telling first. */
const PICKS: Record<LayerId, readonly Pick[]> = {
  aircraft: [
    { keys: ["alt", "altitude"], label: "Altitude", fallback: altitudeM },
    { keys: ["speed", "groundSpeed"], label: "Ground speed", fallback: speedKt("Ground speed", 0) },
    { keys: ["heading", "track"], label: "Heading", fallback: heading("Heading") },
    { keys: ["vrate", "verticalRate"], label: "Climb rate" },
  ],
  ships: [
    { keys: ["speed"], label: "Speed", fallback: speedKt("Speed", 1) },
    { keys: ["course", "heading"], label: "Course", fallback: heading("Course") },
    { keys: ["lengthM", "length"], label: "Length" },
    { keys: ["draughtM", "draught"], label: "Draught" },
  ],
  satellites: [
    { keys: ["alt", "altitude", "altitudeKm"], label: "Altitude", fallback: altitudeKm },
    { keys: ["speed", "velocity"], label: "Speed", fallback: speedKmS },
    { keys: ["inclinationDeg", "inclination"], label: "Inclination" },
    { keys: ["periodMin", "period"], label: "Period" },
  ],
  quakes: [
    { keys: ["magnitude", "mag"], label: "Magnitude" },
    { keys: ["depthKm", "depth"], label: "Depth" },
    { keys: ["felt"], label: "Felt reports" },
  ],
  fires: [
    { keys: ["frpMw", "frp"], label: "Radiative power" },
    { keys: ["confidencePct"], label: "Confidence" },
    { keys: ["brightnessK"], label: "Brightness" },
  ],
  cables: [{ keys: ["lengthKm", "length"], label: "Mapped length" }],
  webcams: [],
  radar: [],
  imagery: [],
  nightlights: [],
};

/**
 * True when a field's display string is just its number written out, so the
 * HUD may re-format it while it tweens. Times carry a numeric value too
 * (epoch milliseconds) but read as a date, and must be left alone.
 */
export function tweenable(field: DetailField): boolean {
  if (field.numeric === undefined || !Number.isFinite(field.numeric)) return false;
  const shown = parseFigure(field.value);
  if (Number.isNaN(shown)) return false;
  const tolerance = 0.5 * 10 ** -decimalsOf(field.value) + 1e-9;
  return Math.abs(shown - field.numeric) <= tolerance;
}

function fromField(field: DetailField, label: string | undefined): Readout {
  const base = { key: field.key, label: label ?? field.label, unit: field.unit };
  if (tweenable(field)) {
    return {
      ...base,
      text: field.value,
      numeric: field.numeric,
      decimals: decimalsOf(field.value),
    };
  }
  return { ...base, text: field.value, decimals: 0 };
}

export interface DetailView {
  readouts: Readout[];
  /** Everything else worth listing, in the source's order. */
  facts: DetailField[];
}

/** Fields that only repeat what the panel already says in its heading. */
function isHeading(field: DetailField, detail: EntityDetail): boolean {
  if (field.key === "label" || field.key === "name") return true;
  const value = field.value.trim();
  if (value === "" || value === detail.title) return true;
  // The subtitle is built from type and operator; a row saying the same again is noise.
  return detail.subtitle !== undefined && detail.subtitle.split(" · ").includes(value);
}

export function detailView(detail: EntityDetail): DetailView {
  const picks = PICKS[detail.layer] ?? [];
  const used = new Set<string>();
  const readouts: Readout[] = [];
  for (const pick of picks) {
    const field = pick.keys
      .map((key) => detail.fields.find((f) => f.key === key))
      .find((f) => f !== undefined);
    if (field) {
      for (const key of pick.keys) used.add(key);
      readouts.push(fromField(field, pick.label));
      continue;
    }
    const made = pick.fallback?.(detail);
    if (made) readouts.push({ key: pick.keys[0], ...made });
  }
  // Origin and destination have their own section.
  if (detail.origin) used.add("origin");
  if (detail.destination) used.add("destination");
  const facts = detail.fields.filter((f) => !used.has(f.key) && !isHeading(f, detail));
  if (
    Number.isFinite(detail.lat) &&
    Number.isFinite(detail.lon) &&
    !facts.some((f) => f.key === "position")
  ) {
    facts.unshift({
      key: "position",
      label: "Position",
      value: positionText(detail.lat, detail.lon),
    });
  }
  return { readouts, facts };
}

/** How far along its route something is, 0..1, or null when either end has no coordinates. */
export function routeProgress(
  detail: EntityDetail,
  distance: (a: Point, b: Point) => number,
): number | null {
  const { origin, destination } = detail;
  if (!hasPoint(origin) || !hasPoint(destination)) return null;
  const here = { lon: detail.lon, lat: detail.lat };
  const flown = distance(origin, here);
  const ahead = distance(here, destination);
  const whole = flown + ahead;
  return whole > 0 ? Math.min(1, Math.max(0, flown / whole)) : null;
}

interface Point {
  lon: number;
  lat: number;
}

function hasPoint(place: EntityDetail["origin"]): place is { code: string; name?: string } & Point {
  return place !== undefined && Number.isFinite(place.lon) && Number.isFinite(place.lat);
}

/** Layers whose objects move, so "Follow" means something. */
export function canFollow(layer: LayerId): boolean {
  return layer === "aircraft" || layer === "ships" || layer === "satellites";
}
