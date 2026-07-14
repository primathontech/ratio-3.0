// OFCE-412 / audit M-5: dedupe mutating operations by an idempotency key so a retry,
// refresh, or double-submit re-uses the first result instead of re-running the work (the
// AI assistant can create stores/pages/domains — re-running duplicates them). In-memory per
// process — fine for the single-container admin-api; a multi-instance deploy needs a shared
// store. Failures are NOT cached, so a genuinely failed attempt can be retried.

export interface IdempotencyStore {
  run<T>(key: string | null, thunk: () => Promise<T>): Promise<T>;
}

export function createIdempotencyStore({
  ttlMs = 600_000,
  now = () => Date.now(),
}: { ttlMs?: number; now?: () => number } = {}): IdempotencyStore {
  const map = new Map<string, { at: number; promise: Promise<unknown> }>();
  return {
    run<T>(key: string | null, thunk: () => Promise<T>): Promise<T> {
      if (!key) return thunk(); // no key → no dedup
      const hit = map.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.promise as Promise<T>;
      const promise = thunk();
      map.set(key, { at: now(), promise });
      // Don't cache a failure — drop it so the caller can retry a genuinely failed attempt.
      promise.catch(() => {
        if (map.get(key)?.promise === promise) map.delete(key);
      });
      return promise;
    },
  };
}
