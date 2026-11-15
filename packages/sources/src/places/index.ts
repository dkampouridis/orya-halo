/**
 * Offline city search over the baked GeoNames gazetteer.
 *
 * `createPlaceIndex` downloads nothing until the first search. Matching is
 * case- and diacritic-insensitive: a query matches a city when each of its
 * words starts a word of the city's name, and any words left over start a
 * word of its region or country ("paris fr", "springfield illinois").
 */
import type { Attribution, LicenceInfo, SearchResult } from "@orya-halo/schema";
import { assetUrl } from "../shared/overlays/http.ts";
import { decodePlaces, foldText } from "./format.ts";
import type { PlaceTable } from "./format.ts";

export {
  PLACE_FORMAT_VERSION,
  PLACE_MAGIC,
  PLACE_SCALE,
  decodePlaces,
  encodePlaces,
  foldText,
} from "./format.ts";
export type { CountryEntry, PlaceAssetHeader, PlaceInput, PlaceTable } from "./format.ts";

/** Path of the asset under the app's asset base. */
export const PLACES_ASSET = "data/places.bin";

export const GEONAMES_LICENCE: LicenceInfo = {
  name: "CC BY 4.0",
  url: "https://creativecommons.org/licenses/by/4.0/",
  display: true,
  redistribution: true,
  commercial: true,
  notes:
    "Attribution to GeoNames required. The baked file keeps name, country, region, position and population only.",
  verified: "2026-11-14",
};

export const GEONAMES_ATTRIBUTION: Attribution = {
  text: "Place names © GeoNames",
  url: "https://www.geonames.org/",
  onMap: false,
};

export interface PlaceIndex {
  /**
   * Best matches for `query`, highest score first. Synchronous: the first
   * call starts loading the gazetteer and returns nothing; call again when
   * `load()` has resolved, or simply await `load()` first.
   */
  search(query: string, limit: number, near?: { lon: number; lat: number }): SearchResult[];
  /** Fetch and decode the gazetteer. Safe to call repeatedly; a failed load is retried on the next call. */
  load(): Promise<void>;
  /** True once searches return results. */
  readonly loaded: boolean;
}

/** Match quality tiers. A tier always outranks population and nearness. */
const EXACT = 3;
const PREFIX = 2;
const WORD = 1;

const TIER_WEIGHT = 100;
/**
 * Added when the city's name covers the whole query. Worth every tier, so a
 * match that needed the region or country ("york" + "new" from New South
 * Wales) never outranks one that did not ("New York City").
 */
const NAME_ONLY_BONUS = 300;
/** Points per factor of ten in population; 40 million people score 38. */
const POPULATION_WEIGHT = 5;
/** Most a nearby city can gain: a little over one factor of ten in population. */
const NEAR_BONUS = 6;
const NEAR_SCALE_KM = 500;

const RAD = Math.PI / 180;

function distanceKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Zoom that frames a city of this size: wide for a metropolis, close for a town. */
export function zoomForPopulation(population: number): number {
  if (population >= 5_000_000) return 9;
  if (population >= 1_000_000) return 10;
  if (population >= 200_000) return 11;
  if (population >= 50_000) return 12;
  return 13;
}

interface Searchable {
  table: PlaceTable;
  /** Folded name per city, with a leading space so " word" finds word starts. */
  nameKeys: string[];
  /** Folded ASCII spelling where it differs, same form; "" otherwise. */
  asciiKeys: string[];
  /** Folded "region country code" per region index, same form. */
  contextKeys: string[];
}

function prepare(table: PlaceTable): Searchable {
  return {
    table,
    nameKeys: table.names.map((name) => ` ${foldText(name)}`),
    asciiKeys: table.ascii.map((name) => (name ? ` ${foldText(name)}` : "")),
    contextKeys: table.regionNames.map((region, i) => {
      const country = table.regionCountry[i];
      return ` ${foldText(`${region} ${table.countryNames[country]} ${table.countryCodes[country]}`)}`;
    }),
  };
}

