/**
 * What the data worker exposes over Comlink: the shared `DataWorkerApi` plus
 * two calls that only the main-thread client in this folder makes.
 */
import type { DataWorkerApi } from "@orya-halo/schema";

export interface HaloWorkerApi extends DataWorkerApi {
  /**
   * Hand the worker the port it posts `DataMessage`s to. Replaces `listen`
   * for the real app: a raw port transfers buffers with one `postMessage`
   * and no reply, where a Comlink callback costs a round trip per message.
   */
  connect(port: MessagePort): void;
  /** Tab visibility. A worker cannot observe it, so the page relays it. */
  setVisible(visible: boolean): void;
}
