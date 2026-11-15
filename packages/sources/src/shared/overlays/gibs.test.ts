import { describe, expect, test } from "vite-plus/test";
import {
  gibsDomainsUrl,
  gibsTileUrl,
  hasTime,
  isoDay,
  isoSecond,
  parseGibsDomains,
  parsePeriod,
  startOfUtcDay,
} from "./gibs.ts";
import type { GibsLayer } from "./gibs.ts";
import { assetUrl } from "./http.ts";
import { fixture } from "./test-context.ts";

const layer: GibsLayer = {
  id: "Some_Layer",
  matrixSet: "GoogleMapsCompatible_Level9",
  maxZoom: 9,
  format: "jpeg",
};

describe("GIBS URLs", () => {
  test("tile template puts row before column, as WMTS does", () => {
    expect(gibsTileUrl(layer, "2026-11-13")).toBe(
      "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/Some_Layer/default/2026-11-13/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpeg",
    );
  });

  test("domains document address carries the window", () => {
    expect(gibsDomainsUrl(layer, "2026-11-06", "2026-11-14")).toBe(
      "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/Some_Layer/default/GoogleMapsCompatible_Level9/all/2026-11-06--2026-11-14.xml",
    );
  });
});

describe("parsePeriod", () => {
  test("reads the periods GIBS uses", () => {
    expect(parsePeriod("P1D")).toBe(86_400_000);
    expect(parsePeriod("PT30M")).toBe(1_800_000);
    expect(parsePeriod("PT6M")).toBe(360_000);
    expect(parsePeriod("P1M")).toBe(30 * 86_400_000);
  });

  test("answers 0 for anything else", () => {
    expect(parsePeriod("daily")).toBe(0);
    expect(parsePeriod("")).toBe(0);
  });
});

describe("parseGibsDomains", () => {
  test("reads a recorded daily document", () => {
    const ranges = parseGibsDomains(
      fixture(import.meta.url, "../../imagery/fixtures/gibs-domains-truecolour.xml"),
    );
    expect(ranges).toEqual([
      { startMs: Date.UTC(2026, 10, 6), endMs: Date.UTC(2026, 10, 14), stepMs: 86_400_000 },
    ]);
  });

  test("reads a recorded half-hourly document", () => {
    const ranges = parseGibsDomains(
      fixture(import.meta.url, "../../radar/fixtures/gibs-domains-imerg.xml"),
    );
    expect(ranges).toEqual([
      { startMs: Date.UTC(2026, 10, 13), endMs: Date.UTC(2026, 10, 14, 9, 30), stepMs: 1_800_000 },
    ]);
  });

  test("reads several ranges in one domain and sorts them", () => {
    const xml = "<Domain>2026-11-10/2026-11-12/P1D,2026-11-01/2026-11-03/P1D</Domain>";
    expect(parseGibsDomains(xml).map((r) => isoDay(r.startMs))).toEqual([
      "2026-11-01",
      "2026-11-10",
    ]);
  });

  test("ignores what it cannot read", () => {
    expect(
      parseGibsDomains("<Domain>nonsense</Domain><Domain>2026-11-02/2026-11-01/P1D</Domain>"),
    ).toEqual([]);
    expect(parseGibsDomains("<html>Service unavailable</html>")).toEqual([]);
  });
});

describe("hasTime", () => {
  const ranges = parseGibsDomains(
    "<Domain>2026-11-01/2026-11-03/P1D,2026-11-06/2026-11-08/P1D</Domain>",
  );

  test("is true on a listed step and false in a gap or between steps", () => {
    expect(hasTime(ranges, Date.UTC(2026, 10, 3))).toBe(true);
    expect(hasTime(ranges, Date.UTC(2026, 10, 4))).toBe(false);
    expect(hasTime(ranges, Date.UTC(2026, 10, 7, 12))).toBe(false);
    expect(hasTime(ranges, Date.UTC(2026, 10, 9))).toBe(false);
  });
});

describe("time helpers", () => {
  test("format UTC days and seconds", () => {
    const t = Date.UTC(2026, 10, 14, 9, 30, 0);
    expect(isoDay(t)).toBe("2026-11-14");
    expect(isoSecond(t)).toBe("2026-11-14T09:30:00Z");
    expect(startOfUtcDay(t)).toBe(Date.UTC(2026, 10, 14));
  });
});

describe("assetUrl", () => {
  test("joins with exactly one slash whatever the base looks like", () => {
    expect(assetUrl("https://halo.example/", "data/cables.bin")).toBe(
      "https://halo.example/data/cables.bin",
    );
    expect(assetUrl("https://halo.example/app", "/data/cables.bin")).toBe(
      "https://halo.example/app/data/cables.bin",
    );
    expect(assetUrl("/", "data/places.bin")).toBe("/data/places.bin");
    expect(assetUrl("", "data/places.bin")).toBe("/data/places.bin");
  });
});
