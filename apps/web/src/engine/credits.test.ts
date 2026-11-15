import { describe, expect, it } from "vite-plus/test";
import { mergeCredits, safeHref } from "./credits.ts";
import { describeStatus } from "./status.ts";

describe("mergeCredits", () => {
  const usgs = { text: "Credit: U.S. Geological Survey", url: "https://earthquake.usgs.gov/" };
  const osm = { text: "© OpenStreetMap", url: "https://openstreetmap.org/copyright" };

  it("keeps the order given: data first, the base map last", () => {
    expect(
      mergeCredits([usgs], [{ text: "Night lights: NASA" }], [osm]).map((c) => c.text),
    ).toEqual(["Credit: U.S. Geological Survey", "Night lights: NASA", "© OpenStreetMap"]);
  });

  it("credits a provider once, however many feeds name it", () => {
    const again = { text: " credit: u.s. geological survey ", url: "https://example.org/other" };
    const merged = mergeCredits([usgs, again], [usgs]);
    expect(merged).toEqual([usgs]);
  });

  it("does not repeat a credit that a longer one already contains", () => {
    const contributors = { text: "© OpenStreetMap contributors", url: "https://osm.org/copyright" };
    expect(mergeCredits([contributors], [osm]).map((c) => c.text)).toEqual([
      "© OpenStreetMap contributors",
    ]);
    // The other way round the fuller credit takes the shorter one's place.
    expect(mergeCredits([osm, usgs], [contributors])).toEqual([contributors, usgs]);
  });

  it("drops empty credits", () => {
    expect(mergeCredits([{ text: "   " }, { text: "" }], [])).toEqual([]);
  });
});

describe("safeHref", () => {
  it("passes web addresses", () => {
    expect(safeHref("https://www.rainviewer.com/")).toBe("https://www.rainviewer.com/");
    expect(safeHref("http://example.org/a?b=1")).toBe("http://example.org/a?b=1");
  });

  it("refuses anything that is not a web address", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,<script>1</script>")).toBeNull();
    expect(safeHref("not a link")).toBeNull();
    expect(safeHref("")).toBeNull();
    expect(safeHref(undefined)).toBeNull();
  });
});

describe("describeStatus", () => {
  const ok = { local: true, deep: null, remoteFailed: false, contextLost: false } as const;

  it("says nothing when the bundled extract is all there is, which is the default", () => {
    expect(describeStatus(ok)).toEqual({ basemap: "low-zoom", graphics: "ok" });
    expect(describeStatus({ ...ok, deep: "api" })).toEqual({ basemap: "full", graphics: "ok" });
  });

  it("explains a missing base map to the person and to whoever runs the app", () => {
    const status = describeStatus({ ...ok, local: false });
    expect(status.basemap).toBe("missing");
    expect(status.message).toMatch(/base map could not be loaded/);
    expect(status.message).toMatch(/Live data still works/);
    expect(status.hint).toMatch(/fetch-tiles\.mjs/);
  });

  it("is not missing when a deep source stands in for the extract", () => {
    const status = describeStatus({ ...ok, local: false, deep: "pmtiles" });
    expect(status.basemap).toBe("full");
    expect(status.message).toBeUndefined();
  });

  it("hints at a remote archive that could not be read, without alarming anyone", () => {
    const status = describeStatus({ ...ok, remoteFailed: true });
    expect(status.message).toBeUndefined();
    expect(status.hint).toMatch(/VITE_PMTILES_URL/);
  });

  it("puts a lost context ahead of everything else", () => {
    const status = describeStatus({ ...ok, local: false, contextLost: true });
    expect(status.graphics).toBe("context-lost");
    expect(status.message).toMatch(/reload the page/);
    expect(status.hint).toMatch(/fetch-tiles/);
  });
});
