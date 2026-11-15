import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import { EntityKind, layerDef } from "@orya-halo/schema";
import { fakeContext, fixture, fixtureBytes } from "../shared/overlays/test-context.ts";
import {
  DEFAULT_BUILD_OPTIONS,
  OVERPASS_QUERY,
  baseCableName,
  buildCables,
  nameKey,
  rejectReason,
} from "./build.ts";
import type { OverpassResponse, OverpassWay } from "./build.ts";
import { haversineKm } from "./geometry.ts";
import {
  UNNAMED_CABLE,
  cableDetail,
  cableId,
  decodeCables,
  encodeCables,
  osmCables,
} from "./index.ts";
import type { CableGeometry } from "./index.ts";

const INFO = {
  generated: "2026-11-14",
  osmBase: "2026-05-31T22:37:44Z",
  licence: "ODbL 1.0",
  attribution: "© OpenStreetMap contributors",
  toleranceM: 150,
};

const sample: CableGeometry[] = [
  {
    record: { n: "Alpha Link", o: "Example Telecom", km: 1234, w: 100, wd: "Q42" },
    paths: [
      [
        [170.12345, -10.5],
        [180, -10.25],
      ],
      [
        [-180, -10.25],
        [-170.00004, -9.99996],
      ],
    ],
  },
  {
    record: { n: "", km: 12, w: 200 },
    paths: [
      [
        [24.9384, 60.1699],
        [24.75, 59.44],
        [24.7, 59.4],
      ],
    ],
  },
];

describe("cable asset format", () => {
  test("round-trips paths, names and facts", () => {
    const { header, paths } = decodeCables(encodeCables(sample, INFO));
    expect(header).toMatchObject({ ...INFO, scale: 10_000 });
    expect(header.cables.map((c) => c.p)).toEqual([2, 1]);

    expect(paths.count).toBe(3);
    expect([...paths.startIndices]).toEqual([0, 2, 4, 7]);
    expect(paths.positions).toHaveLength(14);
    expect(paths.names).toEqual(["Alpha Link", "Alpha Link", UNNAMED_CABLE]);
    expect(paths.meta?.[0]).toEqual({
      label: "Alpha Link",
      operator: "Example Telecom",
      lengthKm: 1234,
      osmWay: 100,
      wikidata: "Q42",
      named: true,
    });
    expect(paths.meta?.[2]).toMatchObject({
      label: UNNAMED_CABLE,
      operator: null,
      wikidata: null,
      named: false,
    });
  });

  test("gives every path of a cable the same id, and different cables different ids", () => {
    const { paths } = decodeCables(encodeCables(sample, INFO));
    expect(paths.ids[0]).toBe(paths.ids[1]);
    expect(paths.ids[0]).toBe(cableId("Alpha Link", 100));
    expect(paths.ids[2]).toBe(cableId("", 200));
    expect(paths.ids[2]).not.toBe(paths.ids[0]);
  });

  test("stores positions to about 11 m", () => {
    const { paths } = decodeCables(encodeCables(sample, INFO));
    expect(paths.positions[0]).toBeCloseTo(170.1235, 3);
    expect(paths.positions[1]).toBeCloseTo(-10.5, 4);
    expect(paths.positions[2]).toBe(180);
    expect(paths.positions[4]).toBe(-180);
    expect(paths.positions[6]).toBeCloseTo(-170, 4);
    expect(paths.positions[12]).toBeCloseTo(24.7, 4);
    expect(paths.positions[13]).toBeCloseTo(59.4, 4);
  });

  test("starts with the documented magic, version and header length", () => {
    const bytes = encodeCables(sample, INFO);
    const view = new DataView(bytes.buffer);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("OHCB");
    expect(view.getUint16(4, true)).toBe(1);
    const headerLength = view.getUint32(8, true);
    expect(
      JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + headerLength))).cables,
    ).toHaveLength(2);
  });

  test("refuses bytes that are not a cable asset", () => {
    expect(() =>
      decodeCables(new TextEncoder().encode("<!doctype html><title>Not found</title>")),
    ).toThrowError(/magic/);
    const bytes = encodeCables(sample, INFO);
    expect(() => decodeCables(bytes.subarray(0, bytes.length - 3))).toThrowError(/truncated/);
    const wrongVersion = bytes.slice();
    wrongVersion[4] = 9;
    expect(() => decodeCables(wrongVersion)).toThrowError(/version 9/);
  });

  test("accepts an ArrayBuffer or a view into a larger buffer", () => {
    const bytes = encodeCables(sample, INFO);
    const padded = new Uint8Array(bytes.length + 8);
    padded.set(bytes, 8);
    expect(decodeCables(padded.subarray(8)).paths.count).toBe(3);
    expect(decodeCables(bytes.buffer as ArrayBuffer).paths.count).toBe(3);
  });
});

