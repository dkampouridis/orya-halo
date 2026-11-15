/** Quality tiers and the governor that moves between them as frames run long or short. Pure. */
import type { QualityTier } from "../core/engine.ts";

export interface QualitySettings {
  /** Upper bound on the device pixel ratio of both canvases. */
  maxPixelRatio: number;
  /** Comet tails on moving objects. */
  tails: boolean;
  /** Strength of the soft halo around glyphs; 0 skips it and shrinks every glyph's quad. */
  glow: number;
  /** Starfield brightness. */
  stars: number;
  /** Draw the second, fainter and much denser layer of stars. */
  faintStars: boolean;
  /** City lights at their best: a wide glow and smooth magnification (up to four more texture reads per night-side pixel). */
  lightsFine: boolean;
  /** Low-zoom density underlay. */
  density: boolean;
  /** Share of moving objects, faintest first, left undrawn in the far view. */
  farThin: number;
  /** Milliseconds MapLibre fades labels and tiles in over; 0 saves the repaints the fades cost. */
  mapFadeMs: number;
  /**
   * Close in, draw aircraft as 3D models of their types instead of flat
   * glyphs: at most this many, nearest the middle of the view first. 0 keeps glyphs.
   */
  aircraftModels: number;
}

export const QUALITY: Record<QualityTier, QualitySettings> = {
  high: {
    maxPixelRatio: 2,
    tails: true,
    glow: 1,
    stars: 1,
    faintStars: true,
    lightsFine: true,
    density: true,
    farThin: 0,
    mapFadeMs: 200,
    aircraftModels: 3000,
  },
  balanced: {
    maxPixelRatio: 1.5,
    tails: true,
    glow: 0.7,
    stars: 1,
    faintStars: true,
    lightsFine: true,
    density: true,
    farThin: 0,
    mapFadeMs: 200,
    aircraftModels: 800,
  },
  // For integrated graphics and phones: one canvas pixel per CSS pixel, bare
  // glyphs on small quads, half the points of a far view, a third of the
  // stars, and a map that does not repaint to fade things in.
  low: {
    maxPixelRatio: 1,
    tails: false,
    glow: 0,
    stars: 0.85,
    faintStars: false,
    lightsFine: false,
    density: false,
    farThin: 0.5,
    mapFadeMs: 0,
    aircraftModels: 0,
  },
};

/** Costly first. */
export const TIER_ORDER: readonly QualityTier[] = ["high", "balanced", "low"];

/** The next cheaper tier, or null when already at the bottom. */
export function lowerTier(tier: QualityTier): QualityTier | null {
  const i = TIER_ORDER.indexOf(tier);
  return i >= 0 && i < TIER_ORDER.length - 1 ? TIER_ORDER[i + 1] : null;
}

/** The next costlier tier, or null when already at the top. */
export function higherTier(tier: QualityTier): QualityTier | null {
  const i = TIER_ORDER.indexOf(tier);
  return i > 0 ? TIER_ORDER[i - 1] : null;
}

/** True when `a` costs more per frame than `b`. */
export function costlier(a: QualityTier, b: QualityTier): boolean {
  return TIER_ORDER.indexOf(a) < TIER_ORDER.indexOf(b);
}

export interface GovernorOptions {
  /** Step down when a window averages below this many frames per second. */
  minFps?: number;
  /** ...for this many windows in a row. */
  strikes?: number;
  /** Windows to ignore after start or a change, while shaders compile and tiles load. */
  graceWindows?: number;
  /** A window counts towards stepping back up when it averages at least this. */
  recoverFps?: number;
  /** Good windows in a row before the first attempt to step up. */
  recoverWindows?: number;
  /** A tier that has to be left again within this many windows of being tried has failed. */
  probationWindows?: number;
  /** After a failed attempt, wait this many times longer before the next. */
  backoff?: number;
  /** Attempts at one tier before it is given up on for the rest of the session. */
  maxAttempts?: number;
}

/**
 * Watches the frame rate in one-second windows and moves between tiers.
 *
 * Down is quick: a few slow windows in a row. Up is slow and remembers: the
 * frame rate must sit well above the step-down line for a while (the gap
 * between the two lines is the hysteresis band, where nothing happens), and
 * because a frame rate capped by the display cannot show how much headroom
 * there is, stepping up is an experiment. If the costlier tier has to be left
 * again while on probation, the next attempt waits several times longer, and
 * after `maxAttempts` failures that tier is not tried again. So a machine
 * that can hold `balanced` but not `high` settles on `balanced` after a
 * bounded number of tries instead of swinging between the two.
 *
 * The governor never goes above the ceiling: the tier the person (or the
 * app) asked for.
 */
export class QualityGovernor {
  private readonly minFps: number;
  private readonly strikesNeeded: number;
  private readonly graceWindows: number;
  private readonly recoverFps: number;
  private readonly recoverWindows: number;
  private readonly probationWindows: number;
  private readonly backoff: number;
  private readonly maxAttempts: number;

