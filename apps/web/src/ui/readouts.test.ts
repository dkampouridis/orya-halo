import { EntityKind } from "@orya-halo/schema";
import type { DetailField, EntityDetail, LayerId } from "@orya-halo/schema";
import { describe, expect, it } from "vite-plus/test";
import { distanceKm } from "./format.ts";
import { canFollow, detailView, routeProgress, tweenable } from "./readouts.ts";

const KIND: Partial<Record<LayerId, EntityKind>> = {
  aircraft: EntityKind.Aircraft,
  ships: EntityKind.Ship,
  satellites: EntityKind.Satellite,
  quakes: EntityKind.Quake,
  fires: EntityKind.Fire,
  webcams: EntityKind.Webcam,
  cables: EntityKind.Cable,
};

function detail(
  layer: LayerId,
  fields: DetailField[],
  extra: Partial<EntityDetail> = {},
): EntityDetail {
  return {
    ref: { kind: KIND[layer] ?? EntityKind.Aircraft, id: 1 },
    layer,
    title: "BAW115",
    lon: -46,
    lat: 27.5,
    alt: 10_972,
    heading: 251,
    speed: 232.5,
    fixTimeMs: 0,
    fields,
    attribution: { text: "adsb.lol", url: "https://adsb.lol" },
    ...extra,
  };
}

const keys = (d: EntityDetail): string[] => detailView(d).readouts.map((r) => r.key);
const labels = (d: EntityDetail): string[] => detailView(d).readouts.map((r) => r.label);

