import { describe, expect, test } from "vite-plus/test";
import { EntityFlag, EntityKind, hashId } from "@orya-halo/schema";
import type { SourceContext } from "@orya-halo/schema";
import { fakeContext, fixture } from "../shared/overlays/test-context.ts";
import {
  MAX_RANK,
  WINDY_CAP,
  camerasToUpdate,
  digitrafficCameras,
  digitrafficDetail,
  digitrafficWeathercams,
  hkCameraDetail,
  hkTrafficCameras,
  inView,
  parseHkCameras,
  rankByDensity,
  selectCameras,
  splitStationName,
  windyCameras,
  windyDetail,
  windyRequestUrl,
  windyWebcams,
} from "./index.ts";
import type { Camera, DigitrafficStation, DigitrafficStations, WindyWebcam } from "./index.ts";

type View = NonNullable<SourceContext["view"]>;

const camera = (id: number, lon: number, lat: number): Camera => ({
  id,
  lon,
  lat,
  fixTimeMs: 0,
  meta: { label: `cam ${id}` },
});

describe("density ranking", () => {
  test("ranks an isolated camera 0 and a close neighbour deeper", () => {
    // 0.01 degrees apart: about 64 px at zoom 12.
    const rank = rankByDensity([
      camera(1, 24.9, 60.2),
      camera(2, 24.91, 60.2),
      camera(3, -70, -30),
    ]);
    expect(rank[0]).toBe(0);
    expect(rank[2]).toBe(0);
    expect(rank[1]).toBeGreaterThan(5);
    expect(rank[1]).toBeLessThanOrEqual(MAX_RANK);
  });

  test("gives cameras at the same spot the deepest rank rather than looping", () => {
    const rank = rankByDensity([camera(1, 10, 10), camera(2, 10, 10), camera(3, 10, 10)]);
    expect([...rank]).toEqual([0, MAX_RANK, MAX_RANK]);
  });

  test("shows more cameras the further in the view is", () => {
    const grid: Camera[] = [];
    for (let i = 0; i < 20; i++)
      for (let j = 0; j < 20; j++) grid.push(camera(i * 20 + j, 20 + i * 0.05, 60 + j * 0.05));
    const rank = rankByDensity(grid);
    const visibleAt = (zoom: number) => rank.filter((r) => r <= zoom).length;
    expect(visibleAt(2)).toBeLessThan(visibleAt(6));
    expect(visibleAt(6)).toBeLessThan(visibleAt(10));
    expect(visibleAt(MAX_RANK)).toBe(grid.length);
  });
});

describe("inView", () => {
  test("accepts points inside and just outside the bounds", () => {
    const bounds: View["bounds"] = [20, 60, 30, 70];
    expect(inView(25, 65, bounds)).toBe(true);
    expect(inView(31, 65, bounds)).toBe(true);
    expect(inView(40, 65, bounds)).toBe(false);
    expect(inView(25, 50, bounds)).toBe(false);
  });

  test("understands bounds that straddle the antimeridian", () => {
    const bounds: View["bounds"] = [170, -20, -170, 0];
    expect(inView(179, -10, bounds)).toBe(true);
    expect(inView(-179, -10, bounds)).toBe(true);
    expect(inView(0, -10, bounds)).toBe(false);
    expect(inView(150, -10, bounds)).toBe(false);
  });

  test("accepts every longitude when the view wraps the globe", () => {
    expect(inView(123, 0, [-180, -85, 180, 85])).toBe(true);
  });
});

