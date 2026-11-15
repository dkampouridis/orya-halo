#!/usr/bin/env node
// Checks how the engine treats raster overlays and a missing base map, with
// every tile request answered locally (no provider is contacted):
//
//   - an overlay's deepest zoom is honoured: past it the engine stretches the
//     deepest tiles instead of asking for ones the provider does not have;
//   - 512 px tiles are requested as 512 px tiles;
//   - the frames of an animated overlay load lazily: only the frame being
//     shown, and a sweep of the time tape asks only for where it comes to rest;
//   - frames cross-fade, and the source that faded out stops loading tiles;
//   - a hidden overlay requests nothing, and its credit comes and goes with it;
//   - without the local tile extract the globe still starts, says so through
//     its status and writes nothing to the console.
//
//   node scripts/check-overlays.mjs [--base=http://localhost:5181] [--headed]
//
// Needs the dev server (`vp dev --port 5181`). Exits non-zero if a check fails.
import { chromium } from "playwright";

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const base = arg("base") ?? "http://localhost:5181";
const headed = process.argv.includes("--headed");

/** The host the sandbox's test overlay points at (src/dev/sandbox.ts, OVERLAY_HOST). */
const OVERLAY_HOST = "https://tiles.halo-sandbox.invalid";
/** A 1 x 1 PNG; what is in a tile does not matter here, only that one arrives. */
const TILE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const MOMENT = "2026-06-21T12:00:00Z";
const T = Date.parse(MOMENT);

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

const browser = await chromium.launch({
  channel: "msedge",
  headless: !headed,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
});

/** Everything a page wrote to the console that is not the browser's own note about a failed request. */
function watchConsole(page) {
  const lines = [];
  page.on("console", (m) => {
    if (m.type() !== "error" && m.type() !== "warning") return;
    if (/Failed to load resource/.test(m.text())) return;
    lines.push(`[${m.type()}] ${m.text().slice(0, 200)}`);
  });
  page.on("pageerror", (e) => lines.push(`[pageerror] ${e.message}`));
  return lines;
}

