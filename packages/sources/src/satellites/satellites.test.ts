import { readFileSync } from "node:fs";
import {
  EARTH_RADIUS_M,
  EntityFlag,
  EntityKind,
  MAX_EXTRAPOLATION_S,
  SatelliteCategory,
  createRenderBatch,
  extrapolate,
} from "@orya-halo/schema";
import type { EntityUpdate } from "@orya-halo/schema";
import { eciToGeodetic, gstime, propagate, twoline2satrec } from "satellite.js";
import { describe, expect, test } from "vite-plus/test";
import { SourceError } from "../shared/space-earth/errors.ts";
import { fakeContext, greatCircleKm } from "../shared/space-earth/testing.ts";
import {
  CELESTRAK_GP_URL,
  buildCatalogue,
  celestrak,
  classifySatellite,
  createCelestrakSource,
  fallbackMessage,
  launchYear,
  orbitFacts,
} from "./index.ts";
import type { SatelliteElements } from "./index.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

// Recorded from CelesTrak on 2026-11-14: GROUP=stations (18 objects, ISS epoch 04:10 UTC)
// and a hand-picked cut of GROUP=active.
const STATIONS_CSV = fixture("stations.csv");
const MIXED_CSV = fixture("mixed.csv");
const ISS = 25544;
/** 2026-11-14T12:00:00Z, about 8 hours after the ISS element epoch. */
const T0 = 1_794_657_600_000;
const DAY_MS = 86_400_000;
const DEG = Math.PI / 180;

const stations = buildCatalogue(STATIONS_CSV);
const mixed = buildCatalogue(MIXED_CSV);

function updateAt(raw: typeof stations, now: number): EntityUpdate {
  const out = celestrak.normalise(raw, { now: () => now });
  if (out.type !== "entities") throw new Error("expected entities");
  return out.update;
}

function fixOf(update: EntityUpdate, id: number) {
  const i = update.columns.ids.indexOf(id);
  if (i < 0) throw new Error(`no object ${id}`);
  const c = update.columns;
  return {
    i,
    lon: c.lon[i],
    lat: c.lat[i],
    alt: c.alt[i],
    heading: c.heading[i],
    speed: c.speed[i],
    vrate: c.vrate[i],
  };
}

const idByName = (raw: typeof stations, name: string) => {
  const i = raw.meta.findIndex((m) => m.label === name);
  if (i < 0) throw new Error(`no object named ${name}`);
  return raw.ids[i];
};

describe("catalogue", () => {
  test("reads every object of a recorded CelesTrak file", () => {
    expect(stations.count).toBe(18);
    expect(stations.skipped).toBe(0);
    expect(stations.meta[0]).toMatchObject({
      label: "ISS (ZARYA)",
      noradId: ISS,
      intlDes: "1998-067A",
      launchYear: 1998,
      orbit: "Low Earth orbit",
      inclinationDeg: 51.63,
    });
    expect(stations.meta[0].periodMin).toBeCloseTo(92.9, 1);
    expect(stations.periodMin[0]).toBeCloseTo(1440 / 15.49365732, 3);
    // 2026-11-14T04:10:44.607360Z
    expect(stations.epochMs[0]).toBeCloseTo(Date.UTC(2026, 10, 14, 4, 10, 44, 607), -1);
  });

  test("keeps catalogue numbers above 99999, which TLE cannot carry", () => {
    expect([...stations.ids]).toContain(101031);
    expect(mixed.ids[mixed.count - 1]).toBe(101357);
  });

  test("skips unusable rows without throwing", () => {
    const header = STATIONS_CSV.split("\n")[0];
    const good = STATIONS_CSV.split("\n")[1];
    const cells = good.split(",");
    const withCell = (index: number, value: string, id: string) => {
      const copy = [...cells];
      copy[index] = value;
      copy[11] = id;
      return copy.join(",");
    };
    const csv = [
      header,
      good,
      good, // duplicate catalogue number
      withCell(4, "1.2", "90001"), // eccentricity of an escape trajectory
      withCell(3, "not-a-number", "90002"),
      withCell(3, "0", "90003"), // no mean motion
      withCell(2, "", "90004"), // no epoch
      withCell(2, "yesterday", "90005"),
      withCell(9, "4", "90006"), // not an SGP4 element set
      withCell(11, "", ""), // no catalogue number
      "ISS (ZARYA),1998-067A", // truncated line
      "",
    ].join("\n");
    const raw = buildCatalogue(csv);
    expect(raw.count).toBe(1);
    expect(raw.skipped).toBe(9);
    expect(updateAt(raw, T0).count).toBe(1);
  });

  test("rejects a response that is not OMM CSV", () => {
    expect(() => buildCatalogue("<html><body>Service unavailable</body></html>")).toThrow(
      SourceError,
    );
    expect(() => buildCatalogue("")).toThrow(SourceError);
  });

  test("survives structuredClone, so the runner may keep it in IndexedDB", () => {
    const a = updateAt(stations, T0);
    const b = updateAt(structuredClone(stations), T0);
    expect(b.count).toBe(a.count);
    expect([...b.columns.lon]).toEqual([...a.columns.lon]);
    expect([...b.columns.speed]).toEqual([...a.columns.speed]);
  });
});

