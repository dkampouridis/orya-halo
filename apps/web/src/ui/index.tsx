/**
 * The HUD: thin glass at the edges of the globe. It reads the store and asks
 * the controller for camera moves through `sendIntent`; it never touches the
 * engine or the data worker.
 *
 * Render isolation: `Hud` itself holds no state, so its children are created
 * once. `Frame` re-renders for a handful of flags (idle, intro, sheet) but
 * receives those children as a prop, so they are not re-rendered with it.
 * Each child subscribes to the narrowest slice of the store it needs.
 */
import { LAYER_IDS } from "@orya-halo/schema";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useHalo } from "../core/store.ts";
import type { Overlay } from "../core/store.ts";
import { publishAccents } from "./accents.ts";
import { Announcer } from "./Announcer.tsx";
import { TipProvider } from "./components/tip.tsx";
import { Dock } from "./Dock.tsx";
import { HoverTag } from "./HoverTag.tsx";
import { offlineGatewayLayers } from "./layer-status.ts";
import { useUi } from "./local.ts";
import { PhoneNotes, StartError } from "./Notices.tsx";
import { Search } from "./Search.tsx";
import { listenForShortcuts } from "./shortcuts.ts";
import { Tape } from "./Tape.tsx";
import { Ticker } from "./Ticker.tsx";
import { Brand, Status } from "./TopBar.tsx";

publishAccents();

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

// Not needed for first paint: each overlay (and Base UI's dialog with it) loads when first opened.
const About = lazy(() => import("./overlays/About.tsx"));
const Shortcuts = lazy(() => import("./overlays/Shortcuts.tsx"));

// The detail panel (with its sparkline and sheet gestures) is needed only once something is
// selected. It is fetched as soon as the opening shot is over, so the first click finds it ready.
const loadDetail = () => import("./Detail.tsx");
const Detail = lazy(() => loadDetail().then((m) => ({ default: m.Detail })));

function DetailSlot() {
  const selected = useHalo((s) => s.selection !== null);
  const settled = useHalo((s) => s.intro === "done");
  const [needed, setNeeded] = useState(false);
  if (selected && !needed) setNeeded(true);
  useEffect(() => {
    if (settled) void loadDetail();
  }, [settled]);
  if (!needed) return null;
  return (
    <Suspense fallback={null}>
      <Detail />
    </Suspense>
  );
}

function Overlays() {
  const overlay = useHalo((s) => s.overlay);
  // Once opened an overlay stays mounted, closed, so it can animate out and reopen at once.
  const [opened, setOpened] = useState<Record<Exclude<Overlay, "none">, boolean>>({
    attribution: false,
    shortcuts: false,
  });
  if (overlay !== "none" && !opened[overlay]) setOpened({ ...opened, [overlay]: true });
  return (
    <Suspense fallback={null}>
      {opened.attribution ? <About open={overlay === "attribution"} /> : null}
      {opened.shortcuts ? <Shortcuts open={overlay === "shortcuts"} /> : null}
    </Suspense>
  );
}

/**
 * Sound follows the store's `sound` flag. The audio module is imported the
 * first time sound is switched on, never before.
 */
function useSound(): void {
  useEffect(() => {
    let audio: typeof import("./sound.ts") | null = null;
    let wanted = false;
    const sync = (): void => {
      if (!audio) return;
      audio.setEnabled(wanted);
      audio.setHum(wanted && useUi.getState().hum);
    };
    const onSound = (on: boolean): void => {
      wanted = on;
      if (audio) sync();
      else if (on) {
        void import("./sound.ts").then((module) => {
          audio = module;
          sync();
        });
      }
    };
    const enabledKey = (s: ReturnType<typeof useHalo.getState>): string =>
      LAYER_IDS.map((id) => (s.layers[id].enabled ? "1" : "0")).join("");
    const offs = [
      useHalo.subscribe((s) => s.sound, onSound, { fireImmediately: true }),
      useUi.subscribe(() => sync()),
      useHalo.subscribe(
        (s) => s.selection,
        (selection) => {
          if (selection && wanted) audio?.tick("select");
        },
      ),
      useHalo.subscribe(enabledKey, () => {
        if (wanted) audio?.tick("toggle");
      }),
    ];
    return () => {
      for (const off of offs) off();
      audio?.setEnabled(false);
    };
  }, []);
}

/** The HUD's root element and the flags its CSS keys off. */
function Frame({ children }: { children: ReactNode }) {
  const idle = useHalo((s) => s.idle);
  const intro = useHalo((s) => s.intro);
  const reduced = useHalo((s) => s.reducedMotion);
  const searching = useHalo((s) => s.searchOpen);
  const offline = useHalo((s) => offlineGatewayLayers(s.layers).length > 0);
  // On phones a note about the engine takes the ticker's place, as the offline note does.
  const notice = useHalo((s) => Boolean(s.engineStatus?.message));
  // Behind a modal sheet the HUD is hidden from assistive tech (Base UI marks it aria-hidden);
  // inert also takes its controls out of the tab order, so nothing hidden can hold focus.
  // Only once focus is inside the sheet: inert blurs whatever it contains, and the control
  // that opened the sheet must still hold focus when Base UI notes where to return it.
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
  const sheet = useUi((s) => s.sheet);

  useEffect(() => listenForShortcuts(), []);
  useSound();

  return (
    <div
      className="hud"
      inert={inert}
      data-intro={intro}
      data-idle={idle ? "" : undefined}
      data-reduced={reduced ? "" : undefined}
      data-search={searching ? "" : undefined}
      data-offline={offline ? "" : undefined}
      data-notice={notice ? "" : undefined}
      data-sheet={sheet === "none" ? undefined : sheet}
    >
      {children}
    </div>
  );
}

export function Hud() {
  return (
    <QueryClientProvider client={queryClient}>
      <TipProvider delay={500} closeDelay={0}>
        <Frame>
          <Brand />
          <Status />
          <Search />
          <Dock />
          <PhoneNotes />
          <DetailSlot />
          <Ticker />
          <Tape />
          <HoverTag />
          <Announcer />
          <StartError />
        </Frame>
        <Overlays />
      </TipProvider>
    </QueryClientProvider>
  );
}