describe("selectCameras", () => {
  const cameras = [camera(3, 24.91, 60.2), camera(1, 24.9, 60.2), camera(2, 114.17, 22.3)];

  test("keeps everything, in id order, when no view is known", () => {
    const selected = selectCameras(cameras, { cap: 100 });
    expect(selected.cameras.map((c) => c.id)).toEqual([1, 2, 3]);
    expect([...selected.rank].slice(0, 2)).toEqual([0, 0]);
  });

  test("drops what is outside the view or too crowded for its zoom", () => {
    const wide = selectCameras(cameras, { cap: 100, view: { zoom: 4, bounds: [10, 50, 40, 70] } });
    expect(wide.cameras.map((c) => c.id)).toEqual([1]);
    const close = selectCameras(cameras, {
      cap: 100,
      view: { zoom: 13, bounds: [24.8, 60.1, 25, 60.3] },
    });
    expect(close.cameras.map((c) => c.id)).toEqual([1, 3]);
  });

  test("drops the most crowded cameras first when over the cap", () => {
    const selected = selectCameras(cameras, { cap: 2 });
    expect(selected.cameras.map((c) => c.id)).toEqual([1, 2]);
    expect(selected.rank).toHaveLength(2);
  });
});

describe("camerasToUpdate", () => {
  test("produces a complete, stationary webcam batch", () => {
    const update = camerasToUpdate("test", [camera(7, 24.9, 60.2)], Uint8Array.of(5), 1000);
    expect(update).toMatchObject({
      kind: EntityKind.Webcam,
      source: "test",
      timeMs: 1000,
      full: true,
      count: 1,
    });
    expect(update.columns.ids[0]).toBe(7);
    expect(update.columns.lon[0]).toBeCloseTo(24.9, 4);
    expect(update.columns.lat[0]).toBeCloseTo(60.2, 4);
    expect(update.columns.speed[0]).toBe(0);
    expect(update.columns.heading[0]).toBeNaN();
    expect(update.columns.flags[0]).toBe(EntityFlag.Stationary);
    expect(update.columns.value[0]).toBe(5);
    expect(update.columns.fixTimeMs[0]).toBe(1000);
    expect(update.meta?.[0]?.label).toBe("cam 7");
  });
});

