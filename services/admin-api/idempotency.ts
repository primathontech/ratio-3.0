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

// Thrown when another (instance's) run already holds the key and is still executing. The route
// maps it to 409 so the caller retries rather than treating it as a new run.
export class IdempotencyInProgressError extends Error {
  constructor() {
    super('that request is already being processed — retry shortly');
    this.name = 'IdempotencyInProgressError';
  }
}

interface Queryable {
  query(
    text: string,
    params?: unknown[]
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}

// Shared idempotency store backed by Postgres (audit H-1) — dedup + single-execution hold
// across admin-api instances. The unique PK makes exactly one instance the "owner" of a key;
// it runs the work and records the result, others return the cached result or a 409 while it's
// still running. Failures are not cached. Rows past the TTL are reclaimable (a crashed owner
// never strands a key).
export function createPgIdempotencyStore(
  db: Queryable,
  { ttlMs = 600_000, now = () => Date.now() }: { ttlMs?: number; now?: () => number } = {}
): IdempotencyStore {
  const tryClaim = async (key: string): Promise<boolean> => {
    const r = await db.query(
      `INSERT INTO idempotency_keys (key, status) VALUES ($1, 'running')
       ON CONFLICT (key) DO NOTHING RETURNING key`,
      [key]
    );
    return (r.rowCount ?? 0) > 0;
  };

  // Returns { owned: true } if this call should run the work, or { owned: false, result } with a
  // cached result. Throws IdempotencyInProgressError if another owner is mid-run.
  async function claimOrResolve<T>(
    key: string
  ): Promise<{ owned: true } | { owned: false; result: T }> {
    if (await tryClaim(key)) return { owned: true };
    const row = (
      await db.query('SELECT status, result, created_at FROM idempotency_keys WHERE key = $1', [
        key,
      ])
    ).rows[0];
    if (!row) {
      // The row was deleted (a failed run) between our insert-conflict and this read — retry once.
      if (await tryClaim(key)) return { owned: true };
      throw new IdempotencyInProgressError();
    }
    const ageMs = now() - new Date(row.created_at as string).getTime();
    if (ageMs < ttlMs) {
      if (row.status === 'done') return { owned: false, result: row.result as T };
      throw new IdempotencyInProgressError(); // running, within TTL
    }
    // Expired (a done row past TTL, or a running row whose owner died) — reclaim. The age guard
    // (evaluated at update time) makes exactly one instance win: the winner sets created_at=now(),
    // so a racing update no longer sees an expired row and affects 0 rows.
    const retake = await db.query(
      `UPDATE idempotency_keys SET status='running', result=NULL, created_at=now()
       WHERE key = $1 AND created_at < now() - ($2 * interval '1 millisecond') RETURNING key`,
      [key, ttlMs]
    );
    if ((retake.rowCount ?? 0) > 0) return { owned: true };
    const again = (
      await db.query('SELECT status, result FROM idempotency_keys WHERE key = $1', [key])
    ).rows[0];
    if (again?.status === 'done') return { owned: false, result: again.result as T };
    throw new IdempotencyInProgressError();
  }

  return {
    async run<T>(key: string | null, thunk: () => Promise<T>): Promise<T> {
      if (!key) return thunk();
      const claim = await claimOrResolve<T>(key);
      if (!claim.owned) return claim.result;
      try {
        const result = await thunk();
        await db.query(`UPDATE idempotency_keys SET status='done', result=$2::jsonb WHERE key=$1`, [
          key,
          JSON.stringify(result ?? null),
        ]);
        return result;
      } catch (e) {
        await db
          .query(`DELETE FROM idempotency_keys WHERE key=$1 AND status='running'`, [key])
          .catch(() => {});
        throw e;
      }
    },
    size: () => 0, // not tracked for the shared store
  };
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
