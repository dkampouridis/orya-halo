/**
 * Search results as the panel lays them out: grouped by layer in dock order
 * with places last, and flattened in that same order so the keyboard walks
 * the list exactly as it reads.
 */
import { LAYERS } from "@orya-halo/schema";
import type { LayerId, SearchResult } from "@orya-halo/schema";

export const MAX_RESULTS = 8;

export interface ResultGroup {
  /** Layer id, or "places". */
  id: LayerId | "places";
  label: string;
  /** Null for places: their lamp is hollow, they are not a layer. */
  layer: LayerId | null;
  items: { result: SearchResult; index: number }[];
}

export interface ResultModel {
  groups: ResultGroup[];
  /** Results in visual order; `index` in each group item points here. */
  flat: SearchResult[];
}

export function groupResults(results: readonly SearchResult[], max = MAX_RESULTS): ResultModel {
  // The service returns best first: keep the best `max`, then arrange them.
  const kept = results.slice(0, max);
  const byGroup = new Map<string, SearchResult[]>();
  for (const result of kept) {
    const id = result.type === "entity" && result.layer ? result.layer : "places";
    const list = byGroup.get(id);
    if (list) list.push(result);
    else byGroup.set(id, [result]);
  }
  const groups: ResultGroup[] = [];
  const flat: SearchResult[] = [];
  const push = (id: ResultGroup["id"], label: string, layer: LayerId | null): void => {
    const list = byGroup.get(id);
    if (!list) return;
    groups.push({
      id,
      label,
      layer,
      items: list.map((result) => ({ result, index: flat.push(result) - 1 })),
    });
  };
  for (const def of LAYERS) push(def.id, def.label, def.id);
  push("places", "Places", null);
  return { groups, flat };
}

/** Where the keyboard position goes for a key, or null when the key is not a list key. */
export function moveActive(active: number, key: string, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowDown":
      return (active + 1) % count;
    case "ArrowUp":
      return (active - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