  private ceiling: QualityTier = "high";
  private strikes = 0;
  private good = 0;
  private grace: number;
  /** Windows left in which stepping down counts against the tier just tried; 0 when not on probation. */
  private probation = 0;
  /** The tier being tried while on probation. */
  private trying: QualityTier | null = null;
  /** Failed attempts per tier. */
  private readonly failures: Record<QualityTier, number> = { high: 0, balanced: 0, low: 0 };

  constructor(options: GovernorOptions = {}) {
    this.minFps = options.minFps ?? 42;
    this.strikesNeeded = options.strikes ?? 3;
    this.graceWindows = options.graceWindows ?? 3;
    this.recoverFps = options.recoverFps ?? 55;
    this.recoverWindows = options.recoverWindows ?? 12;
    this.probationWindows = options.probationWindows ?? 30;
    this.backoff = options.backoff ?? 4;
    this.maxAttempts = options.maxAttempts ?? 2;
    this.grace = this.graceWindows;
  }

  /** The costliest tier the governor may choose: what the person asked for. */
  setCeiling(tier: QualityTier): void {
    this.ceiling = tier;
  }

  /**
   * Forget the recent windows, e.g. after the tier was changed or the tab was
   * hidden. What was learnt about tiers that failed is kept.
   */
  reset(): void {
    this.strikes = 0;
    this.good = 0;
    this.grace = this.graceWindows;
  }

  /** How many good windows in a row stepping up to `tier` needs right now; Infinity when given up on. */
  windowsToTry(tier: QualityTier): number {
    const failed = this.failures[tier];
    if (failed >= this.maxAttempts) return Number.POSITIVE_INFINITY;
    return this.recoverWindows * this.backoff ** failed;
  }

  /**
   * Report one window's average frame rate. Returns the tier to switch to, or
   * null to stay. `displayHz` caps the expectation on slow displays.
   */
  sample(fps: number, tier: QualityTier, displayHz = 60): QualityTier | null {
    if (this.grace > 0) {
      this.grace--;
      return null;
    }
    if (this.probation > 0 && --this.probation === 0) this.trying = null;

    const floor = Math.min(this.minFps, displayHz * 0.7);
    if (fps < floor) {
      this.good = 0;
      this.strikes++;
      if (this.strikes < this.strikesNeeded) return null;
      const next = lowerTier(tier);
      if (next && this.trying === tier) this.failures[tier]++;
      this.trying = null;
      this.probation = 0;
      this.reset();
      return next;
    }
    this.strikes = 0;

    // The band between the two lines: fast enough to stay, not fast enough to try more.
    const ready = Math.max(Math.min(this.recoverFps, displayHz * 0.92), floor);
    if (fps < ready) {
      this.good = 0;
      return null;
    }
    this.good++;
    const up = higherTier(tier);
    if (!up || costlier(up, this.ceiling)) return null;
    if (this.good < this.windowsToTry(up)) return null;
    this.trying = up;
    this.probation = this.probationWindows;
    this.reset();
    return up;
  }
}

/**
 * Spots a display (or a power-saving mode) that only asks for frames 30 or 50
 * times a second, so the governor does not mistake the cap for a slow GPU.
 *
 * Frame counts alone cannot tell a capped display from a GPU that happens to
 * manage 30: both look the same while there is a cheaper tier left to try.
 * So the estimate stays at 60 until the cheapest tier is running and the rate
 * still sits dead level at a rate displays and power savers really use, 30
 * or 50; a struggling GPU wobbles, or is level somewhere else (seven frames
 * a second is not a display rate). Any window at 55 or more ends the
 * assumption at once.
 *
 * A GPU that manages exactly 30 on the cheapest tier of a 60 Hz display looks
 * the same as a cap. It gets the benefit of the doubt, the governor's two
 * bounded attempts at the next tier fail, and it stays where it was.
 */
/** Refresh rates below 60 that a display or a power-saving mode may hold frames to. */
const CAPPED_RATES = [30, 50] as const;

export class RefreshRateEstimate {
  private rate = 60;
  private level = 0;
  private mean = 0;
  private readonly windowsNeeded: number;

  constructor(windowsNeeded = 8) {
    this.windowsNeeded = windowsNeeded;
  }

  get value(): number {
    return this.rate;
  }

  /** Feed one window's average frame rate; returns the current estimate. */
  observe(fps: number, atCheapestTier: boolean): number {
    if (!Number.isFinite(fps) || fps <= 0) return this.rate;
    if (fps >= 55) {
      this.rate = 60;
      this.level = 0;
      return this.rate;
    }
    if (!atCheapestTier) {
      this.level = 0;
      return this.rate;
    }
    if (this.level > 0 && Math.abs(fps - this.mean) <= this.mean * 0.05) {
      this.mean += (fps - this.mean) / ++this.level;
    } else {
      this.level = 1;
      this.mean = fps;
    }
    if (this.level >= this.windowsNeeded) {
      for (const cap of CAPPED_RATES) {
        if (Math.abs(this.mean - cap) <= cap * 0.06) this.rate = cap;
      }
    }
    return this.rate;
  }

  /** Forget the run of level windows (the tab was hidden, the tier changed). */
  reset(): void {
    this.level = 0;
  }
}
