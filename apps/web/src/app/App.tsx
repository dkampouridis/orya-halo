import { useEffect, useRef, useState } from "react";
import { Hud } from "../ui/index.tsx";
import { haloActions, useHalo } from "../core/store.ts";
import { startController } from "./controller.ts";

/**
 * True while a modal overlay is open and holds focus. Inert is applied only
 * once focus is inside the dialog: inert blurs what it contains, and the
 * element that opened the dialog must still hold focus when the dialog notes
 * where to return it. The HUD does the same for its own chrome.
 */
function useInertBehindModal(): boolean {
  const modal = useHalo((s) => s.overlay !== "none");
  const [inert, setInert] = useState(false);
  if (!modal && inert) setInert(false);
  useEffect(() => {
    if (!modal) return;
    const check = (): void => {
      if (document.activeElement?.closest("[role=dialog]")) setInert(true);
    };
    check();
    document.addEventListener("focusin", check);
    return () => document.removeEventListener("focusin", check);
  }, [modal]);
  return inert;
}

/**
 * The whole app: a full-screen element the engine draws into, and the HUD
 * over it. React renders the chrome only; the globe is not a React tree.
 */
export function App() {
  const globe = useRef<HTMLDivElement>(null);
  // Behind a dialog the globe's canvases and credit links leave the tab order too.
  const inert = useInertBehindModal();

  useEffect(() => {
    const container = globe.current;
    if (!container) return;
    let cancelled = false;
    let destroy: (() => void) | undefined;
    startController(container).then(
      (controller) => {
        if (cancelled) controller.destroy();
        else destroy = () => controller.destroy();
      },
      (error: unknown) => {
        console.error("Orya Halo could not start:", error);
        const webgl = /webgl|context/i.test(String(error));
        haloActions().setStartError(
          webgl
            ? "The globe needs WebGL 2, which this browser or device has switched off."
            : "The globe could not start. Reload the page to try again.",
        );
      },
    );
    return () => {
      cancelled = true;
      destroy?.();
    };
  }, []);

  return (
    <>
      <div
        ref={globe}
        id="globe"
        inert={inert}
        style={{ position: "fixed", inset: 0, background: "#000" }}
      />
      <Hud />
    </>
  );
}
