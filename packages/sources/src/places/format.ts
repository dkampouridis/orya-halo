/**
 * The baked city gazetteer (`data/places.bin`), built from GeoNames by
 * `packages/sources/scripts/build-places.ts`.
 *
 * Layout, little-endian:
 *
 * | Offset | Size | Field |
 * |---|---|---|
 * | 0 | 4 | Magic, ASCII `OHPL` |
 * | 4 | 2 | `u16` format version, currently 1 |
 * | 6 | 2 | `u16` reserved, 0 |
 * | 8 | 4 | `u32` header length `H` in bytes |
 * | 12 | H | UTF-8 JSON, a `PlaceAssetHeader` |
 * | 12 + H | rest | Six columns, back to back, sizes in `header.sections` |
 *
 * Columns, each with `header.count` entries, cities ordered by country, then
 * region, then latitude so that neighbours in the file are neighbours on the
 * map and the deltas stay small:
 *
 * 1. `names`: UTF-8, entries separated by `\n`.
 * 2. `ascii`: UTF-8, separated by `\n`. GeoNames' ASCII spelling, stored only
 *    where folding the name (see `foldText`) does not already produce it;
 *    empty otherwise.
 * 3. `region`: zigzag LEB128 delta of the region index. Regions are numbered
 *    by walking `header.countries` in order; each country contributes one
 *    "no region" entry followed by its listed regions.
 * 4. `lon`: zigzag LEB128 delta of `round(lon * scale)`.
 * 5. `lat`: zigzag LEB128 delta of `round(lat * scale)`.
 * 6. `population`: unsigned LEB128.
 */

export const PLACE_MAGIC = "OHPL";
export const PLACE_FORMAT_VERSION = 1;
/** Coordinates are stored as integers of 1/1,000 degree, about 110 m. */
export const PLACE_SCALE = 1000;

/** `[ISO 3166 alpha-2 code, English name, region names]`. */
export type CountryEntry = [code: string, name: string, regions: string[]];

export interface PlaceAssetHeader {
  /** ISO date the asset was built. */
  generated: string;
  source: string;
  licence: string;
  attribution: string;
  count: number;
  scale: number;
  countries: CountryEntry[];
  /** Byte length of each column, in file order. */
  sections: {
    names: number;
    ascii: number;
    region: number;
    lon: number;
    lat: number;
    population: number;
  };
}

/** One city, as the build script hands it to `encodePlaces`. */
export interface PlaceInput {
  name: string;
  /** GeoNames `asciiname`. */
  ascii: string;
  /** ISO 3166 alpha-2. */
  country: string;
  /** Region (first-level division) name, or "" when unknown. */
  region: string;
  lon: number;
  lat: number;
  population: number;
}

/** The gazetteer in memory, column by column. */
export interface PlaceTable {
  count: number;
  names: string[];
  /** ASCII spelling where it differs from the folded name, else "". */
  ascii: string[];
  lon: Float32Array;
  lat: Float32Array;
  population: Uint32Array;
  /** Index into `regionNames` and `regionCountry`. */
  region: Uint16Array;
  /** Region name per region index; "" for a country's "no region" entry. */
  regionNames: string[];
  /** Index into `countryCodes` and `countryNames` per region index. */
  regionCountry: Uint16Array;
  countryCodes: string[];
  countryNames: string[];
}

/** Letters that Unicode decomposition leaves alone but people type as plain ASCII. */
const LETTER_FOLDS: Record<string, string> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  đ: "d",
  ð: "d",
  þ: "th",
  ł: "l",
  ı: "i",
  ħ: "h",
  ŧ: "t",
  ə: "a",
  ƒ: "f",
  ĸ: "k",
  ŋ: "n",
};

/**
 * Reduce text to what search compares: lower case, no diacritics, no
 * apostrophes, every other run of punctuation or space as one space.
 * "Saint-Étienne" becomes "saint etienne"; "N'Djamena" becomes "ndjamena".
 */
