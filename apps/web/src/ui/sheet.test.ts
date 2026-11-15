import { EntityKind } from "@orya-halo/schema";
import type { HaloEvent } from "@orya-halo/schema";
import { describe, expect, it } from "vite-plus/test";
import { tagParts } from "./HoverTag.tsx";
import { FLICK, releaseVelocity, snapSheet } from "./sheet.ts";
import { eventLayer, pickEvent } from "./Ticker.tsx";

const stops = { peek: 132, full: 590 };

describe("snapSheet", () => {
  it("settles on the nearer stop after a slow drag", () => {
    expect(snapSheet({ visible: 200, velocity: 0, ...stops, from: "peek" })).toBe("peek");
    expect(snapSheet({ visible: 420, velocity: 0, ...stops, from: "peek" })).toBe("full");
    expect(snapSheet({ visible: 300, velocity: 0.1, ...stops, from: "full" })).toBe("peek");
  });

  it("lets a flick decide, whatever the distance", () => {
    expect(snapSheet({ visible: 150, velocity: FLICK, ...stops, from: "peek" })).toBe("full");
    expect(snapSheet({ visible: 560, velocity: -FLICK, ...stops, from: "full" })).toBe("peek");
  });

  it("closes on a downward flick from the peek stop", () => {
    expect(snapSheet({ visible: 120, velocity: -FLICK, ...stops, from: "peek" })).toBe("close");
  });

  it("closes when dragged well below the peek stop", () => {
    expect(snapSheet({ visible: 50, velocity: 0, ...stops, from: "peek" })).toBe("close");
    expect(snapSheet({ visible: 100, velocity: 0, ...stops, from: "peek" })).toBe("peek");
  });

  it("closes when flung down from full past the peek stop", () => {
    expect(snapSheet({ visible: 90, velocity: -1.2, ...stops, from: "full" })).toBe("close");
  });
});

describe("releaseVelocity", () => {
  it("is positive for upward movement, in pixels per millisecond", () => {
    expect(
      releaseVelocity([
        [0, 600],
        [16, 590],
        [32, 580],
        [48, 570],
      ]),
    ).toBeCloseTo(30 / 48, 5);
  });

  it("is negative for downward movement", () => {
    expect(
      releaseVelocity([
        [0, 300],
        [20, 330],
      ]),
    ).toBeCloseTo(-1.5, 5);
  });

  it("looks only at the last moments, so a pause before lifting is not a flick", () => {
    const v = releaseVelocity([
      [0, 600],
      [16, 500],
      [32, 400],
      [400, 400],
      [416, 400],
    ]);
    expect(v).toBe(0);
  });

  it("is zero without enough samples", () => {
    expect(releaseVelocity([])).toBe(0);
    expect(releaseVelocity([[0, 10]])).toBe(0);
  });
});

describe("tagParts", () => {
  it("uses the worker's title, number and unit", () => {
    expect(
      tagParts({ label: "ISS (Zarya)  418 km", title: "ISS (Zarya)", value: "418", unit: "km" }),
    ).toEqual({
      name: "ISS (Zarya)",
      value: "418",
      unit: "km",
    });
  });

  it("falls back to the engine's label, whole, without splitting it", () => {
    expect(tagParts({ label: "BAW115  10,972 m" })).toEqual({ name: "BAW115  10,972 m" });
    expect(tagParts({ label: "Atlantic Star" })).toEqual({ name: "Atlantic Star" });
  });

  it("copes with a number that has no unit, and drops a unit that has no number", () => {
    expect(tagParts({ title: "M5.2 off Crete", value: "5.2" })).toEqual({
      name: "M5.2 off Crete",
      value: "5.2",
    });
    expect(tagParts({ title: "Atlantic Star", unit: "kt" })).toEqual({ name: "Atlantic Star" });
  });

  it("has nothing to say before either the engine or the worker has named the object", () => {
    expect(tagParts({})).toBeNull();
    expect(tagParts({ label: "  ", title: "" })).toBeNull();
  });
});

describe("ticker", () => {
  const event = (id: string, extra: Partial<HaloEvent> = {}): HaloEvent => ({
    id,
    topic: "quake",
    timeMs: 0,
    title: id,
    ...extra,
  });

  it("shows the newest notable event ahead of newer routine ones", () => {
    const events = [
      event("routine-new"),
      event("notable", { severity: 1 }),
      event("major-old", { severity: 2 }),
    ];
    expect(pickEvent(events)?.id).toBe("notable");
  });

  it("falls back to the newest event, and to nothing", () => {
    expect(pickEvent([event("a"), event("b", { severity: 0 })])?.id).toBe("a");
    expect(pickEvent([])).toBeNull();
  });

  it("colours the mark by the event's layer", () => {
    expect(eventLayer(event("q"))).toBe("quakes");
    expect(
      eventLayer(event("e", { topic: "emergency", ref: { kind: EntityKind.Aircraft, id: 7 } })),
    ).toBe("aircraft");
    expect(eventLayer(event("l", { topic: "launch" }))).toBeNull();
  });
});
