/**
 * deck.gl layers for Orya Halo. Everything here renders from typed arrays
 * with no per-object JavaScript; time-dependent motion is done in shaders.
 */
export { MoversLayer } from "./movers/movers-layer.ts";
export type { MoverGlyph, MoversLayerProps } from "./movers/movers-layer.ts";
export { MarkersLayer, markersFromBatch, markersFromDensity } from "./markers/markers-layer.ts";
export type { MarkerMode, MarkerSource, MarkersLayerProps } from "./markers/markers-layer.ts";
export { ReticleLayer, createReticle } from "./reticle/reticle-layer.ts";
export type { Reticle, ReticleLayerProps } from "./reticle/reticle-layer.ts";
export { HorizonExtension } from "./horizon-extension.ts";
export {
  DECK_EARTH_RADIUS_M,
  GLOBE_RADIUS,
  farness,
  globeCommon,
  haloVisibility,
  headingProbeDegrees,
  quakeRadiusPx,
  sizeAtZoom,
} from "./maths.ts";
