import { describe, expect, test } from "vite-plus/test";
import { EntityKind } from "@orya-halo/schema";
import type { SearchResult } from "@orya-halo/schema";
import { buildDetail, detailFields, mergeDetail, nearbyEntities } from "./detail.ts";
import {
  categoryName,
  convert,
  entitySubtitle,
  entityTitle,
  formatNumber,
  formatTime,
  idText,
} from "./format.ts";
import { mergeResults, searchStores } from "./search.ts";
import { EntityStore } from "./store.ts";
import { makeUpdate, randomUpdate } from "./testing.ts";

const A = EntityKind.Aircraft;
const S = EntityKind.Ship;
const T0 = 1_800_000_000_000;

function fleet(): EntityStore[] {
  const aircraft = new EntityStore(A);
  aircraft.apply(
    makeUpdate(A, "gateway", T0, [
      {
        id: 0x4ca123,
        lon: -6,
        lat: 53,
        meta: { label: "RYR4TK", registration: "EI-DCL", typeName: "Boeing 737-800" },
      },
      { id: 0x4ca999, lon: 12, lat: 41, meta: { label: "RYR81", registration: "EI-EKA" } },
      {
        id: 0x400abc,
        lon: 0,
        lat: 51,
        meta: { label: "BAW117", registration: "G-XWBA", operator: "British Airways" },
      },
      { id: 0x3c6444, lon: 8, lat: 50, meta: { label: "DLH400", registration: "D-AIRY" } },
      { id: 0xa0b1c2, lon: -74, lat: 40 },
    ]),
    T0,
  );
  const ships = new EntityStore(S);
  ships.apply(
    makeUpdate(S, "gateway", T0, [
      {
        id: 244660000,
        lon: 4,
        lat: 52,
        category: 3,
        meta: { label: "STENA HOLLANDICA", callsign: "PBMM", imo: "9419163" },
      },
      { id: 244120000, lon: 3, lat: 51, meta: { label: "MAERSK RYBNIK" } },
      { id: 311000123, lon: -80, lat: 25, meta: { label: "RYNDAM" } },
    ]),
    T0,
  );
  return [aircraft, ships];
}

const titles = (results: SearchResult[]) => results.map((r) => r.title);

