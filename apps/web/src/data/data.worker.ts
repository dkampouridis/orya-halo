/**
 * Data worker entry. All the logic is in `DataRuntime`; this file gives it
 * the browser (fetch, WebSocket, the Cache API) and exposes it over Comlink.
 */
import { expose, transfer } from "comlink";
import type { DataMessage } from "@orya-halo/schema";
import type { HaloWorkerApi } from "./api.ts";
import { openResponseCache } from "./fetching.ts";
import type { SocketLike } from "./gateway.ts";
import { createAircraftPhotos } from "./photos.ts";
import { createPlaceSearch, createSources } from "./registry.ts";
import { DataRuntime } from "./runtime.ts";

const workerFetch: typeof fetch = (input, init) => fetch(input, init);

const runtime = new DataRuntime({
  plugins: createSources,
  placeSearch: null,
  placeSearchFor: (config) => createPlaceSearch(config, workerFetch),
  fetch: workerFetch,
  createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
  cache: openResponseCache(),
  photos: createAircraftPhotos(workerFetch),
});

/** Sees every message on its way out. Only set in development builds. */
let tap: ((message: DataMessage) => void) | null = null;

if (import.meta.env.DEV) {
  // Development only (the branch is compiled out of production builds): lets
  // a browser test read the worker's state and its recent messages with
  // `worker.evaluate(() => __haloData.state())`.
  const recent: Record<string, unknown>[] = [];
  const counts: Record<string, number> = {};
  tap = (message) => {
    counts[message.type] = (counts[message.type] ?? 0) + 1;
    const line: Record<string, unknown> = { type: message.type, atMs: Date.now() };
    if (message.type === "batch") {
      line.kind = message.batch.kind;
      line.count = message.batch.count;
      line.seq = message.batch.seq;
      line.epochMs = message.batch.epochMs;
    } else if (message.type === "layer") {
      line.layer = message.layer;
      line.state = message.state;
    } else if (message.type === "tiles") {
      line.layer = message.layer;
      line.overlay = message.overlay;
    } else if (message.type === "paths") {
      line.layer = message.layer;
      line.count = message.paths.count;
    } else if (message.type === "density") {
      line.kind = message.grid.kind;
      line.count = message.grid.count;
    } else if (message.type === "events") {
      line.events = message.events;
    } else if (message.type === "track") {
      line.count = message.track?.count ?? null;
    } else {
      line.fromMs = message.fromMs;
      line.toMs = message.toMs;
    }
    recent.push(line);
    if (recent.length > 600) recent.shift();
  };
  (globalThis as { __haloData?: unknown }).__haloData = {
    runtime,
    state: () => runtime.debugState(),
    messages: (type?: string) => (type ? recent.filter((m) => m.type === type) : recent.slice()),
    counts: () => ({ ...counts }),
  };
}

const api: HaloWorkerApi = {
  connect(port) {
    // The hot path: one postMessage per message, buffers moved, nothing awaited.
    runtime.listen((message, transferables) => {
      tap?.(message);
      port.postMessage(message, transferables);
    });
  },
  listen(sink) {
    // The contract's way in, for callers that pass a Comlink-proxied callback.
    // Marked for transfer so buffers are still moved rather than copied.
    runtime.listen((message, transferables) => {
      tap?.(message);
      sink(transfer(message, transferables));
    });
  },
  init: (config) => runtime.init(config),
  setLayerEnabled: (layer, enabled) => runtime.setLayerEnabled(layer, enabled),
  setView: (view) => runtime.setView(view),
  setClock: (clock) => runtime.setClock(clock),
  setTracked: (ref) => runtime.setTracked(ref),
  getDetail: (ref) => runtime.getDetail(ref),
  getSummary: (ref) => runtime.getSummary(ref),
  search: (query, near) => runtime.search(query, near),
  getAttributions: () => runtime.getAttributions(),
  setVisible: (visible) => runtime.setVisible(visible),
  dispose: () => runtime.dispose(),
};

expose(api);
