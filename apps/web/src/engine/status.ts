/** Status messages and the pure function that derives the engine's status. */
import type { EngineStatus } from "../core/engine.ts";

export type { EngineStatus };

export const BASEMAP_MISSING_MESSAGE =
  "The base map could not be loaded, so the globe has no coastlines or place names. Live data still works.";
export const BASEMAP_MISSING_HINT =
  "Run `node scripts/fetch-tiles.mjs` in apps/web to download the world extract, or set VITE_PMTILES_URL or VITE_PROTOMAPS_KEY.";
export const BASEMAP_REMOTE_HINT =
  "VITE_PMTILES_URL could not be read (check the address and its CORS settings); only the low-zoom world extract is in use.";
export const CONTEXT_LOST_MESSAGE =
  "The browser paused the globe's graphics. It comes back by itself; reload the page if it stays dark.";

/** The status for a given tile setup and graphics state. Pure. */
export function describeStatus(input: {
  local: boolean;
  deep: "pmtiles" | "api" | null;
  remoteFailed: boolean;
  contextLost: boolean;
}): EngineStatus {
  const basemap = input.deep ? "full" : input.local ? "low-zoom" : "missing";
  const status: EngineStatus = { basemap, graphics: input.contextLost ? "context-lost" : "ok" };
  if (input.contextLost) status.message = CONTEXT_LOST_MESSAGE;
  else if (basemap === "missing") status.message = BASEMAP_MISSING_MESSAGE;
  if (basemap === "missing") status.hint = BASEMAP_MISSING_HINT;
  else if (input.remoteFailed) status.hint = BASEMAP_REMOTE_HINT;
  return status;
}