describe("Digitraffic road weather cameras", () => {
  const stations = JSON.parse(
    fixture(import.meta.url, "fixtures/digitraffic-stations.json"),
  ) as DigitrafficStations;
  const station = JSON.parse(
    fixture(import.meta.url, "fixtures/digitraffic-station-C01503.json"),
  ) as DigitrafficStation;

  test("splits station names into a place and a road", () => {
    expect(splitStationName("vt6_Imatra_Rönkkä")).toEqual({ label: "Imatra Rönkkä", road: "vt6" });
    expect(splitStationName("kt51_Inkoo")).toEqual({ label: "Inkoo", road: "kt51" });
    expect(splitStationName("VUO_SAT")).toEqual({ label: "VUO SAT", road: "" });
    expect(splitStationName("Kemi")).toEqual({ label: "Kemi", road: "" });
  });

  test("reads the recorded station list, leaving out stations that are not collecting", () => {
    const cameras = digitrafficCameras(stations);
    expect(stations.features).toHaveLength(19);
    expect(cameras).toHaveLength(18);
    const inkoo = cameras.find((c) => c.meta.stationId === "C01503");
    expect(inkoo).toMatchObject({
      id: hashId("fi-weathercam:C01503"),
      meta: { label: "Inkoo", provider: "Fintraffic", country: "Finland", road: "kt51", views: 3 },
    });
    expect(inkoo?.lon).toBeCloseTo(23.99616, 5);
    expect(inkoo?.lat).toBeCloseTo(60.05374, 5);
    expect(inkoo?.fixTimeMs).toBe(Date.UTC(2026, 10, 14, 3, 25, 34));
    expect(new Set(cameras.map((c) => c.id)).size).toBe(cameras.length);
  });

  test("normalises to webcam entities and thins by the view it was fetched for", async () => {
    const ctx = fakeContext({ "https://tie.digitraffic.fi/": stations });
    const raw = await digitrafficWeathercams.fetch?.(ctx);
    expect(ctx.requests[0]).toEqual({
      url: "https://tie.digitraffic.fi/api/weathercam/v1/stations",
      headers: { "digitraffic-user": "OryaHalo/0.1" },
    });
    const all = digitrafficWeathercams.normalise(raw as never, ctx);
    expect(all.type).toBe("entities");
    if (all.type !== "entities") return;
    expect(all.update).toMatchObject({
      kind: EntityKind.Webcam,
      source: "digitraffic-weathercams",
      full: true,
      count: 18,
    });
    expect(all.update.meta?.every((m) => typeof m?.label === "string" && m.label.length > 0)).toBe(
      true,
    );

    // The whole of Finland at zoom 4: the eight Helsinki stations collapse to a few.
    const view: View = { lon: 26, lat: 65, zoom: 4, bounds: [15, 58, 35, 71] };
    const wide = digitrafficWeathercams.normalise({ stations, view }, ctx);
    if (wide.type !== "entities") return;
    expect(wide.update.count).toBeLessThan(18);
    expect(wide.update.count).toBeGreaterThan(3);

    // A view of Hong Kong shows none of them.
    const away = digitrafficWeathercams.normalise(
      { stations, view: { zoom: 10, bounds: [113.8, 22.1, 114.5, 22.6] } },
      ctx,
    );
    if (away.type !== "entities") return;
    expect(away.update.count).toBe(0);
  });

  test("builds the detail panel from the recorded station document", () => {
    const detail = digitrafficDetail(station, "Inkoo");
    expect(detail.title).toBe("Road 51 Inkoo");
    expect(detail.subtitle).toBe("Road weather camera · Inkoo, Uusimaa, Finland");
    expect(detail.sourceUrl).toBe(
      "https://liikennetilanne.fintraffic.fi/kelikamerat/?cameraId=C01503",
    );
    expect(detail.media).toEqual([
      {
        type: "image",
        url: "https://weathercam.digitraffic.fi/C0150301.jpg",
        link: "https://liikennetilanne.fintraffic.fi/kelikamerat/?cameraId=C01503",
        credit: "Fintraffic / digitraffic.fi, CC BY 4.0",
        alt: 'Road weather camera at Road 51 Inkoo, view "Inkooseen"',
      },
      expect.objectContaining({ url: "https://weathercam.digitraffic.fi/C0150302.jpg" }),
      expect.objectContaining({ url: "https://weathercam.digitraffic.fi/C0150309.jpg" }),
    ]);
    expect(detail.fields).toContainEqual({
      key: "interval",
      label: "New image every",
      value: "10",
      unit: "min",
      numeric: 10,
    });
    expect(detail.attribution?.text).toBe("Source: Fintraffic / digitraffic.fi, license CC 4.0 BY");
    expect(detail.fixTimeMs).toBe(Date.UTC(2026, 10, 14, 3, 25, 34));
  });

  test("fetches one station for detail and refuses ids that are not station ids", async () => {
    const ctx = fakeContext({
      "https://tie.digitraffic.fi/api/weathercam/v1/stations/C01503": station,
    });
    const detail = await digitrafficWeathercams.detail?.(
      1,
      { label: "Inkoo", stationId: "C01503" },
      ctx,
    );
    expect(detail?.media).toHaveLength(3);
    expect(ctx.requests.map((r) => r.url)).toEqual([
      "https://tie.digitraffic.fi/api/weathercam/v1/stations/C01503",
    ]);

    expect(await digitrafficWeathercams.detail?.(1, { stationId: "../../etc" }, ctx)).toEqual({});
    expect(await digitrafficWeathercams.detail?.(1, undefined, ctx)).toEqual({});
    expect(ctx.requests).toHaveLength(1);
  });

  test("reports an unreadable list as bad data", () => {
    const ctx = fakeContext({});
    expect(() => digitrafficWeathercams.normalise({ stations: {} }, ctx)).toThrowError(
      /cannot read/,
    );
  });

  test("declares the licence and credit Fintraffic asks for", () => {
    expect(digitrafficWeathercams.licence).toMatchObject({
      name: "CC BY 4.0",
      display: true,
      verified: "2026-11-14",
    });
    expect(digitrafficWeathercams.requiresKey).toBeUndefined();
    expect(digitrafficWeathercams.layer).toBe("webcams");
  });
});

