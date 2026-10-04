import { useSyncExternalStore } from 'react';

/**
 * Generic ordered registry with change notifications. Feature modules register definitions at
 * import time (see src/features.ts); React components read them with `useRegistry`.
 */
export class Registry<T extends { id: string }> {
  private items = new Map<string, T>();
  private listeners = new Set<() => void>();
  private snapshot: T[] = [];

  constructor(readonly name: string) {}

  register(def: T): T {
    if (this.items.has(def.id)) {
      // Later registrations override earlier ones (useful for hot reload / user overrides).
      console.debug(`[${this.name}] overriding ${def.id}`);
    }
    this.items.set(def.id, def);
    this.emit();
    return def;
  }

  registerMany(defs: T[]) {
    for (const d of defs) this.items.set(d.id, d);
    this.emit();
  }

  unregister(id: string) {
    if (this.items.delete(id)) this.emit();
  }

  get(id: string): T | undefined {
    return this.items.get(id);
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  /** Stable array snapshot (insertion order). */
  list(): T[] {
    return this.snapshot;
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private emit() {
    this.snapshot = [...this.items.values()];
    this.listeners.forEach((l) => l());
  }
}

export function useRegistry<T extends { id: string }>(reg: Registry<T>): T[] {
  return useSyncExternalStore(reg.subscribe, () => reg.list());
}
