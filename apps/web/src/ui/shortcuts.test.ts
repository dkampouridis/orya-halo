import { EntityKind, LAYERS } from "@orya-halo/schema";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { defaultLayers, haloActions, onIntent, useHalo } from "../core/store.ts";
import type { Intent } from "../core/store.ts";
import { resolveShortcut, runShortcut } from "./shortcuts.ts";
import type { KeyInput } from "./shortcuts.ts";

const press = (key: string, extra: Partial<KeyInput> = {}) =>
  resolveShortcut({ key, typing: false, overlayOpen: false, ...extra });

describe("resolveShortcut", () => {
  it("maps each documented key to its action", () => {
    expect(press("/")).toEqual({ type: "search" });
    expect(press("f")).toEqual({ type: "follow" });
    expect(press("l")).toEqual({ type: "live" });
    expect(press("n")).toEqual({ type: "north" });
    expect(press("h")).toEqual({ type: "home" });
    expect(press("m")).toEqual({ type: "sound" });
    expect(press("?")).toEqual({ type: "shortcuts" });
    expect(press("Escape")).toEqual({ type: "escape" });
    expect(press("+")).toEqual({ type: "zoom", delta: 1 });
    expect(press("=")).toEqual({ type: "zoom", delta: 1 });
    expect(press("-")).toEqual({ type: "zoom", delta: -1 });
  });

  it("toggles every layer by its hotkey, 1 to 0 in dock order", () => {
    expect(LAYERS.map((l) => l.hotkey)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]);
    for (const layer of LAYERS)
      expect(press(layer.hotkey)).toEqual({ type: "layer", layer: layer.id });
  });

  it("does not care about Caps Lock", () => {
    expect(press("F")).toEqual({ type: "follow" });
    expect(press("M")).toEqual({ type: "sound" });
  });

  it("ignores everything while typing in a field", () => {
    for (const key of ["/", "1", "f", "l", "n", "h", "m", "?", "+", "-", "Escape"]) {
      expect(press(key, { typing: true })).toBeNull();
    }
  });

  it("leaves browser and system chords alone", () => {
    expect(press("l", { ctrlKey: true })).toBeNull();
    expect(press("f", { metaKey: true })).toBeNull();
    expect(press("1", { altKey: true })).toBeNull();
    expect(press("-", { ctrlKey: true })).toBeNull();
  });

  it("gives the keyboard to an open dialog, except for closing the shortcuts list", () => {
    expect(press("1", { overlayOpen: true })).toBeNull();
    expect(press("Escape", { overlayOpen: true })).toBeNull();
    expect(press("/", { overlayOpen: true })).toBeNull();
    expect(press("?", { overlayOpen: true })).toEqual({ type: "shortcuts" });
  });

  it("ignores keys it has no use for", () => {
    for (const key of ["a", "Enter", "Tab", " ", "ArrowLeft", "Shift", "F5"])
      expect(press(key)).toBeNull();
  });
});

describe("runShortcut", () => {
  const ref = { kind: EntityKind.Aircraft, id: 42 };

  beforeEach(() => {
    useHalo.setState({
      layers: defaultLayers(),
      selection: null,
      following: false,
      searchOpen: false,
      overlay: "none",
      sound: false,
      clock: { mode: "live", timeMs: 1000 },
      history: null,
    });
  });

  it("toggles a layer", () => {
    const before = useHalo.getState().layers.radar.enabled;
    runShortcut({ type: "layer", layer: "radar" });
    expect(useHalo.getState().layers.radar.enabled).toBe(!before);
  });

  it("follows only when something is selected", () => {
    runShortcut({ type: "follow" });
    expect(useHalo.getState().following).toBe(false);
    haloActions().select(ref);
    runShortcut({ type: "follow" });
    expect(useHalo.getState().following).toBe(true);
    runShortcut({ type: "follow" });
    expect(useHalo.getState().following).toBe(false);
  });

  it("Escape closes the search first and clears the selection second", () => {
    haloActions().select(ref);
    haloActions().setSearchOpen(true);
    runShortcut({ type: "escape" });
    expect(useHalo.getState().searchOpen).toBe(false);
    expect(useHalo.getState().selection).toEqual(ref);
    runShortcut({ type: "escape" });
    expect(useHalo.getState().selection).toBeNull();
  });

  it("goes back to live from a scrubbed clock", () => {
    useHalo.setState({ history: { fromMs: 0, toMs: 10_000 } });
    haloActions().scrubTo(5000);
    expect(useHalo.getState().clock.mode).toBe("scrub");
    runShortcut({ type: "live" });
    expect(useHalo.getState().clock.mode).toBe("live");
  });

  it("opens, then closes, the shortcuts list", () => {
    runShortcut({ type: "shortcuts" });
    expect(useHalo.getState().overlay).toBe("shortcuts");
    runShortcut({ type: "shortcuts" });
    expect(useHalo.getState().overlay).toBe("none");
  });

  it("switches sound and opens search", () => {
    runShortcut({ type: "sound" });
    expect(useHalo.getState().sound).toBe(true);
    runShortcut({ type: "search" });
    expect(useHalo.getState().searchOpen).toBe(true);
  });

  it("asks the controller for camera moves instead of making them", () => {
    const seen: Intent[] = [];
    const off = onIntent((intent) => seen.push(intent));
    runShortcut({ type: "north" });
    runShortcut({ type: "zoom", delta: 1 });
    runShortcut({ type: "zoom", delta: -1 });
    runShortcut({ type: "home" });
    off();
    expect(seen).toEqual([
      { type: "reset-north" },
      { type: "zoom", delta: 1 },
      { type: "zoom", delta: -1 },
      { type: "home" },
    ]);
  });
});
