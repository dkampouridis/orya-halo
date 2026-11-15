/**
 * How a dock row looks for each layer status. Pure, so every status has a
 * test: the lamp, whether the name dims, what the right column says and the
 * one-line note beneath.
 */
import { LAYERS } from "@orya-halo/schema";
import type { LayerDef } from "@orya-halo/schema";
import type { HaloState, LayerUiState } from "../core/store.ts";

export type Lamp = "lit" | "hollow" | "broken" | "pending";

export interface RowView {
  lamp: Lamp;
  /** Name and icon drop to the dim ink: nothing from this layer is on the globe. */
  dim: boolean;
  /** Number for the right column, when the layer is showing countable data. */
  count: number | null;
  /** Words for the right column in place of a count. */
  state: { text: string; warn: boolean } | null;
  /** First data is on its way: the right column shows the loading ring. */
  busy: boolean;
  /** One sentence under the row. */
  note: { text: string; warn: boolean } | null;
}

const FALLBACK = {
  degraded: "Data is arriving late or in part.",
  "needs-key": "This layer needs an API key. Add it to the .env file and reload.",
  offline: "The provider isn't reachable. Trying again shortly.",
  error: "This layer could not load. Turn it off and on to try again.",
} as const;

/** The figure a row shows: the worldwide total when the provider reports one, else what is loaded. */
export function layerCount(layer: Pick<LayerUiState, "count" | "total">): number | null {
  return layer.total ?? layer.count;
}

export function rowView(def: LayerDef, layer: LayerUiState): RowView {
  const blank = { count: null, state: null, busy: false, note: null };
  if (!layer.enabled) return { lamp: "hollow", dim: true, ...blank };
  const message = layer.message?.trim() || undefined;
  switch (layer.status) {
    case "live":
      return { lamp: "lit", dim: false, ...blank, count: layerCount(layer) };
    case "degraded":
      return {
        lamp: "broken",
        dim: false,
        ...blank,
        count: layerCount(layer),
        note: { text: message ?? FALLBACK.degraded, warn: true },
      };
    case "needs-key":
      return {
        lamp: "hollow",
        dim: true,
        ...blank,
        state: { text: "Needs a key", warn: false },
        note: { text: message ?? FALLBACK["needs-key"], warn: false },
      };
    case "offline":
      return {
        lamp: "hollow",
        dim: true,
        ...blank,
        state: { text: "Offline", warn: true },
        // Gateway rows share one explanation under the list instead of repeating it per row.
        note: def.viaGateway ? null : { text: message ?? FALLBACK.offline, warn: true },
      };
    case "error":
      return {
        lamp: "hollow",
        dim: true,
        ...blank,
        state: { text: "Error", warn: true },
        note: { text: message ?? FALLBACK.error, warn: true },
      };
    case "off":
      // Switched on but the worker has reported "off": nothing to show, nothing wrong.
      return { lamp: "hollow", dim: true, ...blank };
    default:
      return { lamp: "pending", dim: false, ...blank, busy: true };
  }
}

/** What a screen reader hears for the row: name, then its count or state. */
export function rowLabel(def: LayerDef, view: RowView, formatCount: (n: number) => string): string {
  if (view.state) return `${def.label}, ${view.state.text.toLowerCase()}`;
  if (view.busy) return `${def.label}, loading`;
  if (view.count !== null) return `${def.label}, ${formatCount(view.count)}`;
  return def.label;
}

/** Layers that count towards "live": the ones made of individual objects. */
const COUNTED = LAYERS.filter((l) => l.shape === "entities");

/** Everything live on the globe right now: the sum of the object layers that are showing data. */
export function liveTotal(layers: HaloState["layers"]): number {
  let total = 0;
  for (const def of COUNTED) {
    const layer = layers[def.id];
    if (!layer.enabled || (layer.status !== "live" && layer.status !== "degraded")) continue;
    total += layerCount(layer) ?? 0;
  }
  return total;
}

const VIA_GATEWAY = LAYERS.filter((l) => l.viaGateway);

/** The gateway rows that are switched on but unreachable; the dock explains them together. */
export function offlineGatewayLayers(layers: HaloState["layers"]): LayerDef[] {
  return VIA_GATEWAY.filter((def) => layers[def.id].enabled && layers[def.id].status === "offline");
}