describe("readouts per layer", () => {
  it("falls back to the top-level numbers for aircraft that send no fields", () => {
    const view = detailView(detail("aircraft", []));
    expect(view.readouts.map((r) => r.label)).toEqual(["Altitude", "Ground speed", "Heading"]);
    const [alt, speed, heading] = view.readouts;
    expect(alt).toMatchObject({ numeric: 10_972, unit: "m", decimals: 0 });
    // 232.5 m/s is 452 kt.
    expect(Math.round(speed.numeric as number)).toBe(452);
    expect(speed.unit).toBe("kt");
    expect(heading).toMatchObject({ numeric: 251, unit: "°" });
  });

  it("prefers the source's own fields, in their unit, over the fallback", () => {
    const d = detail("aircraft", [
      { key: "alt", label: "Altitude", value: "36,000", unit: "ft", numeric: 36_000 },
      { key: "speed", label: "Ground speed", value: "452", unit: "kt", numeric: 452 },
      { key: "heading", label: "Track", value: "251", unit: "°", numeric: 251 },
      { key: "vrate", label: "Vertical rate", value: "-640", unit: "ft/min", numeric: -640 },
    ]);
    const view = detailView(d);
    expect(view.readouts.map((r) => [r.label, r.numeric, r.unit])).toEqual([
      ["Altitude", 36_000, "ft"],
      ["Ground speed", 452, "kt"],
      ["Heading", 251, "°"],
      ["Climb rate", -640, "ft/min"],
    ]);
    // Shown as readouts, so not repeated in the list beneath.
    expect(view.facts.map((f) => f.key)).toEqual(["position"]);
  });

  it("shows climb rate only when the source provides it", () => {
    expect(labels(detail("aircraft", []))).not.toContain("Climb rate");
  });

  it("leaves heading out when it is unknown", () => {
    expect(labels(detail("aircraft", [], { heading: null }))).toEqual(["Altitude", "Ground speed"]);
  });

  it("gives ships speed and course, then their size when known", () => {
    expect(labels(detail("ships", [], { speed: 8.95, heading: 90 }))).toEqual(["Speed", "Course"]);
    const d = detail(
      "ships",
      [
        { key: "lengthM", label: "Length", value: "294", unit: "m", numeric: 294 },
        { key: "draughtM", label: "Draught", value: "11.2", unit: "m", numeric: 11.2 },
        { key: "navStatus", label: "Status", value: "Under way using engine" },
      ],
      { speed: 8.95, heading: 90 },
    );
    const view = detailView(d);
    expect(view.readouts.map((r) => r.label)).toEqual(["Speed", "Course", "Length", "Draught"]);
    // 8.95 m/s is 17.4 kt, to one decimal for ships.
    expect(view.readouts[0]).toMatchObject({ unit: "kt", decimals: 1 });
    expect((view.readouts[0].numeric as number).toFixed(1)).toBe("17.4");
    expect(view.facts.map((f) => f.key)).toEqual(["position", "navStatus"]);
  });

  it("gives satellites altitude in kilometres and speed in kilometres a second", () => {
    const d = detail(
      "satellites",
      [
        { key: "inclinationDeg", label: "Inclination", value: "51.6", unit: "°", numeric: 51.6 },
        { key: "periodMin", label: "Period", value: "92.9", unit: "min", numeric: 92.9 },
        { key: "noradId", label: "NORAD id", value: "25,544", numeric: 25_544 },
      ],
      { alt: 418_000, speed: 7660, heading: null },
    );
    const view = detailView(d);
    expect(view.readouts.map((r) => [r.label, r.unit])).toEqual([
      ["Altitude", "km"],
      ["Speed", "km/s"],
      ["Inclination", "°"],
      ["Period", "min"],
    ]);
    expect(view.readouts[0].numeric).toBe(418);
    expect(view.readouts[1]).toMatchObject({ numeric: 7.66, decimals: 2 });
    expect(view.facts.map((f) => f.key)).toEqual(["position", "noradId"]);
  });

  it("gives earthquakes magnitude and depth, never an altitude", () => {
    const d = detail(
      "quakes",
      [
        { key: "label", label: "Place", value: "38 km SW of Crete" },
        { key: "magnitude", label: "Magnitude", value: "5.2", numeric: 5.2 },
        { key: "magType", label: "Magnitude type", value: "mww" },
        { key: "depthKm", label: "Depth", value: "10", unit: "km", numeric: 10 },
        { key: "timeMs", label: "Time", value: "2026-11-14 19:40 UTC", numeric: 1_794_684_000_000 },
      ],
      { title: "38 km SW of Crete", alt: -10_000, speed: 0, heading: null },
    );
    const view = detailView(d);
    expect(view.readouts.map((r) => [r.label, r.numeric, r.decimals])).toEqual([
      ["Magnitude", 5.2, 1],
      ["Depth", 10, 0],
    ]);
    // The place is the panel's heading already; the time stays as the date it was written as.
    expect(view.facts.map((f) => f.key)).toEqual(["position", "magType", "timeMs"]);
  });

  it("gives fires their radiative power and cables their length", () => {
    expect(
      keys(
        detail("fires", [
          { key: "frpMw", label: "Fire radiative power", value: "48.2", unit: "MW", numeric: 48.2 },
          { key: "confidencePct", label: "Confidence score", value: "86", unit: "%", numeric: 86 },
        ]),
      ),
    ).toEqual(["frpMw", "confidencePct"]);
    expect(
      labels(
        detail("cables", [
          { key: "lengthKm", label: "Mapped length", value: "5,380", unit: "km", numeric: 5380 },
        ]),
      ),
    ).toEqual(["Mapped length"]);
  });

  it("shows no readouts for layers with nothing to measure", () => {
    const view = detailView(
      detail("webcams", [{ key: "provider", label: "Provider", value: "Digitraffic" }]),
    );
    expect(view.readouts).toEqual([]);
    expect(view.facts.map((f) => f.key)).toEqual(["position", "provider"]);
  });
});

