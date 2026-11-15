/**
 * The four official camera feeds added with Singapore, DriveBC, Calgary and
 * Austin, against answers they should never send but one day may: empty,
 * truncated, the wrong shape, one bad row among good ones. Plus what each
 * must declare (attribution, licence) and how often it may ask.
 *
 * The runner turns any error thrown by `normalise` into "could not be read"
 * for the whole source, so a single bad row that throws hides every camera
 * of that provider. Rows that cannot be read must be skipped instead.
 */
import { describe, expect, test } from "vite-plus/test";
import { EntityKind } from "@orya-halo/schema";
import type { DetailMedia, EntityUpdate, SourceContext, SourcePlugin } from "@orya-halo/schema";
import { fakeContext, fixture } from "../shared/overlays/test-context.ts";
import {
  AUSTIN_API,
  CALGARY_API,
  DRIVEBC_CSV,
  SG_TRAFFIC_IMAGES_API,
  austinCameras,
  austinDetail,
  austinTrafficCameras,
  calgaryCameras,
  calgaryDetail,
  calgaryTrafficCameras,
  driveBcCameras,
  driveBcDetail,
  driveBcHighwayCams,
  sgCameraDetail,
  sgCameras,
  sgLtaTrafficCameras,
} from "./index.ts";
import type { AustinCameraRow, CalgaryCameraRow, SgTrafficImages } from "./index.ts";

const sgBody = fixture(import.meta.url, "fixtures/sg-traffic-images.json");
const bcCsv = fixture(import.meta.url, "fixtures/drivebc-webcams.csv");
const calgaryBody = fixture(import.meta.url, "fixtures/calgary-cameras.json");
const austinBody = fixture(import.meta.url, "fixtures/austin-cameras.json");

const sgFeed = () => JSON.parse(sgBody) as SgTrafficImages;
const calgaryRows = () => JSON.parse(calgaryBody) as CalgaryCameraRow[];
const austinRows = () => JSON.parse(austinBody) as AustinCameraRow[];

const ctx = (): SourceContext => fakeContext({});

function entities(plugin: SourcePlugin, raw: unknown): EntityUpdate {
  const out = plugin.normalise(raw, ctx());
  if (out.type !== "entities") throw new Error("expected entities");
  return out.update;
}

/** The normaliser rejects `raw` as bad data, with a sentence the panel can show. */
function rejects(plugin: SourcePlugin, raw: unknown): void {
  let caught: unknown;
  try {
    plugin.normalise(raw, ctx());
  } catch (error) {
    caught = error;
  }
  expect(caught, "should throw").toBeDefined();
  expect(caught).toMatchObject({ name: "SourceError", code: "bad-data" });
  expect((caught as Error).message).toMatch(/\S.*\.$/);
}

const PLUGINS = [
  {
    plugin: sgLtaTrafficCameras as SourcePlugin,
    url: SG_TRAFFIC_IMAGES_API,
    body: sgBody,
    statement: "made available under the terms of the Singapore Open Data Licence version 1.0",
    // data.gov.sg without a key: 6 requests per 10 seconds; images change about once a minute.
    minRefreshMs: 60_000,
  },
  {
    plugin: driveBcHighwayCams as SourcePlugin,
    url: DRIVEBC_CSV,
    body: bcCsv,
    statement: "Contains information licensed under the Open Government Licence – British Columbia",
    // The file is republished monthly: no need to ask more than every few hours.
    minRefreshMs: 3_600_000,
  },
  {
    plugin: calgaryTrafficCameras as SourcePlugin,
    url: CALGARY_API,
    body: calgaryBody,
    statement: "Contains information licensed under the Open Government Licence – City of Calgary",
    // Socrata throttles keyless clients; the plugin documents one request an hour.
    minRefreshMs: 3_600_000,
  },
  {
    plugin: austinTrafficCameras as SourcePlugin,
    url: AUSTIN_API,
    body: austinBody,
    statement: "Austin Transportation and Public Works",
    minRefreshMs: 3_600_000,
  },
];

