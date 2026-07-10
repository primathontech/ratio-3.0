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
  return {
    check(tenantId: string): RateResult {
      if (!tenantId || typeof tenantId !== 'string') {
        throw new Error('rate limit requires a tenantId');
      }
      try {
        const t = now();
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
