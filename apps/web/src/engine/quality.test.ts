import { describe, expect, it } from "vite-plus/test";
import type { QualityTier } from "../core/engine.ts";
import { QUALITY, QualityGovernor, RefreshRateEstimate, costlier, higherTier } from "./quality.ts";

/**
 * Runs the governor against a pretend machine for `windows` one-second
 * windows and returns every tier change, with the window it happened in.
 */
function simulate(
  governor: QualityGovernor,
  start: QualityTier,
  fpsAt: (tier: QualityTier, window: number) => number,
  windows: number,
  displayHz = 60,
): { tier: QualityTier; changes: { window: number; to: QualityTier }[] } {
  let tier = start;
  const changes: { window: number; to: QualityTier }[] = [];
  for (let w = 0; w < windows; w++) {
    const next = governor.sample(fpsAt(tier, w), tier, displayHz);
    if (next) {
      tier = next;
      changes.push({ window: w, to: next });
    }
  }
  return { tier, changes };
}

describe("quality tiers", () => {
  it("makes the low tier cheaper in every way it can be", () => {
    const { low, balanced, high } = QUALITY;
    expect(low.maxPixelRatio).toBe(1);
    expect(low.tails).toBe(false);
    expect(low.glow).toBe(0);
    expect(low.faintStars).toBe(false);
    expect(low.lightsFine).toBe(false);
    expect(low.density).toBe(false);
    expect(low.farThin).toBeGreaterThan(0);
    expect(high.farThin).toBe(0);
    expect(low.mapFadeMs).toBe(0);
    expect(balanced.maxPixelRatio).toBeLessThan(high.maxPixelRatio);
    expect(balanced.glow).toBeLessThan(high.glow);
  });

  it("knows which way is up", () => {
    expect(higherTier("low")).toBe("balanced");
    expect(higherTier("balanced")).toBe("high");
    expect(higherTier("high")).toBeNull();
    expect(costlier("high", "low")).toBe(true);
    expect(costlier("low", "balanced")).toBe(false);
    expect(costlier("balanced", "balanced")).toBe(false);
  });
});

describe("QualityGovernor, stepping up", () => {
  it("recovers one tier at a time once frames are comfortably fast", () => {
    const governor = new QualityGovernor({ graceWindows: 2, recoverWindows: 5 });
    const { tier, changes } = simulate(governor, "low", () => 60, 20);
    expect(tier).toBe("high");
    expect(changes.map((c) => c.to)).toEqual(["balanced", "high"]);
    // Grace, then five good windows, for each step.
    expect(changes[0].window).toBe(6);
    expect(changes[1].window).toBe(13);
  });

  it("does nothing in the band between the two lines", () => {
    const governor = new QualityGovernor({ graceWindows: 0 });
    // 48 fps: above the step-down line (42), below the step-up line (55).
    expect(simulate(governor, "balanced", () => 48, 500).changes).toEqual([]);
  });

  it("needs the good windows in a row", () => {
    const governor = new QualityGovernor({ graceWindows: 0, recoverWindows: 4 });
    const fps = [60, 60, 60, 50, 60, 60, 60, 50, 60, 60, 60, 60];
    const { changes } = simulate(governor, "low", (_, w) => fps[w], fps.length);
    expect(changes).toEqual([{ window: 11, to: "balanced" }]);
  });

  it("never goes above the tier that was asked for", () => {
    const governor = new QualityGovernor({ graceWindows: 0, recoverWindows: 2 });
    governor.setCeiling("balanced");
    const { tier } = simulate(governor, "low", () => 60, 200);
    expect(tier).toBe("balanced");

    governor.setCeiling("low");
    expect(simulate(governor, "low", () => 60, 200).changes).toEqual([]);
  });

  it("settles instead of oscillating when the costlier tier cannot hold", () => {
    const governor = new QualityGovernor({
      graceWindows: 2,
      strikes: 3,
      recoverWindows: 10,
      probationWindows: 30,
      backoff: 4,
      maxAttempts: 2,
    });
    // A machine that holds `balanced` at the display rate but manages 30 on `high`.
    const machine = (tier: QualityTier): number => (tier === "high" ? 30 : 60);
    const { tier, changes } = simulate(governor, "high", machine, 5000);
    expect(tier).toBe("balanced");
    // Down, then two attempts and no more.
    expect(changes.map((c) => c.to)).toEqual(["balanced", "high", "balanced", "high", "balanced"]);
    // The second attempt waits four times as long as the first.
    const firstWait = changes[1].window - changes[0].window;
    const secondWait = changes[3].window - changes[2].window;
    expect(secondWait).toBeGreaterThan(firstWait * 3);
    expect(governor.windowsToTry("high")).toBe(Number.POSITIVE_INFINITY);
    // And `low`, which was never needed, is still a fair target for stepping up to.
    expect(governor.windowsToTry("balanced")).toBe(10);
  });

  it("does not hold a late slowdown against a tier that had settled", () => {
    const governor = new QualityGovernor({
      graceWindows: 0,
      strikes: 1,
      recoverWindows: 3,
      probationWindows: 5,
    });
    // Up to high, hold it past probation, then a heavy scene arrives.
    const fps = (_: QualityTier, w: number): number => (w >= 20 && w < 22 ? 20 : 60);
    const { changes } = simulate(governor, "balanced", fps, 40);
    expect(changes.map((c) => c.to).slice(0, 3)).toEqual(["high", "balanced", "low"]);
    // No failure was recorded, so the way back up costs the normal wait.
    expect(governor.windowsToTry("high")).toBe(3);
  });

  it("keeps what it learnt when the recent windows are thrown away", () => {
    const governor = new QualityGovernor({
      graceWindows: 0,
      strikes: 1,
      recoverWindows: 2,
      maxAttempts: 1,
    });
    const machine = (tier: QualityTier): number => (tier === "high" ? 20 : 60);
    simulate(governor, "balanced", machine, 10);
    expect(governor.windowsToTry("high")).toBe(Number.POSITIVE_INFINITY);
    governor.reset();
    expect(governor.windowsToTry("high")).toBe(Number.POSITIVE_INFINITY);
    expect(simulate(governor, "balanced", machine, 200).changes).toEqual([]);
  });

  it("judges a 30 Hz display by what it can show", () => {
    const governor = new QualityGovernor({ graceWindows: 0, recoverWindows: 4 });
    // Capped at 30 whatever the tier: there is nothing to gain by staying low.
    const { tier } = simulate(governor, "low", () => 30, 40, 30);
    expect(tier).toBe("high");
  });
});

