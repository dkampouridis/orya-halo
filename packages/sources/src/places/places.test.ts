import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import { fixture, fixtureBytes } from "../shared/overlays/test-context.ts";
import {
  GEONAMES_ATTRIBUTION,
  GEONAMES_LICENCE,
  createPlaceIndex,
  decodePlaces,
  encodePlaces,
  foldText,
  prepareSearch,
  searchPlaces,
  zoomForPopulation,
} from "./index.ts";
import type { PlaceInput } from "./index.ts";

/** Real rows from GeoNames cities15000, picked by name. */
const sample = JSON.parse(fixture(import.meta.url, "fixtures/cities-sample.json")) as {
  countries: Record<string, string>;
  places: PlaceInput[];
};
const INFO = {
  generated: "2026-11-14",
  source: "GeoNames cities15000",
  licence: "CC BY 4.0",
  attribution: "© GeoNames",
};
const asset = encodePlaces(sample.places, new Map(Object.entries(sample.countries)), INFO);
const index = prepareSearch(decodePlaces(asset).table);
const search = (query: string, limit = 5, near?: { lon: number; lat: number }) =>
  searchPlaces(index, query, limit, near);
const titles = (query: string, limit = 5, near?: { lon: number; lat: number }) =>
  search(query, limit, near).map((r) => `${r.title} (${r.subtitle})`);

describe("foldText", () => {
  test("ignores case, diacritics, apostrophes and punctuation", () => {
    expect(foldText("Saint-Étienne")).toBe("saint etienne");
    expect(foldText("N'Djamena")).toBe("ndjamena");
    expect(foldText("N’Djaména")).toBe("ndjamena");
    expect(foldText("  REYKJAVÍK ")).toBe("reykjavik");
    expect(foldText("São Paulo, Brazil")).toBe("sao paulo brazil");
  });

  test("folds letters that Unicode does not decompose", () => {
    expect(foldText("Łódź")).toBe("lodz");
    expect(foldText("Ålesund")).toBe("alesund");
    expect(foldText("Tromsø")).toBe("tromso");
    expect(foldText("Straße")).toBe("strasse");
    expect(foldText("Ærø")).toBe("aero");
  });

  test("keeps non-Latin letters and digits", () => {
    expect(foldText("東京 23")).toBe("東京 23");
  });
});

describe("place asset format", () => {
  test("round-trips every city", () => {
    const { header, table } = decodePlaces(asset);
    expect(header).toMatchObject({ ...INFO, count: sample.places.length, scale: 1000 });
    expect(table.count).toBe(sample.places.length);

    for (const place of sample.places) {
      const i = table.names.findIndex(
        (name, k) =>
          name === place.name &&
          table.population[k] === place.population &&
          Math.abs(table.lat[k] - place.lat) < 0.001,
      );
      expect(i, place.name).toBeGreaterThanOrEqual(0);
      expect(table.lon[i]).toBeCloseTo(place.lon, 2);
      expect(table.lat[i]).toBeCloseTo(place.lat, 2);
      expect(table.regionNames[table.region[i]]).toBe(place.region);
      const country = table.regionCountry[table.region[i]];
      expect(table.countryCodes[country]).toBe(place.country);
      expect(table.countryNames[country]).toBe(sample.countries[place.country]);
    }
  });

  test("stores the ASCII spelling only where folding the name does not give it", () => {
    const { table } = decodePlaces(asset);
    const asciiOf = (name: string) => table.ascii[table.names.indexOf(name)];
    expect(asciiOf("Mülheim")).toBe("Muelheim");
    expect(asciiOf("Łódź")).toBe("");
    expect(asciiOf("Saint-Étienne")).toBe("");
    expect(asciiOf("Helsinki")).toBe("");
  });

  test("starts with the documented magic and version", () => {
    expect(String.fromCharCode(...asset.subarray(0, 4))).toBe("OHPL");
    expect(new DataView(asset.buffer).getUint16(4, true)).toBe(1);
  });

  test("refuses bytes that are not a place asset", () => {
    expect(() =>
      decodePlaces(new TextEncoder().encode("<!doctype html><title>404</title>")),
    ).toThrowError(/magic/);
    expect(() => decodePlaces(asset.subarray(0, asset.length - 5))).toThrowError(/truncated/);
  });
});