describe("searchStores", () => {
  test("is case-insensitive and ranks prefix matches above substring matches", () => {
    const results = searchStores(fleet(), "Ry");
    // Labels that start with "ry" first (shorter is closer), then registrations, then mid-word hits.
    expect(titles(results)).toEqual(["RYR81", "RYNDAM", "RYR4TK", "MAERSK RYBNIK", "DLH400"]);
    expect(results[0].score).toBeGreaterThan(results[3].score);
    expect(results[3].score).toBeGreaterThan(results[4].score);
  });

  test("an exact match beats a longer name with the same prefix", () => {
    const results = searchStores(fleet(), "ryr81");
    expect(results[0]).toMatchObject({
      type: "entity",
      title: "RYR81",
      ref: { kind: A, id: 0x4ca999 },
      layer: "aircraft",
      score: 100,
    });
    expect(results).toHaveLength(1);
  });

  test("finds by registration, call sign and IMO number", () => {
    expect(titles(searchStores(fleet(), "g-xwba"))).toEqual(["BAW117"]);
    expect(titles(searchStores(fleet(), "pbmm"))).toEqual(["STENA HOLLANDICA"]);
    expect(titles(searchStores(fleet(), "9419163"))).toEqual(["STENA HOLLANDICA"]);
  });

  test("finds a word inside a name", () => {
    const results = searchStores(fleet(), "hollandica");
    expect(titles(results)).toEqual(["STENA HOLLANDICA"]);
    expect(results[0].score).toBeGreaterThan(40);
    expect(results[0].score).toBeLessThan(75);
  });

  test("matches ICAO addresses by hex prefix, exact match first", () => {
    expect(titles(searchStores(fleet(), "4ca"))).toEqual(["RYR4TK", "RYR81"]);
    expect(titles(searchStores(fleet(), "4CA999"))).toEqual(["RYR81"]);
    // An aircraft with no label is still findable, and named by its address.
    expect(titles(searchStores(fleet(), "a0b1"))).toEqual(["Aircraft A0B1C2"]);
  });

  test("matches MMSI by decimal prefix, and not ships by hex", () => {
    expect(titles(searchStores(fleet(), "2446"))).toEqual(["STENA HOLLANDICA"]);
    expect(titles(searchStores(fleet(), "244")).sort()).toEqual([
      "MAERSK RYBNIK",
      "STENA HOLLANDICA",
    ]);
    expect(titles(searchStores(fleet(), "311000123"))).toEqual(["RYNDAM"]);
    expect(searchStores(fleet(), "311000123")[0].score).toBe(96);
  });

  test("carries a subtitle and the position to fly to", () => {
    const [hit] = searchStores(fleet(), "ryr4");
    expect(hit).toMatchObject({ subtitle: "Boeing 737-800 · EI-DCL", lon: -6, lat: 53 });
    expect(searchStores(fleet(), "stena")[0].subtitle).toBe("Passenger ship");
  });

  test("returns nothing for a blank query or no match", () => {
    expect(searchStores(fleet(), "   ")).toEqual([]);
    expect(searchStores(fleet(), "zzzz")).toEqual([]);
  });

  test("caps the results and keeps the best", () => {
    const store = new EntityStore(A);
    store.apply(randomUpdate(A, "a", T0, 5000, 3, { labels: true }), T0);
    const results = searchStores([store], "ryr", 20);
    expect(results).toHaveLength(20);
    for (const result of results) expect(result.title.startsWith("RYR")).toBe(true);
    for (let i = 1; i < results.length; i++)
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    expect(searchStores([store], "ryr", 3)).toHaveLength(3);
  });

  test("puts nearer matches first among equals", () => {
    const stores = fleet();
    expect(titles(searchStores(stores, "4ca", 20, { lon: 12, lat: 41 }))[0]).toBe("RYR81");
    expect(titles(searchStores(stores, "4ca", 20, { lon: -6, lat: 53 }))[0]).toBe("RYR4TK");
  });

  test("follows entities as they arrive, change name and leave", () => {
    const store = new EntityStore(A);
    expect(searchStores([store], "klm")).toEqual([]);
    store.apply(
      makeUpdate(A, "a", T0, [
        { id: 1, meta: { label: "KLM1023" } },
        { id: 2, meta: { label: "KLM605" } },
      ]),
      T0,
    );
    expect(titles(searchStores([store], "klm"))).toEqual(["KLM605", "KLM1023"]);
    // The same airframe starts its next leg under a new callsign.
    store.mergeMeta(1, { label: "TRA6868" });
    expect(titles(searchStores([store], "klm"))).toEqual(["KLM605"]);
    expect(titles(searchStores([store], "tra"))).toEqual(["TRA6868"]);
    store.removeIds([2], "a");
    expect(searchStores([store], "klm")).toEqual([]);
    // The survivor was swapped into the freed index and is still found.
    expect(titles(searchStores([store], "6868"))).toEqual(["TRA6868"]);
  });
});

describe("mergeResults", () => {
  const entity = (id: number, title: string, score: number): SearchResult => ({
    type: "entity",
    ref: { kind: A, id },
    title,
    lon: 0,
    lat: 0,
    score,
  });
  const place = (title: string, score: number): SearchResult => ({
    type: "place",
    title,
    lon: 2.35,
    lat: 48.85,
    zoom: 9,
    score,
  });

  test("interleaves by score, keeps the first copy of a duplicate, and caps", () => {
    const merged = mergeResults([
      [entity(1, "local", 70)],
      [entity(1, "remote", 99), entity(2, "other", 60)],
      [place("Paris", 90), place("Paris", 90)],
    ]);
    expect(merged.map((r) => r.title)).toEqual(["Paris", "local", "other"]);
    expect(
      mergeResults([[entity(1, "a", 1), entity(2, "b", 2), entity(3, "c", 3)]], 2).map(
        (r) => r.title,
      ),
    ).toEqual(["c", "b"]);
  });
});