describe("Hong Kong traffic cameras", () => {
  const xml = fixture(import.meta.url, "fixtures/hk-cameras.xml");

  test("reads the recorded camera list", () => {
    const cameras = parseHkCameras(xml);
    expect(cameras).toHaveLength(12);
    expect(cameras[0]).toMatchObject({
      id: hashId("hk-td:H429F"),
      meta: {
        label: "Aberdeen Praya Road near Fish Market",
        key: "H429F",
        district: "Southern",
        region: "Hong Kong Island",
        country: "Hong Kong",
      },
    });
    expect(cameras[0].lon).toBeCloseTo(114.1505, 4);
    expect(cameras[0].lat).toBeCloseTo(22.24845, 5);
    expect(new Set(cameras.map((c) => c.id)).size).toBe(12);
  });

  test("decodes XML entities and drops the bracketed key from names", () => {
    const cameras = parseHkCameras(xml);
    expect(cameras.map((c) => c.meta.district)).toContain("Central & Western");
    expect(cameras.every((c) => !/\[[A-Z0-9]+\]$/.test(String(c.meta.label)))).toBe(true);
  });

  test("skips entries without a usable key or position", () => {
    const broken =
      "<image><key>../x</key><latitude>22.3</latitude><longitude>114.1</longitude></image>" +
      "<image><key>OK1</key><latitude></latitude><longitude>114.1</longitude></image>" +
      "<image><key>OK2</key><description>Somewhere [OK2]</description><latitude>22.3</latitude><longitude>114.1</longitude></image>";
    expect(parseHkCameras(broken).map((c) => c.meta.key)).toEqual(["OK2"]);
  });

  test("builds the detail panel without a request", async () => {
    const ctx = fakeContext({});
    const meta = parseHkCameras(xml)[0].meta;
    const detail = await hkTrafficCameras.detail?.(1, meta, ctx);
    expect(ctx.requests).toHaveLength(0);
    expect(detail).toEqual(hkCameraDetail(meta));
    expect(detail?.title).toBe("Aberdeen Praya Road near Fish Market");
    expect(detail?.subtitle).toBe("Traffic camera · Southern, Hong Kong Island, Hong Kong");
    expect(detail?.media).toEqual([
      {
        type: "image",
        url: "https://tdcctv.data.one.gov.hk/H429F.JPG",
        link: "https://data.gov.hk/en-data/dataset/hk-td-tis_2-traffic-snapshot-images",
        credit: "Transport Department, Hong Kong SAR Government · DATA.GOV.HK",
        alt: "Traffic camera at Aberdeen Praya Road near Fish Market, Hong Kong",
      },
    ]);
    expect(hkCameraDetail({ key: "../../x" })).toEqual({});
  });

  test("normalises to webcam entities and reports an empty list as bad data", async () => {
    const ctx = fakeContext({ "https://static.data.gov.hk/": xml });
    const raw = await hkTrafficCameras.fetch?.(ctx);
    expect(ctx.requests[0].url).toBe(
      "https://static.data.gov.hk/td/traffic-snapshot-images/code/Traffic_Camera_Locations_En.xml",
    );
    const output = hkTrafficCameras.normalise(raw as never, ctx);
    if (output.type !== "entities") throw new Error("expected entities");
    expect(output.update).toMatchObject({
      kind: EntityKind.Webcam,
      source: "hk-traffic-cameras",
      count: 12,
      full: true,
    });
    expect(() =>
      hkTrafficCameras.normalise({ xml: "<image-list></image-list>" }, ctx),
    ).toThrowError(/cannot read/);
  });
});

