import { describe, expect, test } from "vite-plus/test";
import { fakeContext, fixture } from "../shared/overlays/test-context.ts";
import {
  gibsImergPrecipitation,
  normaliseImerg,
  normaliseRainViewer,
  rainViewerRadar,
} from "./index.ts";
import type { RainViewerIndex } from "./index.ts";

/** When the fixtures were recorded. */
const NOW = Date.UTC(2026, 10, 14, 15, 17);

describe("RainViewer", () => {
  const index = JSON.parse(
    fixture(import.meta.url, "fixtures/rainviewer-weather-maps.json"),
  ) as RainViewerIndex;

  test("turns the recorded index into frames, oldest first", () => {
    const overlay = normaliseRainViewer(index);
    const frames = overlay.frames ?? [];
    expect(frames).toHaveLength(13);
    expect(frames[0].timeMs).toBe(1_794_663_000_000);
    expect(frames[12].timeMs).toBe(1_794_670_200_000);
    for (let i = 1; i < frames.length; i++)
      expect(frames[i].timeMs - frames[i - 1].timeMs).toBe(600_000);
    expect(overlay.timeMs).toBe(frames[12].timeMs);
    expect(overlay.tiles).toEqual(frames[12].tiles);
  });

  test("builds tile addresses in the one colour scheme the free API still serves", () => {
    const overlay = normaliseRainViewer(index);
    expect(overlay.tiles).toEqual([
      "https://tilecache.rainviewer.com/v2/radar/f7acf8ce4892/512/{z}/{x}/{y}/2/1_1.png",
    ]);
    expect(overlay.tileSize).toBe(512);
  });

  test("stops at zoom 7, above which the server sends a placeholder picture", () => {
    expect(normaliseRainViewer(index).maxZoom).toBe(7);
  });

  test("sorts frames that arrive out of order and leaves forecasts out", () => {
    const overlay = normaliseRainViewer({
      host: "https://tilecache.rainviewer.com/",
      radar: {
        past: [
          { time: 200, path: "/v2/radar/b" },
          { time: 100, path: "/v2/radar/a" },
        ],
        nowcast: [{ time: 300, path: "/v2/radar/future" }],
      },
    });
    expect(overlay.frames?.map((f) => f.timeMs)).toEqual([100_000, 200_000]);
    expect(overlay.tiles[0]).toBe(
      "https://tilecache.rainviewer.com/v2/radar/b/512/{z}/{x}/{y}/2/1_1.png",
    );
  });

  test("reports an index with no frames as bad data", () => {
    expect(() =>
      normaliseRainViewer({ host: "https://tilecache.rainviewer.com", radar: { past: [] } }),
    ).toThrowError(/no radar frames/);
    expect(() => normaliseRainViewer({})).toThrowError(/no radar frames/);
    expect(() =>
      normaliseRainViewer({
        host: "http://insecure.example",
        radar: { past: [{ time: 1, path: "/x" }] },
      }),
    ).toThrowError();
  });

  test("fetches the public index and declares the credit RainViewer asks for", async () => {
    const ctx = fakeContext({ "https://api.rainviewer.com/public/weather-maps.json": index });
    const raw = await rainViewerRadar.fetch?.(ctx);
    expect(ctx.requests.map((r) => r.url)).toEqual([
      "https://api.rainviewer.com/public/weather-maps.json",
    ]);
    const output = rainViewerRadar.normalise(raw as RainViewerIndex, ctx);
    expect(output.type).toBe("tiles");
    expect(rainViewerRadar.attribution).toMatchObject({
      text: "Weather data by RainViewer",
      url: "https://www.rainviewer.com/",
      onMap: true,
    });
    expect(rainViewerRadar.licence.verified).toBe("2026-11-14");
    expect(rainViewerRadar.licence.commercial).toBe(false);
  });

  test("turns a refusal into a blocked error", async () => {
    const ctx = fakeContext({
      "https://api.rainviewer.com/": { status: 429, body: "Too many requests" },
    });
    await expect(rainViewerRadar.fetch?.(ctx)).rejects.toMatchObject({
      name: "SourceError",
      code: "blocked",
      status: 429,
    });
  });
});

describe("IMERG precipitation", () => {
  const domains = fixture(import.meta.url, "fixtures/gibs-domains-imerg.xml");
  const timeOf = (url: string) => /default\/([^/]+)\//.exec(url)?.[1];

  test("ends an hour before the newest listed half hour and steps back 30 minutes at a time", () => {
    // The recording lists frames up to 09:30; the two newest are not reliably fetchable yet.
    const overlay = normaliseImerg({ domainsXml: domains }, NOW);
    const frames = overlay.frames ?? [];
    expect(frames).toHaveLength(12);
    expect(timeOf(overlay.tiles[0])).toBe("2026-11-14T08:30:00Z");
    expect(timeOf(frames[0].tiles[0])).toBe("2026-11-14T03:00:00Z");
    for (let i = 1; i < frames.length; i++)
      expect(frames[i].timeMs - frames[i - 1].timeMs).toBe(1_800_000);
    expect(overlay).toMatchObject({
      tileSize: 256,
      maxZoom: 6,
      timeMs: Date.UTC(2026, 10, 14, 8, 30),
    });
    expect(overlay.tiles[0]).toContain("/IMERG_Precipitation_Rate_30min/default/");
    expect(overlay.tiles[0]).toMatch(/\/GoogleMapsCompatible_Level6\/\{z\}\/\{y\}\/\{x\}\.png$/);
  });

  test("skips half hours the server does not list", () => {
    const holes =
      "<Domain>2026-11-14T04:00:00Z/2026-11-14T06:00:00Z/PT30M,2026-11-14T08:00:00Z/2026-11-14T09:30:00Z/PT30M</Domain>";
    const overlay = normaliseImerg({ domainsXml: holes }, NOW);
    expect(overlay.frames?.map((f) => timeOf(f.tiles[0])?.slice(11, 16))).toEqual([
      "04:00",
      "04:30",
      "05:00",
      "05:30",
      "06:00",
      "08:00",
      "08:30",
    ]);
  });

  test("assumes seven hours of delay when availability is unknown", () => {
    const overlay = normaliseImerg({ domainsXml: null }, NOW);
    expect(timeOf(overlay.tiles[0])).toBe("2026-11-14T08:00:00Z");
  });

  test("never runs ahead of a scrubbed clock", () => {
    const overlay = normaliseImerg({ domainsXml: domains }, Date.UTC(2026, 10, 14, 2, 10));
    expect(timeOf(overlay.tiles[0])).toBe("2026-11-14T02:00:00Z");
  });

  test("is a second source for the radar layer under NASA's open terms", async () => {
    const ctx = fakeContext({ "https://gibs.earthdata.nasa.gov/": domains }, { nowMs: NOW });
    const raw = await gibsImergPrecipitation.fetch?.(ctx);
    expect(ctx.requests[0].url).toContain(
      "/1.0.0/IMERG_Precipitation_Rate_30min/default/GoogleMapsCompatible_Level6/all/",
    );
    expect(raw).toEqual({ domainsXml: domains });
    expect(gibsImergPrecipitation.layer).toBe("radar");
    expect(gibsImergPrecipitation.licence.commercial).toBe(true);
  });
});
