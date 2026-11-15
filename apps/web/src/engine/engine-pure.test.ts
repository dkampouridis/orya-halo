import type { TileOverlay } from "@orya-halo/schema";
import { describe, expect, it } from "vite-plus/test";
import { routeTile, joinAsset } from "./map/tiles.ts";
import { angularDistance, invert4, wrapLon } from "./maths.ts";
import { overlayTiles, selectFrame } from "./overlays.ts";
import { QUALITY, QualityGovernor, lowerTier } from "./quality.ts";

describe("selectFrame", () => {
  const frames = [1000, 2000, 3000, 4000].map((timeMs) => ({ timeMs }));

  it("returns -1 without frames", () => {
    expect(selectFrame(undefined, 5)).toBe(-1);
    expect(selectFrame([], 5)).toBe(-1);
  });

  it("picks the nearest frame in time", () => {
    expect(selectFrame(frames, 1000)).toBe(0);
    expect(selectFrame(frames, 2400)).toBe(1);
    expect(selectFrame(frames, 2600)).toBe(2);
    expect(selectFrame(frames, 3999)).toBe(3);
  });

  it("clamps to the first and last frame outside the range", () => {
    expect(selectFrame(frames, -50)).toBe(0);
    expect(selectFrame(frames, 99_999)).toBe(3);
  });

  it("prefers the earlier frame on an exact tie", () => {
    expect(selectFrame(frames, 2500)).toBe(1);
  });

  it("handles a single frame", () => {
    expect(selectFrame([{ timeMs: 7 }], 0)).toBe(0);
    expect(selectFrame([{ timeMs: 7 }], 70)).toBe(0);
  });

  it("scans long lists correctly", () => {
    const many = Array.from({ length: 1001 }, (_, i) => ({ timeMs: i * 600_000 }));
    expect(selectFrame(many, 600_000 * 512 + 100)).toBe(512);
    expect(selectFrame(many, 600_000 * 512 + 400_000)).toBe(513);
  });
});

describe("overlayTiles", () => {
  const base: TileOverlay = {
    tiles: ["still/{z}/{x}/{y}.png"],
    tileSize: 256,
    minZoom: 0,
    maxZoom: 7,
    opacity: 0.8,
  };

  it("uses the overlay's own tiles when it is a single image", () => {
    expect(overlayTiles(base, 123)).toEqual({ tiles: base.tiles, frame: -1 });
  });

  it("uses the frame nearest the clock when animated", () => {
    const animated: TileOverlay = {
      ...base,
      frames: [
        { timeMs: 0, tiles: ["a/{z}/{x}/{y}.png"] },
        { timeMs: 600_000, tiles: ["b/{z}/{x}/{y}.png"] },
      ],
    };
    expect(overlayTiles(animated, 100_000)).toEqual({ tiles: ["a/{z}/{x}/{y}.png"], frame: 0 });
    expect(overlayTiles(animated, 500_000)).toEqual({ tiles: ["b/{z}/{x}/{y}.png"], frame: 1 });
  });
});

