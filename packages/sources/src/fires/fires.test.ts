import { readFileSync } from "node:fs";
import { EntityKind } from "@orya-halo/schema";
import type { EntityUpdate } from "@orya-halo/schema";
import { describe, expect, test } from "vite-plus/test";
import { parseCsv } from "../shared/space-earth/csv.ts";
import type { SourceError } from "../shared/space-earth/errors.ts";
import { fakeContext } from "../shared/space-earth/testing.ts";
import {
  FIRMS_KEY_VARIABLE,
  FireConfidence,
  createFirmsSource,
  firms,
  parseAcquisition,
  parseConfidence,
} from "./index.ts";
import type { FiresRaw } from "./index.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

// Rows cut from NASA FIRMS world files recorded on 2026-11-14 (MODIS collection 6.1 and
// VIIRS NOAA-20 collection 2, near real-time). These are the keyless 24-hour files; the keyed
// area API serves the same products but could not be recorded without a key.
const MODIS_CSV = fixture("modis-global-24h.csv");
const VIIRS_CSV = fixture("viirs-noaa20-global-24h.csv");
const MODIS: FiresRaw = { source: "MODIS_NRT", csv: MODIS_CSV };
const VIIRS: FiresRaw = { source: "VIIRS_NOAA20_NRT", csv: VIIRS_CSV };

/** 2026-11-14T15:20:00Z, when the files were recorded. */
const NOW = Date.UTC(2026, 10, 14, 15, 20);
const DAY_MS = 86_400_000;
/** A well-formed key that belongs to nobody. */
const KEY = "0123456789abcdef0123456789abcdef";

function run(raw: FiresRaw, now = NOW, plugin = firms): EntityUpdate {
  const out = plugin.normalise(raw, { now: () => now });
  if (out.type !== "entities") throw new Error("expected entities");
  return out.update;
}

/** The recorded rows as objects, for computing expectations independently of the plugin. */
function rowsOf(csv: string) {
  const { header, rows } = parseCsv(csv);
  return rows.map(
    (cells) =>
      Object.fromEntries(header.map((name, i) => [name, cells[i]])) as Record<string, string>,
  );
}

