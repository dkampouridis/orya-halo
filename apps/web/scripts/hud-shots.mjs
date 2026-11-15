#!/usr/bin/env node
// Screenshots of the real HUD in every state the design review asks for, through the
// installed Microsoft Edge (Playwright `channel: "msedge"`, no browser download).
//
//   node scripts/hud-shots.mjs                    every state, desktop (1440 x 900) and phone
//   node scripts/hud-shots.mjs --only=selected    states whose name contains "selected" (comma-separate several)
//   node scripts/hud-shots.mjs --device=phone     one device: desktop, laptop (1280 x 720),
//                                                 small (1024 x 768), narrow (800 x 1000), phone, or all
//   node scripts/hud-shots.mjs --crops            also 2x close-ups of each component
//   node scripts/hud-shots.mjs --solid            with the solid-glass fallback (reduced transparency)
//   node scripts/hud-shots.mjs --reduced          with prefers-reduced-motion
//
// After each shot the script reports any HUD element that overlaps the map's credit line.
//   node scripts/hud-shots.mjs --base=http://localhost:5183 --query="synthetic=6000&gateway=off"
//
// The dev server must be running: `vp dev --port 5183` in apps/web. The script drives the
// app through its own store (imported from the dev server, so it is the same module the
// page uses) where a real gesture would be slow or flaky, and through real input otherwise.
// Images go to .screenshots/hud/ at the repository root, which git ignores.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "..", "..", ".screenshots", "hud");
mkdirSync(join(out, "crops"), { recursive: true });

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const at = a.indexOf("=");
    return at < 0 ? [a.replace(/^--/, ""), "true"] : [a.slice(2, at), a.slice(at + 1)];
  }),
);
const base = args.base ?? "http://localhost:5183";
const query = args.query ?? "synthetic=6000&gateway=off";
const solid = args.solid === "true";
const reduced = args.reduced === "true";
const suffix = `${solid ? "-solid" : ""}${reduced ? "-reduced" : ""}`;
const only = args.only?.split(",");

const devices = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  laptop: { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 },
  small: { viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1 },
  narrow: { viewport: { width: 800, height: 1000 }, deviceScaleFactor: 1 },
  phone: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
};
const runDevices =
  args.device === "all"
    ? Object.keys(devices)
    : args.device
      ? args.device.split(",")
      : ["desktop", "phone"];
const wide = (device) => device !== "phone";

/** Run something against the app's store inside the page. */
const store = (page, fn, arg) =>
  page.evaluate(
    async ([source, value]) => {
      const { useHalo, haloActions } = await import("/src/core/store.ts");
      // eslint-disable-next-line no-new-func
      return new Function(
        "useHalo",
        "haloActions",
        "arg",
        `return (${source})(useHalo, haloActions, arg)`,
      )(useHalo, haloActions, value);
    },
    [fn.toString(), arg],
  );

/** Select something real: hover the globe until the engine reports an object, then click it. */
async function selectByClick(page, device) {
  const { width, height } = devices[device].viewport;
  if (wide(device)) {
    for (let y = height * 0.3; y < height * 0.8; y += 14) {
      for (let x = width * 0.3; x < width * 0.7; x += 14) {
        await page.mouse.move(x, y);
        await page.waitForTimeout(24);
        // A mover makes the better picture: it has readouts, a heading and something to follow.
        const hit = await store(page, (useHalo) => useHalo.getState().hover?.layer ?? null);
        if (hit === "aircraft" || hit === "ships" || hit === "satellites") {
          await page.mouse.click(x, y);
          return true;
        }
      }
    }
  } else {
    for (let y = height * 0.3; y < height * 0.6; y += 22) {
      for (let x = width * 0.15; x < width * 0.85; x += 22) {
        await page.touchscreen.tap(x, y);
        await page.waitForTimeout(60);
        if (await store(page, (useHalo) => useHalo.getState().selection !== null)) return true;
      }
    }
  }
  return false;
}

/** Fall back to the first search hit that is an object, so the shot still shows a panel. */
async function selectBySearch(page) {
  return page.evaluate(async () => {
    const { getServices } = await import("/src/core/services.ts");
    const { haloActions } = await import("/src/core/store.ts");
    for (const term of ["a", "e", "1"]) {
      const results = (await getServices()?.search(term)) ?? [];
      const hit = results.find((r) => r.type === "entity" && r.ref);
      if (hit) {
        haloActions().select(hit.ref);
        return true;
      }
    }
    return false;
  });
}

