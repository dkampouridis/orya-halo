#!/usr/bin/env node
// Drives the sandbox with a real pointer and checks the engine's events:
// hover and click picking, the double-click dive, drag-to-interact, layer
// toggles, follow mode and its framing, flights, the reduced-motion cut, the
// on-map credits, webcam zoom ranks and the quality tiers.
//
//   node scripts/check-interaction.mjs [--base=http://localhost:5181] [--headed]
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
  page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));
  // A frozen clock and a single batch keep every object where the test expects it.
  await page.goto(
    `${base}/sandbox.html?n=3000&hud=0&interval=0&t=2026-06-21T12:00:00Z&lon=8&lat=49&zoom=6`,
    { waitUntil: "load" },
  );
  await page.waitForFunction(() => globalThis.__halo?.stats.ready === true, null, {
    timeout: 60_000,
  });
  await page.waitForTimeout(1500);

  // Record every event the engine emits.
  await page.evaluate(() => {
    const h = globalThis.__halo;
    h.log = { pick: [], hover: [], dive: [], interact: 0, view: [], quality: [] };
    h.engine.on("pick", (p) => h.log.pick.push(p));
    h.engine.on("hover", (p) => h.log.hover.push(p));
    h.engine.on("dive", (p) => h.log.dive.push(p));
    h.engine.on("interact", () => h.log.interact++);
    h.engine.on("view", (v) => h.log.view.push(v));
  });

  /**
   * Screen position of the object of a kind nearest the middle of the view
   * that has nothing else within 30 pixels, so the click cannot hit a neighbour.
   */
  const locate = (kind) =>
    page.evaluate((k) => {
      const h = globalThis.__halo;
      const all = [];
      for (const fleet of h.world.fleets) {
        for (let i = 0; i < fleet.count; i++) {
          const ref = { kind: fleet.kind, id: ((fleet.kind << 24) | (i + 1)) >>> 0 };
          const at = h.engine.locate(ref);
          if (!at) continue;
          const p = h.engine.project(at.lon, at.lat, fleet.kind === 2 ? 0 : at.alt);
          if (p && p.x > 60 && p.y > 60 && p.x < 1340 && p.y < 840)
            all.push({ kind: fleet.kind, id: ref.id, x: p.x, y: p.y });
        }
      }
      let best = null;
      for (const o of all) {
        if (o.kind !== k) continue;
        if (all.some((n) => n !== o && Math.hypot(n.x - o.x, n.y - o.y) < 30)) continue;
        const d = Math.hypot(o.x - 700, o.y - 450);
        if (!best || d < best.d) best = { d, ...o };
      }
      return best;
    }, kind);

  const plane = await locate(1);
  check("an aircraft is on screen", plane !== null);

  await page.mouse.move(plane.x, plane.y);
  await page.waitForTimeout(400);
  const hover = await page.evaluate(() => globalThis.__halo.log.hover.at(-1));
  check(
    "hover reports the aircraft under the pointer",
    hover?.ref?.id === plane.id && hover.layer === "aircraft",
    JSON.stringify(hover?.ref),
  );

  await page.mouse.move(plane.x + 200, plane.y + 140);
  await page.waitForTimeout(400);
  const cleared = await page.evaluate(() => globalThis.__halo.log.hover.at(-1));
  check("hover clears when the pointer leaves", cleared === null || cleared?.ref?.id !== plane.id);

  await page.mouse.click(plane.x, plane.y);
  await page.waitForTimeout(500);
  const pick = await page.evaluate(() => globalThis.__halo.log.pick.at(-1));
  check("click picks the aircraft", pick?.ref?.id === plane.id, JSON.stringify(pick?.ref));
  check(
    "pick carries a position",
    Number.isFinite(pick?.lon) && Number.isFinite(pick?.lat) && Math.abs(pick.x - plane.x) < 2,
  );

  const ship = await locate(2);
  if (ship) {
    await page.mouse.click(ship.x, ship.y);
    await page.waitForTimeout(500);
    const shipPick = await page.evaluate(() => globalThis.__halo.log.pick.at(-1));
    check(
      "click picks a ship",
      shipPick?.layer === "ships" && shipPick.ref.id === ship.id,
      JSON.stringify(shipPick?.ref),
    );
  }

  // A hidden layer cannot be picked, and comes back when shown again.
  await page.evaluate(() => globalThis.__halo.engine.setLayerVisible("aircraft", false));
  await page.waitForTimeout(300);
  await page.mouse.click(plane.x, plane.y);
  await page.waitForTimeout(400);
  const hidden = await page.evaluate(() => globalThis.__halo.log.pick.at(-1));
  check(
    "a hidden layer is not pickable",
    hidden === null || hidden.layer !== "aircraft",
    JSON.stringify(hidden?.ref ?? null),
  );
  await page.evaluate(() => globalThis.__halo.engine.setLayerVisible("aircraft", true));
  await page.waitForTimeout(700);
  await page.mouse.click(plane.x, plane.y);
  await page.waitForTimeout(400);
  const shown = await page.evaluate(() => globalThis.__halo.log.pick.at(-1));
  check("showing the layer again makes it pickable", shown?.ref?.id === plane.id);

  // Cables are paths: picked by path id, with the cable's name as the label.
  const cable = await page.evaluate(async () => {
    const h = globalThis.__halo;
    const paths = h.engine.paths.get("cables");
    // The middle of the first cable, well away from either landing.
    const mid = (paths.startIndices[0] + paths.startIndices[1]) >> 1;
    const lon = paths.positions[mid * 2];
    const lat = paths.positions[mid * 2 + 1];
    await h.engine.flyTo({ lon, lat, zoom: 6 }, { instant: true });
    await new Promise((r) => setTimeout(r, 700));
    const p = h.engine.project(lon, lat, 0);
    return { ...p, id: paths.ids[0], name: paths.names[0] };
  });
  await page.mouse.click(cable.x, cable.y);
  await page.waitForTimeout(500);
  const cablePick = await page.evaluate(() => globalThis.__halo.log.pick.at(-1));
  check(
    "click picks a cable by its path id and name",
    cablePick?.layer === "cables" &&
      cablePick.ref.kind === 7 &&
      cablePick.ref.id === cable.id &&
      cablePick.label === cable.name,
    JSON.stringify(cablePick?.ref ?? null),
  );
  const cableAt = await page.evaluate(
    (ref) => globalThis.__halo.engine.locate(ref),
    cablePick?.ref ?? { kind: 7, id: -1 },
  );
  check("a cable can be located for the camera", cableAt !== null && Number.isFinite(cableAt.lon));

  // Empty water: a click on nothing reports null.
  await page.evaluate(() =>
    globalThis.__halo.engine.flyTo({ lon: -150, lat: -50, zoom: 9 }, { instant: true }),
  );
  await page.waitForTimeout(600);
  await page.mouse.click(700, 450);
  await page.waitForTimeout(500);
  const empty = await page.evaluate(() => globalThis.__halo.log.pick.at(-1));
  check("click on nothing reports null", empty === null, JSON.stringify(empty));

  await page.mouse.dblclick(640, 420);
  await page.waitForTimeout(300);
  const dive = await page.evaluate(() => globalThis.__halo.log.dive.at(-1));
  check(
    "double click emits dive with a coordinate",
    Number.isFinite(dive?.lon) && Math.abs(dive.lon + 150) < 1 && Math.abs(dive.lat + 50) < 1,
    JSON.stringify(dive),
  );
  await page.waitForTimeout(2800);

  const before = await page.evaluate(() => ({
    n: globalThis.__halo.log.interact,
    view: globalThis.__halo.engine.getView(),
  }));
  await page.mouse.move(700, 450);
  await page.mouse.down();
  await page.mouse.move(560, 400, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(900);
  const after = await page.evaluate(() => ({
    n: globalThis.__halo.log.interact,
    view: globalThis.__halo.engine.getView(),
    views: globalThis.__halo.log.view.length,
  }));
  check("dragging emits interact", after.n > before.n);
  check("dragging moves the camera", Math.abs(after.view.lon - before.view.lon) > 0.001);
  check("view is reported after the move settles", after.views > 0);
  check("view bounds are ordered south to north", after.view.bounds[1] < after.view.bounds[3]);

  // Flights: duration scales with distance and the promise resolves.
  const flight = await page.evaluate(async () => {
    const e = globalThis.__halo.engine;
    const t0 = performance.now();
    await e.flyTo({ lon: 139.7, lat: 35.6, zoom: 5 });
    const far = performance.now() - t0;
    const t1 = performance.now();
    await e.flyTo({ lon: 140.2, lat: 35.8, zoom: 5 });
    const near = performance.now() - t1;
    return { far, near, view: e.getView() };
  });
  check(
    "flyTo arrives",
    Math.abs(flight.view.lon - 140.2) < 0.01 && Math.abs(flight.view.zoom - 5) < 0.01,
    JSON.stringify(flight.view),
  );
  check(
    "a long flight takes about 2.4 s",
    flight.far > 2000 && flight.far < 3200,
    `${Math.round(flight.far)} ms`,
  );
  check(
    "a short hop takes about 1.2 s",
    flight.near > 1000 && flight.near < 1700,
    `${Math.round(flight.near)} ms`,
  );

  const global = await page.evaluate(async () => {
    const e = globalThis.__halo.engine;
    await e.flyTo({ lon: 0, lat: 20, zoom: 1.2 }, { instant: true });
    const out = e.getView();
    await e.flyTo({ lon: 0, lat: 20, zoom: 5 }, { instant: true });
    return { out, close: e.getView() };
  });
  check(
    "the whole planet in view reports global",
    global.out.global === true && global.out.bounds[0] === -180 && global.out.bounds[2] === 180,
  );
  check("a regional view does not", global.close.global === false);

  // Reduced motion: a camera move is a 200 ms cut, not a flight.
  const cut = await page.evaluate(async () => {
    const e = globalThis.__halo.engine;
    e.setReducedMotion(true);
    const t0 = performance.now();
    await e.flyTo({ lon: -74, lat: 40.7, zoom: 6 });
    const ms = performance.now() - t0;
    e.setReducedMotion(false);
    return { ms, view: e.getView() };
  });
  check(
    "reduced motion cuts instead of flying",
    cut.ms < 400 && Math.abs(cut.view.lon + 74) < 0.01,
    `${Math.round(cut.ms)} ms`,
  );

  // Follow: the camera stays on a moving object; the engine's clock is advanced by hand.
  const follow = await page.evaluate(async () => {
    const h = globalThis.__halo;
    const e = h.engine;
    const ref = { kind: 1, id: ((1 << 24) | 1) >>> 0 };
    h.select(ref);
    await e.flyToEntity(ref, { instant: true });
    e.setFollowing(true);
    const t = Date.parse("2026-06-21T12:00:00Z");
    for (let s = 1; s <= 20; s++) {
      e.setClock({ mode: "scrub", timeMs: t + s * 1000 });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
    await new Promise((r) => setTimeout(r, 900));
    const at = e.locate(ref);
    const view = e.getView();
    const screen = e.project(at.lon, at.lat, at.alt);
    return { at, view, screen };
  });
  check(
    "follow keeps the selection under the camera",
    Math.abs(follow.at.lon - follow.view.lon) < 1e-9 &&
      Math.abs(follow.at.lat - follow.view.lat) < 1e-9,
    `${follow.at.lon.toFixed(5)}, ${follow.at.lat.toFixed(5)} vs ${follow.view.lon.toFixed(5)}, ${follow.view.lat.toFixed(5)}`,
  );

  await page.mouse.move(700, 450);
  await page.mouse.down();
  await page.mouse.move(650, 430, { steps: 4 });
  await page.mouse.up();
  // Let the drag's inertia run out before comparing views.
  await page.waitForTimeout(2000);
  const released = await page.evaluate(async () => {
    const e = globalThis.__halo.engine;
    const a = e.getView();
    e.setClock({ mode: "scrub", timeMs: Date.parse("2026-06-21T12:05:00Z") });
    await new Promise((r) => setTimeout(r, 500));
    const b = e.getView();
    return Math.abs(a.lon - b.lon) < 1e-9 && Math.abs(a.lat - b.lat) < 1e-9;
  });
  check("dragging the globe releases follow", released);

  // Follow, framed: with HUD panels open the object sits in the middle of the
  // clear area, pitched or not, and stays there while it moves.
  const framed = await page.evaluate(async () => {
    const h = globalThis.__halo;
    const e = h.engine;
    const map = e.map;
    const ref = { kind: 1, id: ((1 << 24) | 1) >>> 0 };
    const t = Date.parse("2026-06-21T12:00:00Z");
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const padding = { top: 64, right: 372, bottom: 72, left: 240 };
    const centre = {
      x: padding.left + (1400 - padding.left - padding.right) / 2,
      y: padding.top + (900 - padding.top - padding.bottom) / 2,
    };
    e.setClock({ mode: "scrub", timeMs: t });
    h.select(ref);
    e.setPadding(padding);
    await e.flyToEntity(ref, { instant: true });
    e.setFollowing(true);
    await new Promise((r) => setTimeout(r, 700));

    const offCentre = async (from, seconds) => {
      let worst = 0;
      for (let s = 1; s <= seconds; s++) {
        e.setClock({ mode: "scrub", timeMs: t + (from + s) * 1000 });
        await frames();
        const at = e.locate(ref);
        const p = e.project(at.lon, at.lat, at.alt);
        worst = Math.max(worst, p ? Math.hypot(p.x - centre.x, p.y - centre.y) : 999);
      }
      return worst;
    };
    const flat = await offCentre(0, 25);
    const appliedPadding = map.getPadding();

    // A camera set from outside (not a gesture) does not end follow.
    map.jumpTo({ pitch: 55, bearing: 40 });
    await frames();
    const pitched = await offCentre(25, 25);

    // The HUD's zoom buttons: a new zoom for the same place keeps following.
    const before = e.getView();
    const t0 = performance.now();
    await e.flyTo({ lon: before.lon, lat: before.lat, zoom: before.zoom + 1 }, { durationMs: 300 });
    const zoomMs = performance.now() - t0;
    const zoomed = e.getView().zoom - before.zoom;
    const afterZoom = await offCentre(50, 10);

    // A panel closing while following: the padding eases over without dropping the object.
    e.setPadding({ ...padding, right: 0 });
    await new Promise((r) => setTimeout(r, 700));
    const eased = map.getPadding().right;
    const wide = { x: padding.left + (1400 - padding.left) / 2, y: centre.y };
    e.setClock({ mode: "scrub", timeMs: t + 61_000 });
    await frames();
    const at = e.locate(ref);
    const p = e.project(at.lon, at.lat, at.alt);
    const afterPadding = Math.hypot(p.x - wide.x, p.y - wide.y);

    // Flying somewhere else lets go.
    await e.flyTo({ lon: before.lon + 30, lat: before.lat, zoom: 4 }, { instant: true });
    e.setClock({ mode: "scrub", timeMs: t + 120_000 });
    await frames();
    const away = Math.abs(e.getView().lon - (before.lon + 30)) < 0.01;

    e.setFollowing(false);
    e.setPadding({ top: 0, right: 0, bottom: 0, left: 0 });
    map.jumpTo({ pitch: 0, bearing: 0 });
    h.select(null);
    await new Promise((r) => setTimeout(r, 400));
    return { flat, pitched, appliedPadding, zoomed, zoomMs, afterZoom, eased, afterPadding, away };
  });
  check(
    "follow frames the object in the middle of the clear area",
    framed.flat < 1 && framed.appliedPadding.right === 372,
    `at most ${framed.flat.toFixed(2)} px off`,
  );
  check(
    "and keeps it there with the camera pitched and turned",
    framed.pitched < 4,
    `at most ${framed.pitched.toFixed(2)} px off`,
  );
  check(
    "a zoom asked for while following eases in and keeps following",
    Math.abs(framed.zoomed - 1) < 1e-6 && framed.zoomMs > 200 && framed.afterZoom < 4,
    `zoom +${framed.zoomed.toFixed(2)} in ${Math.round(framed.zoomMs)} ms, then ${framed.afterZoom.toFixed(2)} px off`,
  );
  check(
    "a padding change while following eases in",
    framed.eased === 0 && framed.afterPadding < 4,
    `right inset ${framed.eased}, ${framed.afterPadding.toFixed(2)} px off`,
  );
  check("flying elsewhere ends follow", framed.away);

  // Credits: on the map, linked, in the design's Micro type, with no plate behind them.
  const credits = await page.evaluate(() => {
    const e = globalThis.__halo.engine;
    e.setCredits([
      { text: "Aircraft: a test feed", url: "https://example.org/aircraft" },
      { text: "No web address", url: "javascript:alert(1)" },
      { text: "Aircraft: a test feed", url: "https://example.org/again" },
    ]);
    const box = document.querySelector(".halo-credits");
    const items = [...box.querySelectorAll(".halo-credit")].map((n) => ({
      text: n.textContent,
      href: n.getAttribute("href"),
      target: n.getAttribute("target"),
      rel: n.getAttribute("rel"),
    }));
    const style = getComputedStyle(box);
    const rect = box.getBoundingClientRect();
    e.setLayerVisible("nightlights", false);
    const withoutLights = [...box.querySelectorAll(".halo-credit")].map((n) => n.textContent);
    e.setLayerVisible("nightlights", true);
    return {
      items,
      withoutLights,
      fontSize: style.fontSize,
      stretch: style.fontStretch,
      background: style.backgroundColor,
      shadow: style.textShadow,
      right: innerWidth - rect.right,
      bottom: innerHeight - rect.bottom,
      inEngine: Boolean(box.closest(".halo-engine")),
    };
  });
  const texts = credits.items.map((c) => c.text);
  check(
    "setCredits puts the data credits before the base map's own, once each",
    texts.join(" | ") ===
      "Aircraft: a test feed | No web address | Night lights: NASA Earth Observatory | Imagery: NASA Blue Marble, GIBS | Protomaps | © OpenStreetMap",
    texts.join(" | "),
  );
  check(
    "each credit links out safely, and only to the web",
    credits.items[0].href === "https://example.org/aircraft" &&
      credits.items[0].target === "_blank" &&
      /noopener/.test(credits.items[0].rel ?? "") &&
      credits.items[1].href === null,
    JSON.stringify(credits.items.slice(0, 2)),
  );
  check(
    "the credit line is 11 px condensed text on a black bloom, bottom right, inside the engine",
    credits.fontSize === "11px" &&
      credits.stretch === "82%" &&
      credits.background === "rgba(0, 0, 0, 0)" &&
      credits.shadow !== "none" &&
      credits.right === 16 &&
      credits.bottom === 8 &&
      credits.inEngine,
    JSON.stringify(credits),
  );
  check(
    "a credit leaves with its layer",
    !credits.withoutLights.includes("Night lights: NASA Earth Observatory"),
  );

  // Webcams carry a zoom rank: from far away only the few with room are drawn or picked.
  const cams = await page.evaluate(async () => {
    const h = globalThis.__halo;
    const e = h.engine;
    e.setLayerVisible("webcams", true);
    e.setLayerVisible("aircraft", false);
    e.setLayerVisible("ships", false);
    e.setLayerVisible("satellites", false);
    const batch = e.batches.get(5);
    // A camera that only shows from zoom 8, in a cluster whose first camera shows from zoom 3.
    let index = -1;
    for (let i = 0; i < batch.count; i++) {
      if (batch.values[i] === 8 && batch.values[i - (i % 6)] === 3) {
        index = i;
        break;
      }
    }
    const lon = batch.positions[index * 3];
    const lat = batch.positions[index * 3 + 1];
    return { id: batch.ids[index], lon, lat };
  });
  const pickCam = async (zoom) => {
    await page.evaluate(
      ({ lon, lat, zoom }) => globalThis.__halo.engine.flyTo({ lon, lat, zoom }, { instant: true }),
      { ...cams, zoom },
    );
    await page.waitForTimeout(700);
    await page.evaluate(() => {
      globalThis.__halo.log.pick.length = 0;
    });
    await page.mouse.click(700, 450);
    await page.waitForTimeout(400);
    return page.evaluate(() => globalThis.__halo.log.pick.at(-1) ?? null);
  };
  const farCam = await pickCam(2.4);
  check(
    "from far away a webcam below its zoom rank is not drawn or picked",
    farCam === null || farCam.layer !== "webcams",
    JSON.stringify(farCam?.ref ?? null),
  );
  const nearCam = await pickCam(11);
  check(
    "close in, the same webcam is there to pick",
    nearCam?.layer === "webcams" && nearCam.ref.id === cams.id,
    JSON.stringify(nearCam?.ref ?? null),
  );
  await page.evaluate(() => {
    const e = globalThis.__halo.engine;
    for (const id of ["aircraft", "ships", "satellites"]) e.setLayerVisible(id, true);
    e.setLayerVisible("webcams", false);
  });

  // Quality: the low tier really is the cheap one, and what is asked for is honoured.
  const tiers = await page.evaluate(async () => {
    const e = globalThis.__halo.engine;
    const read = () => ({
      ratio: e.map.getPixelRatio(),
      fade: e.map._fadeDuration,
      faintStars: e.sky.faintStars,
      lightsFine: e.sky.lightsFine,
    });
    const high = read();
    e.setQuality("low");
    await new Promise((r) => setTimeout(r, 300));
    const low = read();
    const lowTails = e.layers.find((l) => l.id === "movers-aircraft").props.tail;
    const lowGlow = e.layers.find((l) => l.id === "movers-aircraft").props.glow;
    const lowDensity = e.layers.some((l) => l.id.startsWith("density-"));
    e.setQuality("high");
    await new Promise((r) => setTimeout(r, 300));
    return { high, low, lowTails, lowGlow, lowDensity, back: read() };
  });
  check(
    "the low tier drops tails, glow, faint stars, the density underlay and the map's fades",
    tiers.low.ratio === 1 &&
      tiers.low.fade === 0 &&
      tiers.low.faintStars === false &&
      tiers.low.lightsFine === false &&
      tiers.lowTails === false &&
      tiers.lowGlow === 0 &&
      tiers.lowDensity === false,
    JSON.stringify(tiers.low),
  );
  check(
    "asking for high again brings them back",
    tiers.back.fade === 200 && tiers.back.faintStars === true && tiers.back.lightsFine === true,
    JSON.stringify(tiers.back),
  );

  // The vertex shader against the reference: move the clock, ask extrapolate()
  // where an aircraft should be, and pick that exact pixel. A hit means the GPU
  // drew it there; a miss at the stale fix position means it really moved.
  const parity = await page.evaluate(async () => {
    const h = globalThis.__halo;
    const e = h.engine;
    const frames = () =>
      new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))),
      );
    const t0 = Date.parse("2026-06-21T12:00:00Z");
    e.setFollowing(false);
    h.select(null);
    const batch = e.batches.get(1);
    // A fast aircraft with a known heading and nothing else nearby.
    let index = -1;
    for (let i = 0; i < batch.count && index < 0; i++) {
      const lon = batch.positions[i * 3];
      const lat = batch.positions[i * 3 + 1];
      if (
        !(batch.motion[i * 4 + 1] > 200) ||
        Number.isNaN(batch.motion[i * 4]) ||
        Math.abs(lat) > 60 ||
        batch.style[i * 4 + 1] !== 0
      )
        continue;
      let crowded = false;
      for (const other of e.batches.values()) {
        if (other.kind > 3) continue;
        for (let j = 0; j < other.count; j++) {
          if (other === batch && j === i) continue;
          if (
            Math.abs(other.positions[j * 3] - lon) < 0.6 &&
            Math.abs(other.positions[j * 3 + 1] - lat) < 0.6
          )
            crowded = true;
        }
      }
      if (!crowded) index = i;
    }
    if (index < 0) return { skipped: true };
    const ref = { kind: 1, id: batch.ids[index] };
    const fix = {
      lon: batch.positions[index * 3],
      lat: batch.positions[index * 3 + 1],
      alt: batch.positions[index * 3 + 2],
    };
    await e.flyTo(
      { lon: fix.lon, lat: fix.lat, zoom: 10, pitch: 0, bearing: 0 },
      { instant: true },
    );

    const probe = async (seconds) => {
      e.setClock({ mode: "scrub", timeMs: t0 + seconds * 1000 });
      await frames();
      const at = e.locate(ref);
      const now = e.project(at.lon, at.lat, at.alt);
      const stale = e.project(fix.lon, fix.lat, fix.alt);
      return {
        seconds,
        movedPx: Math.hypot(now.x - stale.x, now.y - stale.y),
        hitNow: e.pickAt(now.x, now.y, 1)?.ref.id === ref.id,
        hitStale: e.pickAt(stale.x, stale.y, 1)?.ref.id === ref.id,
      };
    };
    const results = [await probe(0), await probe(30), await probe(200)];

    // Blend: a corrected fix arrives with the old drawn position recorded as an
    // offset, which must ease to nothing over BLEND_SECONDS (1.5 s).
    const corrected = {
      ...batch,
      seq: batch.seq + 1,
      positions: batch.positions.slice(),
      motion: batch.motion.slice(),
      blend: batch.blend.slice(),
    };
    corrected.blend[index * 3] = 0.06;
    corrected.blend[index * 3 + 1] = -0.04;
    corrected.blend[index * 3 + 2] = 0;
    e.setBatch(corrected);
    const blend = [await probe(0), await probe(0.75), await probe(3)];
    return { speed: batch.motion[index * 4 + 1], results, blend };
  });
  if (parity.skipped) {
    check("found an isolated aircraft for the shader parity check", false);
  } else {
    const [start, mid, late] = parity.results;
    check("at the fix time the glyph is on its fix", start.hitNow && start.movedPx < 0.01);
    check(
      "after 30 s the shader has moved it to where extrapolate() says",
      mid.hitNow && !mid.hitStale,
      `${mid.movedPx.toFixed(1)} px from the fix`,
    );
    // Aircraft stop being projected forward after 45 s: 200 s on, the travel is the same as at 45 s.
    const expected45 = (mid.movedPx / 30) * 45;
    check(
      "past the extrapolation limit it holds position, as extrapolate() does",
      late.hitNow && !late.hitStale && Math.abs(late.movedPx - expected45) < expected45 * 0.03,
      `${late.movedPx.toFixed(1)} px, 45 s of travel is ${expected45.toFixed(1)} px`,
    );
    const [b0, bHalf, bDone] = parity.blend;
    check(
      "a corrected fix starts where the object was last drawn",
      b0.hitNow && !b0.hitStale,
      `${b0.movedPx.toFixed(1)} px offset`,
    );
    check(
      "half way through the blend the shader has eased half the offset away",
      bHalf.hitNow &&
        !bHalf.hitStale &&
        bHalf.movedPx < b0.movedPx * 0.6 &&
        bHalf.movedPx > b0.movedPx * 0.4,
      `${bHalf.movedPx.toFixed(1)} px`,
    );
    check(
      "after the blend only dead reckoning remains",
      bDone.hitNow && Math.abs(bDone.movedPx - (mid.movedPx / 30) * 3) < 1,
      `${bDone.movedPx.toFixed(1)} px`,
    );
  }

  // Tearing down and building again must leave nothing behind and nothing broken.
  const rebuilt = await page.evaluate(async () => {
    const h = globalThis.__halo;
    h.engine.destroy();
    const container = document.getElementById("globe");
    const emptied = container.childElementCount === 0;
    const { createEngine } = await import("/src/engine/index.ts");
    const layers = Object.fromEntries(
      [
        "aircraft",
        "ships",
        "satellites",
        "quakes",
        "cables",
        "radar",
        "imagery",
        "fires",
        "webcams",
        "nightlights",
      ].map((id) => [id, true]),
    );
    const engine = await createEngine({
      container,
      reducedMotion: false,
      quality: "balanced",
      assetBase: "/",
      layers,
      initialView: { lon: 0, lat: 0, zoom: 2 },
    });
    let firstView = null;
    engine.on("view", (v) => {
      firstView ??= v;
    });
    const ready = await new Promise((resolve) => {
      engine.on("ready", () => resolve(true));
      setTimeout(() => resolve(false), 5000);
    });
    for (const batch of h.world.batches(Date.parse("2026-06-21T12:00:00Z"))) engine.setBatch(batch);
    await new Promise((r) => setTimeout(r, 500));
    const view = engine.getView();
    engine.destroy();
    engine.destroy();
    return { emptied, ready, zoom: view.zoom, left: container.childElementCount, firstView };
  });
  check("destroy removes everything from the container", rebuilt.emptied && rebuilt.left === 0);
  check(
    "a second engine starts in the same container",
    rebuilt.ready && Math.abs(rebuilt.zoom - 2) < 1e-6,
  );
  check(
    "the starting view is reported once the globe is ready",
    rebuilt.firstView?.global === true && Math.abs(rebuilt.firstView.zoom - 2) < 1e-6,
  );

  // Touch: tap to pick, double tap to dive, pinch to zoom.
  const touch = await browser.newContext({
    viewport: { width: 900, height: 700 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  });
  const phone = await touch.newPage();
  await phone.goto(
    `${base}/sandbox.html?n=3000&hud=0&interval=0&t=2026-06-21T12:00:00Z&lon=8&lat=49&zoom=6`,
    { waitUntil: "load" },
  );
  await phone.waitForFunction(() => globalThis.__halo?.stats.ready === true, null, {
    timeout: 60_000,
  });
  await phone.waitForTimeout(1500);
  const target = await phone.evaluate(() => {
    const h = globalThis.__halo;
    h.log = { dive: [], interact: 0 };
    h.engine.on("dive", (p) => h.log.dive.push(p));
    h.engine.on("interact", () => h.log.interact++);
    const all = [];
    for (const fleet of h.world.fleets) {
      for (let i = 0; i < fleet.count; i++) {
        const ref = { kind: fleet.kind, id: ((fleet.kind << 24) | (i + 1)) >>> 0 };
        const at = h.engine.locate(ref);
        const p = at && h.engine.project(at.lon, at.lat, fleet.kind === 2 ? 0 : at.alt);
        if (p && p.x > 60 && p.y > 60 && p.x < 840 && p.y < 640)
          all.push({ kind: fleet.kind, id: ref.id, x: p.x, y: p.y });
      }
    }
    return (
      all.find(
        (o) => o.kind === 1 && !all.some((n) => n !== o && Math.hypot(n.x - o.x, n.y - o.y) < 40),
      ) ?? null
    );
  });
  if (target) {
    // Eight pixels off centre: a fingertip is not a cursor.
    await phone.touchscreen.tap(target.x + 8, target.y + 5);
    await phone.waitForTimeout(500);
    const tapped = await phone.evaluate(() => globalThis.__halo.stats.lastPick);
    check(
      "a tap near an aircraft picks it",
      tapped?.ref?.id === target.id,
      JSON.stringify(tapped?.ref ?? null),
    );
  } else {
    check("found an isolated aircraft for the tap check", false);
  }
  await phone.evaluate(() =>
    globalThis.__halo.engine.flyTo({ lon: -150, lat: -50, zoom: 6 }, { instant: true }),
  );
  await phone.waitForTimeout(600);
  await phone.touchscreen.tap(400, 300);
  await phone.waitForTimeout(90);
  await phone.touchscreen.tap(402, 301);
  await phone.waitForTimeout(400);
  const tapDive = await phone.evaluate(() => globalThis.__halo.log.dive.at(-1));
  check(
    "a double tap emits dive",
    Number.isFinite(tapDive?.lon) && Math.abs(tapDive.lat + 50) < 3,
    JSON.stringify(tapDive ?? null),
  );
  await phone.waitForTimeout(2800);

  const zoomBefore = await phone.evaluate(() => globalThis.__halo.engine.getView().zoom);
  const cdp = await touch.newCDPSession(phone);
  await cdp.send("Input.synthesizePinchGesture", {
    x: 450,
    y: 350,
    scaleFactor: 2.5,
    relativeSpeed: 600,
    gestureSourceType: "touch",
  });
  await phone.waitForTimeout(1200);
  const pinch = await phone.evaluate(() => ({
    zoom: globalThis.__halo.engine.getView().zoom,
    interact: globalThis.__halo.log.interact,
  }));
  check(
    "a pinch zooms the globe",
    pinch.zoom > zoomBefore + 0.5,
    `${zoomBefore.toFixed(2)} to ${pinch.zoom.toFixed(2)}`,
  );
  check("touching the globe emits interact", pinch.interact > 0);
  await touch.close();

  console.log(failures === 0 ? "all interaction checks passed" : `${failures} check(s) failed`);
} finally {
  await browser.close();
}
process.exit(failures === 0 ? 0 : 1);
