/**
 * Detail assembly: everything the panel shows for one selected entity,
 * built from the store's columns, the entity's meta and the owning plugin's
 * schema.
 */
import { EARTH_RADIUS_M, EntityKind, layerForKind } from "@orya-halo/schema";
import type {
  Attribution,
  DetailField,
  EntityDetail,
  EntityMeta,
  EntitySummary,
  NearbyEntity,
  SchemaField,
} from "@orya-halo/schema";
import {
  categoryName,
  convert,
  entitySubtitle,
  entityTitle,
  formatNumber,
  formatTime,
  idText,
} from "./format.ts";
import type { Quantity } from "./format.ts";
import type { EntityStore } from "./store.ts";

/** Fields shown for gateway kinds when no plugin describes them. Aviation and marine units. */
export const GATEWAY_SCHEMAS: Partial<Record<EntityKind, readonly SchemaField[]>> = {
  [EntityKind.Aircraft]: [
    { key: "label", label: "Callsign", type: "string" },
    { key: "registration", label: "Registration", type: "string" },
    { key: "typeName", label: "Type", type: "string" },
    { key: "typeCode", label: "Type code", type: "string" },
    { key: "operator", label: "Operator", type: "string" },
    { key: "origin", label: "From", type: "string" },
    { key: "destination", label: "To", type: "string" },
    { key: "alt", label: "Altitude", type: "number", unit: "ft" },
    { key: "speed", label: "Ground speed", type: "number", unit: "kt" },
    { key: "heading", label: "Track", type: "number", unit: "°" },
    { key: "vrate", label: "Vertical rate", type: "number", unit: "ft/min" },
    { key: "squawk", label: "Squawk", type: "string" },
    { key: "country", label: "Country", type: "string" },
    { key: "id", label: "ICAO address", type: "string" },
  ],
  [EntityKind.Ship]: [
    { key: "label", label: "Name", type: "string" },
    { key: "category", label: "Type", type: "string" },
    { key: "id", label: "MMSI", type: "string" },
    { key: "imo", label: "IMO number", type: "string" },
    { key: "callsign", label: "Call sign", type: "string" },
    { key: "speed", label: "Speed", type: "number", unit: "kt" },
    { key: "heading", label: "Course", type: "number", unit: "°" },
    { key: "navStatus", label: "Status", type: "string" },
    { key: "destination", label: "Destination", type: "string" },
    { key: "eta", label: "Arrival", type: "string" },
    { key: "lengthM", label: "Length", type: "number", unit: "m" },
    { key: "widthM", label: "Beam", type: "number", unit: "m" },
    { key: "draughtM", label: "Draught", type: "number", unit: "m" },
    { key: "country", label: "Flag", type: "string" },
  ],
};

/**
 * Rows a gateway layer's plugin tends to leave out because they are not
 * facts about the object but part of its fix or its identity on the wire.
 * Units follow the detail panel's own readouts (metres, not feet).
 */
const GATEWAY_EXTRAS: Partial<Record<EntityKind, readonly SchemaField[]>> = {
  [EntityKind.Aircraft]: [
    { key: "vrate", label: "Vertical rate", type: "number", unit: "m/s" },
    { key: "id", label: "ICAO address", type: "string" },
  ],
  [EntityKind.Ship]: [{ key: "id", label: "MMSI", type: "string" }],
};

/** A gateway plugin's schema, completed with the rows above that it does not already have. */
export function gatewaySchema(
  kind: EntityKind,
  schema: readonly SchemaField[],
): readonly SchemaField[] {
  const extras = GATEWAY_EXTRAS[kind]?.filter((extra) => !schema.some((f) => f.key === extra.key));
  return extras && extras.length > 0 ? [...schema, ...extras] : schema;
}

/** Schema keys answered from the store's columns when meta has no such key. */
const COLUMN_KEYS: Record<
  string,
  {
    column: "lon" | "lat" | "alt" | "heading" | "speed" | "vrate" | "value" | "fixTimeMs";
    quantity: Quantity;
    decimals?: number;
  }
> = {
  lon: { column: "lon", quantity: "angle", decimals: 4 },
  lat: { column: "lat", quantity: "angle", decimals: 4 },
  alt: { column: "alt", quantity: "length", decimals: 0 },
  altitude: { column: "alt", quantity: "length", decimals: 0 },
  heading: { column: "heading", quantity: "angle", decimals: 0 },
  course: { column: "heading", quantity: "angle", decimals: 0 },
  track: { column: "heading", quantity: "angle", decimals: 0 },
  speed: { column: "speed", quantity: "speed" },
  vrate: { column: "vrate", quantity: "rate", decimals: 0 },
  verticalRate: { column: "vrate", quantity: "rate", decimals: 0 },
  value: { column: "value", quantity: "none" },
  fixTimeMs: { column: "fixTimeMs", quantity: "none" },
};

