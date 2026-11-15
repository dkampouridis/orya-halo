/**
 * Things the HUD may ask for that live outside the store: search, the
 * attribution list, a link to the current view. The controller provides
 * them once the data worker is up; until then `getServices()` is null and
 * the HUD shows its loading state.
 */
import type { SearchResult, SourceSummary } from "@orya-halo/schema";

export interface HaloServices {
  /** Find objects and places. Resolves to at most a screenful of results, best first. */
  search(query: string): Promise<SearchResult[]>;
  /** Every data source in use, for the attribution page. */
  getAttributions(): Promise<SourceSummary[]>;
  /** Address of the current view (camera, layers, selection), for "Copy link". */
  shareUrl(): string;
}

let services: HaloServices | null = null;
const listeners = new Set<() => void>();

export function provideServices(next: HaloServices | null): void {
  services = next;
  for (const listener of listeners) listener();
}

export function getServices(): HaloServices | null {
  return services;
}

/** For `useSyncExternalStore`: re-render when services become available. */
export function subscribeServices(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
