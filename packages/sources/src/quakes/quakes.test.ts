import { readFileSync } from "node:fs";
import { EntityKind, hashId } from "@orya-halo/schema";
import type { EntityUpdate, HaloEvent } from "@orya-halo/schema";
import { describe, expect, test } from "vite-plus/test";
import { fakeContext } from "../shared/space-earth/testing.ts";
import {
  USGS_FEEDS,
  alertLevel,
  mergeFeeds,
  quakeSeverity,
  quakeTitle,
  usgsQuakes,
} from "./index.ts";
import type { QuakesRaw, UsgsFeed } from "./index.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

// Recorded from earthquake.usgs.gov on 2026-11-14 at 15:20 UTC and trimmed.
const ALL_DAY = fixture("all_day.json");
const M45_WEEK = fixture("4.5_week.json");
const SIGNIFICANT_WEEK = fixture("significant_week.json");
const RAW: QuakesRaw = {
  feeds: [ALL_DAY, M45_WEEK, SIGNIFICANT_WEEK].map((text) => JSON.parse(text) as UsgsFeed),
};

/** When the feeds were generated. */
const NOW = 1_794_669_607_000;
/** M5.5 on the northern Mid-Atlantic Ridge, 2026-11-14T09:26:13Z. */
const RIDGE_QUAKE = { id: "us7000ty84", time: 1_794_648_373_073 };

function run(now: number, raw: QuakesRaw = RAW): { update: EntityUpdate; events: HaloEvent[] } {
  const out = usgsQuakes.normalise(raw, { now: () => now });
  if (out.type !== "entities") throw new Error("expected entities");
  return { update: out.update, events: out.events ?? [] };
}

const indexOf = (update: EntityUpdate, usgsId: string) =>
  update.columns.ids.indexOf(hashId(usgsId));

