import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { LayerId, LayerState } from "@orya-halo/schema";
import { LayerStates, layerSubject } from "./layers.ts";
import { TrackBuffer } from "./track.ts";

const T0 = 1_800_000_000_000;

function setup(counts: Partial<Record<LayerId, number>> = {}) {
  const emitted: [LayerId, LayerState][] = [];
  const states = new LayerStates(
    (layer, state) => emitted.push([layer, state]),
    (layer) => counts[layer] ?? null,
  );
  return {
    emitted,
    states,
    counts,
    of: (layer: LayerId) => emitted.filter(([id]) => id === layer).map(([, state]) => state),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("LayerStates", () => {
  test("a disabled layer is off whatever its feeds say", () => {
    const { states, of } = setup();
    states.setFeed("quakes", "usgs", { status: "live" });
    expect(states.current("quakes")).toEqual({ status: "off", count: null });
    states.setEnabled("quakes", true);
    expect(of("quakes").pop()).toEqual({ status: "live", count: null });
  });

  test("takes the count from the store and the freshest update time from the feeds", () => {
    const { states } = setup({ quakes: 212 });
    states.setEnabled("quakes", true);
    states.setFeed("quakes", "usgs", { status: "live", updatedMs: T0 - 5000 });
    states.setFeed("quakes", "emsc", { status: "live", updatedMs: T0 - 1000 });
    expect(states.current("quakes")).toEqual({ status: "live", count: 212, updatedMs: T0 - 1000 });
  });

  test("the healthiest feed decides, and a failing one makes it partial", () => {
    const { states } = setup({ quakes: 3 });
    states.setEnabled("quakes", true);
    states.setFeed("quakes", "a", { status: "offline", message: "A is down." });
    states.setFeed("quakes", "b", { status: "loading" });
    expect(states.current("quakes").status).toBe("loading");
    states.setFeed("quakes", "b", { status: "live" });
    expect(states.current("quakes")).toMatchObject({ status: "degraded", message: "A is down." });
    states.setFeed("quakes", "a", { status: "live" });
    expect(states.current("quakes")).toEqual({ status: "live", count: 3 });
    states.setFeed("quakes", "a", { status: "needs-key", message: "Needs a key." });
    states.setFeed("quakes", "b", null);
    expect(states.current("quakes")).toMatchObject({
      status: "needs-key",
      message: "Needs a key.",
    });
  });

  test("path layers count what their feeds report", () => {
    const { states } = setup();
    states.setEnabled("cables", true);
    states.setFeed("cables", "telegeography", { status: "live", count: 550 });
    expect(states.current("cables")).toEqual({ status: "live", count: 550 });
  });

  test("passes on the worldwide total", () => {
    const { states } = setup({ aircraft: 1800 });
    states.setEnabled("aircraft", true);
    states.setFeed("aircraft", "gateway", { status: "live", total: 12_400 });
    expect(states.current("aircraft")).toEqual({ status: "live", count: 1800, total: 12_400 });
  });

  test("emits changes of status at once, and count changes at most once a second", async () => {
    const { states, of, counts } = setup({ aircraft: 0 });
    states.setEnabled("aircraft", true);
    states.setFeed("aircraft", "gateway", { status: "loading" });
    states.setFeed("aircraft", "gateway", { status: "live" });
    expect(of("aircraft").map((s) => s.status)).toEqual(["error", "loading", "live"]);
    // Enabled quietly, fed, then announced: no moment without a feed is shown.
    states.setEnabled("ships", true, false);
    states.setFeed("ships", "gateway", { status: "loading" });
    states.touch("ships", true);
    expect(of("ships").map((s) => s.status)).toEqual(["loading"]);
    // Counts tick up many times a second; the HUD hears about it once.
    for (let i = 1; i <= 50; i++) {
      counts.aircraft = i * 10;
      states.touch("aircraft");
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(of("aircraft")).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(600);
    expect(of("aircraft")).toHaveLength(4);
    expect(of("aircraft")[3]).toEqual({ status: "live", count: 500 });
  });

  test("does not repeat an unchanged state", async () => {
    const { states, emitted } = setup({ aircraft: 5 });
    states.setEnabled("aircraft", true);
    states.setFeed("aircraft", "gateway", { status: "live" });
    const count = emitted.length;
    for (let i = 0; i < 5; i++) {
      states.touch("aircraft");
      await vi.advanceTimersByTimeAsync(1500);
    }
    expect(emitted.length).toBe(count);
  });

  test("words agree with singular and plural layer names", () => {
    expect(layerSubject("ships", "are", "is")).toBe("Ships are");
    expect(layerSubject("radar", "are", "is")).toBe("Rain radar is");
    expect(layerSubject("imagery", "need", "needs")).toBe("Satellite imagery needs");
    expect(layerSubject("cables", "need", "needs")).toBe("Undersea cables need");
  });
});

describe("TrackBuffer", () => {
  test("keeps points in time order whatever order they arrive in", () => {
    const buffer = new TrackBuffer();
    buffer.add(3, 3, 300, 3000);
    buffer.add(1, 1, 100, 1000);
    buffer.add(2, 2, 200, 2000);
    const track = buffer.toTrack({ kind: 1, id: 9 });
    expect(track.ref).toEqual({ kind: 1, id: 9 });
    expect(track.count).toBe(3);
    expect([...track.timesMs]).toEqual([1000, 2000, 3000]);
    expect([...track.positions]).toEqual([1, 1, 100, 2, 2, 200, 3, 3, 300]);
    expect(buffer.lastMs).toBe(3000);
  });

  test("treats two feeds reporting the same fix as one point", () => {
    const buffer = new TrackBuffer();
    expect(buffer.add(1, 1, 0, 10_000)).toBe(true);
    expect(buffer.add(1.0001, 1, 0, 10_200)).toBe(false);
    expect(buffer.add(1.0001, 1, 0, 9_800)).toBe(false);
    expect(buffer.add(Number.NaN, 1, 0, 20_000)).toBe(false);
    expect(buffer.count).toBe(1);
  });

  test("is bounded: the oldest points make room", () => {
    const buffer = new TrackBuffer(4);
    for (let i = 1; i <= 10; i++) buffer.add(i, 0, 0, i * 1000);
    expect(buffer.count).toBe(4);
    expect([...buffer.toTrack({ kind: 1, id: 1 }).timesMs]).toEqual([7000, 8000, 9000, 10_000]);
    // Something older than everything held has nowhere to go.
    expect(buffer.add(0, 0, 0, 500)).toBe(false);
    // Something in the middle pushes the oldest out.
    expect(buffer.add(8.5, 0, 0, 8500)).toBe(true);
    expect([...buffer.toTrack({ kind: 1, id: 1 }).timesMs]).toEqual([8000, 8500, 9000, 10_000]);
  });

  test("merges a plugin's track in time order and hands over fresh buffers", () => {
    const buffer = new TrackBuffer();
    buffer.addAll([0, 0, 0, 2, 2, 0], [1000, 3000]);
    const extra = {
      ref: { kind: 3 as const, id: 5 },
      count: 2,
      positions: Float32Array.of(1, 1, 0, 9, 9, 0),
      timesMs: Float64Array.of(2000, 9000),
    };
    const first = buffer.toTrack({ kind: 3, id: 5 }, extra);
    expect([...first.timesMs]).toEqual([1000, 2000, 3000, 9000]);
    expect(first.positions[9]).toBe(9);
    const second = buffer.toTrack({ kind: 3, id: 5 }, extra);
    expect(second.positions.buffer).not.toBe(first.positions.buffer);
    expect(buffer.toTrack({ kind: 3, id: 5 }, null).count).toBe(2);
  });
});
