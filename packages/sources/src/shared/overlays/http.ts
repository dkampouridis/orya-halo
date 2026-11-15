/**
 * HTTP helpers for the overlay, webcam, place and weather sources.
 *
 * Failures surface as the package's one `SourceError`, so the runner maps
 * every plugin's errors to a layer status the same way.
 */
import type { SourceContext } from "@orya-halo/schema";
import { SourceError, firstLine } from "../space-earth/errors.ts";

export { SourceError };

type FetchContext = Pick<SourceContext, "fetch" | "signal">;

export interface RequestOptions {
  headers?: Record<string, string>;
  /** Treat 401 and 403 as a missing or rejected key rather than a block. */
  keyed?: boolean;
}

/**
 * GET `url` and return the response when it is a 200. `provider` names the
 * service in error messages; the URL never appears there because it may carry
 * a key.
 */
export async function fetchOk(
  ctx: FetchContext,
  url: string,
  provider: string,
  options: RequestOptions = {},
): Promise<Response> {
  const response = await ctx.fetch(url, { signal: ctx.signal, headers: options.headers });
  if (response.status === 200) return response;

  let body = "";
  try {
    body = firstLine(await response.text());
  } catch {
    // The status alone is enough to report.
  }
  const said = body ? `: ${body}` : ".";
  const { status } = response;
  if (options.keyed && (status === 401 || status === 403)) {
    throw new SourceError(
      "needs-key",
      `${provider} rejected the API key (HTTP ${status})${said}`,
      status,
    );
  }
  if (status === 403 || status === 429) {
    throw new SourceError(
      "blocked",
      `${provider} refused the request (HTTP ${status})${said}`,
      status,
    );
  }
  throw new SourceError("http", `${provider} answered HTTP ${status}${said}`, status);
}

/** GET `url` and parse the body as JSON. Unparseable bodies are "bad-data". */
export async function fetchJson<T>(
  ctx: FetchContext,
  url: string,
  provider: string,
  options: RequestOptions = {},
): Promise<T> {
  const response = await fetchOk(ctx, url, provider, options);
  try {
    return (await response.json()) as T;
  } catch {
    throw new SourceError("bad-data", `${provider} sent a response that is not valid JSON.`);
  }
}

/** GET `url` and return the body as text. */
export async function fetchBody(
  ctx: FetchContext,
  url: string,
  provider: string,
  options: RequestOptions = {},
): Promise<string> {
  return (await fetchOk(ctx, url, provider, options)).text();
}

/** GET `url` and return the body as bytes. */
export async function fetchBytes(
  ctx: FetchContext,
  url: string,
  provider: string,
): Promise<ArrayBuffer> {
  return (await fetchOk(ctx, url, provider)).arrayBuffer();
}

/** Join the app's asset base and a relative path with exactly one slash. */
export function assetUrl(assetBase: string, path: string): string {
  return `${assetBase.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
