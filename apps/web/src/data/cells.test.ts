import { describe, expect, test } from "vite-plus/test";
import { getResolution, isValidCell, latLngToCell } from "h3-js";
import type { ViewState } from "@orya-halo/schema";
import { cellsForView, coverBounds, resolutionForView } from "./cells.ts";
import { seededRandom } from "./synthetic.ts";

function view(bounds: [number, number, number, number], zoom: number, global = false): ViewState {
  const [west, south, east, north] = bounds;
  const width = east >= west ? east - west : east + 360 - west;
  return {
    lon: west + width / 2,
    lat: (south + north) / 2,
    zoom,
    bearing: 0,
    pitch: 0,
    bounds,
    global,
  };
}

/** Random points inside bounds (which may cross the antimeridian) must all fall in covered cells. */
function expectCovered(
  bounds: [number, number, number, number],
  res: number,
  cells: string[],
  seed = 1,
): void {
  const set = new Set(cells);
  const random = seededRandom(seed);
  const [west, south, east, north] = bounds;
  const width = east >= west ? east - west : east + 360 - west;
  for (let i = 0; i < 4000; i++) {
    let lon = west + random() * width;
    if (lon > 180) lon -= 360;
    const lat = south + random() * (north - south);
    const cell = latLngToCell(lat, lon, res);
    if (!set.has(cell))
      throw new Error(
        `Point ${lon.toFixed(3)}, ${lat.toFixed(3)} is in ${cell}, which is not covered`,
      );
  }
  // Corners and edge midpoints: where a cover is most likely to fall short.
  for (const fx of [0, 0.5, 1]) {
    for (const fy of [0, 0.5, 1]) {
      let lon = west + fx * width;
      if (lon > 180) lon -= 360;
      expect(set.has(latLngToCell(south + fy * (north - south), lon, res))).toBe(true);
    }
  }
}

describe("resolutionForView", () => {
  test("goes finer as the camera comes down", () => {
    expect(resolutionForView({ zoom: 1.5, global: false })).toBe(0);
    expect(resolutionForView({ zoom: 3.5, global: false })).toBe(1);
    expect(resolutionForView({ zoom: 5, global: false })).toBe(2);
    expect(resolutionForView({ zoom: 6, global: false })).toBe(3);
    expect(resolutionForView({ zoom: 12, global: false })).toBe(3);
  });

  test("a global view is the whole world whatever the zoom says", () => {
    expect(resolutionForView({ zoom: 7, global: true })).toBe(0);
    expect(resolutionForView({ zoom: Number.NaN, global: false })).toBe(0);
  });
});

