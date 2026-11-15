/**
 * The official traffic camera feeds added after Digitraffic and Hong Kong:
 * Singapore (LTA), British Columbia (DriveBC), Calgary and Austin.
 *
 * Fixtures were recorded on 2026-11-15 between 11:20 and 11:30 UTC, one
 * request each, and trimmed:
 * - sg-traffic-images.json: the whole answer of
 *   https://api.data.gov.sg/v1/transport/traffic-images (eight cameras that day);
 * - drivebc-webcams.csv: twelve views at six locations from the B.C. Data
 *   Catalogue's webcams.csv, chosen for multi-view groups, HTML in a credit
 *   and numeric entities in a caption;
 * - calgary-cameras.json: the first eight rows of data.calgary.ca k7p9-kppz;
 * - austin-cameras.json: eight working cameras from data.austintexas.gov
 *   b4k4-adkb, with the columns AUSTIN_API selects.
 */
import { describe, expect, test } from "vite-plus/test";
import { EntityFlag, EntityKind, hashId } from "@orya-halo/schema";
import type { SourceContext, SourcePlugin } from "@orya-halo/schema";
import { fakeContext, fixture } from "../shared/overlays/test-context.ts";
import {
  AUSTIN_API,
  CALGARY_API,
  DRIVEBC_CSV,
  SG_TRAFFIC_IMAGES_API,
  austinCameras,
  austinDetail,
  austinPlace,
  austinTrafficCameras,
  calgaryCameras,
  calgaryDetail,
  calgaryTrafficCameras,
  driveBcCameras,
  driveBcDetail,
  driveBcHighwayCams,
  plainText,
  sgCameraDetail,
  sgCameras,
  sgLtaTrafficCameras,
} from "./index.ts";
import type { AustinCameraRow, CalgaryCameraRow, SgTrafficImages } from "./index.ts";

type View = NonNullable<SourceContext["view"]>;

const sgBody = fixture(import.meta.url, "fixtures/sg-traffic-images.json");
const bcCsv = fixture(import.meta.url, "fixtures/drivebc-webcams.csv");
const calgaryBody = fixture(import.meta.url, "fixtures/calgary-cameras.json");
const austinBody = fixture(import.meta.url, "fixtures/austin-cameras.json");

/** Fetch through the plugin, normalise, and return the entity update. */
async function run(plugin: SourcePlugin, ctx: SourceContext) {
  const raw = await plugin.fetch?.(ctx);
  const output = plugin.normalise(raw, ctx);
  if (output.type !== "entities") throw new Error("expected entities");
  return output.update;
}

describe("plainText", () => {
  test("drops tags, decodes named and numeric entities and collapses space", () => {
    expect(plainText('<a href="x" target="_blank">Counterflow operations</a> in effect.<br>')).toBe(
      "Counterflow operations in effect.",
    );
    expect(plainText("near C&#x259;X&#x323;&#x2B7; Cix&#x2B7; &amp; &#39;x&#39;")).toBe(
      "near CəX̣ʷ Cixʷ & 'x'",
    );
    expect(plainText("&bogus; &#0;")).toBe("&bogus;");
  });
});