describe("normalise", () => {
  test("merges the three feeds without duplicates and leaves out non-earthquakes", () => {
    const { update } = run(NOW);
    // 16 in the day file, 3 of them blasts; 9 in the week file, 4 already in the day file;
    // the significant one is already in the week file.
    expect(update.count).toBe(18);
    expect(update).toMatchObject({
      kind: EntityKind.Quake,
      source: "usgs-quakes",
      timeMs: NOW,
      full: true,
    });
    expect(new Set(update.columns.ids).size).toBe(18);
    for (const column of Object.values(update.columns)) expect(column.length).toBe(18);
    expect(update.meta?.length).toBe(18);
    for (const blast of ["ci41361759", "mb90212658", "uw714138941"])
      expect(indexOf(update, blast)).toBe(-1);
    // Oldest first, so the newest is drawn last.
    for (let i = 1; i < update.count; i++) {
      expect(update.columns.fixTimeMs[i]).toBeGreaterThanOrEqual(update.columns.fixTimeMs[i - 1]);
    }
  });

  test("maps one recorded event field by field", () => {
    const { update } = run(NOW);
    // us7000tx16: M 6.4 - 30 km WSW of Lata, Solomon Islands, 17 km deep, PAGER green.
    const i = indexOf(update, "us7000tx16");
    expect(i).toBeGreaterThanOrEqual(0);
    const c = update.columns;
    expect(c.lon[i]).toBeCloseTo(165.5616, 3);
    expect(c.lat[i]).toBeCloseTo(-10.8669, 3);
    expect(c.alt[i]).toBe(-17_000);
    expect(c.fixTimeMs[i]).toBe(1_794_195_299_466);
    expect(c.value[i]).toBeCloseTo(6.4, 5);
    expect(c.category[i]).toBe(1);
    expect(c.speed[i]).toBe(0);
    expect(Number.isNaN(c.heading[i])).toBe(true);
    expect(update.meta?.[i]).toEqual({
      label: "30 km WSW of Lata, Solomon Islands",
      magnitude: 6.4,
      magType: "mww",
      depthKm: 17,
      timeMs: 1_794_195_299_466,
      felt: 2,
      alert: "green",
      tsunami: false,
      significance: 631,
      status: "reviewed",
      url: "https://earthquake.usgs.gov/earthquakes/eventpage/us7000tx16",
    });
  });

  test("events without an alert get category 0 and null fields stay null", () => {
    const { update } = run(NOW);
    const i = indexOf(update, "ci41362063");
    expect(update.columns.category[i]).toBe(0);
    expect(update.meta?.[i]).toMatchObject({
      label: "5 km W of Holtville, CA",
      felt: null,
      alert: null,
      tsunami: false,
    });
    expect(update.columns.alt[i]).toBeLessThan(0);
  });

  test("keeps the most recently updated copy of an event", () => {
    const day = JSON.parse(ALL_DAY) as UsgsFeed;
    const week = JSON.parse(M45_WEEK) as UsgsFeed;
    const inDay = day.features.find((f) => f.id === RIDGE_QUAKE.id);
    const inWeek = week.features.find((f) => f.id === RIDGE_QUAKE.id);
    if (!inDay || !inWeek) throw new Error("fixture changed");
    inWeek.properties.mag = 5.7;
    inWeek.properties.updated = (inDay.properties.updated ?? 0) + 60_000;
    const merged = mergeFeeds([day, week], NOW);
    expect(merged.find((f) => f.id === RIDGE_QUAKE.id)?.properties.mag).toBe(5.7);
    // And the other way round: the stale copy loses whichever feed it sits in.
    inWeek.properties.updated = (inDay.properties.updated ?? 0) - 60_000;
    expect(mergeFeeds([day, week], NOW).find((f) => f.id === RIDGE_QUAKE.id)?.properties.mag).toBe(
      5.5,
    );
  });

  test("hides events that have not happened yet at a scrubbed time", () => {
    const before = run(RIDGE_QUAKE.time - 1);
    expect(indexOf(before.update, RIDGE_QUAKE.id)).toBe(-1);
    const after = run(RIDGE_QUAKE.time);
    expect(indexOf(after.update, RIDGE_QUAKE.id)).toBeGreaterThanOrEqual(0);
    expect(after.update.count).toBe(before.update.count + 1);
  });

  test("tolerates malformed features", () => {
    const feed = {
      features: [
        null,
        {
          id: "x1",
          properties: { mag: null, place: "nowhere", time: NOW - 1000, type: "earthquake" },
          geometry: { type: "Point", coordinates: [1, 2, 3] },
        },
        {
          id: "x2",
          properties: { mag: 3, place: "nowhere", time: NOW - 1000, type: "earthquake" },
          geometry: null,
        },
        {
          id: "x3",
          properties: { mag: 3, place: "nowhere", time: NOW - 1000, type: "earthquake" },
          geometry: { type: "Point", coordinates: [1, 95, 3] },
        },
        {
          id: "x4",
          properties: { mag: 3, place: null, time: NOW - 1000, type: "earthquake" },
          geometry: { type: "Point", coordinates: [190, 2, null] },
        },
      ],
    } as unknown as UsgsFeed;
    const { update } = run(NOW, { feeds: [feed, undefined as unknown as UsgsFeed] });
    expect(update.count).toBe(1);
    expect(update.columns.ids[0]).toBe(hashId("x4"));
    expect(update.columns.lon[0]).toBeCloseTo(-170, 5);
    expect(update.columns.alt[0]).toBe(-0);
    expect(update.meta?.[0]).toMatchObject({
      label: "Unnamed location",
      url: "https://earthquake.usgs.gov/earthquakes/eventpage/x4",
    });
    expect(run(NOW, { feeds: [] }).update.count).toBe(0);
  });
});

