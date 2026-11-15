#!/usr/bin/env node
// Regression guard for "Invalid value for edge-insets, top, bottom, left and
// right must all be numbers", which MapLibre throws from inside its render loop
// when the camera padding goes negative.
//
// The cause was the engine's first frame. The frame loop seeds its clock with
// `performance.now()` and then requests an animation frame; the timestamp the
// browser hands that frame is when the frame *began*, which can be earlier than
// the seed. The first `dt` came out negative, the hand-eased padding stepped
// away from its target instead of towards it, and an inset moving from 0 up to
// 240 overshot below zero.
//
// Browsers do this only sometimes, so the check forces it: every callback the
// engine's frame loop receives in the first seconds is given a timestamp
// slightly in the past, exactly as a browser may. Then it runs the real app
// through the moves that ease padding (the opening shot, selecting, clearing,
// resizing to phone and back) and fails on any page error.
//
//   node scripts/check-padding.mjs [--base=http://localhost:5183] [--headed]
//
// Needs the dev server (`vp dev --port 5183`). Exits non-zero if a check fails.
import { chromium } from "playwright";

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const base = arg("base") ?? "http://localhost:5183";
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

/** Runs one page load; returns the page errors it saw. */
async function run({ skewMs, viewport, label }) {
  const page = await browser.newPage({ viewport });
  await page.routeWebSocket(/.*/, () => {});
  // Only this dev server: the check is about the camera, and must not spend
  // anyone's rate limit (CelesTrak allows one download per update per address).
  // Without them the layers fall back to bundled data or show as offline.
  const local = new URL(base).host;
  await page.route(
    (url) => url.host !== local,
    (route) => route.abort("blockedbyclient"),
  );
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message.split("\n")[0]));
  if (skewMs > 0) {
    await page.addInitScript((skew) => {
      const native = window.requestAnimationFrame.bind(window);
      const until = performance.now() + 30_000;
      // The engine's loop is the class field `frame`; MapLibre's and deck.gl's
      // loops keep their real timestamps.
      window.requestAnimationFrame = (cb) =>
        native((ts) => cb(cb.name === "frame" && performance.now() < until ? ts - skew : ts));
    }, skewMs);
  }
  await page.goto(`${base}/?gateway=off&synthetic=3000`, { waitUntil: "load" });
  await page.waitForSelector("canvas", { timeout: 60_000 });
  // The opening shot: stars, orbit, the flight to the region.
  await page.waitForTimeout(5000);

  const { width, height } = viewport;
  for (let i = 0; i < 4; i++) {
    // Click around the middle of the globe; whatever is hit gets selected and
    // the right-hand panel's padding eases in, or the selection is cleared.
    await page.mouse.click(width * (0.45 + 0.03 * i), height * (0.5 - 0.02 * i));
    await page.waitForTimeout(900);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
  }
  // Phone width moves the HUD to the bottom: every inset changes at once.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1500);
  await page.setViewportSize(viewport);
  await page.waitForTimeout(1500);
  await page.close();
  check(`${label}: no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
}

try {
  await run({ skewMs: 0, viewport: { width: 1440, height: 900 }, label: "natural timing" });
  // Each skew forces a negative first dt of a different size.
  for (const skewMs of [8, 40, 100]) {
    await run({
      skewMs,
      viewport: { width: 1440, height: 900 },
      label: `first frame ${skewMs} ms early`,
    });
  }
  await run({ skewMs: 40, viewport: { width: 390, height: 844 }, label: "phone, 40 ms early" });
} finally {
  await browser.close();
}
if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall padding checks passed");