describe("selecting cables from OpenStreetMap", () => {
  const way = (
    tags: Record<string, string>,
    geometry = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 1 },
    ],
  ): OverpassWay => ({
    type: "way",
    id: 1,
    geometry,
    tags,
  });

  test("accepts each way submarine telecom cables are tagged", () => {
    expect(rejectReason(way({ communication: "line", location: "underwater" }))).toBeNull();
    expect(rejectReason(way({ communication: "line", submarine: "yes" }))).toBeNull();
    expect(rejectReason(way({ man_made: "submarine_cable" }))).toBeNull();
    expect(
      rejectReason(
        way({
          "seamark:type": "cable_submarine",
          "seamark:cable_submarine:category": "fibre_optic",
        }),
      ),
    ).toBeNull();
  });

  test("leaves out power cables, disused cables, areas and land lines", () => {
    expect(rejectReason(way({ communication: "line", power: "cable" }))).toBe("power");
    expect(
      rejectReason(
        way({ "seamark:type": "cable_submarine", "seamark:cable_submarine:category": "power" }),
      ),
    ).toBe("not telecom");
    expect(rejectReason(way({ communication: "line", submarine: "yes", disused: "yes" }))).toBe(
      "disused",
    );
    expect(
      rejectReason(way({ communication: "line", "seamark:cable_submarine:status": "not_in_use" })),
    ).toBe("disused");
    expect(rejectReason(way({ communication: "line", location: "underground" }))).toBe(
      "not underwater",
    );
    expect(rejectReason(way({ communication: "line", "seamark:type": "cable_area" }))).toBe(
      "not a cable line",
    );
    expect(
      rejectReason(
        way({ communication: "line" }, [
          { lat: 0, lon: 0 },
          { lat: 1, lon: 1 },
          { lat: 0, lon: 0 },
        ]),
      ),
    ).toBe("closed way");
    expect(rejectReason(way({ communication: "line" }, [{ lat: 0, lon: 0 }]))).toBe("no geometry");
  });

  test("strips segment labels from names", () => {
    expect(baseCableName("UK-GERMANY 5 - Seg 3")).toBe("UK-GERMANY 5");
    expect(baseCableName("Atlantic Crossing 1 (AC1)Seg.B1")).toBe("Atlantic Crossing 1 (AC1)");
    expect(baseCableName("Atlantic Crossing 1 (AC1) Seg. C")).toBe("Atlantic Crossing 1 (AC1)");
    expect(baseCableName("DANICE Seg.2")).toBe("DANICE");
    expect(baseCableName("SHEFA-2 Seg 7-1")).toBe("SHEFA-2");
    expect(baseCableName("SHEFA-2 Seg5")).toBe("SHEFA-2");
    expect(baseCableName("SEA-ME-WE 3 SEG 10.2")).toBe("SEA-ME-WE 3");
    expect(baseCableName("SEA ME WE3-S10.3")).toBe("SEA ME WE3");
    expect(baseCableName("UK-Denmark 4 - Seg 2 BT")).toBe("UK-Denmark 4");
  });

  test("keeps names that only look like they have a segment label", () => {
    expect(baseCableName("Segment 1")).toBe("Segment 1");
    expect(baseCableName("TAT 10B EAST SECTION")).toBe("TAT 10B EAST SECTION");
    expect(baseCableName("Segovia Link")).toBe("Segovia Link");
    expect(baseCableName("Apollo South")).toBe("Apollo South");
    expect(baseCableName("  Seabras-1 ")).toBe("Seabras-1");
  });

  test("gives differently written names of one cable the same key", () => {
    expect(nameKey("TAT 12")).toBe(nameKey("tat-12"));
    expect(nameKey("MAYA-1")).toBe(nameKey("Maya-1"));
    expect(nameKey("SEA ME WE3-S9")).toBe(nameKey("SEA-ME-WE 3 SEG 10.2"));
    expect(nameKey("Apollo North")).not.toBe(nameKey("Apollo South"));
  });

  test("asks Overpass for every tagging scheme in one query", () => {
    expect(OVERPASS_QUERY).toContain('way["communication"="line"]["location"="underwater"]');
    expect(OVERPASS_QUERY).toContain('way["man_made"="submarine_cable"]');
    expect(OVERPASS_QUERY).toContain("out tags geom");
    expect(OVERPASS_QUERY.match(/\[out:json\]/g)).toHaveLength(1);
  });
});

