/**
 * Shareable links. The camera, the layers that are on and the selected
 * object live in the URL fragment, so copying the address bar shares the view:
 *
 *   #v=23.7275,37.9838,6.20,0,0&l=aircraft,ships,satellites&s=1.4ca7b5
 *
 * `v` is lon, lat, zoom, bearing, pitch. `s` is kind.id with the id in hex.
 */
import { LAYER_IDS } from "@orya-halo/schema";
import type { EntityRef, LayerId, ViewState } from "@orya-halo/schema";
import type { CameraTarget } from "../core/engine.ts";

export interface UrlState {
  view?: CameraTarget;
  layers?: LayerId[];
  selection?: EntityRef;
}

const round = (value: number, digits: number): string => String(Number(value.toFixed(digits)));

export function parseUrlState(hash: string): UrlState {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const state: UrlState = {};

  const v = params.get("v")?.split(",").map(Number);
  if (v && v.length >= 3 && v.slice(0, 3).every(Number.isFinite)) {
    const [lon, lat, zoom, bearing = 0, pitch = 0] = v;
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && zoom >= 0 && zoom <= 22) {
      state.view = {
        lon,
        lat,
        zoom,
        bearing: Number.isFinite(bearing) ? bearing : 0,
        pitch: Number.isFinite(pitch) ? Math.min(Math.max(pitch, 0), 85) : 0,
      };
    }
  }

  const l = params.get("l");
  if (l !== null) {
    const known = new Set<string>(LAYER_IDS);
    state.layers = l.split(",").filter((id): id is LayerId => known.has(id));
  }

  const s = params.get("s")?.match(/^(\d+)\.([0-9a-f]{1,8})$/i);
  if (s) {
    const kind = Number(s[1]);
    if (kind >= 1 && kind <= 7)
      state.selection = { kind: kind as EntityRef["kind"], id: Number.parseInt(s[2], 16) };
  }
  return state;
}

export function formatUrlState(
  view: ViewState | null,
  layers: LayerId[],
  selection: EntityRef | null,
): string {
  const parts: string[] = [];
  if (view) {
    parts.push(
      `v=${round(view.lon, 4)},${round(view.lat, 4)},${round(view.zoom, 2)},${round(view.bearing, 0)},${round(view.pitch, 0)}`,
    );
  }
  parts.push(`l=${layers.join(",")}`);
  if (selection) parts.push(`s=${selection.kind}.${selection.id.toString(16)}`);
  return `#${parts.join("&")}`;
}

/** The current page address with the given state, for "Copy link". */
export function shareUrl(
  view: ViewState | null,
  layers: LayerId[],
  selection: EntityRef | null,
): string {
  return `${location.origin}${location.pathname}${location.search}${formatUrlState(view, layers, selection)}`;
}
