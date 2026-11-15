/**
 * Halo wire protocol, version 1. Full specification: docs/PROTOCOL.md.
 *
 * Server to client: little-endian binary frames. Data frames are columnar
 * (one array per field) so a client can view them as typed arrays with no
 * per-record parsing, and so permessage-deflate compresses them well.
 * Only entities that changed since the client's last frame are sent.
 *
 * Client to server: small JSON text messages (subscriptions are rare).
 *
 * The Rust gateway implements the same layout in apps/gateway/src/protocol.rs;
 * both sides are tested against the golden files in packages/schema/fixtures.
 */
import type { EntityColumns, EntityMeta, EntityUpdate } from "./entity.ts";
import { createColumns } from "./entity.ts";
import type { EntityKind } from "./kinds.ts";

export const PROTOCOL_VERSION = 1;
export const FRAME_MAGIC = 0x48; // "H"
export const HEADER_BYTES = 24;

export const FrameType = {
  /** Positions and motion for new or changed entities. */
  Upsert: 1,
  /** Entities that left the subscription or expired. */
  Remove: 2,
  /** Static facts (callsign, name, type), sent once per entity. */
  Meta: 3,
  /** Per-cell counts for low-zoom density rendering. */
  Density: 4,
  /** Global totals and upstream health for each kind. */
  Stats: 5,
  /** Ticker events, UTF-8 JSON. */
  Events: 6,
} as const;
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

/** Header flag: an Upsert that is the complete set for the subscription. */
export const FRAME_FLAG_FULL = 1;
/**
 * Header flag: the body (everything after the 24-byte header) is raw DEFLATE
 * (RFC 1951). Only sent to clients that connect with `?z=1`. Inflate with
 * `inflateFrame` before `decodeFrame`.
 */
export const FRAME_FLAG_DEFLATE = 2;

/** Bytes per entity in an Upsert frame. */
export const UPSERT_RECORD_BYTES = 22;
export const DENSITY_RECORD_BYTES = 20;
export const STATS_RECORD_BYTES = 8;

/**
 * Fixed-point scales used by Upsert columns. `age` saturates: 255 means
 * "at least 255 s old" (ships can be minutes old); such entities also carry
 * the Stale flag, and the detail endpoint has the exact fix time.
 */
export const LONLAT_SCALE = 1e7; // i32 degrees * 1e7
export const ALT_UNIT_M = 7.62; // i16 units of 25 ft
export const HEADING_SCALE = 100; // u16 degrees * 100
export const HEADING_UNKNOWN = 0xffff;
export const SPEED_UNIT_MPS = 0.1; // u16 units of 0.1 m/s
export const VRATE_UNIT_MPS = 0.5; // i8 units of 0.5 m/s
export const AGE_SATURATED_S = 255;

/** Keys of the type-length-value fields in a Meta frame. */
export const MetaKey = {
  label: 1,
  registration: 2,
  typeCode: 3,
  typeName: 4,
  operator: 5,
  origin: 6,
  destination: 7,
  country: 8,
  squawk: 9,
  imo: 10,
  callsign: 11,
  lengthM: 12,
  widthM: 13,
  draughtM: 14,
  navStatus: 15,
  eta: 16,
  source: 17,
} as const;
export type MetaKeyName = keyof typeof MetaKey;

const META_NAME_BY_KEY = new Map<number, MetaKeyName>(
  (Object.keys(MetaKey) as MetaKeyName[]).map((name) => [MetaKey[name], name]),
);

/** Upstream health reported in Stats frames. */
export const UpstreamStatus = {
  Off: 0,
  Ok: 1,
  Degraded: 2,
  NeedsKey: 3,
  Down: 4,
} as const;
export type UpstreamStatus = (typeof UpstreamStatus)[keyof typeof UpstreamStatus];

export interface FrameHeader {
  type: FrameType;
  kind: EntityKind | 0;
  flags: number;
  /** Server clock when the frame was built, Unix epoch milliseconds. */
  timeMs: number;
  count: number;
  /** Frame-specific: H3 resolution for Density frames, otherwise 0. */
  aux: number;
}

/** Decoded Upsert, still in wire units. Arrays may be views on the message buffer. */
export interface UpsertFrame extends FrameHeader {
  type: typeof FrameType.Upsert;
  kind: EntityKind;
  full: boolean;
  ids: Uint32Array;
  lonE7: Int32Array;
  latE7: Int32Array;
  alt: Int16Array;
  heading: Uint16Array;
  speed: Uint16Array;
  vrate: Int8Array;
  age: Uint8Array;
  category: Uint8Array;
  entityFlags: Uint8Array;
}

