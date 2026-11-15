import { describe, expect, test } from "vite-plus/test";
import {
  densifyLine,
  haversineKm,
  lineLengthKm,
  mergeLines,
  simplifyLine,
  splitAtAntimeridian,
  wrapLon,
} from "./geometry.ts";
import type { LonLat } from "./geometry.ts";

describe("length", () => {
  test("one degree of longitude on the equator is about 111.2 km", () => {
    expect(haversineKm([0, 0], [1, 0])).toBeCloseTo(111.195, 2);
  });

  test("measures across the antimeridian the short way", () => {
    expect(haversineKm([179.5, 0], [-179.5, 0])).toBeCloseTo(111.195, 2);
  });

  test("adds up the segments of a line", () => {
    expect(
      lineLengthKm([
        [0, 0],
        [1, 0],
        [1, 1],
      ]),
    ).toBeCloseTo(111.195 * 2, 1);
    expect(lineLengthKm([[5, 5]])).toBe(0);
  });
});

describe("simplifyLine", () => {
  test("drops vertices closer to the line than the tolerance and keeps the ends", () => {
    // 0.0005 degrees is about 55 m off the straight line.
    const line: LonLat[] = [
      [0, 0],
      [0.5, 0.0005],
      [1, 0],
    ];
    expect(simplifyLine(line, 150)).toEqual([
      [0, 0],
      [1, 0],
    ]);
  });

  test("keeps a vertex that is further away than the tolerance", () => {
    // 0.01 degrees is about 1.1 km.
    const line: LonLat[] = [
      [0, 0],
      [0.5, 0.01],
      [1, 0],
    ];
    expect(simplifyLine(line, 150)).toEqual(line);
  });

  test("works the same at high latitude, where a degree of longitude is short", () => {
    // At 80 N, 0.005 degrees of longitude is under 100 m.
    const line: LonLat[] = [
      [20, 80],
      [20.005, 80.5],
      [20, 81],
    ];
    expect(simplifyLine(line, 150)).toHaveLength(2);
  });

  test("returns a copy, not the input", () => {
    const line: LonLat[] = [
      [0, 0],
      [1, 1],
    ];
    const out = simplifyLine(line, 150);
    expect(out).toEqual(line);
    expect(out[0]).not.toBe(line[0]);
  });
});

describe("densifyLine", () => {
  test("leaves no segment longer than the limit and keeps the original vertices", () => {
    const out = densifyLine(
      [
        [-40, 40],
        [-10, 50],
      ],
      1,
    );
    expect(out[0]).toEqual([-40, 40]);
    expect(out[out.length - 1]).toEqual([-10, 50]);
    for (let i = 1; i < out.length; i++) {
      expect(haversineKm(out[i - 1], out[i])).toBeLessThanOrEqual(111.3);
    }
    expect(out.length).toBeGreaterThan(20);
  });

  test("follows the great circle, which bows towards the pole", () => {
    const out = densifyLine(
      [
        [-60, 45],
        [0, 45],
      ],
      1,
    );
    const middle = out[Math.floor(out.length / 2)];
    expect(middle[0]).toBeCloseTo(-30, 0);
    expect(middle[1]).toBeGreaterThan(48);
  });

  test("leaves short segments alone", () => {
    const line: LonLat[] = [
      [10, 10],
      [10.2, 10.1],
    ];
    expect(densifyLine(line, 1)).toEqual(line);
  });
});

describe("wrapLon", () => {
  test("brings longitudes into -180..180", () => {
    expect(wrapLon(190)).toBe(-170);
    expect(wrapLon(-190)).toBe(170);
    expect(wrapLon(180)).toBe(180);
    expect(wrapLon(-180)).toBe(-180);
    expect(wrapLon(540)).toBe(180);
  });
});