describe("Singapore LTA traffic cameras", () => {
  const feed = JSON.parse(sgBody) as SgTrafficImages;

  test("reads every camera in the recorded answer", () => {
    const cameras = sgCameras(feed);
    expect(cameras).toHaveLength(8);
    expect(cameras[0]).toMatchObject({
      id: hashId("sg-lta:2701"),
      fixTimeMs: Date.parse("2026-11-15T19:21:10+08:00"),
      meta: {
        label: "Traffic camera 2701",
        provider: "Land Transport Authority",
        country: "Singapore",
        cameraId: "2701",
        image:
          "https://images.data.gov.sg/api/traffic-images/2026/11/7e06334d-1a24-44d1-bda8-6011a9872ddb.jpg",
      },
    });
    expect(cameras[0].lat).toBeCloseTo(1.447023728, 8);
    expect(cameras[0].lon).toBeCloseTo(103.7716543, 6);
  });

  test("skips cameras without a number, a position or an image on the dataset's host", () => {
    const camera = feed.items?.[0]?.cameras?.[0];
    const broken: SgTrafficImages = {
      items: [
        {
          cameras: [
            { ...camera, camera_id: "../1" },
            { ...camera, camera_id: "1", location: {} },
            { ...camera, camera_id: "2", image: "https://evil.example/x.jpg" },
            { ...camera, camera_id: "3", image: "http://images.data.gov.sg/api/x.jpg" },
            { ...camera, camera_id: "4" },
          ],
        },
      ],
    };
    expect(sgCameras(broken).map((c) => c.meta.cameraId)).toEqual(["4"]);
  });

  test("normalises to webcam entities and reports an unreadable answer as bad data", async () => {
    const ctx = fakeContext({ [SG_TRAFFIC_IMAGES_API]: sgBody });
    const update = await run(sgLtaTrafficCameras as SourcePlugin, ctx);
    expect(ctx.requests.map((r) => r.url)).toEqual([SG_TRAFFIC_IMAGES_API]);
    expect(update).toMatchObject({
      kind: EntityKind.Webcam,
      source: "sg-lta-traffic-images",
      count: 8,
      full: true,
    });
    expect(update.columns.flags[0]).toBe(EntityFlag.Stationary);
    expect(() =>
      sgLtaTrafficCameras.normalise({ feed: { api_info: { status: "down" } } }, ctx),
    ).toThrowError(/cannot read/);
  });

  test("looks up the newest image when a camera is selected", async () => {
    const meta = sgCameras(feed)[1].meta;
    const newer = JSON.parse(sgBody) as SgTrafficImages;
    const entry = newer.items?.[0]?.cameras?.[1];
    if (!entry) throw new Error("fixture changed");
    entry.image = "https://images.data.gov.sg/api/traffic-images/2026/11/newer.jpg";
    entry.timestamp = "2026-11-15T19:22:10+08:00";
    const ctx = fakeContext({ [SG_TRAFFIC_IMAGES_API]: JSON.stringify(newer) });
    const detail = await sgLtaTrafficCameras.detail?.(1, meta, ctx);
    expect(ctx.requests).toHaveLength(1);
    expect(detail).toMatchObject({
      title: "Traffic camera 2702",
      subtitle: "Traffic camera · Singapore",
      fixTimeMs: Date.parse("2026-11-15T19:22:10+08:00"),
      media: [
        {
          type: "image",
          url: "https://images.data.gov.sg/api/traffic-images/2026/11/newer.jpg",
          link: "https://data.gov.sg/datasets/d_6cdb6b405b25aaaacbaf7689bcc6fae0/view",
          credit: "Land Transport Authority · data.gov.sg, Singapore Open Data Licence",
          alt: "Traffic camera 2702, Singapore",
        },
      ],
    });
  });

  test("falls back to the listed image when the lookup fails", async () => {
    const meta = sgCameras(feed)[1].meta;
    const ctx = fakeContext({ [SG_TRAFFIC_IMAGES_API]: { status: 429, body: "Too many" } });
    const detail = await sgLtaTrafficCameras.detail?.(1, meta, ctx);
    expect(detail?.media?.[0].url).toBe(meta.image);
    expect(detail?.fixTimeMs).toBeUndefined();
    expect(sgCameraDetail({ cameraId: "../x" })).toEqual({});
  });

  test("declares the notice the Singapore Open Data Licence asks for", () => {
    expect(sgLtaTrafficCameras.licence).toMatchObject({ display: true, verified: "2026-11-15" });
    expect(sgLtaTrafficCameras.attribution.text).toContain(
      "made available under the terms of the Singapore Open Data Licence version 1.0",
    );
    expect(sgLtaTrafficCameras.attribution.url).toBe("https://data.gov.sg/open-data-licence");
    expect(sgLtaTrafficCameras.requiresKey).toBeUndefined();
  });
});