export interface RemoveFrame extends FrameHeader {
  type: typeof FrameType.Remove;
  kind: EntityKind;
  ids: Uint32Array;
}

export interface MetaRecord {
  id: number;
  fields: Partial<Record<MetaKeyName, string>>;
}

export interface MetaFrame extends FrameHeader {
  type: typeof FrameType.Meta;
  kind: EntityKind;
  records: MetaRecord[];
}

export interface DensityFrame extends FrameHeader {
  type: typeof FrameType.Density;
  kind: EntityKind;
  /** H3 resolution of the cells. */
  res: number;
  /** Low and high 32 bits of each H3 cell index. */
  cellLo: Uint32Array;
  cellHi: Uint32Array;
  /** Cell centre, degrees. */
  lon: Float32Array;
  lat: Float32Array;
  counts: Uint32Array;
}

export interface StatsEntry {
  kind: EntityKind;
  status: UpstreamStatus;
  /** Entities of this kind the gateway is tracking worldwide. */
  total: number;
}

export interface StatsFrame extends FrameHeader {
  type: typeof FrameType.Stats;
  entries: StatsEntry[];
}

/** One line in the live ticker. */
export interface HaloEvent {
  /** Stable id, so repeated reports of the same event collapse. */
  id: string;
  /** What kind of thing happened, e.g. "quake", "emergency", "launch". */
  topic: string;
  timeMs: number;
  /** One plain sentence, ready to show. */
  title: string;
  detail?: string;
  lon?: number;
  lat?: number;
  /** Entity to select when the event is clicked. */
  ref?: { kind: EntityKind; id: number };
  /** 0 routine, 1 notable, 2 major. */
  severity?: 0 | 1 | 2;
}

export interface EventsFrame extends FrameHeader {
  type: typeof FrameType.Events;
  events: HaloEvent[];
}

export type Frame = UpsertFrame | RemoveFrame | MetaFrame | DensityFrame | StatsFrame | EventsFrame;

/** Layers the gateway serves. */
export type GatewayLayer = "aircraft" | "ships";

/** H3 resolutions a client may subscribe at. 0 means the whole world. */
export type SubscriptionRes = 0 | 1 | 2 | 3;

/** Client to server messages (JSON text frames). */
export type ClientMessage =
  | {
      t: "sub";
      /** Layers wanted. Omitted layers are unsubscribed. */
      layers: GatewayLayer[];
      /** 0 subscribes to the whole world and ignores `cells`. */
      res: SubscriptionRes;
      /** H3 cell indexes at `res`, hex strings. Replaces the previous set. */
      cells: string[];
      /** Send individual entities. */
      points: boolean;
      /** Send per-cell Density frames. */
      density: boolean;
    }
  | { t: "ping"; id: number };

/** Server to client control messages (JSON text frames). */
export type ServerMessage =
  | {
      t: "hello";
      v: number;
      /** Milliseconds between delta ticks. */
      tickMs: number;
      /** Largest `cells` array accepted in one subscription. */
      maxCells: number;
      /** H3 resolution of Density frames. */
      densityRes: number;
      layers: Record<GatewayLayer, { status: UpstreamStatus; attribution: string }>;
    }
  | { t: "pong"; id: number }
  | { t: "error"; code: string; message: string };

const HOST_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export class ProtocolError extends Error {
  override name = "ProtocolError";
}

function writeHeader(view: DataView, h: FrameHeader): void {
  view.setUint8(0, FRAME_MAGIC);
  view.setUint8(1, PROTOCOL_VERSION);
  view.setUint8(2, h.type);
  view.setUint8(3, h.kind);
  view.setUint16(4, h.flags, true);
  view.setUint16(6, 0, true);
  view.setFloat64(8, h.timeMs, true);
  view.setUint32(16, h.count, true);
  view.setUint32(20, h.aux, true);
}

export function readHeader(buffer: ArrayBuffer): FrameHeader {
  if (buffer.byteLength < HEADER_BYTES) throw new ProtocolError("Frame shorter than its header");
  const view = new DataView(buffer);
  if (view.getUint8(0) !== FRAME_MAGIC) throw new ProtocolError("Bad frame magic");
  const version = view.getUint8(1);
  if (version !== PROTOCOL_VERSION)
    throw new ProtocolError(`Unsupported protocol version ${version}`);
  return {
    type: view.getUint8(2) as FrameType,
    kind: view.getUint8(3) as EntityKind | 0,
    flags: view.getUint16(4, true),
    timeMs: view.getFloat64(8, true),
    count: view.getUint32(16, true),
    aux: view.getUint32(20, true),
  };
}

