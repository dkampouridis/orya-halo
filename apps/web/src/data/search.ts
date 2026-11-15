/**
 * Search over everything loaded.
 *
 * There is no separate index to keep in step: each store already carries one
 * lower-cased search key per entity, maintained as entities come and go. A
 * query is one `indexOf` per entity plus a numeric range test on the id
 * column, which is a couple of milliseconds at 100,000 entities. Ids match
 * numerically (a hex prefix is a range of ICAO addresses), so no id strings
 * are ever built.
 */
import { EntityKind, layerForKind } from "@orya-halo/schema";
import type { SearchResult } from "@orya-halo/schema";
import { entitySubtitle, entityTitle } from "./format.ts";
import type { EntityStore } from "./store.ts";

export const DEFAULT_SEARCH_LIMIT = 20;

const SCORE_EXACT = 100;
const SCORE_ID_EXACT = 96;
const SCORE_LABEL_PREFIX = 90;
const SCORE_FIELD_EXACT = 85;
const SCORE_FIELD_PREFIX = 75;
const SCORE_ID_PREFIX = 72;
const SCORE_WORD = 60;
const SCORE_SUBSTRING = 40;
/** Most a nearby match gains over an identical distant one. */
const NEAR_BONUS = 6;
const NEAR_RANGE_DEG = 20;

/** How well `key` (fields joined by newlines, label first) matches at `pos`. */
function scoreKey(key: string, query: string, pos: number): number {
  const end = pos + query.length;
  const fieldEnds = end === key.length || key.charCodeAt(end) === 10;
  let base: number;
  let fieldStart = pos;
  if (pos === 0) {
    base = fieldEnds ? SCORE_EXACT : SCORE_LABEL_PREFIX;
  } else {
    const before = key.charCodeAt(pos - 1);
    if (before === 10) base = fieldEnds ? SCORE_FIELD_EXACT : SCORE_FIELD_PREFIX;
    else {
      // Space, hyphen, slash: the start of a word inside a name.
      base = before === 32 || before === 45 || before === 47 ? SCORE_WORD : SCORE_SUBSTRING;
      fieldStart = key.lastIndexOf("\n", pos) + 1;
    }
  }
  if (fieldEnds && fieldStart === pos) return base;
  // Among equals, the shorter name is the closer match.
  let fieldEnd = key.indexOf("\n", end);
  if (fieldEnd === -1) fieldEnd = key.length;
  const extra = fieldEnd - fieldStart - query.length;
  return base - Math.min(extra, 20) * 0.25;
}

interface IdQuery {
  /** Half-open id ranges that the typed digits are a prefix of, exact match first. */
  lo: number[];
  hi: number[];
}

/** Ranges of 24-bit ICAO addresses whose hex form starts with `query`. */
function hexQuery(query: string): IdQuery | null {
  if (!/^[0-9a-f]{1,6}$/.test(query)) return null;
  const span = 16 ** (6 - query.length);
  const lo = Number.parseInt(query, 16) * span;
  return { lo: [lo], hi: [lo + span] };
}

/** Ranges of decimal ids (MMSI, NORAD) that start with `query`. */
function decimalQuery(query: string): IdQuery | null {
  if (!/^[1-9]\d{0,9}$/.test(query)) return null;
  const value = Number.parseInt(query, 10);
  const lo: number[] = [];
  const hi: number[] = [];
  for (let span = 1; value * span <= 0xffffffff; span *= 10) {
    lo.push(value * span);
    hi.push((value + 1) * span);
  }
  return { lo, hi };
}

/** Fixed-size best-K list, so a query that matches half the world stays cheap. */
class Top {
  readonly score: Float64Array;
  readonly store: Int32Array;
  readonly index: Int32Array;
  count = 0;
  private worst = 0;
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
    this.score = new Float64Array(limit);
    this.store = new Int32Array(limit);
    this.index = new Int32Array(limit);
  }

  /** Lowest score that would still get in. */
  get floor(): number {
    return this.count < this.limit ? Number.NEGATIVE_INFINITY : this.score[this.worst];
  }

  add(score: number, store: number, index: number): void {
    let slot: number;
    if (this.count < this.limit) slot = this.count++;
    else if (score > this.score[this.worst]) slot = this.worst;
    else return;
    this.score[slot] = score;
    this.store[slot] = store;
    this.index[slot] = index;
    if (this.count === this.limit) {
      let worst = 0;
      for (let i = 1; i < this.limit; i++) if (this.score[i] < this.score[worst]) worst = i;
      this.worst = worst;
    }
  }
}

