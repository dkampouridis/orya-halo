#!/usr/bin/env node
// Builds the engine sandbox and prints what each emitted file weighs, raw and
// gzipped, so the engine's share of the download is a number rather than a guess.
//
//   node scripts/measure-bundle.mjs
//   node scripts/measure-bundle.mjs --by-package   also: which packages the engine's JavaScript is made of
//
// The sandbox entry is a few lines that `import()` the engine, exactly as the
// app does, so everything except the entry chunk is the lazily loaded engine.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const outDir = join(webRoot, "node_modules", ".cache", "orya-halo", "sandbox-dist");

const byPackage = process.argv.includes("--by-package");

const build = spawnSync(
  "pnpm",
  ["exec", "vp", "build", "--config", "scripts/sandbox.vite.config.mjs"],
  {
    cwd: webRoot,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, HALO_SOURCEMAP: byPackage ? "1" : "0" },
  },
);
if (build.status !== 0) process.exit(build.status ?? 1);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1).padStart(8)} kB`;
const rows = walk(outDir)
  .filter((file) => !file.endsWith(".map") && !file.endsWith(".html"))
  .map((file) => {
    const data = readFileSync(file);
    // Fonts and images are already compressed; gzip only helps text.
    const text = /\.(m?js|css|json|svg)$/.test(file);
    return {
      file: relative(outDir, file).replaceAll("\\", "/"),
      raw: data.length,
      gzip: text ? gzipSync(data, { level: 9 }).length : data.length,
      text,
    };
  })
  .sort((a, b) => b.gzip - a.gzip);

console.log(`\n${"file".padEnd(58)}${"raw".padStart(11)}${"gzip".padStart(11)}`);
for (const r of rows) console.log(`${r.file.padEnd(58)}${kb(r.raw)}${kb(r.gzip)}`);

const js = rows.filter((r) => /\.m?js$/.test(r.file));
const worker = js.filter((r) => /worker/.test(r.file));
const entry = js.filter((r) => r.file.startsWith("assets/sandbox-"));

// A file on disk is not a file on the wire. The engine is what the entry
// chunk's `import()` names plus everything that chunk imports statically;
// chunks only reachable through a further `import()` inside a library (luma's
// WebGPU adapter, its GPU-compute back end) are fetched only if that code
// path runs, which in the engine it never does.
const byName = new Map(js.map((r) => [r.file.split("/").pop(), r]));
const source = (r) => readFileSync(join(outDir, r.file), "utf8");
const imports = (r, pattern) =>
  [...source(r).matchAll(pattern)].map((m) => byName.get(m[1])).filter(Boolean);
const STATIC = /(?:from|import)\s*["'`]\.\/([^"'`]+)["'`]/g;
const DYNAMIC = /import\(\s*["'`]\.\/([^"'`]+)["'`]\s*\)/g;
const closure = (roots) => {
  const seen = new Set(roots);
  for (const r of seen) for (const next of imports(r, STATIC)) seen.add(next);
  return seen;
};
const boot = closure(entry);
const loaded = closure(entry.flatMap((r) => imports(r, DYNAMIC)));
const engine = js.filter((r) => loaded.has(r) && !boot.has(r));
const lazy = js.filter((r) => !loaded.has(r) && !boot.has(r) && !worker.includes(r));

const sum = (list) => list.reduce((total, r) => total + r.gzip, 0);
console.log(`\nentry chunk (sandbox bootstrap, not the engine): ${kb(sum(entry))} gzip`);
console.log(`engine JavaScript, fetched by import():         ${kb(sum(engine))} gzip`);
console.log(
  `split off by libraries, fetched only if used:   ${kb(sum(lazy))} gzip  (${lazy.map((r) => r.file.split("/").pop()).join(", ") || "none"})`,
);
console.log(`MapLibre worker, fetched by the engine:         ${kb(sum(worker))} gzip`);
console.log(
  `stylesheets:                                    ${kb(sum(rows.filter((r) => r.file.endsWith(".css"))))} gzip`,
);
console.log(
  `fonts for map labels:                           ${kb(sum(rows.filter((r) => r.file.endsWith(".woff2"))))}`,
);

if (byPackage) {
  // Which package each byte of the engine's JavaScript came from, read off the
  // source maps: every mapped stretch of output is credited to its source file.
  const VLQ = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const decode = (segment) => {
    const out = [];
    let value = 0;
    let shift = 0;
    for (const ch of segment) {
      const digit = VLQ.indexOf(ch);
      value += (digit & 31) << shift;
      if (digit & 32) {
        shift += 5;
      } else {
        out.push(value & 1 ? -(value >> 1) : value >> 1);
        value = 0;
        shift = 0;
      }
    }
    return out;
  };
  const owner = (source) => {
    const path = source.replaceAll("\\", "/");
    const at = path.lastIndexOf("node_modules/");
    if (at >= 0) {
      const parts = path.slice(at + 13).split("/");
      return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
    }
    if (path.includes("packages/")) return `@orya-halo/${path.split("packages/")[1].split("/")[0]}`;
    if (path.includes("/src/engine/")) return "(engine)";
    if (path.includes("/src/dev/")) return "(sandbox)";
    return "(other)";
  };
  const totals = new Map();
  for (const r of rows.filter((x) => /\.m?js$/.test(x.file) && !/worker/.test(x.file))) {
    const mapFile = join(outDir, `${r.file}.map`);
    let map;
    try {
      map = JSON.parse(readFileSync(mapFile, "utf8"));
    } catch {
      continue;
    }
    const lines = readFileSync(join(outDir, r.file), "utf8").split("\n");
    let source = 0;
    map.mappings.split(";").forEach((line, lineIndex) => {
      let column = 0;
      const segments = line ? line.split(",").map(decode) : [];
      const starts = [];
      for (const seg of segments) {
        column += seg[0];
        if (seg.length >= 4) source += seg[1];
        starts.push([column, seg.length >= 4 ? source : -1]);
      }
      const length = lines[lineIndex]?.length ?? 0;
      starts.forEach(([from, src], i) => {
        const to = i + 1 < starts.length ? starts[i + 1][0] : length;
        const name = src >= 0 ? owner(map.sources[src] ?? "") : "(unmapped)";
        totals.set(name, (totals.get(name) ?? 0) + Math.max(0, to - from));
      });
    });
  }
  const all = [...totals.values()].reduce((a, b) => a + b, 0);
  console.log(
    `\nengine JavaScript by package (minified bytes before gzip, ${kb(all).trim()} mapped):`,
  );
  for (const [name, bytes] of [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 28)) {
    console.log(`${name.padEnd(40)}${kb(bytes)}${((bytes / all) * 100).toFixed(1).padStart(7)} %`);
  }
}
