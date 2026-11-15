/**
 * Where the phone's detail sheet comes to rest after a drag. Heights are how
 * much of the sheet shows above the bottom edge, in CSS pixels.
 */
export type SheetRest = "peek" | "full" | "close";

/** A flick: faster than this and direction decides, not distance. Pixels per millisecond. */
export const FLICK = 0.4;
/** Below this share of the peek height with no flick, the sheet is being put away. */
const CLOSE_BELOW = 0.55;

export function snapSheet(input: {
  /** Height showing when the finger lifted. */
  visible: number;
  /** Upward speed at release, px/ms; negative is downward. */
  velocity: number;
  peek: number;
  full: number;
  /** Where the drag started from. */
  from: "peek" | "full";
}): SheetRest {
  const { visible, velocity, peek, full, from } = input;
  if (velocity >= FLICK) return "full";
  if (velocity <= -FLICK) {
    // A downward flick steps down one stop: full to peek, peek to closed.
    if (from === "peek" || visible < peek) return "close";
    return "peek";
  }
  if (visible < peek * CLOSE_BELOW) return "close";
  return visible > (peek + full) / 2 ? "full" : "peek";
}

/** Upward speed from the last few pointer samples, px/ms. Samples are `[timeMs, y]`, newest last. */
export function releaseVelocity(
  samples: readonly (readonly [number, number])[],
  windowMs = 100,
): number {
  if (samples.length < 2) return 0;
  const [tEnd, yEnd] = samples[samples.length - 1];
  let start = samples[samples.length - 2];
  for (let i = samples.length - 2; i >= 0; i--) {
    if (tEnd - samples[i][0] > windowMs) break;
    start = samples[i];
  }
  const dt = tEnd - start[0];
  // Screen y grows downward, so upward movement is a falling y.
  return dt > 0 ? (start[1] - yEnd) / dt : 0;
}
