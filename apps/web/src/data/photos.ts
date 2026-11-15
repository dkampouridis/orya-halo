/**
 * Aircraft photos from the Planespotters.net public photo API, for the
 * detail panel.
 *
 * Terms read on 2026-11-14 at https://www.planespotters.net/photo/api, and
 * what each means here:
 *
 * - "Browser clients must request the API from a webpage that sets a valid
 *   Origin or Referer header." The data worker's `fetch` is such a request;
 *   the API answered it with HTTP 200 and `Access-Control-Allow-Origin: *`
 *   (checked from Edge on http://localhost on 2026-11-14; a headless browser
 *   is turned away without CORS headers, which reads here as "no photo").
 *   Nothing goes through the gateway, which the terms would count as
 *   re-offering the API.
 * - "API JSON responses may be cached for up to 24 hours." They are kept in
 *   memory for that long at most, so an open detail panel asks once.
 * - "Image binaries must be fetched straight from the thumbnail URLs we
 *   return, by the same browser that displays them", and "all URLs returned
 *   by the API must be used unchanged." The image URL and the link are passed
 *   on exactly as received; the worker never downloads the image.
 * - "Each photo must credit the photographer in text visible next to the
 *   image, and the thumbnail must lead back to the photo's page [...] a plain
 *   anchor on the thumbnail, without rel="nofollow"." The photographer is in
 *   `credit` and the page in `link`; the detail panel must render both that way.
 */
import type { DetailMedia } from "@orya-halo/schema";

export interface AircraftPhotos {
  /**
   * The latest photo of the aircraft with this ICAO 24-bit address, or null
   * when there is none or the lookup failed. Never rejects.
   */
  lookup(icao: number): Promise<DetailMedia | null>;
  /** The answer already in memory: a photo, null for "none", undefined for "not asked yet". */
  peek(icao: number): DetailMedia | null | undefined;
}

const API = "https://api.planespotters.net/pub/photos/hex/";
const REQUEST_TIMEOUT_MS = 6_000;
/** The longest the terms allow an answer to be reused. */
const FOUND_TTL_MS = 24 * 3_600_000;
/** An aircraft with no photo may get one; a failed lookup is retried sooner, but not at once. */
const NONE_TTL_MS = 3_600_000;
const FAILED_TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 256;

interface Entry {
  media: DetailMedia | null;
  untilMs: number;
}

/** Planespotters' site, and the short domain its image CDN answers on (t.plnspttrs.net). */
const THEIR_HOSTS = /(^|\.)(planespotters\.net|plnspttrs\.net)$/;

function httpsOn(value: unknown, host: RegExp): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && host.test(url.hostname) ? value : null;
  } catch {
    return null;
  }
}

/** The first usable photo in an API answer, in the detail panel's terms. */
export function parsePlanespotters(json: unknown, hex: string): DetailMedia | null {
  const photos = (json as { photos?: unknown } | null)?.photos;
  if (!Array.isArray(photos)) return null;
  for (const photo of photos as Record<string, unknown>[]) {
    if (typeof photo !== "object" || photo === null) continue;
    const large = photo.thumbnail_large as { src?: unknown } | undefined;
    const small = photo.thumbnail as { src?: unknown } | undefined;
    // Only what Planespotters itself hosts: an address from anywhere else is not theirs to hand out.
    const url = httpsOn(large?.src, THEIR_HOSTS) ?? httpsOn(small?.src, THEIR_HOSTS);
    const link = httpsOn(photo.link, THEIR_HOSTS);
    const photographer = typeof photo.photographer === "string" ? photo.photographer.trim() : "";
    // Without all three the terms cannot be met, so the photo is not shown.
    if (url === null || link === null || photographer === "") continue;
    return {
      type: "image",
      url,
      link,
      credit: `Photo © ${photographer}, Planespotters.net`,
      alt: `Photograph of aircraft ${hex}`,
    };
  }
  return null;
}

/** Photo lookup with a small in-memory cache. `fetchFn` is the worker's `fetch`. */
export function createAircraftPhotos(
  fetchFn: typeof fetch,
  now: () => number = Date.now,
): AircraftPhotos {
  const entries = new Map<number, Entry>();
  const inFlight = new Map<number, Promise<DetailMedia | null>>();

  const remember = (icao: number, media: DetailMedia | null, ttlMs: number): void => {
    entries.delete(icao);
    if (entries.size >= MAX_ENTRIES) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
    entries.set(icao, { media, untilMs: now() + ttlMs });
  };

  const peek = (icao: number): DetailMedia | null | undefined => {
    const entry = entries.get(icao);
    if (entry === undefined) return undefined;
    if (entry.untilMs <= now()) {
      entries.delete(icao);
      return undefined;
    }
    return entry.media;
  };

  const request = async (icao: number): Promise<DetailMedia | null> => {
    const hex = icao.toString(16).toUpperCase().padStart(6, "0");
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchFn(`${API}${hex}`, { signal: abort.signal });
      if (!response.ok) {
        remember(icao, null, FAILED_TTL_MS);
        return null;
      }
      const media = parsePlanespotters(await response.json(), hex);
      remember(icao, media, media ? FOUND_TTL_MS : NONE_TTL_MS);
      return media;
    } catch {
      remember(icao, null, FAILED_TTL_MS);
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    peek,
    lookup(icao) {
      // Addresses above 24 bits are not ICAO addresses (TIS-B and other synthetic ids).
      if (!Number.isInteger(icao) || icao <= 0 || icao > 0xffffff) return Promise.resolve(null);
      const known = peek(icao);
      if (known !== undefined) return Promise.resolve(known);
      let pending = inFlight.get(icao);
      if (pending === undefined) {
        pending = request(icao).finally(() => inFlight.delete(icao));
        inFlight.set(icao, pending);
      }
      return pending;
    },
  };
}