describe("normalise", () => {
  test("keeps the last 24 hours, drops low confidence, merges 0.1 degree cells", () => {
    const update = run(MODIS);
    expect(update).toMatchObject({
      kind: EntityKind.Fire,
      source: "nasa-firms",
      timeMs: NOW,
      full: true,
    });

    // The same selection, worked out the plain way from the recorded rows.
    const kept = rowsOf(MODIS_CSV).filter((r) => {
      const t = parseAcquisition(r.acq_date, r.acq_time);
      return Number(r.confidence) >= 30 && t <= NOW && NOW - t <= DAY_MS;
    });
    const cells = new Map<string, { frp: number; n: number }>();
    for (const r of kept) {
      const key = `${Math.floor((Number(r.latitude) + 90) / 0.1)}:${Math.floor((Number(r.longitude) + 180) / 0.1)}`;
      const cell = cells.get(key) ?? { frp: -1, n: 0 };
      cell.frp = Math.max(cell.frp, Number(r.frp));
      cell.n++;
      cells.set(key, cell);
    }
    expect(rowsOf(MODIS_CSV).length).toBe(78);
    expect(kept.length).toBeGreaterThan(20);
    expect(kept.length).toBeLessThan(78);
    expect(cells.size).toBeLessThan(kept.length);
    expect(update.count).toBe(cells.size);

    for (const column of Object.values(update.columns)) expect(column.length).toBe(update.count);
    expect(update.meta?.length).toBe(update.count);
    expect(new Set(update.columns.ids).size).toBe(update.count);
    // Every point carries the strongest detection of its cell and the number merged.
    const strongest = [...cells.values()].map((c) => c.frp).sort((a, b) => a - b);
    expect([...update.columns.value].map((v) => Math.round(v * 100) / 100)).toEqual(strongest);
    expect(update.meta?.reduce((sum, m) => sum + Number(m?.detections), 0)).toBe(kept.length);
    for (let i = 0; i < update.count; i++) {
      expect(update.columns.category[i]).toBeGreaterThanOrEqual(FireConfidence.Nominal);
      expect(NOW - update.columns.fixTimeMs[i]).toBeLessThanOrEqual(DAY_MS);
      expect(update.columns.fixTimeMs[i]).toBeLessThanOrEqual(NOW);
      expect(update.columns.speed[i]).toBe(0);
      expect(update.columns.alt[i]).toBe(0);
    }
  });

  test("maps one recorded MODIS detection field by field", () => {
    // 2026-11-14 13:29 UTC is the newest pass in the sample; take its strongest row.
    const newest = rowsOf(MODIS_CSV)
      .filter((r) => r.acq_date === "2026-11-14" && Number(r.confidence) >= 30)
      .sort((a, b) => Number(b.frp) - Number(a.frp))[0];
    const update = run(MODIS, NOW, createFirmsSource({ cellDeg: 0.001 }));
    const i =
      update.meta?.findIndex(
        (m) => m?.lat === Number(newest.latitude) && m?.lon === Number(newest.longitude),
      ) ?? -1;
    expect(i).toBeGreaterThanOrEqual(0);
    const c = update.columns;
    expect(c.lat[i]).toBeCloseTo(Number(newest.latitude), 4);
    expect(c.lon[i]).toBeCloseTo(Number(newest.longitude), 4);
    expect(c.value[i]).toBeCloseTo(Number(newest.frp), 2);
    expect(c.fixTimeMs[i]).toBe(
      Date.UTC(2026, 10, 14, Number(newest.acq_time.slice(0, 2)), Number(newest.acq_time.slice(2))),
    );
    const meta = update.meta?.[i];
    expect(meta).toMatchObject({
      frpMw: Number(newest.frp),
      confidencePct: Number(newest.confidence),
      satellite: newest.satellite === "T" ? "Terra" : "Aqua",
      instrument: "MODIS",
      dayNight: newest.daynight === "D" ? "day" : "night",
      brightnessK: Number(newest.brightness),
      detections: 1,
    });
    expect(meta?.label).toMatch(/^Fire at \d+\.\d\d°[NS], \d+\.\d\d°[EW]$/);
    expect(["nominal", "high"]).toContain(meta?.confidence);
  });

  test("reads VIIRS files, whose confidence is a word and brightness is bright_ti4", () => {
    const rows = rowsOf(VIIRS_CSV);
    const low = rows.filter((r) => r.confidence === "low").length;
    expect(low).toBeGreaterThan(0);
    // Recorded at 00:15 UTC on the 13th: inside the window a day and a bit earlier.
    const then = Date.UTC(2026, 10, 13, 12, 0);
    const update = run(
      VIIRS,
      then,
      createFirmsSource({ source: "VIIRS_NOAA20_NRT", cellDeg: 0.0001 }),
    );
    expect(update.count).toBeGreaterThan(0);
    expect(update.count).toBeLessThanOrEqual(rows.length - low);
    for (const meta of update.meta ?? []) {
      expect(meta).toMatchObject({
        satellite: "NOAA-20",
        instrument: "VIIRS",
        confidencePct: null,
      });
      expect(["nominal", "high"]).toContain(meta?.confidence);
      expect(typeof meta?.brightnessK).toBe("number");
    }
    // 375 m pixels of one fire front collapse into far fewer 0.1 degree points.
    expect(run(VIIRS, then).count).toBeLessThan(update.count);
  });

  test("caps the layer at the strongest fires", () => {
    const all = run(MODIS);
    const capped = run(MODIS, NOW, createFirmsSource({ maxPoints: 5 }));
    expect(capped.count).toBe(5);
    const strongest = [...all.columns.value]
      .sort((a, b) => b - a)
      .slice(0, 5)
      .sort((a, b) => a - b);
    expect([...capped.columns.value]).toEqual(strongest);
    // Weakest first, so the strongest is drawn last, on top.
    expect(capped.columns.value[4]).toBe(Math.max(...all.columns.value));
  });

  test("ids are stable for a place between refreshes", () => {
    const a = run(MODIS);
    const b = run(MODIS, NOW - 2 * 3_600_000);
    const shared = [...a.columns.ids].filter((id) => b.columns.ids.includes(id));
    expect(shared.length).toBeGreaterThan(0);
    for (const id of shared) {
      const i = a.columns.ids.indexOf(id);
      const j = b.columns.ids.indexOf(id);
      expect(Math.abs(a.columns.lat[i] - b.columns.lat[j])).toBeLessThan(0.1001);
      expect(Math.abs(a.columns.lon[i] - b.columns.lon[j])).toBeLessThan(0.1001);
    }
  });

  test("shows nothing for a moment outside the data", () => {
    expect(run(MODIS, NOW + 3 * DAY_MS).count).toBe(0);
    expect(run(MODIS, Date.UTC(2026, 10, 12)).count).toBe(0);
  });

  test("accepts one-letter codes and an instrument column, and skips broken rows", () => {
    // Not a recording: the keyed area API could not be called without a key, so its exact
    // output is unconfirmed. This covers the variants it is believed to use (one-letter VIIRS
    // confidence, an instrument column) so that either spelling parses.
    const csv = [
      "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight",
      "10.5,20.5,330.1,0.4,0.4,2026-11-14,1200,N21,VIIRS,n,2.0NRT,290.1,12.5,D",
      "10.5,21.5,330.1,0.4,0.4,2026-11-14,1200,N,VIIRS,h,2.0NRT,290.1,40,N",
      "10.5,22.5,330.1,0.4,0.4,2026-11-14,1200,N20,VIIRS,l,2.0NRT,290.1,99,D",
      "95,20.5,330.1,0.4,0.4,2026-11-14,1200,N20,VIIRS,n,2.0NRT,290.1,5,D",
      "10.5,23.5,330.1,0.4,0.4,2026-11-14,,N20,VIIRS,n,2.0NRT,290.1,5,D",
      "10.5,24.5,330.1,0.4,0.4,2026-11-14,1200,N20,VIIRS,n,2.0NRT,290.1,,D",
      "not,a,row",
      "",
    ].join("\r\n");
    const update = run({ source: "VIIRS_NOAA21_NRT", csv });
    expect(update.count).toBe(2);
    expect(update.meta?.[0]).toMatchObject({
      satellite: "NOAA-21",
      instrument: "VIIRS",
      confidence: "nominal",
      dayNight: "day",
      frpMw: 12.5,
    });
    expect(update.meta?.[1]).toMatchObject({
      satellite: "Suomi NPP",
      confidence: "high",
      dayNight: "night",
      frpMw: 40,
    });
    expect(update.columns.category[1]).toBe(FireConfidence.High);
  });

  test("a body that is not fire CSV is an error, not an empty layer", () => {
    expect(() => run({ source: "MODIS_NRT", csv: "Invalid MAP_KEY." })).toThrow(
      /NASA FIRMS sent something other/,
    );
    // A header with no rows is a quiet day somewhere, which is fine.
    expect(run({ source: "MODIS_NRT", csv: MODIS_CSV.split("\n")[0] }).count).toBe(0);
  });

  test("confidence and acquisition time parsing", () => {
    expect(parseConfidence("29")).toEqual({ level: FireConfidence.Low, pct: 29 });
    expect(parseConfidence("30")).toEqual({ level: FireConfidence.Nominal, pct: 30 });
    expect(parseConfidence("80")).toEqual({ level: FireConfidence.High, pct: 80 });
    expect(parseConfidence("nominal").level).toBe(FireConfidence.Nominal);
    expect(parseConfidence("H").level).toBe(FireConfidence.High);
    expect(parseConfidence(undefined).level).toBe(FireConfidence.Unknown);
    expect(parseAcquisition("2026-11-13", "0017")).toBe(Date.UTC(2026, 10, 13, 0, 17));
    expect(parseAcquisition("2026-11-13", "17")).toBe(Date.UTC(2026, 10, 13, 0, 17));
    expect(parseAcquisition("2026-11-13", "2359")).toBe(Date.UTC(2026, 10, 13, 23, 59));
    expect(Number.isNaN(parseAcquisition("13/11/2026", "0017"))).toBe(true);
    expect(Number.isNaN(parseAcquisition("2026-11-13", ""))).toBe(true);
    expect(Number.isNaN(parseAcquisition("2026-11-13", "ab"))).toBe(true);
  });
});

