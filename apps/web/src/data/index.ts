/**
 * Main-thread side of the data worker. Deliberately tiny: this file is in
 * the app's entry chunk, and everything heavy (stores, h3-js, the plugins)
 * stays behind the Worker boundary in its own chunk.
 *
 * Calls go through Comlink. Messages do not: the worker posts them on a
 * dedicated `MessagePort` with their buffers in the transfer list, so a
 * batch crosses threads as one `postMessage` with no copy, no reply and no
 * per-message promise. A Comlink callback would cost a round trip each time.
 */
import { releaseProxy, transfer, wrap } from "comlink";
import type { DataMessage } from "@orya-halo/schema";
import type { CreateDataClient, DataClient } from "../core/data.ts";
import type { HaloWorkerApi } from "./api.ts";

/** Messages kept while nobody is listening yet (the first layer states arrive during `init`). */
const MAX_BACKLOG = 256;

export const createDataClient: CreateDataClient = async (config) => {
  const worker = new Worker(new URL("./data.worker.ts", import.meta.url), {
    type: "module",
    name: "halo-data",
  });
  const remote = wrap<HaloWorkerApi>(worker);
  const handlers = new Set<(message: DataMessage) => void>();
  let backlog: DataMessage[] | null = [];

  const channel = new MessageChannel();
  channel.port1.onmessage = (event: MessageEvent<DataMessage>) => {
    if (backlog !== null) {
      if (backlog.length < MAX_BACKLOG) backlog.push(event.data);
      return;
    }
    for (const handler of handlers) handler(event.data);
  };

  const onVisibility = () => void remote.setVisible(!document.hidden);
  document.addEventListener("visibilitychange", onVisibility);

  await remote.connect(transfer(channel.port2, [channel.port2]));
  if (document.hidden) await remote.setVisible(false);
  await remote.init(config);

  const onMessage: DataClient["onMessage"] = (handler) => {
    handlers.add(handler);
    if (backlog !== null) {
      const waiting = backlog;
      backlog = null;
      for (const message of waiting) handler(message);
    }
    return () => handlers.delete(handler);
  };

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    document.removeEventListener("visibilitychange", onVisibility);
    channel.port1.close();
    handlers.clear();
    // Let the worker close its sockets, then stop it whether or not it answered.
    void Promise.resolve(remote.dispose())
      .catch(() => {})
      .then(() => {
        remote[releaseProxy]();
        worker.terminate();
      });
  };

  return {
    api: {
      // Already initialised above; the worker takes one configuration per lifetime.
      init: async () => {},
      // The port above is the sink; a listener registered here joins it.
      listen: async (sink) => void onMessage(sink),
      setLayerEnabled: (layer, enabled) => remote.setLayerEnabled(layer, enabled),
      setView: (view) => remote.setView(view),
      setClock: (clock) => remote.setClock(clock),
      setTracked: (ref) => remote.setTracked(ref),
      getDetail: (ref) => remote.getDetail(ref),
      getSummary: (ref) => remote.getSummary(ref),
      search: (query, near) => remote.search(query, near),
      getAttributions: () => remote.getAttributions(),
      dispose: async () => dispose(),
    },
    onMessage,
    dispose,
  };
};