describe("propagation", () => {
  test("places the ISS within a few km of an independent tracker", () => {
    // api.wheretheiss.at: a different SGP4 implementation working from an earlier element set.
    const reference = JSON.parse(fixture("iss-reference.json")) as {
      positions: { timestamp: number; latitude: number; longitude: number; altitudeKm: number }[];
    };
    expect(reference.positions.length).toBe(3);
    for (const ref of reference.positions) {
      const fix = fixOf(updateAt(stations, ref.timestamp * 1000), ISS);
      expect(greatCircleKm(fix.lon, fix.lat, ref.longitude, ref.latitude)).toBeLessThan(3);
      expect(Math.abs(fix.alt / 1000 - ref.altitudeKm)).toBeLessThan(1);
    }
  });

  test("agrees with satellite.js's own transforms from the TLE of the same element set", () => {
    const [, line1, line2] = fixture("stations.tle").split("\n");
    const pv = propagate(twoline2satrec(line1, line2), new Date(T0));
    if (!pv) throw new Error("reference propagation failed");
    const geo = eciToGeodetic(pv.position, gstime(new Date(T0)));
    const fix = fixOf(updateAt(stations, T0), ISS);
    // The TLE rounds eccentricity and drag to fewer digits than the CSV.
    expect(greatCircleKm(fix.lon, fix.lat, geo.longitude / DEG, geo.latitude / DEG)).toBeLessThan(
      0.05,
    );
    expect(Math.abs(fix.alt / 1000 - geo.height)).toBeLessThan(0.05);
  });

  test("reports the full set with SI columns and shared meta", () => {
    const update = updateAt(stations, T0);
    expect(update).toMatchObject({
      kind: EntityKind.Satellite,
      source: "celestrak-gp",
      timeMs: T0,
      full: true,
      count: 18,
    });
    for (const column of Object.values(update.columns)) expect(column.length).toBe(18);
    expect(update.meta).toBe(stations.meta);
    const iss = fixOf(update, ISS);
    expect(iss.alt).toBeGreaterThan(400_000);
    expect(iss.alt).toBeLessThan(430_000);
    expect(update.columns.fixTimeMs[iss.i]).toBe(T0);
    expect(update.columns.value[iss.i]).toBeCloseTo(92.94, 1);
    expect(update.columns.category[iss.i]).toBe(SatelliteCategory.Station);
    expect(update.columns.flags[iss.i]).toBe(0);
  });

  test("gives the ISS the ground speed of its track over the rotating Earth", () => {
    // The sub-satellite point circles a 6371 km sphere once per 92.94 min: 7.18 km/s in
    // inertial space. The ground below moves east at up to 0.46 km/s, which takes
    // 0.24 to 0.33 km/s off a prograde 51.6 degree track: about 6.85 to 6.94 km/s.
    let min = Number.POSITIVE_INFINITY;
    let max = 0;
    for (let s = 0; s < 5580; s += 60) {
      const fix = fixOf(updateAt(stations, T0 + s * 1000), ISS);
      min = Math.min(min, fix.speed);
      max = Math.max(max, fix.speed);
      // Altitude changes by a few km per orbit, so tens of metres per second at most.
      expect(Math.abs(fix.vrate)).toBeLessThan(50);
    }
    expect(min).toBeGreaterThan(6800);
    expect(max).toBeLessThan(6990);
    expect(max - min).toBeGreaterThan(50);
  });

  test("heading and speed match a finite difference of two propagations", () => {
    for (const [raw, id] of [
      [stations, ISS],
      [mixed, idByName(mixed, "MERIDIAN 7")],
      [mixed, idByName(mixed, "NAVSTAR 43 (USA 132)")],
      [mixed, idByName(mixed, "LANDSAT 8")],
    ] as const) {
      for (let s = 0; s < 6000; s += 500) {
        const t = T0 + s * 1000;
        const fix = fixOf(updateAt(raw, t), id);
        const before = fixOf(updateAt(raw, t - 1000), id);
        const after = fixOf(updateAt(raw, t + 1000), id);
        let dLon = after.lon - before.lon;
        if (dLon > 180) dLon -= 360;
        if (dLon < -180) dLon += 360;
        // The same sphere and flat-step convention `extrapolate()` uses.
        const north = ((after.lat - before.lat) / 2) * DEG * EARTH_RADIUS_M;
        const east = (dLon / 2) * DEG * EARTH_RADIUS_M * Math.cos(fix.lat * DEG);
        const speed = Math.hypot(north, east);
        // Positions are 32-bit floats, good to about a metre, so the difference is noisy at that level.
        expect(Math.abs(speed - fix.speed)).toBeLessThan(3);
        if (speed > 200) {
          const heading = (Math.atan2(east, north) / DEG + 360) % 360;
          let dHeading = Math.abs(heading - fix.heading);
          if (dHeading > 180) dHeading = 360 - dHeading;
          expect(dHeading).toBeLessThan(0.5);
        }
        expect(Math.abs((after.alt - before.alt) / 2 - fix.vrate)).toBeLessThan(2);
        expect(fix.heading).toBeGreaterThanOrEqual(0);
        expect(fix.heading).toBeLessThan(360);
      }
    }
  });

  test("lets the renderer dead-reckon for a couple of seconds", () => {
    expect(MAX_EXTRAPOLATION_S[EntityKind.Satellite]).toBeGreaterThanOrEqual(2);
    for (let s = 0; s < 5580; s += 300) {
      const t = T0 + s * 1000;
      const fix = fixOf(updateAt(stations, t), ISS);
      const batch = createRenderBatch(EntityKind.Satellite, 1, t);
      batch.positions.set([fix.lon, fix.lat, fix.alt]);
      batch.motion.set([fix.heading, fix.speed, fix.vrate, 0]);
      batch.blend.set([0, 0, -1000]);
      const [lon, lat, alt] = extrapolate(batch, 0, t + 2000);
      const truth = fixOf(updateAt(stations, t + 2000), ISS);
      // 14 km travelled; the straight-line guess is off by tens of metres.
      expect(greatCircleKm(lon, lat, truth.lon, truth.lat)).toBeLessThan(0.1);
      expect(Math.abs(alt - truth.alt)).toBeLessThan(20);
    }
  });

  test("a geostationary satellite hangs still", () => {
    const fix = fixOf(updateAt(mixed, T0), idByName(mixed, "GOES 16"));
    expect(fix.alt).toBeGreaterThan(35_700_000);
    expect(fix.alt).toBeLessThan(35_900_000);
    expect(Math.abs(fix.lat)).toBeLessThan(1);
    // GOES-16 handed GOES-East to GOES-19 in 2025 and is parked in storage near 104.7 W.
    expect(fix.lon).toBeGreaterThan(-106);
    expect(fix.lon).toBeLessThan(-103.5);
    expect(fix.speed).toBeLessThan(10);
  });

  test("works for a scrubbed time in the past", () => {
    const past = updateAt(stations, T0 - 3 * DAY_MS);
    expect(past.count).toBe(18);
    expect(past.timeMs).toBe(T0 - 3 * DAY_MS);
    const fix = fixOf(past, ISS);
    expect(Number.isFinite(fix.lon) && Number.isFinite(fix.lat)).toBe(true);
    expect(fix.alt).toBeGreaterThan(380_000);
    expect(fix.alt).toBeLessThan(440_000);
    // Scrubbing back and forth must not depend on the order of calls.
    expect(fixOf(updateAt(stations, T0), ISS)).toEqual(
      fixOf(updateAt(buildCatalogue(STATIONS_CSV), T0), ISS),
    );
  });

  test("drops decayed objects and keeps columns and meta aligned", () => {
    // HMU-SAT2 (67688) was at 16.24 revolutions per day and falling fast when recorded.
    const later = updateAt(stations, T0 + 120 * DAY_MS);
    expect(later.count).toBeLessThan(18);
    expect(later.count).toBeGreaterThan(8);
    expect([...later.columns.ids]).not.toContain(67688);
    expect([...later.columns.ids]).toContain(ISS);
    for (const column of Object.values(later.columns)) expect(column.length).toBe(later.count);
    expect(later.meta?.length).toBe(later.count);
    later.meta?.forEach((m, i) => expect(m?.noradId).toBe(later.columns.ids[i]));
    for (let i = 0; i < later.count; i++) {
      expect(Number.isFinite(later.columns.lon[i])).toBe(true);
      expect(later.columns.alt[i]).toBeGreaterThan(80_000);
      // Elements four months old are flagged as a rough guide only.
      expect(later.columns.flags[i] & EntityFlag.Stale).toBe(EntityFlag.Stale);
    }
    // The catalogue itself is untouched, so the present still shows all 18.
    expect(stations.meta.length).toBe(18);
    expect(updateAt(stations, T0).count).toBe(18);
  });
});

