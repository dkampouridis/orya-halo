#!/usr/bin/env node
// Screenshots and frame timings of the engine sandbox, through the installed
// Microsoft Edge (Playwright `channel: "msedge"`, no browser download).
//
//   node scripts/shot.mjs                       all preset shots
//   node scripts/shot.mjs --only=terminator     one preset
//   node scripts/shot.mjs --query="n=50000&zoom=3" --out=custom.png
//   node scripts/shot.mjs --perf --query="n=50000"   frame statistics as JSON, no image
//
// Options: --base=http://localhost:5181  --width=1600 --height=1000 --scale=1
//          --dir=engine-round2/after   a folder under .screenshots/ for the presets
//          --settle=3500   ms to wait after the engine reports ready
//          --clip=x,y,w,h  capture part of the page (CSS pixels); with --scale=4 it is a magnifier
//          --eval="js"     run a snippet in the page before the capture (`__halo` is the sandbox)
//          --hover=x,y     rest the pointer there first
//          --headed        show the window
//          --uncapped      lift the display's frame-rate limit (with --perf --headed)
//          --software      force SwiftShader, to see the worst case
//          --seconds=10    how long --perf samples
//
// The dev server must be running: `vp dev --port 5181` in apps/web.
// Images go to .screenshots/ at the repository root, which git ignores.
//
// WebGL in headless Edge, as found on the development machine (Windows 11,
// Edge with an NVIDIA card, checked 2026-11-14): `headless: true` gets a
// hardware context through ANGLE/D3D11 with no flags at all. The flags below
// (--use-angle=d3d11 --enable-gpu --ignore-gpu-blocklist) ask for the same
// thing explicitly, for machines whose GPU is on Chromium's blocklist. The
// renderer string is printed on every run: "SwiftShader" or "Basic Render
// Driver" in it means the shot or the timing came from software rendering.
//
// For frame timings use --headed: a headless browser has no display to pace
// against. Add --uncapped to see what a frame costs rather than how often the
// monitor asks for one.
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const shotsDir = join(here, "..", "..", "..", ".screenshots");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const at = a.indexOf("=");
    return at < 0 ? [a.replace(/^--/, ""), "true"] : [a.slice(2, at), a.slice(at + 1)];
  }),
);

const base = args.base ?? "http://localhost:5181";
const width = Number(args.width ?? 1600);
const height = Number(args.height ?? 1000);
const scale = Number(args.scale ?? 1);
const settle = Number(args.settle ?? 3500);

// A fixed moment keeps the terminator where the shots expect it: the June
// solstice, with dusk falling across Europe and Africa.
const DUSK = "t=2026-06-21T19:30:00Z";

/** The shots the design review asks for. `after` runs in the page before the capture. */
const PRESETS = {
  "globe-night": { query: `${DUSK}&lon=95&lat=22&zoom=2.15&n=20000&hud=0` },
  terminator: { query: `${DUSK}&lon=18&lat=38&zoom=2.4&n=20000&hud=0` },
  "region-20k": { query: `${DUSK}&lon=8&lat=48&zoom=4.2&n=20000&hud=0` },
  "close-glyphs": { query: `${DUSK}&lon=4.2&lat=51.6&zoom=7.4&n=20000&hud=0` },
  "selected-reticle": { query: `${DUSK}&lon=8&lat=49&zoom=6.6&n=20000&hud=0&select=aircraft` },
  "day-side": { query: `${DUSK}&lon=-100&lat=35&zoom=2.6&n=20000&hud=0` },
  "horizon-pitch": { query: `${DUSK}&lon=30&lat=30&zoom=4.4&pitch=62&bearing=-20&n=20000&hud=0` },
  "all-layers": { query: `${DUSK}&lon=30&lat=15&zoom=2.5&n=20000&hud=0&layers=all` },
  "satellites-orbit": {
    query: `${DUSK}&lon=40&lat=10&zoom=2.2&n=20000&hud=0&layers=satellites,nightlights&select=satellites`,
  },
  // The far view at the four zooms it is judged at: 20,000 movers from orbit down to a region.
  "far-z1.5": { query: `${DUSK}&lon=18&lat=38&zoom=1.5&n=20000&hud=0` },
  "far-z2.5": { query: `${DUSK}&lon=18&lat=38&zoom=2.5&n=20000&hud=0` },
  "far-z4": { query: `${DUSK}&lon=18&lat=38&zoom=4&n=20000&hud=0` },
  "far-z6": { query: `${DUSK}&lon=18&lat=38&zoom=6&n=20000&hud=0` },
  // City lights alone, over the Nile and the Gulf, where they are densest.
  "lights-gulf": { query: `${DUSK}&lon=40&lat=28&zoom=3.4&n=0&hud=0` },
  "follow-aircraft": {
    query: `${DUSK}&lon=8&lat=49&zoom=7.5&n=20000&hud=0&select=aircraft&follow=1&pad=64,372,72,240`,
  },
};

