/**
 * Errors and the one HTTP helper shared by the satellite, earthquake and
 * wildfire plugins.
 *
 * Plugins fail with a `SourceError` whose `code` the runner can map to a layer
 * status ("needs-key", "offline", ...) and whose `message` is one plain
 * sentence fit to show as it is.
 */
import type { SourceContext } from "@orya-halo/schema";

export type SourceErrorCode =
  /** The source needs an API key that is missing or was rejected. */
  | "needs-key"
  /** The provider refused the request under its usage policy. Do not retry soon. */
  | "blocked"
  /** Any other unsuccessful HTTP response. */
  | "http"
  /** The response arrived but was not what the provider documents. */
  | "bad-data";

export class SourceError extends Error {
  override name = "SourceError";
  readonly code: SourceErrorCode;
  /** HTTP status, when the failure was an HTTP response. */
  readonly status?: number;

  constructor(code: SourceErrorCode, message: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** True for a `SourceError`, including one that crossed a worker or realm boundary. */
export function isSourceError(error: unknown): error is SourceError {
  return (
    error instanceof SourceError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { name?: unknown }).name === "SourceError")
  );
}

/** First non-empty line of a response body, trimmed and shortened, for error messages. */
export function firstLine(body: string, max = 160): string {
  const line = body.split("\n").find((l) => l.trim().length > 0) ?? "";
  const clean = line
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * The opening sentence of a response body, for error messages. Providers wrap
 * their plain-text errors over lines (CelesTrak's 403 breaks mid-sentence), so
 * lines are joined until one ends a sentence, three at most.
 */
export function firstSentence(body: string, max = 160): string {
  const lines = body
    .split("\n")
    .map((line) =>
      line
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((line) => line.length > 0);
  let text = "";
  for (let i = 0; i < lines.length && i < 3; i++) {
    text = text ? `${text} ${lines[i]}` : lines[i];
    if (/[.!?]$/.test(lines[i])) break;
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * GET `url` and return the body as text. Any status other than 200 becomes a
 * `SourceError`: "blocked" for 403 and 429, "http" otherwise. `provider` is the
 * name used in the message. The URL never appears in a message, because it may
 * carry a key.
 */
export async function fetchText(
  ctx: Pick<SourceContext, "fetch" | "signal">,
  url: string,
  provider: string,
): Promise<string> {
  const response = await ctx.fetch(url, { signal: ctx.signal });
  if (response.status !== 200) {
    let body = "";
    try {
      body = firstSentence(await response.text());
    } catch {
      // The status alone is enough to report.
    }
    const said = body ? `: ${body}` : ".";
    if (response.status === 403 || response.status === 429) {
      throw new SourceError(
        "blocked",
        `${provider} refused the request (HTTP ${response.status})${said}`,
        response.status,
      );
    }
    throw new SourceError(
      "http",
      `${provider} answered HTTP ${response.status}${said}`,
      response.status,
    );
  }
  return response.text();
}
