import { Dialog } from "@base-ui/react/dialog";
import type { CSSProperties, ReactNode } from "react";
import { haloActions, useHalo } from "../../core/store.ts";
import { Icon } from "../icons.tsx";
// The overlays' own styles arrive with them rather than with the first paint.
import "../../styles/overlays.css";

/**
 * The shell both overlays share: a modal glass sheet over a dimmed globe.
 * Base UI's Dialog supplies the focus trap, Esc and focus return.
 */
export function Sheet({
  open,
  title,
  lede,
  width,
  children,
}: {
  open: boolean;
  title: string;
  lede?: string;
  width?: number;
  children: ReactNode;
}) {
  const reduced = useHalo((s) => s.reducedMotion);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) haloActions().setOverlay("none");
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="backdrop" />
        <Dialog.Popup
          className="hud-portal sheet glass"
          data-reduced={reduced ? "" : undefined}
          style={width ? ({ "--sheet-width": `${width}px` } as CSSProperties) : undefined}
        >
          <header className="sheet-head">
            <div>
              <Dialog.Title className="sheet-title">{title}</Dialog.Title>
              {lede ? <Dialog.Description className="sheet-lede">{lede}</Dialog.Description> : null}
            </div>
            <Dialog.Close className="tool" aria-label="Close">
              <Icon name="close" />
            </Dialog.Close>
          </header>
          <div className="sheet-body">{children}</div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
