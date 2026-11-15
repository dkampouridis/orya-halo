// Captures every mockup state into .screenshots/mockup/ (ignored by git).
//
//   cd apps/web && node ../../docs/mockup/shots.mjs            all states, desktop and phone
//   cd apps/web && node ../../docs/mockup/shots.mjs --crops    also 2x crops of each component
//   cd apps/web && node ../../docs/mockup/shots.mjs --solid    with the solid-glass fallback
//
// Run from apps/web: that is where Playwright is installed. Uses the installed Edge.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { chromium } = createRequire(join(process.cwd(), "package.json"))("playwright");

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../.screenshots/mockup");
const page = pathToFileURL(join(here, "index.html")).href;
const crops = process.argv.includes("--crops");
const solid = process.argv.includes("--solid"); // capture the solid-glass fallback instead
mkdirSync(join(out, "crops"), { recursive: true });

const desktop = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };
const phone = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
};

const shots = [
  ["desktop-default", desktop, "default"],
  ["desktop-selected", desktop, "selected"],
  ["desktop-search", desktop, "search"],
  ["desktop-scrubbed", desktop, "scrubbed"],
  ["desktop-idle", desktop, "idle"],
  ["desktop-offline", desktop, "offline"],
  ["phone-default", phone, "default"],
  ["phone-selected-peek", phone, "selected"],
  ["phone-selected-full", phone, "selected-full"],
  ["phone-search", phone, "search"],
  ["phone-scrubbed", phone, "scrubbed"],
  ["phone-offline", phone, "offline"],
];

// Component close-ups at 2x, for judging type and hairlines.
const closeUps = [
  ["dock", "selected", ".dock"],
  ["dock-offline", "offline", ".dock"],
  ["detail", "selected", ".detail"],
  ["search", "search", ".search"],
  ["tape", "default", ".tape-wrap", 16],
  ["tape-scrubbed", "scrubbed", ".tape-wrap", 16, 140],
  ["reticle", "selected", "#pick", 90],
  ["hover-tag", "default", "#tag", 60],
  ["top-left", "default", ".brand", 14],
  ["top-right", "default", ".status", 14],
];

const browser = await chromium.launch({ channel: "msedge" });

async function open(context, state) {
  const p = await context.newPage();
  // With Windows "Transparency effects" off, Edge reports prefers-reduced-transparency and the
  // glass swaps to its solid fallback. Capture the real glass whatever this machine is set to.
  const cdp = await context.newCDPSession(p);
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-transparency", value: solid ? "reduce" : "no-preference" }],
  });
  p.on("pageerror", (e) => console.error(`[${state}] page error: ${e.message}`));
  p.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning")
      console.error(`[${state}] ${m.type()}: ${m.text()}`);
  });
  await p.goto(`${page}?shot#${state}`);
  await p.waitForFunction(() => window.__haloReady === true, null, { timeout: 30000 });
  await p.waitForTimeout(state === "idle" ? 900 : 450); // let the state's transition settle
  return p;
}

for (const [name, device, state] of shots) {
  const context = await browser.newContext(device);
  const p = await open(context, state);
  const file = join(out, `${name}.png`);
  await p.screenshot({ path: file });
  console.log(file);
  await context.close();
}

// The icon family, wordmark and favicon on one sheet.
{
  const context = await browser.newContext({
    viewport: { width: 1100, height: 900 },
    deviceScaleFactor: 2,
  });
  const p = await context.newPage();
  await p.goto(pathToFileURL(join(here, "icons.html")).href);
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(300);
  const file = join(out, "icons.png");
  await p.screenshot({ path: file, fullPage: true });
  console.log(file);
  await context.close();
}

if (crops) {
  const context = await browser.newContext({ ...desktop, deviceScaleFactor: 2 });
  for (const [name, state, selector, pad = 8, padRight] of closeUps) {
    const p = await open(context, state);
    const box = await p.locator(selector).first().boundingBox();
    if (!box) {
      console.error(`no box for ${selector}`);
      continue;
    }
    const clip = {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: box.width + pad + (padRight ?? pad),
      height: box.height + pad * 2,
    };
    const file = join(out, "crops", `${name}.png`);
    await p.screenshot({ path: file, clip });
    console.log(file);
    await p.close();
  }
  await context.close();
}

await browser.close();
