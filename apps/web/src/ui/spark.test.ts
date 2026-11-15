import { describe, expect, it } from "vite-plus/test";
import { cleanSeries, niceStep, sparkGeometry, sparkScale, sparkWords } from "./spark.ts";

const BOX = { width: 308, height: 40, pad: 3 };
const minutes = (n: number): number[] => Array.from({ length: n }, (_, i) => i * 60_000);

describe("cleanSeries", () => {
  it("drops non-finite values and times, and samples that do not move time forward", () => {
    const points = cleanSeries(
      [0, 1, 2, 2, Number.NaN, 5, 4, 6],
      [10, Number.NaN, 12, 13, 14, 15, 16, Infinity],
    );
    expect(points).toEqual([
      { t: 0, v: 10 },
      { t: 2, v: 12 },
      { t: 5, v: 15 },
    ]);
  });

  it("stops at the shorter of the two arrays", () => {
    expect(cleanSeries([0, 1, 2], [5])).toEqual([{ t: 0, v: 5 }]);
  });
});

describe("niceStep", () => {
  it("rounds to 1, 2 or 5 times a power of ten", () => {
    expect(niceStep(0.7)).toBe(1);
    expect(niceStep(1.3)).toBe(2);
    expect(niceStep(3)).toBe(5);
    expect(niceStep(7)).toBe(10);
    expect(niceStep(240)).toBe(500);
  });

  it("never returns zero or NaN", () => {
    expect(niceStep(0)).toBe(1);
    expect(niceStep(Number.NaN)).toBe(1);
  });
});

describe("sparkGeometry", () => {
  it("draws nothing for a single point, an empty series or only NaN", () => {
    expect(sparkGeometry({ timesMs: [0], values: [1000] }, BOX, 30)).toBeNull();
    expect(sparkGeometry({ timesMs: [], values: [] }, BOX, 30)).toBeNull();
    expect(
      sparkGeometry({ timesMs: [0, 1, 2], values: [Number.NaN, Number.NaN, Number.NaN] }, BOX, 30),
    ).toBeNull();
  });

  it("draws nothing for a constant or nearly constant series", () => {
    expect(
      sparkGeometry(
        { timesMs: minutes(5), values: [10_000, 10_000, 10_000, 10_000, 10_000] },
        BOX,
        30,
      ),
    ).toBeNull();
    // Transponder noise at cruise: 25 ft steps.
    expect(
      sparkGeometry({ timesMs: minutes(4), values: [10_668, 10_676, 10_668, 10_660] }, BOX, 30),
    ).toBeNull();
  });

  it("spans the box inside its padding, oldest at the left, highest at the top", () => {
    const g = sparkGeometry({ timesMs: minutes(3), values: [0, 500, 1000] }, BOX, 30);
    expect(g).not.toBeNull();
    if (!g) return;
    expect(g.d.startsWith("M3 37")).toBe(true);
    expect(g.end).toEqual({ x: 305, y: 3 });
    expect(g.domain).toEqual([0, 1000]);
    expect(g.min).toBe(0);
    expect(g.max).toBe(1000);
    expect(g.last).toBe(1000);
    expect(g.spanMs).toBe(120_000);
  });

  it("places points by time, not by index", () => {
    const g = sparkGeometry(
      { timesMs: [0, 9 * 60_000, 10 * 60_000], values: [0, 1000, 1000] },
      BOX,
      30,
    );
    // 9 of 10 minutes across a 302px inner width.
    expect(g?.d).toContain("L274.8 3");
  });

  it("skips NaN points and still draws the rest", () => {
    const g = sparkGeometry({ timesMs: minutes(4), values: [0, Number.NaN, 600, 1000] }, BOX, 30);
    expect(g?.d.split("L")).toHaveLength(3);
  });

  it("keeps its vertical scale when a new point lands inside it", () => {
    const before = sparkGeometry(
      { timesMs: minutes(4), values: [3200, 6100, 9400, 10_100] },
      BOX,
      30,
    );
    const after = sparkGeometry(
      { timesMs: minutes(5), values: [3200, 6100, 9400, 10_100, 10_400] },
      BOX,
      30,
    );
    expect(before?.domain).toEqual([3000, 11_000]);
    expect(after?.domain).toEqual(before?.domain);
    // So the first point is drawn at the same height in both.
    expect(after?.d.split("L")[0]).toBe(before?.d.split("L")[0]);
  });

  it("writes plain numbers with at most one decimal", () => {
    const g = sparkGeometry(
      { timesMs: [0, 7, 13], values: [1, 2.333, 3.7] },
      { width: 100, height: 10, pad: 0 },
      0.1,
    );
    expect(g?.d).toMatch(/^M[\d.]+ [\d.]+(L[\d.]+ [\d.]+)+$/);
    expect(g?.d).not.toMatch(/\.\d\d/);
  });
});

describe("sparkScale and sparkWords", () => {
  const climb = {
    timesMs: minutes(24),
    values: Array.from({ length: 24 }, (_, i) => 3200 + i * 340),
  };

  it("labels aircraft altitude with the recorded span, in the readout's unit", () => {
    const g = sparkGeometry(climb, BOX, 30);
    if (!g) throw new Error("expected a line");
    const metres = sparkWords(g, sparkScale("altitude", "aircraft", "m"));
    expect(metres.lead).toBe("Altitude, last");
    expect(metres.span).toEqual({ value: 23, unit: "min" });
    expect(metres.range).toEqual({ low: "3,200", high: "11,020" });
    expect(metres.unit).toBe("m");
    expect(metres.description).toBe(
      "Altitude over the last 23 minutes: between 3,200 and 11,020 metres, currently 11,020.",
    );
    const feet = sparkWords(g, sparkScale("altitude", "aircraft", "ft"));
    expect(feet.range).toEqual({ low: "10,499", high: "36,155" });
    expect(feet.unit).toBe("ft");
  });

  it("labels ship speed in knots", () => {
    const g = sparkGeometry(
      { timesMs: minutes(11), values: [5, 5.2, 5.6, 6, 6.4, 6.6, 6.7, 6.7, 6.8, 6.8, 6.9] },
      BOX,
      0.25,
    );
    if (!g) throw new Error("expected a line");
    const words = sparkWords(g, sparkScale("speed", "ships"));
    expect(words.lead).toBe("Speed, last");
    expect(words.span).toEqual({ value: 10, unit: "min" });
    expect(words.range).toEqual({ low: "9.7", high: "13.4" });
    expect(words.unit).toBe("kt");
  });

  it("calls a satellite's series one orbit, with no span", () => {
    const g = sparkGeometry(
      {
        timesMs: minutes(92),
        values: minutes(92).map((_, i) => 415_000 + 4000 * Math.sin(i / 14.6)),
      },
      BOX,
      1000,
    );
    if (!g) throw new Error("expected a line");
    const words = sparkWords(g, sparkScale("altitude", "satellites"));
    expect(words.lead).toBe("Altitude over one orbit");
    expect(words.span).toBeNull();
    expect(words.unit).toBe("km");
    expect(words.range).toEqual({ low: "411", high: "419" });
    expect(
      words.description.startsWith("Altitude over one orbit: between 411 and 419 kilometres"),
    ).toBe(true);
  });

  it("does not draw a geostationary satellite, whose altitude barely moves", () => {
    const flat = {
      timesMs: minutes(10),
      values: minutes(10).map((_, i) => 35_786_000 + (i % 2) * 400),
    };
    expect(sparkGeometry(flat, BOX, sparkScale("altitude", "satellites").minRange)).toBeNull();
  });
});