describe("classification", () => {
  test("categories from recorded names and orbits", () => {
    const expected: Record<string, number> = {
      "ISS (ZARYA)": SatelliteCategory.Station,
      "CSS (TIANHE)": SatelliteCategory.Station,
      "STARLINK-1008": SatelliteCategory.Constellation,
      "ONEWEB-0012": SatelliteCategory.Constellation,
      "KUIPER-00008": SatelliteCategory.Constellation,
      "IRIDIUM 106": SatelliteCategory.Constellation,
      "O3B FM5": SatelliteCategory.Constellation,
      "NAVSTAR 43 (USA 132)": SatelliteCategory.Navigation,
      "COSMOS 2433 [GLONASS-M]": SatelliteCategory.Navigation,
      "GSAT0101 (GALILEO-PFM)": SatelliteCategory.Navigation,
      "BEIDOU-3 M1": SatelliteCategory.Navigation,
      // Navigation wins over the geostationary orbit it happens to use.
      "BEIDOU-3 G1": SatelliteCategory.Navigation,
      "QZS-2 (MICHIBIKI-2)": SatelliteCategory.Navigation,
      "LANDSAT 8": SatelliteCategory.EarthObservation,
      "SENTINEL-2A": SatelliteCategory.EarthObservation,
      "NOAA 20 (JPSS-1)": SatelliteCategory.EarthObservation,
      "FLOCK 4Q-16": SatelliteCategory.EarthObservation,
      "GOES 16": SatelliteCategory.EarthObservation,
      "HIMAWARI-8": SatelliteCategory.EarthObservation,
      HST: SatelliteCategory.Science,
      "LAGEOS 1": SatelliteCategory.Science,
      "COSMOS 1989 (ETALON 1)": SatelliteCategory.Science,
      "MMS 1": SatelliteCategory.Science,
      CXO: SatelliteCategory.Science,
      "INTELSAT 902 (IS-902)": SatelliteCategory.Geostationary,
      "SES-7 (PROTOSTAR 2)": SatelliteCategory.Geostationary,
      "TDRS 3": SatelliteCategory.Geostationary,
      "SXM-7": SatelliteCategory.Geostationary,
      "CELESTIS-02 & TAURUS R/B": SatelliteCategory.Debris,
      "CALSPHERE 1": SatelliteCategory.Other,
      "MERIDIAN 7": SatelliteCategory.Other,
    };
    for (const [name, category] of Object.entries(expected)) {
      const i = mixed.meta.findIndex((m) => m.label === name);
      expect(i, name).toBeGreaterThanOrEqual(0);
      expect(mixed.category[i], name).toBe(category);
    }
    // Every category code is one the schema defines.
    const known = new Set<number>(Object.values(SatelliteCategory));
    for (const code of mixed.category) expect(known.has(code)).toBe(true);
  });

  test("names not in any recorded file", () => {
    expect(classifySatellite("FENGYUN 1C DEB", "leo")).toBe(SatelliteCategory.Debris);
    expect(classifySatellite("SL-16 R/B", "leo")).toBe(SatelliteCategory.Debris);
    expect(classifySatellite("PRAETORIAN SDA_602", "leo")).toBe(SatelliteCategory.Constellation);
    expect(classifySatellite("CREW DRAGON 13", "leo")).toBe(SatelliteCategory.Station);
    expect(classifySatellite("Unknown Payload", "geo")).toBe(SatelliteCategory.Geostationary);
    expect(classifySatellite("", "leo")).toBe(SatelliteCategory.Other);
  });

  test("orbit classes", () => {
    const orbitOf = (name: string) =>
      mixed.meta[mixed.meta.findIndex((m) => m.label === name)].orbit;
    expect(orbitOf("ISS (ZARYA)")).toBe("Low Earth orbit");
    expect(orbitOf("LANDSAT 8")).toBe("Sun-synchronous orbit");
    expect(orbitOf("NAVSTAR 43 (USA 132)")).toBe("Medium Earth orbit");
    expect(orbitOf("GOES 16")).toBe("Geostationary orbit");
    expect(orbitOf("QZS-2 (MICHIBIKI-2)")).toBe("Geosynchronous orbit");
    expect(orbitOf("MERIDIAN 7")).toBe("Molniya orbit");
    expect(orbitOf("CXO")).toBe("Highly elliptical orbit");

    const iss = orbitFacts(15.49365732, 0.00073685, 51.6324);
    expect(iss.periodMin).toBeCloseTo(92.94, 2);
    expect(iss.perigeeKm).toBeGreaterThan(400);
    expect(iss.apogeeKm).toBeLessThan(430);
    expect(orbitFacts(2.28, 0.73, 27).orbit).toBe("gto");
    const geo = orbitFacts(1.0027, 0.0002, 0.05);
    expect(geo.apogeeKm).toBeGreaterThan(35_700);
    expect(geo.apogeeKm).toBeLessThan(35_900);
  });

  test("launch year from the international designator", () => {
    expect(launchYear("1998-067A")).toBe(1998);
    expect(launchYear("2026-227DE")).toBe(2026);
    expect(launchYear("")).toBeNull();
    expect(launchYear("UNKNOWN")).toBeNull();
  });
});