describe("ticker events", () => {
  test("nothing above M4.5 in the last hour at the recorded moment", () => {
    // The newest M4.5+ in the sample was six hours old when it was recorded.
    expect(run(NOW).events).toEqual([]);
  });

  test("a M5.5 twenty minutes ago makes one stable, clickable line", () => {
    const now = RIDGE_QUAKE.time + 20 * 60_000;
    const { update, events } = run(now);
    expect(events).toEqual([
      {
        id: "quake:us7000ty84",
        topic: "quake",
        timeMs: RIDGE_QUAKE.time,
        title: "M5.5 earthquake on the northern Mid-Atlantic Ridge",
        detail: "northern Mid-Atlantic Ridge, 10 km deep",
        lon: -42.6346,
        lat: 30.122,
        ref: { kind: EntityKind.Quake, id: hashId("us7000ty84") },
        severity: 0,
      },
    ]);
    // The event points at an entity in the same update.
    expect(update.columns.ids).toContain(events[0].ref?.id);
    // Same id a minute later, so the ticker collapses the repeat; gone after an hour.
    expect(run(now + 60_000).events[0].id).toBe("quake:us7000ty84");
    expect(run(RIDGE_QUAKE.time + 3_600_000).events.length).toBe(1);
    expect(run(RIDGE_QUAKE.time + 3_600_001).events).toEqual([]);
  });

  test("small quakes never make the ticker", () => {
    // ci41362063 is M2.3 and 87 seconds old at the recorded moment.
    const { update, events } = run(NOW);
    expect(indexOf(update, "ci41362063")).toBeGreaterThanOrEqual(0);
    expect(events.some((e) => e.id === "quake:ci41362063")).toBe(false);
  });

  test("titles read as plain sentences for each kind of USGS place", () => {
    expect(quakeTitle(6.4, "30 km WSW of Lata, Solomon Islands")).toBe(
      "M6.4 earthquake near Lata, Solomon Islands",
    );
    expect(quakeTitle(5.8, "79 km WSW of Changuillo, Peru")).toBe(
      "M5.8 earthquake near Changuillo, Peru",
    );
    expect(quakeTitle(5.2, "off the west coast of northern Sumatra")).toBe(
      "M5.2 earthquake off the west coast of northern Sumatra",
    );
    expect(quakeTitle(5.8, "central Mid-Atlantic Ridge")).toBe(
      "M5.8 earthquake on the central Mid-Atlantic Ridge",
    );
    expect(quakeTitle(5.2, "State of Yap, Federated States of Micronesia")).toBe(
      "M5.2 earthquake near State of Yap, Federated States of Micronesia",
    );
    expect(quakeTitle(6, "Fiji region")).toBe("M6.0 earthquake in the Fiji region");
    expect(quakeTitle(7.1, "South of the Fiji Islands")).toBe(
      "M7.1 earthquake south of the Fiji Islands",
    );
    expect(quakeTitle(5, "North Island of New Zealand")).toBe(
      "M5.0 earthquake near North Island of New Zealand",
    );
    expect(quakeTitle(4.5, null)).toBe("M4.5 earthquake");
    expect(quakeTitle(4.5, "  ")).toBe("M4.5 earthquake");
  });

  test("severity follows magnitude", () => {
    expect(quakeSeverity(4.5)).toBe(0);
    expect(quakeSeverity(5.9)).toBe(0);
    expect(quakeSeverity(6)).toBe(1);
    expect(quakeSeverity(6.9)).toBe(1);
    expect(quakeSeverity(7)).toBe(2);
    expect(quakeSeverity(9.1)).toBe(2);
  });

  test("PAGER alert colours map to category codes", () => {
    expect(
      [null, undefined, "", "green", "yellow", "orange", "red", "purple"].map(alertLevel),
    ).toEqual([0, 0, 0, 1, 2, 3, 4, 0]);
  });
});