describe("searchPlaces", () => {
  test("returns place results with a country subtitle and a zoom", () => {
    const [first] = search("helsinki");
    expect(first).toMatchObject({
      type: "place",
      title: "Helsinki",
      subtitle: "Uusimaa, Finland",
      zoom: 11,
    });
    expect(first.lon).toBeCloseTo(24.935, 2);
    expect(first.lat).toBeCloseTo(60.17, 2);
    expect(first.score).toBeGreaterThan(0);
    expect(first.ref).toBeUndefined();
  });

  test("ranks same-named cities by population", () => {
    expect(titles("paris", 2)).toEqual([
      "Paris (Île-de-France, France)",
      "Paris (Texas, United States)",
    ]);
    expect(titles("london", 2)).toEqual([
      "London (England, United Kingdom)",
      "London (Ontario, Canada)",
    ]);
  });

  test("puts an exact name above a longer name that merely starts with the query", () => {
    // Newcastle (New South Wales) is exact; Newcastle upon Tyne is only a prefix match.
    const results = titles("newcastle", 4);
    expect(results.slice(0, 2).sort()).toEqual([
      "Newcastle (KwaZulu-Natal, South Africa)",
      "Newcastle (New South Wales, Australia)",
    ]);
    expect(results.slice(2)).toEqual([
      "Newcastle upon Tyne (England, United Kingdom)",
      "Newcastle under Lyme (England, United Kingdom)",
    ]);
  });

  test("matches while typing", () => {
    expect(titles("hels", 1)).toEqual(["Helsinki (Uusimaa, Finland)"]);
    expect(titles("new yo", 1)).toEqual(["New York City (New York, United States)"]);
    expect(titles("los ang", 1)).toEqual(["Los Angeles (California, United States)"]);
  });

  test("matches a word inside the name, below names that start with the query", () => {
    const results = titles("york", 5);
    expect(results[0]).toBe("York (England, United Kingdom)");
    expect(results).toContain("New York City (New York, United States)");
    expect(results.indexOf("Yorkton (Saskatchewan, Canada)")).toBeLessThan(
      results.indexOf("New York City (New York, United States)"),
    );
  });

  test("ignores case and diacritics in both directions", () => {
    expect(titles("LODZ", 1)).toEqual(["Łódź (Łódź Voivodeship, Poland)"]);
    expect(titles("łódź", 1)).toEqual(["Łódź (Łódź Voivodeship, Poland)"]);
    expect(titles("saint etienne", 1)).toEqual(["Saint-Étienne (Auvergne-Rhône-Alpes, France)"]);
    expect(titles("ndjamena", 1)[0]).toContain("N'Djamena");
    expect(titles("n'djamena", 1)[0]).toContain("N'Djamena");
    expect(titles("reykjavik", 1)[0]).toContain("Reykjavík");
    expect(titles("alesund", 1)[0]).toContain("Ålesund");
  });

  test("finds a city by its ASCII spelling", () => {
    expect(titles("muelheim", 1)[0]).toContain("Mülheim");
    expect(titles("mulheim", 1)[0]).toContain("Mülheim");
  });

  test("narrows by region or country words", () => {
    expect(titles("paris texas", 1)).toEqual(["Paris (Texas, United States)"]);
    expect(titles("springfield illinois", 1)).toEqual(["Springfield (Illinois, United States)"]);
    expect(titles("london, canada", 1)).toEqual(["London (Ontario, Canada)"]);
    // The capital is in a province of the same name, which the subtitle does not repeat.
    expect(titles("san jose cr", 1)).toEqual(["San José (Costa Rica)"]);
    expect(titles("athens gr", 1)).toEqual(["Athens (Attica, Greece)"]);
  });

  test("never lets a region-assisted match outrank a name that covers the whole query", () => {
    // "new" could come from New South Wales, New Jersey or New York state; the city named New ... wins.
    expect(titles("new york", 1)).toEqual(["New York City (New York, United States)"]);
    expect(titles("new delhi", 1)).toEqual(["New Delhi (Delhi, India)"]);
  });

  test("gives a slight boost to places near the user, not enough to beat a much bigger city", () => {
    const illinois = { lon: -89.65, lat: 39.8 };
    expect(titles("springfield", 1)).toEqual(["Springfield (Missouri, United States)"]);
    expect(titles("springfield", 1, illinois)).toEqual(["Springfield (Illinois, United States)"]);
    // Standing in Paris, Texas still finds Paris, France first: 86 times the population.
    expect(titles("paris", 1, { lon: -95.55, lat: 33.66 })).toEqual([
      "Paris (Île-de-France, France)",
    ]);
  });

  test("does not repeat a region that only echoes the city or country", () => {
    expect(titles("luxembourg", 1)).toEqual(["Luxembourg (Luxembourg)"]);
    expect(titles("tokyo", 1)).toEqual(["Tokyo (Japan)"]);
  });

  test("returns nothing for an empty query, no match, or a zero limit", () => {
    expect(search("")).toEqual([]);
    expect(search("  ,. ")).toEqual([]);
    expect(search("zzzzqq")).toEqual([]);
    expect(search("paris", 0)).toEqual([]);
    expect(search("paris moon")).toEqual([]);
  });

  test("honours the limit and orders by score", () => {
    const results = search("s", 3);
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.score)).toEqual(results.map((r) => r.score).sort((a, b) => b - a));
  });
});