/** Tier of `tokens` against one folded name, and which tokens it did not cover. */
function matchName(key: string, tokens: readonly string[], leftover: string[]): number {
  leftover.length = 0;
  let matched = "";
  for (const token of tokens) {
    if (key.includes(` ${token}`)) matched += ` ${token}`;
    else leftover.push(token);
  }
  if (matched === "") return 0;
  if (key === matched) return EXACT;
  if (key.startsWith(matched)) return PREFIX;
  return WORD;
}

/** Search a decoded gazetteer. Exported for tests and for callers that load the table themselves. */
export function searchPlaces(
  index: Searchable,
  query: string,
  limit: number,
  near?: { lon: number; lat: number },
): SearchResult[] {
  const folded = foldText(query);
  if (folded === "" || limit <= 0) return [];
  const tokens = folded.split(" ");
  const { table, nameKeys, asciiKeys, contextKeys } = index;

  const hits: { i: number; score: number }[] = [];
  const leftover: string[] = [];
  const leftoverAscii: string[] = [];
  for (let i = 0; i < table.count; i++) {
    let tier = matchName(nameKeys[i], tokens, leftover);
    let rest = leftover;
    if (asciiKeys[i] !== "") {
      const asciiTier = matchName(asciiKeys[i], tokens, leftoverAscii);
      if (asciiTier > tier || (asciiTier === tier && leftoverAscii.length < leftover.length)) {
        tier = asciiTier;
        rest = leftoverAscii;
      }
    }
    if (tier === 0) continue;
    if (rest.length > 0) {
      const context = contextKeys[table.region[i]];
      if (!rest.every((token) => context.includes(` ${token}`))) continue;
    }

    let score = tier * TIER_WEIGHT + Math.log10(table.population[i] + 1) * POPULATION_WEIGHT;
    if (rest.length === 0) score += NAME_ONLY_BONUS;
    if (near) {
      score +=
        NEAR_BONUS *
        Math.exp(-distanceKm(near.lon, near.lat, table.lon[i], table.lat[i]) / NEAR_SCALE_KM);
    }
    hits.push({ i, score });
  }

  hits.sort(
    (a, b) => b.score - a.score || table.population[b.i] - table.population[a.i] || a.i - b.i,
  );

  return hits.slice(0, limit).map(({ i, score }) => {
    const region = table.regionNames[table.region[i]];
    const country = table.countryNames[table.regionCountry[table.region[i]]];
    const name = table.names[i];
    // "Luxembourg, Luxembourg, Luxembourg" helps nobody.
    const showRegion = region !== "" && foldText(region) !== foldText(name) && region !== country;
    return {
      type: "place",
      title: name,
      subtitle: showRegion ? `${region}, ${country}` : country,
      lon: table.lon[i],
      lat: table.lat[i],
      zoom: zoomForPopulation(table.population[i]),
      score,
    };
  });
}

/** Wrap a decoded gazetteer for `searchPlaces`. */
export function prepareSearch(table: PlaceTable): Searchable {
  return prepare(table);
}

/**
 * City search backed by `data/places.bin` under `assetBase`. `fetch` is the
 * caller's fetch (the worker's, or a fake in tests).
 */
export function createPlaceIndex(assetBase: string, fetch: typeof globalThis.fetch): PlaceIndex {
  let ready: Searchable | undefined;
  let loading: Promise<void> | undefined;

  const load = (): Promise<void> => {
    if (ready) return Promise.resolve();
    loading ??= (async () => {
      try {
        const response = await fetch(assetUrl(assetBase, PLACES_ASSET));
        if (!response.ok)
          throw new Error(`The place data file could not be loaded (HTTP ${response.status}).`);
        ready = prepare(decodePlaces(await response.arrayBuffer()).table);
      } finally {
        // Cleared on success too: `ready` takes over, and a failure may be retried.
        loading = undefined;
      }
    })();
    return loading;
  };

  return {
    search(query, limit, near) {
      if (!ready) {
        // Search stays usable while offline: swallow the failure here, `load()` reports it.
        load().catch(() => {});
        return [];
      }
      return searchPlaces(ready, query, limit, near);
    },
    load,
    get loaded() {
      return ready !== undefined;
    },
  };
}