async function select(page, device) {
  if (!(await selectByClick(page, device))) {
    console.error("  no object found under the pointer; selecting through search instead");
    if (!(await selectBySearch(page)))
      console.error("  nothing to select: the detail shot will be empty");
  }
  await page
    .waitForFunction(() => document.querySelector(".detail-name") !== null, null, { timeout: 8000 })
    .catch(() => console.error("  detail did not arrive"));
  // Let the camera finish its glide.
  await page.waitForTimeout(2600);
  await page.mouse.move(8, 8);
}

/**
 * The HUD fades after 8 s without input, and a headless page has none. A bare Shift keydown
 * counts as input to the controller, is no shortcut, and (unlike a pointer move) raises no
 * hover tag on the globe.
 */
async function wake(page) {
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" })));
  await page.waitForTimeout(350);
}

const states = {
  default: async () => {},
  selected: select,
  "selected-full": async (page, device) => {
    await select(page, device);
    if (device === "phone") {
      await page.locator(".sheet-handle").tap();
      await page.waitForTimeout(400);
    }
  },
  search: async (page, device) => {
    if (device === "phone") await page.locator(".search-open").tap();
    else await page.keyboard.press("/");
    await page.keyboard.type(args.term ?? "at", { delay: 30 });
    await page.waitForTimeout(900);
    if (wide(device)) await page.keyboard.press("ArrowDown");
  },
  "search-empty": async (page, device) => {
    if (device === "phone") await page.locator(".search-open").tap();
    else await page.keyboard.press("/");
    await page.keyboard.type("qqzzxx", { delay: 20 });
    await page.waitForTimeout(900);
  },
  scrubbed: async (page) => {
    // Twelve minutes back, or as far as the recorded history goes.
    await store(page, (useHalo, haloActions) => {
      const { history } = useHalo.getState();
      const now = Date.now();
      // A fresh page has seconds of history, not minutes: stand in a full buffer for the shot.
      if (!history || now - history.fromMs < 13 * 60_000) {
        haloActions().setHistory({ fromMs: now - 30 * 60_000, toMs: now });
      }
      haloActions().scrubTo(now - 12 * 60_000);
    });
    await page.waitForTimeout(500);
  },
  idle: async (page) => {
    await store(page, (_, haloActions) => haloActions().setIdle(true));
    await page.waitForTimeout(900);
  },
  about: async (page) => {
    await page.locator(".brand").click();
    await page.waitForSelector(".source-item, .sheet .dim", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);
  },
  shortcuts: async (page, device) => {
    if (device === "phone")
      await store(page, (_, haloActions) => haloActions().setOverlay("shortcuts"));
    else await page.keyboard.press("?");
    await page.waitForSelector(".keys", { timeout: 8000 });
    await page.waitForTimeout(400);
  },
  // An object that is not there: the panel's "no longer in view" state.
  missing: async (page) => {
    await store(page, (_, haloActions) => haloActions().select({ kind: 1, id: 0xfffffe }));
    await page
      .waitForSelector(".detail-gone", { timeout: 8000 })
      .catch(() => console.error("  never went missing"));
    await page.waitForTimeout(400);
  },
  // Everything the panel can show at once (route, photo, facts, nearby), with stand-in data:
  // the synthetic source has no routes or photos. The photo is 220px wide to show it is not upscaled.
  "detail-rich": async (page, device) => {
    await store(page, (_, haloActions) => haloActions().select({ kind: 1, id: 0xfffffd }));
    await page.waitForSelector(".detail-gone", { timeout: 8000 }).catch(() => {});
    await store(page, (_, haloActions) => {
      const photo =
        "data:image/svg+xml," +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="124" viewBox="0 0 220 124"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#141c26"/><stop offset=".62" stop-color="#3a4554"/><stop offset=".86" stop-color="#8d8279"/><stop offset="1" stop-color="#b3997f"/></linearGradient></defs><rect width="220" height="124" fill="url(#s)"/><rect y="101" width="220" height="23" fill="#1a2029"/><path fill="#0c1118" d="M24 76c3-6 13-10 27-10h110l22-24h8l-8 26c8 1 13 3 13 5s-7 4-18 5l-127 6c-14 0-24-3-27-8Z"/></svg>',
        );
      haloActions().setDetail(
        {
          ref: { kind: 1, id: 0xfffffd },
          layer: "aircraft",
          title: "BAW115",
          subtitle: "Boeing 777-300ER · British Airways",
          lon: -46,
          lat: 49.2,
          alt: 10972,
          heading: 251,
          speed: 232.5,
          fixTimeMs: Date.now() - 2000,
          fields: [
            { key: "label", label: "Callsign", value: "BAW115" },
            { key: "registration", label: "Registration", value: "G-STBK" },
            { key: "typeName", label: "Aircraft", value: "Boeing 777-300ER" },
            { key: "operator", label: "Operator", value: "British Airways" },
            { key: "vrate", label: "Vertical rate", value: "0", unit: "m/s", numeric: 0 },
            { key: "squawk", label: "Squawk", value: "2241" },
            { key: "country", label: "Country", value: "United Kingdom" },
          ],
          origin: { code: "LHR", name: "London Heathrow", lon: -0.4614, lat: 51.4775 },
          destination: { code: "JFK", name: "New York JFK", lon: -73.7781, lat: 40.6413 },
          media: [
            {
              type: "image",
              url: photo,
              link: "https://www.planespotters.net/",
              credit: "Photo by Anna Lindqvist on Planespotters.net",
              alt: "G-STBK on the ground",
            },
          ],
          nearby: [
            { ref: { kind: 1, id: 11 }, label: "AAL107", distanceKm: 46 },
            { ref: { kind: 2, id: 12 }, label: "Atlantic Star", distanceKm: 84 },
            { ref: { kind: 1, id: 13 }, label: "VIR137", distanceKm: 118 },
          ],
          attribution: {
            text: "Position from ADS-B receivers, via adsb.lol",
            url: "https://adsb.lol",
          },
        },
        "ready",
      );
      // The last 38 minutes of a climb to cruise and a step climb, in metres, as the controller sends it.
      const now = Date.now();
      const timesMs = Array.from(
        { length: 60 },
        (_, i) => now - 38 * 60_000 + (i * (38 * 60_000)) / 59,
      );
      const values = timesMs.map((_, i) =>
        i < 16 ? 2400 + i * 470 : i < 40 ? 9750 + Math.sin(i) * 6 : 10_972,
      );
      haloActions().setTrackSeries({ measure: "altitude", timesMs, values });
    });
    await page.waitForTimeout(500);
    if (device === "phone") {
      await page.locator(".sheet-handle").tap();
      await page.waitForTimeout(500);
    }
  },
  // A hover tag and a ticker line, with stand-in data where the page has none of its own.
  "hover-ticker": async (page, device) => {
    await store(
      page,
      (useHalo, haloActions, at) => {
        if (useHalo.getState().events.length === 0) {
          haloActions().pushEvents([
            {
              id: "shot-quake",
              topic: "quake",
              timeMs: Date.now() - 2 * 60_000,
              title: "M5.2 earthquake off Crete",
              lon: 23.6,
              lat: 34.9,
              severity: 1,
            },
          ]);
        }
        haloActions().setHover({
          ref: { kind: 3, id: 25544 },
          layer: "satellites",
          label: "ISS (Zarya)  418 km",
          x: at.x,
          y: at.y,
          lon: 0,
          lat: 0,
        });
      },
      device === "phone" ? { x: 200, y: 400 } : { x: 712, y: 560 },
    );
    await page.waitForTimeout(500);
  },
  offline: async (page) => {
    await store(page, (_, haloActions) => {
      // The worker's own sentence for an unreachable gateway.
      const unreachable =
        "Live traffic is offline. The gateway isn't reachable; satellites and earthquakes still work.";
      for (const layer of ["aircraft", "ships"]) {
        haloActions().setLayerState(layer, {
          status: "offline",
          count: null,
          message: unreachable,
        });
      }
      haloActions().setGatewayOnline(false);
      // A source sentence long enough to need the two-line clamp.
      haloActions().setLayerState("quakes", {
        status: "degraded",
        count: 285,
        message:
          "Earthquakes are arriving late: the USGS summary feed has not changed for 14 minutes, so the newest events may be missing. Trying again every minute.",
      });
      haloActions().setLayerState("fires", {
        status: "needs-key",
        count: null,
        message: "Wildfires need a free NASA FIRMS key. Add it to the .env file.",
      });
      haloActions().setLayerEnabled("fires", true);
      haloActions().setLayerState("fires", {
        status: "needs-key",
        count: null,
        message: "Wildfires need a free NASA FIRMS key. Add it to the .env file.",
      });
    });
    await page.waitForTimeout(400);
  },
  // The engine lost its base map (the message and, in development, the hint for whoever runs it).
  "engine-notice": async (page) => {
    await page.evaluate(async () => {
      const status = await import("/src/engine/status.ts");
      const { haloActions } = await import("/src/core/store.ts");
      haloActions().setEngineStatus({
        basemap: "missing",
        graphics: "ok",
        message: status.BASEMAP_MISSING_MESSAGE,
        hint: status.BASEMAP_MISSING_HINT,
      });
    });
    await page.waitForTimeout(400);
  },
  "context-lost": async (page) => {
    await page.evaluate(async () => {
      const status = await import("/src/engine/status.ts");
      const { haloActions } = await import("/src/core/store.ts");
      haloActions().setEngineStatus({
        basemap: "full",
        graphics: "context-lost",
        message: status.CONTEXT_LOST_MESSAGE,
      });
    });
    await page.waitForTimeout(400);
  },
  // WebGL switched off: the engine cannot start and the HUD says so instead of waiting forever.
  "start-error": async () => {},
  // The sparkline for each kind of series, with stand-in data where the page has none.
  "spark-ship": async (page, device) => sparkShot(page, device, "ships"),
  "spark-satellite": async (page, device) => sparkShot(page, device, "satellites"),
};

