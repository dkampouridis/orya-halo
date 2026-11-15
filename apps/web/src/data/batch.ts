/**
 * Batch builder: turns a store into a GPU-ready `RenderBatch`.
 *
 * Continuity is the point. When an entity has a new fix, the builder asks
 * where the previous batch draws it at the new batch's update time (with
 * `extrapolate()`, the same maths as the vertex shader) and stores the
 * difference from the new path in `blend`. The renderer eases that offset to
 * zero over `BLEND_SECONDS`, so a correction never shows as a jump.
 */
import {
  BLEND_SIZE,
  EntityKind,
  MOTION_SIZE,
  POSITION_SIZE,
  STYLE_SIZE,
  createRenderBatch,
  extrapolate,
} from "@orya-halo/schema";
import type { RenderBatch } from "@orya-halo/schema";
import type { EntityStore } from "./store.ts";

/**
 * Corrections larger than this snap instead of easing: after a long gap
 * (hidden tab, lost feed) a 1.5 s glide across the map would be a lie.
 */
export const MAX_BLEND_DEG = 0.3;

/** Blend start time written for entities with nothing to ease, seconds before the epoch. */
const NO_BLEND_S = -1e6;

/** The `style[3]` byte for aircraft: the 3D model id (`aircraftModelForType`), 0 when unknown. */
export function modelByte(value: number): number {
  return value > 0 && value < 256 ? Math.trunc(value) : 0;
}

/**
 * The `style[2]` byte: a kind's scalar squeezed to 0..255 for the shader.
 * Ships: length, 0..400 m. Satellites: orbital period, 0..1440 min.
 * Earthquakes: magnitude, 0..10. Fires: radiative power on a log scale,
 * 1000 MW and above is 255. Other kinds: 0.
 */
export function styleValue(kind: EntityKind, value: number): number {
  let x = 0;
  switch (kind) {
    case EntityKind.Ship:
      x = value / 400;
      break;
    case EntityKind.Satellite:
      x = value / 1440;
      break;
    case EntityKind.Quake:
      x = value / 10;
      break;
    case EntityKind.Fire:
      x = Math.log10(1 + Math.max(value, 0)) / 3;
      break;
    default:
      return 0;
  }
  if (!(x > 0)) return 0;
  return x >= 1 ? 255 : Math.round(x * 255);
}

function wrapDelta(d: number): number {
  if (d > 180) return d - 360;
  if (d < -180) return d + 360;
  return d;
}

export class BatchBuilder {
  readonly kind: EntityKind;
  private seq = 0;
  /** Epoch of the previous batch: the frame the store's blend state is in. */
  private lastEpochMs = 0;
  // One-entity scratch batches so the offset is computed by `extrapolate()`
  // itself, on exactly the float32 values the batches carry.
  private readonly before: RenderBatch;
  private readonly after: RenderBatch;
  private readonly a: [number, number, number] = [0, 0, 0];
  private readonly b: [number, number, number] = [0, 0, 0];

  constructor(kind: EntityKind) {
    this.kind = kind;
    this.before = createRenderBatch(kind, 1, 0);
    this.after = createRenderBatch(kind, 1, 0);
    this.after.blend[2] = NO_BLEND_S;
  }

  /** An empty batch, to clear the renderer when a layer is switched off. */
  empty(timeMs: number): RenderBatch {
    this.lastEpochMs = Math.floor(timeMs);
    return createRenderBatch(this.kind, 0, this.lastEpochMs, ++this.seq);
  }

  /** Next sequence number, for batches built elsewhere (history replay). */
  nextSeq(): number {
    return ++this.seq;
  }

