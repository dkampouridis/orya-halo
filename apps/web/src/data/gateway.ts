/**
 * Gateway client: the WebSocket that carries aircraft and ships.
 *
 * Speaks docs/PROTOCOL.md. Subscribes by viewport (H3 cells chosen in
 * `cells.ts`), decodes binary frames straight into the entity stores, and
 * keeps the connection alive: reconnect with backoff and jitter, resubscribe
 * after every `hello`, ping for latency and to notice a dead socket.
 */
import {
  AGE_SATURATED_S,
  EntityKind,
  FRAME_FLAG_DEFLATE,
  FRAME_FLAG_FULL,
  FrameType,
  HEADER_BYTES,
  ProtocolError,
  UpstreamStatus,
  decodeFrame,
  inflateFrame,
  layerForKind,
  upsertToUpdate,
} from "@orya-halo/schema";
import type {
  Attribution,
  ClientMessage,
  DensityGrid,
  EntityMeta,
  EntityUpdate,
  Frame,
  GatewayLayer,
  HaloEvent,
  SearchResult,
  ServerMessage,
  ViewState,
} from "@orya-halo/schema";
import { cellsForView } from "./cells.ts";
import { idText } from "./format.ts";
import { layerSubject } from "./layers.ts";
import type { FeedState } from "./layers.ts";

/** Source id of everything that arrives through the gateway. */
export const GATEWAY_SOURCE = "gateway";

const KNOWN_FLAGS = FRAME_FLAG_FULL | FRAME_FLAG_DEFLATE;

export const GATEWAY_LAYERS: readonly GatewayLayer[] = ["aircraft", "ships"];
const KIND_OF: Record<GatewayLayer, EntityKind> = {
  aircraft: EntityKind.Aircraft,
  ships: EntityKind.Ship,
};

/** The slice of `WebSocket` the client uses, so tests can supply a fake. */
export interface SocketLike {
  binaryType: string;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface GatewayHost {
  /**
   * Merge an update. `saturated` lists the rows whose age reached the wire
   * format's ceiling: their `fixTimeMs` is the latest the fix can have been
   * made, not when it was.
   */
  apply(update: EntityUpdate, saturated: readonly number[] | null): void;
  remove(kind: EntityKind, ids: Uint32Array): void;
  meta(kind: EntityKind, id: number, meta: EntityMeta): void;
  density(grid: DensityGrid): void;
  events(events: HaloEvent[]): void;
  state(layer: GatewayLayer, state: FeedState): void;
  /** The feed is gone for now: drop the gateway's entities for this layer. */
  clear(layer: GatewayLayer): void;
}

export interface GatewayOptions {
  /** WebSocket base URL, e.g. `wss://halo.example.org`. */
  url: string;
  createSocket: (url: string) => SocketLike;
  fetch: typeof fetch;
  host: GatewayHost;
  random?: () => number;
}

/** An airport at one end of a flight, as the gateway's route lookup names it. */
export interface GatewayPlace {
  code: string;
  name?: string;
  lon?: number;
  lat?: number;
}

/** One entity as `GET /v1/entity/{kind}/{id}` describes it (apps/gateway/src/http.rs). */
export interface GatewayEntity {
  lon: number;
  lat: number;
  /** Metres. */
  alt: number;
  /** Degrees, or null when the feed does not say. */
  heading: number | null;
  /** Metres per second. */
  speed: number;
  vrate: number;
  /**
   * When the fix was made, on the gateway's clock, to the millisecond. A
   * frame only carries whole seconds of age and stops counting at 255.
   */
  fixTimeMs: number;
  category: number;
  flags: number;
  meta: EntityMeta;
  /** Recent track, oldest first: lon, lat, alt triples and a time per vertex. */
  track: { positions: number[]; timesMs: number[] } | null;
  /** Scheduled route, for airline flights the gateway could look up. */
  origin?: GatewayPlace;
  destination?: GatewayPlace;
  /** Credit for the feed this entity came from. */
  attribution?: Attribution;
}

const SUB_DEBOUNCE_MS = 250;
const PING_INTERVAL_MS = 15_000;
/** No message at all for this long means the socket is dead, whatever it claims. */
const SILENCE_LIMIT_MS = 45_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** How long old positions stay on screen after the connection drops. */
const GRACE_MS = 10_000;
/** Clock differences below this are not worth correcting. */
const SKEW_THRESHOLD_MS = 1_500;
const UNREACHABLE =
  "Live traffic is offline. The gateway isn't reachable; satellites and earthquakes still work.";

export class GatewayClient {
  /** Round trip of the last ping, milliseconds; null before the first pong. */
  latencyMs: number | null = null;
  /** Frames skipped because they used header flags this client does not know. */
  skippedFrames = 0;
  /** What has come down the socket since the client was made. For diagnostics. */
  readonly stats = { connections: 0, frames: 0, compressedFrames: 0, fullFrames: 0, bytes: 0 };

