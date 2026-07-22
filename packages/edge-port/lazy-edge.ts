// The D38 edge algorithm: lazy render-on-first-visit + purge-on-change. Supersedes the D28
// pre-materialize path for the common case (spine/edge.ts stays as the historical POC-1 artifact).
//
//   first visit  → origin renders → cache at edge (tagged) + async last-good write to S3
//   repeat visit → edge HIT, zero origin work
//   edit         → save DB → Fast Purge invalidate by tag (stale, NOT delete) → next visit revalidates
//   origin error → serve the stale copy (Akamai serve-stale-on-error) or the S3 last-good
//   never-visited page + total outage → 503 — the D39-accepted tradeoff, by design
//
// What survives from POC-1 unchanged: canonical key (P9), fail-closed KV host resolution (D29),
// the GET/HEAD + reserved-path gate (P8), cache-only-when-origin-opts-in (B-2), per-user content
// never in the shell. What's gone: release pointer in the key (purge-by-tag replaces it), route
// index + tombstone materialization (origin's own 404 is rendered, cached, and purged like a page).

import type { KVLike, R2Like, StoredResponse } from '../spine/stores';
import type { OriginLike } from '../spine/edge';
import { keyDims, cacheKey, r2Key, canonicalPath, type KeyDims } from '../spine/canonical-key';
import { toStored } from '../spine/response';
import type { EdgeCacheLike } from './akamai-cache';
import { tenantTag, pageTag } from './tags';

// Keys are versionless under lazy+purge — the release dimension is pinned to this constant so the
// canonical-key machinery (and its P9 guarantees) is reused verbatim.
export const LIVE = 'live';

export interface LazyEdgeDeps {
  kv: KVLike; // host → tenant resolution (fail-closed, D29)
  cache: EdgeCacheLike; // Akamai edge cache (tag-aware, stale-capable)
  lastGood: R2Like; // S3 — durable last-good copy, the cold-PoP/outage backstop (D35)
  origin: OriginLike;
  colo: string;
  // async work that must not block or fail the response (the last-good write). EdgeWorkers has no
  // waitUntil — the real port does this via a sub-request it doesn't await; tests inject a
  // collector so they can await completion deterministically.
  waitUntil?: (p: Promise<unknown>) => void;
}

export interface LazyEdgeResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  served:
    | 'HIT' // fresh edge hit
    | 'MISS' // first visit — origin rendered
    | 'REVALIDATED' // stale hit, origin re-rendered fine
    | 'STALE' // stale hit, origin down → serve-stale-on-error
    | 'STALE-S3' // cold PoP, origin down → S3 last-good
    | 'no-store'
    | 'store-not-found'
    | 'kv-unavailable'
    | '503';
  colo: string;
}

const RESERVED = ['/cart', '/checkout', '/account', '/api', '/preview'];
function isReserved(p: string): boolean {
  return RESERVED.some((r) => p === r || p.startsWith(r + '/'));
}
const PUBLIC_METHODS = new Set(['GET', 'HEAD']);
const SHELL_TTL = 31536000; // effectively-forever fresh; purge is the invalidator, not TTL

function present(
  r: StoredResponse,
  served: LazyEdgeResult['served'],
  colo: string
): LazyEdgeResult {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers))
    if (!k.toLowerCase().startsWith('x-')) headers[k] = v;
  headers['cache-control'] = 'public, max-age=0, must-revalidate';
  return { status: r.status, headers, body: r.body, served, colo };
}

function schedule(d: LazyEdgeDeps, p: Promise<unknown>): void {
  if (d.waitUntil) d.waitUntil(p.catch(() => {}));
  else void p.catch(() => {}); // never let the backstop write fail the response
}

// Write-behind to S3: last-good for servable pages; a REAL 404 overwrites as a tombstone so a
// deleted page can never resurrect from S3 during an outage (the D28 tombstone lesson, lazy form).
function writeLastGood(d: LazyEdgeDeps, dims: KeyDims, stored: StoredResponse): void {
  schedule(d, d.lastGood.put(r2Key(dims), stored));
}

