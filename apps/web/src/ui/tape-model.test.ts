import type { ClockState } from "@orya-halo/schema";
import { describe, expect, it } from "vite-plus/test";
import {
  canScrub,
  dragTarget,
  keyScrub,
  LIVE_SNAP_MS,
  minutesBehind,
  MINUTE_MS,
  PX_PER_MIN,
  resolveScrub,
  ticks,
  timeOfX,
  underNeedle,
  xOfTime,
} from "./tape-model.ts";

const NOW = Date.UTC(2026, 10, 14, 19, 42, 7);
const HISTORY = { fromMs: NOW - 30 * MINUTE_MS, toMs: NOW };
const LIVE: ClockState = { mode: "live", timeMs: NOW };
const NEEDLE = 468;

describe("time and pixels", () => {
  it("puts the moment under the needle at the needle", () => {
    expect(xOfTime(NOW, NOW, NEEDLE)).toBe(NEEDLE);
  });

  it("runs ten pixels to the minute, earlier to the left", () => {
    expect(xOfTime(NOW - MINUTE_MS, NOW, NEEDLE)).toBe(NEEDLE - PX_PER_MIN);
    expect(xOfTime(NOW - 12 * MINUTE_MS, NOW, NEEDLE)).toBe(NEEDLE - 120);
    expect(xOfTime(NOW + 3 * MINUTE_MS, NOW, NEEDLE)).toBe(NEEDLE + 30);
  });

  it("maps pixels back to the same time", () => {
    for (const x of [-4, 0, 123.5, NEEDLE, 600]) {
      expect(xOfTime(timeOfX(x, NOW, NEEDLE), NOW, NEEDLE)).toBeCloseTo(x, 6);
    }
  });

  it("dragging the tape right goes back in time", () => {
    expect(dragTarget(NOW, 120)).toBe(NOW - 12 * MINUTE_MS);
    expect(dragTarget(NOW - 12 * MINUTE_MS, -50)).toBe(NOW - 7 * MINUTE_MS);
    expect(dragTarget(NOW, 0)).toBe(NOW);
  });
});

describe("resolveScrub", () => {
  it("stays live when there is no history to scrub", () => {
    expect(resolveScrub(NOW - 5 * MINUTE_MS, null, NOW)).toEqual({ mode: "live" });
    expect(resolveScrub(NOW - 5 * MINUTE_MS, { fromMs: NOW - 4000, toMs: NOW }, NOW)).toEqual({
      mode: "live",
    });
  });

  it("holds a moment inside the buffer", () => {
    expect(resolveScrub(NOW - 12 * MINUTE_MS, HISTORY, NOW)).toEqual({
      mode: "scrub",
      timeMs: NOW - 12 * MINUTE_MS,
    });
  });

  it("stops at the oldest recorded moment", () => {
    expect(resolveScrub(NOW - 90 * MINUTE_MS, HISTORY, NOW)).toEqual({
      mode: "scrub",
      timeMs: HISTORY.fromMs,
    });
  });

  it("snaps to live close to now, and for anything in the future", () => {
    expect(resolveScrub(NOW - LIVE_SNAP_MS + 1, HISTORY, NOW)).toEqual({ mode: "live" });
    expect(resolveScrub(NOW + MINUTE_MS, HISTORY, NOW)).toEqual({ mode: "live" });
    expect(resolveScrub(NOW - LIVE_SNAP_MS - 1, HISTORY, NOW).mode).toBe("scrub");
  });

  it("never asks for a moment newer than the history holds", () => {
    const stale = { fromMs: NOW - 30 * MINUTE_MS, toMs: NOW - 2 * MINUTE_MS };
    expect(resolveScrub(NOW - MINUTE_MS, stale, NOW)).toEqual({
      mode: "scrub",
      timeMs: stale.toMs,
    });
  });
});

describe("keyScrub", () => {
  it("steps a minute back from live with the left arrow", () => {
    expect(keyScrub("ArrowLeft", false, LIVE, HISTORY, NOW)).toEqual({
      mode: "scrub",
      timeMs: NOW - MINUTE_MS,
    });
  });

  it("steps from the scrubbed moment, not from now", () => {
    const clock: ClockState = { mode: "scrub", timeMs: NOW - 12 * MINUTE_MS };
    expect(keyScrub("ArrowLeft", false, clock, HISTORY, NOW)).toEqual({
      mode: "scrub",
      timeMs: NOW - 13 * MINUTE_MS,
    });
    expect(keyScrub("ArrowRight", false, clock, HISTORY, NOW)).toEqual({
      mode: "scrub",
      timeMs: NOW - 11 * MINUTE_MS,
    });
  });

  it("goes five minutes with Shift or the Page keys", () => {
    expect(keyScrub("ArrowLeft", true, LIVE, HISTORY, NOW)).toEqual({
      mode: "scrub",
      timeMs: NOW - 5 * MINUTE_MS,
    });
    expect(keyScrub("PageDown", false, LIVE, HISTORY, NOW)).toEqual({
      mode: "scrub",
      timeMs: NOW - 5 * MINUTE_MS,
    });
    const clock: ClockState = { mode: "scrub", timeMs: NOW - 12 * MINUTE_MS };
    expect(keyScrub("PageUp", false, clock, HISTORY, NOW)).toEqual({
      mode: "scrub",
      timeMs: NOW - 7 * MINUTE_MS,
    });
  });

  it("returns to live when the right arrow reaches now", () => {
    const clock: ClockState = { mode: "scrub", timeMs: NOW - MINUTE_MS };
    expect(keyScrub("ArrowRight", false, clock, HISTORY, NOW)).toEqual({ mode: "live" });
    expect(keyScrub("ArrowRight", false, LIVE, HISTORY, NOW)).toEqual({ mode: "live" });
  });

  it("jumps to the ends with Home and End", () => {
    expect(keyScrub("Home", false, LIVE, HISTORY, NOW)).toEqual({
      mode: "scrub",
      timeMs: HISTORY.fromMs,
    });
    expect(
      keyScrub("End", false, { mode: "scrub", timeMs: NOW - 9 * MINUTE_MS }, HISTORY, NOW),
    ).toEqual({
      mode: "live",
    });
  });

  it("does not run past the start of the buffer", () => {
    const clock: ClockState = { mode: "scrub", timeMs: HISTORY.fromMs + 20_000 };
    expect(keyScrub("ArrowLeft", false, clock, HISTORY, NOW)).toEqual({
      mode: "scrub",
      timeMs: HISTORY.fromMs,
    });
  });

  it("leaves other keys alone, and every key when the tape is locked", () => {
    expect(keyScrub("a", false, LIVE, HISTORY, NOW)).toBeNull();
    expect(keyScrub("Enter", false, LIVE, HISTORY, NOW)).toBeNull();
    expect(keyScrub("ArrowLeft", false, LIVE, null, NOW)).toBeNull();
    expect(canScrub({ fromMs: NOW - 30_000, toMs: NOW })).toBe(false);
  });
});

