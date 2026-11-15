import { layerDef } from "@orya-halo/schema";
import type { LayerStatus } from "@orya-halo/schema";
import { describe, expect, it } from "vite-plus/test";
import { defaultLayers } from "../core/store.ts";
import type { LayerUiState } from "../core/store.ts";
import { formatNumber } from "./format.ts";
import { liveTotal, offlineGatewayLayers, rowLabel, rowView } from "./layer-status.ts";

const on = (status: LayerStatus, extra: Partial<LayerUiState> = {}): LayerUiState => ({
  enabled: true,
  status,
  count: null,
  ...extra,
});

describe("rowView", () => {
  const aircraft = layerDef("aircraft");
  const quakes = layerDef("quakes");

  it("off: hollow lamp, dim name, nothing on the right", () => {
    expect(rowView(aircraft, { enabled: false, status: "off", count: null })).toEqual({
      lamp: "hollow",
      dim: true,
      count: null,
      state: null,
      busy: false,
      note: null,
    });
  });

  it("stays quiet when a layer is off, whatever the worker last said about it", () => {
    const view = rowView(aircraft, {
      enabled: false,
      status: "live",
      count: 400,
      message: "stale",
    });
    expect(view).toMatchObject({ lamp: "hollow", count: null, note: null });
  });

  it("loading: the colour without the light, and the ring", () => {
    expect(rowView(aircraft, on("loading"))).toMatchObject({
      lamp: "pending",
      dim: false,
      busy: true,
      count: null,
    });
  });

  it("live: lit lamp and the count", () => {
    expect(rowView(aircraft, on("live", { count: 12_410 }))).toMatchObject({
      lamp: "lit",
      dim: false,
      count: 12_410,
      state: null,
      note: null,
    });
  });

  it("shows the worldwide total when the provider reports one", () => {
    expect(rowView(aircraft, on("live", { count: 812, total: 12_410 })).count).toBe(12_410);
    expect(rowView(aircraft, on("live", { count: 812, total: null })).count).toBe(812);
  });

  it("live with nothing to count shows no number", () => {
    expect(rowView(layerDef("nightlights"), on("live")).count).toBeNull();
  });

  it("degraded: broken lamp, the count, and the row's own message in warn", () => {
    const view = rowView(
      layerDef("ships"),
      on("degraded", { count: 8221, message: "Positions are 2 min old. Reconnecting." }),
    );
    expect(view).toMatchObject({
      lamp: "broken",
      dim: false,
      count: 8221,
      note: { text: "Positions are 2 min old. Reconnecting.", warn: true },
    });
  });

  it("needs a key: says so, with the instruction beneath, not as a warning", () => {
    const view = rowView(
      layerDef("fires"),
      on("needs-key", {
        message: "Wildfires need a free NASA FIRMS key. Add it to the .env file.",
      }),
    );
    expect(view).toMatchObject({
      lamp: "hollow",
      dim: true,
      state: { text: "Needs a key", warn: false },
      note: { text: "Wildfires need a free NASA FIRMS key. Add it to the .env file.", warn: false },
    });
  });

  it("offline: gateway rows leave the explanation to the dock, others carry their own", () => {
    expect(
      rowView(aircraft, on("offline", { message: "The gateway isn't reachable." })),
    ).toMatchObject({
      lamp: "hollow",
      state: { text: "Offline", warn: true },
      note: null,
    });
    expect(rowView(quakes, on("offline", { message: "USGS isn't answering." }))).toMatchObject({
      state: { text: "Offline", warn: true },
      note: { text: "USGS isn't answering.", warn: true },
    });
  });

  it("error: says so and how to try again", () => {
    const view = rowView(quakes, on("error"));
    expect(view.state).toEqual({ text: "Error", warn: true });
    expect(view.note?.warn).toBe(true);
    expect(view.note?.text).toMatch(/off and on/);
  });

  it("always has a sentence for a status that needs one, even without a message", () => {
    for (const status of ["degraded", "needs-key", "error"] as const) {
      expect(rowView(quakes, on(status)).note?.text.length).toBeGreaterThan(10);
      expect(
        rowView(quakes, on(status, { message: "   " })).note?.text.trim().length,
      ).toBeGreaterThan(10);
    }
  });

  it("names the row for screen readers with its count or state", () => {
    expect(rowLabel(aircraft, rowView(aircraft, on("live", { count: 12_410 })), formatNumber)).toBe(
      "Aircraft, 12,410",
    );
    expect(rowLabel(aircraft, rowView(aircraft, on("offline")), formatNumber)).toBe(
      "Aircraft, offline",
    );
    expect(rowLabel(aircraft, rowView(aircraft, on("loading")), formatNumber)).toBe(
      "Aircraft, loading",
    );
    expect(
      rowLabel(
        aircraft,
        rowView(aircraft, { enabled: false, status: "off", count: null }),
        formatNumber,
      ),
    ).toBe("Aircraft");
  });
});

describe("liveTotal", () => {
  it("sums the object layers that are showing data", () => {
    const layers = defaultLayers();
    layers.aircraft = on("live", { count: 12_410 });
    layers.ships = on("degraded", { count: 8221 });
    layers.satellites = on("live", { count: 13_906 });
    layers.quakes = on("live", { count: 37 });
    // Cables are paths, not objects: the mockup's 34,574 leaves their 587 out.
    layers.cables = on("live", { count: 587 });
    expect(liveTotal(layers)).toBe(34_574);
  });

  it("leaves out layers that are off, loading or unreachable", () => {
    const layers = defaultLayers();
    layers.aircraft = on("offline", { count: 12_410 });
    layers.ships = { enabled: false, status: "off", count: 8221 };
    layers.satellites = on("loading", { count: 5 });
    layers.quakes = on("live", { count: 37 });
    expect(liveTotal(layers)).toBe(37);
  });

  it("prefers the worldwide total", () => {
    const layers = defaultLayers();
    for (const id of ["ships", "satellites", "quakes"] as const)
      layers[id] = { enabled: false, status: "off", count: null };
    layers.aircraft = on("live", { count: 300, total: 12_410 });
    expect(liveTotal(layers)).toBe(12_410);
  });
});

describe("offlineGatewayLayers", () => {
  it("lists gateway layers that are on and unreachable", () => {
    const layers = defaultLayers();
    expect(offlineGatewayLayers(layers)).toEqual([]);
    layers.aircraft = on("offline");
    layers.ships = on("offline");
    layers.quakes = on("offline");
    expect(offlineGatewayLayers(layers).map((l) => l.id)).toEqual(["aircraft", "ships"]);
    layers.ships = { enabled: false, status: "off", count: null };
    expect(offlineGatewayLayers(layers).map((l) => l.id)).toEqual(["aircraft"]);
  });
});