describe("track", () => {
  test("one revolution of the ISS closes on itself once the Earth's turn is added back", () => {
    const track = celestrak.track?.(stations, ISS, { now: () => T0 });
    if (!track) throw new Error("no track");
    expect(track.ref).toEqual({ kind: EntityKind.Satellite, id: ISS });
    expect(track.count).toBe(181);
    expect(track.positions.length).toBe(181 * 3);
    expect(track.timesMs.length).toBe(181);
    for (let i = 1; i < track.count; i++)
      expect(track.timesMs[i]).toBeGreaterThan(track.timesMs[i - 1]);

    const last = (track.count - 1) * 3;
    const spanS = (track.timesMs[track.count - 1] - track.timesMs[0]) / 1000;
    expect(spanS / 60).toBeCloseTo(stations.periodMin[0], 3);
    // Same latitude and height one period later...
    expect(Math.abs(track.positions[last + 1] - track.positions[1])).toBeLessThan(0.5);
    expect(Math.abs(track.positions[last + 2] - track.positions[2])).toBeLessThan(2000);
    // ...and the longitude it started from, less what the Earth turned meanwhile (23.3 degrees).
    // What is left is the slow westward drift of the orbit plane, a fraction of a degree.
    const turned = (spanS * 7.292115e-5) / DEG;
    expect(turned).toBeGreaterThan(23);
    const residual = ((track.positions[last] - track.positions[0] + turned + 540) % 360) - 180;
    expect(Math.abs(residual)).toBeLessThan(0.5);

    // The track is centred on the shown moment: its middle vertex is the current fix.
    const fix = fixOf(updateAt(stations, T0), ISS);
    expect(track.timesMs[90]).toBe(T0);
    expect(track.positions[90 * 3]).toBeCloseTo(fix.lon, 4);
    expect(track.positions[90 * 3 + 1]).toBeCloseTo(fix.lat, 4);
    expect(track.positions[90 * 3 + 2]).toBeCloseTo(fix.alt, -1);
    // The track reaches the inclination north and south.
    let north = -90;
    let south = 90;
    for (let i = 0; i < track.count; i++) {
      north = Math.max(north, track.positions[i * 3 + 1]);
      south = Math.min(south, track.positions[i * 3 + 1]);
    }
    expect(north).toBeGreaterThan(51);
    expect(north).toBeLessThan(52.2);
    expect(south).toBeLessThan(-51);
  });

  test("a geostationary track is one sidereal day and stays over its station", () => {
    const id = idByName(mixed, "GOES 16");
    const track = celestrak.track?.(mixed, id, { now: () => T0 });
    if (!track) throw new Error("no track");
    expect(track.count).toBe(181);
    expect((track.timesMs[180] - track.timesMs[0]) / 3_600_000).toBeCloseTo(23.93, 1);
    for (let i = 0; i < track.count; i++) {
      expect(Math.abs(track.positions[i * 3] - track.positions[0])).toBeLessThan(1.5);
      expect(Math.abs(track.positions[i * 3 + 1])).toBeLessThan(1.5);
    }
  });

  test("an orbit longer than a day is cut to one day, an eccentric one is sampled finer", () => {
    const id = idByName(mixed, "MMS 1");
    const i = mixed.ids.indexOf(id);
    expect(mixed.periodMin[i]).toBeGreaterThan(3 * 1440);
    const track = celestrak.track?.(mixed, id, { now: () => T0 });
    if (!track) throw new Error("no track");
    expect(track.count).toBe(361);
    expect((track.timesMs[track.count - 1] - track.timesMs[0]) / 3_600_000).toBeCloseTo(23.93, 1);
  });

  test("unknown ids and decayed objects give no track", () => {
    expect(celestrak.track?.(stations, 1, { now: () => T0 })).toBeNull();
    expect(celestrak.track?.(stations, 67688, { now: () => T0 + 200 * DAY_MS })).toBeNull();
  });
});