describe("building cables from a recorded Overpass response", () => {
  const response = JSON.parse(
    fixture(import.meta.url, "fixtures/overpass-sample.json"),
  ) as OverpassResponse;
  const { cables, stats } = buildCables(response, DEFAULT_BUILD_OPTIONS);
  const byName = (name: string) => cables.find((c) => c.record.n === name);

  test("counts what it left out and why", () => {
    expect(stats.waysIn).toBe(19);
    // One disused segment, a 138 kV power cable, a land line tagged power=minor_line, and two charted cable areas.
    expect(stats.rejected).toEqual({ disused: 1, power: 2, "closed way": 2 });
    expect(stats.waysKept).toBe(14);
    expect(stats.cables).toBe(cables.length);
  });

  test("stitches segments that share a base name into one cable", () => {
    const danice = byName("DANICE");
    expect(danice).toBeDefined();
    expect(byName("DANICE Seg.1")).toBeUndefined();
    expect(danice?.record.km).toBeGreaterThan(2000);
    expect(danice?.record.w).toBe(78425264);

    const shefa = byName("SHEFA-2");
    expect(shefa?.record.o).toBe("Foroya Tele");
    expect(shefa?.record.km).toBeGreaterThan(500);
  });

  test("names the members of a route relation after the relation", () => {
    const cable = byName("Sweden-Estonia (EE-S 1)");
    expect(cable).toBeDefined();
    expect(cable?.record.wd).toBe("Q123347502");
    expect(byName("Baltic Sea Submarine Cable")).toBeUndefined();
  });

  test("joins unnamed ways that touch and drops fragments too short to see", () => {
    const unnamed = cables.filter((c) => c.record.n === "");
    expect(unnamed).toHaveLength(1);
    expect(unnamed[0].paths).toHaveLength(1);
    expect(unnamed[0].record.w).toBe(186862032);
    expect(stats.tooShort).toBe(1);
  });

  test("sorts cables longest first and reports whole kilometres", () => {
    const lengths = cables.map((c) => c.record.km);
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
    expect(
      lengths.every((km) => Number.isInteger(km) && km >= DEFAULT_BUILD_OPTIONS.minCableKm),
    ).toBe(true);
  });

  test("leaves no long chord and no jump across the antimeridian in any path", () => {
    for (const cable of cables) {
      for (const path of cable.paths) {
        expect(path.length).toBeGreaterThanOrEqual(2);
        for (let i = 1; i < path.length; i++) {
          expect(haversineKm(path[i - 1], path[i])).toBeLessThan(112);
          expect(Math.abs(path[i][0] - path[i - 1][0])).toBeLessThan(180);
        }
      }
    }
  });

  test("simplifies: fewer vertices out than in", () => {
    const verticesIn = response.elements.reduce(
      (sum, e) => sum + ((e as OverpassWay).geometry?.length ?? 0),
      0,
    );
    expect(stats.vertices).toBeLessThan(verticesIn);
  });

  test("survives encoding", () => {
    const { paths } = decodeCables(encodeCables(cables, INFO));
    expect(paths.count).toBe(stats.paths);
    expect(paths.positions.length).toBe(stats.vertices * 2);
    expect(new Set(paths.ids).size).toBe(cables.length);
  });
});

