/** Minimal typed event emitter (browser and Node). Listener errors are isolated. */
export class Emitter<Events extends { [K in keyof Events]: (...args: never[]) => void }> {
  private readonly listeners = new Map<keyof Events, Set<Events[keyof Events]>>();

  on<K extends keyof Events>(event: K, listener: Events[K]): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  protected emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        (listener as (...a: Parameters<Events[K]>) => void)(...args);
      } catch (err) {
        console.error(`listener for "${String(event)}" failed`, err);
      }
    }
  }

  protected removeAllListeners(): void {
    this.listeners.clear();
  }
}
