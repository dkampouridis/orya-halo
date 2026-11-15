#!/usr/bin/env node
// Drives the real HUD with real input in the installed Microsoft Edge and reports what held:
// keyboard shortcuts, search, the time tape, dialogs and focus, the phone sheet's drag, the
// fonts' width axis, and how many times each component renders while the clock ticks.
//
//   node scripts/hud-check.mjs                 everything
//   node scripts/hud-check.mjs --only=tape     checks whose name contains "tape"
//   node scripts/hud-check.mjs --seconds=20    length of the render-count window
//   node scripts/hud-check.mjs --only=retry    "Try again" against a gateway that refuses every connection
//
// The dev server must be running: `vp dev --port 5183` in apps/web. Exit code 1 if any check fails.
import { chromium } from "playwright";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const at = a.indexOf("=");
    return at < 0 ? [a.replace(/^--/, ""), "true"] : [a.slice(2, at), a.slice(at + 1)];
  }),
);
const base = args.base ?? "http://localhost:5183";
const query = args.query ?? "synthetic=6000&gateway=off";
const seconds = Number(args.seconds ?? 10);

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "pass" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const wanted = (name) => !args.only || name.includes(args.only);

/**
 * Counts renders per component the way React DevTools does: on each commit, walk the fibers
 * that were worked on and count the function components that actually ran (PerformedWork).
 * Installed before React loads, so it sees every commit. Nothing is added to the app's code.
 */
const RENDER_COUNTER = () => {
  const counts = {};
  const PERFORMED_WORK = 1;
  const name = (fiber) => {
    const type = fiber.type;
    if (typeof type === "function") return type.displayName || type.name || null;
    if (type && typeof type === "object" && type.type)
      return type.type.displayName || type.type.name || null;
    return null;
  };
  const walk = (next, prev) => {
    if (!next || next === prev) return;
    const label = name(next);
    if (label && (next.flags & PERFORMED_WORK) === PERFORMED_WORK)
      counts[label] = (counts[label] ?? 0) + 1;
    if (prev && next.child === prev.child) return;
    for (let child = next.child; child; child = child.sibling) walk(child, child.alternate);
  };
  window.__renders = { counts, reset: () => Object.keys(counts).forEach((k) => delete counts[k]) };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject: () => 1,
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id, root) {
      walk(root.current, root.current.alternate);
    },
  };
};

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

async function open(browser, options) {
  const context = await browser.newContext(options);
  await context
    .grantPermissions(["clipboard-read", "clipboard-write"], { origin: base })
    .catch(() => {});
  const page = await context.newPage();
  await page.addInitScript(RENDER_COUNTER);
  // Other people edit this checkout while checks run: without Vite's socket the page is not reloaded under them.
  await page.routeWebSocket(
    (url) => url.host === new URL(base).host,
    () => {},
  );
  // CelesTrak allows one download per update per address; satellites come from the bundled snapshot here.
  await page.route(/celestrak.org/, (route) => route.abort("blockedbyclient"));
  page.on("pageerror", (e) => console.log(`      page error: ${e.message.slice(0, 160)}`));
  await page.goto(`${base}/?${query}`);
  const deadline = Date.now() + 45_000;
  while (!(await store(page, (useHalo) => useHalo.getState().intro === "done"))) {
    if (Date.now() > deadline) throw new Error("the opening shot never finished");
    await page.waitForTimeout(250);
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500);
  return { context, page };
}

/** A full buffer to scrub through, whatever this page has recorded so far. */
const fillHistory = (page) =>
  store(page, (_, haloActions) => {
    const now = Date.now();
    haloActions().setHistory({ fromMs: now - 30 * 60_000, toMs: now });
  });
const clock = (page) =>
  store(page, (useHalo) => {
    const c = useHalo.getState().clock;
    return { mode: c.mode, behindMin: Math.round((Date.now() - c.timeMs) / 60_000) };
  });
const selectSomething = (page) =>
  page.evaluate(async () => {
    const { getServices } = await import("/src/core/services.ts");
    const { haloActions } = await import("/src/core/store.ts");
    for (const term of ["syn", "a", "e"]) {
      const results = (await getServices()?.search(term)) ?? [];
      const hit =
        results.find((r) => r.type === "entity" && r.ref && r.layer !== "cables") ??
        results.find((r) => r.ref);
      if (hit) {
        haloActions().select(hit.ref);
        return hit.title;
      }
    }
    return null;
  });

const browser = await chromium.launch({
  channel: "msedge",
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
});

