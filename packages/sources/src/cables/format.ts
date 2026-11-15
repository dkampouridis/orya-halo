/**
 * The baked undersea cable asset (`data/cables.bin`).
 *
 * Layout, little-endian:
 *
 * | Offset | Size | Field |
 * |---|---|---|
 * | 0 | 4 | Magic, ASCII `OHCB` |
 * | 4 | 2 | `u16` format version, currently 1 |
 * | 6 | 2 | `u16` reserved, 0 |
 * | 8 | 4 | `u32` header length `H` in bytes |
 * | 12 | H | UTF-8 JSON, a `CableAssetHeader` |
 * | 12 + H | rest | Geometry stream |
 *
 * Geometry stream: for each cable in header order, for each of its `p`
 * paths, an unsigned LEB128 vertex count followed by that many
 * `(Δlon, Δlat)` pairs as zigzag LEB128 integers in units of `1 / scale`
 * degrees. Deltas run on through the whole stream: the first vertex of the
 * file is relative to (0, 0) and every later vertex, including the first of
 * a new path, is relative to the vertex before it.
 *
 * One file and no JSON geometry keeps the asset small: positions cost two to
 * three bytes per coordinate before compression.
 */
import { hashId } from "@orya-halo/schema";
import type { PathSet } from "@orya-halo/schema";
import type { LonLat } from "./geometry.ts";

export const CABLE_MAGIC = "OHCB";
export const CABLE_FORMAT_VERSION = 1;
/** Coordinates are stored as integers of 1/10,000 degree, about 11 m. */
export const CABLE_SCALE = 10_000;

/** One cable in the asset header. Keys are short because there are hundreds. */
export interface CableRecord {
  /** Name. Empty when OpenStreetMap has none. */
  n: string;
  /** Operator or owner, when tagged. */
  o?: string;
  /** Length in kilometres of everything mapped for this cable. */
  km: number;
  /** A representative OpenStreetMap way id, for the link back. */
  w: number;
  /** Wikidata item id, when tagged. */
  wd?: string;
  /** Number of paths this cable has in the geometry stream. */
  p: number;
}

export interface CableAssetHeader {
  /** ISO date the asset was built. */
  generated: string;
  /** Time of the OpenStreetMap snapshot the Overpass server answered from. */
  osmBase: string;
  licence: string;
  attribution: string;
  /** Integer units per degree in the geometry stream. */
  scale: number;
  /** Simplification tolerance used, metres. */
  toleranceM: number;
  cables: CableRecord[];
}

/** A cable ready to be written: its record plus geometry. */
export interface CableGeometry {
  record: Omit<CableRecord, "p">;
  paths: LonLat[][];
}

/**
 * Stable numeric id of a cable: a hash of its name, or of its representative
 * way when it has none. Stable across rebuilds as long as OpenStreetMap keeps
 * the name (or the way).
 */
export function cableId(name: string, way: number): number {
  return hashId(name ? `osm-cable:${name}` : `osm-way:${way}`);
}

function zigzag(n: number): number {
  return n < 0 ? -2 * n - 1 : 2 * n;
}

function unzigzag(n: number): number {
  return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
}

function pushVarint(out: number[], value: number): void {
  let v = value;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
}

/** Serialise cables to the asset layout. */
export function encodeCables(
  cables: readonly CableGeometry[],
  info: Pick<CableAssetHeader, "generated" | "osmBase" | "licence" | "attribution" | "toleranceM">,
): Uint8Array {
  const header: CableAssetHeader = {
    ...info,
    scale: CABLE_SCALE,
    cables: cables.map((c) => ({ ...c.record, p: c.paths.length })),
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));

  const stream: number[] = [];
  let prevLon = 0;
  let prevLat = 0;
  for (const cable of cables) {
    for (const path of cable.paths) {
      pushVarint(stream, path.length);
      for (const [lon, lat] of path) {
        const qLon = Math.round(lon * CABLE_SCALE);
        const qLat = Math.round(lat * CABLE_SCALE);
        pushVarint(stream, zigzag(qLon - prevLon));
        pushVarint(stream, zigzag(qLat - prevLat));
        prevLon = qLon;
        prevLat = qLat;
      }
    }
  }

  const out = new Uint8Array(12 + headerBytes.length + stream.length);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = CABLE_MAGIC.charCodeAt(i);
  view.setUint16(4, CABLE_FORMAT_VERSION, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, headerBytes.length, true);
  out.set(headerBytes, 12);
  out.set(stream, 12 + headerBytes.length);
  return out;
}