describe("quality", () => {
  it("orders tiers from costly to cheap", () => {
    expect(lowerTier("high")).toBe("balanced");
    expect(lowerTier("balanced")).toBe("low");
    expect(lowerTier("low")).toBeNull();
    expect(QUALITY.high.maxPixelRatio).toBeGreaterThan(QUALITY.balanced.maxPixelRatio);
    expect(QUALITY.balanced.maxPixelRatio).toBeGreaterThan(QUALITY.low.maxPixelRatio);
    expect(QUALITY.low.tails).toBe(false);
  });

  it("steps down after sustained slow frames, not on a single dip", () => {
    const governor = new QualityGovernor({ minFps: 42, strikes: 3, graceWindows: 0 });
    expect(governor.sample(20, "high")).toBeNull();
    expect(governor.sample(60, "high")).toBeNull();
    expect(governor.sample(20, "high")).toBeNull();
    expect(governor.sample(20, "high")).toBeNull();
    expect(governor.sample(20, "high")).toBe("balanced");
  });

  it("ignores the first windows while the scene loads", () => {
    const governor = new QualityGovernor({ strikes: 1, graceWindows: 2 });
    expect(governor.sample(5, "high")).toBeNull();
    expect(governor.sample(5, "high")).toBeNull();
    expect(governor.sample(5, "high")).toBe("balanced");
  });

  it("gives the new tier time to settle before judging it", () => {
    const governor = new QualityGovernor({ strikes: 1, graceWindows: 1 });
    governor.sample(5, "high");
    expect(governor.sample(5, "high")).toBe("balanced");
    expect(governor.sample(5, "balanced")).toBeNull();
    expect(governor.sample(5, "balanced")).toBe("low");
  });

  it("has nowhere to go below the lowest tier", () => {
    const governor = new QualityGovernor({ strikes: 1, graceWindows: 0 });
    expect(governor.sample(5, "low")).toBeNull();
  });

  it("does not punish a display that only refreshes 30 times a second", () => {
    const governor = new QualityGovernor({ minFps: 42, strikes: 1, graceWindows: 0 });
    expect(governor.sample(30, "high", 30)).toBeNull();
    expect(governor.sample(15, "high", 30)).toBe("balanced");
  });
});

describe("maths", () => {
  it("wraps longitudes into -180..180", () => {
    expect(wrapLon(190)).toBe(-170);
    expect(wrapLon(-190)).toBe(170);
    expect(wrapLon(540)).toBe(-180);
    expect(wrapLon(12.5)).toBe(12.5);
  });

  it("measures great-circle angles", () => {
    expect(angularDistance(0, 0, 90, 0)).toBeCloseTo(Math.PI / 2, 12);
    expect(angularDistance(0, 0, 180, 0)).toBeCloseTo(Math.PI, 9);
    expect(angularDistance(10, 90, -120, 90)).toBeCloseTo(0, 9);
    expect(angularDistance(179, 0, -179, 0)).toBeCloseTo((2 * Math.PI) / 180, 12);
  });

  it("inverts a perspective view-projection matrix", () => {
    // A typical camera: perspective times a translation and a tilt.
    const m = [1.2, 0.1, 0, 0, -0.2, 1.7, 0.4, 0.4, 0.3, -0.5, -1.01, -1, 4, -3, 9.8, 10];
    const inv = new Float64Array(16);
    expect(invert4(m, inv)).toBe(true);
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) sum += m[k * 4 + row] * inv[col * 4 + k];
        expect(sum).toBeCloseTo(row === col ? 1 : 0, 10);
      }
    }
  });

  it("refuses a singular matrix", () => {
    expect(
      invert4(
        Array.from({ length: 16 }, () => 0),
        new Float64Array(16),
      ),
    ).toBe(false);
  });
});

describe("tile routing", () => {
  it("serves low zooms from the bundled extract and deep zooms from the configured source", () => {
    expect(routeTile(0, 5, "pmtiles")).toBe("local");
    expect(routeTile(5, 5, "pmtiles")).toBe("local");
    expect(routeTile(6, 5, "pmtiles")).toBe("pmtiles");
    expect(routeTile(12, 5, "api")).toBe("api");
  });

  it("has nothing past the extract when no deep source is configured", () => {
    expect(routeTile(3, 5, null)).toBe("local");
    expect(routeTile(6, 5, null)).toBe("none");
  });

  it("uses the deep source for everything when the extract is missing", () => {
    expect(routeTile(0, null, "api")).toBe("api");
    expect(routeTile(0, null, null)).toBe("none");
  });

  it("joins asset paths whatever the base looks like", () => {
    expect(joinAsset("/", "tiles/world.pmtiles")).toBe("/tiles/world.pmtiles");
    expect(joinAsset("/halo", "/tiles/world.pmtiles")).toBe("/halo/tiles/world.pmtiles");
    expect(joinAsset("https://cdn.example/app/", "textures/x.jpg")).toBe(
      "https://cdn.example/app/textures/x.jpg",
    );
  });
});