// ---------------------------------------------------------------- desktop
{
  const { context, page } = await open(browser, { viewport: { width: 1440, height: 900 } });

  if (wanted("fonts")) {
    const fonts = await page.evaluate(() => {
      const width = (family, stretch, weight) => {
        const el = document.createElement("span");
        el.textContent = "Handgloves 0123456789";
        el.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font-family:"${family}";font-size:40px;font-weight:${weight};font-stretch:${stretch}%`;
        document.body.append(el);
        const w = el.getBoundingClientRect().width;
        el.remove();
        return Math.round(w);
      };
      const requests = performance
        .getEntriesByType("resource")
        .map((r) => r.name)
        .filter((n) => /\.woff2/.test(n));
      const style = (sel) => {
        const c = getComputedStyle(document.querySelector(sel));
        return `${c.fontFamily.split(",")[0]} ${c.fontSize}/${c.lineHeight} ${c.fontWeight} ${c.fontStretch}`;
      };
      const digits = ["0", "1", "8", ",", ":", "."].map((ch) => {
        const el = document.createElement("span");
        el.className = "num";
        el.textContent = ch.repeat(20);
        el.style.cssText = "position:absolute;visibility:hidden";
        document.querySelector(".hud").append(el);
        const w = el.getBoundingClientRect().width;
        el.remove();
        return w;
      });
      return {
        archivo: [
          width("Archivo Variable", 62, 400),
          width("Archivo Variable", 100, 400),
          width("Archivo Variable", 125, 400),
        ],
        mono: [width("Martian Mono Variable", 75, 300), width("Martian Mono Variable", 112.5, 300)],
        thirdParty: requests.filter((n) => !n.startsWith(location.origin)),
        files: requests.map((n) => n.split("/").pop().split("?")[0]),
        brand: style(".brand-name"),
        rowName: style(".row-name"),
        count: style(".row-count, .status .num"),
        digitsEqual: new Set(digits.map((w) => w.toFixed(2))).size === 1,
      };
    });
    check(
      "fonts: Archivo's width axis is live",
      fonts.archivo[0] < fonts.archivo[1] && fonts.archivo[1] < fonts.archivo[2],
      fonts.archivo.join(" < "),
    );
    check(
      "fonts: Martian Mono's width axis is live",
      fonts.mono[0] < fonts.mono[1],
      fonts.mono.join(" < "),
    );
    check(
      "fonts: self-hosted, no third-party font requests",
      fonts.thirdParty.length === 0,
      fonts.files.join(", "),
    );
    check(
      "fonts: Martian Mono digits, comma, colon and point share one advance",
      fonts.digitsEqual,
    );
    console.log(`      name ${fonts.brand}; label ${fonts.rowName}; data ${fonts.count}`);
  }

  if (wanted("render")) {
    // Keep the HUD awake without touching anything, then count renders over a quiet window.
    const awake = setInterval(
      () =>
        page
          .evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" })))
          .catch(() => {}),
      3000,
    );
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" })));
    await page.waitForTimeout(500);
    await page.evaluate(() => window.__renders.reset());
    await page.waitForTimeout(seconds * 1000);
    const idle = await page.evaluate(() => ({ ...window.__renders.counts }));
    console.log(`      renders in ${seconds} s, live, nothing selected: ${JSON.stringify(idle)}`);
    // Unit is the clock's own "utc" label; Num and Total move only when a count does; the
    // ticker re-renders when the minute turns ("2 min ago") or a new event arrives.
    const allowed = new Set(["Clock", "Unit", "Fps", "Num", "Total", "Ticker"]);
    const others = Object.keys(idle).filter((k) => !allowed.has(k));
    check(
      "render isolation: a clock tick re-renders the clock only",
      (idle.Clock ?? 0) >= seconds - 2 && others.length === 0,
      `unexpected: ${others.join(", ") || "none"}`,
    );
    check("render isolation: the tape redraws without a React render", (idle.Tape ?? 0) === 0);
    check(
      "render isolation: dock, search and frame stay still",
      !idle.Dock && !idle.Search && !idle.Frame && !idle.Hud,
    );

    // Hover: only the tag should move.
    await page.evaluate(() => window.__renders.reset());
    await store(page, (_, haloActions) => {
      for (let i = 0; i < 30; i++) {
        haloActions().setHover({
          ref: { kind: 1, id: 1 },
          layer: "aircraft",
          label: "BAW115  10,972 m",
          title: "BAW115",
          value: "10,972",
          unit: "m",
          x: 600 + i,
          y: 400,
          lon: 0,
          lat: 0,
        });
      }
    });
    await page.waitForTimeout(300);
    const hover = await page.evaluate(() => ({ ...window.__renders.counts }));
    const tagBox = await page.locator(".hover-tag").evaluate((el) => ({
      events: getComputedStyle(el).pointerEvents,
      text: el.textContent,
    }));
    // Before the worker answers there is only the engine's label: shown whole, never split.
    await store(page, (_, haloActions) =>
      haloActions().setHover({
        ref: { kind: 1, id: 2 },
        layer: "aircraft",
        label: "AAL107  9,144 m",
        x: 600,
        y: 400,
        lon: 0,
        lat: 0,
      }),
    );
    await page.waitForTimeout(100);
    const fallback = await page
      .locator(".hover-tag")
      .evaluate((el) => [...el.children].map((c) => c.className));
    await store(page, (_, haloActions) => haloActions().setHover(null));
    const hoverOthers = Object.keys(hover).filter(
      (k) => !["HoverTag", "Clock", "Unit", "Fps", "Num", "Total", "Ticker"].includes(k),
    );
    check(
      "render isolation: hover re-renders the tag only",
      (hover.HoverTag ?? 0) >= 1 && hoverOthers.length === 0,
      JSON.stringify(hover),
    );
    check(
      "hover tag takes no pointer events and sets title, number and unit apart",
      tagBox.events === "none" && tagBox.text === "BAW11510,972m",
      `${tagBox.events} "${tagBox.text}"`,
    );
    check(
      "hover tag falls back to the engine's label, whole",
      fallback.length === 1 && fallback[0] === "tag-name",
      fallback.join(", "),
    );

    // With something selected the panel refreshes every 2 s; the dock still should not.
    const title = await selectSomething(page);
    await page.waitForSelector(".detail-name", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(3000);
    await page.evaluate(() => window.__renders.reset());
    await page.waitForTimeout(seconds * 1000);
    const selected = await page.evaluate(() => ({ ...window.__renders.counts }));
    console.log(
      `      renders in ${seconds} s with "${title}" selected: ${JSON.stringify(selected)}`,
    );
    check(
      "render isolation: the detail refresh stays inside the panel",
      !selected.Dock && !selected.Tape && !selected.Search && !selected.Frame,
    );
    clearInterval(awake);
    await store(page, (_, haloActions) => haloActions().select(null));
    await page.waitForTimeout(400);
  }

  if (wanted("keys")) {
    await page.mouse.move(700, 500);
    const before = await store(page, (useHalo) => useHalo.getState().layers.radar.enabled);
    await page.keyboard.press("6");
    await page.waitForTimeout(150);
    const toggled = await store(page, (useHalo) => useHalo.getState().layers.radar.enabled);
    check("keys: 6 toggles rain radar", toggled === !before);
    await page.keyboard.press("6");

    await page.keyboard.press("/");
    await page.waitForTimeout(200);
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("role"));
    const empty = await page.locator(".search input").inputValue();
    check(
      "keys: / opens search and focuses the field without typing a slash",
      focused === "combobox" && empty === "",
      `${focused} "${empty}"`,
    );

    const layersBefore = await store(page, (useHalo) =>
      JSON.stringify(Object.values(useHalo.getState().layers).map((l) => l.enabled)),
    );
    await page.keyboard.type("1f0m", { delay: 30 });
    await page.waitForTimeout(200);
    const layersAfter = await store(page, (useHalo) =>
      JSON.stringify(Object.values(useHalo.getState().layers).map((l) => l.enabled)),
    );
    const sound = await store(page, (useHalo) => useHalo.getState().sound);
    check(
      "keys: typing in the field triggers no shortcut",
      layersBefore === layersAfter &&
        sound === false &&
        (await page.locator(".search input").inputValue()) === "1f0m",
    );

    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    check(
      "keys: Esc closes search and clears the field",
      !(await store(page, (useHalo) => useHalo.getState().searchOpen)) &&
        (await page.locator(".search input").inputValue()) === "",
    );
  }

  if (wanted("search")) {
    await page.keyboard.press("/");
    await page.keyboard.type("at", { delay: 40 });
    await page.waitForSelector(".result", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(300);
    const first = await page.evaluate(() => ({
      active: document.querySelector(".search input").getAttribute("aria-activedescendant"),
      selected: [...document.querySelectorAll(".result")].findIndex(
        (r) => r.getAttribute("aria-selected") === "true",
      ),
      count: document.querySelectorAll(".result").length,
      groups: [...document.querySelectorAll(".group-name")].map((g) => g.textContent),
    }));
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    const moved = await page.evaluate(() => ({
      active: document.querySelector(".search input").getAttribute("aria-activedescendant"),
      selected: [...document.querySelectorAll(".result")].findIndex(
        (r) => r.getAttribute("aria-selected") === "true",
      ),
      title: document.querySelector('.result[aria-selected="true"] .result-name')?.textContent,
    }));
    check(
      "search: results arrive grouped, first one active",
      first.count > 0 && first.count <= 8 && first.selected === 0,
      `${first.count} results in ${first.groups.join(", ")}`,
    );
    check(
      "search: arrow keys move the active result",
      moved.selected === 1 && moved.active === "search-option-1",
      `${moved.active}`,
    );
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    const after = await store(page, (useHalo) => ({
      open: useHalo.getState().searchOpen,
      selection: useHalo.getState().selection,
    }));
    const panelTitle = await page
      .locator(".detail-name")
      .textContent({ timeout: 6000 })
      .catch(() => null);
    check(
      "search: Enter opens the active result and closes search",
      after.open === false && (after.selection === null || panelTitle === moved.title),
      `"${moved.title}" -> ${after.selection ? `panel "${panelTitle}"` : "a place: camera flies"}`,
    );

    if (after.selection) {
      await page.waitForTimeout(1500);
      const expected = await page.evaluate(async () =>
        (await import("/src/core/services.ts")).getServices().shareUrl(),
      );
      await page.getByRole("button", { name: "Copy link" }).click();
      await page.waitForTimeout(300);
      const label = await page.locator(".actions .btn").last().textContent();
      const clip = await page
        .evaluate(() => navigator.clipboard.readText())
        .catch(() => "(clipboard unreadable)");
      const said = await page.locator('.hud [aria-live="polite"]').textContent();
      check(
        "detail: Copy link copies the share URL and confirms it",
        label === "Link copied" &&
          clip.split("#")[1]?.includes("s=") &&
          clip.split("&s=")[1] === expected.split("&s=")[1],
        `button "${label}", announced "${said}"`,
      );
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      check(
        "keys: Esc clears the selection",
        (await store(page, (useHalo) => useHalo.getState().selection)) === null,
      );
    }
  }

  if (wanted("tape")) {
    await fillHistory(page);
    await page.locator(".tape").focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(200);
    const back3 = await clock(page);
    const flag = await page.locator(".needle-flag").innerText();
    const aria = await page.locator(".tape").getAttribute("aria-valuetext");
    check(
      "tape: three left arrows scrub three minutes back",
      back3.mode === "scrub" && back3.behindMin === 3,
      `flag "${flag}", ${aria}`,
    );
    await page.keyboard.press("Shift+ArrowLeft");
    await page.waitForTimeout(150);
    check("tape: Shift+left goes five more", (await clock(page)).behindMin === 8);
    const unit = await page.locator(".status-count .unit").textContent();
    check("tape: the count reads in replay while scrubbed", unit === "in replay", unit);
    await page.keyboard.press("End");
    await page.waitForTimeout(200);
    check(
      "tape: End returns to live",
      (await clock(page)).mode === "live" &&
        (await page.locator(".needle-flag").innerText()) === "live",
    );

    const box = await page.locator(".tape").boundingBox();
    await page.mouse.move(box.x + 200, box.y + 24);
    await page.mouse.down();
    await page.mouse.move(box.x + 260, box.y + 24, { steps: 6 });
    await page.mouse.move(box.x + 320, box.y + 24, { steps: 6 });
    await page.waitForTimeout(100);
    const mid = await clock(page);
    await page.mouse.up();
    await page.waitForTimeout(250);
    const dragged = await clock(page);
    check(
      "tape: dragging 120px right scrubs twelve minutes back",
      dragged.mode === "scrub" && dragged.behindMin === 12 && mid.mode === "scrub",
      `${dragged.behindMin} min`,
    );
    await page.getByRole("button", { name: "Back to live" }).click();
    await page.waitForTimeout(300);
    check(
      "tape: Back to live returns to live and the button leaves",
      (await clock(page)).mode === "live" && (await page.locator(".back-to-live").count()) === 0,
    );
    await page.keyboard.press("l");

    await store(page, (_, haloActions) => haloActions().setHistory(null));
    await page.waitForTimeout(150);
    await page.locator(".tape").focus();
    await page.keyboard.press("ArrowLeft");
    const locked = await clock(page);
    const why = await page
      .locator(".tape-empty")
      .textContent()
      .catch(() => null);
    check(
      "tape: with no history it is disabled and says why",
      locked.mode === "live" &&
        (await page.locator(".tape").getAttribute("aria-disabled")) === "true" &&
        Boolean(why),
      why ?? "",
    );
  }

  if (wanted("dialog")) {
    await page.locator(".dock-tools .tool").nth(4).focus();
    await page.keyboard.press("?");
    await page.waitForSelector(".keys", { timeout: 8000 });
    await page.waitForTimeout(400);
    const where = () =>
      page.evaluate(() => {
        const el = document.activeElement;
        return {
          inside: Boolean(el?.closest("[role=dialog]")),
          on: el?.getAttribute("aria-label") ?? el?.tagName ?? "nothing",
        };
      });
    // Focus moves in once the sheet has opened; give it a moment, and report how long it took.
    const opened = Date.now();
    let first = await where();
    while (!first.inside && Date.now() - opened < 2000) {
      await page.waitForTimeout(50);
      first = await where();
    }
    const tookMs = Date.now() - opened;
    // At typing speed: Base UI's focus guards hand focus back a moment after it lands on them,
    // and Tabs fired back to back with no gap can catch a guard mid-hand-off.
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      await page.waitForTimeout(60);
    }
    const later = await where();
    check(
      "dialog: shortcuts sheet opens with ?, takes focus and traps Tab",
      first.inside && later.inside,
      `focus on "${first.on}" after ${tookMs} ms more, after six Tabs on "${later.on}"`,
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    const restored = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    check(
      "dialog: Esc closes it and focus returns to where it was",
      (await store(page, (useHalo) => useHalo.getState().overlay)) === "none" &&
        restored === "Keyboard shortcuts",
      `focus on "${restored}"`,
    );

    await page.locator(".brand").click();
    await page.waitForSelector(".source-item", { timeout: 8000 }).catch(() => {});
    const about = await page.evaluate(() => ({
      sources: document.querySelectorAll(".source-item").length,
      licences: [...document.querySelectorAll(".source-meta a")].filter((a) =>
        a.href.startsWith("http"),
      ).length,
      text: document.querySelector("[role=dialog]")?.textContent ?? "",
    }));
    check(
      "about: lists every source with a licence link, plus the base map and NASA credits",
      about.sources > 0 &&
        about.licences >= about.sources &&
        /OpenStreetMap/.test(about.text) &&
        /NASA/.test(about.text) &&
        /DATA_LICENCES/.test(about.text),
      `${about.sources} sources`,
    );
    await page.locator("[role=dialog] .switch").first().click();
    await page.waitForTimeout(600);
    const audio = await store(page, (useHalo) => useHalo.getState().sound);
    check("sound: the switch turns sound on (off by default)", audio === true);
    await page.locator("[role=dialog] .switch").first().click();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  }

  if (wanted("notes")) {
    const long =
      "Earthquakes are arriving late: the USGS summary feed has not changed for 14 minutes, so the newest events may be missing. Trying again every minute.";
    await store(
      page,
      (_, haloActions, message) =>
        haloActions().setLayerState("quakes", { status: "degraded", count: 285, message }),
      long,
    );
    await page.waitForTimeout(300);
    const note = await page.evaluate(() => {
      const row = [...document.querySelectorAll(".dock .row")].find((r) =>
        r.getAttribute("aria-label")?.startsWith("Earthquakes"),
      );
      const el = document.getElementById(row?.getAttribute("aria-describedby") ?? "");
      return el
        ? {
            height: el.getBoundingClientRect().height,
            text: el.textContent,
            lineHeight: parseFloat(getComputedStyle(el).lineHeight),
          }
        : null;
    });
    check(
      "notes: a long dock note is cut at two lines and stays whole for screen readers",
      note !== null && note.height <= 2 * note.lineHeight + 0.5 && note.text === long,
      note ? `${note.height}px` : "no note",
    );
    await page.locator(".row-note").filter({ hasText: "Earthquakes are" }).hover();
    await page.waitForTimeout(900);
    const tip = await page
      .locator(".tip-long")
      .textContent({ timeout: 2000 })
      .catch(() => null);
    check("notes: hovering the row shows the whole sentence", tip === long, tip ?? "no tooltip");
    await page.mouse.move(700, 500);
    await page.locator(".dock .row").nth(3).focus();
    await page.waitForTimeout(900);
    const tipOnFocus = await page
      .locator(".tip-long")
      .textContent({ timeout: 2000 })
      .catch(() => null);
    check(
      "notes: focusing the row shows the whole sentence",
      tipOnFocus === long,
      tipOnFocus ?? "no tooltip",
    );
    await page.evaluate(() => document.activeElement?.blur());
    await store(page, (_, haloActions) =>
      haloActions().setLayerState("quakes", { status: "live", count: 285 }),
    );
  }

  if (wanted("notice")) {
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
    await page.waitForTimeout(200);
    const shown = await page
      .locator(".engine-notice")
      .textContent()
      .catch(() => null);
    await store(page, (_, haloActions) =>
      haloActions().setEngineStatus({ basemap: "full", graphics: "ok" }),
    );
    await page.waitForTimeout(200);
    const after = await page.locator(".engine-notice").count();
    check(
      "notice: the engine's sentence shows in the dock, with the hint in a development build, and clears on recovery",
      Boolean(shown?.includes("base map could not be loaded") && shown.includes("fetch-tiles")) &&
        after === 0,
      shown ?? "",
    );
  }

  if (wanted("media")) {
    const photo = "https://t.plnspttrs.net/12345/1234567_abcdef0123_t.jpg";
    await store(page, (_, haloActions) => haloActions().select({ kind: 1, id: 0xfffffb }));
    await page.waitForSelector(".detail-gone", { timeout: 8000 }).catch(() => {});
    await store(
      page,
      (_, haloActions, url) => {
        const now = Date.now();
        haloActions().setDetail(
          {
            ref: { kind: 1, id: 0xfffffb },
            layer: "aircraft",
            title: "BAW115",
            subtitle: "Boeing 777-300ER · British Airways",
            lon: -46,
            lat: 49.2,
            alt: 10972,
            heading: 251,
            speed: 232.5,
            fixTimeMs: now - 2000,
            fields: [
              { key: "alt", label: "Altitude", value: "36,000", unit: "ft", numeric: 36000 },
            ],
            media: [
              {
                type: "image",
                url,
                link: "https://www.planespotters.net/photo/1234567",
                credit: "Photo © Anna Lindqvist, Planespotters.net",
                alt: "G-STBK",
              },
            ],
            attribution: { text: "adsb.lol", url: "https://adsb.lol" },
          },
          "ready",
        );
        // A climb then a level stretch: drawn. Then a series with nothing in it but noise: not drawn.
        const timesMs = Array.from({ length: 20 }, (_, i) => now - (19 - i) * 60_000);
        haloActions().setTrackSeries({
          measure: "altitude",
          timesMs,
          values: timesMs.map((_, i) => Math.min(3000 + i * 600, 10_972)),
        });
      },
      photo,
    );
    await page.waitForTimeout(300);
    const media = await page.evaluate(() => {
      const a = document.querySelector(".media a");
      const img = a?.querySelector("img");
      return a && img
        ? {
            rel: a.getAttribute("rel"),
            href: a.getAttribute("href"),
            target: a.getAttribute("target"),
            referrer: img.getAttribute("referrerpolicy"),
            loading: img.getAttribute("loading"),
            src: img.getAttribute("src"),
            srcset: img.hasAttribute("srcset") || img.hasAttribute("sizes"),
            caption: document.querySelector(".media figcaption")?.textContent,
          }
        : null;
    });
    check(
      "media: the photo is a plain link (rel noopener only), loaded as given, lazily, with the Referer and a visible credit",
      media !== null &&
        media.rel === "noopener" &&
        media.href === "https://www.planespotters.net/photo/1234567" &&
        media.referrer === null &&
        media.loading === "lazy" &&
        media.src === photo &&
        !media.srcset &&
        media.caption?.includes("Anna Lindqvist"),
      JSON.stringify(media),
    );
    const spark = await page.evaluate(() => ({
      caption: document.querySelector(".spark figcaption")?.textContent,
      label: document.querySelector(".spark svg")?.getAttribute("aria-label"),
      d: document.querySelector(".spark-line")?.getAttribute("d")?.length ?? 0,
    }));
    check(
      "spark: the track is drawn with an honest caption, in the readout's unit",
      spark.d > 0 && spark.caption === "Altitude, last 19 min9,843–35,997ft",
      `"${spark.caption}"; "${spark.label}"`,
    );
    await store(page, (_, haloActions) => {
      const now = Date.now();
      const timesMs = Array.from({ length: 20 }, (_, i) => now - (19 - i) * 60_000);
      haloActions().setTrackSeries({
        measure: "altitude",
        timesMs,
        values: timesMs.map((_, i) => 10_668 + (i % 2) * 7.6),
      });
    });
    await page.waitForTimeout(150);
    const flat = await page.locator(".spark").count();
    await store(page, (_, haloActions) => haloActions().setTrackSeries(null));
    await page.waitForTimeout(150);
    const none = await page.locator(".spark").count();
    check("spark: nothing is drawn for a level series or no series", flat === 0 && none === 0);
    await store(page, (_, haloActions) => haloActions().select(null));
    await page.waitForTimeout(300);
  }

  if (wanted("tab")) {
    await page.evaluate(() => document.activeElement?.blur());
    await page.mouse.click(700, 450);
    await page.keyboard.press("Escape");
    const stops = [];
    for (let i = 0; i < 44; i++) {
      await page.keyboard.press("Tab");
      stops.push(
        await page.evaluate(() => {
          const el = document.activeElement;
          // The globe and its credit links are focusable too, but they are the engine's.
          if (!el || !el.closest(".hud")) return "(body)";
          const outline = getComputedStyle(el.closest(".search-field") ?? el).outlineStyle;
          return `${el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 24) ?? el.tagName}${outline === "none" ? " [no outline]" : ""}`;
        }),
      );
    }
    const hudStops = stops.filter((s) => s !== "(body)");
    const need = [
      "Orya Halo: about and data sources",
      "Search flights, ships, satellites, places",
      "Face north",
      "Zoom in",
      "Sound",
      "Keyboard shortcuts",
      "About and data sources",
      "Time",
    ];
    const missing = need.filter((n) => !hudStops.some((s) => s.startsWith(n)));
    check(
      "tab: every control is reachable and shows the halo outline",
      missing.length === 0 && !hudStops.some((s) => s.includes("[no outline]")),
      missing.length ? `missing ${missing.join(", ")}` : `${new Set(hudStops).size} stops`,
    );
    console.log(`      order: ${[...new Set(hudStops)].join(" > ")}`);
    await page.keyboard.press("Escape");
  }

  await context.close();
}

// ---------------------------------------------------------------- the map's credit line
/** HUD elements that overlap the engine's credit line, which licences require on the map. */
const creditClashes = (page) =>
  page.evaluate(() => {
    const credits = document.querySelector(".halo-credits");
    if (!credits || credits.hidden) return { hits: ["(no credit line)"] };
    const c = credits.getBoundingClientRect();
    const hits = [];
    for (const sel of [
      ".brand",
      ".status",
      ".search",
      ".dock",
      ".phone-notes",
      ".detail",
      ".ticker",
      ".tape-wrap",
      ".back-to-live",
    ]) {
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (r.width === 0 || style.display === "none" || Number(style.opacity) < 0.05) continue;
        if (r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top)
          hits.push(sel);
      }
    }
    return { hits };
  });

if (wanted("credits")) {
  for (const [width, height] of [
    [1440, 900],
    [1280, 720],
    [1024, 768],
    [800, 1000],
  ]) {
    const { context, page } = await open(browser, { viewport: { width, height } });
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" })));
    const live = await creditClashes(page);
    await fillHistory(page);
    await store(page, (_, haloActions) => haloActions().scrubTo(Date.now() - 12 * 60_000));
    await page.waitForTimeout(400);
    const scrubbed = await creditClashes(page);
    const backToLive = await page.locator(".back-to-live").count();
    check(
      `credits: clear of the HUD at ${width} x ${height}, live and scrubbed`,
      live.hits.length === 0 && scrubbed.hits.length === 0 && backToLive === 1,
      [...live.hits, ...scrubbed.hits].join(", "),
    );
    await context.close();
  }
}

// ---------------------------------------------------------------- retry
// A development build looks for a gateway on this machine (port 8787); with none running, every
// connection fails, as when the gateway is down. After a few failures the worker's backoff is
// several seconds; "Try again" must connect at once. (Playwright cannot route a socket opened
// inside a worker, so the attempts are counted, not refused: a gateway that is actually running
// on 8787 makes this check fail with "no Try again button".)
if (wanted("retry")) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.routeWebSocket(
    (url) => url.host === new URL(base).host,
    () => {},
  );
  // CelesTrak allows one download per update per address; satellites come from the bundled snapshot here.
  await page.route(/celestrak.org/, (route) => route.abort("blockedbyclient"));
  let attempts = 0;
  const times = [];
  page.on("websocket", (ws) => {
    if (!/:8787\//.test(ws.url())) return;
    attempts++;
    times.push(Date.now());
  });
  await page.goto(`${base}/?synthetic=0`);
  const deadline = Date.now() + 45_000;
  while (attempts < 4 && Date.now() < deadline) await page.waitForTimeout(250);
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" })));
  const button = page.getByRole("button", { name: "Try again" });
  await button.waitFor({ timeout: 10_000 }).catch(() => {});
  const before = attempts;
  const clickedAt = Date.now();
  await button.click().catch(() => {});
  await page.waitForTimeout(700);
  const reconnected = times.find((t) => t >= clickedAt);
  check(
    "retry: Try again reconnects at once, not at the next backoff",
    attempts > before && reconnected !== undefined && reconnected - clickedAt < 700,
    reconnected
      ? `after ${reconnected - clickedAt} ms (attempt ${before + 1})`
      : `no attempt in 700 ms after ${before} attempts`,
  );

  // The old order, one layer off and on at a time, for comparison: it leaves the gateway with a
  // layer still wanted, so nothing happens until the backoff timer fires.
  await page.waitForTimeout(3000);
  const beforeOld = attempts;
  const oldAt = Date.now();
  await store(page, (_, haloActions) => {
    for (const id of ["aircraft", "ships"]) {
      haloActions().setLayerEnabled(id, false);
      haloActions().setLayerEnabled(id, true);
    }
  });
  await page.waitForTimeout(700);
  const oldReconnect = times.find((t) => t >= oldAt);
  console.log(
    `      for comparison, toggling one layer at a time: ${oldReconnect && oldReconnect - oldAt < 700 ? `reconnected after ${oldReconnect - oldAt} ms` : `no attempt within 700 ms (${attempts - beforeOld} attempts)`}`,
  );
  await context.close();
}

// ---------------------------------------------------------------- phone
if (wanted("sheet") || wanted("phone")) {
  const { context, page } = await open(browser, {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const cdp = await context.newCDPSession(page);
  const touch = async (type, x, y) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x, y }],
    });
  /** A finger drag from y0 to y1 over `ms`, then lift. */
  const drag = async (x, y0, y1, ms) => {
    const steps = Math.max(4, Math.round(ms / 16));
    await touch("touchStart", x, y0);
    for (let i = 1; i <= steps; i++) {
      await touch("touchMove", x, y0 + ((y1 - y0) * i) / steps);
      await page.waitForTimeout(ms / steps);
    }
    await touch("touchEnd", x, y1);
    await page.waitForTimeout(450);
  };
  const visible = () =>
    page
      .locator(".detail")
      .evaluate((el) => Math.round(window.innerHeight - el.getBoundingClientRect().top));
  const wake = () =>
    page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" })));

  await wake();
  const targets = await page.evaluate(() =>
    [...document.querySelectorAll(".dock .row, .search-open")].map((el) => {
      const r = el.getBoundingClientRect();
      return [Math.round(r.width), Math.round(r.height)];
    }),
  );
  check(
    "phone: lamp buttons and search meet the touch target floor (36 x 40 approved for the dock)",
    targets.every(([w, h]) => w >= 34 && h >= 40),
    targets.map((t) => t.join("x")).join(" "),
  );

  const normal = await creditClashes(page);
  // The synthetic feed re-reports its own state within a second, so measure straight away; the
  // engine notice, which nothing else touches, holds the notes open meanwhile.
  await store(page, (_, haloActions) => {
    const message =
      "Live traffic is offline. The gateway isn't reachable; satellites and earthquakes still work.";
    for (const layer of ["aircraft", "ships"])
      haloActions().setLayerState(layer, { status: "offline", count: null, message });
    haloActions().setGatewayOnline(false);
    haloActions().setEngineStatus({
      basemap: "missing",
      graphics: "ok",
      message:
        "The base map could not be loaded, so the globe has no coastlines or place names. Live data still works.",
    });
  });
  await page.waitForTimeout(120);
  const offline = await creditClashes(page);
  const noteBox = await page
    .locator(".phone-notes")
    .boundingBox({ timeout: 2000 })
    .catch(() => null);
  await store(page, (_, haloActions) =>
    haloActions().setEngineStatus({ basemap: "full", graphics: "ok" }),
  );
  for (const layer of ["aircraft", "ships"]) {
    await store(
      page,
      (_, haloActions, id) => haloActions().setLayerState(id, { status: "live", count: 6000 }),
      layer,
    );
  }

  await selectSomething(page);
  await page.waitForSelector(".detail-name", { timeout: 8000 });
  await page.waitForTimeout(700);
  await wake();
  const atPeek = await creditClashes(page);
  check(
    "phone: credits clear of the dock, its offline note and the sheet at peek",
    normal.hits.length + offline.hits.length + atPeek.hits.length === 0 &&
      noteBox !== null &&
      noteBox.y < 200,
    [...normal.hits, ...offline.hits, ...atPeek.hits].join(", ") ||
      `offline note at y ${Math.round(noteBox?.y ?? -1)}`,
  );
  const peek = await visible();
  const stack = await page.evaluate(() => {
    const top = (sel) =>
      Math.round(window.innerHeight - document.querySelector(sel).getBoundingClientRect().bottom);
    return { tape: top(".tape-wrap"), dock: top(".dock") };
  });
  check(
    "sheet: opens at the 132px peek stop with dock and tape riding above it",
    peek === 132 && stack.tape === 140 && stack.dock === 192,
    `sheet ${peek}px, tape bottom ${stack.tape}px, dock bottom ${stack.dock}px`,
  );

  const handleY = 844 - peek + 11;
  await drag(195, handleY, handleY - 300, 500);
  const full = await visible();
  const stopFull = await page.locator(".detail").getAttribute("data-stop");
  check(
    "sheet: a slow drag up past halfway rests at the full stop (70% of the height)",
    stopFull === "full" && Math.abs(full - 844 * 0.7) < 3,
    `${full}px`,
  );

  await wake();
  await drag(195, 844 - full + 11, 844 - full + 211, 60);
  const afterFlick = await visible();
  check(
    "sheet: a short fast flick down returns to peek",
    (await page.locator(".detail").getAttribute("data-stop")) === "peek" && afterFlick === 132,
    `${afterFlick}px`,
  );

  await wake();
  await page.locator(".sheet-handle").tap();
  await page.waitForTimeout(400);
  check(
    "sheet: a tap on the handle steps to the other stop",
    (await page.locator(".detail").getAttribute("data-stop")) === "full",
  );
  await page.locator(".sheet-handle").tap();
  await page.waitForTimeout(400);

  await wake();
  await drag(195, 844 - 132 + 11, 844 - 12, 60);
  await page.waitForTimeout(300);
  check(
    "sheet: a flick down from peek closes it and clears the selection",
    (await store(page, (useHalo) => useHalo.getState().selection)) === null &&
      (await page.locator(".detail").count()) === 0,
  );

  await wake();
  const row = page.locator(".dock .row").first();
  const rowBox = await row.boundingBox();
  const wasOn = await store(page, (useHalo) => useHalo.getState().layers.aircraft.enabled);
  await touch("touchStart", rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
  await page.waitForTimeout(650);
  const peekText = await page
    .locator(".dock-peek")
    .textContent()
    .catch(() => null);
  await touch("touchEnd", rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
  await page.waitForTimeout(300);
  const stillOn = await store(page, (useHalo) => useHalo.getState().layers.aircraft.enabled);
  check(
    "phone: long-press on a lamp button shows its name and count, and does not toggle",
    Boolean(peekText?.startsWith("Aircraft")) && stillOn === wasOn,
    `"${peekText}"`,
  );
  await row.tap();
  await page.waitForTimeout(200);
  check(
    "phone: a tap toggles the layer",
    (await store(page, (useHalo) => useHalo.getState().layers.aircraft.enabled)) === !wasOn,
  );
  await row.tap();

  await context.close();
}

// Reduced motion drops slides, not placement: at the peek stop the dock and tape still ride
// above the sheet (they once stayed underneath it, their lift cancelled with the entrance).
if (wanted("reduced") || wanted("phone")) {
  const { context, page } = await open(browser, {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce",
  });
  await selectSomething(page);
  await page.waitForSelector(".detail-name", { timeout: 8000 });
  await page.waitForTimeout(500);
  const stack = await page.evaluate(() => {
    const above = (sel) =>
      Math.round(window.innerHeight - document.querySelector(sel).getBoundingClientRect().bottom);
    return { tape: above(".tape-wrap"), dock: above(".dock") };
  });
  check(
    "reduced motion: at the peek stop the dock and tape still ride above the sheet",
    stack.tape === 140 && stack.dock === 192,
    `tape bottom ${stack.tape}px, dock bottom ${stack.dock}px`,
  );
  await context.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
