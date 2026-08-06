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

interface Queryable {
  query(
    text: string,
    params?: unknown[]
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}

export interface AsyncRateLimiter {
  check(key: string): Promise<RateResult>;
}

// Shared (Postgres-backed) fixed-window limiter (audit H-1): the effective limit holds across
// admin-api instances, unlike the in-memory createRateLimiter. One atomic upsert per check
// increments the current window, or resets it if the window elapsed. Fails OPEN on any DB
// error (ADR-008) — a limiter outage must not take down the whole API. Stale keys are swept
// at most once per window.
export function createPgRateLimiter(
  db: Queryable,
  {
    limit = 100,
    windowMs = 60_000,
    now = () => Date.now(),
  }: {
    limit?: number;
    windowMs?: number;
    now?: () => number;
  } = {}
): AsyncRateLimiter {
  let lastSweep = now();
  return {
    async check(key: string): Promise<RateResult> {
      if (!key || typeof key !== 'string') throw new Error('rate limit requires a key');
      try {
        const t = now();
        if (t - lastSweep >= windowMs) {
          lastSweep = t;
          await db.query('DELETE FROM rate_counters WHERE reset_at < now()').catch(() => {});
        }
        // Atomic: start a fresh window (count=1) if none/expired, else increment in place.
        const { rows } = await db.query(
          `INSERT INTO rate_counters (key, count, reset_at)
             VALUES ($1, 1, now() + ($2 * interval '1 millisecond'))
           ON CONFLICT (key) DO UPDATE SET
             count = CASE WHEN rate_counters.reset_at < now() THEN 1 ELSE rate_counters.count + 1 END,
             reset_at = CASE WHEN rate_counters.reset_at < now()
                             THEN now() + ($2 * interval '1 millisecond') ELSE rate_counters.reset_at END
           RETURNING count`,
          [key, windowMs]
        );
        const count = Number(rows[0]?.count ?? 1);
        return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
      } catch {
        return { allowed: true, remaining: null, failOpen: true };
      }
    },
  };
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