function launchOptions() {
  const flags = args.software
    ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
    : ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"];
  // --uncapped lifts the display's refresh limit, so the frame time shows what a
  // frame costs rather than how fast the monitor asks for one.
  const pacing = args.uncapped ? ["--disable-frame-rate-limit", "--disable-gpu-vsync"] : [];
  return {
    channel: "msedge",
    headless: !args.headed,
    args: [
      ...flags,
      ...pacing,
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
    ],
  };
}

async function open(browser, query) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: scale,
  });
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning")
      console.log(`  [${m.type()}] ${m.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 400) console.log(`  [http ${r.status()}] ${r.url()}`);
  });
  await page.goto(`${base}/sandbox.html?${query}`, { waitUntil: "load" });
  await page.waitForFunction(() => globalThis.__halo?.stats.ready === true, null, {
    timeout: 60_000,
  });
  await page.waitForTimeout(settle);
  return { context, page };
}

async function renderer(page) {
  return page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown";
  });
}

const browser = await chromium.launch(launchOptions());
try {
  if (args.perf) {
    const { context, page } = await open(browser, args.query ?? "n=20000");
    await page.evaluate(() => globalThis.__halo.resetMeter());
    await page.waitForTimeout(Number(args.seconds ?? 10) * 1000);
    const result = await page.evaluate(() => ({
      frameMs: globalThis.__halo.readMeter(),
      fps: globalThis.__halo.stats.fps,
      quality: globalThis.__halo.stats.quality,
      qualityChanges: globalThis.__halo.stats.qualityLog,
      counts: globalThis.__halo.stats.counts,
      devicePixelRatio: globalThis.devicePixelRatio,
    }));
    console.log(
      JSON.stringify(
        {
          renderer: await renderer(page),
          headless: !args.headed,
          viewport: [width, height],
          ...result,
        },
        null,
        2,
      ),
    );
    await context.close();
  } else {
    mkdirSync(shotsDir, { recursive: true });
    const jobs = args.query
      ? [{ file: args.out ?? "custom.png", query: args.query }]
      : Object.entries(PRESETS)
          .filter(([name]) => !args.only || args.only.split(",").includes(name))
          .map(([name, preset]) => ({
            file: join(args.dir ?? "", `${name}.png`),
            query: preset.query,
          }));
    for (const { file, query } of jobs) {
      const { context, page } = await open(browser, query);
      // --eval runs a snippet in the page first, --hover=x,y rests the pointer there.
      if (args.eval) await page.evaluate(args.eval);
      if (args.hover) await page.mouse.move(...args.hover.split(",").map(Number));
      if (args.eval || args.hover) await page.waitForTimeout(1500);
      const out = isAbsolute(file) ? file : join(shotsDir, file);
      mkdirSync(dirname(out), { recursive: true });
      // --clip=x,y,width,height (CSS pixels) with --scale=2 or more gives a magnified detail.
      const clip = args.clip?.split(",").map(Number);
      await page.screenshot({
        path: out,
        clip: clip ? { x: clip[0], y: clip[1], width: clip[2], height: clip[3] } : undefined,
      });
      console.log(`${out}  (${await renderer(page)})`);
      await context.close();
    }
  }
} finally {
  await browser.close();
}
