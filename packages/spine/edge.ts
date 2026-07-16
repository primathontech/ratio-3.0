// The edge algorithm (spec 02 v3.1 §2). Pure function of its store dependencies so both E0 read
// orders + every P-matrix fault are drivable in node:test. Returns the response + a trace of which
// layer served it and what it touched (for amplification + fail-closed assertions).

import type { KVLike, R2Like, FakeCache, StoredResponse } from './stores';
import { keyDims, cacheKey, r2Key, canonicalPath, type KeyDims } from './canonical-key';
import { toStored } from './response';

export type ReadOrder = 'origin-first' | 'r2-first';

export interface OriginLike {
  // Renders for a specific canonical request. dims carries query/segment/locale so the origin
  // renders the SAME variant the edge will cache under (B-1). Returns null to model a network
  // throw (transient); may also throw. `cacheable` mirrors the origin's `x-cache: long` opt-in.
  fetch(
    dims: KeyDims
  ): Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
    cacheable: boolean;
  } | null>;
  renders: number;
}

export interface EdgeDeps {
  kv: KVLike;
  r2: R2Like;
  cache: FakeCache;
  origin: OriginLike;
  order: ReadOrder;
  colo: string;
}

export interface EdgeResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  served:
    | 'HIT'
    | 'MISS'
    | 'STALE-R2'
    | 'HIT-R2'
    | 'INDEX-404'
    | 'no-store'
    | 'store-not-found'
    | 'kv-unavailable'
    | '503';
  colo: string;
}

const RESERVED = ['/cart', '/checkout', '/account', '/api', '/preview'];
function isReserved(p: string): boolean {
  // exact-or-slash for every reserved prefix (P8 fix #16: /api and /preview were over/under-broad)
  return RESERVED.some((r) => p === r || p.startsWith(r + '/'));
}
const PUBLIC_METHODS = new Set(['GET', 'HEAD']);

// browser-facing headers: strip internal x-* + stamp a conservative Cache-Control per class (#14).
function present(r: StoredResponse, served: EdgeResult['served'], colo: string): EdgeResult {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers))
    if (!k.toLowerCase().startsWith('x-')) headers[k] = v;
  headers['cache-control'] = 'public, max-age=0, must-revalidate';
  return {
    status: r.status,
    headers,
    body: served === 'HIT' && r.status === 200 ? r.body : r.body,
    served,
    colo,
  };
}

const ROUTE_INDEX = (tenantId: string, releaseId: number) => `idx/${tenantId}/${releaseId}`;

export async function handle(
  req: { method: string; url: string; host: string; cookie?: string },
  d: EdgeDeps
): Promise<EdgeResult> {
  const url = new URL(req.url);
  const path = canonicalPath(url.pathname);

  // 0. GATE — before any cache logic (P8). Non-public methods + reserved paths never touch cache.
  if (!PUBLIC_METHODS.has(req.method) || isReserved(path)) {
    return {
      status: 200,
      headers: { 'x-handler': 'reserved' },
      body: 'no-store',
      served: 'no-store',
      colo: d.colo,
    };
  }

  // 1. Resolve host from KV ONLY (fail-closed, D29). No DB on the public path — ever.
  //    Distinguish a KV OUTAGE (503, retryable) from a genuinely-absent/suspended host (404).
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
  let rec: { status: string; tenantId?: string; current?: number; previous?: number } | null;
  try {
    rec = raw ? JSON.parse(raw) : null;
  } catch {
    rec = null; // malformed record → treat as absent (404)
  }
  if (!rec || rec.status !== 'active' || rec.tenantId == null || rec.current == null) {
    return {
      status: 404,
      headers: {},
      body: 'Store not found',
      served: 'store-not-found',
      colo: d.colo,
    };
  }
  const tenantId = rec.tenantId;
  const release = rec.current;
  const dims = keyDims(tenantId, release, url);
  const ck = cacheKey(dims);

  // 2. Cache API (per-PoP) first in BOTH orders.
  const cached = await d.cache.match(ck);
  if (cached) return present(cached, 'HIT', d.colo);

  if (d.order === 'r2-first') {
    // R2 is complete per release (D28) → serve it directly; origin only if unexpectedly missing.
    const obj = await safeR2Get(d, r2Key(dims));
    if (obj) {
      await d.cache.put(ck, obj, 31536000);
      return present(obj, 'HIT-R2', d.colo);
    }
    // unexpected R2 miss → route index decides 404 vs origin-fill (never 503 for a known-unknown)
    const idx404 = await indexSays404(d, tenantId, release, dims.path);
    if (idx404) return idx404;
    const fromOrigin = await tryOrigin(d, dims);
    if (fromOrigin) {
      await d.cache.put(ck, fromOrigin.stored, 31536000);
      return present(fromOrigin.stored, 'MISS', d.colo);
    }
    return { status: 503, headers: {}, body: 'unavailable', served: '503', colo: d.colo };
  }

  // origin-first (the v3 sketch): origin, cache ONLY on ok + x-cache:long (B-2), R2 on transient.
  const fromOrigin = await tryOrigin(d, dims);
  if (fromOrigin) {
    if (fromOrigin.stored.status < 400 && fromOrigin.cacheable) {
      await d.cache.put(ck, fromOrigin.stored, 31536000);
    }
    return present(fromOrigin.stored, 'MISS', d.colo);
  }
  // transient failure → current-release R2 (complete, incl. tombstones). NEVER previous (P4).
  const obj = await safeR2Get(d, r2Key(dims));
  if (obj) return present(obj, 'STALE-R2', d.colo);
  // R2 also missing/down → route index gives a correct 404 for a known-unknown path (H-6).
  const idx404 = await indexSays404(d, tenantId, release, dims.path);
  if (idx404) return idx404;
  return { status: 503, headers: {}, body: 'unavailable', served: '503', colo: d.colo };
}

// origin fetch → {stored, cacheable} on a REAL answer; null on transient (throw/5xx/429).
async function tryOrigin(
  d: EdgeDeps,
  dims: KeyDims
): Promise<{ stored: StoredResponse; cacheable: boolean } | null> {
  let res: {
    status: number;
    headers: Record<string, string>;
    body: string;
    cacheable: boolean;
  } | null;
  try {
    res = await d.origin.fetch(dims);
  } catch {
    return null;
  }
  if (!res) return null;
  if (res.status >= 500 || res.status === 429) return null; // transient
  return { stored: toStored(res), cacheable: res.cacheable };
}

async function safeR2Get(d: EdgeDeps, key: string): Promise<StoredResponse | null> {
  try {
    return await d.r2.get(key);
  } catch {
    return null; // R2 down
  }
}

// Consult the per-release route index: if the path is absent, it's a known-unknown → synthesize a
// 404 that survives a total origin+DB outage (spec v3.1 unknown-path rule). Index unreachable → null.
async function indexSays404(
  d: EdgeDeps,
  tenantId: string,
  release: number,
  path: string
): Promise<EdgeResult | null> {
  let idx: StoredResponse | null;
  try {
    idx = await d.r2.get(ROUTE_INDEX(tenantId, release));
  } catch {
    return null;
  }
  if (!idx) return null;
  try {
    const index = JSON.parse(idx.body) as Record<string, unknown>;
    if (!(path in index)) {
      return {
        status: 404,
        headers: { 'cache-control': 'public, max-age=0' },
        body: 'Not found',
        served: 'INDEX-404',
        colo: d.colo,
      };
    }
  } catch {
    return null;
  }
  return null; // path IS in the index but its object was unreachable → let caller 503
}
