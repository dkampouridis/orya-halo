#!/usr/bin/env node
// Measures how far apart MapLibre and deck.gl put the same coordinate on
// screen, over a range of cameras. The data layers are drawn by deck.gl's
// GlobeView in a canvas above MapLibre's globe; this is the check that the two
// cameras really are the same camera.
//
//   node scripts/check-alignment.mjs [--base=http://localhost:5181]
//
// Needs the dev server (`vp dev --port 5181`). Prints the largest offset in
// CSS pixels per camera; anything under a pixel is a match.
import { chromium } from "playwright";

const base = process.argv.find((a) => a.startsWith("--base="))?.slice(7) ?? "http://localhost:5181";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  // Other people edit this checkout while the checks run; without Vite's socket the page is not reloaded under them.
  await page.routeWebSocket(/.*/, () => {});
  await page.goto(`${base}/sandbox.html?n=0&hud=0&interval=0`, { waitUntil: "load" });
  await page.waitForFunction(() => globalThis.__halo?.stats.ready === true, null, {
    timeout: 60_000,
  });

  const rows = await page.evaluate(async () => {
    const engine = globalThis.__halo.engine;
    // The sandbox reaches into the engine here on purpose: MapLibre's own
    // projection is the reference the public `project()` is compared against.
    const map = engine.map;
    const cameras = [];
    for (const zoom of [1, 2.5, 4, 6, 9, 11, 11.6, 12.4, 15]) {
      for (const [lon, lat] of [
        [10, 0],
        [-74, 40.7],
        [139.7, 62],
      ]) {
        for (const [pitch, bearing] of [
          [0, 0],
          [50, 30],
        ])
          cameras.push({ zoom, lon, lat, pitch, bearing, padding: 0 });
      }
    }
    cameras.push({ zoom: 2, lon: 20, lat: 30, pitch: 0, bearing: 0, padding: 340 });
    cameras.push({ zoom: 7, lon: 20, lat: 30, pitch: 40, bearing: -20, padding: 340 });
    cameras.push({ zoom: 14, lon: 20, lat: 30, pitch: 40, bearing: -20, padding: 340 });

    const out = [];
    for (const c of cameras) {
      map.setPadding({ top: 0, bottom: 0, left: 0, right: c.padding });
      map.jumpTo({ center: [c.lon, c.lat], zoom: c.zoom, pitch: c.pitch, bearing: c.bearing });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      let worst = 0;
      let seen = 0;
      const w = map.getContainer().clientWidth;
      const h = map.getContainer().clientHeight;
      for (let ix = 1; ix < 8; ix++) {
        for (let iy = 1; iy < 8; iy++) {
          const px = (w * ix) / 8;
          const py = (h * iy) / 8;
          const ll = map.unproject([px, py]);
          const back = map.project(ll);
          // Off the edge of the planet MapLibre clamps to the limb: skip those samples.
          if (Math.hypot(back.x - px, back.y - py) > 0.5) continue;
          const p = engine.project(ll.lng, ll.lat, 0);
          if (!p) continue;
          seen++;
          worst = Math.max(worst, Math.hypot(p.x - px, p.y - py));
        }
      }
      out.push({ ...c, samples: seen, worstPx: Number(worst.toFixed(3)) });
    }
    return out;
  });

  for (const r of rows) {
    console.log(
      `zoom ${String(r.zoom).padEnd(5)} lat ${String(r.lat).padEnd(5)} pitch ${String(r.pitch).padEnd(3)} bearing ${String(r.bearing).padEnd(4)} pad ${String(r.padding).padEnd(4)} samples ${String(r.samples).padEnd(3)} worst ${r.worstPx} px`,
    );
  }
  console.log(`largest offset: ${Math.max(...rows.map((r) => r.worstPx))} px`);

  // `ViewState.global` is computed from the camera alone. Compare it with what
  // MapLibre actually draws: the planet is wholly in view when all four edge
  // midpoints of the screen look past it into space.
  const limb = await page.evaluate(async () => {
    const engine = globalThis.__halo.engine;
    const map = engine.map;
    const w = map.getContainer().clientWidth;
    const h = map.getContainer().clientHeight;
    const offPlanet = ([x, y]) => {
      const back = map.project(map.unproject([x, y]));
      return Math.hypot(back.x - x, back.y - y) > 0.5;
    };
    const none = { top: 0, bottom: 0, left: 0, right: 0 };
    // The HUD's insets with a detail panel open, and a phone with its sheet up:
    // padding slides the disc across the canvas, so the limb reaches an edge sooner.
    const panel = { top: 64, bottom: 72, left: 240, right: 372 };
    const sheet = { top: 64, bottom: 280, left: 0, right: 0 };
    const out = [];
    for (const [lat, pitch, padding, name] of [
      [0, 0, none, "none"],
      [45, 0, none, "none"],
      [-60, 0, none, "none"],
      [20, 30, none, "none"],
      [0, 0, panel, "panel"],
      [40, 0, panel, "panel"],
      [10, 25, panel, "panel"],
      [0, 0, sheet, "sheet"],
    ]) {
      // The view axis meets the canvas at the middle of the unpadded area.
      const cx = w / 2 + (padding.left - padding.right) / 2;
      const cy = h / 2 + (padding.top - padding.bottom) / 2;
      for (let zoom = 1.2; zoom <= 3.61; zoom += 0.1) {
        map.jumpTo({ center: [15, lat], zoom, pitch, bearing: 0, padding });
        await new Promise((r) => requestAnimationFrame(r));
        const drawn = [
          [cx, 1],
          [cx, h - 1],
          [1, cy],
          [w - 1, cy],
        ].every(offPlanet);
        out.push({
          lat,
          pitch,
          padding: name,
          zoom: Number(zoom.toFixed(1)),
          drawn,
          reported: engine.getView().global,
        });
      }
    }
    map.jumpTo({ padding: none });
    return out;
  });
  const wrong = limb.filter((r) => r.drawn !== r.reported);
  console.log(
    `global flag agrees with the drawn limb in ${limb.length - wrong.length} of ${limb.length} cameras`,
  );
  for (const r of wrong)
    console.log(
      `  lat ${r.lat} pitch ${r.pitch} padding ${r.padding} zoom ${r.zoom}: drawn ${r.drawn}, reported ${r.reported}`,
    );
} finally {
  await browser.close();
}