describe("plugin", () => {
  test("downloads the active group once, as CSV", async () => {
    const ctx = fakeContext({ now: T0, routes: { "celestrak.org": STATIONS_CSV } });
    const raw = await celestrak.fetch?.(ctx);
    expect(ctx.requests).toEqual([CELESTRAK_GP_URL]);
    expect(CELESTRAK_GP_URL).toBe(
      "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=CSV",
    );
    expect(raw?.count).toBe(18);
  });

  test("reports CelesTrak's once-per-update refusal as blocked, in its own words", async () => {
    const body =
      "GP data has not updated since your last successful\ndownload of GROUP=active at 2026-03-26 08:10:22 UTC.\nData is updated once every 2 hours.";
    const ctx = fakeContext({ now: T0, routes: { "celestrak.org": { status: 403, body } } });
    const error = await celestrak.fetch?.(ctx).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).code).toBe("blocked");
    expect((error as SourceError).status).toBe(403);
    expect((error as SourceError).message).toContain(
      "GP data has not updated since your last successful",
    );
    // The sentence is carried whole, although CelesTrak breaks it over two lines.
    expect((error as SourceError).message).toBe(
      "CelesTrak refused the request (HTTP 403): GP data has not updated since your last successful download of GROUP=active at 2026-03-26 08:10:22 UTC.",
    );
    // One request, no retry from the plugin.
    expect(ctx.requests.length).toBe(1);
  });

  test("an error page or an empty file is bad data, not an empty sky", async () => {
    for (const body of [
      "<html>Maintenance</html>",
      "No GP data found",
      STATIONS_CSV.split("\n")[0],
    ]) {
      const ctx = fakeContext({ now: T0, routes: { "celestrak.org": body } });
      await expect(celestrak.fetch?.(ctx)).rejects.toMatchObject({
        name: "SourceError",
        code: "bad-data",
      });
    }
  });

  test("stays inside CelesTrak's usage policy", () => {
    const twoHours = 2 * 3_600_000;
    // One download per two-hourly update, enforced per IP address.
    expect(celestrak.refreshRate).toBeGreaterThan(twoHours);
    expect(celestrak.cacheTtl).toBeGreaterThan(twoHours);
    expect(celestrak.recomputeRate).toBe(1000);
    expect(celestrak.layer).toBe("satellites");
    expect(celestrak.transport).toBe("compute");
    expect(celestrak.requiresKey).toBeUndefined();
    expect(celestrak.licence.display).toBe(true);
    expect(celestrak.licence.verified).toBe("2026-11-14");
  });

  test("detail rows come from the schema", async () => {
    const detail = await celestrak.detail?.(ISS, stations.meta[0], fakeContext({ now: T0 }));
    expect(detail?.subtitle).toBe("Low Earth orbit");
    expect(detail?.sourceUrl).toBe("https://celestrak.org/satcat/table-satcat.php?CATNR=25544");
    expect(detail?.attribution).toBe(celestrak.attribution);
    const rows = Object.fromEntries((detail?.fields ?? []).map((f) => [f.key, f]));
    expect(rows.noradId).toMatchObject({ label: "NORAD id", value: "25544", numeric: 25544 });
    expect(rows.intlDes.value).toBe("1998-067A");
    expect(rows.launchYear.value).toBe("1998");
    expect(rows.inclinationDeg).toMatchObject({ value: "51.6", unit: "°" });
    expect(rows.periodMin).toMatchObject({ value: "92.9", unit: "min" });
    expect(rows.perigeeKm.unit).toBe("km");
    expect(rows.epochMs.value).toBe("2026-11-14 04:10 UTC");
    expect(rows.label).toBeUndefined();
    expect(rows.orbit).toBeUndefined();
    // Every meta key the catalogue writes has a labelled schema field.
    const keys = new Set(celestrak.schema.map((f) => f.key));
    for (const key of Object.keys(stations.meta[0])) expect(keys.has(key), key).toBe(true);

    const geo = await celestrak.detail?.(
      1,
      mixed.meta[mixed.meta.findIndex((m) => m.label === "GOES 16")],
      fakeContext({ now: T0 }),
    );
    const apogee = geo?.fields?.find((f) => f.key === "apogeeKm");
    expect(apogee?.value).toMatch(/^35,7\d\d$/);
    expect((await celestrak.detail?.(5, undefined, fakeContext({ now: T0 })))?.fields).toEqual([]);
  });
});

