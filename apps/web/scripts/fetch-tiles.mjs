#!/usr/bin/env node
// Fetches the keyless base map: a whole-world Protomaps extract, zoom 0 to 5,
// into public/tiles/world.pmtiles (ignored by git).
//
//   node scripts/fetch-tiles.mjs [--maxzoom=5] [--build=YYYYMMDD] [--force]
//
// Why an extract and not a URL: Protomaps discourages hotlinking its daily
// builds ("you should copy the tileset to your own Cloud Storage") and the
// build bucket only answers CORS for localhost and Protomaps' own sites, so a
// deployed page cannot read it anyway. Zoom 0 to 5 is about 14 MiB, which fits
// under the 25 MiB per-file limit of Cloudflare Pages; zoom 6 (about 43 MiB)
// does not. Deeper zooms come from VITE_PMTILES_URL or VITE_PROTOMAPS_KEY at
// run time (see src/engine/map/tiles.ts).
//
// This does what `pmtiles extract <url> out.pmtiles --maxzoom=N` does, in
// plain Node so nothing has to be installed: the planet archive is clustered
// (tile data is stored in tile-id order), so zoom 0..N is one contiguous byte
// range at the start of the tile section. The script reads the header, the
// directories that cover those tile ids, then that range in a few large
// requests: under ten requests in total.
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

const BUILDS_INDEX = "https://build-metadata.protomaps.dev/builds.json";
const BUILD_BASE = "https://build.protomaps.com";
/** Cloudflare Pages refuses assets larger than this. */
const PAGES_LIMIT = 25 * 1024 * 1024;
const HEADER_SIZE = 127;
/** The spec requires header plus root directory to fit in the first 16 KiB. */
const ROOT_BUDGET = 16384 - HEADER_SIZE;
const CHUNK = 8 * 1024 * 1024;
const GZIP = 2;

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "public", "tiles");
const outFile = join(outDir, "world.pmtiles");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  }),
);
const maxZoom = Number(args.maxzoom ?? 5);

function fail(message) {
  console.error(`fetch-tiles: ${message}`);
  process.exit(1);
}

async function latestBuild() {
  if (args.build) return `${args.build}.pmtiles`;
  const res = await fetch(BUILDS_INDEX);
  if (!res.ok)
    fail(`could not read the build list (${res.status}). Pass --build=YYYYMMDD to skip it.`);
  const builds = await res.json();
  const keys = builds
    .map((b) => b.key)
    .filter((k) => /^\d{8}\.pmtiles$/.test(k))
    .sort();
  if (keys.length === 0) fail("the build list is empty. Pass --build=YYYYMMDD.");
  return keys[keys.length - 1];
}

