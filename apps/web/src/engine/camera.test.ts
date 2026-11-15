import { EntityKind } from "@orya-halo/schema";
import { describe, expect, it } from "vite-plus/test";
import {
  FLY_MAX_MS,
  FLY_MIN_MS,
  approach,
  flyDurationMs,
  followCentre,
  framingZoom,
  globeFitsView,
  globeRadiusPx,
  normaliseBounds,
  orbitRate,
} from "./camera.ts";

describe("flyDurationMs", () => {
  const here = { lon: 0, lat: 0, zoom: 4 };

  it("is the minimum for a move that goes nowhere", () => {
    expect(flyDurationMs(here, here)).toBe(FLY_MIN_MS);
  });

  it("is the maximum for the far side of the planet", () => {
    expect(flyDurationMs(here, { lon: 180, lat: 0, zoom: 4 })).toBe(FLY_MAX_MS);
  });

  it("grows with distance and with zoom change, and never leaves 1.2 to 2.4 s", () => {
    const hop = flyDurationMs(here, { lon: 5, lat: 0, zoom: 4 });
    const haul = flyDurationMs(here, { lon: 60, lat: 20, zoom: 4 });
    const dive = flyDurationMs(here, { lon: 0, lat: 0, zoom: 12 });
    expect(hop).toBeGreaterThan(FLY_MIN_MS);
    expect(haul).toBeGreaterThan(hop);
    expect(dive).toBeGreaterThan(FLY_MIN_MS);
    for (const d of [hop, haul, dive, flyDurationMs(here, { lon: -170, lat: -80, zoom: 18 })]) {
      expect(d).toBeGreaterThanOrEqual(FLY_MIN_MS);
      expect(d).toBeLessThanOrEqual(FLY_MAX_MS);
    }
  });

  it("takes the short way across the antimeridian", () => {
    const across = flyDurationMs({ lon: 179, lat: 0, zoom: 4 }, { lon: -179, lat: 0, zoom: 4 });
    expect(across).toBeLessThan(FLY_MIN_MS + 50);
  });
});

describe("globeRadiusPx", () => {
  it("is half the Mercator world width over pi at the equator", () => {
    expect(globeRadiusPx(0, 0)).toBeCloseTo(256 / Math.PI, 9);
    expect(globeRadiusPx(3, 0)).toBeCloseTo((256 * 8) / Math.PI, 9);
  });

  it("grows by 1 / cos(latitude), as MapLibre's globe does", () => {
    expect(globeRadiusPx(2, 60) / globeRadiusPx(2, 0)).toBeCloseTo(2, 9);
  });

  it("stays finite at the poles", () => {
    expect(Number.isFinite(globeRadiusPx(2, 90))).toBe(true);
  });
});

describe("globeFitsView", () => {
  const screen = { width: 1400, height: 900, lat: 0, pitch: 0 };

  it("is true from orbit and false once the limb leaves the screen", () => {
    expect(globeFitsView({ ...screen, zoom: 1 })).toBe(true);
    // Worked by hand for a 900 px tall view: the limb touches the top edge between zoom 2.9 and 3.0.
    expect(globeFitsView({ ...screen, zoom: 2.9 })).toBe(true);
    expect(globeFitsView({ ...screen, zoom: 3.0 })).toBe(false);
    expect(globeFitsView({ ...screen, zoom: 8 })).toBe(false);
  });

  it("is limited by the narrow side of the viewport", () => {
    expect(globeFitsView({ ...screen, zoom: 2.5 })).toBe(true);
    expect(globeFitsView({ ...screen, zoom: 2.5, width: 390, height: 844 })).toBe(false);
  });

  it("accounts for the globe looking larger at high latitude", () => {
    expect(globeFitsView({ ...screen, zoom: 2.5, lat: 0 })).toBe(true);
    expect(globeFitsView({ ...screen, zoom: 2.5, lat: 70 })).toBe(false);
  });

  it("accounts for pitch pushing the planet down the screen", () => {
    expect(globeFitsView({ ...screen, zoom: 2.6, pitch: 0 })).toBe(true);
    expect(globeFitsView({ ...screen, zoom: 2.6, pitch: 55 })).toBe(false);
  });

  it("is never true in the flat street-level view", () => {
    expect(globeFitsView({ ...screen, zoom: 12.5 })).toBe(false);
  });

  it("copes with an empty container", () => {
    expect(globeFitsView({ ...screen, zoom: 1, width: 0, height: 0 })).toBe(false);
  });
});

describe("globeFitsView with padding", () => {
  const screen = { width: 1400, height: 900, lat: 0, pitch: 0 };
  const panel = { top: 0, bottom: 0, left: 0, right: 372 };

  it("is unchanged by padding that is the same on both sides", () => {
    const even = { top: 60, bottom: 60, left: 200, right: 200 };
    expect(globeFitsView({ ...screen, zoom: 2.9, padding: even })).toBe(true);
    expect(globeFitsView({ ...screen, zoom: 3.0, padding: even })).toBe(false);
  });

  it("is false once padding pushes the disc off the canvas", () => {
    // Radius 461 px at zoom 2.5: centred it clears a 1000 px wide canvas, but
    // a 372 px panel moves the centre 186 px left, to 314 px from the edge.
    const narrow = { ...screen, width: 1000, zoom: 2.5 };
    expect(globeFitsView(narrow)).toBe(true);
    expect(globeFitsView({ ...narrow, padding: panel })).toBe(false);
    // On a wide canvas the same push leaves room.
    expect(globeFitsView({ ...screen, width: 1600, zoom: 2.5, padding: panel })).toBe(true);
  });

  it("checks the top and the bottom separately", () => {
    // A phone sheet lifts the globe: it runs off the top long before the bottom.
    const phone = { width: 390, height: 844, lat: 0, pitch: 0, zoom: 1.2 };
    expect(globeFitsView(phone)).toBe(true);
    expect(globeFitsView({ ...phone, padding: { top: 0, bottom: 600, left: 0, right: 0 } })).toBe(
      false,
    );
  });
});

