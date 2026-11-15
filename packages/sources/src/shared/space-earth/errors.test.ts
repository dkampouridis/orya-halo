import { describe, expect, test } from "vite-plus/test";
import { SourceError, fetchText, firstSentence } from "./errors.ts";
import { fakeContext } from "./testing.ts";

describe("firstSentence", () => {
  test("joins a sentence the provider wrapped over two lines, and stops there", () => {
    // CelesTrak's answer to a repeated download (the sample in satellites.test.ts). In the
    // browser on 2026-11-14 the first line alone left "since your last successful" hanging.
    const body =
      "GP data has not updated since your last successful\ndownload of GROUP=active at 2026-03-26 08:10:22 UTC.\nData is updated once every 2 hours.";
    expect(firstSentence(body)).toBe(
      "GP data has not updated since your last successful download of GROUP=active at 2026-03-26 08:10:22 UTC.",
    );
  });

  test("a one-line body is returned as it is", () => {
    expect(firstSentence("Invalid MAP_KEY.")).toBe("Invalid MAP_KEY.");
    expect(firstSentence('{"error":{"code":"needs_key","message":"Set the key."}}')).toBe(
      '{"error":{"code":"needs_key","message":"Set the key."}}',
    );
    expect(firstSentence("")).toBe("");
    expect(firstSentence("\n\n  \n")).toBe("");
  });

  test("markup is dropped, and a body that never ends a sentence is cut at three lines and at the limit", () => {
    expect(firstSentence("<html>\n<head><title>403 Forbidden</title></head>\n<body>")).toBe(
      "403 Forbidden",
    );
    expect(firstSentence("one\ntwo\nthree\nfour")).toBe("one two three");
    const long = firstSentence("x".repeat(400));
    expect(long).toHaveLength(160);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("fetchText", () => {
  test("a refusal carries the provider's whole sentence", async () => {
    const ctx = fakeContext({
      now: 0,
      routes: {
        "example.org": {
          status: 403,
          body: "GP data has not updated since your last successful\ndownload of GROUP=active at 2026-03-26 08:10:22 UTC.\nData is updated once every 2 hours.",
        },
      },
    });
    const error = await fetchText(ctx, "https://example.org/data", "CelesTrak").then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).code).toBe("blocked");
    expect((error as SourceError).message).toBe(
      "CelesTrak refused the request (HTTP 403): GP data has not updated since your last successful download of GROUP=active at 2026-03-26 08:10:22 UTC.",
    );
  });
});
