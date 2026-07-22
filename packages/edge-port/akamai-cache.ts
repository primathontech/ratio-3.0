// Akamai edge-cache semantics, faked for local proofs — the Track-3 counterpart of FakeCache.
// Two properties distinguish Akamai from the CF Cache API, and BOTH are load-bearing for D38:
//
//   1. Fast Purge **invalidate mode** marks entries STALE — it does not delete them. A stale entry
//      is revalidated at origin on next hit; if origin is down, serve-stale-on-error hands out the
//      stale copy. This dissolves the A3 hole ("purge deletes → nothing to serve stale") that was
//      CF-specific and forced the D28 pre-materialization design.
//   2. Purge is **by cache-tag** (native, standard contract) — no Enterprise gate, no pointer bump.
//
// TTL expiry ALSO degrades to stale (not gone): Akamai keeps the object for revalidation within a
// bounded window. `maxStaleSeconds` models that window — past it the object is genuinely evicted,
// which is what makes "serve-stale forever" impossible and the S3 last-good layer still necessary.

import type { StoredResponse } from '../spine/stores';

export type CacheState = 'fresh' | 'stale';

export interface CacheHit {
  res: StoredResponse;
  state: CacheState;
}

export interface EdgeCacheLike {
  match(key: string): Promise<CacheHit | null>;
  put(key: string, res: StoredResponse, tags: string[], ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

// The purge contract the control plane calls (real impl: drivers/fastpurge.ts → CCU v3).
export interface PurgeLike {
  invalidateByTags(tags: string[]): Promise<void>; // mark stale, serve-until-revalidated (default)
  deleteByTags(tags: string[]): Promise<void>; // hard remove — emergency use only
}

interface Entry {
  res: StoredResponse;
  tags: Set<string>;
  freshUntil: number; // epoch ms — fresh before this
  invalidated: boolean; // Fast Purge invalidate hit this entry
}

export class FakeAkamaiCache implements EdgeCacheLike, PurgeLike {
  private m = new Map<string, Entry>();
  constructor(
    private clock: () => number,
    private maxStaleSeconds = 7 * 24 * 3600
  ) {}

  async match(key: string): Promise<CacheHit | null> {
    const e = this.m.get(key);
    if (!e) return null;
    const now = this.clock();
    // past the bounded stale window → genuinely gone (models Akamai eviction)
    if (now >= e.freshUntil + this.maxStaleSeconds * 1000) {
      this.m.delete(key);
      return null;
    }
    const state: CacheState = e.invalidated || now >= e.freshUntil ? 'stale' : 'fresh';
    return { res: e.res, state };
  }

  async put(key: string, res: StoredResponse, tags: string[], ttlSeconds: number): Promise<void> {
    this.m.set(key, {
      res,
      tags: new Set(tags),
      freshUntil: this.clock() + ttlSeconds * 1000,
      invalidated: false,
    });
  }

  async delete(key: string): Promise<void> {
    this.m.delete(key);
  }

  async invalidateByTags(tags: string[]): Promise<void> {
    for (const e of this.m.values()) if (tags.some((t) => e.tags.has(t))) e.invalidated = true;
  }

  async deleteByTags(tags: string[]): Promise<void> {
    for (const [k, e] of this.m) if (tags.some((t) => e.tags.has(t))) this.m.delete(k);
  }

  raw() {
    return this.m;
  }
}