describe("Windy webcams", () => {
  const sample = JSON.parse(fixture(import.meta.url, "fixtures/windy-schema-sample.json")) as {
    clusters: WindyWebcam[];
    webcam: WindyWebcam;
  };
  const query = (url: string) => Object.fromEntries(new URL(url).searchParams);

  test("asks for the most popular webcams when no view, or a very wide one, is known", () => {
    const popular =
      "https://api.windy.com/webcams/api/v3/webcams?limit=50&offset=0&sortKey=popularity&sortDirection=desc&include=location";
    expect(windyRequestUrl(undefined)).toBe(popular);
    expect(windyRequestUrl({ lon: 0, lat: 0, zoom: 1.5, bounds: [-180, -85, 180, 85] })).toBe(
      popular,
    );
  });

  test("asks the cluster endpoint for a city-sized view", () => {
    const url = windyRequestUrl({
      lon: 151.2,
      lat: -33.85,
      zoom: 10,
      bounds: [150.9, -34.0, 151.5, -33.7],
    });
    expect(url.startsWith("https://api.windy.com/webcams/api/v3/map/clusters?")).toBe(true);
    expect(query(url)).toEqual({
      northLat: "-33.7000",
      southLat: "-34.0000",
      eastLon: "151.5000",
      westLon: "150.9000",
      zoom: "10",
      include: "location",
    });
  });

  test("keeps the box inside the limit the endpoint sets for each zoom", () => {
    for (const view of [
      { lon: 10, lat: 50, zoom: 3.2, bounds: [-20, 30, 40, 68] },
      { lon: 10, lat: 50, zoom: 5, bounds: [0, 44, 20, 56] },
      { lon: 151, lat: -33, zoom: 12.7, bounds: [150.99, -33.01, 151.01, -32.99] },
    ] satisfies View[]) {
      const q = query(windyRequestUrl(view));
      const zoom = Number(q.zoom);
      expect(zoom).toBeGreaterThanOrEqual(4);
      expect(zoom).toBeLessThanOrEqual(18);
      expect(zoom).toBeLessThanOrEqual(
        Math.floor(view.zoom) + 1 < 4 ? 4 : Math.floor(view.zoom) + 1,
      );
      expect(Number(q.northLat) - Number(q.southLat)).toBeLessThanOrEqual(
        22.5 / 2 ** (zoom - 4) + 1e-9,
      );
      expect(Number(q.eastLon) - Number(q.westLon)).toBeLessThanOrEqual(
        45 / 2 ** (zoom - 4) + 1e-9,
      );
    }
  });

  test("stays on the centre's side of the antimeridian", () => {
    const q = query(
      windyRequestUrl({ lon: 178, lat: -17, zoom: 7, bounds: [176, -19, -178, -15] }),
    );
    expect(Number(q.westLon)).toBeGreaterThanOrEqual(176);
    expect(Number(q.eastLon)).toBeLessThanOrEqual(180);
    expect(Number(q.westLon)).toBeLessThan(Number(q.eastLon));
  });

  test("needs a key, and says how to supply one", async () => {
    const ctx = fakeContext({});
    await expect(windyWebcams.fetch?.(ctx)).rejects.toMatchObject({
      name: "SourceError",
      code: "needs-key",
      message: "Windy webcams need an API key. Set VITE_WINDY_WEBCAMS_KEY to turn them on.",
    });
    expect(ctx.requests).toHaveLength(0);
    expect(windyWebcams.requiresKey).toBe("VITE_WINDY_WEBCAMS_KEY");
    // Its request is built from the view, so the runner must refetch when the view moves.
    expect(windyWebcams.viewAware).toBe(true);
  });

  test("sends the key in a header, never in the address", async () => {
    const view: View = { lon: 151.2, lat: -33.85, zoom: 10, bounds: [150.9, -34.0, 151.5, -33.7] };
    const ctx = fakeContext(
      { "https://api.windy.com/": sample.clusters },
      { key: "secret-key", view },
    );
    const raw = await windyWebcams.fetch?.(ctx);
    expect(ctx.requests[0].headers).toEqual({ "x-windy-api-key": "secret-key" });
    expect(ctx.requests[0].url).not.toContain("secret-key");
    expect(raw?.webcams).toHaveLength(4);
  });

  test("accepts the listing endpoint's wrapped answer too", async () => {
    const ctx = fakeContext(
      { "https://api.windy.com/": { total: 4, webcams: sample.clusters } },
      { key: "k" },
    );
    expect((await windyWebcams.fetch?.(ctx))?.webcams).toHaveLength(4);
  });

  test("reports a rejected key as a key problem", async () => {
    const ctx = fakeContext(
      { "https://api.windy.com/": { status: 403, body: '{"message":"Invalid API key"}' } },
      { key: "bad" },
    );
    await expect(windyWebcams.fetch?.(ctx)).rejects.toMatchObject({
      code: "needs-key",
      status: 403,
    });
  });

  test("keeps active webcams with a position and uses Windy's own id", () => {
    const cameras = windyCameras(sample.clusters);
    expect(cameras.map((c) => c.id)).toEqual([1179853135, 1240000001]);
    expect(cameras[0].meta).toMatchObject({
      label: "Sydney: Sydney Harbour Bridge - Sydney Opera House",
      city: "Sydney",
      country: "Australia",
      webcamId: 1179853135,
      clusterSize: 300,
    });
    const ctx = fakeContext({});
    const output = windyWebcams.normalise({ webcams: sample.clusters }, ctx);
    if (output.type !== "entities") throw new Error("expected entities");
    expect(output.update).toMatchObject({
      kind: EntityKind.Webcam,
      source: "windy-webcams",
      count: 2,
    });
    expect([...output.update.columns.value]).toEqual([0, 0]);
  });

  test("caps how many webcams it shows", () => {
    const many = Array.from({ length: WINDY_CAP + 50 }, (_, i) => ({
      webcamId: 1_300_000_000 + i,
      title: `Cam ${i}`,
      status: "active",
      location: { latitude: 10 + i * 0.001, longitude: 20 },
    }));
    expect(windyCameras(many)).toHaveLength(WINDY_CAP);
  });

  test("follows Windy's display rules in the detail panel", async () => {
    const ctx = fakeContext(
      { "https://api.windy.com/webcams/api/v3/webcams/1179853135": sample.webcam },
      { key: "secret-key" },
    );
    const detail = await windyWebcams.detail?.(1179853135, undefined, ctx);
    expect(ctx.requests[0].url).toBe(
      "https://api.windy.com/webcams/api/v3/webcams/1179853135?include=images,location,player,urls",
    );
    expect(ctx.requests[0].headers).toEqual({ "x-windy-api-key": "secret-key" });
    expect(detail).toEqual(windyDetail(sample.webcam));

    const [image, player] = detail?.media ?? [];
    // Every image links to the webcam's page on Windy and carries the courtesy line.
    expect(image).toEqual({
      type: "image",
      url: "https://images-webcams.windy.com/35/1179853135/current/preview/1179853135.jpg?token=example",
      link: "https://webcams.windy.com/webcams/1179853135",
      credit: "Webcams provided by Windy.com",
      alt: "Webcam view: Sydney: Sydney Harbour Bridge - Sydney Opera House",
    });
    expect(player).toMatchObject({
      type: "embed",
      link: "https://webcams.windy.com/webcams/1179853135",
    });
    expect(detail?.attribution).toEqual({
      text: "Webcams provided by Windy.com",
      url: "https://www.windy.com/",
      onMap: true,
    });
    expect(detail?.sourceUrl).toBe("https://webcams.windy.com/webcams/1179853135");
    expect(detail?.subtitle).toBe("Webcam · Sydney, New South Wales, Australia");
  });

  test("never shows media from an address that is not https", () => {
    const detail = windyDetail({
      webcamId: 5,
      title: "Odd",
      images: {
        current: { preview: "javascript:alert(1)", thumbnail: "http://insecure.example/a.jpg" },
      },
      player: { day: "data:text/html,hi" },
      urls: { detail: "http://insecure.example/" },
    });
    expect(detail.media).toEqual([]);
    expect(detail.sourceUrl).toBe("https://webcams.windy.com/webcams/5");
  });
});
