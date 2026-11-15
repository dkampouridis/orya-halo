/**
 * The recorded path of the one tracked entity: a bounded, time-ordered list
 * fed from the history ring, the gateway's own track and live fixes.
 */
import type { EntityRef, Track } from "@orya-halo/schema";

/** Points closer in time than this are the same observation from two feeds. */
const SAME_FIX_MS = 500;

export class TrackBuffer {
  count = 0;
  private readonly capacity: number;
  private readonly positions: Float32Array;
  private readonly timesMs: Float64Array;

  constructor(capacity = 2048) {
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 3);
    this.timesMs = new Float64Array(capacity);
  }

  /** Time of the newest point, or -Infinity when empty. */
  get lastMs(): number {
    return this.count === 0 ? Number.NEGATIVE_INFINITY : this.timesMs[this.count - 1];
  }

  /** Insert one point in time order. Returns false when it duplicates one already held. */
  add(lon: number, lat: number, alt: number, timeMs: number): boolean {
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(timeMs)) return false;
    // Binary search for the first point later than this one.
    let lo = 0;
    let hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.timesMs[mid] <= timeMs) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && timeMs - this.timesMs[lo - 1] < SAME_FIX_MS) return false;
    if (lo < this.count && this.timesMs[lo] - timeMs < SAME_FIX_MS) return false;

    if (this.count === this.capacity) {
      // Full: the oldest point makes room. A point older than everything is dropped.
      if (lo === 0) return false;
      this.positions.copyWithin(0, 3, this.count * 3);
      this.timesMs.copyWithin(0, 1, this.count);
      this.count--;
      lo--;
    }
    this.positions.copyWithin((lo + 1) * 3, lo * 3, this.count * 3);
    this.timesMs.copyWithin(lo + 1, lo, this.count);
    this.positions[lo * 3] = lon;
    this.positions[lo * 3 + 1] = lat;
    this.positions[lo * 3 + 2] = Number.isFinite(alt) ? alt : 0;
    this.timesMs[lo] = timeMs;
    this.count++;
    return true;
  }

  /** Add many points given as lon, lat, alt triples with a time each. */
  addAll(positions: ArrayLike<number>, timesMs: ArrayLike<number>, count = timesMs.length): void {
    for (let i = 0; i < count; i++)
      this.add(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], timesMs[i]);
  }

  /**
   * A fresh `Track` (its buffers are handed to the main thread). `extra`, a
   * time-ordered track from a plugin such as a predicted orbit, is merged in.
   */
  toTrack(ref: EntityRef, extra?: Track | null): Track {
    const extraCount = extra ? extra.count : 0;
    const total = this.count + extraCount;
    const positions = new Float32Array(total * 3);
    const timesMs = new Float64Array(total);
    let a = 0;
    let b = 0;
    let out = 0;
    while (a < this.count || b < extraCount) {
      const takeOwn =
        b >= extraCount || (a < this.count && this.timesMs[a] <= (extra as Track).timesMs[b]);
      const fromPositions = takeOwn ? this.positions : (extra as Track).positions;
      const fromTimes = takeOwn ? this.timesMs : (extra as Track).timesMs;
      const i = takeOwn ? a++ : b++;
      positions[out * 3] = fromPositions[i * 3];
      positions[out * 3 + 1] = fromPositions[i * 3 + 1];
      positions[out * 3 + 2] = fromPositions[i * 3 + 2];
      timesMs[out] = fromTimes[i];
      out++;
    }
    return { ref: { kind: ref.kind, id: ref.id }, count: total, positions, timesMs };
  }
}