  /**
   * Snapshot `store` at `timeMs` (the update time: wall time when live, the
   * scrubbed time when replaying). With `blend` false every entity is placed
   * exactly on its fix: used when resuming, where easing from stale positions
   * would be wrong.
   */
  build(store: EntityStore, timeMs: number, blend = true): RenderBatch {
    const n = store.count;
    // Re-based every batch, so times stay small and float32 keeps sub-ms steps.
    const epochMs = Math.floor(timeMs);
    const lastEpochMs = this.lastEpochMs;
    const batch = createRenderBatch(this.kind, n, epochMs, ++this.seq);
    const { positions, motion, style } = batch;
    const blendOut = batch.blend;
    const before = this.before;
    const after = this.after;
    const a = this.a;
    const b = this.b;
    const kind = this.kind;
    // Column references held in locals: the loop below runs for every entity.
    const {
      lon,
      lat,
      alt,
      heading,
      speed,
      vrate,
      fixTimeMs,
      category,
      flags,
      value,
      dirty,
      drawn,
      bLon,
      bLat,
      bTimeMs,
    } = store;
    // Kinds whose scalar means nothing to the shader skip the scaling call.
    const styled = styleValue(kind, 1) !== 0;

    before.epochMs = lastEpochMs;
    after.epochMs = epochMs;

    for (let i = 0; i < n; i++) {
      if (dirty[i] === 1) {
        let dLon = 0;
        let dLat = 0;
        if (blend && drawn[i] === 1) {
          before.positions[0] = store.pLon[i];
          before.positions[1] = store.pLat[i];
          before.positions[2] = store.pAlt[i];
          before.motion[0] = store.pHeading[i];
          before.motion[1] = store.pSpeed[i];
          before.motion[2] = store.pVrate[i];
          before.motion[3] = (store.pFixTimeMs[i] - lastEpochMs) / 1000;
          before.blend[0] = bLon[i];
          before.blend[1] = bLat[i];
          before.blend[2] = Math.max((bTimeMs[i] - lastEpochMs) / 1000, NO_BLEND_S);
          extrapolate(before, 0, timeMs, a);

          after.positions[0] = lon[i];
          after.positions[1] = lat[i];
          after.positions[2] = alt[i];
          after.motion[0] = heading[i];
          after.motion[1] = speed[i];
          after.motion[2] = vrate[i];
          after.motion[3] = (fixTimeMs[i] - epochMs) / 1000;
          extrapolate(after, 0, timeMs, b);

          dLon = wrapDelta(a[0] - b[0]);
          dLat = a[1] - b[1];
          const scaledLon = dLon * Math.cos(b[1] * (Math.PI / 180));
          if (
            dLat > MAX_BLEND_DEG ||
            dLat < -MAX_BLEND_DEG ||
            scaledLon > MAX_BLEND_DEG ||
            scaledLon < -MAX_BLEND_DEG
          ) {
            dLon = 0;
            dLat = 0;
          }
        }
        bLon[i] = dLon;
        bLat[i] = dLat;
        bTimeMs[i] = timeMs;
        dirty[i] = 0;
        drawn[i] = 1;
      } else if (!blend) {
        bLon[i] = 0;
        bLat[i] = 0;
      }

      const p = i * POSITION_SIZE;
      positions[p] = lon[i];
      positions[p + 1] = lat[i];
      positions[p + 2] = alt[i];

      const m = i * MOTION_SIZE;
      motion[m] = heading[i];
      motion[m + 1] = speed[i];
      motion[m + 2] = vrate[i];
      motion[m + 3] = (fixTimeMs[i] - epochMs) / 1000;

      const o = i * BLEND_SIZE;
      const dLon = bLon[i];
      const dLat = bLat[i];
      blendOut[o] = dLon;
      blendOut[o + 1] = dLat;
      blendOut[o + 2] =
        dLon === 0 && dLat === 0 ? NO_BLEND_S : Math.max((bTimeMs[i] - epochMs) / 1000, NO_BLEND_S);

      const s = i * STYLE_SIZE;
      style[s] = category[i];
      style[s + 1] = flags[i];
      if (styled) style[s + 2] = styleValue(kind, value[i]);
      else if (kind === EntityKind.Aircraft) style[s + 3] = modelByte(value[i]);
    }

    batch.ids.set(store.ids.subarray(0, n));
    batch.values.set(store.value.subarray(0, n));
    this.lastEpochMs = epochMs;
    store.changed = false;
    return batch;
  }
}
