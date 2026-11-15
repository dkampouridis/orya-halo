import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import type { RefObject } from "react";
import { getServices, subscribeServices } from "../core/services.ts";
import type { HaloServices } from "../core/services.ts";

/** Search, attributions and the share link, or null until the data worker is up. */
export function useServices(): HaloServices | null {
  return useSyncExternalStore(subscribeServices, getServices, () => null);
}

/**
 * Keeps something on screen for `exitMs` after it closes, so it can animate
 * out. `closing` is true for that tail; entry animation is CSS `@starting-style`.
 */
export function usePresence(open: boolean, exitMs: number): { mounted: boolean; closing: boolean } {
  const [previous, setPrevious] = useState(open);
  const [lingering, setLingering] = useState(false);
  if (previous !== open) {
    setPrevious(open);
    setLingering(!open);
  }
  useEffect(() => {
    if (!lingering) return;
    const timer = setTimeout(() => setLingering(false), exitMs);
    return () => clearTimeout(timer);
  }, [lingering, exitMs]);
  return { mounted: open || lingering, closing: !open && lingering };
}

/** `value`, but only after it has stopped changing for `delayMs`. */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

/**
 * True while the element's text is cut short by a line clamp. Measured again
 * when the text changes, the box resizes or the web fonts arrive (a clamp
 * keeps the box the same height when a third line appears, so a resize alone
 * would miss that).
 */
export function useClamped(ref: RefObject<HTMLElement | null>, text: string | undefined): boolean {
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !text) {
      setClamped(false);
      return;
    }
    let live = true;
    const measure = (): void => {
      if (live) setClamped(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    void document.fonts.ready.then(measure);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [ref, text]);
  return clamped;
}

const PHONE_QUERY = "(max-width: 720px)";

function subscribePhone(listener: () => void): () => void {
  const query = matchMedia(PHONE_QUERY);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

/** True at phone width, where the dock is a strip and the detail panel a sheet. */
export function useIsPhone(): boolean {
  return useSyncExternalStore(
    subscribePhone,
    () => matchMedia(PHONE_QUERY).matches,
    () => false,
  );
}
