import { describe, expect, test } from "vite-plus/test";
import { fakeContext, fixture } from "../shared/overlays/test-context.ts";
import {
  BLACK_MARBLE_TILES,
  CITY_LIGHTS_2012_TILES,
  gibsTrueColour,
  latestCompleteDay,
  normaliseTrueColour,
} from "./index.ts";

const domains = fixture(import.meta.url, "fixtures/gibs-domains-truecolour.xml");
const outage = fixture(import.meta.url, "fixtures/gibs-domains-snpp-outage.xml");
/** When the fixtures were recorded. */
const NOW = Date.UTC(2026, 10, 14, 15, 17);

const dayOf = (url: string) => /default\/(\d{4}-\d{2}-\d{2})\//.exec(url)?.[1];

describe("latestCompleteDay", () => {
  test("is yesterday once the last swath has had time to be published", () => {
    expect(latestCompleteDay(Date.UTC(2026, 10, 14, 6, 0))).toBe(Date.UTC(2026, 10, 13));
    expect(latestCompleteDay(Date.UTC(2026, 10, 14, 23, 59))).toBe(Date.UTC(2026, 10, 13));
  });

  test("is the day before yesterday in the small hours", () => {
    expect(latestCompleteDay(Date.UTC(2026, 10, 14, 5, 59))).toBe(Date.UTC(2026, 10, 12));
  });
});

describe("normaliseTrueColour", () => {
  test("shows the most recent complete day and offers the days before it, oldest first", () => {
    const overlay = normaliseTrueColour({ domainsXml: domains }, NOW);
    expect(overlay.frames?.map((f) => dayOf(f.tiles[0]))).toEqual([
      "2026-11-09",
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
      "2026-11-13",
    ]);
    expect(overlay.tiles).toEqual([
      "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_NOAA20_CorrectedReflectance_TrueColor/default/2026-11-13/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpeg",
    ]);
    expect(overlay.timeMs).toBe(Date.UTC(2026, 10, 13, 12));
    expect(overlay.frames?.map((f) => f.timeMs)).toEqual(
      [...(overlay.frames ?? [])].map((f) => f.timeMs).sort((a, b) => a - b),
    );
    expect(overlay).toMatchObject({ tileSize: 256, minZoom: 0, maxZoom: 9, opacity: 1 });
  });

  test("never asks for a day the server has not published", () => {
    // Recorded from Suomi NPP, whose imagery stopped on 2 November.
    const overlay = normaliseTrueColour({ domainsXml: outage }, NOW);
    expect(dayOf(overlay.tiles[0])).toBe("2026-11-02");
    expect(overlay.frames?.map((f) => dayOf(f.tiles[0]))).toEqual([
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
  });

  test("skips days missing from the published ranges", () => {
    const gappy = "<Domain>2026-11-06/2026-11-10/P1D,2026-11-12/2026-11-14/P1D</Domain>";
    const overlay = normaliseTrueColour({ domainsXml: gappy }, NOW);
    expect(overlay.frames?.map((f) => dayOf(f.tiles[0]))).toEqual([
      "2026-11-09",
      "2026-11-10",
      "2026-11-12",
      "2026-11-13",
    ]);
  });

  test("falls back to the clock when availability is unknown", () => {
    const overlay = normaliseTrueColour({ domainsXml: null }, NOW);
    expect(dayOf(overlay.tiles[0])).toBe("2026-11-13");
    expect(overlay.frames).toHaveLength(5);
  });

  test("follows a scrubbed clock into the past", () => {
    const overlay = normaliseTrueColour({ domainsXml: domains }, Date.UTC(2026, 10, 11, 12));
    expect(dayOf(overlay.tiles[0])).toBe("2026-11-10");
  });
});

describe("gibsTrueColour plugin", () => {
  test("asks for the small availability document, not the capabilities file", async () => {
    const ctx = fakeContext({ "https://gibs.earthdata.nasa.gov/": domains }, { nowMs: NOW });
    const raw = await gibsTrueColour.fetch?.(ctx);
    expect(ctx.requests).toHaveLength(1);
    expect(ctx.requests[0].url).toBe(
      "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/VIIRS_NOAA20_CorrectedReflectance_TrueColor/default/GoogleMapsCompatible_Level9/all/2026-11-06--2026-11-14.xml",
    );
    const output = gibsTrueColour.normalise(raw as { domainsXml: string }, ctx);
    expect(output.type).toBe("tiles");
  });

  test("still produces an overlay when the availability document cannot be fetched", async () => {
    const ctx = fakeContext(
      { "https://gibs.earthdata.nasa.gov/": { status: 503 } },
      { nowMs: NOW },
    );
    const raw = await gibsTrueColour.fetch?.(ctx);
    expect(raw).toEqual({ domainsXml: null });
  });

  test("declares its layer, licence check date and credit", () => {
    expect(gibsTrueColour.layer).toBe("imagery");
    expect(gibsTrueColour.licence.verified).toBe("2026-11-14");
    expect(gibsTrueColour.licence.display).toBe(true);
    expect(gibsTrueColour.attribution.text).toContain("Global Imagery Browse Services (GIBS)");
    expect(gibsTrueColour.refreshRate).toBeGreaterThanOrEqual(600_000);
  });
});

describe("night lights templates", () => {
  test("are XYZ templates in row-then-column order", () => {
    expect(BLACK_MARBLE_TILES).toBe(
      "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png",
    );
    expect(CITY_LIGHTS_2012_TILES).toContain(
      "/VIIRS_CityLights_2012/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg",
    );
  });
});