describe("RefreshRateEstimate", () => {
  it("assumes 60 until the cheapest tier is dead level below it", () => {
    const estimate = new RefreshRateEstimate(4);
    expect(estimate.value).toBe(60);
    // Slow on a costly tier says nothing about the display.
    for (let i = 0; i < 20; i++) expect(estimate.observe(30, false)).toBe(60);
    for (let i = 0; i < 3; i++) expect(estimate.observe(30, true)).toBe(60);
    expect(estimate.observe(30.2, true)).toBe(30);
  });

  it("does not take a steadily slow GPU for a cap", () => {
    // Software rendering holds seven frames a second as level as any display would.
    const estimate = new RefreshRateEstimate(4);
    for (let i = 0; i < 40; i++) estimate.observe(7 + (i % 2) * 0.1, true);
    expect(estimate.value).toBe(60);
    // And so the governor stays on the cheapest tier instead of climbing into worse.
    const governor = new QualityGovernor({ graceWindows: 0, recoverWindows: 4 });
    expect(simulate(governor, "low", () => 7, 200, estimate.value).changes).toEqual([]);
  });

  it("does not take a wobbling frame rate for a cap", () => {
    const estimate = new RefreshRateEstimate(4);
    for (const fps of [28, 36, 31, 24, 38, 29, 35, 26, 33, 40]) estimate.observe(fps, true);
    expect(estimate.value).toBe(60);
  });

  it("drops the assumption on the first fast window", () => {
    const estimate = new RefreshRateEstimate(2);
    estimate.observe(30, true);
    estimate.observe(30, true);
    expect(estimate.value).toBe(30);
    expect(estimate.observe(59.8, true)).toBe(60);
  });

  it("lets a capped phone climb back out of the low tier", () => {
    const governor = new QualityGovernor({ graceWindows: 0, recoverWindows: 4, strikes: 3 });
    const estimate = new RefreshRateEstimate(4);
    let tier: QualityTier = "high";
    const seen: QualityTier[] = [];
    for (let w = 0; w < 80; w++) {
      const hz = estimate.observe(30, tier === "low");
      const next = governor.sample(30, tier, hz);
      if (next) {
        tier = next;
        estimate.reset();
        seen.push(next);
      }
    }
    // Mistaken for a slow GPU at first, then recognised as a cap and undone.
    expect(seen).toEqual(["balanced", "low", "balanced", "high"]);
  });
});