/** Fresh pages that must not wait for the opening shot, and what to set up before the app loads. */
const special = {
  "start-error": {
    init: () => {
      const native = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        return /webgl/i.test(type) ? null : native.call(this, type, ...rest);
      };
    },
    ready: (page) => page.waitForSelector(".start-error", { timeout: 30_000 }),
  },
};

/** Select a stand-in ship or satellite and give it a series, so the strip can be judged in place. */
async function sparkShot(page, device, layer) {
  // Let the controller find nothing first, so its answer does not land on top of the stand-in.
  await store(
    page,
    (_, haloActions, which) =>
      haloActions().select({ kind: which === "ships" ? 2 : 3, id: 0xfffffc }),
    layer,
  );
  await page.waitForSelector(".detail-gone", { timeout: 8000 }).catch(() => {});
  await store(
    page,
    (_, haloActions, which) => {
      const now = Date.now();
      const ship = which === "ships";
      const ref = { kind: ship ? 2 : 3, id: 0xfffffc };
      haloActions().select(ref);
      const minutes = ship ? 26 : 92;
      const timesMs = Array.from(
        { length: 48 },
        (_, i) => now - minutes * 60_000 + (i * minutes * 60_000) / 47,
      );
      const values = ship
        ? timesMs.map((_, i) => (i < 14 ? 2.1 + i * 0.32 : 6.6 + Math.sin(i / 3) * 0.12))
        : timesMs.map((_, i) => 417_000 + 5200 * Math.sin((i / 47) * 2 * Math.PI + 0.6));
      haloActions().setDetail(
        {
          ref,
          layer: which,
          title: ship ? "Finnmaid" : "ISS (Zarya)",
          subtitle: ship ? "Ro-ro passenger ship · Finland" : "Space station · Low Earth orbit",
          lon: ship ? 22.1 : 31.4,
          lat: ship ? 59.6 : 41.2,
          alt: ship ? 0 : values[values.length - 1],
          heading: 74,
          speed: ship ? values[values.length - 1] : 7660,
          fixTimeMs: now - 4000,
          fields: ship
            ? [
                { key: "speed", label: "Speed", value: "12.9", unit: "kt", numeric: 12.9 },
                { key: "heading", label: "Course", value: "74", unit: "°", numeric: 74 },
                { key: "lengthM", label: "Length", value: "218", unit: "m", numeric: 218 },
                { key: "draughtM", label: "Draught", value: "6.6", unit: "m", numeric: 6.6 },
                { key: "id", label: "MMSI", value: "230361000" },
              ]
            : [
                {
                  key: "inclinationDeg",
                  label: "Inclination",
                  value: "51.6",
                  unit: "°",
                  numeric: 51.6,
                },
                { key: "periodMin", label: "Period", value: "92.9", unit: "min", numeric: 92.9 },
                { key: "id", label: "NORAD number", value: "25544" },
              ],
          attribution: ship
            ? {
                text: "Source: Fintraffic / digitraffic.fi, license CC 4.0 BY",
                url: "https://www.digitraffic.fi/",
              }
            : { text: "Satellite orbits: CelesTrak", url: "https://celestrak.org/" },
        },
        "ready",
      );
      haloActions().setTrackSeries({ measure: ship ? "speed" : "altitude", timesMs, values });
    },
    layer,
  );
  await page.waitForTimeout(600);
  if (device === "phone") {
    await page.locator(".sheet-handle").tap();
    await page.waitForTimeout(500);
  }
}