describe("zoomForPopulation", () => {
  test("frames a metropolis wider than a town", () => {
    expect(zoomForPopulation(9_000_000)).toBe(9);
    expect(zoomForPopulation(2_000_000)).toBe(10);
    expect(zoomForPopulation(650_000)).toBe(11);
    expect(zoomForPopulation(100_000)).toBe(12);
    expect(zoomForPopulation(16_000)).toBe(13);
  });
});

describe("createPlaceIndex", () => {
  const fetchFake = (calls: string[], respond: () => Response) =>
    (async (input: RequestInfo | URL) => {
      calls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return respond();
    }) as typeof fetch;

  test("does not download anything until the first search", async () => {
    const calls: string[] = [];
    const places = createPlaceIndex(
      "https://halo.example/app/",
      fetchFake(calls, () => new Response(asset as Uint8Array<ArrayBuffer>)),
    );
    expect(calls).toEqual([]);
    expect(places.loaded).toBe(false);

    // The first search starts the download and has nothing to return yet.
    expect(places.search("paris", 3)).toEqual([]);
    expect(calls).toEqual(["https://halo.example/app/data/places.bin"]);

    await places.load();
    expect(places.loaded).toBe(true);
    expect(places.search("paris", 1)[0]).toMatchObject({ type: "place", title: "Paris" });
    expect(calls).toHaveLength(1);
  });

  test("shares one download between overlapping callers", async () => {
    const calls: string[] = [];
    const places = createPlaceIndex(
      "/",
      fetchFake(calls, () => new Response(asset as Uint8Array<ArrayBuffer>)),
    );
    await Promise.all([places.load(), places.load(), places.load()]);
    expect(calls).toEqual(["/data/places.bin"]);
  });

  test("reports a failed download from load() and tries again next time", async () => {
    const calls: string[] = [];
    let fail = true;
    const places = createPlaceIndex(
      "/",
      fetchFake(calls, () =>
        fail
          ? new Response("nope", { status: 503 })
          : new Response(asset as Uint8Array<ArrayBuffer>),
      ),
    );
    await expect(places.load()).rejects.toThrowError(/HTTP 503/);
    // A search while the file is unreachable returns nothing and does not throw, now or later.
    expect(places.search("paris", 1)).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(places.loaded).toBe(false);

    fail = false;
    await places.load();
    expect(places.search("paris", 1)).toHaveLength(1);
    expect(calls).toHaveLength(3);
  });
});

describe("GeoNames credit", () => {
  test("is stated for the attribution page", () => {
    expect(GEONAMES_LICENCE).toMatchObject({
      name: "CC BY 4.0",
      display: true,
      verified: "2026-11-14",
    });
    expect(GEONAMES_ATTRIBUTION.url).toBe("https://www.geonames.org/");
  });
});

/** The file the app ships. Checked when present so a bad build cannot slip through. */
const shipped = new URL("../../../../apps/web/public/data/places.bin", import.meta.url);

describe.skipIf(!existsSync(fileURLToPath(shipped)))("the shipped place asset", () => {
  // Read inside the tests: a skipped suite still runs this callback.
  let cache: ReturnType<typeof decodePlaces> | undefined;
  const load = () =>
    (cache ??= decodePlaces(
      fixtureBytes(import.meta.url, "../../../../apps/web/public/data/places.bin"),
    ));

  test("holds tens of thousands of cities with sane positions", () => {
    const { header, table } = load();
    expect(header.count).toBeGreaterThan(25_000);
    expect(table.names).toHaveLength(header.count);
    for (let i = 0; i < table.count; i++) {
      if (Math.abs(table.lon[i]) > 180 || Math.abs(table.lat[i]) > 90 || table.names[i] === "") {
        throw new Error(`Bad city at index ${i}.`);
      }
    }
  });

  test("answers everyday searches", () => {
    const full = prepareSearch(load().table);
    const top = (query: string) => searchPlaces(full, query, 1)[0];
    expect(top("tokyo")).toMatchObject({ title: "Tokyo", subtitle: "Japan" });
    expect(top("sao paulo").title).toBe("São Paulo");
    expect(top("new york").title).toBe("New York City");
    expect(top("athens").subtitle).toContain("Greece");
    expect(top("kobenhavn") ?? top("copenhagen")).toBeDefined();
  });

  test("searches the whole gazetteer quickly enough to run on every keystroke", () => {
    const full = prepareSearch(load().table);
    const started = performance.now();
    for (const query of ["s", "san", "san f", "new", "berl", "los angeles california"])
      searchPlaces(full, query, 8);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