describe("element sources and fallback", () => {
  const PROXY = "https://gateway.example/v1/proxy/celestrak/active.csv";
  const SNAPSHOT = "https://halo.example/data/satellites.csv";
  /** The same objects with every element set a month older. */
  const MONTH_OLD_CSV = STATIONS_CSV.replaceAll("2026-11-", "2026-10-");
  const plugin = createCelestrakSource({ url: PROXY, fallbackUrl: SNAPSHOT });
  const failureOf = (promise: Promise<unknown> | undefined) =>
    (promise ?? Promise.resolve()).then(
      () => null,
      (error: unknown) => error as SourceError,
    );

  test("fetch asks the configured element source and nothing else", async () => {
    const ctx = fakeContext({
      now: T0,
      routes: { "gateway.example": STATIONS_CSV, "halo.example": MIXED_CSV },
    });
    const raw = (await plugin.fetch?.(ctx)) as SatelliteElements;
    expect(ctx.requests).toEqual([PROXY]);
    expect(raw.origin).toBe("live");
    expect(raw.count).toBe(18);
    expect(new Date(raw.elementsMs).toISOString()).toBe("2026-11-14T04:10:44.607Z");
    // Same plugin id, layer and policy as the direct source: only the address differs.
    expect([plugin.id, plugin.layer, plugin.cacheTtl, plugin.refreshRate]).toEqual([
      celestrak.id,
      celestrak.layer,
      celestrak.cacheTtl,
      celestrak.refreshRate,
    ]);
  });

  test("the direct source is the default, with no snapshot", async () => {
    const ctx = fakeContext({ now: T0, routes: { "celestrak.org": STATIONS_CSV } });
    expect(((await celestrak.fetch?.(ctx)) as SatelliteElements).origin).toBe("live");
    expect(ctx.requests).toEqual([CELESTRAK_GP_URL]);
    const offline = fakeContext({ now: T0 });
    await expect(celestrak.fallback?.(offline)).rejects.toMatchObject({ name: "SourceError" });
  });

  test("a failure of the element source is the runner's to handle: fetch never reaches for the snapshot", async () => {
    for (const status of [403, 500, 503]) {
      const ctx = fakeContext({
        now: T0,
        routes: { "gateway.example": { status, body: "" }, "halo.example": STATIONS_CSV },
      });
      const error = await failureOf(plugin.fetch?.(ctx));
      expect(error?.code).toBe(status === 403 ? "blocked" : "http");
      expect(ctx.requests).toEqual([PROXY]);
    }
    const thrown = fakeContext({ now: T0 });
    thrown.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    await expect(plugin.fetch?.(thrown)).rejects.toBeInstanceOf(TypeError);
  });

  test("the proxy's JSON error is read for its sentence", async () => {
    const body = JSON.stringify({
      error: { code: "unavailable", message: "The gateway runs in mock mode." },
    });
    const ctx = fakeContext({ now: T0, routes: { "gateway.example": { status: 503, body } } });
    const error = await failureOf(plugin.fetch?.(ctx));
    expect(error?.message).toBe(
      "The satellite element proxy answered HTTP 503: The gateway runs in mock mode.",
    );
    expect([error?.code, error?.status]).toEqual(["http", 503]);
  });

  test("fallback prefers the runner's older copy, and says how old it is", async () => {
    const ctx = fakeContext({
      now: T0,
      routes: { "gateway.example": STATIONS_CSV, "halo.example": MIXED_CSV },
    });
    const result = await plugin.fallback?.(ctx);
    expect(ctx.requests).toEqual([PROXY]);
    expect((result?.raw as SatelliteElements).origin).toBe("cache");
    expect(result?.raw.count).toBe(18);
    expect(result?.message).toBe(
      "Showing satellite orbits from 14 November. Fresher data is temporarily unavailable.",
    );
  });

  test("fallback reads the bundled snapshot when there is no older copy", async () => {
    // The runner's cache-only fetch fails a URL it holds nothing for; the fake answers 404.
    const ctx = fakeContext({ now: T0, routes: { "halo.example": MIXED_CSV } });
    const result = await plugin.fallback?.(ctx);
    expect(ctx.requests).toEqual([PROXY, SNAPSHOT]);
    expect((result?.raw as SatelliteElements).origin).toBe("snapshot");
    expect(result?.raw.count).toBe(mixed.count);
    expect(result?.message).toBe(
      "Showing satellite orbits from 14 November. Fresher data is temporarily unavailable.",
    );
    // A recompute of the stand-in is an ordinary update.
    expect(updateAt(result?.raw as SatelliteElements, T0).count).toBe(mixed.count);
  });

  test("a copy kept from long ago gives way to a newer snapshot", async () => {
    const ctx = fakeContext({
      now: T0,
      routes: { "gateway.example": MONTH_OLD_CSV, "halo.example": MIXED_CSV },
    });
    const result = await plugin.fallback?.(ctx);
    expect(ctx.requests).toEqual([PROXY, SNAPSHOT]);
    expect((result?.raw as SatelliteElements).origin).toBe("snapshot");

    // With no snapshot to compare, the old copy is shown and its age is spelled out.
    const alone = fakeContext({ now: T0, routes: { "celestrak.org": MONTH_OLD_CSV } });
    const old = await celestrak.fallback?.(alone);
    expect((old?.raw as SatelliteElements).origin).toBe("cache");
    expect(old?.message).toBe(
      "Showing satellite orbits from 14 October. They are 31 days old, so positions are only a rough guide. Fresher data is temporarily unavailable.",
    );
  });

  test("an unreadable snapshot is an error, never an empty sky", async () => {
    for (const body of ["<html>Not found</html>", ""]) {
      const ctx = fakeContext({ now: T0, routes: { "halo.example": body } });
      await expect(plugin.fallback?.(ctx)).rejects.toMatchObject({
        name: "SourceError",
        code: "bad-data",
      });
    }
    const missing = fakeContext({ now: T0 });
    await expect(plugin.fallback?.(missing)).rejects.toMatchObject({
      name: "SourceError",
      code: "http",
      status: 404,
    });
  });

  test("messages give the day, the year when it differs, and the age past two weeks", () => {
    const at = (iso: string) => Date.parse(iso);
    expect(fallbackMessage(at("2026-11-12T06:00:00Z"), T0)).toBe(
      "Showing satellite orbits from 12 November. Fresher data is temporarily unavailable.",
    );
    expect(fallbackMessage(T0 - 13 * DAY_MS, T0)).not.toContain("days old");
    expect(fallbackMessage(T0 - 14 * DAY_MS, T0)).toContain("They are 14 days old");
    expect(fallbackMessage(at("2025-12-30T00:00:00Z"), at("2026-01-02T00:00:00Z"))).toBe(
      "Showing satellite orbits from 30 December 2025. Fresher data is temporarily unavailable.",
    );
  });

  test("the bundled snapshot parses with this plugin and matches its sidecar", () => {
    const base = new URL("../../../../apps/web/public/data/", import.meta.url);
    // Written with LF line ends; a checkout with core.autocrlf may turn them into CRLF.
    const csv = readFileSync(new URL("satellites.csv", base), "utf8").replaceAll("\r\n", "\n");
    const sidecar = JSON.parse(readFileSync(new URL("satellites.json", base), "utf8")) as {
      objects: number;
      bytes: number;
      epochs: { median: string };
    };
    const snapshot = buildCatalogue(csv);
    expect(snapshot.count).toBe(sidecar.objects);
    expect(snapshot.count).toBeGreaterThan(5000);
    expect(snapshot.skipped).toBe(0);
    expect(Buffer.byteLength(csv)).toBe(sidecar.bytes);
    const epochs = Float64Array.from(snapshot.epochMs).sort();
    expect(new Date(epochs[epochs.length >> 1]).toISOString()).toBe(sidecar.epochs.median);
  });
});