/** HUD elements that overlap the map's own credit line, which the HUD must leave clear. */
const creditClashes = (page) =>
  page.evaluate(() => {
    const credits = document.querySelector(".halo-credits");
    if (!credits || credits.hidden) return null;
    const c = credits.getBoundingClientRect();
    const hits = [];
    const selectors = [
      ".brand",
      ".status",
      ".search",
      ".dock",
      ".phone-notes",
      ".detail",
      ".ticker",
      ".tape-wrap",
      ".back-to-live",
      ".start-error",
    ];
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (r.width === 0 || style.display === "none" || Number(style.opacity) < 0.05) continue;
        if (r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top)
          hits.push(sel);
      }
    }
    return { hits, box: [c.left, c.top, c.width, c.height].map(Math.round) };
  });

const closeUps = [
  ["dock", "default", ".dock", 8],
  ["dock-offline", "offline", ".dock", 8],
  ["detail", "selected", ".detail", 8],
  ["search", "search", ".search", 8],
  ["tape", "default", ".tape-wrap", 16],
  ["tape-scrubbed", "scrubbed", ".tape-wrap", 16, 140],
  ["top-left", "default", ".brand", 14],
  ["top-right", "default", ".status", 14],
];

const browser = await chromium.launch({
  channel: "msedge",
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
});

