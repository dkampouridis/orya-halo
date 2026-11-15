/**
 * The data side's public face on the main thread.
 *
 * `src/data` implements this: it starts the data worker, wraps it with
 * Comlink and delivers its messages. The worker itself implements
 * `DataWorkerApi` from `@orya-halo/schema`.
 */
import type { DataConfig, DataMessage, DataWorkerApi } from "@orya-halo/schema";

export interface DataClient {
  /** The worker's API. Every method returns a promise across the thread boundary. */
  api: {
    [K in keyof DataWorkerApi]: DataWorkerApi[K] extends (...args: infer A) => infer R
      ? (...args: A) => Promise<Awaited<R>>
      : never;
  };
  /** Receive worker messages. Returns an unsubscribe function. */
  onMessage(handler: (message: DataMessage) => void): () => void;
  /** Stop the worker and release everything. */
  dispose(): void;
}

/** Implemented by `src/data/index.ts`. Starts the worker and calls `init`. */
export type CreateDataClient = (config: DataConfig) => Promise<DataClient>;
