// Polyfill `localStorage` so jsdom's Storage isn't shadowed by Node 25's
// experimental built-in `localStorage` global, which exposes only a partial API
class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

// Default the storage engine to the ephemeral in-memory adapter for tests so a
// server-booting test never writes a durable `enpilink.db` into the package cwd
// (the dev/prod default is now `sqlite`). Tests that specifically exercise the
// sqlite engine instantiate `SqliteStorageAdapter` directly or set
// `ENPILINK_STORAGE`/`ENPILINK_DB_PATH` explicitly. Only set it when unset so a
// test (or the CI env) can still override it.
if (process.env.ENPILINK_STORAGE === undefined) {
  process.env.ENPILINK_STORAGE = "memory";
}

const storage = new MemoryStorage();

Object.defineProperty(globalThis, "localStorage", {
  value: storage,
  writable: true,
  configurable: true,
});