export async function handleLazy(
  req: { method: string; url: string; host: string },
  d: LazyEdgeDeps
): Promise<LazyEdgeResult> {
  const url = new URL(req.url);
  const path = canonicalPath(url.pathname);

  // 0. GATE — reserved paths + non-public methods never touch cache logic (P8).
  if (!PUBLIC_METHODS.has(req.method) || isReserved(path)) {
    return {
      status: 200,
      headers: { 'x-handler': 'reserved' },
      body: 'no-store',
      served: 'no-store',
      colo: d.colo,
    };
  }

  // 1. Fail-closed host resolution (D29) — KV only, never DB on the public path. Outage (503,
  //    retryable) is distinguished from absent/suspended/malformed (404). The record no longer
  //    needs current/previous (D38) — only {status, tenantId}.
  let raw: string | null;
  try {
    raw = await d.kv.get(`host:${req.host}`);
  } catch {
    return {
      status: 503,
      headers: {},
      body: 'temporarily unavailable',
      served: 'kv-unavailable',
      colo: d.colo,
    };
  }
  let rec: { status?: string; tenantId?: string } | null;
  try {
    rec = raw ? JSON.parse(raw) : null;
  } catch {
    rec = null;
  }
  if (!rec || rec.status !== 'active' || rec.tenantId == null) {
    return {
      status: 404,
      headers: {},
      body: 'Store not found',
      served: 'store-not-found',
      colo: d.colo,
    };
  }
  const tenantId = rec.tenantId;
  const dims = keyDims(tenantId, LIVE, url);
  const ck = cacheKey(dims);
  const tags = [tenantTag(tenantId), pageTag(tenantId, dims.path)];

  // 2. Edge cache. Fresh → done. Stale (TTL or purge-invalidate) → revalidate at origin,
  //    serve-stale-on-error if origin can't answer.
  const hit = await d.cache.match(ck);
  if (hit && hit.state === 'fresh') return present(hit.res, 'HIT', d.colo);

  const fromOrigin = await tryOrigin(d, dims);
  if (fromOrigin) {
    // real answer from origin — re-cache if it opts in (B-2), else drop any stale copy so a page
    // that became non-cacheable can't keep serving from the stale window on future errors.
    if (fromOrigin.cacheable) {
      await d.cache.put(ck, fromOrigin.stored, tags, SHELL_TTL);
      writeLastGood(d, dims, fromOrigin.stored);
    } else {
      if (hit) await d.cache.delete(ck);
      // a REAL 404 tombstones last-good even when non-cacheable — a deleted page must not
      // resurrect from S3 during a later outage just because origin didn't opt the 404 in.
      if (fromOrigin.stored.status === 404) writeLastGood(d, dims, fromOrigin.stored);
    }
    return present(fromOrigin.stored, hit ? 'REVALIDATED' : 'MISS', d.colo);
  }

  // 3. Origin transient failure. Warm PoP → serve the stale copy (Akamai serve-stale-on-error —
  //    the property that makes lazy SAFE where CF couldn't, D38). Cold PoP → S3 last-good (D35).
  if (hit) return present(hit.res, 'STALE', d.colo);
  const lastGood = await safeGet(d.lastGood, r2Key(dims));
  if (lastGood) return present(lastGood, 'STALE-S3', d.colo);

  // 4. Never-visited page + origin down: nothing to serve. Accepted (D39) — zero-traffic pages.
  return { status: 503, headers: {}, body: 'unavailable', served: '503', colo: d.colo };
}

// Origin fetch → real answer or null on transient (throw / 5xx / 429) — same contract as POC-1.
async function tryOrigin(
  d: LazyEdgeDeps,
  dims: KeyDims
): Promise<{ stored: StoredResponse; cacheable: boolean } | null> {
  let res: Awaited<ReturnType<OriginLike['fetch']>>;
  try {
    res = await d.origin.fetch(dims);
  } catch {
    return null;
  }
  if (!res) return null;
  if (res.status >= 500 || res.status === 429) return null;
  return { stored: toStored(res), cacheable: res.cacheable };
}

async function safeGet(store: R2Like, key: string): Promise<StoredResponse | null> {
  try {
    return await store.get(key);
  } catch {
    return null;
  }
}
