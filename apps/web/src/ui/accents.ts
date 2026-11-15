/**
 * Layer colours for CSS. `LAYERS` in the schema package is the only place a
 * layer's colour is written down; this publishes each one as `--accent-<layer>`
 * on the document root so the HUD and its portals can use it.
 */
import { LAYERS, layerForKind } from "@orya-halo/schema";
import type { EntityKind, LayerId } from "@orya-halo/schema";
import type { CSSProperties } from "react";

export function publishAccents(root: HTMLElement = document.documentElement): void {
  for (const layer of LAYERS) root.style.setProperty(`--accent-${layer.id}`, layer.accent);
}

/** Inline style that sets `--accent` to a layer's colour for everything inside. */
export function accentStyle(layer: LayerId): CSSProperties {
  return { "--accent": `var(--accent-${layer})` } as CSSProperties;
}

/** The layer an entity kind belongs to, or null for a kind this build does not know. */
export function layerOfKind(kind: EntityKind): LayerId | null {
  try {
    return layerForKind(kind).id;
  } catch {
    return null;
  }
}