/**
 * Typed-array view on a little-endian column. Zero-copy on little-endian
 * hosts (every browser platform in practice); byte-swapped copy otherwise.
 */
type ColumnCtor<T> = {
  new (buffer: ArrayBuffer, byteOffset: number, length: number): T;
  BYTES_PER_ELEMENT: number;
};

function column<T extends ArrayBufferView>(
  Ctor: ColumnCtor<T>,
  buffer: ArrayBuffer,
  offset: number,
  count: number,
): T {
  const size = Ctor.BYTES_PER_ELEMENT;
  if (offset + count * size > buffer.byteLength) throw new ProtocolError("Frame truncated");
  if (HOST_LITTLE_ENDIAN || size === 1) return new Ctor(buffer, offset, count);
  const copy = buffer.slice(offset, offset + count * size);
  const bytes = new Uint8Array(copy);
  for (let i = 0; i < bytes.length; i += size) bytes.subarray(i, i + size).reverse();
  return new Ctor(copy, 0, count);
}

export interface UpsertInput {
  kind: EntityKind;
  timeMs: number;
  full: boolean;
  count: number;
  ids: ArrayLike<number>;
  lonE7: ArrayLike<number>;
  latE7: ArrayLike<number>;
  alt: ArrayLike<number>;
  heading: ArrayLike<number>;
  speed: ArrayLike<number>;
  vrate: ArrayLike<number>;
  age: ArrayLike<number>;
  category: ArrayLike<number>;
  entityFlags: ArrayLike<number>;
}

export function encodeUpsert(input: UpsertInput): ArrayBuffer {
  const n = input.count;
  const buffer = new ArrayBuffer(HEADER_BYTES + n * UPSERT_RECORD_BYTES);
  const view = new DataView(buffer);
  writeHeader(view, {
    type: FrameType.Upsert,
    kind: input.kind,
    flags: input.full ? FRAME_FLAG_FULL : 0,
    timeMs: input.timeMs,
    count: n,
    aux: 0,
  });
  let o = HEADER_BYTES;
  for (let i = 0; i < n; i++) view.setUint32(o + i * 4, input.ids[i], true);
  o += n * 4;
  for (let i = 0; i < n; i++) view.setInt32(o + i * 4, input.lonE7[i], true);
  o += n * 4;
  for (let i = 0; i < n; i++) view.setInt32(o + i * 4, input.latE7[i], true);
  o += n * 4;
  for (let i = 0; i < n; i++) view.setInt16(o + i * 2, input.alt[i], true);
  o += n * 2;
  for (let i = 0; i < n; i++) view.setUint16(o + i * 2, input.heading[i], true);
  o += n * 2;
  for (let i = 0; i < n; i++) view.setUint16(o + i * 2, input.speed[i], true);
  o += n * 2;
  for (let i = 0; i < n; i++) view.setInt8(o + i, input.vrate[i]);
  o += n;
  for (let i = 0; i < n; i++) view.setUint8(o + i, input.age[i]);
  o += n;
  for (let i = 0; i < n; i++) view.setUint8(o + i, input.category[i]);
  o += n;
  for (let i = 0; i < n; i++) view.setUint8(o + i, input.entityFlags[i]);
  return buffer;
}