describe("the needle's readout", () => {
  it("is zero while live", () => {
    expect(minutesBehind(LIVE, NOW + 5000)).toBe(0);
    expect(underNeedle(LIVE, NOW + 5000)).toBe(NOW + 5000);
  });

  it("counts whole minutes, and at least one once scrubbed", () => {
    expect(minutesBehind({ mode: "scrub", timeMs: NOW - 12 * MINUTE_MS }, NOW)).toBe(12);
    expect(minutesBehind({ mode: "scrub", timeMs: NOW - 12.4 * MINUTE_MS }, NOW)).toBe(12);
    expect(minutesBehind({ mode: "scrub", timeMs: NOW - 25_000 }, NOW)).toBe(1);
  });

  it("grows as now moves on from a held moment", () => {
    const clock: ClockState = { mode: "scrub", timeMs: NOW - 12 * MINUTE_MS };
    expect(minutesBehind(clock, NOW + 3 * MINUTE_MS)).toBe(15);
    expect(underNeedle(clock, NOW + 3 * MINUTE_MS)).toBe(clock.timeMs);
  });
});

describe("ticks", () => {
  const input = {
    width: 600,
    needleX: NEEDLE,
    underMs: NOW,
    nowMs: NOW,
    history: HISTORY,
    keepClear: { from: NEEDLE - 20, to: NEEDLE + 60 },
  };

  it("draws one tick per whole minute, none in the future", () => {
    const list = ticks(input);
    expect(list.length).toBeGreaterThan(40);
    for (const tick of list) {
      expect(tick.timeMs % MINUTE_MS).toBe(0);
      expect(tick.timeMs).toBeLessThanOrEqual(NOW);
      expect(tick.x).toBeLessThanOrEqual(NEEDLE);
      expect(tick.x).toBeGreaterThanOrEqual(-4);
    }
    for (let i = 1; i < list.length; i++) expect(list[i].x - list[i - 1].x).toBe(PX_PER_MIN);
  });

  it("marks every fifth minute as major", () => {
    for (const tick of ticks(input)) {
      expect(tick.major).toBe(new Date(tick.timeMs).getUTCMinutes() % 5 === 0);
    }
  });

  it("knows which ticks the needle can reach", () => {
    const list = ticks(input);
    expect(list.some((t) => !t.reachable)).toBe(true);
    for (const tick of list) expect(tick.reachable).toBe(tick.timeMs >= HISTORY.fromMs);
    expect(ticks({ ...input, history: null }).every((t) => !t.reachable)).toBe(true);
  });

  it("labels major ticks only, and keeps them out from under the readout", () => {
    const list = ticks(input);
    const labelled = list.filter((t) => t.labelled);
    expect(labelled.length).toBeGreaterThan(5);
    for (const tick of labelled) {
      expect(tick.major).toBe(true);
      expect(tick.x < input.keepClear.from || tick.x > input.keepClear.to).toBe(true);
    }
    // 19:40 sits 21px left of the needle at 19:42:07, just clear; one minute later it would not be.
    const later = ticks({ ...input, underMs: NOW - 2 * MINUTE_MS });
    const underFlag = later.find(
      (t) => t.x >= input.keepClear.from && t.x <= input.keepClear.to && t.major,
    );
    expect(underFlag?.labelled).toBe(false);
  });

  it("shows the stretch between the needle and now when scrubbed", () => {
    const list = ticks({ ...input, underMs: NOW - 12 * MINUTE_MS });
    const right = list.filter((t) => t.x > NEEDLE);
    expect(right.length).toBe(12);
    expect(Math.max(...right.map((t) => t.x))).toBeLessThanOrEqual(
      xOfTime(NOW, NOW - 12 * MINUTE_MS, NEEDLE),
    );
  });

  it("drops labels beyond the limit a phone asks for", () => {
    const list = ticks({ ...input, underMs: NOW - 12 * MINUTE_MS, labelLimit: NEEDLE + 80 });
    expect(list.filter((t) => t.labelled).every((t) => t.x < NEEDLE + 80)).toBe(true);
  });
});
