import { describe, expect, it } from "vite-plus/test";
import {
  agoText,
  clockText,
  decimalsOf,
  distanceKm,
  formatNumber,
  hourMinute,
  MINUS,
  parseFigure,
  positionText,
  spanOf,
  tweenValue,
} from "./format.ts";

describe("formatNumber", () => {
  it("groups thousands", () => {
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(999)).toBe("999");
    expect(formatNumber(1000)).toBe("1,000");
    expect(formatNumber(12410)).toBe("12,410");
    expect(formatNumber(1234567)).toBe("1,234,567");
  });

  it("keeps the decimals it is asked for, so digits do not come and go mid-tween", () => {
    expect(formatNumber(17.4, 1)).toBe("17.4");
    expect(formatNumber(17, 1)).toBe("17.0");
    expect(formatNumber(1204.5, 2)).toBe("1,204.50");
  });

  it("rounds to the shown precision", () => {
    expect(formatNumber(10971.6)).toBe("10,972");
    expect(formatNumber(0.449, 1)).toBe("0.4");
  });

  it("uses a real minus sign and never writes minus zero", () => {
    expect(formatNumber(-5)).toBe(`${MINUS}5`);
    expect(formatNumber(-1234.5, 1)).toBe(`${MINUS}1,234.5`);
    expect(formatNumber(-0.2)).toBe("0");
    expect(formatNumber(-0)).toBe("0");
  });

  it("writes nothing for values that are not numbers", () => {
    expect(formatNumber(Number.NaN)).toBe("");
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe("");
  });
});

describe("decimalsOf and parseFigure", () => {
  it("reads back what formatNumber wrote", () => {
    for (const [value, decimals] of [
      [12410, 0],
      [17.4, 1],
      [-1204.5, 2],
      [0, 0],
    ] as const) {
      const text = formatNumber(value, decimals);
      expect(decimalsOf(text)).toBe(decimals);
      expect(parseFigure(text)).toBeCloseTo(value, 6);
    }
  });

  it("accepts the worker's plain hyphen", () => {
    expect(parseFigure("-12.5")).toBe(-12.5);
  });

  it("refuses text that only looks numeric", () => {
    expect(parseFigure("2026-11-14 19:20 UTC")).toBeNaN();
    expect(parseFigure("n/a")).toBeNaN();
    expect(parseFigure("")).toBeNaN();
    expect(parseFigure("7700 (emergency)")).toBeNaN();
  });

  it("does not mistake a thousands group for decimals", () => {
    expect(decimalsOf("12,410")).toBe(0);
    expect(decimalsOf("1,204.50")).toBe(2);
  });
});

describe("tweenValue", () => {
  it("starts at the old value and lands exactly on the new one", () => {
    expect(tweenValue(100, 250, 0)).toBe(100);
    expect(tweenValue(100, 250, 1)).toBe(250);
    expect(tweenValue(100, 250, 1.4)).toBe(250);
    expect(tweenValue(0.1, 0.3, 1)).toBe(0.3);
  });

  it("moves monotonically towards the target, fastest at the start", () => {
    let last = 100;
    const steps: number[] = [];
    for (let step = 1; step <= 9; step++) {
      const v = tweenValue(100, 250, step / 10);
      expect(v).toBeGreaterThan(last);
      expect(v).toBeLessThan(250);
      steps.push(v - last);
      last = v;
    }
    expect(steps[0]).toBeGreaterThan(steps[steps.length - 1]);
  });

  it("tweens downward too", () => {
    expect(tweenValue(250, 100, 0.5)).toBeLessThan(250);
    expect(tweenValue(250, 100, 0.5)).toBeGreaterThan(100);
  });
});

describe("time", () => {
  const at = Date.UTC(2026, 10, 14, 19, 42, 7);

  it("writes the UTC clock with leading zeros", () => {
    expect(clockText(at)).toBe("19:42:07");
    expect(clockText(Date.UTC(2026, 0, 1, 0, 5, 9))).toBe("00:05:09");
    expect(hourMinute(at)).toBe("19:42");
  });

  it("picks the largest sensible unit for a span", () => {
    expect(spanOf(2000)).toEqual({ value: 2, unit: "s" });
    expect(spanOf(59_400)).toEqual({ value: 59, unit: "s" });
    expect(spanOf(120_000)).toEqual({ value: 2, unit: "min" });
    expect(spanOf(2 * 3_600_000)).toEqual({ value: 2, unit: "h" });
    expect(spanOf(3 * 86_400_000)).toEqual({ value: 3, unit: "d" });
    expect(spanOf(-500)).toEqual({ value: 0, unit: "s" });
  });

  it("says just now inside the first minute", () => {
    expect(agoText(12_000)).toBe("just now");
    expect(agoText(130_000)).toBe("2 min ago");
  });
});

describe("position", () => {
  it("names the hemispheres", () => {
    expect(positionText(51.4775, -0.4614)).toBe("51.48° N, 0.46° W");
    expect(positionText(-33.9, 151.2, 1)).toBe("33.9° S, 151.2° E");
  });

  it("measures great-circle distance", () => {
    // London Heathrow to New York JFK is about 5,540 km.
    const km = distanceKm({ lon: -0.4614, lat: 51.4775 }, { lon: -73.7781, lat: 40.6413 });
    expect(km).toBeGreaterThan(5500);
    expect(km).toBeLessThan(5580);
    expect(distanceKm({ lon: 10, lat: 10 }, { lon: 10, lat: 10 })).toBe(0);
  });
});
