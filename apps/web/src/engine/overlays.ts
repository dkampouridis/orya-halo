/** Raster overlay helpers. Pure. */
import type { TileOverlay } from "@orya-halo/schema";

/**
 * Which frame of an animated overlay to show at `timeMs`: the nearest one in
 * time. Returns -1 when the overlay has no frames. Frames are oldest first.
 */
export function selectFrame(
  frames: readonly { timeMs: number }[] | undefined,
  timeMs: number,
): number {
  if (!frames || frames.length === 0) return -1;
  // Binary search for the first frame at or after the moment.
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].timeMs < timeMs) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(frames[lo - 1].timeMs - timeMs) <= Math.abs(frames[lo].timeMs - timeMs))
    return lo - 1;
  return lo;
}

/** The tile URL templates an overlay should show at `timeMs`. */
export function overlayTiles(
  overlay: TileOverlay,
  timeMs: number,
): { tiles: string[]; frame: number } {
  const frame = selectFrame(overlay.frames, timeMs);
  if (frame < 0 || !overlay.frames) return { tiles: overlay.tiles, frame: -1 };
  return { tiles: overlay.frames[frame].tiles, frame };
}