describe("splitAtAntimeridian", () => {
  test("leaves a line that does not cross alone", () => {
    const line: LonLat[] = [
      [10, 0],
      [20, 5],
      [30, 10],
    ];
    expect(splitAtAntimeridian(line)).toEqual([line]);
  });

  test("cuts an eastbound crossing and meets the edge at the right latitude", () => {
    const parts = splitAtAntimeridian([
      [170, 0],
      [-170, 20],
    ]);
    expect(parts).toEqual([
      [
        [170, 0],
        [180, 10],
      ],
      [
        [-180, 10],
        [-170, 20],
      ],
    ]);
  });

  test("cuts a westbound crossing", () => {
    const parts = splitAtAntimeridian([
      [-175, 10],
      [175, 10],
      [170, 12],
    ]);
    expect(parts).toEqual([
      [
        [-175, 10],
        [-180, 10],
      ],
      [
        [180, 10],
        [175, 10],
        [170, 12],
      ],
    ]);
  });

  test("cuts every crossing of a line that goes back and forth", () => {
    const parts = splitAtAntimeridian([
      [178, 0],
      [-178, 0],
      [178, 2],
    ]);
    expect(parts).toHaveLength(3);
    expect(parts[1][0][0]).toBe(-180);
    expect(parts[1][parts[1].length - 1][0]).toBe(-180);
  });

  test("never leaves a jump of more than 180 degrees inside a piece", () => {
    const pacific = densifyLine(
      [
        [140, 35],
        [-122, 37],
      ],
      1,
    );
    const parts = splitAtAntimeridian(pacific);
    expect(parts).toHaveLength(2);
    for (const part of parts) {
      for (let i = 1; i < part.length; i++)
        expect(Math.abs(part[i][0] - part[i - 1][0])).toBeLessThan(180);
    }
    expect(parts[0][parts[0].length - 1][0]).toBe(180);
    expect(parts[1][0][0]).toBe(-180);
    expect(parts[1][0][1]).toBeCloseTo(parts[0][parts[0].length - 1][1], 10);
  });

  test("does not duplicate a vertex that sits exactly on the edge", () => {
    const parts = splitAtAntimeridian([
      [170, 0],
      [180, 5],
      [-170, 10],
    ]);
    expect(parts).toEqual([
      [
        [170, 0],
        [180, 5],
      ],
      [
        [-180, 5],
        [-170, 10],
      ],
    ]);
  });
});

describe("mergeLines", () => {
  test("joins lines end to end, reversing where needed", () => {
    const merged = mergeLines([
      [
        [0, 0],
        [1, 0],
      ],
      [
        [2, 0],
        [1, 0],
      ],
      [
        [2, 0],
        [3, 0],
      ],
    ]);
    expect(merged).toEqual([
      [
        [0, 0],
        [1, 0],
        [2, 0],
        [3, 0],
      ],
    ]);
  });

  test("extends backwards from the first line too", () => {
    const merged = mergeLines([
      [
        [1, 0],
        [2, 0],
      ],
      [
        [0, 0],
        [1, 0],
      ],
    ]);
    expect(merged).toEqual([
      [
        [0, 0],
        [1, 0],
        [2, 0],
      ],
    ]);
  });

  test("keeps separate lines separate", () => {
    const merged = mergeLines([
      [
        [0, 0],
        [1, 0],
      ],
      [
        [5, 5],
        [6, 5],
      ],
    ]);
    expect(merged).toHaveLength(2);
  });

  test("does not guess at a three-way junction", () => {
    const merged = mergeLines([
      [
        [0, 0],
        [1, 0],
      ],
      [
        [1, 0],
        [2, 1],
      ],
      [
        [1, 0],
        [2, -1],
      ],
    ]);
    // The trunk stops at the branching unit; the two branches join through it.
    expect(merged).toHaveLength(2);
    expect(merged.reduce((sum, line) => sum + line.length, 0)).toBe(5);
  });

  test("ignores degenerate input", () => {
    expect(mergeLines([[[0, 0]], []])).toEqual([]);
  });
});
