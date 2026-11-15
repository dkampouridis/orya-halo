#!/usr/bin/env node
// Runs axe-core against the real HUD in the states the accessibility review asks for, on
// desktop and phone, in the installed Microsoft Edge, and prints every violation with the
// elements it names. Rules that need a human (axe's "incomplete", mostly contrast over the
// live globe) are counted and listed by rule.
//
//   node scripts/hud-axe.mjs                  every state, desktop and phone
//   node scripts/hud-axe.mjs --only=about     states whose name contains "about"
//   node scripts/hud-axe.mjs --device=phone
//
// Needs `@axe-core/playwright` (a dev dependency of this package:
// `node scripts/pnpm-locked.mjs add --filter @orya-halo/web -D @axe-core/playwright` from the
// repository root) and the dev server (`vp dev --port 5183` in apps/web). Exit code 1 if any
// violation is found.
import { chromium } from "playwright";

let AxeBuilder;
try {
  ({ default: AxeBuilder } = await import("@axe-core/playwright"));
} catch {
  console.error(
    "@axe-core/playwright is not installed. From the repository root:\n" +
      "  node scripts/pnpm-locked.mjs add --filter @orya-halo/web -D @axe-core/playwright",
  );
  process.exit(2);
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const at = a.indexOf("=");
    return at < 0 ? [a.replace(/^--/, ""), "true"] : [a.slice(2, at), a.slice(at + 1)];
  }),
);
const base = args.base ?? "http://localhost:5183";
const query = args.query ?? "synthetic=6000&gateway=off";

const devices = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
};

const store = (page, fn) =>
  page.evaluate(async (source) => {
    const { useHalo, haloActions } = await import("/src/core/store.ts");
    // eslint-disable-next-line no-new-func
    return new Function("useHalo", "haloActions", `return (${source})(useHalo, haloActions)`)(
      useHalo,
      haloActions,
    );
  }, fn.toString());

const selectSomething = (page) =>
  page.evaluate(async () => {
    const { getServices } = await import("/src/core/services.ts");
    const { haloActions } = await import("/src/core/store.ts");
    for (const term of ["syn", "a", "e"]) {
      const results = (await getServices()?.search(term)) ?? [];
      const hit = results.find((r) => r.type === "entity" && r.ref && r.layer !== "cables");
      if (hit) {
        haloActions().select(hit.ref);
        return true;
      }
    }
    return false;
  });

const states = {
  default: async () => {},
  selected: async (page) => {
    await selectSomething(page);
    await page.waitForSelector(".detail-name", { timeout: 8000 });
    await page.waitForTimeout(600);
  },
  "search-open": async (page, device) => {
    if (device === "phone") await page.locator(".search-open").tap();
    else await page.keyboard.press("/");
    await page.keyboard.type("at", { delay: 30 });
    await page.waitForSelector(".result", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(300);
  },
  about: async (page) => {
    await store(page, (_, haloActions) => haloActions().setOverlay("attribution"));
    await page.waitForSelector(".source-item", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);
  },
  shortcuts: async (page) => {
    await store(page, (_, haloActions) => haloActions().setOverlay("shortcuts"));
    await page.waitForSelector(".keys", { timeout: 8000 });
    await page.waitForTimeout(500);
  },
};

const browser = await chromium.launch({
  channel: "msedge",
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
});

let violations = 0;
for (const [device, options] of Object.entries(devices)) {
  if (args.device && args.device !== device) continue;
  for (const [name, prepare] of Object.entries(states)) {
    if (args.only && !name.includes(args.only)) continue;
    const context = await browser.newContext(options);
    const page = await context.newPage();
    await page.routeWebSocket(
      (url) => url.host === new URL(base).host,
      () => {},
    );
    await page.goto(`${base}/?${query}`);
    const deadline = Date.now() + 45_000;
    while (!(await store(page, (useHalo) => useHalo.getState().intro === "done"))) {
      if (Date.now() > deadline) throw new Error("the opening shot never finished");
      await page.waitForTimeout(250);
    }
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" })));
    await page.waitForTimeout(1500);
    await prepare(page, device);
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      // The globe's canvases are pictures with their own text alternative (the live region).
      .exclude("#globe canvas")
      .analyze();
    violations += result.violations.length;
    console.log(
      `${device}-${name}: ${result.violations.length} violations, ${result.incomplete.length} to review`,
    );
    for (const v of result.violations) {
      console.log(`  ${v.id} (${v.impact}): ${v.help}`);
      for (const node of v.nodes.slice(0, 6))
        console.log(
          `    ${node.target.join(" ")}  ${node.failureSummary?.split("\n")[1]?.trim() ?? ""}`,
        );
    }
    if (result.incomplete.length)
      console.log(
        `  to review: ${result.incomplete.map((i) => `${i.id} (${i.nodes.length})`).join(", ")}`,
      );
    await context.close();
  }
}
await browser.close();
process.exit(violations ? 1 : 0);