describe("detail", () => {
  test("assembles fields from columns and meta in schema order", () => {
    const store = new EntityStore(EntityKind.Quake);
    store.apply(
      makeUpdate(EntityKind.Quake, "usgs-quakes", T0, [
        {
          id: 77,
          lon: 142.37,
          lat: 38.32,
          alt: -29_000,
          value: 6.1,
          fixTimeMs: T0 - 600_000,
          meta: {
            label: "M 6.1 off the coast of Honshu",
            place: "112 km E of Sendai",
            depthKm: 29,
            felt: 412,
            tsunami: false,
            url: "https://earthquake.usgs.gov/x",
            updated: T0,
          },
        },
      ]),
      T0,
    );
    const fields = detailFields(store, 0, [
      { key: "value", label: "Magnitude", type: "number" },
      { key: "depthKm", label: "Depth", type: "number", unit: "km" },
      { key: "place", label: "Where", type: "string" },
      { key: "felt", label: "Felt reports", type: "number" },
      { key: "tsunami", label: "Tsunami warning", type: "boolean" },
      { key: "fixTimeMs", label: "Time", type: "time" },
      { key: "updated", label: "Updated", type: "time" },
      { key: "missing", label: "Not there", type: "string" },
      { key: "lat", label: "Latitude", type: "number", unit: "°" },
    ]);
    expect(fields).toEqual([
      { key: "value", label: "Magnitude", value: "6.1", numeric: expect.closeTo(6.1, 5) },
      { key: "depthKm", label: "Depth", value: "29", unit: "km", numeric: 29 },
      { key: "place", label: "Where", value: "112 km E of Sendai" },
      { key: "felt", label: "Felt reports", value: "412", numeric: 412 },
      { key: "tsunami", label: "Tsunami warning", value: "No" },
      { key: "fixTimeMs", label: "Time", value: formatTime(T0 - 600_000), numeric: T0 - 600_000 },
      { key: "updated", label: "Updated", value: formatTime(T0), numeric: T0 },
      {
        key: "lat",
        label: "Latitude",
        value: "38.3200",
        unit: "°",
        numeric: expect.closeTo(38.32, 4),
      },
    ]);
  });

  test("converts SI columns to the schema's display unit", () => {
    const store = new EntityStore(A);
    store.apply(
      makeUpdate(A, "x", T0, [{ id: 1, alt: 10_668, speed: 231.5, vrate: -5.08, heading: 271.4 }]),
      T0,
    );
    const fields = detailFields(store, 0, [
      { key: "alt", label: "Altitude", type: "number", unit: "ft" },
      { key: "altitude", label: "Altitude", type: "number", unit: "m" },
      { key: "speed", label: "Speed", type: "number", unit: "kt" },
      { key: "speed", label: "Speed", type: "number", unit: "km/h" },
      { key: "vrate", label: "Vertical rate", type: "number", unit: "ft/min" },
      { key: "heading", label: "Track", type: "number", unit: "°" },
    ]);
    expect(fields.map((f) => `${f.value} ${f.unit}`)).toEqual([
      "35,000 ft",
      "10,668 m",
      "450 kt",
      "833 km/h",
      "-1,000 ft/min",
      "271 °",
    ]);
    expect(fields[0].numeric).toBeCloseTo(35_000, 0);
  });

  test("leaves out an unknown heading rather than showing NaN", () => {
    const store = new EntityStore(A);
    store.apply(makeUpdate(A, "x", T0, [{ id: 1 }]), T0);
    expect(
      detailFields(store, 0, [{ key: "heading", label: "Track", type: "number", unit: "°" }]),
    ).toEqual([]);
  });

  test("builds the whole detail: heading, position, route, nearby, attribution", () => {
    const stores = fleet();
    const [aircraft] = stores;
    aircraft.mergeMeta(0x4ca123, { origin: "DUB", destination: "STN" });
    // Something close by, of another kind.
    stores[1].apply(
      makeUpdate(S, "gateway", T0, [
        { id: 250000001, lon: -6.1, lat: 53.3, meta: { label: "ULYSSES" } },
      ]),
      T0,
    );
    const detail = buildDetail(
      aircraft,
      aircraft.indexOf(0x4ca123),
      [{ key: "registration", label: "Registration", type: "string" }],
      { text: "adsb.lol", url: "https://adsb.lol" },
      stores,
    );
    expect(detail).toMatchObject({
      ref: { kind: A, id: 0x4ca123 },
      layer: "aircraft",
      title: "RYR4TK",
      subtitle: "Boeing 737-800 · EI-DCL",
      lon: -6,
      lat: 53,
      heading: null,
      fixTimeMs: T0,
      fields: [{ key: "registration", label: "Registration", value: "EI-DCL" }],
      origin: { code: "DUB" },
      destination: { code: "STN" },
      attribution: { text: "adsb.lol", url: "https://adsb.lol" },
    });
    expect(detail.nearby).toEqual([
      { ref: { kind: S, id: 250000001 }, label: "ULYSSES", distanceKm: expect.closeTo(34, 0) },
    ]);
    expect(detail.meta).toEqual(aircraft.meta[aircraft.indexOf(0x4ca123)]);
    expect(detail.meta).not.toBe(aircraft.meta[aircraft.indexOf(0x4ca123)]);
  });

  test("nearby is the closest few within range, nearest first, never the entity itself", () => {
    const store = new EntityStore(A);
    const rows = [];
    for (let i = 0; i < 40; i++)
      rows.push({ id: i + 1, lon: 10 + i * 0.1, lat: 45, meta: { label: `N${i}` } });
    rows.push({ id: 900, lon: -170, lat: 45, meta: { label: "far" } });
    store.apply(makeUpdate(A, "a", T0, rows), T0);
    const near = nearbyEntities([store], { kind: A, id: 1 }, 10, 45, 5, 150);
    expect(near.map((n) => n.label)).toEqual(["N1", "N2", "N3", "N4", "N5"]);
    expect(near[0].distanceKm).toBeCloseTo(7.9, 0);
    expect(near.every((n, i) => i === 0 || n.distanceKm >= near[i - 1].distanceKm)).toBe(true);
    // Across the antimeridian is next door, not the other side of the world.
    const dateline = nearbyEntities([store], { kind: S, id: 0 }, 179.9, 45, 5, 100);
    expect(dateline.map((n) => n.label)).toEqual([]);
    store.apply(
      makeUpdate(A, "a", T0, [{ id: 901, lon: -179.9, lat: 45, meta: { label: "across" } }]),
      T0,
    );
    expect(
      nearbyEntities([store], { kind: S, id: 0 }, 179.9, 45, 5, 100).map((n) => n.label),
    ).toEqual(["across"]);
  });

  test("mergeDetail lays extras over the base and replaces fields by key", () => {
    const stores = fleet();
    const base = buildDetail(
      stores[0],
      0,
      [{ key: "registration", label: "Registration", type: "string" }],
      { text: "a", url: "" },
      stores,
    );
    const merged = mergeDetail(base, {
      subtitle: "Boeing 737-8AS",
      media: [{ type: "image", url: "https://example.org/p.jpg", alt: "EI-DCL on the apron" }],
      fields: [
        { key: "registration", label: "Registration", value: "EI-DCL (Ireland)" },
        { key: "built", label: "Built", value: "2004" },
      ],
      sourceUrl: "https://example.org/EI-DCL",
    });
    expect(merged.subtitle).toBe("Boeing 737-8AS");
    expect(merged.title).toBe(base.title);
    expect(merged.fields.map((f) => f.value)).toEqual(["EI-DCL (Ireland)", "2004"]);
    expect(merged.media).toHaveLength(1);
    expect(merged.sourceUrl).toBe("https://example.org/EI-DCL");
    expect(mergeDetail(base, undefined)).toBe(base);
  });
});

