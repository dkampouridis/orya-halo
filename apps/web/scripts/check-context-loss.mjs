#!/usr/bin/env node
// Takes the WebGL context away from each of the engine's two canvases, for
// real (the WEBGL_lose_context extension, which is what the browser itself
// uses to simulate a GPU reset), and checks that the globe comes back:
//
//   - the data canvas (deck.gl): the engine builds a fresh canvas and the
//     glyphs are drawn and pickable again;
//   - the map canvas (MapLibre): once the browser restores the context the
//     base map, the sky and night layer, and any raster overlay return;
//   - both at once, as after a GPU process restart;
//   - the engine's status says "context-lost" in between and "ok" after.
//
// "Comes back" is judged from pixels: a screenshot of the globe before, while
// lost, and after.
//
//   node scripts/check-context-loss.mjs [--base=http://localhost:5181] [--headed]
//
// Needs the dev server (`vp dev --port 5181`). Exits non-zero if a check fails.
import { chromium } from "playwright";

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const base = arg("base") ?? "http://localhost:5181";
const headed = process.argv.includes("--headed");

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
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  // Other people edit this checkout while the checks run; without Vite's socket the page is not reloaded under them.
  await page.routeWebSocket(/.*/, () => {});
  const consoleLines = [];
  page.on("console", (m) => {
    // The browser's own note about a missing favicon is not the engine's doing.
    if (/Failed to load resource/.test(m.text())) return;
    if (m.type() === "error" || m.type() === "warning") consoleLines.push(m.text().slice(0, 240));
  });
  page.on("pageerror", (e) => consoleLines.push(`pageerror: ${e.message}`));
  // A frozen clock and one batch: the picture only changes if the engine changes it.
  await page.goto(
    `${base}/sandbox.html?n=6000&hud=0&interval=0&t=2026-06-21T19:30:00Z&lon=40&lat=28&zoom=3`,
    { waitUntil: "load" },
  );
  await page.waitForFunction(() => globalThis.__halo?.stats.ready === true, null, {
    timeout: 60_000,
  });
  await page.waitForTimeout(3000);

  /**
   * What is on screen, split by who drew it. Glyphs are saturated cyan and
   * amber; the map side is counted as anything lit that is not a glyph
   * (city lights, labels, the atmosphere's rim).
   */
  const picture = async () => {
    const png = (await page.screenshot()).toString("base64");
    return page.evaluate(async (data) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let glyphs = 0;
      let map = 0;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        const cyan = b > 170 && g > 150 && r < 140;
        const amber = r > 200 && g > 140 && g < 200 && b < 90;
        if (cyan || amber) glyphs++;
        else if (r + g + b > 120) map++;
        if (r + g + b > 90) lit++;
      }
      return { glyphs, map, lit };
    }, png);
  };
  const state = () =>
    page.evaluate(() => {
      const e = globalThis.__halo.engine;
      const data = e.overlay.getCanvas();
      return {
        status: e.getStatus().graphics,
        sky: Boolean(e.map.style && e.map.getLayer("halo-space")),
        mapLost: e.map.getCanvas().getContext("webgl2").isContextLost(),
        dataLost: data ? data.getContext("webgl2").isContextLost() : true,
        layers: e.layers.length,
      };
    });
  /** An aircraft near the middle of the screen with nothing close to it, to pick before and after. */
  const target = await page.evaluate(() => {
    const h = globalThis.__halo;
    const fleet = h.world.fleets.find((f) => f.kind === 1);
    const all = [];
    for (let i = 0; i < fleet.count; i++) {
      const id = ((1 << 24) | (i + 1)) >>> 0;
      const at = h.engine.locate({ kind: 1, id });
      const p = at && h.engine.project(at.lon, at.lat, at.alt);
      if (p && p.x > 300 && p.x < 1100 && p.y > 200 && p.y < 700) all.push({ id, x: p.x, y: p.y });
    }
    return (
      all.find((o) => !all.some((n) => n !== o && Math.hypot(n.x - o.x, n.y - o.y) < 24)) ?? null
    );
  });
  const pickTarget = async () => {
    await page.evaluate(() => {
      globalThis.__halo.stats.lastPick = null;
    });
    await page.mouse.click(target.x, target.y);
    await page.waitForTimeout(400);
    return page.evaluate(() => globalThis.__halo.stats.lastPick?.ref?.id ?? null);
  };

  const before = await picture();
  check(
    "the globe is drawn to begin with",
    before.glyphs > 300 && before.map > 3000,
    JSON.stringify(before),
  );
  check(
    "an aircraft can be picked to begin with",
    target !== null && (await pickTarget()) === target.id,
  );
  // Deselect again so the reticle does not change the picture.
  await page.evaluate(() => globalThis.__halo.select(null));

  // ── The data canvas ────────────────────────────────────────────────────────
  await page.evaluate(() => {
    const e = globalThis.__halo.engine;
    globalThis.__lostCanvas = e.overlay.getCanvas();
    globalThis.__statuses = [];
    e.onStatus((s) => globalThis.__statuses.push(s.graphics));
    globalThis.__lostCanvas.getContext("webgl2").getExtension("WEBGL_lose_context").loseContext();
  });
  await page.waitForTimeout(2500);
  const afterData = await picture();
  const dataState = await state();
  const replaced = await page.evaluate(
    () =>
      globalThis.__halo.engine.overlay.getCanvas() !== globalThis.__lostCanvas &&
      !globalThis.__lostCanvas.isConnected,
  );
  check(
    "losing the data canvas's context: the engine builds a new canvas",
    replaced && !dataState.dataLost,
  );
  check(
    "the glyphs are drawn again",
    afterData.glyphs > before.glyphs * 0.8,
    `${afterData.glyphs} glyph pixels, ${before.glyphs} before`,
  );
  check("and can be picked again", (await pickTarget()) === target.id);
  await page.evaluate(() => globalThis.__halo.select(null));
  check(
    "the status went to context-lost and back",
    (await page.evaluate(() => globalThis.__statuses.join(","))) === "context-lost,ok",
    await page.evaluate(() => globalThis.__statuses.join(",")),
  );

  // ── The map canvas ─────────────────────────────────────────────────────────
  await page.evaluate(() => {
    globalThis.__statuses.length = 0;
    const gl = globalThis.__halo.engine.map.getCanvas().getContext("webgl2");
    globalThis.__mapLose = gl.getExtension("WEBGL_lose_context");
    globalThis.__mapLose.loseContext();
  });
  await page.waitForTimeout(1200);
  const lost = await picture();
  const lostState = await state();
  check(
    "losing the map's context: the map goes dark and the engine says so",
    lostState.mapLost && lostState.status === "context-lost" && lost.map < before.map * 0.2,
    `${lost.map} map pixels, ${before.map} before; status ${lostState.status}`,
  );
  // Over black the points of light are dimmer than over the map, so count anything lit.
  check("the data layers keep drawing over the dark", lost.lit > 1500, `${lost.lit} lit pixels`);
  await page.evaluate(() => globalThis.__mapLose.restoreContext());
  await page.waitForTimeout(4000);
  const restored = await picture();
  const restoredState = await state();
  check(
    "when the context returns, so do the base map and the sky",
    !restoredState.mapLost && restoredState.sky && restored.map > before.map * 0.8,
    `${restored.map} map pixels, ${before.map} before; sky layer ${restoredState.sky}`,
  );
  check("the status is ok again", restoredState.status === "ok", restoredState.status);
  check("the glyphs are still there", restored.glyphs > before.glyphs * 0.8, `${restored.glyphs}`);

  // The camera and the rest of the engine still work.
  const flown = await page.evaluate(async () => {
    const e = globalThis.__halo.engine;
    await e.flyTo({ lon: 60, lat: 20, zoom: 3.4 }, { durationMs: 500 });
    e.setLayerVisible("nightlights", false);
    e.setLayerVisible("nightlights", true);
    const v = e.getView();
    await e.flyTo({ lon: 40, lat: 28, zoom: 3 }, { instant: true });
    return Math.abs(v.lon - 60) < 0.01;
  });
  check("the camera still flies afterwards", flown);

  // ── Both at once, with a raster overlay up ─────────────────────────────────
  await page.route("https://tiles.halo-sandbox.invalid/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/png",
      headers: { "access-control-allow-origin": "*" },
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64",
      ),
    }),
  );
  await page.evaluate(() => {
    const e = globalThis.__halo.engine;
    e.setLayerVisible("radar", true);
    e.setTiles("radar", {
      tiles: ["https://tiles.halo-sandbox.invalid/radar/f0/{z}/{x}/{y}.png"],
      tileSize: 512,
      minZoom: 0,
      maxZoom: 7,
      opacity: 0.01,
    });
  });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const e = globalThis.__halo.engine;
    const data = e.overlay.getCanvas().getContext("webgl2").getExtension("WEBGL_lose_context");
    const gl = e.map.getCanvas().getContext("webgl2");
    globalThis.__mapLose = gl.getExtension("WEBGL_lose_context");
    globalThis.__mapLose.loseContext();
    data.loseContext();
  });
  await page.waitForTimeout(1500);
  await page.evaluate(() => globalThis.__mapLose.restoreContext());
  await page.waitForTimeout(4500);
  const both = await picture();
  const bothState = await state();
  const overlayBack = await page.evaluate(() => {
    const map = globalThis.__halo.engine.map;
    return (
      Boolean(map.getLayer("halo-raster-radar-a")) &&
      map.getLayoutProperty("halo-raster-radar-a", "visibility") !== "none"
    );
  });
  check(
    "after losing both contexts the whole picture returns",
    both.glyphs > before.glyphs * 0.8 && both.map > before.map * 0.8 && bothState.status === "ok",
    `${JSON.stringify(both)} against ${JSON.stringify(before)}; status ${bothState.status}`,
  );
  check("the raster overlay is back on the map", overlayBack);
  check("and an aircraft can still be picked", (await pickTarget()) === target.id);

  // The browser may note the loss itself ("WebGL: CONTEXT_LOST_WEBGL"); the engine and the libraries should add nothing.
  const unexpected = consoleLines.filter((l) => !/CONTEXT_LOST_WEBGL|GroupMarkerNotSet/i.test(l));
  check(
    "nothing was written to the console",
    unexpected.length === 0,
    [...new Set(unexpected)].join(" | "),
  );

  console.log(failures === 0 ? "all context-loss checks passed" : `${failures} check(s) failed`);
} finally {
  await browser.close();
}
process.exit(failures === 0 ? 0 : 1);