describe("DriveBC highway cameras", () => {
  test("groups the views on one pole into one camera", () => {
    const cameras = driveBcCameras(bcCsv);
    expect(cameras.map((c) => c.meta.group)).toEqual(["520", "914", "799", "21", "341"]);
    const elkford = cameras[1];
    expect(elkford).toMatchObject({
      id: hashId("drivebc:914"),
      meta: {
        label: "Elkford",
        provider: "B.C. Ministry of Transportation and Transit",
        country: "Canada",
        // The view that names the group comes first, the rest by id.
        views: "914:N,937:W,938:E,939:S",
        place: "Highway 43 at Fording River Road in Elkford",
        highway: "43",
        region: "Southern Interior",
        note: null,
      },
    });
    expect(elkford.lat).toBeCloseTo(50.021677, 6);
    expect(elkford.lon).toBeCloseTo(-114.916704, 6);
  });

  test("turns HTML and entities in the file into plain text", () => {
    const cameras = driveBcCameras(bcCsv);
    expect(cameras.find((c) => c.meta.group === "21")?.meta.note).toBe(
      "Counterflow operations in effect for Lions Gate Bridge.",
    );
    // The group's own view is not in the trimmed file: the first view stands in.
    const jackass = cameras.find((c) => c.meta.group === "341");
    expect(jackass?.meta).toMatchObject({ label: "Jackass Mountain", views: "1105:N" });
    expect(jackass?.meta.place).toBe(
      "Highway 1 between Boston Bar and Lytton at Jackass Mountain summit near CəX̣ʷ Cixʷ (Check-Chow) Bridge",
    );
  });

  test("skips rows without a numeric id or a position", () => {
    const header = bcCsv.split("\n")[0];
    const csv = [
      header,
      '"x1","x1","Bad","","","1","","","","N","49","-123","0"',
      '"7","7","No place","","","1","","","","N","","-123","0"',
      '"8","8","Fine - N","","","1","","","","N","49.5","-123.5","0"',
    ].join("\n");
    expect(driveBcCameras(csv).map((c) => c.meta.label)).toEqual(["Fine"]);
    expect(driveBcCameras("not,a,camera,file\n1,2,3,4")).toEqual([]);
  });

  test("builds the detail panel with every view and no request", async () => {
    const ctx = fakeContext({});
    const meta = driveBcCameras(bcCsv)[1].meta;
    const detail = await driveBcHighwayCams.detail?.(1, meta, ctx);
    expect(ctx.requests).toHaveLength(0);
    expect(detail).toEqual(driveBcDetail(meta));
    expect(detail?.title).toBe("Elkford");
    expect(detail?.subtitle).toBe("Highway camera · Southern Interior, British Columbia");
    expect(detail?.media).toHaveLength(4);
    expect(detail?.media?.[0]).toEqual({
      type: "image",
      url: "https://www.drivebc.ca/images/914.jpg",
      link: "https://www.drivebc.ca/cameras/914",
      credit: "DriveBC, B.C. Ministry of Transportation and Transit",
      alt: "Highway camera at Elkford, looking north",
    });
    expect(detail?.fields?.map((f) => f.key)).toEqual(["place", "highway", "region", "views"]);
    expect(driveBcDetail({ views: "../1:N" })).toEqual({});
  });

  test("normalises to webcam entities and reports an unreadable file as bad data", async () => {
    const ctx = fakeContext({ [DRIVEBC_CSV]: bcCsv });
    const update = await run(driveBcHighwayCams as SourcePlugin, ctx);
    expect(ctx.requests.map((r) => r.url)).toEqual([DRIVEBC_CSV]);
    expect(update).toMatchObject({
      kind: EntityKind.Webcam,
      source: "drivebc-highwaycams",
      count: 5,
      full: true,
    });
    expect(() => driveBcHighwayCams.normalise({ csv: "<html></html>" }, ctx)).toThrowError(
      /cannot read/,
    );
  });

  test("thins by the view it was fetched for", async () => {
    // Around Elkford only.
    const view: View = { lon: -114.9, lat: 50, zoom: 9, bounds: [-115.3, 49.8, -114.5, 50.2] };
    const ctx = fakeContext({ [DRIVEBC_CSV]: bcCsv }, { view });
    const update = await run(driveBcHighwayCams as SourcePlugin, ctx);
    expect(update.count).toBe(1);
    expect(update.meta?.[0]?.label).toBe("Elkford");
  });

  test("states the Open Government Licence – British Columbia", () => {
    expect(driveBcHighwayCams.licence).toMatchObject({
      name: "Open Government Licence – British Columbia 2.0",
      display: true,
      verified: "2026-11-15",
    });
    expect(driveBcHighwayCams.attribution.text).toContain(
      "Contains information licensed under the Open Government Licence – British Columbia",
    );
  });
});