function fieldFrom(
  field: SchemaField,
  raw: string | number | boolean,
  decimals?: number,
): DetailField | null {
  const out: DetailField = { key: field.key, label: field.label, value: "" };
  if (field.unit !== undefined) out.unit = field.unit;
  switch (field.type) {
    case "number": {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n)) {
        // A provider that sends "n/a" where a number belongs still deserves a row.
        if (typeof raw !== "string" || raw.trim() === "") return null;
        out.value = raw.trim();
        return out;
      }
      out.value = formatNumber(n, decimals);
      out.numeric = n;
      return out;
    }
    case "boolean":
      out.value = raw === true || raw === "true" || raw === 1 ? "Yes" : "No";
      return out;
    case "time": {
      const ms = typeof raw === "number" ? raw : Date.parse(String(raw));
      if (!Number.isFinite(ms)) return null;
      out.value = formatTime(ms);
      out.numeric = ms;
      return out;
    }
    default: {
      const text = String(raw).trim();
      if (text === "") return null;
      out.value = text;
      return out;
    }
  }
}

/** Display rows for entity `i`, in schema order. Fields with nothing to show are left out. */
export function detailFields(
  store: EntityStore,
  i: number,
  schema: readonly SchemaField[],
): DetailField[] {
  const meta = store.meta[i];
  const fields: DetailField[] = [];
  for (const field of schema) {
    let made: DetailField | null = null;
    const fromMeta = meta?.[field.key];
    if (fromMeta !== undefined && fromMeta !== null) {
      // The plugin wrote both the schema and the meta, so its value is already in the display unit.
      made = fieldFrom(field, fromMeta);
    } else if (field.key === "id") {
      made = fieldFrom({ ...field, type: "string" }, idText(store.kind, store.ids[i]));
    } else if (field.key === "category") {
      made = fieldFrom({ ...field, type: "string" }, categoryName(store.kind, store.category[i]));
    } else {
      const column = COLUMN_KEYS[field.key];
      if (column !== undefined) {
        const si = store[column.column][i];
        if (Number.isFinite(si)) {
          const type =
            column.column === "fixTimeMs"
              ? "time"
              : field.type === "string"
                ? "number"
                : field.type;
          made = fieldFrom(
            { ...field, type },
            convert(si, column.quantity, field.unit),
            // Whole feet per minute read well; whole metres per second hide a gentle climb.
            column.quantity === "rate" && field.unit === "m/s" ? 1 : column.decimals,
          );
        }
      }
    }
    if (made !== null) fields.push(made);
  }
  return fields;
}

const DEG = Math.PI / 180;

/**
 * The `k` closest entities of any kind within `radiusKm`. A flat scan with a
 * latitude band reject: fast enough at 100,000 entities to run per selection.
 */
export function nearbyEntities(
  stores: readonly EntityStore[],
  self: { kind: EntityKind; id: number },
  lon: number,
  lat: number,
  k = 5,
  radiusKm = 150,
): NearbyEntity[] {
  const radiusDeg = (radiusKm * 1000) / EARTH_RADIUS_M / DEG;
  const cosLat = Math.max(Math.cos(lat * DEG), 0.01);
  const limit2 = radiusDeg * radiusDeg;
  const best: { store: EntityStore; index: number; d2: number }[] = [];
  for (const store of stores) {
    const n = store.count;
    for (let i = 0; i < n; i++) {
      const dLat = store.lat[i] - lat;
      if (dLat > radiusDeg || dLat < -radiusDeg) continue;
      let dLon = store.lon[i] - lon;
      if (dLon > 180) dLon -= 360;
      else if (dLon < -180) dLon += 360;
      dLon *= cosLat;
      const d2 = dLat * dLat + dLon * dLon;
      if (d2 > limit2) continue;
      if (best.length === k && d2 >= best[k - 1].d2) continue;
      if (store.kind === self.kind && store.ids[i] === self.id) continue;
      let at = best.length;
      while (at > 0 && best[at - 1].d2 > d2) at--;
      best.splice(at, 0, { store, index: i, d2 });
      if (best.length > k) best.pop();
    }
  }
  return best.map(({ store, index, d2 }) => ({
    ref: { kind: store.kind, id: store.ids[index] },
    label: entityTitle(store.kind, store.ids[index], store.meta[index]),
    distanceKm: Math.round(((Math.sqrt(d2) * DEG * EARTH_RADIUS_M) / 1000) * 10) / 10,
  }));
}

function place(value: EntityMeta[string]): { code: string } | undefined {
  if (typeof value !== "string") return undefined;
  const code = value.trim();
  return code === "" ? undefined : { code };
}

