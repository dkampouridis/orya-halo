/**
 * Night-lights tile templates from NASA GIBS, for the renderer's night side.
 * Not a plugin: the imagery is a fixed composite, so there is nothing to poll.
 *
 * Verified 2026-11-14 in the Web-Mercator capabilities document; a sample
 * tile of each answered 200 with `Access-Control-Allow-Origin: *`.
 * Credit and licence are the same as every GIBS layer (`GIBS_ATTRIBUTION`).
 */
import { gibsTileUrl } from "../shared/overlays/gibs.ts";
import type { GibsLayer } from "../shared/overlays/gibs.ts";

/**
 * Black Marble 2016: the cloud-free annual composite of VIIRS night lights
 * on a dark base map. 256 px PNG, zoom 0 to 8. Composites exist for 2012 and
 * 2016 only.
 */
export const BLACK_MARBLE_LAYER: GibsLayer = {
  id: "VIIRS_Black_Marble",
  matrixSet: "GoogleMapsCompatible_Level8",
  maxZoom: 8,
  format: "png",
};

/** `{z}/{y}/{x}` template for the 2016 Black Marble composite. */
export const BLACK_MARBLE_TILES = gibsTileUrl(BLACK_MARBLE_LAYER, "2016-01-01");

/**
 * The older "Earth at Night 2012" composite as JPEG: 19 KB against 88 KB for
 * the same Black Marble tile (z3). It has no time dimension, so the path
 * carries no date.
 */
export const CITY_LIGHTS_2012_TILES =
  "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_CityLights_2012/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg";