let requests = 0;
async function range(url, offset, length) {
  requests++;
  const res = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
  if (res.status !== 206) fail(`expected a partial response from ${url}, got ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length !== length)
    fail(`short read at ${offset}: wanted ${length} bytes, got ${bytes.length}`);
  return bytes;
}

function readVarint(buf, state) {
  let value = 0;
  let shift = 1;
  for (;;) {
    const byte = buf[state.pos++];
    value += (byte & 0x7f) * shift;
    if (byte < 0x80) return value;
    shift *= 128;
  }
}

function writeVarint(out, value) {
  while (value >= 0x80) {
    out.push((value % 128) | 0x80);
    value = Math.floor(value / 128);
  }
  out.push(value);
}

/** PMTiles v3 directory: columns of tile-id deltas, run lengths, lengths, offsets. */
function parseDirectory(compressed) {
  const buf = gunzipSync(compressed);
  const state = { pos: 0 };
  const n = readVarint(buf, state);
  const entries = Array.from({ length: n }, () => ({
    tileId: 0,
    runLength: 0,
    length: 0,
    offset: 0,
  }));
  let id = 0;
  for (const e of entries) e.tileId = id += readVarint(buf, state);
  for (const e of entries) e.runLength = readVarint(buf, state);
  for (const e of entries) e.length = readVarint(buf, state);
  for (let i = 0; i < n; i++) {
    const v = readVarint(buf, state);
    entries[i].offset = v === 0 && i > 0 ? entries[i - 1].offset + entries[i - 1].length : v - 1;
  }
  return entries;
}

function serialiseDirectory(entries) {
  const out = [];
  writeVarint(out, entries.length);
  let last = 0;
  for (const e of entries) {
    writeVarint(out, e.tileId - last);
    last = e.tileId;
  }
  for (const e of entries) writeVarint(out, e.runLength);
  for (const e of entries) writeVarint(out, e.length);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const prev = entries[i - 1];
    writeVarint(out, i > 0 && e.offset === prev.offset + prev.length ? 0 : e.offset + 1);
  }
  return gzipSync(Buffer.from(out), { level: 9 });
}

/** Root directory alone when it fits; otherwise a root of pointers to leaf directories. */
function buildDirectories(entries) {
  const whole = serialiseDirectory(entries);
  if (whole.length <= ROOT_BUDGET) return { root: whole, leaves: Buffer.alloc(0) };
  for (let leafSize = 4096; leafSize >= 64; leafSize >>= 1) {
    const leaves = [];
    const pointers = [];
    let offset = 0;
    for (let i = 0; i < entries.length; i += leafSize) {
      const leaf = serialiseDirectory(entries.slice(i, i + leafSize));
      pointers.push({ tileId: entries[i].tileId, runLength: 0, length: leaf.length, offset });
      leaves.push(leaf);
      offset += leaf.length;
    }
    const root = serialiseDirectory(pointers);
    if (root.length <= ROOT_BUDGET) return { root, leaves: Buffer.concat(leaves) };
  }
  return fail("could not fit the root directory in 16 KiB.");
}

async function main() {
  if (existsSync(outFile) && !args.force) {
    const mb = (statSync(outFile).size / 1048576).toFixed(1);
    console.log(`fetch-tiles: ${outFile} already exists (${mb} MiB). Use --force to replace it.`);
    return;
  }
  if (!(Number.isInteger(maxZoom) && maxZoom >= 0 && maxZoom <= 7)) {
    fail("--maxzoom must be a whole number from 0 to 7 for a world extract.");
  }

  const build = await latestBuild();
  const url = `${BUILD_BASE}/${build}`;
  console.log(`fetch-tiles: extracting zoom 0 to ${maxZoom} from ${url}`);

  // Header and root directory always sit in the first 16 KiB.
  const head = await range(url, 0, 16384);
  if (head.subarray(0, 7).toString("latin1") !== "PMTiles" || head[7] !== 3)
    fail("not a PMTiles v3 archive.");
  const u64 = (at) => Number(head.readBigUInt64LE(at));
  const src = {
    rootOffset: u64(8),
    rootLength: u64(16),
    metaOffset: u64(24),
    metaLength: u64(32),
    leafOffset: u64(40),
    tileOffset: u64(56),
    clustered: head[96] === 1,
    internalCompression: head[97],
  };
  if (!src.clustered)
    fail("the source archive is not clustered; a contiguous extract is not possible.");
  if (src.internalCompression !== GZIP)
    fail("the source archive's directories are not gzip-compressed.");

  // Tile ids are assigned zoom by zoom, so everything up to maxZoom is below this id.
  const idLimit = (4 ** (maxZoom + 1) - 1) / 3;
  const rootEntries = parseDirectory(
    head.subarray(src.rootOffset, src.rootOffset + src.rootLength),
  );
  const entries = [];
  for (let i = 0; i < rootEntries.length; i++) {
    const e = rootEntries[i];
    if (e.tileId >= idLimit) break;
    if (e.runLength > 0) {
      entries.push(e);
      continue;
    }
    const leaf = parseDirectory(await range(url, src.leafOffset + e.offset, e.length));
    for (const t of leaf) if (t.tileId < idLimit) entries.push(t);
  }
  let dataEnd = 0;
  let addressed = 0;
  const contents = new Set();
  for (const e of entries) {
    if (e.runLength === 0) fail("nested leaf directories are not supported.");
    // A run of identical tiles (open ocean) may continue past the zoom limit.
    e.runLength = Math.min(e.runLength, idLimit - e.tileId);
    dataEnd = Math.max(dataEnd, e.offset + e.length);
    addressed += e.runLength;
    contents.add(e.offset);
  }
  if (entries.length === 0) fail("no tiles found.");

  const metadata = await range(url, src.metaOffset, src.metaLength);
  const parts = [];
  for (let at = 0; at < dataEnd; at += CHUNK) {
    parts.push(await range(url, src.tileOffset + at, Math.min(CHUNK, dataEnd - at)));
    process.stdout.write(
      `\rfetch-tiles: ${Math.min(100, Math.round(((at + CHUNK) / dataEnd) * 100))}% of ${(dataEnd / 1048576).toFixed(1)} MiB`,
    );
  }
  process.stdout.write("\n");
  const tiles = Buffer.concat(parts);

  const { root, leaves } = buildDirectories(entries);
  const header = Buffer.from(head.subarray(0, HEADER_SIZE));
  const put = (at, value) => header.writeBigUInt64LE(BigInt(value), at);
  const metaAt = HEADER_SIZE + root.length;
  const leavesAt = metaAt + metadata.length;
  const tilesAt = leavesAt + leaves.length;
  put(8, HEADER_SIZE);
  put(16, root.length);
  put(24, metaAt);
  put(32, metadata.length);
  put(40, leavesAt);
  put(48, leaves.length);
  put(56, tilesAt);
  put(64, tiles.length);
  put(72, addressed);
  put(80, entries.length);
  put(88, contents.size);
  header[101] = maxZoom;
  header[118] = Math.min(header[118], maxZoom);

  mkdirSync(outDir, { recursive: true });
  const archive = Buffer.concat([header, root, metadata, leaves, tiles]);
  writeFileSync(outFile, archive);
  console.log(
    `fetch-tiles: wrote ${outFile} (${(archive.length / 1048576).toFixed(1)} MiB, ${addressed} tiles, ${requests} requests) from build ${build}`,
  );
  if (archive.length > PAGES_LIMIT) {
    console.warn(
      "fetch-tiles: this file is over 25 MiB, the per-file limit of Cloudflare Pages. Host it on object storage and set VITE_PMTILES_URL, or lower --maxzoom.",
    );
  }
}

await main();