/**
 * Best matches for `query` across `stores`: exact, then prefix, then
 * substring; nearer first among equals when `near` is given.
 */
export function searchStores(
  stores: readonly EntityStore[],
  query: string,
  limit = DEFAULT_SEARCH_LIMIT,
  near?: { lon: number; lat: number },
): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (q === "" || limit <= 0) return [];
  const top = new Top(limit);
  const hex = hexQuery(q);
  const decimal = decimalQuery(q);

  for (let s = 0; s < stores.length; s++) {
    const store = stores[s];
    const n = store.count;
    const keys = store.keys;
    const ids = store.ids;
    const idQuery = store.kind === EntityKind.Aircraft ? hex : decimal;
    const ranges = idQuery === null ? 0 : idQuery.lo.length;

    for (let i = 0; i < n; i++) {
      let score = -1;
      const key = keys[i];
      if (key !== "") {
        const pos = key.indexOf(q);
        if (pos !== -1) score = scoreKey(key, q, pos);
      }
      if (idQuery !== null) {
        const id = ids[i];
        for (let r = 0; r < ranges; r++) {
          if (id >= idQuery.lo[r] && id < idQuery.hi[r]) {
            const exact = idQuery.hi[r] - idQuery.lo[r] === 1;
            const idScore = exact ? SCORE_ID_EXACT : SCORE_ID_PREFIX - Math.min(r, 8);
            if (idScore > score) score = idScore;
            break;
          }
        }
      }
      if (score < 0) continue;
      if (near !== undefined) {
        if (score + NEAR_BONUS <= top.floor) continue;
        let dLon = Math.abs(store.lon[i] - near.lon);
        if (dLon > 180) dLon = 360 - dLon;
        const d = Math.max(dLon, Math.abs(store.lat[i] - near.lat));
        if (d < NEAR_RANGE_DEG) score += NEAR_BONUS * (1 - d / NEAR_RANGE_DEG);
      } else if (score <= top.floor) continue;
      top.add(score, s, i);
    }
  }

  const results: SearchResult[] = [];
  for (let k = 0; k < top.count; k++) {
    const store = stores[top.store[k]];
    const i = top.index[k];
    const meta = store.meta[i];
    const result: SearchResult = {
      type: "entity",
      ref: { kind: store.kind, id: store.ids[i] },
      layer: layerForKind(store.kind).id,
      title: entityTitle(store.kind, store.ids[i], meta),
      lon: store.lon[i],
      lat: store.lat[i],
      score: top.score[k],
    };
    const subtitle = entitySubtitle(store.kind, store.category[i], meta);
    if (subtitle !== undefined) result.subtitle = subtitle;
    results.push(result);
  }
  return results.sort(byScore);
}

function byScore(a: SearchResult, b: SearchResult): number {
  return b.score - a.score || a.title.localeCompare(b.title);
}

/**
 * Fold several result lists into one ranked list. Earlier lists win when the
 * same entity appears twice, so local (fresher) results go first.
 */
export function mergeResults(
  lists: readonly SearchResult[][],
  limit = DEFAULT_SEARCH_LIMIT,
): SearchResult[] {
  const seen = new Set<string>();
  const merged: SearchResult[] = [];
  for (const list of lists) {
    for (const result of list) {
      const key = result.ref
        ? `e${result.ref.kind}:${result.ref.id}`
        : `p${result.title}:${result.lon.toFixed(2)}:${result.lat.toFixed(2)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(result);
    }
  }
  merged.sort(byScore);
  return merged.length > limit ? merged.slice(0, limit) : merged;
}