describe("plugin", () => {
  const routes = {
    "summary/all_day.geojson": ALL_DAY,
    "summary/4.5_week.geojson": M45_WEEK,
    "summary/significant_week.geojson": SIGNIFICANT_WEEK,
  };

  test("fetches the three summary feeds once each", async () => {
    const ctx = fakeContext({ now: NOW, routes });
    const raw = await usgsQuakes.fetch?.(ctx);
    expect([...ctx.requests].sort()).toEqual(
      USGS_FEEDS.map(
        (name) => `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/${name}.geojson`,
      ).sort(),
    );
    expect(raw?.feeds.length).toBe(3);
    expect(run(NOW, raw).update.count).toBe(18);
  });

  test("carries on with the past-day feed when a weekly feed fails", async () => {
    const ctx = fakeContext({
      now: NOW,
      routes: {
        "summary/all_day.geojson": ALL_DAY,
        "summary/4.5_week.geojson": { status: 503, body: "busy" },
      },
    });
    const raw = await usgsQuakes.fetch?.(ctx);
    expect(raw?.feeds.length).toBe(1);
    expect(run(NOW, raw).update.count).toBe(13);
  });

  test("fails plainly when the past-day feed is missing or unreadable", async () => {
    const down = fakeContext({
      now: NOW,
      routes: { "summary/all_day.geojson": { status: 500, body: "" }, "4.5_week": M45_WEEK },
    });
    await expect(usgsQuakes.fetch?.(down)).rejects.toMatchObject({
      name: "SourceError",
      code: "http",
      status: 500,
    });
    const garbled = fakeContext({
      now: NOW,
      routes: { ...routes, "summary/all_day.geojson": "<html>" },
    });
    await expect(usgsQuakes.fetch?.(garbled)).rejects.toMatchObject({
      name: "SourceError",
      code: "bad-data",
    });
    const wrongShape = fakeContext({
      now: NOW,
      routes: { ...routes, "summary/all_day.geojson": '{"type":"FeatureCollection"}' },
    });
    await expect(usgsQuakes.fetch?.(wrongShape)).rejects.toMatchObject({
      name: "SourceError",
      code: "bad-data",
    });
  });

  test("polls at the feeds' own cadence", () => {
    // Regenerated every minute and served with Cache-Control: max-age=60.
    expect(usgsQuakes.refreshRate).toBe(60_000);
    expect(usgsQuakes.layer).toBe("quakes");
    expect(usgsQuakes.transport).toBe("fetch");
    expect(usgsQuakes.requiresKey).toBeUndefined();
    expect(usgsQuakes.attribution.text).toBe("Credit: U.S. Geological Survey");
    expect(usgsQuakes.licence).toMatchObject({
      display: true,
      redistribution: true,
      verified: "2026-11-14",
    });
  });

  test("detail links to the USGS event page", async () => {
    const { update } = run(NOW);
    const i = indexOf(update, "us7000tx16");
    const detail = await usgsQuakes.detail?.(
      update.columns.ids[i],
      update.meta?.[i],
      fakeContext({ now: NOW }),
    );
    expect(detail?.subtitle).toBe("Magnitude 6.4 (mww), 17 km deep, 2026-11-09 03:34 UTC");
    expect(detail?.sourceUrl).toBe("https://earthquake.usgs.gov/earthquakes/eventpage/us7000tx16");
    const rows = Object.fromEntries((detail?.fields ?? []).map((f) => [f.key, f]));
    expect(rows.magnitude).toMatchObject({ label: "Magnitude", value: "6.4", numeric: 6.4 });
    expect(rows.depthKm).toMatchObject({ value: "17", unit: "km" });
    expect(rows.felt.value).toBe("2");
    expect(rows.alert.value).toBe("green");
    expect(rows.tsunami.value).toBe("No");
    expect(rows.url).toBeUndefined();
    expect(rows.label).toBeUndefined();
    // Every meta key has a labelled schema field.
    const keys = new Set(usgsQuakes.schema.map((f) => f.key));
    for (const key of Object.keys(update.meta?.[i] ?? {})) expect(keys.has(key), key).toBe(true);
    expect(await usgsQuakes.detail?.(1, undefined, fakeContext({ now: NOW }))).toEqual({
      attribution: usgsQuakes.attribution,
    });
  });
});