describe("format", () => {
  test("names entities that have no label by kind and id", () => {
    expect(entityTitle(A, 0xabc, undefined)).toBe("Aircraft 000ABC");
    expect(entityTitle(S, 244660000, {})).toBe("Ship 244660000");
    expect(entityTitle(EntityKind.Satellite, 25544, { name: "ISS (ZARYA)" })).toBe("ISS (ZARYA)");
    expect(idText(A, 0x4ca123)).toBe("4CA123");
  });

  test("falls back to the category for a subtitle", () => {
    expect(entitySubtitle(A, 6, undefined)).toBe("Helicopter");
    expect(entitySubtitle(S, 2, { country: "Liberia" })).toBe("Tanker · Liberia");
    expect(entitySubtitle(A, 0, undefined)).toBeUndefined();
    expect(categoryName(EntityKind.Satellite, 1)).toBe("Space station");
    expect(categoryName(EntityKind.Quake, 3)).toBe("");
  });

  test("formats numbers the way people read them", () => {
    expect(formatNumber(35000.4)).toBe("35,000");
    expect(formatNumber(1234567)).toBe("1,234,567");
    expect(formatNumber(42.26)).toBe("42.3");
    expect(formatNumber(6.1)).toBe("6.1");
    expect(formatNumber(6)).toBe("6");
    expect(formatNumber(-0.001)).toBe("0");
    expect(formatNumber(-1234.5)).toBe("-1,235");
    expect(formatNumber(38.32, 4)).toBe("38.3200");
    expect(formatNumber(Number.NaN)).toBe("");
  });

  test("converts between SI and display units, leaving unknown units alone", () => {
    expect(convert(100, "speed", "kt")).toBeCloseTo(194.38, 1);
    expect(convert(1000, "length", "ft")).toBeCloseTo(3280.84, 1);
    expect(convert(1852, "length", "nm")).toBeCloseTo(1, 6);
    expect(convert(5.08, "rate", "ft/min")).toBeCloseTo(1000, 0);
    expect(convert(7, "speed", "furlongs/fortnight")).toBe(7);
    expect(convert(7, "none", "m")).toBe(7);
  });

  test("formats times in UTC to the minute", () => {
    expect(formatTime(Date.UTC(2026, 10, 14, 9, 5, 59))).toBe("2026-11-14 09:05 UTC");
    expect(formatTime(Number.NaN)).toBe("");
  });
});
