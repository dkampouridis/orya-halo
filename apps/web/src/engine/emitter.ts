/** Minimal typed event emitter for `HaloEngine.on`. */
export class Emitter<Events> {
  private readonly handlers = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(type: K, handler: (payload: Events[K]) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as (payload: never) => void);
    return () => {
      set.delete(handler as (payload: never) => void);
    };
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    // A Set may be changed while it is iterated, so a listener can unsubscribe itself.
    for (const handler of set) {
      // A throwing listener must not stop the render loop or other listeners.
      try {
        (handler as (payload: Events[K]) => void)(payload);
      } catch (error) {
        console.error(`Orya Halo: "${String(type)}" listener failed`, error);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
