/**
 * Builds `apps/web/public/data/places.bin`, the offline city gazetteer, from
 * the GeoNames `cities15000` extract (every city over 15,000 people, plus
 * capitals).
 *
 *   vp node scripts/build-places.ts                    (from packages/sources)
 *   vp node scripts/build-places.ts --cache <dir>      keep or reuse the downloads in <dir>
 *
 * Three downloads, once: the cities archive, the region names and the country
 * names. Nothing personal is sent: the User-Agent names the project only.
 *
 * Data © GeoNames, CC BY 4.0 (https://download.geonames.org/export/dump/readme.txt).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, inflateRawSync } from "node:zlib";
import { decodePlaces, encodePlaces } from "../src/places/format.ts";
import type { PlaceInput } from "../src/places/format.ts";

const BASE = "https://download.geonames.org/export/dump/";
const USER_AGENT = "orya-halo-build/0.1 (open-source globe; places asset builder)";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = join(here, "..", "..", "..", "apps", "web", "public", "data", "places.bin");

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const cacheDir = arg("--cache");

async function download(file: string): Promise<Uint8Array> {
  const cached = cacheDir ? join(resolve(cacheDir), file) : undefined;
  if (cached && existsSync(cached)) return readFileSync(cached);
  console.log(`Downloading ${file} ...`);
  const response = await fetch(BASE + file, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`GeoNames answered HTTP ${response.status} for ${file}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (cached) {
    mkdirSync(dirname(cached), { recursive: true });
    writeFileSync(cached, bytes);
  }
  return bytes;
}

/** Pull one file out of a zip archive using its central directory. */
function unzipEntry(zip: Uint8Array, name: string): Uint8Array {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = zip.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error("Not a zip archive: no end-of-central-directory record.");
  const entries = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  for (let i = 0; i < entries; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("Corrupt zip central directory.");
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const entryName = decoder.decode(zip.subarray(at + 46, at + 46 + nameLength));
    if (entryName === name) {
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const data = zip.subarray(start, start + compressedSize);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      throw new Error(`Unsupported zip compression method ${method}.`);
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`${name} is not in the archive.`);
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const citiesText = text(unzipEntry(await download("cities15000.zip"), "cities15000.txt"));
const regionText = text(await download("admin1CodesASCII.txt"));
const countryText = text(await download("countryInfo.txt"));

// admin1CodesASCII.txt: "CC.code <tab> name <tab> ascii name <tab> geonameId".
const regionNames = new Map<string, string>();
for (const line of regionText.split("\n")) {
  const [code, name] = line.split("\t");
  if (code && name) regionNames.set(code, name.trim());
}

// countryInfo.txt: comment lines start with "#"; column 0 is the ISO code, column 4 the name.
const countryNames = new Map<string, string>();
for (const line of countryText.split("\n")) {
  if (line.startsWith("#")) continue;
  const cells = line.split("\t");
  if (cells[0] && cells[4]) countryNames.set(cells[0], cells[4].trim());
}

// cities15000.txt: the GeoNames "geoname" table, tab-separated, see the readme.
const places: PlaceInput[] = [];
let skipped = 0;
for (const line of citiesText.split("\n")) {
  if (!line) continue;
  const cells = line.split("\t");
  const lat = Number(cells[4]);
  const lon = Number(cells[5]);
  const country = cells[8];
  if (!cells[1] || !country || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    skipped++;
    continue;
  }
  places.push({
    name: cells[1],
    ascii: cells[2] ?? "",
    country,
    region: regionNames.get(`${country}.${cells[10]}`) ?? "",
    lon,
    lat,
    population: Number(cells[14]) || 0,
  });
}

const bytes = encodePlaces(places, countryNames, {
  generated: new Date().toISOString().slice(0, 10),
  source: "GeoNames cities15000",
  licence: "CC BY 4.0",
  attribution: "© GeoNames",
});

// Read the file back the way the app will, so a broken asset never reaches disk.
const check = decodePlaces(bytes);
if (check.table.count !== places.length)
  throw new Error("Round-trip check failed: city count differs.");

const out = resolve(arg("--out") ?? DEFAULT_OUT);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, bytes);

const { sections } = check.header;
console.log(
  `\nCities: ${places.length} (${skipped} unreadable lines skipped), countries: ${check.header.countries.length}`,
);
console.log(`Columns (bytes): ${JSON.stringify(sections)}`);
console.log(`Wrote ${out}`);
console.log(
  `  ${bytes.length.toLocaleString("en-GB")} bytes, ${gzipSync(bytes, { level: 9 }).length.toLocaleString("en-GB")} gzipped`,
);
