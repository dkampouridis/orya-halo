/**
 * The time tape's arithmetic: time to pixels and back, what a drag or a key
 * asks for, which ticks to draw. The tape slides under a fixed needle, so the
 * needle's x is always the moment being shown.
 */
import type { ClockState } from "@orya-halo/schema";

export const PX_PER_MIN = 10;
export const MINUTE_MS = 60_000;
/** Closer to now than this counts as live: nobody means "eleven seconds ago". */
export const LIVE_SNAP_MS = 20_000;
/** Less history than this and the tape stays locked. */
export const MIN_HISTORY_MS = MINUTE_MS;

export type History = { fromMs: number; toMs: number } | null;
export type ScrubTarget = { mode: "live" } | { mode: "scrub"; timeMs: number };

/** Pixel position of a moment, given the moment under the needle. */
export function xOfTime(timeMs: number, underMs: number, needleX: number): number {
  return needleX + ((timeMs - underMs) / MINUTE_MS) * PX_PER_MIN;
}

/** The moment at a pixel position. Inverse of `xOfTime`. */
export function timeOfX(x: number, underMs: number, needleX: number): number {
  return underMs + ((x - needleX) / PX_PER_MIN) * MINUTE_MS;
}

/** The moment under the needle after dragging the tape `dxPx` (right is positive: back in time). */
export function dragTarget(startUnderMs: number, dxPx: number): number {
  return startUnderMs - (dxPx / PX_PER_MIN) * MINUTE_MS;
}

/** True when there is enough history to scrub through. */
export function canScrub(history: History): history is { fromMs: number; toMs: number } {
  return history !== null && history.toMs - history.fromMs >= MIN_HISTORY_MS;
}

/** Turn a wanted moment into what the store should do: hold inside the buffer, or go live. */
export function resolveScrub(timeMs: number, history: History, nowMs: number): ScrubTarget {
  if (!canScrub(history)) return { mode: "live" };
  if (timeMs >= nowMs - LIVE_SNAP_MS) return { mode: "live" };
  return { mode: "scrub", timeMs: Math.min(Math.max(timeMs, history.fromMs), history.toMs) };
}

/** The moment under the needle right now. */
export function underNeedle(clock: ClockState, nowMs: number): number {
  return clock.mode === "live" ? nowMs : clock.timeMs;
}

/**
 * What a key press on the tape asks for, or null when the key is not the
 * tape's (or there is nothing to scrub). Left and right move a minute, five
 * with Shift or Page keys; Home is the oldest moment, End is live.
 */
export function keyScrub(
  key: string,
  shift: boolean,
  clock: ClockState,
  history: History,
  nowMs: number,
): ScrubTarget | null {
  if (!canScrub(history)) return null;
  const under = underNeedle(clock, nowMs);
  const step = (shift ? 5 : 1) * MINUTE_MS;
  switch (key) {
    case "ArrowLeft":
    case "ArrowDown":
      return resolveScrub(under - step, history, nowMs);
    case "ArrowRight":
    case "ArrowUp":
      return resolveScrub(under + step, history, nowMs);
    case "PageDown":
      return resolveScrub(under - 5 * MINUTE_MS, history, nowMs);
    case "PageUp":
      return resolveScrub(under + 5 * MINUTE_MS, history, nowMs);
    case "Home":
      return resolveScrub(history.fromMs, history, nowMs);
    case "End":
      return { mode: "live" };
    default:
      return null;
  }
}

/** Whole minutes behind live, at least one while scrubbed; 0 when live. */
export function minutesBehind(clock: ClockState, nowMs: number): number {
  if (clock.mode === "live") return 0;
  return Math.max(1, Math.round((nowMs - clock.timeMs) / MINUTE_MS));
}

export interface Tick {
  /** Centre of the tick, CSS pixels from the tape's left edge. */
  x: number;
  /** Unix epoch milliseconds, on a whole minute. */
  timeMs: number;
  /** Every fifth minute: taller, and labelled when there is room. */
  major: boolean;
  /** Inside the recorded history, so the needle can reach it. */
  reachable: boolean;
  /** Show the hh:mm label. */
  labelled: boolean;
}

export interface TickInput {
  width: number;
  needleX: number;
  /** The moment under the needle. */
  underMs: number;
  nowMs: number;
  history: History;
  /** Labels stay out of this span: the needle's readout window sits there. */
  keepClear: { from: number; to: number };
  /** Labels stay left of this: on phones "Back to live" covers the tape's end. */
  labelLimit?: number;
}

/** A tick per minute from the tape's left edge up to now; nothing is drawn in the future. */
export function ticks(input: TickInput): Tick[] {
  const { width, needleX, underMs, nowMs, history, keepClear } = input;
  const limit = input.labelLimit ?? Number.POSITIVE_INFINITY;
  const first = Math.ceil(timeOfX(-4, underMs, needleX) / MINUTE_MS);
  const last = Math.floor(nowMs / MINUTE_MS);
  const out: Tick[] = [];
  for (let m = first; m <= last; m++) {
    const timeMs = m * MINUTE_MS;
    const x = Math.round(xOfTime(timeMs, underMs, needleX));
    if (x > width + 4) break;
    const major = m % 5 === 0;
    out.push({
      x,
      timeMs,
      major,
      reachable: history !== null && timeMs >= history.fromMs,
      labelled: major && (x < keepClear.from || x > keepClear.to) && x < limit,
    });
  }
  return out;
}
