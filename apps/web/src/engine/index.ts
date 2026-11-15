/**
 * The rendering engine's entry point. Load it with a dynamic `import()` so
 * MapLibre and deck.gl stay out of the app's first chunk.
 */
import type { CreateEngine } from "../core/engine.ts";
import { HaloEngineImpl } from "./halo-engine.ts";

export const createEngine: CreateEngine = (options) => HaloEngineImpl.create(options);