  private readonly url: string;
  private readonly httpBase: string;
  private readonly createSocket: (url: string) => SocketLike;
  private readonly fetchFn: typeof fetch;
  private readonly host: GatewayHost;
  private readonly random: () => number;

  private socket: SocketLike | null = null;
  private connected = false;
  /** True from a first connection attempt until it succeeds or fails. */
  private connecting = false;
  private stopped = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private subTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private pingId = 0;
  private pingSentMs = 0;
  private lastMessageMs = 0;

  private maxCells = 2000;
  private readonly layers = new Set<GatewayLayer>();
  private view: ViewState | null = null;
  private lastSub = "";

  private readonly upstream: Record<GatewayLayer, UpstreamStatus> = {
    aircraft: UpstreamStatus.Ok,
    ships: UpstreamStatus.Ok,
  };
  private readonly totals: Record<GatewayLayer, number | null> = { aircraft: null, ships: null };
  private readonly updatedMs: Record<GatewayLayer, number> = { aircraft: 0, ships: 0 };
  /** Credit text per layer, from `hello`. */
  readonly attributions: Partial<Record<GatewayLayer, string>> = {};

  /** Smallest (local receive time - server frame time) seen on this connection. */
  private minDeltaMs = Number.POSITIVE_INFINITY;
  /** Tail of the in-order queue used while compressed frames inflate. */
  private pending: Promise<void> | null = null;

  constructor(options: GatewayOptions) {
    this.url = options.url.replace(/\/+$/, "");
    this.httpBase = this.url.replace(/^ws/i, "http");
    this.createSocket = options.createSocket;
    this.fetchFn = options.fetch;
    this.host = options.host;
    this.random = options.random ?? Math.random;
  }

  get online(): boolean {
    return this.connected;
  }

  /** Milliseconds to add to a server timestamp to express it on the local clock. */
  get skewMs(): number {
    return Number.isFinite(this.minDeltaMs) && Math.abs(this.minDeltaMs) > SKEW_THRESHOLD_MS
      ? this.minDeltaMs
      : 0;
  }

  /** Which gateway layers are wanted. Connects on the first, disconnects on none. */
  setLayerEnabled(layer: GatewayLayer, enabled: boolean): void {
    if (enabled === this.layers.has(layer)) return;
    if (enabled) this.layers.add(layer);
    else {
      this.layers.delete(layer);
      // Whatever arrives after switching back on is new data.
      this.updatedMs[layer] = 0;
    }
    if (this.layers.size === 0) {
      this.disconnect();
      return;
    }
    if (this.socket === null && this.reconnectTimer === null) {
      // Connecting publishes every layer's state itself, as "loading".
      this.connect();
      return;
    }
    if (enabled) this.publish(layer);
    if (this.socket !== null) this.scheduleSub(0);
  }

  setView(view: ViewState): void {
    this.view = view;
    this.scheduleSub(SUB_DEBOUNCE_MS);
  }

  stop(): void {
    this.stopped = true;
    this.disconnect();
  }

  private disconnect(): void {
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    this.connecting = false;
    this.attempts = 0;
    this.lastSub = "";
    if (socket) {
      socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
      try {
        socket.close();
      } catch {
        // Closing a socket that never opened can throw; it is gone either way.
      }
    }
  }