/** The detail of entity `i` from local state alone. */
export function buildDetail(
  store: EntityStore,
  i: number,
  schema: readonly SchemaField[],
  attribution: Attribution,
  stores: readonly EntityStore[],
): EntityDetail {
  const kind = store.kind;
  const id = store.ids[i];
  const meta = store.meta[i];
  const heading = store.heading[i];
  const detail: EntityDetail = {
    ref: { kind, id },
    layer: layerForKind(kind).id,
    title: entityTitle(kind, id, meta),
    lon: store.lon[i],
    lat: store.lat[i],
    alt: store.alt[i],
    heading: Number.isNaN(heading) ? null : heading,
    speed: store.speed[i],
    fixTimeMs: store.fixTimeMs[i],
    fields: detailFields(store, i, schema),
    attribution,
  };
  const subtitle = entitySubtitle(kind, store.category[i], meta);
  if (subtitle !== undefined) detail.subtitle = subtitle;
  const origin = place(meta?.origin);
  if (origin) detail.origin = origin;
  const destination = place(meta?.destination);
  if (destination) detail.destination = destination;
  const near = nearbyEntities(stores, detail.ref, detail.lon, detail.lat);
  if (near.length > 0) detail.nearby = near;
  if (typeof meta?.url === "string" && meta.url !== "") detail.sourceUrl = meta.url;
  if (meta !== undefined) detail.meta = { ...meta };
  return detail;
}

const KNOTS_PER_MPS = 1 / 0.514444;

/**
 * What the hover tag says about entity `i`: its name and the one number that
 * tells most about its kind. Aircraft: altitude in metres. Ships: speed in
 * knots. Satellites: altitude in kilometres. Earthquakes: magnitude. Other
 * kinds have no such number.
 */
export function buildSummary(store: EntityStore, i: number): EntitySummary {
  const kind = store.kind;
  const id = store.ids[i];
  const summary: EntitySummary = {
    ref: { kind, id },
    layer: layerForKind(kind).id,
    title: entityTitle(kind, id, store.meta[i]),
  };
  switch (kind) {
    case EntityKind.Aircraft:
      if (Number.isFinite(store.alt[i])) {
        summary.value = formatNumber(store.alt[i], 0);
        summary.unit = "m";
      }
      break;
    case EntityKind.Ship:
      if (Number.isFinite(store.speed[i])) {
        summary.value = formatNumber(store.speed[i] * KNOTS_PER_MPS, 1);
        summary.unit = "kn";
      }
      break;
    case EntityKind.Satellite:
      if (Number.isFinite(store.alt[i])) {
        summary.value = formatNumber(store.alt[i] / 1000, 0);
        summary.unit = "km";
      }
      break;
    case EntityKind.Quake:
      // Written as seismologists write it; "M" is part of the figure, not a unit after it.
      if (Number.isFinite(store.value[i])) summary.value = `M${store.value[i].toFixed(1)}`;
      break;
  }
  return summary;
}

/**
 * Lay a plugin's or the gateway's extra detail over the local one.
 *
 * Fields: extra rows replace base rows with the same key and otherwise go at
 * the end. When `schema` (the plugin's own) is given and the plugin restates
 * any of its schema's rows, it has chosen its rows: the panel then shows the
 * plugin's list as it is, and of the base only what the schema does not
 * cover. That is how a plugin leaves out a row its subtitle already says
 * (an earthquake's time) or one that only matters to the machine (a cable's
 * OpenStreetMap way number).
 */
export function mergeDetail(
  base: EntityDetail,
  extra: Partial<EntityDetail> | null | undefined,
  schema?: readonly SchemaField[],
): EntityDetail {
  if (!extra) return base;
  const merged: EntityDetail = { ...base };
  for (const key in extra) {
    const value = extra[key as keyof EntityDetail];
    if (value === undefined || key === "ref" || key === "fields" || key === "meta") continue;
    (merged as unknown as Record<string, unknown>)[key] = value;
  }
  if (extra.fields && extra.fields.length > 0) {
    const own = new Set(schema?.map((f) => f.key));
    const curated = extra.fields.some((f) => own.has(f.key));
    const fields = curated ? base.fields.filter((f) => !own.has(f.key)) : base.fields.slice();
    let lead = 0;
    for (const field of extra.fields) {
      const at = fields.findIndex((f) => f.key === field.key);
      if (at !== -1) fields[at] = field;
      // A curated list leads, in the plugin's order; additions follow the base.
      else if (curated) fields.splice(lead++, 0, field);
      else fields.push(field);
    }
    merged.fields = fields;
  }
  if (extra.meta) merged.meta = { ...base.meta, ...extra.meta };
  return merged;
}