export function encodeRemove(
  kind: EntityKind,
  timeMs: number,
  ids: ArrayLike<number>,
): ArrayBuffer {
  const n = ids.length;
  const buffer = new ArrayBuffer(HEADER_BYTES + n * 4);
  const view = new DataView(buffer);
  writeHeader(view, { type: FrameType.Remove, kind, flags: 0, timeMs, count: n, aux: 0 });
  for (let i = 0; i < n; i++) view.setUint32(HEADER_BYTES + i * 4, ids[i], true);
  return buffer;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** Longest field value in bytes; longer strings are cut at a character boundary. */
export const META_MAX_FIELD_BYTES = 255;

function truncateUtf8(text: string): Uint8Array {
  let bytes = utf8Encoder.encode(text);
  if (bytes.length <= META_MAX_FIELD_BYTES) return bytes;
  let end = META_MAX_FIELD_BYTES;
  // Step back over continuation bytes so a multi-byte character is not split.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  bytes = bytes.subarray(0, end);
  return bytes;
}

export function encodeMeta(kind: EntityKind, timeMs: number, records: MetaRecord[]): ArrayBuffer {
  const parts: { id: number; fields: [number, Uint8Array][] }[] = [];
  let size = HEADER_BYTES;
  for (const record of records) {
    const fields: [number, Uint8Array][] = [];
    // Emit in key order so the bytes are deterministic across implementations.
    const names = (Object.keys(record.fields) as MetaKeyName[])
      .filter((name) => MetaKey[name] !== undefined && record.fields[name] !== undefined)
      .sort((a, b) => MetaKey[a] - MetaKey[b]);
    for (const name of names) {
      const bytes = truncateUtf8(record.fields[name] as string);
      fields.push([MetaKey[name], bytes]);
      size += 2 + bytes.length;
    }
    size += 5;
    parts.push({ id: record.id, fields });
  }
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  const out = new Uint8Array(buffer);
  writeHeader(view, {
    type: FrameType.Meta,
    kind,
    flags: 0,
    timeMs,
    count: records.length,
    aux: 0,
  });
  let o = HEADER_BYTES;
  for (const part of parts) {
    view.setUint32(o, part.id, true);
    view.setUint8(o + 4, part.fields.length);
    o += 5;
    for (const [key, bytes] of part.fields) {
      view.setUint8(o, key);
      view.setUint8(o + 1, bytes.length);
      out.set(bytes, o + 2);
      o += 2 + bytes.length;
    }
  }
  return buffer;
}

export interface DensityInput {
  kind: EntityKind;
  timeMs: number;
  res: number;
  cellLo: ArrayLike<number>;
  cellHi: ArrayLike<number>;
  lon: ArrayLike<number>;
  lat: ArrayLike<number>;
  counts: ArrayLike<number>;
}

export function encodeDensity(input: DensityInput): ArrayBuffer {
  const n = input.counts.length;
  const buffer = new ArrayBuffer(HEADER_BYTES + n * DENSITY_RECORD_BYTES);
  const view = new DataView(buffer);
  writeHeader(view, {
    type: FrameType.Density,
    kind: input.kind,
    flags: 0,
    timeMs: input.timeMs,
    count: n,
    aux: input.res,
  });
  let o = HEADER_BYTES;
  for (let i = 0; i < n; i++) view.setUint32(o + i * 4, input.cellLo[i], true);
  o += n * 4;
  for (let i = 0; i < n; i++) view.setUint32(o + i * 4, input.cellHi[i], true);
  o += n * 4;
  for (let i = 0; i < n; i++) view.setFloat32(o + i * 4, input.lon[i], true);
  o += n * 4;
  for (let i = 0; i < n; i++) view.setFloat32(o + i * 4, input.lat[i], true);
  o += n * 4;
  for (let i = 0; i < n; i++) view.setUint32(o + i * 4, input.counts[i], true);
  return buffer;
}

export function encodeStats(timeMs: number, entries: StatsEntry[]): ArrayBuffer {
  const buffer = new ArrayBuffer(HEADER_BYTES + entries.length * STATS_RECORD_BYTES);
  const view = new DataView(buffer);
  writeHeader(view, {
    type: FrameType.Stats,
    kind: 0,
    flags: 0,
    timeMs,
    count: entries.length,
    aux: 0,
  });
  entries.forEach((entry, i) => {
    const o = HEADER_BYTES + i * STATS_RECORD_BYTES;
    view.setUint8(o, entry.kind);
    view.setUint8(o + 1, entry.status);
    view.setUint16(o + 2, 0, true);
    view.setUint32(o + 4, entry.total, true);
  });
  return buffer;
}

export function encodeEvents(timeMs: number, events: HaloEvent[]): ArrayBuffer {
  const body = utf8Encoder.encode(JSON.stringify(events));
  const buffer = new ArrayBuffer(HEADER_BYTES + body.length);
  writeHeader(new DataView(buffer), {
    type: FrameType.Events,
    kind: 0,
    flags: 0,
    timeMs,
    count: events.length,
    aux: 0,
  });
  new Uint8Array(buffer).set(body, HEADER_BYTES);
  return buffer;
}

/**
 * Inflate a frame whose header carries `FRAME_FLAG_DEFLATE`. Returns the
 * frame with a plain body and the flag cleared; other frames pass through.
 */
export async function inflateFrame(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  if (buffer.byteLength < HEADER_BYTES) throw new ProtocolError("Frame shorter than its header");
  const flags = new DataView(buffer).getUint16(4, true);
  if ((flags & FRAME_FLAG_DEFLATE) === 0) return buffer;
  const stream = new Blob([buffer.slice(HEADER_BYTES)])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  const body = await new Response(stream).arrayBuffer();
  const out = new Uint8Array(HEADER_BYTES + body.byteLength);
  out.set(new Uint8Array(buffer, 0, HEADER_BYTES), 0);
  out.set(new Uint8Array(body), HEADER_BYTES);
  new DataView(out.buffer).setUint16(4, flags & ~FRAME_FLAG_DEFLATE, true);
  return out.buffer;
}

/** Decode any server frame. Column arrays are views on `buffer` where possible. */
export function decodeFrame(buffer: ArrayBuffer): Frame {
  const header = readHeader(buffer);
  const n = header.count;
  switch (header.type) {
    case FrameType.Upsert: {
      if (buffer.byteLength < HEADER_BYTES + n * UPSERT_RECORD_BYTES)
        throw new ProtocolError("Upsert frame truncated");
      let o = HEADER_BYTES;
      const ids = column(Uint32Array, buffer, o, n);
      o += n * 4;
      const lonE7 = column(Int32Array, buffer, o, n);
      o += n * 4;
      const latE7 = column(Int32Array, buffer, o, n);
      o += n * 4;
      const alt = column(Int16Array, buffer, o, n);
      o += n * 2;
      const heading = column(Uint16Array, buffer, o, n);
      o += n * 2;
      const speed = column(Uint16Array, buffer, o, n);
      o += n * 2;
      const vrate = column(Int8Array, buffer, o, n);
      o += n;
      const age = column(Uint8Array, buffer, o, n);
      o += n;
      const category = column(Uint8Array, buffer, o, n);
      o += n;
      const entityFlags = column(Uint8Array, buffer, o, n);
      return {
        ...header,
        type: FrameType.Upsert,
        kind: header.kind as EntityKind,
        full: (header.flags & FRAME_FLAG_FULL) !== 0,
        ids,
        lonE7,
        latE7,
        alt,
        heading,
        speed,
        vrate,
        age,
        category,
        entityFlags,
      };
    }
    case FrameType.Remove:
      return {
        ...header,
        type: FrameType.Remove,
        kind: header.kind as EntityKind,
        ids: column(Uint32Array, buffer, HEADER_BYTES, n),
      };
    case FrameType.Meta: {
      const view = new DataView(buffer);
      const bytes = new Uint8Array(buffer);
      const records: MetaRecord[] = [];
      let o = HEADER_BYTES;
      for (let r = 0; r < n; r++) {
        if (o + 5 > buffer.byteLength) throw new ProtocolError("Meta frame truncated");
        const id = view.getUint32(o, true);
        const fieldCount = view.getUint8(o + 4);
        o += 5;
        const fields: Partial<Record<MetaKeyName, string>> = {};
        for (let f = 0; f < fieldCount; f++) {
          if (o + 2 > buffer.byteLength) throw new ProtocolError("Meta frame truncated");
          const key = view.getUint8(o);
          const len = view.getUint8(o + 1);
          o += 2;
          if (o + len > buffer.byteLength) throw new ProtocolError("Meta frame truncated");
          const name = META_NAME_BY_KEY.get(key);
          // Unknown keys are skipped so older clients tolerate newer servers.
          if (name) fields[name] = utf8Decoder.decode(bytes.subarray(o, o + len));
          o += len;
        }
        records.push({ id, fields });
      }
      return { ...header, type: FrameType.Meta, kind: header.kind as EntityKind, records };
    }
    case FrameType.Density: {
      if (buffer.byteLength < HEADER_BYTES + n * DENSITY_RECORD_BYTES)
        throw new ProtocolError("Density frame truncated");
      let o = HEADER_BYTES;
      const cellLo = column(Uint32Array, buffer, o, n);
      o += n * 4;
      const cellHi = column(Uint32Array, buffer, o, n);
      o += n * 4;
      const lon = column(Float32Array, buffer, o, n);
      o += n * 4;
      const lat = column(Float32Array, buffer, o, n);
      o += n * 4;
      const counts = column(Uint32Array, buffer, o, n);
      return {
        ...header,
        type: FrameType.Density,
        kind: header.kind as EntityKind,
        res: header.aux,
        cellLo,
        cellHi,
        lon,
        lat,
        counts,
      };
    }
    case FrameType.Stats: {
      if (buffer.byteLength < HEADER_BYTES + n * STATS_RECORD_BYTES)
        throw new ProtocolError("Stats frame truncated");
      const view = new DataView(buffer);
      const entries: StatsEntry[] = [];
      for (let i = 0; i < n; i++) {
        const o = HEADER_BYTES + i * STATS_RECORD_BYTES;
        entries.push({
          kind: view.getUint8(o) as EntityKind,
          status: view.getUint8(o + 1) as UpstreamStatus,
          total: view.getUint32(o + 4, true),
        });
      }
      return { ...header, type: FrameType.Stats, entries };
    }
    case FrameType.Events: {
      const text = utf8Decoder.decode(new Uint8Array(buffer, HEADER_BYTES));
      let events: HaloEvent[];
      try {
        events = JSON.parse(text) as HaloEvent[];
      } catch {
        throw new ProtocolError("Events frame is not valid JSON");
      }
      if (!Array.isArray(events)) throw new ProtocolError("Events frame is not an array");
      return { ...header, type: FrameType.Events, events };
    }
    default:
      throw new ProtocolError(`Unknown frame type ${header.type as number}`);
  }
}

/** Convert a decoded Upsert from wire units to SI columns. */
export function upsertToUpdate(frame: UpsertFrame, source: string): EntityUpdate {
  const n = frame.count;
  const c: EntityColumns = createColumns(n);
  c.ids.set(frame.ids);
  c.category.set(frame.category);
  c.flags.set(frame.entityFlags);
  for (let i = 0; i < n; i++) {
    c.lon[i] = frame.lonE7[i] / LONLAT_SCALE;
    c.lat[i] = frame.latE7[i] / LONLAT_SCALE;
    c.alt[i] = frame.alt[i] * ALT_UNIT_M;
    const h = frame.heading[i];
    c.heading[i] = h === HEADING_UNKNOWN ? Number.NaN : h / HEADING_SCALE;
    c.speed[i] = frame.speed[i] * SPEED_UNIT_MPS;
    c.vrate[i] = frame.vrate[i] * VRATE_UNIT_MPS;
    c.fixTimeMs[i] = frame.timeMs - frame.age[i] * 1000;
  }
  return { kind: frame.kind, source, timeMs: frame.timeMs, full: frame.full, count: n, columns: c };
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Convert SI columns to an Upsert frame. Used by tests and the mock gateway. */
export function updateToUpsert(update: EntityUpdate): ArrayBuffer {
  const n = update.count;
  const c = update.columns;
  const lonE7 = new Int32Array(n);
  const latE7 = new Int32Array(n);
  const alt = new Int16Array(n);
  const heading = new Uint16Array(n);
  const speed = new Uint16Array(n);
  const vrate = new Int8Array(n);
  const age = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    lonE7[i] = Math.round(c.lon[i] * LONLAT_SCALE);
    latE7[i] = Math.round(c.lat[i] * LONLAT_SCALE);
    alt[i] = clamp(Math.round(c.alt[i] / ALT_UNIT_M), -32768, 32767);
    heading[i] = Number.isNaN(c.heading[i])
      ? HEADING_UNKNOWN
      : Math.round((((c.heading[i] % 360) + 360) % 360) * HEADING_SCALE) % 36000;
    speed[i] = clamp(Math.round(c.speed[i] / SPEED_UNIT_MPS), 0, 65535);
    vrate[i] = clamp(Math.round(c.vrate[i] / VRATE_UNIT_MPS), -127, 127);
    age[i] = clamp(Math.round((update.timeMs - c.fixTimeMs[i]) / 1000), 0, AGE_SATURATED_S);
  }
  return encodeUpsert({
    kind: update.kind,
    timeMs: update.timeMs,
    full: update.full,
    count: n,
    ids: c.ids,
    lonE7,
    latE7,
    alt,
    heading,
    speed,
    vrate,
    age,
    category: c.category,
    entityFlags: c.flags,
  });
}

/** Meta records to per-entity `EntityMeta` objects, keyed by id. */
export function metaToMap(frame: MetaFrame): Map<number, EntityMeta> {
  const map = new Map<number, EntityMeta>();
  for (const record of frame.records) map.set(record.id, { ...record.fields });
  return map;
}