describe("plugin", () => {
  test("without a key it asks for one and makes no request", async () => {
    for (const key of [undefined, "", "   "]) {
      const ctx = fakeContext({ now: NOW, key, routes: { "firms.modaps": MODIS_CSV } });
      const error = await firms.fetch?.(ctx).then(
        () => null,
        (e: unknown) => e as Error & { code?: string },
      );
      expect(error).toMatchObject({ name: "SourceError", code: "needs-key" });
      expect(error?.message).toBe(
        "Wildfires need a free NASA FIRMS map key. Set VITE_FIRMS_MAP_KEY and reload.",
      );
      expect(ctx.requests).toEqual([]);
    }
    expect(firms.requiresKey).toBe(FIRMS_KEY_VARIABLE);
    expect(FIRMS_KEY_VARIABLE).toBe("VITE_FIRMS_MAP_KEY");
  });

  test("a malformed key is caught before any request", async () => {
    const ctx = fakeContext({ now: NOW, key: "my-key", routes: { "firms.modaps": MODIS_CSV } });
    await expect(firms.fetch?.(ctx)).rejects.toMatchObject({ code: "needs-key" });
    expect(ctx.requests).toEqual([]);
  });

  test("requests two UTC days of the world from the area endpoint", async () => {
    const ctx = fakeContext({ now: NOW, key: KEY, routes: { "firms.modaps": MODIS_CSV } });
    const raw = await firms.fetch?.(ctx);
    expect(ctx.requests).toEqual([
      `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${KEY}/MODIS_NRT/world/2`,
    ]);
    expect(raw).toEqual({ source: "MODIS_NRT", csv: MODIS_CSV });
    expect(run(raw as FiresRaw).count).toBe(run(MODIS).count);
  });

  test("a rejected key becomes needs-key and the key never appears in a message", async () => {
    // Recorded reply to a well-formed but unknown key: HTTP 400, text/plain.
    const ctx = fakeContext({
      now: NOW,
      key: KEY,
      routes: { "firms.modaps": { status: 400, body: "Invalid MAP_KEY." } },
    });
    const error = await firms.fetch?.(ctx).then(
      () => null,
      (e: unknown) => e as Error & { code?: string },
    );
    expect(error).toMatchObject({ name: "SourceError", code: "needs-key" });
    expect(error?.message).not.toContain(KEY);
    // The same text with a 200, which some FIRMS endpoints send.
    const ok = fakeContext({ now: NOW, key: KEY, routes: { "firms.modaps": "Invalid MAP_KEY." } });
    await expect(firms.fetch?.(ok)).rejects.toMatchObject({ code: "needs-key" });
  });

  test("the transaction limit is reported as blocked, other failures as they are", async () => {
    // Recorded reply of the key status endpoint for a refused key.
    const limited = fakeContext({
      now: NOW,
      key: KEY,
      routes: {
        "firms.modaps": {
          status: 403,
          body: "MAP_KEY is invalid or your have exceeded your transaction/time limit. Please try again later.",
        },
      },
    });
    await expect(firms.fetch?.(limited)).rejects.toMatchObject({ code: "blocked", status: 403 });
    const down = fakeContext({
      now: NOW,
      key: KEY,
      routes: { "firms.modaps": { status: 502, body: "<html>Bad gateway</html>" } },
    });
    await expect(firms.fetch?.(down)).rejects.toMatchObject({ code: "http", status: 502 });
    const html = fakeContext({
      now: NOW,
      key: KEY,
      routes: { "firms.modaps": "<html>Maintenance</html>" },
    });
    await expect(firms.fetch?.(html)).rejects.toMatchObject({ code: "bad-data" });
  });

  test("behind a proxy it needs no key and sends none", async () => {
    const proxied = createFirmsSource({
      proxyUrl: "https://gateway.example/firms/",
      source: "VIIRS_NOAA21_NRT",
    });
    expect(proxied.requiresKey).toBeUndefined();
    const ctx = fakeContext({ now: NOW, routes: { "gateway.example": VIIRS_CSV } });
    const raw = await proxied.fetch?.(ctx);
    expect(ctx.requests).toEqual(["https://gateway.example/firms/VIIRS_NOAA21_NRT/world/2"]);
    expect(raw?.source).toBe("VIIRS_NOAA21_NRT");
  });

  test("behind a proxy, a key problem is the proxy's to explain, not this page's", async () => {
    const proxied = createFirmsSource({ proxyUrl: "https://gateway.example/v1/proxy/firms" });
    // The gateway's answer when it has no key, as recorded on 2026-11-14. It names
    // FIRMS_MAP_KEY, which used to be mistaken for FIRMS rejecting VITE_FIRMS_MAP_KEY.
    const body =
      '{"error":{"code":"needs_key","message":"Wildfires need a NASA FIRMS map key. Set FIRMS_MAP_KEY on the gateway and restart it."}}';
    const ctx = fakeContext({ now: NOW, routes: { "gateway.example": { status: 503, body } } });
    const error = await proxied.fetch?.(ctx).then(
      () => null,
      (e: unknown) => e as SourceError,
    );
    expect(error).toMatchObject({ name: "SourceError", code: "http", status: 503 });
    expect(error?.message).toContain('"code":"needs_key"');
    expect(error?.message).not.toContain("VITE_FIRMS_MAP_KEY");

    // A proxy that relays FIRMS's own refusal: still nothing about a key on this page.
    const relayed = fakeContext({ now: NOW, routes: { "gateway.example": "Invalid MAP_KEY." } });
    const refusal = await proxied.fetch?.(relayed).then(
      () => null,
      (e: unknown) => e as SourceError,
    );
    expect(refusal).toMatchObject({ code: "needs-key" });
    expect(refusal?.message).toBe(
      "NASA FIRMS rejected the map key held by the wildfire proxy. Check the key on the proxy.",
    );
  });

  test("is a light, slow layer", () => {
    expect(firms.layer).toBe("fires");
    expect(firms.transport).toBe("fetch");
    // 5000 transactions per 10 minutes allowed; this asks twice an hour.
    expect(firms.refreshRate).toBeGreaterThanOrEqual(15 * 60_000);
    expect(firms.cacheTtl).toBeGreaterThan(0);
    expect(firms.cacheTtl).toBeLessThanOrEqual(firms.refreshRate);
    expect(firms.attribution.text).toContain("NASA FIRMS");
    expect(firms.licence).toMatchObject({ display: true, verified: "2026-11-14" });
  });

  test("detail describes the detection and links to the FIRMS map", async () => {
    const update = run(MODIS);
    const i = update.count - 1;
    const meta = update.meta?.[i];
    const detail = await firms.detail?.(update.columns.ids[i], meta, fakeContext({ now: NOW }));
    expect(detail?.subtitle).toMatch(
      /^Seen by MODIS on (Terra|Aqua), (day|night) pass, 2026-11-1[34] \d\d:\d\d UTC$/,
    );
    expect(detail?.sourceUrl).toBe(
      `https://firms.modaps.eosdis.nasa.gov/map/#d:24hrs;@${Number(meta?.lon).toFixed(2)},${Number(meta?.lat).toFixed(2)},10.00z`,
    );
    const rows = Object.fromEntries((detail?.fields ?? []).map((f) => [f.key, f]));
    expect(rows.frpMw).toMatchObject({
      label: "Fire radiative power",
      unit: "MW",
      numeric: meta?.frpMw,
    });
    expect(rows.confidence.value).toMatch(/nominal|high/);
    expect(rows.confidencePct.unit).toBe("%");
    expect(rows.brightnessK.unit).toBe("K");
    expect(rows.detections.numeric).toBeGreaterThanOrEqual(1);
    expect(rows.label).toBeUndefined();
    expect(await firms.detail?.(1, undefined, fakeContext({ now: NOW }))).toEqual({
      attribution: firms.attribution,
    });
  });
});
