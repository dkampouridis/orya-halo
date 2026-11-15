import { describe, expect, it } from "vite-plus/test";
import { piecesOf, preparePaths } from "./paths.ts";
import type { PreparedPaths } from "./paths.ts";

const DEG = Math.PI / 180;

/** Vertices of piece `i` as arrays of numbers. */
function piece(p: PreparedPaths, i: number): number[][] {
  const total = p.positions.length / p.size;
  const from = p.startIndices[i];
  const to = i + 1 < p.length ? p.startIndices[i + 1] : total;
  const out: number[][] = [];
  for (let v = from; v < to; v++)
    out.push(Array.from(p.positions.subarray(v * p.size, (v + 1) * p.size)));
  return out;
}

/** Largest longitude step between neighbouring vertices of any piece. */
function largestLonStep(p: PreparedPaths): number {
  let worst = 0;
  for (let i = 0; i < p.length; i++) {
    const v = piece(p, i);
    for (let k = 1; k < v.length; k++) worst = Math.max(worst, Math.abs(v[k][0] - v[k - 1][0]));
  }
  return worst;
}

function arcDeg(a: number[], b: number[]): number {
  const h =
    Math.sin(((b[1] - a[1]) * DEG) / 2) ** 2 +
    Math.cos(a[1] * DEG) * Math.cos(b[1] * DEG) * Math.sin(((b[0] - a[0]) * DEG) / 2) ** 2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(h)))) / DEG;
}

describe("preparePaths", () => {
  it("leaves a short path as it is", () => {
    const p = preparePaths([10, 50, 10.5, 50.2, 11, 50.1], 2, [0, 3], 1);
    expect(p.length).toBe(1);
    expect(Array.from(p.owners)).toEqual([0]);
    expect(piece(p, 0)).toEqual([
      [10, Math.fround(50)],
      [10.5, Math.fround(50.2)],
      [11, Math.fround(50.1)],
    ]);
  });

  it("cuts a path at the antimeridian instead of going the long way round", () => {
    // Eastwards across the line: +179.5 to -179.5 is one degree, not 359.
    const p = preparePaths([179.5, 10, -179.5, 12], 2, [0, 2], 1);
    expect(p.length).toBe(2);
    expect(Array.from(p.owners)).toEqual([0, 0]);
    const [west, east] = [piece(p, 0), piece(p, 1)];
    expect(west.at(-1)?.[0]).toBe(180);
    expect(east[0][0]).toBe(-180);
    // Both sides of the cut are the same place.
    expect(west.at(-1)?.[1]).toBeCloseTo(east[0][1], 5);
    expect(west.at(-1)?.[1]).toBeCloseTo(11, 1);
    expect(east.at(-1)).toEqual([-179.5, 12]);
    expect(largestLonStep(p)).toBeLessThan(1.01);
  });

  it("cuts westwards crossings too, and carries altitude across the cut", () => {
    const p = preparePaths([-179, 0, 400_000, 179, 0, 420_000], 3, [0], 1);
    expect(p.length).toBe(2);
    expect(piece(p, 0).at(-1)).toEqual([-180, 0, 410_000]);
    expect(piece(p, 1)[0]).toEqual([180, 0, 410_000]);
  });

  it("handles an orbit track that crosses the line several times", () => {
    // Two and a bit revolutions of a 53 degree orbit, sampled every 4 degrees
    // of travel, with longitudes folded the way the worker sends them.
    const positions: number[] = [];
    for (let k = 0; k <= 200; k++) {
      const u = k * 4 * DEG;
      const lat = Math.asin(Math.sin(53 * DEG) * Math.sin(u)) / DEG;
      const lon = Math.atan2(Math.cos(53 * DEG) * Math.sin(u), Math.cos(u)) / DEG - k * 0.25;
      positions.push(((((lon + 180) % 360) + 360) % 360) - 180, lat, 550_000);
    }
    const p = preparePaths(positions, 3, [0], 1);
    expect(p.length).toBeGreaterThanOrEqual(3);
    // No stroke anywhere longer than the densifying step allows.
    expect(largestLonStep(p)).toBeLessThan(4);
    for (let i = 0; i < p.length; i++) {
      const v = piece(p, i);
      for (let k = 1; k < v.length; k++) expect(arcDeg(v[k - 1], v[k])).toBeLessThan(1.01);
      for (const vertex of v) {
        expect(Math.abs(vertex[0])).toBeLessThanOrEqual(180);
        expect(vertex[2]).toBe(550_000);
      }
    }
  });

  it("follows the great circle across a long segment", () => {
    // London to Tokyo in one segment: the great circle goes far north of both.
    const p = preparePaths([0, 51.5, 139.7, 35.6], 2, [0, 2], 1);
    expect(p.length).toBe(1);
    const v = piece(p, 0);
    expect(v.length).toBeGreaterThan(80);
    expect(Math.max(...v.map((x) => x[1]))).toBeGreaterThan(65);
    for (let k = 1; k < v.length; k++) expect(arcDeg(v[k - 1], v[k])).toBeLessThan(1.01);
    expect(v[0]).toEqual([0, 51.5]);
    expect(v.at(-1)?.[0]).toBeCloseTo(139.7, 4);
    expect(v.at(-1)?.[1]).toBeCloseTo(35.6, 4);
  });

  it("keeps several paths apart and remembers which piece belongs to which", () => {
    const positions = [
      // 0: plain
      0, 0, 0.5, 0,
      // 1: crosses the line
      179.8, -20, -179.8, -20,
      // 2: plain
      30, 10, 30.4, 10.2, 30.8, 10.4,
    ];
    const p = preparePaths(positions, 2, [0, 2, 4, 7], 3);
    expect(Array.from(p.owners)).toEqual([0, 1, 1, 2]);
    expect(piece(p, 3).length).toBe(3);

    const crossing = piecesOf(p, 1);
    expect(crossing.length).toBe(2);
    expect(Array.from(crossing.startIndices)).toEqual([0, 2]);
    expect(crossing.positions.length).toBe(8);
    expect(piecesOf(p, 9).length).toBe(0);
  });

  it("accepts longitudes outside -180..180 and vertices that sit on the line", () => {
    const p = preparePaths([181, 5, 182, 5], 2, [0, 2], 1);
    expect(p.length).toBe(1);
    expect(piece(p, 0)).toEqual([
      [-179, 5],
      [-178, 5],
    ]);

    const onLine = preparePaths([179, 0, 180, 0, -179, 0], 2, [0, 3], 1);
    expect(largestLonStep(onLine)).toBeLessThan(1.01);
    const all = Array.from({ length: onLine.length }, (_, i) => piece(onLine, i)).flat();
    expect(all.at(-1)).toEqual([-179, 0]);
  });

  it("drops paths too short to draw and skips broken vertices", () => {
    const p = preparePaths([5, 5, 6, 6, Number.NaN, 7, 6.5, 6.5], 2, [0, 1, 4], 2);
    expect(p.length).toBe(1);
    expect(Array.from(p.owners)).toEqual([1]);
    expect(piece(p, 0).length).toBe(2);
  });

  it("copes with an empty set", () => {
    const p = preparePaths(new Float32Array(0), 2, new Uint32Array([0]), 0);
    expect(p.length).toBe(0);
    expect(p.positions.length).toBe(0);
  });
});
