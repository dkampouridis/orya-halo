/**
 * Every data source plugin in Orya Halo. One folder per feed family; each
 * plugin states its endpoint, refresh rate, licence and attribution.
 * docs/DATA_LICENCES.md is the human-readable version of the same facts.
 */
export * from "./gateway/index.ts";
export * from "./satellites/index.ts";
export * from "./quakes/index.ts";
export * from "./fires/index.ts";
export * from "./radar/index.ts";
export * from "./imagery/index.ts";
export * from "./cables/index.ts";
export * from "./webcams/index.ts";
export * from "./places/index.ts";
export * from "./weather/index.ts";
export { SourceError, isSourceError } from "./shared/space-earth/errors.ts";
