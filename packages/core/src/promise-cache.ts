/**
 * A bounded in-process cache of promises. Callers asking for a key while
 * its value is still being computed share that one computation; one that
 * fails is forgotten at once, so a passing outage never sticks; past
 * `maxEntries` the least recently used entry goes first.
 */
export interface PromiseCache {
  get<T>(key: string, compute: () => Promise<T>, ttlMs?: number): Promise<T>;
  peek<T>(key: string): Promise<T> | undefined;
  set<T>(key: string, value: Promise<T>, ttlMs?: number): Promise<T>;
  delete(key: string): void;
}

export function createPromiseCache(opts: {
  maxEntries: number;
  ttlMs: number;
  now?: () => number;
}): PromiseCache {
  const now = opts.now ?? Date.now;
  // Map insertion order is the LRU order: a hit is re-inserted, eviction takes the first key.
  const entries = new Map<string, { value: Promise<unknown>; expiresAt: number }>();
  const peek = <T>(key: string): Promise<T> | undefined => {
    const entry = entries.get(key);
    if (!entry) return undefined;
    entries.delete(key);
    if (entry.expiresAt <= now()) return undefined;
    entries.set(key, entry);
    return entry.value as Promise<T>;
  };
  const set = <T>(key: string, value: Promise<T>, ttlMs = opts.ttlMs): Promise<T> => {
    const entry = { value, expiresAt: now() + ttlMs };
    entries.delete(key);
    entries.set(key, entry);
    for (const oldest of entries.keys()) {
      if (entries.size <= opts.maxEntries) break;
      entries.delete(oldest);
    }
    value.catch(() => {
      if (entries.get(key) === entry) entries.delete(key);
    });
    return value;
  };
  return {
    get: (key, compute, ttlMs) => peek(key) ?? set(key, compute(), ttlMs),
    peek,
    set,
    delete: (key) => {
      entries.delete(key);
    },
  };
}