try {
  // ── Overlays ───────────────────────────────────────────────────────────────
  {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    // Other people edit this checkout while the checks run; without Vite's socket the page is not reloaded under them.
    await page.routeWebSocket(/.*/, () => {});
    const consoleLines = watchConsole(page);
    /** Every overlay tile asked for: which frame, which tile, and when. */
    const requests = [];
    await page.route(`${OVERLAY_HOST}/**`, async (route) => {
      const m = /\/radar\/f(\d+)\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(route.request().url());
      if (m) requests.push({ frame: Number(m[1]), z: Number(m[2]), at: Date.now() });
      // A little latency, so "still loading" is a state the page really passes through.
      await new Promise((r) => setTimeout(r, 40));
      await route.fulfill({
        status: 200,
        contentType: "image/png",
        headers: { "access-control-allow-origin": "*" },
        body: TILE,
      });
    });
    await page.goto(
      `${base}/sandbox.html?n=0&hud=0&interval=0&overlay=radar&t=${MOMENT}&lon=10&lat=48&zoom=3`,
      { waitUntil: "load" },
    );
    await page.waitForFunction(() => globalThis.__halo?.stats.ready === true, null, {
      timeout: 60_000,
    });
    await page.waitForTimeout(2500);

    const frames = () => [...new Set(requests.map((r) => r.frame))].sort((a, b) => a - b);
    const since = (mark) => requests.slice(mark);
    const layerState = () =>
      page.evaluate(() => {
        const map = globalThis.__halo.engine.map;
        return ["a", "b"].map((slot) => {
          const id = `halo-raster-radar-${slot}`;
          if (!map.getLayer(id)) return null;
          return {
            visibility: map.getLayoutProperty(id, "visibility") ?? "visible",
            opacity: map.getPaintProperty(id, "raster-opacity"),
            tiles: map.getSource(id).tiles[0],
          };
        });
      });

    check("the overlay loads tiles", requests.length > 0, `${requests.length} requests`);
    check(
      "only the frame being shown is requested at first",
      frames().length === 1 && frames()[0] === 12,
      `frames ${frames().join(", ")}`,
    );
    check(
      "512 px tiles are requested at the map's own zoom",
      requests.every((r) => r.z <= 3),
      `zooms ${[...new Set(requests.map((r) => r.z))].join(", ")}`,
    );
    const firstState = await layerState();
    check(
      "a still frame uses one source; the second waits out of the style",
      firstState[0]?.visibility === "visible" && firstState[1]?.visibility === "none",
      JSON.stringify(firstState.map((s) => s?.visibility)),
    );

    // Past the provider's deepest zoom: stretch, do not ask.
    let mark = requests.length;
    await page.evaluate(() =>
      globalThis.__halo.engine.flyTo({ lon: 10, lat: 48, zoom: 10 }, { instant: true }),
    );
    await page.waitForTimeout(2000);
    const deep = since(mark);
    check(
      "past the overlay's deepest zoom its tiles are stretched, not requested",
      deep.length > 0 && deep.every((r) => r.z <= 7),
      `${deep.length} requests, deepest zoom ${Math.max(0, ...deep.map((r) => r.z))}`,
    );
    await page.evaluate(() =>
      globalThis.__halo.engine.flyTo({ lon: 10, lat: 48, zoom: 3 }, { instant: true }),
    );
    await page.waitForTimeout(1200);

    // One step of the tape: the new frame loads into the hidden source, then the two cross-fade.
    mark = requests.length;
    await page.evaluate((t) => {
      globalThis.__halo.engine.setClock({ mode: "scrub", timeMs: t - 10 * 60_000 });
    }, T);
    await page.waitForTimeout(1500);
    const step = since(mark);
    const stepState = await layerState();
    check(
      "stepping the clock requests the one new frame",
      step.length > 0 && step.every((r) => r.frame === 11),
      `frames ${[...new Set(step.map((r) => r.frame))].join(", ")}`,
    );
    check(
      "the new frame fades in on the second source and the first is retired",
      stepState[1]?.opacity === 0.7 &&
        stepState[1]?.visibility === "visible" &&
        stepState[0]?.opacity === 0 &&
        stepState[0]?.visibility === "none",
      JSON.stringify(stepState.map((s) => s && [s.visibility, s.opacity])),
    );

    // A sweep of the tape across every frame in about a second, coming to rest on the oldest.
    mark = requests.length;
    await page.evaluate(async (t) => {
      const e = globalThis.__halo.engine;
      for (let i = 11; i >= 0; i--) {
        e.setClock({ mode: "scrub", timeMs: t - (12 - i) * 10 * 60_000 });
        await new Promise((r) => setTimeout(r, 90));
      }
    }, T);
    await page.waitForTimeout(2000);
    const sweep = since(mark);
    const sweptFrames = [...new Set(sweep.map((r) => r.frame))].sort((a, b) => a - b);
    check(
      "a sweep of the tape requests only the frame it comes to rest on",
      sweptFrames.length === 1 && sweptFrames[0] === 0,
      `frames ${sweptFrames.join(", ")}; ${sweep.length} requests`,
    );
    const rest = await layerState();
    check(
      "the frame it rests on is the one on screen",
      rest.some((s) => s?.visibility === "visible" && s.opacity === 0.7 && /\/f0\//.test(s.tiles)),
      JSON.stringify(rest.map((s) => s && [s.visibility, s.opacity, s.tiles.slice(-22)])),
    );

    // Hidden: nothing is requested, and the credit goes with the picture.
    const credit = () =>
      page.evaluate(() =>
        [...document.querySelectorAll(".halo-credits .halo-credit")].map((n) => n.textContent),
      );
    check(
      "the overlay's credit is on the map while it shows",
      (await credit()).includes("Test radar tiles"),
    );
    mark = requests.length;
    await page.evaluate((t) => {
      const e = globalThis.__halo.engine;
      e.setLayerVisible("radar", false);
      e.setClock({ mode: "scrub", timeMs: t - 6 * 10 * 60_000 });
    }, T);
    await page.waitForTimeout(1200);
    check(
      "a hidden overlay requests nothing",
      since(mark).length === 0,
      `${since(mark).length} requests`,
    );
    check("and its credit leaves the map", !(await credit()).includes("Test radar tiles"));
    await page.evaluate(() => globalThis.__halo.engine.setLayerVisible("radar", true));
    await page.waitForTimeout(1500);
    const back = [...new Set(since(mark).map((r) => r.frame))];
    check(
      "shown again, it catches up with the clock",
      back.length === 1 && back[0] === 6,
      `frames ${back.join(", ")}`,
    );
    check("and its credit returns", (await credit()).includes("Test radar tiles"));

    // Reduced motion: frames cut.
    const cut = await page.evaluate(() => {
      const e = globalThis.__halo.engine;
      e.setReducedMotion(true);
      const out = ["a", "b"].map((slot) =>
        e.map.getPaintProperty(`halo-raster-radar-${slot}`, "raster-fade-duration"),
      );
      const fade = e.map._fadeDuration;
      e.setReducedMotion(false);
      return { out, fade, after: e.map._fadeDuration };
    });
    check(
      "reduced motion, set after start, stops overlay and label fades",
      cut.out.every((d) => d === 0) && cut.fade === 0 && cut.after > 0,
      JSON.stringify(cut),
    );

    // Removing the overlay takes its sources with it.
    const removed = await page.evaluate(() => {
      const e = globalThis.__halo.engine;
      e.setTiles("radar", null);
      return ["a", "b"].every((slot) => !e.map.getSource(`halo-raster-radar-${slot}`));
    });
    check("removing the overlay removes its sources", removed);
    check(
      "nothing was written to the console",
      consoleLines.length === 0,
      consoleLines.join(" | "),
    );
    await page.close();
  }

  // ── No local tile extract ──────────────────────────────────────────────────
  for (const [label, answer] of [
    // What a dev server or a single-page host answers for a file it does not have.
    [
      "answered with the app's index page",
      { status: 200, contentType: "text/html", body: "<!doctype html><title>x</title>" },
    ],
    ["answered with 404", { status: 404, contentType: "text/plain", body: "Not found" }],
  ]) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    // Other people edit this checkout while the checks run; without Vite's socket the page is not reloaded under them.
    await page.routeWebSocket(/.*/, () => {});
    const consoleLines = watchConsole(page);
    await page.route("**/tiles/world.pmtiles", (route) => route.fulfill(answer));
    await page.goto(
      `${base}/sandbox.html?n=3000&hud=0&interval=0&t=2026-06-21T19:30:00Z&lon=40&lat=28&zoom=3`,
      { waitUntil: "load" },
    );
    const ready = await page
      .waitForFunction(() => globalThis.__halo?.stats.ready === true, null, { timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    await page.waitForTimeout(2500);
    check(`tile extract ${label}: the globe still starts`, ready);
    if (!ready) {
      await page.close();
      continue;
    }
    const state = await page.evaluate(() => {
      const e = globalThis.__halo.engine;
      const credits = [...document.querySelectorAll(".halo-credits .halo-credit")].map(
        (n) => n.textContent,
      );
      return {
        status: e.getStatus(),
        credits,
        sky: Boolean(e.map.getLayer("halo-space")),
        layers: e.layers.length,
      };
    });
    check(
      `tile extract ${label}: the engine reports it`,
      state.status.basemap === "missing" &&
        /base map/.test(state.status.message ?? "") &&
        Boolean(state.status.hint),
      JSON.stringify(state.status),
    );
    check(
      `tile extract ${label}: the sky and the data layers are up`,
      state.sky && state.layers > 3,
      `${state.layers} data layers`,
    );
    check(
      `tile extract ${label}: no base map credit is claimed`,
      !state.credits.some((c) => /OpenStreetMap/.test(c)),
      state.credits.join(" · "),
    );
    // The picture: city lights and glyphs over a plain sphere, not a black screen.
    const shot = (
      await page.screenshot({ clip: { x: 400, y: 150, width: 600, height: 600 } })
    ).toString("base64");
    const lit = await page.evaluate(async (png) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let bright = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 150) bright++;
      return bright;
    }, shot);
    check(`tile extract ${label}: lights and glyphs are drawn`, lit > 800, `${lit} lit pixels`);
    check(
      `tile extract ${label}: nothing was written to the console`,
      consoleLines.length === 0,
      consoleLines.join(" | "),
    );
    await page.close();
  }

  console.log(failures === 0 ? "all overlay checks passed" : `${failures} check(s) failed`);
} finally {
  await browser.close();
}
process.exit(failures === 0 ? 0 : 1);
