import { describe, expect, it } from "vite-plus/test";
import {
  NIGHT_FULL,
  NIGHT_START,
  nightFactor,
  subsolarPoint,
  sunDirection,
  sunElevationSine,
} from "./solar.ts";

const at = (iso: string): number => Date.parse(iso);

describe("subsolarPoint", () => {
  // Instants of the equinoxes and solstices as published by the US Naval Observatory.
  it("sits on the equator at the equinoxes", () => {
    expect(Math.abs(subsolarPoint(at("2024-03-20T03:06:00Z")).lat)).toBeLessThan(0.03);
    expect(Math.abs(subsolarPoint(at("2024-09-22T12:44:00Z")).lat)).toBeLessThan(0.03);
    expect(Math.abs(subsolarPoint(at("2026-03-20T14:46:00Z")).lat)).toBeLessThan(0.03);
  });

  it("reaches the tropics at the solstices", () => {
    expect(subsolarPoint(at("2024-06-20T20:51:00Z")).lat).toBeCloseTo(23.44, 1);
    expect(subsolarPoint(at("2023-12-22T03:27:00Z")).lat).toBeCloseTo(-23.44, 1);
    expect(subsolarPoint(at("2026-06-21T08:24:00Z")).lat).toBeCloseTo(23.44, 1);
  });

  it("follows the equation of time at Greenwich noon", () => {
    // At 12:00 UTC the sun is ahead of or behind the Greenwich meridian by the
    // equation of time, 15 degrees per hour: +16 min 27 s on 3 November puts
    // it 4.11 degrees west; -14 min 14 s on 11 February puts it 3.56 degrees east.
    expect(subsolarPoint(at("2024-11-03T12:00:00Z")).lon).toBeCloseTo(-4.11, 0);
    expect(Math.abs(subsolarPoint(at("2024-11-03T12:00:00Z")).lon + 4.11)).toBeLessThan(0.15);
    expect(Math.abs(subsolarPoint(at("2024-02-11T12:00:00Z")).lon - 3.56)).toBeLessThan(0.15);
    // Near the solstice the two clocks almost agree.
    expect(Math.abs(subsolarPoint(at("2024-06-13T12:00:00Z")).lon)).toBeLessThan(0.2);
  });

  it("moves west 15 degrees an hour and wraps at the antimeridian", () => {
    const noon = subsolarPoint(at("2024-06-13T12:00:00Z")).lon;
    const later = subsolarPoint(at("2024-06-13T18:00:00Z")).lon;
    expect(later - noon).toBeCloseTo(-90, 0);
    const midnight = subsolarPoint(at("2024-06-13T00:00:00Z")).lon;
    expect(Math.abs(midnight)).toBeGreaterThan(179);
    expect(Math.abs(midnight)).toBeLessThanOrEqual(180);
  });

  it("holds for a scrubbed moment decades away", () => {
    expect(Math.abs(subsolarPoint(at("1999-03-21T01:46:00Z")).lat)).toBeLessThan(0.05);
    expect(subsolarPoint(at("2040-06-20T21:46:00Z")).lat).toBeCloseTo(23.43, 1);
  });
});

describe("sunDirection", () => {
  it("is a unit vector in the globe frame, pointing at the subsolar point", () => {
    const t = at("2024-06-20T12:00:00Z");
    const [x, y, z] = sunDirection(t);
    expect(Math.hypot(x, y, z)).toBeCloseTo(1, 12);
    const sun = subsolarPoint(t);
    // y is the polar axis; z points at longitude 0 on the equator.
    expect(Math.asin(y) * (180 / Math.PI)).toBeCloseTo(sun.lat, 9);
    expect(Math.atan2(x, z) * (180 / Math.PI)).toBeCloseTo(sun.lon, 9);
  });
});

describe("sunElevationSine", () => {
  const t = at("2024-09-22T12:00:00Z");
  const sun = subsolarPoint(t);

  it("is 1 under the sun and -1 at its antipode", () => {
    expect(sunElevationSine(t, sun.lon, sun.lat)).toBeCloseTo(1, 9);
    expect(sunElevationSine(t, sun.lon + 180, -sun.lat)).toBeCloseTo(-1, 9);
  });

  it("is 0 on the terminator, a quarter turn away", () => {
    expect(sunElevationSine(t, sun.lon + 90, 0)).toBeCloseTo(0, 2);
    expect(sunElevationSine(t, sun.lon - 90, 0)).toBeCloseTo(0, 2);
  });

  it("gives polar day and polar night at the solstice", () => {
    const june = at("2024-06-20T20:51:00Z");
    for (const lon of [-120, 0, 120]) {
      expect(sunElevationSine(june, lon, 85)).toBeGreaterThan(0);
      expect(sunElevationSine(june, lon, -85)).toBeLessThan(0);
    }
  });
});

describe("nightFactor", () => {
  it("is 0 by day, 1 at night and eases through twilight", () => {
    expect(nightFactor(0.5)).toBe(0);
    expect(nightFactor(NIGHT_START)).toBe(0);
    expect(nightFactor(NIGHT_FULL)).toBe(1);
    expect(nightFactor(-0.9)).toBe(1);
    const mid = nightFactor((NIGHT_START + NIGHT_FULL) / 2);
    expect(mid).toBeCloseTo(0.5, 9);
    expect(nightFactor(0)).toBeLessThan(mid);
  });
});
