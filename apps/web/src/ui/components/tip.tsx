import { Tooltip } from "@base-ui/react/tooltip";
import type { ReactElement } from "react";
import { cx } from "../format.ts";

/**
 * A tooltip in the HUD's small glass tag: what the control does and its key.
 * For icon-only buttons; the button keeps its own `aria-label`. `long` lets a
 * sentence wrap, for text that is cut short where it normally sits.
 */
export function Tip({
  label,
  hotkey,
  side = "bottom",
  disabled = false,
  long = false,
  children,
}: {
  label: string;
  hotkey?: string;
  side?: "top" | "bottom" | "left" | "right";
  disabled?: boolean;
  long?: boolean;
  children: ReactElement<Record<string, unknown>>;
}) {
  return (
    <Tooltip.Root disabled={disabled}>
      <Tooltip.Trigger render={children} />
      <Tooltip.Portal>
        <Tooltip.Positioner side={side} sideOffset={8} style={{ zIndex: 30 }}>
          <Tooltip.Popup className={cx("hud-portal tag tip", long && "tip-long")}>
            <span className="tag-name">{label}</span>
            {hotkey ? <kbd className="key">{hotkey}</kbd> : null}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export const TipProvider = Tooltip.Provider;