async function open(context, name, setup = {}) {
  const page = await context.newPage();
  if (setup.init) await page.addInitScript(setup.init);
  // With Windows "Transparency effects" off, Edge reports prefers-reduced-transparency and the
  // glass swaps to its solid fallback. Capture the real glass whatever this machine is set to.
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-transparency", value: solid ? "reduce" : "no-preference" }],
  });
  // Other people edit this checkout while shots run: without Vite's socket the page is not reloaded under them.
  // Only the dev server's own socket is cut, so a gateway connection still behaves as it would.
  await page.routeWebSocket(
    (url) => url.host === new URL(base).host,
    () => {},
  );
  // CelesTrak allows one download per update per address; satellites come from the bundled snapshot here.
  await page.route(/celestrak.org/, (route) => route.abort("blockedbyclient"));
  page.on("pageerror", (e) => console.error(`  [${name}] page error: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") console.error(`  [${name}] console: ${m.text().slice(0, 300)}`);
  });
  await page.goto(`${base}/?${query}`);
  if (setup.ready) {
    await setup.ready(page);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1000);
    return page;
  }
  // The opening shot ends when the store says so; any shot before that would be mid-entrance.
  const deadline = Date.now() + 45_000;
  while (!(await store(page, (useHalo) => useHalo.getState().intro === "done"))) {
    if (Date.now() > deadline) throw new Error("the opening shot never finished");
    await page.waitForTimeout(250);
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(Number(args.settle ?? 2500));
  return page;
}

for (const device of runDevices) {
  const options = devices[device];
  if (!options) throw new Error(`unknown device "${device}"`);
  for (const [name, prepare] of Object.entries(states)) {
    if (only && !only.some((o) => name.includes(o))) continue;
    if (name === "selected-full" && device !== "phone") continue;
    const label = `${device}-${name}`;
    console.log(label);
    const context = await browser.newContext({
      ...options,
      reducedMotion: reduced ? "reduce" : "no-preference",
    });
    try {
      const page = await open(context, label, special[name]);
      await wake(page);
      await prepare(page, device);
      if (name !== "idle") await wake(page);
      await page.screenshot({ path: join(out, `${label}${suffix}.png`) });
      const clash = await creditClashes(page);
      if (clash?.hits.length)
        console.error(
          `  overlaps the map credits (${clash.box.join(", ")}): ${clash.hits.join(", ")}`,
        );
    } catch (error) {
      console.error(`  ${label} failed: ${error.message}`);
    }
    await context.close();
  }
}

if (args.crops === "true") {
  const context = await browser.newContext({ ...devices.desktop, deviceScaleFactor: 2 });
  for (const [name, state, selector, pad = 8, padRight] of closeUps) {
    if (only && !only.some((o) => name.includes(o))) continue;
    console.log(`crop ${name}`);
    try {
      const page = await open(context, name);
      await wake(page);
      await states[state](page, "desktop");
      await wake(page);
      const box = await page.locator(selector).first().boundingBox();
      if (!box) throw new Error(`no box for ${selector}`);
      await page.screenshot({
        path: join(out, "crops", `${name}.png`),
        clip: {
          x: Math.max(0, box.x - pad),
          y: Math.max(0, box.y - pad),
          width: box.width + pad + (padRight ?? pad),
          height: box.height + pad * 2,
        },
      });
      await page.close();
    } catch (error) {
      console.error(`  crop ${name} failed: ${error.message}`);
    }
  }
  await context.close();
}

await browser.close();