describe("empty and wrongly shaped answers", () => {
  test("Singapore: no list at all is bad data", () => {
    rejects(sgLtaTrafficCameras as SourcePlugin, { feed: null });
    rejects(sgLtaTrafficCameras as SourcePlugin, { feed: {} });
    rejects(sgLtaTrafficCameras as SourcePlugin, { feed: { items: "none" } });
    rejects(sgLtaTrafficCameras as SourcePlugin, {});
  });

  test("Singapore: an empty list is an empty layer, not an error", () => {
    // data.gov.sg answers `items: []` for a moment with no images.
    expect(entities(sgLtaTrafficCameras as SourcePlugin, { feed: { items: [] } }).count).toBe(0);
    expect(
      entities(sgLtaTrafficCameras as SourcePlugin, { feed: { items: [{ cameras: [] }] } }).count,
    ).toBe(0);
    expect(entities(sgLtaTrafficCameras as SourcePlugin, { feed: { items: [{}] } }).count).toBe(0);
  });

  test("DriveBC: an empty, header-only, HTML or truncated file is bad data", () => {
    const header = bcCsv.split("\n")[0];
    for (const csv of [
      "",
      "\n\n",
      header,
      "<!doctype html><html><body>Service unavailable</body></html>",
    ])
      rejects(driveBcHighwayCams as SourcePlugin, { csv });
    rejects(driveBcHighwayCams as SourcePlugin, {});
  });

  test("DriveBC: Windows line endings and a cut-off last line still read", () => {
    const lf = driveBcCameras(bcCsv);
    expect(driveBcCameras(bcCsv.replace(/\r?\n/g, "\r\n")).map((c) => c.id)).toEqual(
      lf.map((c) => c.id),
    );
    const lines = bcCsv.trimEnd().split("\n");
    const cut = [...lines.slice(0, -1), lines.at(-1)?.slice(0, 20)].join("\n");
    expect(() => driveBcCameras(cut)).not.toThrow();
    expect(driveBcCameras(cut).length).toBeGreaterThan(0);
  });

  test("DriveBC: columns in another order are found by name", () => {
    const [header, ...rows] = bcCsv
      .replace(/^[^"]*/, "")
      .trimEnd()
      .split(/\r?\n/);
    const split = (line: string) => line.split('","').map((s) => s.replace(/^"|"$/g, ""));
    const cols = split(header);
    const order = cols.map((_, i) => i).reverse();
    const quote = (cells: string[]) => order.map((i) => `"${cells[i] ?? ""}"`).join(",");
    const reversed = [quote(cols), ...rows.map((r) => quote(split(r)))].join("\n");
    expect(
      driveBcCameras(reversed)
        .map((c) => c.id)
        .sort((a, b) => a - b),
    ).toEqual(
      driveBcCameras(bcCsv)
        .map((c) => c.id)
        .sort((a, b) => a - b),
    );
  });

  test("Calgary and Austin: an empty list or a non-list is bad data", () => {
    for (const plugin of [calgaryTrafficCameras, austinTrafficCameras] as SourcePlugin[]) {
      rejects(plugin, { rows: [] });
      rejects(plugin, { rows: {} });
      rejects(plugin, { rows: null });
      rejects(plugin, { rows: "error" });
      rejects(plugin, {});
      // A Socrata error document instead of rows.
      rejects(plugin, { rows: { error: true, message: "Unknown column" } });
    }
  });

  test("fields of the wrong type are skipped where the plugin checks them", () => {
    const sg = sgFeed();
    const cams = sg.items?.[0]?.cameras ?? [];
    (cams[0] as Record<string, unknown>).camera_id = 1001;
    (cams[1].location as Record<string, unknown>).latitude = "1.3";
    expect(sgCameras(sg).length).toBe(cams.length - 2);

    const calgary = calgaryRows();
    (calgary[0].point as Record<string, unknown>).coordinates = ["-114", "51"];
    expect(calgaryCameras(calgary).length).toBe(calgary.length - 1);

    const austin = austinRows();
    (austin[0].location as Record<string, unknown>).coordinates = null;
    expect(austinCameras(austin).length).toBe(austin.length - 1);
  });
});

// BUG: each of these throws a TypeError out of the parser instead of skipping
// the row, and the runner then shows the whole provider as unreadable.
describe("one unreadable row among good ones", () => {
  test.fails("Singapore: a null camera entry is skipped", () => {
    const feed = sgFeed();
    feed.items?.[0]?.cameras?.unshift(null as never);
    expect(sgCameras(feed).length).toBe(8);
  });

  test.fails("Singapore: a camera list that is not a list is bad data, not a TypeError", () => {
    rejects(sgLtaTrafficCameras as SourcePlugin, { feed: { items: [{ cameras: {} }] } });
  });

  test.fails("Calgary: a null row is skipped", () => {
    expect(calgaryCameras([null as never, ...calgaryRows()]).length).toBe(8);
  });

  test.fails("Calgary: an image address that is not text is skipped", () => {
    const rows = calgaryRows();
    (rows[0].camera_url as Record<string, unknown>).url = 42;
    expect(calgaryCameras(rows).length).toBe(7);
  });

  test.fails("Austin: a null row is skipped", () => {
    expect(austinCameras([null as never, ...austinRows()]).length).toBe(8);
  });

  test.fails("Austin: a camera id sent as a number is read or skipped, not a crash", () => {
    const rows = austinRows();
    (rows[0] as Record<string, unknown>).camera_id = 1;
    expect(() => austinCameras(rows)).not.toThrow();
  });
});

describe("stored facts the panel trusts", () => {
  test("a detail panel from tampered meta shows nothing rather than a foreign image", () => {
    expect(sgCameraDetail({ cameraId: "4701", image: "https://evil.example/x.jpg" }).media).toEqual(
      [],
    );
    expect(calgaryDetail({ image: "https://trafficcam.calgary.ca/../loc1.jpg" })).toEqual({});
    expect(calgaryDetail({ image: "http://trafficcam.calgary.ca/loc1.jpg" })).toEqual({});
    expect(austinDetail({ cameraId: "1/../2" })).toEqual({});
    expect(driveBcDetail({ views: "../1:N" })).toEqual({});
    expect(driveBcDetail({})).toEqual({});
  });

  test("no plugin's detail asks the network except Singapore's one lookup", async () => {
    for (const { plugin, url, body } of PLUGINS) {
      const update = entities(plugin, await plugin.fetch?.(fakeContext({ [url]: body })));
      const meta = update.meta?.[0];
      const c = fakeContext({ [SG_TRAFFIC_IMAGES_API]: sgBody });
      await plugin.detail?.(update.columns.ids[0], meta, c);
      expect(c.requests.length, plugin.id).toBe(plugin === sgLtaTrafficCameras ? 1 : 0);
      // No meta: nothing to show, and no request.
      const empty = fakeContext({});
      expect(await plugin.detail?.(update.columns.ids[0], undefined, empty)).toEqual({});
      expect(empty.requests).toHaveLength(0);
    }
  });
});

describe("attribution, licence and polling", () => {
  test.each(PLUGINS)(
    "$plugin.id states its licence and credits the provider",
    ({ plugin, statement }) => {
      expect(plugin.attribution.text).toContain(statement);
      expect(plugin.attribution.url).toMatch(/^https:\/\//);
      expect(plugin.licence.url).toMatch(/^https:\/\//);
      expect(plugin.licence).toMatchObject({ display: true });
      expect(plugin.licence.verified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(plugin.licence.name.length).toBeGreaterThan(5);
      expect(plugin.docs).toMatch(/^https:\/\//);
      expect(plugin.requiresKey).toBeUndefined();
      expect(plugin.layer).toBe("webcams");
    },
  );

  test.each(PLUGINS)(
    "$plugin.id puts a credit on every image it shows",
    async ({ plugin, url, body }) => {
      const update = entities(plugin, await plugin.fetch?.(fakeContext({ [url]: body })));
      expect(update.kind).toBe(EntityKind.Webcam);
      expect(update.count).toBeGreaterThan(0);
      for (let i = 0; i < update.count; i++) {
        const detail = await plugin.detail?.(
          update.columns.ids[i],
          update.meta?.[i],
          fakeContext({ [SG_TRAFFIC_IMAGES_API]: sgBody }),
        );
        expect(detail?.attribution).toEqual(plugin.attribution);
        expect(detail?.sourceUrl).toMatch(/^https:\/\//);
        const media = detail?.media as DetailMedia[];
        expect(media.length).toBeGreaterThan(0);
        for (const m of media) {
          expect(m.type).toBe("image");
          expect(m.url).toMatch(/^https:\/\/[^/]+\/.+\.jpg$/);
          expect(m.credit?.length).toBeGreaterThan(5);
          expect(m.link).toMatch(/^https:\/\//);
          expect(m.alt?.length).toBeGreaterThan(5);
        }
      }
    },
  );

  test.each(PLUGINS)(
    "$plugin.id polls no faster than its provider allows, with one request a poll",
    async ({ plugin, url, body, minRefreshMs }) => {
      expect(plugin.refreshRate).toBeGreaterThanOrEqual(minRefreshMs);
      // A view-aware source would refetch on every pan; these lists are fetched whole.
      expect(plugin.viewAware).toBeFalsy();
      expect(plugin.transport).toBe("fetch");
      const c = fakeContext({ [url]: body });
      await plugin.fetch?.(c);
      expect(c.requests.map((r) => r.url)).toEqual([url]);
    },
  );

  test("data.gov.sg's 6 requests per 10 seconds leave room for camera lookups", () => {
    // One list poll every refresh plus one lookup per selected camera: the
    // poll alone must use a sliver of the allowance.
    const pollsPer10s = 10_000 / sgLtaTrafficCameras.refreshRate;
    expect(pollsPer10s).toBeLessThan(0.1);
  });

  test("ids are unique within and across the four providers", async () => {
    const all: number[] = [];
    for (const { plugin, url, body } of PLUGINS) {
      const update = entities(plugin, await plugin.fetch?.(fakeContext({ [url]: body })));
      const ids = Array.from(update.columns.ids.subarray(0, update.count));
      expect(new Set(ids).size, plugin.id).toBe(ids.length);
      all.push(...ids);
    }
    expect(new Set(all).size).toBe(all.length);
  });
});
