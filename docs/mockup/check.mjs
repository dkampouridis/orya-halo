// Verifies what the mockup claims: the width axes are applied, numerals are tabular, and
// every piece of text holds 4.5:1 against what is actually behind it (glass over the globe,
// or the globe itself).
//
//   cd apps/web && node ../../docs/mockup/check.mjs
//
// Contrast is measured, not computed from tokens: the text is made transparent (its black bloom
// on space stays, as it does for a reader), the page is captured with the real glass, and each
// text box is compared with the pixels behind it. Two figures are reported
// per text run: against the 95th-percentile brightest pixel, and against the brightest pixel.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { chromium } = createRequire(join(process.cwd(), "package.json"))("playwright");
const here = dirname(fileURLToPath(import.meta.url));
const url = pathToFileURL(join(here, "index.html")).href;

const browser = await chromium.launch({ channel: "msedge" });
let failed = false;

async function open(device, state) {
  const context = await browser.newContext(device);
  const p = await context.newPage();
  // Measure the real glass, not the solid fallback this machine's settings may select.
  const cdp = await context.newCDPSession(p);
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-transparency", value: "no-preference" }],
  });
  await p.goto(`${url}?shot#${state}`);
  await p.waitForFunction(() => window.__haloReady === true, null, { timeout: 30000 });
  await p.waitForTimeout(500);
  return { context, p };
}

/* ---------- fonts ---------- */
{
  const { context, p } = await open({ viewport: { width: 1440, height: 900 } }, "selected");
  const r = await p.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.cssText =
      "position:fixed;left:0;top:0;white-space:nowrap;visibility:hidden;font-size:40px";
    document.body.appendChild(probe);
    const width = (family, stretch, weight, text, extra = "") => {
      probe.style.cssText += `;font-family:${family};font-stretch:${stretch}%;font-weight:${weight};${extra}`;
      probe.textContent = text;
      return +probe.getBoundingClientRect().width.toFixed(2);
    };
    const out = {
      loaded: {
        archivo: document.fonts.check('300 22px "Archivo"'),
        martian: document.fonts.check('300 12px "Martian Mono"'),
      },
      archivoByWidth: [62, 82, 100, 118, 125].map((s) => [
        s,
        width('"Archivo"', s, 400, "Undersea cables 587"),
      ]),
      martianByWidth: [75, 80, 100, 112.5].map((s) => [
        s,
        width('"Martian Mono"', s, 300, "10,972"),
      ]),
      archivoByWeight: [100, 300, 500, 900].map((w) => [
        w,
        width('"Archivo"', 100, w, "Undersea cables 587"),
      ]),
      martianDigits: ["000000", "111111", "888888", "1,1:1."].map((t) => [
        t,
        width('"Martian Mono"', 80, 300, t),
      ]),
      archivoDigits: ["000000", "111111", "888888"].map((t) => [
        t,
        width('"Archivo"', 82, 500, t, "font-variant-numeric:tabular-nums"),
      ]),
      computed: {},
    };
    for (const [name, sel] of [
      ["wordmark", ".brand-name"],
      ["dock label", ".row-name"],
      ["count", ".row-count"],
      ["readout", ".readout .num"],
      ["name", ".detail-name"],
    ]) {
      const cs = getComputedStyle(document.querySelector(sel));
      out.computed[name] =
        `${cs.fontFamily.split(",")[0]} ${cs.fontSize}/${cs.lineHeight} weight ${cs.fontWeight} stretch ${cs.fontStretch}`;
    }
    probe.remove();
    return out;
  });
  console.log("Fonts loaded:", r.loaded);
  console.log(
    "Archivo width axis (stretch %, px):",
    r.archivoByWidth.map((x) => x.join(": ")).join("   "),
  );
  console.log(
    "Martian Mono width axis (stretch %, px):",
    r.martianByWidth.map((x) => x.join(": ")).join("   "),
  );
  console.log(
    "Archivo weight axis (weight, px):",
    r.archivoByWeight.map((x) => x.join(": ")).join("   "),
  );
  console.log("Martian Mono digit runs:", r.martianDigits.map((x) => x.join(" = ")).join("   "));
  console.log("Archivo tabular digit runs:", r.archivoDigits.map((x) => x.join(" = ")).join("   "));
  console.log("Computed:", r.computed);
  const rising = (a) => a.every((x, i) => i === 0 || x[1] > a[i - 1][1]);
  const equal = (a) => a.every((x) => Math.abs(x[1] - a[0][1]) < 0.05);
  const ok =
    r.loaded.archivo &&
    r.loaded.martian &&
    rising(r.archivoByWidth) &&
    rising(r.martianByWidth) &&
    equal(r.martianDigits) &&
    equal(r.archivoDigits);
  console.log(
    ok ? "PASS fonts: both width axes respond and numerals are tabular\n" : "FAIL fonts\n",
  );
  if (!ok) failed = true;
  await context.close();
}