describe("osmCables plugin", () => {
  const asset = encodeCables(sample, INFO);

  test("loads the asset from the app's own data folder", async () => {
    const ctx = fakeContext(
      { "https://halo.example/app/data/cables.bin": asset },
      { assetBase: "https://halo.example/app" },
    );
    const raw = await osmCables.fetch?.(ctx);
    expect(ctx.requests.map((r) => r.url)).toEqual(["https://halo.example/app/data/cables.bin"]);
    const output = osmCables.normalise(raw as ArrayBuffer, ctx);
    expect(output.type).toBe("paths");
    if (output.type !== "paths") return;
    expect(output.paths.count).toBe(3);
    expect(output.paths.names[0]).toBe("Alpha Link");
  });

  test("says so plainly when the asset is missing or is not the asset", async () => {
    const missing = fakeContext({});
    await expect(osmCables.fetch?.(missing)).rejects.toMatchObject({
      name: "SourceError",
      code: "http",
      status: 404,
    });
    const html = new TextEncoder().encode("<!doctype html>").buffer as ArrayBuffer;
    expect(() => osmCables.normalise(html, missing)).toThrowError(
      /cable data file could not be read/,
    );
  });

  test("builds the detail panel from a cable's facts", () => {
    const detail = cableDetail({
      label: "Alpha Link",
      operator: "Example Telecom",
      lengthKm: 1234,
      osmWay: 100,
      wikidata: "Q42",
      named: true,
    });
    expect(detail.title).toBe("Alpha Link");
    expect(detail.subtitle).toBe("Undersea cable · Example Telecom");
    expect(detail.sourceUrl).toBe("https://www.openstreetmap.org/way/100");
    expect(detail.fields).toEqual([
      { key: "operator", label: "Operator", value: "Example Telecom" },
      { key: "lengthKm", label: "Mapped length", value: "1,234", unit: "km", numeric: 1234 },
      { key: "wikidata", label: "Wikidata", value: "Q42" },
    ]);
    expect(detail.attribution?.text).toBe("© OpenStreetMap contributors");
  });

  test("describes an unnamed cable without inventing facts", () => {
    const detail = cableDetail({
      label: UNNAMED_CABLE,
      operator: null,
      lengthKm: 12,
      osmWay: 200,
      wikidata: null,
      named: false,
    });
    expect(detail.title).toBe("Unnamed cable");
    expect(detail.subtitle).toBe("Undersea telecommunications cable");
    expect(detail.fields?.map((f) => f.key)).toEqual(["lengthKm"]);
  });

  test("answers detail from the passed facts without a request", async () => {
    const ctx = fakeContext({});
    const detail = await osmCables.detail?.(1, { label: "Alpha Link", osmWay: 100 }, ctx);
    expect(detail?.title).toBe("Alpha Link");
    expect(ctx.requests).toHaveLength(0);
  });

  test("looks the cable up in the asset when no facts were passed", async () => {
    const ctx = fakeContext({ "https://halo.example/data/cables.bin": asset });
    const detail = await osmCables.detail?.(cableId("", 200), undefined, ctx);
    expect(detail?.sourceUrl).toBe("https://www.openstreetmap.org/way/200");
    expect(await osmCables.detail?.(12345, undefined, ctx)).toEqual({});
  });

  test("is a static source on the cables layer with OpenStreetMap's credit on the map", () => {
    expect(osmCables.layer).toBe("cables");
    expect(layerDef("cables").kind).toBe(EntityKind.Cable);
    expect(osmCables.transport).toBe("static");
    expect(osmCables.refreshRate).toBe(0);
    expect(osmCables.licence.name).toBe("ODbL 1.0");
    expect(osmCables.attribution).toEqual({
      text: "© OpenStreetMap contributors",
      url: "https://www.openstreetmap.org/copyright",
      onMap: true,
    });
  });
});

/** The file the app ships. Checked when present so a bad build cannot slip through. */
const shipped = new URL("../../../../apps/web/public/data/cables.bin", import.meta.url);

describe.skipIf(!existsSync(fileURLToPath(shipped)))("the shipped cable asset", () => {
  test("decodes, is a sensible size and never draws across the globe", () => {
    const bytes = fixtureBytes(import.meta.url, "../../../../apps/web/public/data/cables.bin");
    expect(bytes.length).toBeLessThan(1_000_000);
    const { header, paths } = decodeCables(bytes);
    expect(header.licence).toBe("ODbL 1.0");
    expect(header.cables.length).toBeGreaterThan(100);
    expect(paths.count).toBeGreaterThanOrEqual(header.cables.length);
    expect(new Set(paths.ids).size).toBe(header.cables.length);
    const p = paths.positions;
    for (let path = 0; path < paths.count; path++) {
      expect(paths.startIndices[path + 1] - paths.startIndices[path]).toBeGreaterThanOrEqual(2);
      for (let v = paths.startIndices[path] + 1; v < paths.startIndices[path + 1]; v++) {
        if (Math.abs(p[v * 2] - p[v * 2 - 2]) >= 180)
          throw new Error(`Path ${path} jumps across the antimeridian.`);
      }
    }
    for (let i = 0; i < p.length; i += 2) {
      if (Math.abs(p[i]) > 180 || Math.abs(p[i + 1]) > 90)
        throw new Error("Position outside the globe.");
    }
  });
});
