/**
 * A fake `SourceContext` for tests: answers requests from a table instead of
 * the network and records what was asked. Imported by test files only.
 */
import { readFileSync } from "node:fs";
import type { SourceContext } from "@orya-halo/schema";

export interface Recorded {
  url: string;
  headers: Record<string, string>;
}

export interface FakeContext extends SourceContext {
  /** Every request made through `fetch`, in order. */
  requests: Recorded[];
}

/** A canned answer: a body (text, bytes or JSON-able object), or a full `Response`. */
export type Answer = string | Uint8Array | Response | { status: number; body?: string } | object;

function toResponse(answer: Answer): Response {
  if (answer instanceof Response) return answer;
  if (typeof answer === "string") return new Response(answer, { status: 200 });
  if (answer instanceof Uint8Array)
    return new Response(answer as Uint8Array<ArrayBuffer>, { status: 200 });
  if ("status" in answer && typeof answer.status === "number") {
    return new Response((answer as { body?: string }).body ?? "", { status: answer.status });
  }
  return new Response(JSON.stringify(answer), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Build a context. `routes` maps a URL prefix to its answer; the longest
 * matching prefix wins and an unmatched URL answers 404.
 */
export function fakeContext(
  routes: Record<string, Answer | (() => Answer)>,
  options: Partial<Pick<SourceContext, "key" | "view" | "assetBase">> & { nowMs?: number } = {},
): FakeContext {
  const requests: Recorded[] = [];
  const controller = new AbortController();
  const prefixes = Object.keys(routes).sort((a, b) => b.length - a.length);
  const fetchFake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    requests.push({ url, headers });
    const prefix = prefixes.find((p) => url.startsWith(p));
    if (prefix === undefined) return new Response("Not found", { status: 404 });
    const route = routes[prefix];
    return toResponse(typeof route === "function" ? (route as () => Answer)() : route);
  }) as typeof fetch;

  return {
    fetch: fetchFake,
    now: () => options.nowMs ?? Date.UTC(2026, 10, 14, 15, 17, 0),
    signal: controller.signal,
    assetBase: options.assetBase ?? "https://halo.example/",
    key: options.key,
    view: options.view,
    requests,
  };
}

/** Read a fixture that sits next to a test: `fixture(import.meta.url, "fixtures/x.json")`. */
export function fixture(testUrl: string, path: string): string {
  return readFileSync(new URL(path, testUrl), "utf8");
}

/** Read a binary fixture or asset by URL-relative path. */
export function fixtureBytes(testUrl: string, path: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(path, testUrl)));
}
