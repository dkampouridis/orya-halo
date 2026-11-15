import { EntityKind } from "@orya-halo/schema";
import type { SearchResult } from "@orya-halo/schema";
import { describe, expect, it } from "vite-plus/test";
import { groupResults, MAX_RESULTS, moveActive } from "./search-model.ts";

let nextId = 1;
const entity = (
  title: string,
  layer: SearchResult["layer"],
  kind: EntityKind,
  score: number,
): SearchResult => ({
  type: "entity",
  ref: { kind, id: nextId++ },
  layer,
  title,
  lon: 0,
  lat: 0,
  score,
});
const place = (title: string, score: number): SearchResult => ({
  type: "place",
  title,
  lon: 1,
  lat: 2,
  score,
});

// Best first, as the service returns them, with the layers interleaved.
const RESULTS: SearchResult[] = [
  place("Atlanta", 99),
  entity("Atlantic Star", "ships", EntityKind.Ship, 95),
  entity("DAL30", "aircraft", EntityKind.Aircraft, 94),
  entity("Atlas 5 Centaur R/B", "satellites", EntityKind.Satellite, 90),
  entity("GTI8102", "aircraft", EntityKind.Aircraft, 88),
  place("Atlantic City", 80),
  entity("Atlantic Sail", "ships", EntityKind.Ship, 70),
];

describe("groupResults", () => {
  it("groups by layer in dock order, with places last", () => {
    const model = groupResults(RESULTS);
    expect(model.groups.map((g) => g.id)).toEqual(["aircraft", "ships", "satellites", "places"]);
    expect(model.groups.map((g) => g.label)).toEqual(["Aircraft", "Ships", "Satellites", "Places"]);
    expect(model.groups.at(-1)?.layer).toBeNull();
  });

  it("keeps the service's order inside each group", () => {
    const model = groupResults(RESULTS);
    expect(model.groups[0].items.map((i) => i.result.title)).toEqual(["DAL30", "GTI8102"]);
    expect(model.groups[1].items.map((i) => i.result.title)).toEqual([
      "Atlantic Star",
      "Atlantic Sail",
    ]);
  });

  it("numbers results in the order they are shown, so the keyboard walks down the page", () => {
    const model = groupResults(RESULTS);
    const shown = model.groups.flatMap((g) => g.items);
    expect(shown.map((i) => i.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    for (const item of shown) expect(model.flat[item.index]).toBe(item.result);
    expect(model.flat.map((r) => r.title)).toEqual([
      "DAL30",
      "GTI8102",
      "Atlantic Star",
      "Atlantic Sail",
      "Atlas 5 Centaur R/B",
      "Atlanta",
      "Atlantic City",
    ]);
  });

  it("keeps the best eight, whichever groups they fall in", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      i % 2
        ? place(`Place ${i}`, 100 - i)
        : entity(`AC${i}`, "aircraft", EntityKind.Aircraft, 100 - i),
    );
    const model = groupResults(many);
    expect(model.flat).toHaveLength(MAX_RESULTS);
    expect(new Set(model.flat)).toEqual(new Set(many.slice(0, MAX_RESULTS)));
  });

  it("files an object with no layer under places rather than dropping it", () => {
    const odd: SearchResult = { type: "entity", title: "Unknown", lon: 0, lat: 0, score: 1 };
    expect(groupResults([odd]).groups.map((g) => g.id)).toEqual(["places"]);
  });

  it("is empty for no results", () => {
    expect(groupResults([])).toEqual({ groups: [], flat: [] });
  });
});

describe("moveActive", () => {
  it("moves down and up one row", () => {
    expect(moveActive(0, "ArrowDown", 5)).toBe(1);
    expect(moveActive(3, "ArrowUp", 5)).toBe(2);
  });

  it("wraps at both ends", () => {
    expect(moveActive(4, "ArrowDown", 5)).toBe(0);
    expect(moveActive(0, "ArrowUp", 5)).toBe(4);
  });

  it("jumps to the ends", () => {
    expect(moveActive(2, "Home", 5)).toBe(0);
    expect(moveActive(2, "End", 5)).toBe(4);
  });

  it("stays put in a list of one", () => {
    expect(moveActive(0, "ArrowDown", 1)).toBe(0);
    expect(moveActive(0, "ArrowUp", 1)).toBe(0);
  });

  it("ignores keys that are not list keys, and an empty list", () => {
    expect(moveActive(0, "Enter", 5)).toBeNull();
    expect(moveActive(0, "a", 5)).toBeNull();
    expect(moveActive(0, "ArrowDown", 0)).toBeNull();
  });
});