export function foldText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[ßæœøđðþłıħŧəƒĸŋ]/g, (ch) => LETTER_FOLDS[ch] ?? ch)
    .replace(/['’‘ʻʼ`´]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function zigzag(n: number): number {
  return n < 0 ? -2 * n - 1 : 2 * n;
}

function unzigzag(n: number): number {
  return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
}

function pushVarint(out: number[], value: number): void {
  let v = value;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
}

/**
 * Serialise cities to the asset layout. `countryNames` maps ISO codes to
 * English names; a code missing from it is shown as the code itself.
 */
export function encodePlaces(
  places: readonly PlaceInput[],
  countryNames: ReadonlyMap<string, string>,
  info: Pick<PlaceAssetHeader, "generated" | "source" | "licence" | "attribution">,
): Uint8Array {
  const regionsByCountry = new Map<string, Set<string>>();
  for (const place of places) {
    let set = regionsByCountry.get(place.country);
    if (!set) regionsByCountry.set(place.country, (set = new Set()));
    if (place.region) set.add(place.region);
  }
  const codes = [...regionsByCountry.keys()].sort();
  const countries: CountryEntry[] = [];
  const regionIndex = new Map<string, number>();
  let next = 0;
  for (const code of codes) {
    const regions = [...(regionsByCountry.get(code) ?? [])].sort();
    countries.push([code, countryNames.get(code) ?? code, regions]);
    regionIndex.set(`${code}\t`, next++);
    for (const region of regions) regionIndex.set(`${code}\t${region}`, next++);
  }
  const regionOf = (p: PlaceInput) => regionIndex.get(`${p.country}\t${p.region}`) as number;

  const ordered = [...places].sort(
    (a, b) =>
      regionOf(a) - regionOf(b) || a.lat - b.lat || a.lon - b.lon || a.name.localeCompare(b.name),
  );

  const encoder = new TextEncoder();
  const names = encoder.encode(ordered.map((p) => p.name.replace(/\n/g, " ")).join("\n"));
  const ascii = encoder.encode(
    ordered
      .map((p) => {
        const folded = foldText(p.ascii);
        return folded && folded !== foldText(p.name) ? p.ascii.replace(/\n/g, " ") : "";
      })
      .join("\n"),
  );
  const region: number[] = [];
  const lon: number[] = [];
  const lat: number[] = [];
  const population: number[] = [];
  let prevRegion = 0;
  let prevLon = 0;
  let prevLat = 0;
  for (const p of ordered) {
    const r = regionOf(p);
    const qLon = Math.round(p.lon * PLACE_SCALE);
    const qLat = Math.round(p.lat * PLACE_SCALE);
    pushVarint(region, zigzag(r - prevRegion));
    pushVarint(lon, zigzag(qLon - prevLon));
    pushVarint(lat, zigzag(qLat - prevLat));
    pushVarint(population, Math.max(0, Math.round(p.population)));
    prevRegion = r;
    prevLon = qLon;
    prevLat = qLat;
  }

  const header: PlaceAssetHeader = {
    ...info,
    count: ordered.length,
    scale: PLACE_SCALE,
    countries,
    sections: {
      names: names.length,
      ascii: ascii.length,
      region: region.length,
      lon: lon.length,
      lat: lat.length,
      population: population.length,
    },
  };
  const headerBytes = encoder.encode(JSON.stringify(header));
  const columns: ArrayLike<number>[] = [names, ascii, region, lon, lat, population];
  const total = columns.reduce((sum, c) => sum + c.length, 12 + headerBytes.length);

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = PLACE_MAGIC.charCodeAt(i);
  view.setUint16(4, PLACE_FORMAT_VERSION, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, headerBytes.length, true);
  out.set(headerBytes, 12);
  let offset = 12 + headerBytes.length;
  for (const column of columns) {
    out.set(column, offset);
    offset += column.length;
  }
  return out;
}

/** Parse the asset. Throws a plain `Error` when the bytes are not a place asset. */
export function decodePlaces(buffer: ArrayBuffer | Uint8Array): {
  header: PlaceAssetHeader;
  table: PlaceTable;
} {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (
    bytes.length < 12 ||
    String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== PLACE_MAGIC
  ) {
    throw new Error("Not a place asset: wrong magic bytes.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  if (version !== PLACE_FORMAT_VERSION) {
    throw new Error(
      `Place asset version ${version} is not supported (expected ${PLACE_FORMAT_VERSION}).`,
    );
  }
  const headerLength = view.getUint32(8, true);
  if (12 + headerLength > bytes.length) throw new Error("Place asset is truncated.");
  const decoder = new TextDecoder();
  const header = JSON.parse(
    decoder.decode(bytes.subarray(12, 12 + headerLength)),
  ) as PlaceAssetHeader;
  const { count, sections } = header;
  const scale = header.scale > 0 ? header.scale : PLACE_SCALE;

  let offset = 12 + headerLength;
  const take = (length: number): Uint8Array => {
    if (offset + length > bytes.length) throw new Error("Place asset is truncated.");
    const slice = bytes.subarray(offset, offset + length);
    offset += length;
    return slice;
  };
  const names = decoder.decode(take(sections.names)).split("\n");
  const ascii = decoder.decode(take(sections.ascii)).split("\n");
  if (names.length !== count || ascii.length !== count)
    throw new Error("Place asset is inconsistent: name count differs.");

  const readColumn = (column: Uint8Array, each: (value: number, index: number) => void): void => {
    let at = 0;
    for (let i = 0; i < count; i++) {
      let value = 0;
      let factor = 1;
      for (;;) {
        if (at >= column.length) throw new Error("Place asset is truncated.");
        const byte = column[at++];
        value += (byte & 0x7f) * factor;
        if (byte < 0x80) break;
        factor *= 0x80;
      }
      each(value, i);
    }
  };

  const region = new Uint16Array(count);
  const lon = new Float32Array(count);
  const lat = new Float32Array(count);
  const population = new Uint32Array(count);
  let acc = 0;
  readColumn(take(sections.region), (v, i) => {
    acc += unzigzag(v);
    region[i] = acc;
  });
  acc = 0;
  readColumn(take(sections.lon), (v, i) => {
    acc += unzigzag(v);
    lon[i] = acc / scale;
  });
  acc = 0;
  readColumn(take(sections.lat), (v, i) => {
    acc += unzigzag(v);
    lat[i] = acc / scale;
  });
  readColumn(take(sections.population), (v, i) => {
    population[i] = v;
  });

  const regionNames: string[] = [];
  const regionCountry: number[] = [];
  header.countries.forEach(([, , regions], countryIndex) => {
    regionNames.push("");
    regionCountry.push(countryIndex);
    for (const name of regions) {
      regionNames.push(name);
      regionCountry.push(countryIndex);
    }
  });

  return {
    header,
    table: {
      count,
      names,
      ascii,
      lon,
      lat,
      population,
      region,
      regionNames,
      regionCountry: Uint16Array.from(regionCountry),
      countryCodes: header.countries.map((c) => c[0]),
      countryNames: header.countries.map((c) => c[1]),
    },
  };
}
