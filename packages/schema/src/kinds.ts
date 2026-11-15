/**
 * Entity kinds and layer registry. One source of truth for ids, names and
 * signature colours, shared by the gateway protocol, the workers, the GPU
 * layers and the HUD.
 */

/** Numeric kind of a point entity. Values are part of the wire protocol. */
export const EntityKind = {
  Aircraft: 1,
  Ship: 2,
  Satellite: 3,
  Quake: 4,
  Webcam: 5,
  Fire: 6,
  /** Undersea cable. A namespace for selection only: cables are paths and never appear in entity batches or on the wire. */
  Cable: 7,
} as const;
export type EntityKind = (typeof EntityKind)[keyof typeof EntityKind];

/** Kinds that travel as point entities (everything except cables). */
export const ENTITY_KINDS: readonly EntityKind[] = [1, 2, 3, 4, 5, 6];

export type LayerId =
  | "aircraft"
  | "ships"
  | "satellites"
  | "quakes"
  | "cables"
  | "radar"
  | "imagery"
  | "fires"
  | "webcams"
  | "nightlights";

/** How a layer's data reaches the renderer. */
export type LayerDataShape = "entities" | "paths" | "tiles" | "computed";

export interface LayerDef {
  readonly id: LayerId;
  /** Sentence-case name shown in the dock. */
  readonly label: string;
  /** Singular noun for one object, used in counts and search ("1 ship"). */
  readonly noun: string;
  readonly shape: LayerDataShape;
  /** Kind used in `EntityRef`s for this layer's objects. */
  readonly kind?: EntityKind;
  /** Signature colour, sRGB hex. The only place a layer's colour is defined. */
  readonly accent: string;
  /** On at first launch. */
  readonly defaultOn: boolean;
  /** Keyboard shortcut digit in the dock. */
  readonly hotkey: string;
  /** True when live data comes through the realtime gateway. */
  readonly viaGateway: boolean;
}

export const LAYERS: readonly LayerDef[] = [
  {
    id: "aircraft",
    label: "Aircraft",
    noun: "aircraft",
    shape: "entities",
    kind: EntityKind.Aircraft,
    accent: "#4fe3ff",
    defaultOn: true,
    hotkey: "1",
    viaGateway: true,
  },
  {
    id: "ships",
    label: "Ships",
    noun: "ship",
    shape: "entities",
    kind: EntityKind.Ship,
    accent: "#ffb224",
    defaultOn: true,
    hotkey: "2",
    viaGateway: true,
  },
  {
    id: "satellites",
    label: "Satellites",
    noun: "satellite",
    shape: "entities",
    kind: EntityKind.Satellite,
    accent: "#b08cff",
    defaultOn: true,
    hotkey: "3",
    viaGateway: false,
  },
  {
    id: "quakes",
    label: "Earthquakes",
    noun: "earthquake",
    shape: "entities",
    kind: EntityKind.Quake,
    accent: "#ff5247",
    defaultOn: true,
    hotkey: "4",
    viaGateway: false,
  },
  {
    id: "cables",
    label: "Undersea cables",
    noun: "cable",
    shape: "paths",
    kind: EntityKind.Cable,
    accent: "#1fbfa3",
    defaultOn: true,
    hotkey: "5",
    viaGateway: false,
  },
  {
    id: "radar",
    label: "Rain radar",
    noun: "radar frame",
    shape: "tiles",
    accent: "#6fa8ff",
    defaultOn: false,
    hotkey: "6",
    viaGateway: false,
  },
  {
    id: "imagery",
    label: "Satellite imagery",
    noun: "image",
    shape: "tiles",
    accent: "#9fb6c9",
    defaultOn: false,
    hotkey: "7",
    viaGateway: false,
  },
  {
    id: "fires",
    label: "Wildfires",
    noun: "fire",
    shape: "entities",
    kind: EntityKind.Fire,
    accent: "#ff7a2b",
    defaultOn: false,
    hotkey: "8",
    viaGateway: false,
  },
  {
    id: "webcams",
    label: "Webcams",
    noun: "webcam",
    shape: "entities",
    kind: EntityKind.Webcam,
    accent: "#ffffff",
    defaultOn: false,
    hotkey: "9",
    viaGateway: false,
  },
  {
    id: "nightlights",
    label: "Day and night",
    noun: "terminator",
    shape: "computed",
    accent: "#ffd9a0",
    defaultOn: true,
    hotkey: "0",
    viaGateway: false,
  },
];

export const LAYER_IDS: readonly LayerId[] = LAYERS.map((l) => l.id);

const BY_ID = new Map<LayerId, LayerDef>(LAYERS.map((l) => [l.id, l]));
const BY_KIND = new Map<EntityKind, LayerDef>(
  LAYERS.filter((l) => l.kind !== undefined).map((l) => [l.kind as EntityKind, l]),
);

export function layerDef(id: LayerId): LayerDef {
  const def = BY_ID.get(id);
  if (!def) throw new Error(`Unknown layer: ${id}`);
  return def;
}

export function layerForKind(kind: EntityKind): LayerDef {
  const def = BY_KIND.get(kind);
  if (!def) throw new Error(`No layer for entity kind ${kind}`);
  return def;
}

/** `#rrggbb` to `[r, g, b]` in 0..255, for GPU colour uniforms. */
export function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Per-kind category codes carried in the `category` column. */
export const AircraftCategory = {
  Unknown: 0,
  Light: 1,
  Medium: 2,
  Large: 3,
  Heavy: 4,
  HighPerformance: 5,
  Rotorcraft: 6,
  Glider: 7,
  Uav: 8,
  Surface: 9,
} as const;

export const ShipCategory = {
  Unknown: 0,
  Cargo: 1,
  Tanker: 2,
  Passenger: 3,
  Fishing: 4,
  Service: 5,
  HighSpeed: 6,
  Pleasure: 7,
  Military: 8,
  Other: 9,
} as const;

export const SatelliteCategory = {
  Other: 0,
  Station: 1,
  Constellation: 2,
  Navigation: 3,
  EarthObservation: 4,
  Science: 5,
  Geostationary: 6,
  Debris: 7,
} as const;

/** Bit flags carried in the `flags` column, shared by all kinds. */
export const EntityFlag = {
  /** On the ground, moored or otherwise not under way. */
  Stationary: 1 << 0,
  /** Emergency squawk or distress status. */
  Emergency: 1 << 1,
  Military: 1 << 2,
  /** Position is older than the layer's freshness window. */
  Stale: 1 << 3,
} as const;
