/**
 * Id to index map over typed arrays.
 *
 * A `Map<number, number>` allocates per insert and boxes ids above 2^31. This
 * is open addressing with linear probing and backward-shift deletion, so the
 * steady state (entities coming and going at a constant population) touches
 * no allocator at all and never accumulates tombstones.
 */
export class IdMap {
  private keys: Uint32Array;
  /** Stored value, or -1 for an empty slot. */
  private vals: Int32Array;
  private mask: number;
  private shift: number;
  size = 0;

  constructor(expected = 256) {
    let bits = 4;
    while (1 << bits < expected * 2) bits++;
    this.keys = new Uint32Array(1 << bits);
    this.vals = new Int32Array(1 << bits).fill(-1);
    this.mask = (1 << bits) - 1;
    this.shift = 32 - bits;
  }

  /** Slots allocated; for memory accounting and flatness checks. */
  get capacity(): number {
    return this.keys.length;
  }

  private home(id: number): number {
    // Fibonacci hashing spreads sequential ids (MMSI blocks, NORAD numbers).
    return Math.imul(id, 0x9e3779b1) >>> this.shift;
  }

  /** Value stored for `id`, or -1. */
  get(id: number): number {
    const keys = this.keys;
    const vals = this.vals;
    const mask = this.mask;
    let s = this.home(id);
    for (;;) {
      const v = vals[s];
      if (v === -1) return -1;
      if (keys[s] === id) return v;
      s = (s + 1) & mask;
    }
  }

  /** Insert or overwrite. `value` must be zero or positive. */
  set(id: number, value: number): void {
    if ((this.size + 1) * 2 > this.keys.length) this.grow();
    const keys = this.keys;
    const vals = this.vals;
    const mask = this.mask;
    let s = this.home(id);
    for (;;) {
      if (vals[s] === -1) {
        keys[s] = id;
        vals[s] = value;
        this.size++;
        return;
      }
      if (keys[s] === id) {
        vals[s] = value;
        return;
      }
      s = (s + 1) & mask;
    }
  }

  delete(id: number): boolean {
    const keys = this.keys;
    const vals = this.vals;
    const mask = this.mask;
    let i = this.home(id);
    for (;;) {
      if (vals[i] === -1) return false;
      if (keys[i] === id) break;
      i = (i + 1) & mask;
    }
    // Backward shift: pull later entries of the same probe run into the hole
    // so lookups never need tombstones.
    let j = i;
    for (;;) {
      j = (j + 1) & mask;
      if (vals[j] === -1) break;
      const k = this.home(keys[j]);
      const inRun = i <= j ? i < k && k <= j : i < k || k <= j;
      if (inRun) continue;
      keys[i] = keys[j];
      vals[i] = vals[j];
      i = j;
    }
    vals[i] = -1;
    this.size--;
    return true;
  }

  clear(): void {
    this.vals.fill(-1);
    this.size = 0;
  }

  private grow(): void {
    const oldKeys = this.keys;
    const oldVals = this.vals;
    const length = oldKeys.length * 2;
    this.keys = new Uint32Array(length);
    this.vals = new Int32Array(length).fill(-1);
    this.mask = length - 1;
    this.shift--;
    this.size = 0;
    for (let s = 0; s < oldKeys.length; s++) {
      if (oldVals[s] !== -1) this.set(oldKeys[s], oldVals[s]);
    }
  }
}