describe("the quiet list", () => {
  it("drops rows that repeat the heading or the subtitle", () => {
    const d = detail(
      "aircraft",
      [
        { key: "label", label: "Callsign", value: "BAW115" },
        { key: "typeName", label: "Aircraft", value: "Boeing 777-300ER" },
        { key: "operator", label: "Operator", value: "British Airways" },
        { key: "registration", label: "Registration", value: "G-STBK" },
        { key: "squawk", label: "Squawk", value: "" },
      ],
      { subtitle: "Boeing 777-300ER · British Airways" },
    );
    expect(detailView(d).facts.map((f) => f.key)).toEqual(["position", "registration"]);
  });

  it("leaves origin and destination to the route section", () => {
    const d = detail(
      "aircraft",
      [
        { key: "origin", label: "From", value: "LHR" },
        { key: "destination", label: "To", value: "JFK" },
        { key: "country", label: "Country", value: "United Kingdom" },
      ],
      { origin: { code: "LHR" }, destination: { code: "JFK" } },
    );
    expect(detailView(d).facts.map((f) => f.key)).toEqual(["position", "country"]);
  });

  it("starts with the position", () => {
    expect(detailView(detail("aircraft", [])).facts[0]).toMatchObject({
      key: "position",
      value: "27.50° N, 46.00° W",
    });
  });
});

describe("tweenable", () => {
  it("accepts a figure that is its number written out", () => {
    expect(tweenable({ key: "alt", label: "Altitude", value: "10,972", numeric: 10_972 })).toBe(
      true,
    );
    expect(tweenable({ key: "speed", label: "Speed", value: "17.4", numeric: 17.38 })).toBe(true);
    expect(tweenable({ key: "vrate", label: "Climb", value: "-640", numeric: -640 })).toBe(true);
  });

  it("refuses times, text and mismatched numbers", () => {
    expect(
      tweenable({
        key: "timeMs",
        label: "Time",
        value: "2026-11-14 19:40 UTC",
        numeric: 1_794_684_000_000,
      }),
    ).toBe(false);
    expect(tweenable({ key: "orbit", label: "Orbit", value: "Low Earth orbit" })).toBe(false);
    expect(tweenable({ key: "x", label: "X", value: "12", numeric: 40 })).toBe(false);
    expect(tweenable({ key: "x", label: "X", value: "12", numeric: Number.NaN })).toBe(false);
  });

  it("makes a non-tweenable readout plain text", () => {
    const d = detail("quakes", [{ key: "magnitude", label: "Magnitude", value: "n/a" }]);
    const [readout] = detailView(d).readouts;
    expect(readout.text).toBe("n/a");
    expect(readout.numeric).toBeUndefined();
  });
});

describe("routeProgress", () => {
  const lhr = { code: "LHR", name: "London Heathrow", lon: -0.4614, lat: 51.4775 };
  const jfk = { code: "JFK", name: "New York JFK", lon: -73.7781, lat: 40.6413 };

  it("is the share of the way from origin to destination", () => {
    const mid = detail("aircraft", [], { origin: lhr, destination: jfk, lon: -40, lat: 52 });
    const p = routeProgress(mid, distanceKm) as number;
    expect(p).toBeGreaterThan(0.4);
    expect(p).toBeLessThan(0.6);
    expect(
      routeProgress(detail("aircraft", [], { origin: lhr, destination: jfk, ...lhr }), distanceKm),
    ).toBe(0);
    expect(
      routeProgress(detail("aircraft", [], { origin: lhr, destination: jfk, ...jfk }), distanceKm),
    ).toBe(1);
  });

  it("is unknown when an end has no coordinates", () => {
    expect(
      routeProgress(
        detail("aircraft", [], { origin: { code: "LHR" }, destination: jfk }),
        distanceKm,
      ),
    ).toBeNull();
    expect(routeProgress(detail("aircraft", []), distanceKm)).toBeNull();
  });
});

describe("canFollow", () => {
  it("is for things that move", () => {
    expect((["aircraft", "ships", "satellites"] as const).every(canFollow)).toBe(true);
    expect((["quakes", "cables", "fires", "webcams"] as const).some(canFollow)).toBe(false);
  });
});