  private clearTimers(): void {
    for (const timer of [this.reconnectTimer, this.graceTimer, this.subTimer, this.pingTimer]) {
      if (timer !== null) clearTimeout(timer);
    }
    this.reconnectTimer = this.graceTimer = this.subTimer = this.pingTimer = null;
  }

  private connect(): void {
    if (this.stopped || this.layers.size === 0) return;
    this.reconnectTimer = null;
    // Only a first attempt reads as "loading"; retries stay "offline" until one works.
    this.connecting = this.attempts === 0;
    let socket: SocketLike;
    try {
      socket = this.createSocket(`${this.url}/v1/stream?v=1&z=1`);
    } catch {
      this.lost();
      return;
    }
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.lastMessageMs = Date.now();
      if (typeof event.data === "string") this.onControl(event.data);
      else if (event.data instanceof ArrayBuffer) this.onBinary(event.data);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.lost();
    };
    // An error is always followed by a close, which does the work.
    socket.onerror = () => {};
    socket.onopen = () => {};
    for (const layer of this.layers) this.publish(layer);
  }

  /** The connection failed or dropped: report it and try again later. */
  private lost(): void {
    const wasConnected = this.connected;
    this.connected = false;
    this.connecting = false;
    this.lastSub = "";
    this.pending = null;
    this.minDeltaMs = Number.POSITIVE_INFINITY;
    if (this.pingTimer !== null) clearTimeout(this.pingTimer);
    if (this.subTimer !== null) clearTimeout(this.subTimer);
    this.pingTimer = this.subTimer = null;
    if (this.stopped || this.layers.size === 0) return;

    if (wasConnected && this.graceTimer === null) {
      // A blip should not empty the sky: hold positions briefly while reconnecting.
      this.graceTimer = setTimeout(() => {
        this.graceTimer = null;
        for (const layer of this.layers) {
          this.host.clear(layer);
          this.updatedMs[layer] = 0;
          this.publish(layer);
        }
      }, GRACE_MS);
    }
    const delay =
      Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.attempts) *
      (0.5 + this.random() * 0.5);
    this.attempts++;
    for (const layer of this.layers) this.publish(layer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /** Push the current feed state of one layer to the host. */
  private publish(layer: GatewayLayer): void {
    if (!this.layers.has(layer)) return;
    this.host.state(layer, this.feedState(layer));
  }

  private feedState(layer: GatewayLayer): FeedState {
    const total = this.totals[layer];
    const updatedMs = this.updatedMs[layer] || undefined;
    const upstream = this.upstream[layer];
    if (!this.connected) {
      // First attempt still in the air: not a failure yet.
      if (this.connecting) return { status: "loading" };
      if (this.graceTimer === null) return { status: "offline", message: UNREACHABLE, total };
      if (upstream === UpstreamStatus.Ok || upstream === UpstreamStatus.Degraded) {
        return {
          status: "degraded",
          message: "Live traffic lost its connection. Reconnecting now.",
          total,
          updatedMs,
        };
      }
      // A layer the gateway was not serving anyway keeps saying why, below.
    }
    switch (upstream) {
      case UpstreamStatus.Ok:
        return { status: updatedMs === undefined ? "loading" : "live", total, updatedMs };
      case UpstreamStatus.Degraded:
        return {
          status: "degraded",
          message: `${layerSubject(layer, "are", "is")} updating slowly or incompletely right now.`,
          total,
          updatedMs,
        };
      case UpstreamStatus.NeedsKey:
        return {
          status: "needs-key",
          message: `${layerSubject(layer, "need", "needs")} an API key. Add it to the gateway's .env file.`,
          total,
        };
      case UpstreamStatus.Off:
        return {
          status: "offline",
          message: `${layerSubject(layer, "are", "is")} switched off on this gateway.`,
          total,
        };
      default:
        return {
          status: "offline",
          message: `${layerSubject(layer, "are", "is")} offline. The gateway can't reach its provider right now.`,
          total,
        };
    }
  }

  private onControl(text: string): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(text) as ServerMessage;
    } catch {
      return;
    }
    if (message.t === "hello") {
      this.stats.connections++;
      this.connected = true;
      this.connecting = false;
      this.attempts = 0;
      if (this.graceTimer !== null) clearTimeout(this.graceTimer);
      this.graceTimer = null;
      if (typeof message.maxCells === "number" && message.maxCells > 0)
        this.maxCells = message.maxCells;
      for (const layer of GATEWAY_LAYERS) {
        const info = message.layers?.[layer];
        if (!info) continue;
        this.upstream[layer] = info.status;
        if (info.attribution) this.attributions[layer] = info.attribution;
      }
      for (const layer of this.layers) this.publish(layer);
      this.lastSub = "";
      this.sendSub();
      this.schedulePing();
    } else if (message.t === "pong") {
      if (message.id === this.pingId) this.latencyMs = Date.now() - this.pingSentMs;
    }
    // An `error` leaves the previous subscription in force; the next view
    // change sends a fresh one, so there is nothing to undo here.
  }

  private schedulePing(): void {
    if (this.pingTimer !== null) clearTimeout(this.pingTimer);
    this.pingTimer = setTimeout(() => {
      this.pingTimer = null;
      const socket = this.socket;
      if (!socket || !this.connected) return;
      if (Date.now() - this.lastMessageMs > SILENCE_LIMIT_MS) {
        // Half-open connection: closing it ourselves starts the reconnect.
        socket.onclose = socket.onmessage = null;
        this.socket = null;
        try {
          socket.close();
        } catch {
          // Gone already.
        }
        this.lost();
        return;
      }
      this.pingSentMs = Date.now();
      this.send({ t: "ping", id: ++this.pingId });
      this.schedulePing();
    }, PING_INTERVAL_MS);
  }

  private send(message: ClientMessage): void {
    try {
      this.socket?.send(JSON.stringify(message));
    } catch {
      // The close handler deals with a socket that died under us.
    }
  }

  private scheduleSub(delayMs: number): void {
    if (this.subTimer !== null) clearTimeout(this.subTimer);
    this.subTimer = setTimeout(() => {
      this.subTimer = null;
      this.sendSub();
    }, delayMs);
  }

  /** The subscription the current view and layers call for. */
  subscription(): Extract<ClientMessage, { t: "sub" }> {
    // Before the camera reports, the opening shot is the whole globe.
    const cover = this.view
      ? cellsForView(this.view, this.maxCells)
      : { res: 0 as const, cells: [] };
    return {
      t: "sub",
      layers: GATEWAY_LAYERS.filter((layer) => this.layers.has(layer)),
      res: cover.res,
      cells: cover.cells,
      points: true,
      // Far out, the glow of per-cell counts reads better than 20,000 dots alone.
      density: cover.res <= 1,
    };
  }

  private sendSub(): void {
    if (!this.connected || this.socket === null) return;
    const message = this.subscription();
    const key = JSON.stringify(message);
    if (key === this.lastSub) return;
    this.lastSub = key;
    try {
      this.socket.send(key);
    } catch {
      this.lastSub = "";
    }
  }

  private onBinary(buffer: ArrayBuffer): void {
    if (buffer.byteLength < HEADER_BYTES) return;
    const flags = new DataView(buffer).getUint16(4, true);
    this.stats.frames++;
    this.stats.bytes += buffer.byteLength;
    if ((flags & FRAME_FLAG_DEFLATE) !== 0) this.stats.compressedFrames++;
    if ((flags & FRAME_FLAG_FULL) !== 0) this.stats.fullFrames++;
    if ((flags & ~KNOWN_FLAGS) !== 0) {
      // A flag we do not know may change how the body is laid out. Guessing
      // would put garbage on the map, so the frame is skipped instead.
      this.skippedFrames++;
      return;
    }
    if ((flags & FRAME_FLAG_DEFLATE) !== 0 || this.pending !== null) {
      // Inflating is asynchronous; everything behind it queues to keep order.
      const socket = this.socket;
      const work =
        (flags & FRAME_FLAG_DEFLATE) !== 0 ? inflateFrame(buffer) : Promise.resolve(buffer);
      const tail: Promise<void> = (this.pending ?? Promise.resolve())
        .then(() => work)
        .then(
          (frame) => {
            if (this.socket === socket) this.onFrame(frame);
          },
          () => {
            this.skippedFrames++;
          },
        )
        .then(() => {
          if (this.pending === tail) this.pending = null;
        });
      this.pending = tail;
      return;
    }
    this.onFrame(buffer);
  }

  private onFrame(buffer: ArrayBuffer): void {
    let frame: Frame;
    try {
      frame = decodeFrame(buffer);
    } catch (error) {
      if (error instanceof ProtocolError) {
        this.skippedFrames++;
        return;
      }
      throw error;
    }
    const now = Date.now();
    const delta = now - frame.timeMs;
    if (delta < this.minDeltaMs) this.minDeltaMs = delta;

    switch (frame.type) {
      case FrameType.Upsert: {
        const layer = layerOf(frame.kind);
        if (layer === null || !this.layers.has(layer)) return;
        const update = upsertToUpdate(frame, GATEWAY_SOURCE);
        const skew = this.skewMs;
        if (skew !== 0) {
          // The device clock is off: move the fixes onto it, or dead
          // reckoning would run early or late by the difference.
          update.timeMs += skew;
          const fix = update.columns.fixTimeMs;
          for (let i = 0; i < update.count; i++) fix[i] += skew;
        }
        // Age stops counting at 255 s: those fixes are at least that old, not exactly.
        let saturated: number[] | null = null;
        for (let i = 0; i < frame.count; i++) {
          if (frame.age[i] >= AGE_SATURATED_S) (saturated ??= []).push(i);
        }
        const first = this.updatedMs[layer] === 0;
        this.updatedMs[layer] = now;
        this.host.apply(update, saturated);
        if (first) this.publish(layer);
        break;
      }
      case FrameType.Remove: {
        const layer = layerOf(frame.kind);
        if (layer === null || !this.layers.has(layer)) return;
        this.host.remove(frame.kind, frame.ids);
        break;
      }
      case FrameType.Meta: {
        const layer = layerOf(frame.kind);
        if (layer === null || !this.layers.has(layer)) return;
        for (const record of frame.records) this.host.meta(frame.kind, record.id, record.fields);
        break;
      }
      case FrameType.Density: {
        const layer = layerOf(frame.kind);
        if (layer === null || !this.layers.has(layer)) return;
        const n = frame.count;
        const positions = new Float32Array(n * 2);
        let max = 0;
        for (let i = 0; i < n; i++) {
          positions[i * 2] = frame.lon[i];
          positions[i * 2 + 1] = frame.lat[i];
          if (frame.counts[i] > max) max = frame.counts[i];
        }
        // Copied, not viewed: the grid's buffers are transferred to the main thread.
        this.host.density({
          kind: frame.kind,
          res: frame.res,
          count: n,
          positions,
          counts: new Uint32Array(frame.counts),
          max,
        });
        break;
      }
      case FrameType.Stats: {
        for (const entry of frame.entries) {
          const layer = layerOf(entry.kind);
          if (layer === null) continue;
          this.totals[layer] = entry.total;
          this.upstream[layer] = entry.status;
          this.publish(layer);
        }
        break;
      }
      case FrameType.Events:
        if (frame.events.length > 0) this.host.events(frame.events);
        break;
    }
  }

  /** Detail of one entity from the gateway, or null when it has none. */
  async fetchEntity(
    kind: EntityKind,
    id: number,
    signal?: AbortSignal,
  ): Promise<GatewayEntity | null> {
    const layer = layerOf(kind);
    if (layer === null) return null;
    const response = await this.fetchFn(
      `${this.httpBase}/v1/entity/${layer === "ships" ? "ship" : "aircraft"}/${id}`,
      { signal },
    );
    // 404 is the gateway saying it no longer tracks this id.
    if (!response.ok) return null;
    return parseGatewayEntity(await response.json());
  }

  /** Base URL of the gateway's HTTP endpoints. */
  get httpUrl(): string {
    return this.httpBase;
  }

  /** Search everything the gateway tracks, anywhere in the world. */
  async search(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
    const response = await this.fetchFn(
      `${this.httpBase}/v1/search?q=${encodeURIComponent(query)}`,
      { signal },
    );
    if (!response.ok) return [];
    return parseGatewaySearch(await response.json());
  }
}