describe("City of Calgary traffic cameras", () => {
  const rows = JSON.parse(calgaryBody) as CalgaryCameraRow[];

  test("reads the recorded rows", () => {
    const cameras = calgaryCameras(rows);
    expect(cameras).toHaveLength(8);
    expect(cameras[1]).toMatchObject({
      id: hashId("calgary:100"),
      meta: {
        label: "Stoney Trail / Beddington Trail NW",
        provider: "The City of Calgary",
        country: "Canada",
        camera: "Camera 101",
        quadrant: "NW",
        image: "https://trafficcam.calgary.ca/loc100.jpg",
      },
    });
    expect(cameras[1].lon).toBeCloseTo(-114.1149257, 7);
    expect(cameras[1].lat).toBeCloseTo(51.1565751, 7);
  });

  test("keeps only images on the City's camera host and rows with a position", () => {
    const row = rows[0];
    const cameras = calgaryCameras([
      { ...row, camera_url: { url: "https://elsewhere.example/loc1.jpg" } },
      { ...row, camera_url: { url: "http://trafficcam.calgary.ca/loc1.jpg" } },
      { ...row, point: undefined },
      { ...row, camera_url: { url: "https://trafficcam.calgary.ca/loc9.jpg" } },
    ]);
    expect(cameras.map((c) => c.meta.image)).toEqual(["https://trafficcam.calgary.ca/loc9.jpg"]);
  });

  test("builds the detail panel without a request", async () => {
    const ctx = fakeContext({});
    const meta = calgaryCameras(rows)[0].meta;
    const detail = await calgaryTrafficCameras.detail?.(1, meta, ctx);
    expect(ctx.requests).toHaveLength(0);
    expect(detail).toMatchObject({
      title: "Glenmore Trail / Macleod Trail S",
      subtitle: "Traffic camera · Calgary, Alberta, Canada",
      media: [
        {
          type: "image",
          url: "https://trafficcam.calgary.ca/loc0.jpg",
          link: "https://data.calgary.ca/d/k7p9-kppz",
          alt: "Traffic camera at Glenmore Trail / Macleod Trail S, Calgary",
        },
      ],
    });
    expect(calgaryDetail({ image: "javascript:alert(1)" })).toEqual({});
  });

  test("normalises to webcam entities and reports an unreadable answer as bad data", async () => {
    const ctx = fakeContext({ [CALGARY_API]: calgaryBody });
    const update = await run(calgaryTrafficCameras as SourcePlugin, ctx);
    expect(ctx.requests.map((r) => r.url)).toEqual([CALGARY_API]);
    expect(update).toMatchObject({ source: "calgary-traffic-cameras", count: 8, full: true });
    expect(() =>
      calgaryTrafficCameras.normalise({ rows: { error: true } as never }, ctx),
    ).toThrowError(/cannot read/);
    expect(calgaryTrafficCameras.attribution.text).toContain(
      "Contains information licensed under the Open Government Licence – City of Calgary",
    );
  });
});