export interface DecodedCables {
  header: CableAssetHeader;
  paths: PathSet;
}

/** Label for a cable OpenStreetMap has no name for. */
export const UNNAMED_CABLE = "Unnamed cable";

/**
 * Parse the asset into a `PathSet`. A cable with several paths (branches, or
 * pieces either side of the antimeridian) appears as several entries that
 * share one id, name and meta object.
 *
 * Throws a plain `Error` when the bytes are not a cable asset.
 */
export function decodeCables(buffer: ArrayBuffer | Uint8Array): DecodedCables {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (
    bytes.length < 12 ||
    String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== CABLE_MAGIC
  ) {
    throw new Error("Not a cable asset: wrong magic bytes.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  if (version !== CABLE_FORMAT_VERSION) {
    throw new Error(
      `Cable asset version ${version} is not supported (expected ${CABLE_FORMAT_VERSION}).`,
    );
  }
  const headerLength = view.getUint32(8, true);
  if (12 + headerLength > bytes.length) throw new Error("Cable asset is truncated.");
  const header = JSON.parse(
    new TextDecoder().decode(bytes.subarray(12, 12 + headerLength)),
  ) as CableAssetHeader;
  const scale = header.scale > 0 ? header.scale : CABLE_SCALE;

  let offset = 12 + headerLength;
  const readVarint = (): number => {
    let value = 0;
    let factor = 1;
    for (;;) {
      if (offset >= bytes.length) throw new Error("Cable asset is truncated.");
      const byte = bytes[offset++];
      value += (byte & 0x7f) * factor;
      if (byte < 0x80) return value;
      factor *= 0x80;
    }
  };

  const count = header.cables.reduce((sum, c) => sum + c.p, 0);
  const ids = new Uint32Array(count);
  const startIndices = new Uint32Array(count + 1);
  const names: string[] = [];
  const meta: PathSet["meta"] = [];
  // Every coordinate takes at least one byte, so the remaining byte count bounds the float count.
  let positions = new Float32Array(Math.max(16, bytes.length - offset));
  let vertices = 0;
  let lon = 0;
  let lat = 0;
  let path = 0;

  for (const record of header.cables) {
    const id = cableId(record.n, record.w);
    const name = record.n || UNNAMED_CABLE;
    const facts: Record<string, string | number | boolean | null> = {
      label: name,
      operator: record.o ?? null,
      lengthKm: record.km,
      osmWay: record.w,
      wikidata: record.wd ?? null,
      named: record.n !== "",
    };
    for (let p = 0; p < record.p; p++) {
      const n = readVarint();
      ids[path] = id;
      startIndices[path] = vertices;
      names.push(name);
      meta.push(facts);
      if ((vertices + n) * 2 > positions.length) {
        const grown = new Float32Array(Math.max(positions.length * 2, (vertices + n) * 2));
        grown.set(positions);
        positions = grown;
      }
      for (let v = 0; v < n; v++) {
        lon += unzigzag(readVarint());
        lat += unzigzag(readVarint());
        positions[vertices * 2] = lon / scale;
        positions[vertices * 2 + 1] = lat / scale;
        vertices++;
      }
      path++;
    }
  }
  startIndices[count] = vertices;

  return {
    header,
    paths: { count, ids, startIndices, positions: positions.slice(0, vertices * 2), names, meta },
  };
}
