/**
 * The base map style: Protomaps' layer set recoloured to the Orya Halo
 * palette (DESIGN.md, "The Earth itself"), stripped of everything that needs
 * a sprite sheet, and lettered in the app's own typeface.
 */
import archivoLatinExt from "@fontsource-variable/archivo/files/archivo-latin-ext-wght-normal.woff2?url";
import archivoLatin from "@fontsource-variable/archivo/files/archivo-latin-wght-normal.woff2?url";
import { layers, namedFlavor } from "@protomaps/basemaps";
import type { Flavor } from "@protomaps/basemaps";
import type { LayerSpecification, StyleSpecification } from "maplibre-gl";

/** Design tokens for the planet. Layer accents live in `@orya-halo/schema`; these are not layer colours. */
export const EARTH = {
  land: "#10151c",
  water: "#070b11",
  /** Ice-white at 20%. */
  border: "rgba(233, 239, 246, 0.2)",
  borderMinor: "rgba(233, 239, 246, 0.1)",
  rim: "#7fb4ff",
} as const;

export const BASEMAP_SOURCE = "protomaps";
/** The style layer the sky and night shading sit directly beneath: the first label layer. */
export const FIRST_LABEL_LAYER = "water_waterway_label";

const FONT = "Archivo";

/**
 * Protomaps' dark flavor pulled towards a cold blue-grey and flattened: land
 * uses differ by a hair, roads only surface when zoomed in, labels stay dim.
 */
function haloFlavor(): Flavor {
  const land = EARTH.land;
  const lift1 = "#121820";
  const lift2 = "#141b24";
  const road = "#1b232e";
  const roadMajor = "#222c39";
  const roadHighway = "#2a3545";
  return {
    ...namedFlavor("dark"),
    background: EARTH.water,
    earth: land,
    water: EARTH.water,
    park_a: lift1,
    park_b: "#111a1c",
    hospital: lift1,
    industrial: lift1,
    school: lift1,
    wood_a: "#10171a",
    wood_b: "#10171a",
    pedestrian: lift1,
    scrub_a: land,
    scrub_b: land,
    glacier: "#151c26",
    sand: lift1,
    beach: lift2,
    aerodrome: lift1,
    runway: roadMajor,
    zoo: lift1,
    military: lift1,
    tunnel_other_casing: land,
    tunnel_minor_casing: land,
    tunnel_link_casing: land,
    tunnel_major_casing: land,
    tunnel_highway_casing: land,
    tunnel_other: "#171d26",
    tunnel_minor: "#171d26",
    tunnel_link: "#171d26",
    tunnel_major: "#1a212b",
    tunnel_highway: "#1e2631",
    pier: lift2,
    buildings: "#0c1016",
    minor_service_casing: land,
    minor_casing: land,
    link_casing: land,
    major_casing_late: land,
    highway_casing_late: land,
    other: road,
    minor_service: road,
    minor_a: road,
    minor_b: road,
    link: roadMajor,
    major_casing_early: land,
    major: roadMajor,
    highway_casing_early: land,
    highway: roadHighway,
    railway: "#0b0f15",
    boundaries: EARTH.border,
    bridges_other_casing: land,
    bridges_minor_casing: land,
    bridges_link_casing: land,
    bridges_major_casing: land,
    bridges_highway_casing: land,
    bridges_other: road,
    bridges_minor: road,
    bridges_link: roadMajor,
    bridges_major: roadMajor,
    bridges_highway: roadHighway,
    roads_label_minor: "#5d6a7b",
    roads_label_minor_halo: land,
    roads_label_major: "#6f7c8e",
    roads_label_major_halo: land,
    ocean_label: "#3f4d61",
    subplace_label: "#5d6a7b",
    subplace_label_halo: land,
    city_label: "#8492a5",
    city_label_halo: "#0b0f15",
    state_label: "#4a5666",
    state_label_halo: land,
    country_label: "#6f7c8e",
    address_label: "#5d6a7b",
    address_label_halo: land,
    regular: FONT,
    bold: FONT,
    italic: FONT,
  };
}

/**
 * Layers left out. `landcover` because it adds colour noise and an extra
 * attribution duty (ESA WorldCover, CC BY 4.0); the rest because they draw
 * sprite icons, and a calm map of the whole planet does not need points of
 * interest or road shields.
 */
const DROPPED = new Set(["landcover", "pois", "roads_shields", "roads_oneway", "address_label"]);

function tune(layer: LayerSpecification): LayerSpecification {
  if (layer.type === "symbol" && layer.layout) {
    const layout: Record<string, unknown> = { ...layer.layout };
    // No sprite sheet is loaded, so icon references would only produce warnings.
    delete layout["icon-image"];
    delete layout["icon-size"];
    // Sentence case everywhere, including on the map.
    delete layout["text-transform"];
    return { ...layer, layout } as LayerSpecification;
  }
  if (layer.id === "boundaries") {
    return {
      ...layer,
      paint: { ...layer.paint, "line-color": EARTH.borderMinor },
    } as LayerSpecification;
  }
  return layer;
}

export interface StyleInput {
  /** Tile URL template understood by a registered protocol. */
  tiles: string;
  maxZoom: number;
  attribution: string;
}

/** The complete MapLibre style for the globe. */
export function buildStyle(input: StyleInput): StyleSpecification {
  const base = layers(BASEMAP_SOURCE, haloFlavor(), { lang: "en" })
    .filter((layer) => !DROPPED.has(layer.id))
    .map(tune);

  return {
    version: 8,
    name: "Orya Halo",
    projection: { type: "globe" },
    // MapLibre's own atmosphere is switched off: the engine draws the rim itself.
    sky: { "atmosphere-blend": 0 },
    // No `glyphs` URL: MapLibre draws label glyphs in the browser from the
    // font files declared here, so there is no glyph server to depend on and
    // the map is set in the same Archivo as the interface. Scripts the files
    // do not cover fall back to the device's own fonts.
    "font-faces": {
      [FONT]: [
        {
          url: archivoLatin,
          "unicode-range": [
            "U+0000-00FF",
            "U+0131",
            "U+0152-0153",
            "U+02BB-02BC",
            "U+02C6",
            "U+02DA",
            "U+02DC",
            "U+2000-206F",
            "U+20AC",
            "U+2122",
            "U+2212",
          ],
        },
        {
          url: archivoLatinExt,
          "unicode-range": [
            "U+0100-02BA",
            "U+02BD-02C5",
            "U+02C7-02CC",
            "U+02CE-02D7",
            "U+02DD-02FF",
            "U+1E00-1E9F",
            "U+1EF2-1EFF",
            "U+2C60-2C7F",
            "U+A720-A7FF",
          ],
        },
      ],
    },
    sources: {
      [BASEMAP_SOURCE]: {
        type: "vector",
        tiles: [input.tiles],
        minzoom: 0,
        maxzoom: input.maxZoom,
        attribution: input.attribution,
      },
    },
    layers: base,
  };
}