describe("followCentre", () => {
  it("looks straight at the object when the camera is not pitched", () => {
    expect(followCentre(12, 48, 11_000, 0, 30)).toEqual([12, 48]);
  });

  it("looks at the ground beyond a high object when pitched", () => {
    // 10 km up, pitched 45 degrees, facing north: 10 km further north.
    const [lon, lat] = followCentre(12, 48, 10_000, 45, 0);
    expect(lon).toBeCloseTo(12, 6);
    expect((lat - 48) * 111_195).toBeCloseTo(10_000, -2);
    // Facing east the shift is along the parallel instead.
    const [lonE, latE] = followCentre(12, 48, 10_000, 45, 90);
    expect(latE).toBeCloseTo(48, 2);
    expect((lonE - 12) * 111_195 * Math.cos((48 * Math.PI) / 180)).toBeCloseTo(10_000, -2);
  });

  it("does nothing for things on the surface", () => {
    expect(followCentre(-70, -33, 0, 60, 120)).toEqual([-70, -33]);
  });

  it("caps the shift for very high objects and stays on the map", () => {
    const [lon, lat] = followCentre(170, 60, 35_786_000, 70, 45);
    expect(Math.abs(lon)).toBeLessThanOrEqual(180);
    expect(lat).toBeLessThanOrEqual(85);
    // 2,500 km at most.
    const [, latN] = followCentre(0, 0, 35_786_000, 70, 0);
    expect(latN * 111_195).toBeLessThan(2_510_000);
  });
});

describe("approach", () => {
  it("halves the gap every half-life, at any frame rate", () => {
    expect(approach(0, 100, 200, 200)).toBeCloseTo(50, 9);
    let slow = 0;
    for (let i = 0; i < 4; i++) slow = approach(slow, 100, 50, 200);
    expect(slow).toBeCloseTo(50, 9);
  });

  it("lands on the target instead of creeping towards it for ever", () => {
    let x = 0;
    for (let i = 0; i < 400; i++) x = approach(x, 10, 16, 80);
    expect(x).toBe(10);
    expect(approach(3, 7, 16, 0)).toBe(7);
  });

  // A frame timestamp earlier than the clock's seed gives a negative step. It
  // used to push a padding inset easing from 0 to 240 below zero, which MapLibre
  // rejects from inside its render loop.
  it("never moves away from the target, whatever the step", () => {
    expect(approach(0, 240, -5, 90)).toBe(0);
    expect(approach(0, 240, 0, 90)).toBe(0);
    expect(approach(0, 240, Number.NaN, 90)).toBe(0);
    for (const dt of [1, 16, 100, 10_000]) {
      const next = approach(0, 240, dt, 90);
      expect(next).toBeGreaterThanOrEqual(0);
      expect(next).toBeLessThanOrEqual(240);
    }
  });
});

describe("normaliseBounds", () => {
  it("passes ordinary bounds through", () => {
    expect(normaliseBounds(-10, 35, 30, 60)).toEqual([-10, 35, 30, 60]);
  });

  it("wraps longitudes, leaving west greater than east across the antimeridian", () => {
    const [west, , east] = normaliseBounds(170, -10, 200, 10);
    expect(west).toBe(170);
    expect(east).toBe(-160);
    const [west2, , east2] = normaliseBounds(-200, -10, -170, 10);
    expect(west2).toBe(160);
    expect(east2).toBe(-170);
  });

  it("reports the full range when the view wraps the planet", () => {
    expect(normaliseBounds(-300, -80, 120, 80)).toEqual([-180, -80, 180, 80]);
    expect(normaliseBounds(-180, -90, 180, 90)).toEqual([-180, -90, 180, 90]);
  });

  it("clamps latitudes", () => {
    expect(normaliseBounds(0, -95, 10, 97)).toEqual([0, -90, 10, 90]);
  });

  it("treats non-finite input as the whole planet", () => {
    expect(normaliseBounds(Number.NaN, -10, 10, 10)).toEqual([-180, -10, 180, 10]);
  });
});

describe("framingZoom and orbitRate", () => {
  it("frames satellites from far out and webcams close in", () => {
    expect(framingZoom(EntityKind.Satellite)).toBeLessThan(framingZoom(EntityKind.Aircraft));
    expect(framingZoom(EntityKind.Aircraft)).toBeLessThan(framingZoom(EntityKind.Webcam));
  });

  it("orbits slowly, and slower still when zoomed in", () => {
    expect(orbitRate(1)).toBeGreaterThan(0);
    expect(orbitRate(1)).toBeLessThanOrEqual(2);
    expect(orbitRate(6)).toBeLessThan(orbitRate(3));
  });
});
