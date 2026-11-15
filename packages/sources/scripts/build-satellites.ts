/**
 * Builds `apps/web/public/data/satellites.csv`, the satellite snapshot the
 * web app shows when it cannot get current elements, and its sidecar
 * `satellites.json` (element dates, object count, provenance).
 *
 *   vp node scripts/build-satellites.ts --from active.csv   (from packages/sources)
 *       build from a CelesTrak answer saved earlier; sends nothing
 *   vp node scripts/build-satellites.ts --url http://localhost:8787/v1/proxy/celestrak/active.csv
 *       ask a gateway, which shares its one download per update
 *   vp node scripts/build-satellites.ts
 *       one download of GROUP=active from CelesTrak
 *
 * Options: `--out <file>` (default the web app's public/data/satellites.csv),
 * `--retrieved <ISO time>` when the `--from` file's modification time is not
 * when it was downloaded, `--min-objects <n>` (default 5000).
 *
 * CelesTrak serves a group once per update (every 2 hours) to each IP
 * address and answers a repeat with HTTP 403; addresses that keep erroring
 * end up in its firewall (https://celestrak.org/usage-policy.php). So the
 * download is one request with no retry, and any answer but 200 stops the
 * script. Do not run it without `--from` or `--url` if this address (the
 * dev server's browser included) downloaded the active group in the last
 * two hours.
 *
 * The file is written as CelesTrak sent it, with LF line ends. Dropping the
 * columns the plugin never reads (CLASSIFICATION_TYPE, REV_AT_EPOCH,
 * EPHEMERIS_TYPE, ELEMENT_SET_NO) was measured on 2026-11-14 and saves 9% raw
 * but only 5% gzipped (888 KB to 841 KB): not worth a file that is no longer
 * byte for byte CelesTrak's format.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { buildCatalogue } from "../src/satellites/catalogue.ts";

const CELESTRAK_GP_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=CSV";
const USER_AGENT = "orya-halo-build/0.1 (open-source globe; satellite snapshot builder)";
const REQUEST_TIMEOUT_MS = 120_000;
const DAY_MS = 86_400_000;
/** The median element set of a sound active catalogue is a day or two old. */
const MAX_MEDIAN_AGE_MS = 30 * DAY_MS;
/** Rows the plugin cannot propagate; a few are normal (CelesTrak lists some non-SGP4 sets). */
const MAX_SKIPPED_SHARE = 0.05;

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = join(here, "..", "..", "..", "apps", "web", "public", "data", "satellites.csv");

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** One GET, no retry, no redirects: anything but 200 ends the run. */
async function download(url: string): Promise<string> {
  console.log(`Downloading ${url} (one request) ...`);
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/csv, text/plain" },
    // CelesTrak answers a wrong domain or a legacy query with a 301, and asks clients to stop there.
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status !== 200) {
    const body = (await response.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 240);
    fail(
      `Stopped: HTTP ${response.status}${body ? ` (${body})` : ""}. Nothing was written. ` +
        "Do not retry before CelesTrak's next update; use --from with a saved file instead.",
    );
  }
  return response.text();
}

async function main(): Promise<void> {
  const from = arg("--from");
  const url = arg("--url");
  const out = resolve(arg("--out") ?? DEFAULT_OUT);
  const minObjects = Number(arg("--min-objects") ?? 5000);

  let csv: string;
  let retrievedMs: number;
  if (from !== undefined) {
    csv = readFileSync(from, "utf8");
    const stated = arg("--retrieved");
    retrievedMs = stated !== undefined ? Date.parse(stated) : statSync(from).mtimeMs;
    if (Number.isNaN(retrievedMs)) fail(`--retrieved: "${stated}" is not a date.`);
  } else {
    csv = await download(url ?? CELESTRAK_GP_URL);
    retrievedMs = Date.now();
  }

  // Validate with the plugin's own parser: what it cannot read must not ship.
  csv = csv.replace(/\r\n/g, "\n");
  if (!csv.endsWith("\n")) csv += "\n";
  const catalogue = buildCatalogue(csv);
  const rows = catalogue.count + catalogue.skipped;
  if (catalogue.count < minObjects)
    fail(
      `Only ${catalogue.count} usable objects (at least ${minObjects} expected). Nothing was written.`,
    );
  if (catalogue.skipped > rows * MAX_SKIPPED_SHARE)
    fail(`${catalogue.skipped} of ${rows} rows are unusable. Nothing was written.`);

  const epochs = Float64Array.from(catalogue.epochMs).sort();
  const median = epochs[epochs.length >> 1];
  if (Math.abs(retrievedMs - median) > MAX_MEDIAN_AGE_MS) {
    fail(
      `The median element set is from ${new Date(median).toISOString()}, far from the retrieval time. Nothing was written.`,
    );
  }

  const bytes = Buffer.byteLength(csv);
  const gzipBytes = gzipSync(csv, { level: 9 }).length;
  const sidecar = {
    source: "CelesTrak GP element sets, GROUP=active, FORMAT=CSV (OMM)",
    url: CELESTRAK_GP_URL,
    retrieved: new Date(retrievedMs).toISOString(),
    objects: catalogue.count,
    skipped: catalogue.skipped,
    epochs: {
      first: new Date(epochs[0]).toISOString(),
      median: new Date(median).toISOString(),
      last: new Date(epochs[epochs.length - 1]).toISOString(),
    },
    bytes,
    gzipBytes,
    licence:
      "No formal licence: CelesTrak usage policy, https://celestrak.org/usage-policy.php. Data originates from the U.S. Space Force.",
    attribution: "Satellite orbits: CelesTrak, from U.S. Space Force GP data",
  };

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, csv);
  const sidecarPath = out.replace(/\.csv$/i, "") + ".json";
  writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
  console.log(
    `Wrote ${out}: ${catalogue.count} objects (${catalogue.skipped} skipped), ` +
      `${(bytes / 1e6).toFixed(2)} MB, ${(gzipBytes / 1e6).toFixed(2)} MB gzipped; ` +
      `median element epoch ${sidecar.epochs.median}.`,
  );
  console.log(`Wrote ${sidecarPath}.`);
}

await main();
