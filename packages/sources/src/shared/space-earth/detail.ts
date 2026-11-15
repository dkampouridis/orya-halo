/**
 * Turns an entity's meta into detail-panel rows, driven by the plugin's own
 * `schema`, so labels and units are written once.
 */
import type { DetailField, EntityMeta, SchemaField } from "@orya-halo/schema";

/** "2026-11-14 04:10 UTC". Minutes are as fine as any of these feeds is worth reading. */
export function formatUtc(timeMs: number): string {
  const iso = new Date(timeMs).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * A number for display. Quantities (fields with a unit) get thousands
 * separators; bare numbers such as catalogue ids and years do not.
 */
export function formatNumber(value: number, grouped: boolean): string {
  const abs = Math.abs(value);
  if (abs !== 0 && abs < 0.01) return value.toPrecision(3);
  // Two decimals for small values, one above ten; trailing zeros are dropped ("6.4", not "6.40").
  const digits = Number.isInteger(value) ? 0 : abs < 10 ? 2 : 1;
  if (!grouped) return String(Number(value.toFixed(digits)));
  return value.toLocaleString("en-US", { maximumFractionDigits: digits });
}

/** One schema field of `meta` as a detail row, or null when the value is absent. */
export function detailField(field: SchemaField, meta: EntityMeta): DetailField | null {
  const value = meta[field.key];
  if (value === null || value === undefined || value === "") return null;
  const row: DetailField = { key: field.key, label: field.label, value: "" };
  if (field.unit) row.unit = field.unit;
  switch (field.type) {
    case "number": {
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      row.value = formatNumber(n, field.unit !== undefined);
      row.numeric = n;
      return row;
    }
    case "time": {
      const t = Number(value);
      if (!Number.isFinite(t)) return null;
      row.value = formatUtc(t);
      return row;
    }
    case "boolean":
      row.value = value ? "Yes" : "No";
      return row;
    default:
      row.value = String(value);
      return row;
  }
}

/**
 * Detail rows for every schema field present in `meta`, in schema order.
 * The label (it is the panel title) and links (they become `sourceUrl`) are left out.
 */
export function detailFields(
  schema: readonly SchemaField[],
  meta: EntityMeta | undefined,
): DetailField[] {
  if (!meta) return [];
  const rows: DetailField[] = [];
  for (const field of schema) {
    if (field.key === "label" || field.type === "url") continue;
    const row = detailField(field, meta);
    if (row) rows.push(row);
  }
  return rows;
}
