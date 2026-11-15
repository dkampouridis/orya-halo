import { useLayoutEffect, useRef } from "react";
import { useHalo } from "../core/store.ts";
import { cx, formatNumber, tweenValue } from "./format.ts";

const TWEEN_MS = 300;

/**
 * A numeral in Data type that tweens to each new value over 300ms. The text
 * is written straight to the DOM, so a rolling number costs no React renders;
 * Martian Mono's fixed advance keeps the digits from shifting as they change.
 */
export function Num({
  value,
  decimals = 0,
  suffix = "",
  className,
}: {
  value: number;
  decimals?: number;
  /** Glued to the number, e.g. "°". Units with a space go in a separate Unit. */
  suffix?: string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const write = (n: number): void => {
      shown.current = n;
      el.textContent = formatNumber(n, decimals) + suffix;
    };
    const from = shown.current;
    if (from === null || from === value || document.hidden || useHalo.getState().reducedMotion) {
      write(value);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / TWEEN_MS);
      write(tweenValue(from, value, t));
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, decimals, suffix]);

  return <span ref={ref} className={cx("num", className)} />;
}

/** A unit after a number: Micro, dim, lowercase. */
export function Unit({ children }: { children: string }) {
  return <span className="unit">{children}</span>;
}