describe("coverBounds", () => {
  test("covers a city-scale box at resolution 3", () => {
    const bounds: [number, number, number, number] = [-1.5, 50.8, 1.2, 52.1];
    const cells = coverBounds(bounds, 3);
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.length).toBeLessThan(120);
    for (const cell of cells) {
      expect(isValidCell(cell)).toBe(true);
      expect(getResolution(cell)).toBe(3);
    }
    expectCovered(bounds, 3, cells);
  });

  test("returns sorted, unique cells so equal views give equal subscriptions", () => {
    const cells = coverBounds([10, 40, 20, 48], 2);
    expect(cells).toEqual([...new Set(cells)].sort());
    expect(coverBounds([10, 40, 20, 48], 2)).toEqual(cells);
  });

  test("covers a box across the antimeridian without wrapping the long way", () => {
    // Fiji to Samoa: west is greater than east.
    const bounds: [number, number, number, number] = [172, -22, -168, -8];
    const cells = coverBounds(bounds, 2);
    expectCovered(bounds, 2, cells, 3);
    // The same span the wrong way round would be seventeen times wider.
    expect(cells.length).toBeLessThan(coverBounds([-168, -22, 172, -8], 2).length / 4);
    // Nothing from the far side of the world.
    expect(new Set(cells).has(latLngToCell(-15, 0, 2))).toBe(false);
  });

  test("covers a view that contains the north pole", () => {
    const bounds: [number, number, number, number] = [-180, 72, 180, 90];
    const cells = coverBounds(bounds, 2);
    expectCovered(bounds, 2, cells, 5);
    expect(new Set(cells).has(latLngToCell(90, 0, 2))).toBe(true);
  });

  test("covers a view that contains the south pole at every resolution", () => {
    const bounds: [number, number, number, number] = [-180, -90, 180, -78];
    for (const res of [1, 2, 3]) {
      const cells = coverBounds(bounds, res);
      expectCovered(bounds, res, cells, 7 + res);
      expect(new Set(cells).has(latLngToCell(-90, 0, res))).toBe(true);
    }
  });

  test("covers a wide box at resolution 1", () => {
    const bounds: [number, number, number, number] = [-130, 10, -50, 60];
    expectCovered(bounds, 1, coverBounds(bounds, 1), 9);
  });

  test("includes a margin beyond the box", () => {
    const set = new Set(coverBounds([0, 0, 2, 2], 3));
    // Half a degree outside every edge is still subscribed.
    for (const [lon, lat] of [
      [-0.5, 1],
      [2.5, 1],
      [1, -0.5],
      [1, 2.5],
    ]) {
      expect(set.has(latLngToCell(lat, lon, 3))).toBe(true);
    }
  });

  test("refuses bounds that are not numbers", () => {
    expect(coverBounds([Number.NaN, 0, 1, 1], 2)).toEqual([]);
  });
});

describe("cellsForView", () => {
  test("uses resolution 3 for a regional view", () => {
    const cover = cellsForView(view([2, 47, 9, 51], 7), 2000);
    expect(cover.res).toBe(3);
    expectCovered([2, 47, 9, 51], 3, cover.cells);
  });

  test("subscribes to the whole world when the view is global", () => {
    expect(cellsForView(view([-180, -90, 180, 90], 1.2, true), 2000)).toEqual({
      res: 0,
      cells: [],
    });
  });

  test("coarsens when the finest resolution would exceed the server's limit", () => {
    const bounds: [number, number, number, number] = [-30, 20, 40, 65];
    // A pitched camera at zoom 6.5 can see this much; far too many res-3 cells.
    const cover = cellsForView(view(bounds, 6.5), 2000);
    expect(cover.res).toBe(2);
    expect(cover.cells.length).toBeLessThanOrEqual(2000);
    expectCovered(bounds, 2, cover.cells);
  });

  test("keeps coarsening down to the whole world for a tiny limit", () => {
    const bounds: [number, number, number, number] = [-30, 20, 40, 65];
    const cover = cellsForView(view(bounds, 6.5), 150);
    expect(cover.res).toBe(1);
    expect(cover.cells.length).toBeLessThanOrEqual(150);
    expect(cellsForView(view(bounds, 6.5), 5)).toEqual({ res: 0, cells: [] });
  });

  test("never returns more cells than allowed", () => {
    const random = seededRandom(21);
    for (let i = 0; i < 60; i++) {
      const west = random() * 360 - 180;
      const width = 1 + random() * 120;
      const south = random() * 150 - 80;
      const north = Math.min(90, south + 1 + random() * 60);
      let east = west + width;
      if (east > 180) east -= 360;
      const bounds: [number, number, number, number] = [west, south, east, north];
      const zoom = 3 + random() * 6;
      const cover = cellsForView(view(bounds, zoom), 500);
      expect(cover.cells.length).toBeLessThanOrEqual(500);
      expect(cover.res).toBeLessThanOrEqual(resolutionForView({ zoom, global: false }));
      if (cover.res > 0) expectCovered(bounds, cover.res, cover.cells, i);
    }
  });

  test("falls back to the whole world when the bounds are unusable", () => {
    expect(cellsForView(view([Number.NaN, 0, 0, 0], 8), 2000)).toEqual({ res: 0, cells: [] });
  });
});
