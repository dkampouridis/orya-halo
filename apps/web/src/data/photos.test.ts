import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { createAircraftPhotos, parsePlanespotters } from "./photos.ts";

/**
 * An answer in the shape the API gave Edge on http://localhost on 2026-11-14
 * (hosts, paths and the `utm_source` query as received). The values are made
 * up: the terms do not allow API data to be kept or passed on.
 */
const RECORDED = JSON.parse(
  readFileSync(new URL("./fixtures/planespotters-sample.json", import.meta.url), "utf8"),
) as unknown;

const HOUR = 3_600_000;

function fakeApi(answer: (url: string) => Response | Promise<Response>) {
  const requests: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);
    return answer(url);
  }) as typeof fetch;
  return { requests, fetchFn };
}

describe("parsePlanespotters", () => {
  test("reads an answer, passing every URL on unchanged", () => {
    expect(parsePlanespotters(RECORDED, "3C65A1")).toEqual({
      type: "image",
      // The large thumbnail, exactly as returned (the terms forbid rewriting it).
      url: "https://t.plnspttrs.net/00000/0000001_0123456789_280.jpg",
      // The photo's page, with the query string the API put there.
      link: "https://www.planespotters.net/photo/0000001/d-test-example-airline-airbus-a380?utm_source=api",
      credit: "Photo © Example Photographer, Planespotters.net",
      alt: "Photograph of aircraft 3C65A1",
    });
  });

  test("no photo, an error body or nonsense is no photo", () => {
    expect(parsePlanespotters({ photos: [] }, "ABC123")).toBeNull();
    expect(
      parsePlanespotters(
        { error: "Server User-Agent strings must include a contact URL" },
        "ABC123",
      ),
    ).toBeNull();
    expect(parsePlanespotters(null, "ABC123")).toBeNull();
    expect(parsePlanespotters("photos", "ABC123")).toBeNull();
  });

  test("a photo that cannot be credited or linked back, or is hosted elsewhere, is not shown", () => {
    const photo = {
      thumbnail_large: { src: "https://t.plnspttrs.net/1/a_280.jpg" },
      link: "https://www.planespotters.net/photo/1/a",
      photographer: "A. Spotter",
    };
    expect(parsePlanespotters({ photos: [photo] }, "ABC123")?.credit).toBe(
      "Photo © A. Spotter, Planespotters.net",
    );
    expect(parsePlanespotters({ photos: [{ ...photo, photographer: " " }] }, "ABC123")).toBeNull();
    expect(parsePlanespotters({ photos: [{ ...photo, link: undefined }] }, "ABC123")).toBeNull();
    expect(
      parsePlanespotters({ photos: [{ ...photo, link: "https://example.org/photo/1" }] }, "ABC123"),
    ).toBeNull();
    expect(
      parsePlanespotters(
        {
          photos: [
            { ...photo, thumbnail_large: { src: "https://evil.example/planespotters.net/a.jpg" } },
          ],
        },
        "ABC123",
      ),
    ).toBeNull();
    expect(
      parsePlanespotters(
        { photos: [{ ...photo, thumbnail_large: { src: "http://t.plnspttrs.net/1/a_280.jpg" } }] },
        "ABC123",
      ),
    ).toBeNull();
    // The small thumbnail stands in when the large one is missing.
    expect(
      parsePlanespotters(
        {
          photos: [
            {
              ...photo,
              thumbnail_large: undefined,
              thumbnail: { src: "https://cdn.planespotters.net/1/a_t.jpg" },
            },
          ],
        },
        "ABC123",
      )?.url,
    ).toBe("https://cdn.planespotters.net/1/a_t.jpg");
  });
});

describe("createAircraftPhotos", () => {
  test("asks by hex address, once per aircraft, however often the panel refreshes", async () => {
    let now = 1_800_000_000_000;
    const api = fakeApi(() => Response.json(RECORDED));
    const photos = createAircraftPhotos(api.fetchFn, () => now);
    expect(photos.peek(0x3c65a1)).toBeUndefined();
    // Two refreshes while the first lookup is still in the air share it.
    const [a, b] = await Promise.all([photos.lookup(0x3c65a1), photos.lookup(0x3c65a1)]);
    expect(a?.url).toBe("https://t.plnspttrs.net/00000/0000001_0123456789_280.jpg");
    expect(b).toBe(a);
    expect(api.requests).toEqual(["https://api.planespotters.net/pub/photos/hex/3C65A1"]);
    expect(photos.peek(0x3c65a1)).toBe(a);
    now += 23 * HOUR;
    await photos.lookup(0x3c65a1);
    expect(api.requests).toHaveLength(1);
    // The terms allow an answer to be reused for 24 hours, no longer.
    now += 2 * HOUR;
    await photos.lookup(0x3c65a1);
    expect(api.requests).toHaveLength(2);
  });

  test("addresses are padded to six hex digits; ids that are not ICAO addresses are not asked about", async () => {
    const api = fakeApi(() => Response.json({ photos: [] }));
    const photos = createAircraftPhotos(api.fetchFn);
    expect(await photos.lookup(0xabc)).toBeNull();
    expect(await photos.lookup(0x1000000)).toBeNull();
    expect(await photos.lookup(0)).toBeNull();
    expect(await photos.lookup(1.5)).toBeNull();
    expect(api.requests).toEqual(["https://api.planespotters.net/pub/photos/hex/000ABC"]);
  });

  test("no photo is remembered for an hour, a failure for five minutes, and neither ever throws", async () => {
    let now = 1_800_000_000_000;
    let mode: "none" | "refused" | "down" = "none";
    const api = fakeApi(() => {
      if (mode === "down") throw new TypeError("Failed to fetch");
      if (mode === "refused") return Response.json({ error: "no" }, { status: 403 });
      return Response.json({ photos: [] });
    });
    const photos = createAircraftPhotos(api.fetchFn, () => now);
    expect(await photos.lookup(1)).toBeNull();
    expect(photos.peek(1)).toBeNull();
    now += 59 * 60_000;
    await photos.lookup(1);
    expect(api.requests).toHaveLength(1);
    now += 2 * 60_000;
    await photos.lookup(1);
    expect(api.requests).toHaveLength(2);

    mode = "refused";
    expect(await photos.lookup(2)).toBeNull();
    mode = "down";
    expect(await photos.lookup(3)).toBeNull();
    now += 4 * 60_000;
    await photos.lookup(2);
    await photos.lookup(3);
    expect(api.requests).toHaveLength(4);
    now += 2 * 60_000;
    mode = "none";
    await photos.lookup(2);
    expect(api.requests).toHaveLength(5);
  });

  test("the memory is bounded", async () => {
    const api = fakeApi(() => Response.json({ photos: [] }));
    const photos = createAircraftPhotos(api.fetchFn);
    for (let icao = 1; icao <= 300; icao++) await photos.lookup(icao);
    // The oldest answers were dropped to make room.
    expect(photos.peek(1)).toBeUndefined();
    expect(photos.peek(300)).toBeNull();
    let held = 0;
    for (let icao = 1; icao <= 300; icao++) if (photos.peek(icao) !== undefined) held++;
    expect(held).toBe(256);
  });
});
