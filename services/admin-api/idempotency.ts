// OFCE-412 / audit M-5: dedupe mutating operations by an idempotency key so a retry,
// refresh, or double-submit re-uses the first result instead of re-running the work (the
// AI assistant can create stores/pages/domains — re-running duplicates them). In-memory per
// process — fine for the single-container admin-api; a multi-instance deploy needs a shared
// store. Failures are NOT cached, so a genuinely failed attempt can be retried.

import { createHash } from 'node:crypto';

export interface IdempotencyStore {
  run<T>(key: string | null, thunk: () => Promise<T>): Promise<T>;
  size(): number; // live entry count (for tests / observability)
}

// The idempotency key for an assistant run. A client-supplied key wins (a network retry of the
// same submit re-uses it). Otherwise derive one from the content (L-2) so an accidental
// double-submit of the identical request still dedupes. The `k:`/`c:` prefixes keep the two
// namespaces from ever colliding; the message is hashed so long prompts don't bloat the key.
export function idempotencyKeyFor(opts: {
  userId: string;
  storeId?: string;
  message: string;
  clientKey?: string | null;
}): string {
  const { userId, storeId, message, clientKey } = opts;
  if (clientKey) return `k:${userId}:${clientKey}`;
  const hash = createHash('sha256').update(message.trim()).digest('hex');
  return `c:${userId}:${storeId ?? ''}:${hash}`;
}

export function createIdempotencyStore({
  ttlMs = 600_000,
  now = () => Date.now(),
}: { ttlMs?: number; now?: () => number } = {}): IdempotencyStore {
  const map = new Map<string, { at: number; promise: Promise<unknown> }>();
  // Drop everything past its TTL. Bounds memory (M-1): without this, successful entries were
  // never evicted and the map grew forever (a fresh UUID key per assistant send).
  const sweep = () => {
    const t = now();
    for (const [k, v] of map) if (t - v.at >= ttlMs) map.delete(k);
  };
  return {
    run<T>(key: string | null, thunk: () => Promise<T>): Promise<T> {
      if (!key) return thunk(); // no key → no dedup
      sweep();
      const hit = map.get(key);
      if (hit) return hit.promise as Promise<T>; // still-live entries only (sweep removed stale)
      const promise = thunk();
      map.set(key, { at: now(), promise });
      // Don't cache a failure — drop it so the caller can retry a genuinely failed attempt.
      promise.catch(() => {
        if (map.get(key)?.promise === promise) map.delete(key);
      });
      return promise;
    },
    size: () => map.size,
  };
}