/* ---------- contrast ---------- */
const analyser = await (await browser.newContext()).newPage();
async function contrast(label, device, state) {
  const { context, p } = await open(device, state);
  const runs = await p.evaluate(() => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const chain = (el) => {
      let o = 1;
      for (let e = el; e; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity);
      return o;
    };
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent.trim();
      const el = n.parentElement;
      if (!text || !el || el.closest("script,style,title")) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || chain(el) < 0.99) continue;
      range.selectNodeContents(n);
      for (const b of range.getClientRects()) {
        if (
          b.width < 2 ||
          b.height < 2 ||
          b.bottom < 0 ||
          b.top > innerHeight ||
          b.right < 0 ||
          b.left > innerWidth
        )
          continue;
        // Skip text clipped away by a scrolling or collapsed ancestor.
        const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        if (!hit || !(hit === el || el.contains(hit) || hit.contains(el))) continue;
        out.push({
          text: text.slice(0, 34),
          color: el instanceof SVGElement ? cs.fill : cs.color,
          x: b.left,
          y: b.top,
          w: b.width,
          h: b.height,
          size: cs.fontSize,
        });
      }
    }
    const ph = document.querySelector("#q");
    if (ph && !ph.value && getComputedStyle(ph).display !== "none") {
      const b = ph.getBoundingClientRect();
      out.push({
        text: "(search placeholder)",
        color: getComputedStyle(ph, "::placeholder").color,
        x: b.left,
        y: b.top + 10,
        w: 250,
        h: b.height - 20,
        size: "13px",
      });
    }
    return out;
  });
  await p.addStyleTag({
    content:
      "*{color:transparent!important;caret-color:transparent!important}svg text{fill:transparent!important}input::placeholder{color:transparent!important}",
  });
  await p.waitForTimeout(250);
  const png = (await p.screenshot()).toString("base64");
  const scale = device.deviceScaleFactor || 1;
  const rows = await analyser.evaluate(
    async ({ png, runs, scale }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext("2d", { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const lin = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      const lum = (r, gg, b) => 0.2126 * lin(r) + 0.7152 * lin(gg) + 0.0722 * lin(b);
      return runs.map((t) => {
        const m = t.color.match(/[\d.]+/g).map(Number);
        const fg = lum(m[0], m[1], m[2]);
        const x = Math.max(0, Math.floor(t.x * scale));
        const y = Math.max(0, Math.floor(t.y * scale));
        const w = Math.max(1, Math.min(c.width - x, Math.ceil(t.w * scale)));
        const h = Math.max(1, Math.min(c.height - y, Math.ceil(t.h * scale)));
        const d = g.getImageData(x, y, w, h).data;
        const ls = [];
        for (let i = 0; i < d.length; i += 4) ls.push(lum(d[i], d[i + 1], d[i + 2]));
        ls.sort((a, b) => a - b);
        const ratio = (bg) => (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
        return {
          text: t.text,
          size: t.size,
          color: t.color,
          p95: +ratio(ls[Math.floor(ls.length * 0.95)]).toFixed(2),
          worst: +ratio(ls[ls.length - 1]).toFixed(2),
        };
      });
    },
    { png, runs, scale },
  );
  rows.sort((a, b) => a.p95 - b.p95);
  const low = rows.filter((r) => r.p95 < 4.5);
  console.log(
    `${label}: ${rows.length} text runs, lowest ${rows[0].p95}:1 at the 95th percentile, ${low.length} below 4.5:1`,
  );
  for (const r of rows.slice(0, 6))
    console.log(
      `   ${String(r.p95).padStart(5)}:1  (brightest pixel ${String(r.worst).padStart(5)}:1)  ${r.size} ${r.color}  "${r.text}"`,
    );
  if (low.length) failed = true;
  await context.close();
}

const desktop = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };
const phone = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
};
await contrast("desktop default", desktop, "default");
await contrast("desktop selected", desktop, "selected");
await contrast("desktop search", desktop, "search");
await contrast("desktop scrubbed", desktop, "scrubbed");
await contrast("desktop offline", desktop, "offline");
await contrast("phone default", phone, "default");
await contrast("phone selected, peek", phone, "selected");
await contrast("phone selected, full", phone, "selected-full");
await contrast("phone search", phone, "search");

await browser.close();
console.log(failed ? "\nFAIL" : "\nPASS: fonts and contrast");
process.exit(failed ? 1 : 0);