describe("City of Austin traffic cameras", () => {
  const rows = JSON.parse(austinBody) as AustinCameraRow[];

  test("asks only for working cameras and the columns it reads", () => {
    const url = new URL(AUSTIN_API);
    expect(url.searchParams.get("$where")).toBe("camera_status='TURNED_ON'");
    expect(url.searchParams.get("$select")).toBe(
      "camera_id,location_name,screenshot_address,location",
    );
  });

  test("reads the recorded rows and tidies the street names", () => {
    const cameras = austinCameras(rows);
    expect(cameras).toHaveLength(8);
    expect(cameras[2]).toMatchObject({
      id: hashId("austin:100"),
      meta: {
        label: "Lamar Blvd / Barton Springs Rd",
        provider: "Austin Transportation and Public Works",
        country: "United States",
        cameraId: "100",
      },
    });
    expect(cameras[2].lon).toBeCloseTo(-97.758522, 6);
    expect(austinPlace(" SPRINGDALE RD / ED BLUESTEIN BLVD SVRD")).toBe(
      "Springdale Rd / Ed Bluestein Blvd SVRD",
    );
    expect(austinPlace("830 BLK W RUNDBERG LN (Little Walnut Creek Library, HEB)")).toBe(
      "830 BLK W Rundberg Ln (Little Walnut Creek Library, HEB)",
    );
  });

  test("skips rows whose screenshot is not where the dataset says it lives", () => {
    const row = rows[0];
    const cameras = austinCameras([
      { ...row, camera_id: "2", screenshot_address: "https://elsewhere.example/2.jpg" },
      { ...row, camera_id: "../1" },
      { ...row, location: undefined },
      row,
    ]);
    expect(cameras.map((c) => c.meta.cameraId)).toEqual(["1"]);
  });

  test("builds the detail panel without a request", async () => {
    const ctx = fakeContext({});
    const meta = austinCameras(rows)[2].meta;
    const detail = await austinTrafficCameras.detail?.(1, meta, ctx);
    expect(ctx.requests).toHaveLength(0);
    expect(detail).toEqual(austinDetail(meta));
    expect(detail?.media).toEqual([
      {
        type: "image",
        url: "https://cctv.austinmobility.io/image/100.jpg",
        link: "https://data.austintexas.gov/d/b4k4-adkb",
        credit: "Austin Transportation and Public Works",
        alt: "Traffic camera at Lamar Blvd / Barton Springs Rd, Austin",
      },
    ]);
    expect(austinDetail({ cameraId: "1.jpg?x" })).toEqual({});
  });

  test("normalises to webcam entities and reports an unreadable answer as bad data", async () => {
    const ctx = fakeContext({ [AUSTIN_API]: austinBody });
    const update = await run(austinTrafficCameras as SourcePlugin, ctx);
    expect(ctx.requests.map((r) => r.url)).toEqual([AUSTIN_API]);
    expect(update).toMatchObject({ source: "austin-traffic-cameras", count: 8, full: true });
    expect(() => austinTrafficCameras.normalise({ rows: [] }, ctx)).toThrowError(/cannot read/);
    expect(austinTrafficCameras.licence).toMatchObject({ display: true, verified: "2026-11-15" });
  });

  test("failures carry the codes the runner understands", async () => {
    const refused = fakeContext({ [AUSTIN_API]: { status: 429, body: "Slow down" } });
    await expect(austinTrafficCameras.fetch?.(refused)).rejects.toMatchObject({
      name: "SourceError",
      code: "blocked",
    });
    const down = fakeContext({ [CALGARY_API]: { status: 503, body: "" } });
    await expect(calgaryTrafficCameras.fetch?.(down)).rejects.toMatchObject({
      name: "SourceError",
      code: "http",
    });
  });
});
