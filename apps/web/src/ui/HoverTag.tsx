import { useHalo } from "../core/store.ts";
import type { HoverState } from "../core/store.ts";

export interface TagParts {
  name: string;
  value?: string;
  unit?: string;
}

/**
 * What the tag says: the worker's title, number and unit once it has answered,
 * else the engine's own label, whole. Null when there is nothing to say yet.
 */
export function tagParts(
  hover: Pick<HoverState, "label" | "title" | "value" | "unit">,
): TagParts | null {
  const name = hover.title?.trim() || hover.label?.trim();
  if (!name) return null;
  const value = hover.value?.trim() || undefined;
  return { name, value, unit: value ? hover.unit?.trim() || undefined : undefined };
}

/** Room a tag needs to the right of its object before it flips to the left. */
const FLIP_MARGIN = 240;

/**
 * The label beside the hovered object. The engine draws the ring; this is
 * only the tag, and it never takes pointer events.
 */
export function HoverTag() {
  const hover = useHalo((s) => s.hover);
  const parts = hover ? tagParts(hover) : null;
  if (!hover || !parts) return null;
  const left = hover.x > window.innerWidth - FLIP_MARGIN;
  return (
    <div
      className="tag hover-tag"
      role="tooltip"
      data-side={left ? "left" : undefined}
      style={{
        transform: `translate(${Math.round(hover.x)}px, ${Math.round(hover.y)}px)${left ? " translateX(-100%)" : ""}`,
      }}
    >
      <span className="tag-name">{parts.name}</span>
      {parts.value ? <span className="num">{parts.value}</span> : null}
      {parts.unit ? <span className="unit">{parts.unit}</span> : null}
    </div>
  );
}
