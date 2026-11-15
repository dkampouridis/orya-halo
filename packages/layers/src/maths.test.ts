import { BLEND_SECONDS, EARTH_RADIUS_M } from "@orya-halo/schema";
import { describe, expect, it } from "vite-plus/test";
import {
  DECK_EARTH_RADIUS_M,
  GLOBE_RADIUS,
  farness,
  globeCommon,
  haloVisibility,
  headingProbeDegrees,
  quakeRadiusPx,
  sizeAtZoom,
} from "./maths.ts";
import { markersVS } from "./markers/markers-shaders.ts";
import { moversVS } from "./movers/movers-shaders.ts";

describe("globeCommon", () => {
  it("matches deck.gl's globe frame", () => {
    // Longitude 0 on the equator faces -y; the north pole is +z; 90 east is +x.
    const [x0, y0, z0] = globeCommon(0, 0);
    expect(x0).toBeCloseTo(0, 9);
    expect(y0).toBeCloseTo(-GLOBE_RADIUS, 9);
    expect(z0).toBeCloseTo(0, 9);
    expect(globeCommon(0, 90)[2]).toBeCloseTo(GLOBE_RADIUS, 9);
    expect(globeCommon(90, 0)[0]).toBeCloseTo(GLOBE_RADIUS, 9);
  });

  it("lifts altitude along the radius", () => {
    const p = globeCommon(35, -20, DECK_EARTH_RADIUS_M);
    expect(Math.hypot(p[0], p[1], p[2])).toBeCloseTo(2 * GLOBE_RADIUS, 6);
  });
});

describe("haloVisibility", () => {
  // A camera three radii out, above longitude 0 on the equator.
  const camera = globeCommon(0, 0, 2 * DECK_EARTH_RADIUS_M);

  it("shows the near side and hides the far side", () => {
    expect(haloVisibility(camera, globeCommon(0, 0))).toBe(1);
    expect(haloVisibility(camera, globeCommon(30, 20))).toBe(1);
    expect(haloVisibility(camera, globeCommon(180, 0))).toBe(0);
    expect(haloVisibility(camera, globeCommon(120, 0))).toBe(0);
  });

  it("turns over at the geometric horizon", () => {
    // From three radii the horizon is acos(1/3) = 70.53 degrees away.
    expect(haloVisibility(camera, globeCommon(70, 0))).toBe(1);
    expect(haloVisibility(camera, globeCommon(70.5, 0))).toBe(1);
    expect(haloVisibility(camera, globeCommon(72.2, 0))).toBeGreaterThan(0);
    expect(haloVisibility(camera, globeCommon(72.2, 0))).toBeLessThan(1);
    expect(haloVisibility(camera, globeCommon(74, 0))).toBe(0);
  });

  it("keeps a satellite visible past the surface horizon, until the planet covers it", () => {
    const leo = 550_000;
    expect(haloVisibility(camera, globeCommon(85, 0, leo))).toBe(1);
    expect(haloVisibility(camera, globeCommon(85, 0))).toBe(0);
    expect(haloVisibility(camera, globeCommon(170, 0, leo))).toBe(0);
    // Geostationary height on the far side, clear of the disc.
    expect(haloVisibility(camera, globeCommon(150, 0, 35_786_000))).toBe(1);
    // Directly behind the planet it is eclipsed.
    expect(haloVisibility(camera, globeCommon(180, 0, 35_786_000))).toBe(0);
  });

  it("never hides something between the camera and the planet", () => {
    expect(haloVisibility(camera, globeCommon(0, 0, DECK_EARTH_RADIUS_M))).toBe(1);
  });
});

describe("sizeAtZoom", () => {
  it("clamps at both ends of the range", () => {
    expect(sizeAtZoom(0, [2, 8], [3, 9])).toBe(3);
    expect(sizeAtZoom(20, [2, 8], [3, 9])).toBe(9);
  });

  it("ramps linearly by default", () => {
    expect(sizeAtZoom(5, [2, 8], [3, 9])).toBeCloseTo(6, 12);
  });

  it("holds small for longer with an ease above 1", () => {
    expect(sizeAtZoom(5, [2, 8], [3, 9], 2)).toBeCloseTo(4.5, 12);
    expect(sizeAtZoom(8, [2, 8], [3, 9], 2)).toBe(9);
  });
});

describe("headingProbeDegrees", () => {
  it("halves with every zoom level, staying about six pixels long", () => {
    expect(headingProbeDegrees(3) / headingProbeDegrees(4)).toBeCloseTo(2, 12);
    // deck.gl draws 512 * 2^zoom pixels per 360 degrees at the equator.
    for (const zoom of [0, 5, 12, 18]) {
      const pixels = (headingProbeDegrees(zoom) / 360) * 512 * 2 ** zoom;
      expect(pixels).toBeCloseTo(6, 9);
    }
  });
});

describe("quakeRadiusPx", () => {
  it("grows with magnitude between a floor and a ceiling", () => {
    expect(quakeRadiusPx(0)).toBe(4);
    expect(quakeRadiusPx(4.5)).toBeGreaterThan(quakeRadiusPx(3));
    expect(quakeRadiusPx(6.5)).toBeGreaterThan(quakeRadiusPx(4.5));
    expect(quakeRadiusPx(9.5)).toBe(30);
  });

  it("is the formula the markers shader uses", () => {
    expect(markersVS).toContain("clamp(5.0 + (instanceValues - 2.5) * 4.2, 4.0, 30.0)");
    expect(quakeRadiusPx(5)).toBeCloseTo(5 + 2.5 * 4.2, 12);
  });
});

describe("movers vertex shader", () => {
  it("takes its dead-reckoning constants from the schema, like extrapolate()", () => {
    expect(moversVS).toContain(`EARTH_RADIUS_M = ${EARTH_RADIUS_M.toFixed(1)}`);
    expect(moversVS).toContain(`BLEND_SECONDS = ${BLEND_SECONDS.toFixed(4)}`);
  });

  it("eases the blend offset with the same smoothstep as extrapolate()", () => {
    expect(moversVS).toContain("1.0 - x * x * (3.0 - 2.0 * x)");
  });
});

describe("farness", () => {
  it("is 1 from orbit, 0 close in, and eased in between", () => {
    expect(farness(1, [2.2, 4.4])).toBe(1);
    expect(farness(2.2, [2.2, 4.4])).toBe(1);
    expect(farness(4.4, [2.2, 4.4])).toBe(0);
    expect(farness(9, [2.2, 4.4])).toBe(0);
    expect(farness(3.3, [2.2, 4.4])).toBeCloseTo(0.5, 12);
    expect(farness(2.5, [2.2, 4.4])).toBeGreaterThan(farness(3, [2.2, 4.4]));
  });

  it("is never on for a layer that keeps its glyphs at every zoom", () => {
    expect(farness(0, null)).toBe(0);
  });
});

describe("far view and zoom rank in the shaders", () => {
  it("ranks objects by their id, so brightness does not flicker between batches", () => {
    expect(moversVS).toContain("halo_rank(instanceIdBytes)");
  });

  it("gives an emergency its full glyph at any zoom", () => {
    expect(moversVS).toContain("float far = emergency ? 0.0 : movers.far;");
  });

  it("hides a mark below its zoom rank rather than drawing it faint", () => {
    expect(markersVS).toContain("smoothstep(instanceValues - 0.5, instanceValues, markers.zoom)");
  });
});
