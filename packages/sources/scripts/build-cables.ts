/**
 * Builds `apps/web/public/data/cables.bin` from OpenStreetMap.
 *
 *   vp node scripts/build-cables.ts                 (from packages/sources)
 *   vp node scripts/build-cables.ts --input raw.json   reuse a saved Overpass response
 *   vp node scripts/build-cables.ts --save-raw raw.json
 *
 * Sends one Overpass query. If a public instance fails, times out or answers
 * from a snapshot more than 30 days old, the next instance is tried; the
 * freshest answer wins. Nothing personal is sent: the User-Agent names the
 * project only.
 *
 * Data © OpenStreetMap contributors, ODbL 1.0. The output is a derived
 * database under the same licence.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { DEFAULT_BUILD_OPTIONS, OVERPASS_QUERY, buildCables } from "../src/cables/build.ts";
import type { OverpassResponse } from "../src/cables/build.ts";
import { decodeCables, encodeCables } from "../src/cables/format.ts";

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const USER_AGENT = "orya-halo-build/0.1 (open-source globe; submarine cable asset builder)";
const REQUEST_TIMEOUT_MS = 300_000;
const STALE_AFTER_MS = 30 * 86_400_000;

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = join(here, "..", "..", "..", "apps", "web", "public", "data", "cables.bin");

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function snapshotTime(response: OverpassResponse): number {
  const time = Date.parse(response.osm3s?.timestamp_osm_base ?? "");
  return Number.isNaN(time) ? 0 : time;
}

async function queryOne(endpoint: string): Promise<OverpassResponse> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
    body: `data=${encodeURIComponent(OVERPASS_QUERY)}`,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as OverpassResponse & { remark?: string };
  // Overpass reports a timeout or memory limit as HTTP 200 with a remark and partial data.
  if (body.remark) throw new Error(`Overpass remark: ${body.remark}`);
  if (!Array.isArray(body.elements) || body.elements.length === 0) throw new Error("empty result");
  return body;
}

async function queryOverpass(): Promise<OverpassResponse> {
  let best: OverpassResponse | undefined;
  for (const endpoint of ENDPOINTS) {
    const host = new URL(endpoint).host;
    try {
      console.log(`Asking ${host} ...`);
      const result = await queryOne(endpoint);
      const age = Date.now() - snapshotTime(result);
      console.log(
        `  ${result.elements.length} elements, snapshot ${result.osm3s?.timestamp_osm_base ?? "unknown"}`,
      );
      if (!best || snapshotTime(result) > snapshotTime(best)) best = result;
      if (age <= STALE_AFTER_MS) return result;
      console.warn(
        `  Snapshot is ${Math.round(age / 86_400_000)} days old; trying the next instance.`,
      );
    } catch (error) {
      console.warn(`  ${host} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!best)
    throw new Error(
      "No Overpass instance answered. Try again later, or pass --input with a saved response.",
    );
  console.warn("No instance had a fresh snapshot; using the freshest one received.");
  return best;
}

const input = arg("--input");
const saveRaw = arg("--save-raw");
const out = resolve(arg("--out") ?? DEFAULT_OUT);

const response: OverpassResponse = input
  ? (JSON.parse(readFileSync(resolve(input), "utf8")) as OverpassResponse)
  : await queryOverpass();
if (saveRaw) writeFileSync(resolve(saveRaw), JSON.stringify(response));

const { cables, stats } = buildCables(response, DEFAULT_BUILD_OPTIONS);
const bytes = encodeCables(cables, {
  generated: new Date().toISOString().slice(0, 10),
  osmBase: response.osm3s?.timestamp_osm_base ?? "unknown",
  licence: "ODbL 1.0",
  attribution: "© OpenStreetMap contributors",
  toleranceM: DEFAULT_BUILD_OPTIONS.toleranceM,
});

// Read the file back the way the app will, so a broken asset never reaches disk.
const check = decodeCables(bytes);
if (check.paths.count !== stats.paths)
  throw new Error("Round-trip check failed: path count differs.");

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, bytes);

console.log(`\nWays received: ${stats.waysIn}, kept: ${stats.waysKept}`);
console.log(`Left out: ${JSON.stringify(stats.rejected)}`);
console.log(
  `Cables: ${stats.cables} (${stats.named} named), dropped as too short: ${stats.tooShort}`,
);
console.log(
  `Paths: ${stats.paths}, vertices: ${stats.vertices}, mapped length: ${stats.lengthKm.toLocaleString("en-GB")} km`,
);
console.log(`Wrote ${out}`);
console.log(
  `  ${bytes.length.toLocaleString("en-GB")} bytes, ${gzipSync(bytes, { level: 9 }).length.toLocaleString("en-GB")} gzipped`,
);