function layerOf(kind: number): GatewayLayer | null {
  if (kind === EntityKind.Aircraft) return "aircraft";
  if (kind === EntityKind.Ship) return "ships";
  return null;
}

/** Entity kind a gateway layer carries. */
export function kindOfGatewayLayer(layer: GatewayLayer): EntityKind {
  return KIND_OF[layer];
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parsePlace(value: unknown): GatewayPlace | undefined {
  if (!isObject(value) || typeof value.code !== "string" || value.code === "") return undefined;
  const place: GatewayPlace = { code: value.code };
  if (typeof value.name === "string" && value.name !== "") place.name = value.name;
  if (finite(value.lon) && finite(value.lat)) {
    place.lon = value.lon;
    place.lat = value.lat;
  }
  return place;
}

/**
 * Read the gateway's entity document: the fix inline in SI units, facts as
 * strings under `meta`, the track as `[lon, lat, alt, timeMs]` rows. Null
 * when it is not that document.
 */
export function parseGatewayEntity(json: unknown): GatewayEntity | null {
  if (!isObject(json)) return null;
  if (!finite(json.lon) || !finite(json.lat) || !finite(json.fixTimeMs)) return null;
  const meta: EntityMeta = {};
  if (isObject(json.meta)) {
    for (const key in json.meta) {
      const value = json.meta[key];
      if (typeof value === "string" && value !== "") meta[key] = value;
    }
  }
  const positions: number[] = [];
  const timesMs: number[] = [];
  if (Array.isArray(json.track)) {
    for (const row of json.track as unknown[]) {
      if (!Array.isArray(row) || !finite(row[0]) || !finite(row[1]) || !finite(row[3])) continue;
      positions.push(row[0], row[1], finite(row[2]) ? row[2] : 0);
      timesMs.push(row[3]);
    }
  }
  const entity: GatewayEntity = {
    lon: json.lon,
    lat: json.lat,
    alt: finite(json.alt) ? json.alt : 0,
    heading: finite(json.heading) ? json.heading : null,
    speed: finite(json.speed) ? json.speed : 0,
    vrate: finite(json.vrate) ? json.vrate : 0,
    fixTimeMs: json.fixTimeMs,
    category: finite(json.category) ? json.category : 0,
    flags: finite(json.flags) ? json.flags : 0,
    meta,
    track: timesMs.length > 0 ? { positions, timesMs } : null,
  };
  const origin = parsePlace(json.origin);
  if (origin) entity.origin = origin;
  const destination = parsePlace(json.destination);
  if (destination) entity.destination = destination;
  if (isObject(json.attribution) && typeof json.attribution.text === "string") {
    entity.attribution = {
      text: json.attribution.text,
      url: typeof json.attribution.url === "string" ? json.attribution.url : "",
    };
  }
  return entity;
}

/** Read `GET /v1/search`: `{ query, results: [{ kind, id, title, subtitle, lon, lat, score }] }`. */
export function parseGatewaySearch(json: unknown): SearchResult[] {
  const rows = isObject(json) && Array.isArray(json.results) ? (json.results as unknown[]) : [];
  const results: SearchResult[] = [];
  for (const row of rows) {
    if (!isObject(row)) continue;
    const kind = row.kind;
    if (kind !== EntityKind.Aircraft && kind !== EntityKind.Ship) continue;
    if (!finite(row.id) || !finite(row.lon) || !finite(row.lat)) continue;
    const result: SearchResult = {
      type: "entity",
      ref: { kind, id: row.id },
      layer: layerForKind(kind).id,
      title: typeof row.title === "string" && row.title !== "" ? row.title : idText(kind, row.id),
      lon: row.lon,
      lat: row.lat,
      // The gateway scores as local search does: 100 exact, 80 prefix, 50 substring.
      score: finite(row.score) ? row.score : 50,
    };
    if (typeof row.subtitle === "string" && row.subtitle !== "") result.subtitle = row.subtitle;
    results.push(result);
  }
  return results;
}
