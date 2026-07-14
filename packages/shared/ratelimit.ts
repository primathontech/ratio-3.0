// Per-tenant fixed-window rate limit (ADR-001 D-MT6). Fail-open on backing-store
// failure (ADR-008). Clock + store injectable for deterministic tests.
export interface RateResult {
  allowed: boolean;
  remaining: number | null;
  failOpen?: boolean;
}

interface Entry {
  count: number;
  reset: number;
}
interface Store {
  get(key: string): Entry | undefined;
  set(key: string, value: Entry): void;
}

export function createRateLimiter({
  limit = 100,
  windowMs = 60_000,
  now = () => Date.now(),
  store = new Map<string, Entry>() as Store,
}: {
  limit?: number;
  windowMs?: number;
  now?: () => number;
  store?: Store;
} = {}) {
  let lastSweep = now();
  return {
    check(tenantId: string): RateResult {
      if (!tenantId || typeof tenantId !== 'string') {
        throw new Error('rate limit requires a tenantId');
      }
      try {
        const t = now();
        // Evict expired windows so the map doesn't grow unboundedly (one entry per distinct
        // key, never removed otherwise) (L1). Bounded to once per window so the O(n) sweep
        // stays amortized-cheap; only the in-memory default Map is iterable/deletable.
        if (store instanceof Map && t - lastSweep >= windowMs) {
          for (const [k, e] of store) if (t >= e.reset) store.delete(k);
          lastSweep = t;
        }
        const entry = store.get(tenantId);
        if (!entry || t >= entry.reset) {
          store.set(tenantId, { count: 1, reset: t + windowMs });
          return { allowed: true, remaining: limit - 1 };
        }
        if (entry.count < limit) {
          entry.count += 1;
          store.set(tenantId, entry);
          return { allowed: true, remaining: limit - entry.count };
        }
        return { allowed: false, remaining: 0 };
      } catch {
        return { allowed: true, remaining: null, failOpen: true };
      }
    },
  };
}
