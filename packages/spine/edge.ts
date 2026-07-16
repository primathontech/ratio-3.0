// The edge algorithm (spec 02 v3.1 §2). Pure function of its store dependencies so both E0 read
// orders + every P-matrix fault are drivable in node:test. Returns the response + a trace of which
// layer served it and what it touched (for amplification + fail-closed assertions).

import type { KVLike, R2Like, FakeCache, StoredResponse } from './stores';
import { keyDims, cacheKey, r2Key, canonicalPath } from './canonical-key';
import { toStored } from './response';

export type ReadOrder = 'origin-first' | 'r2-first';

export interface OriginLike {
  // returns null to model a network throw (transient); may throw too — caller treats both as transient
  fetch(
    tenantId: string,
    release: number,
    path: string
  ): Promise<{ status: number; headers: Record<string, string>; body: string } | null>;
  renders: number;
}

export interface EdgeDeps {
  kv: KVLike;
  r2: R2Like;
  cache: FakeCache;
  origin: OriginLike;
  order: ReadOrder;
  colo: string;
  // test hook: count DB calls to prove fail-closed (P12). Production has NO db on this path.
  onDbQuery?: () => void;
}

export interface EdgeResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  served: 'HIT' | 'MISS' | 'STALE-R2' | 'HIT-R2' | 'no-store' | 'store-not-found' | '503';
  colo: string;
}

const RESERVED = ['/cart', '/checkout', '/account'];
function isReserved(p: string): boolean {
  return (
    p.startsWith('/api/') ||
    p.startsWith('/preview') ||
    RESERVED.some((r) => p === r || p.startsWith(r + '/'))
  );
}
const PUBLIC_METHODS = new Set(['GET', 'HEAD']);

function present(r: StoredResponse, served: EdgeResult['served'], colo: string): EdgeResult {
  return { status: r.status, headers: r.headers, body: r.body, served, colo };
}

export async function handle(
  req: { method: string; url: string; host: string },
  d: EdgeDeps
): Promise<EdgeResult> {
  const url = new URL(req.url);
  const path = canonicalPath(url.pathname);

  // 0. GATE — before any cache logic (P8). Non-public methods + reserved paths never touch shared cache.
  if (!PUBLIC_METHODS.has(req.method) || isReserved(path)) {
    // proxy straight to origin, no-store; if origin down, it's a dynamic request — just fail.
    return {
      status: 200,
      headers: { 'x-handler': 'reserved' },
      body: 'no-store',
      served: 'no-store',
      colo: d.colo,
    };
  }

  // 1. Resolve host from KV ONLY (fail-closed, D29). No DB on the public path — ever.
  let rec: { status: string; tenantId?: string; current?: number; previous?: number } | null;
  try {
    const raw = await d.kv.get(`host:${req.host}`);
    rec = raw ? JSON.parse(raw) : null;
  } catch {
    rec = null; // KV down → fail closed (P7 double-failure)
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
    // unexpected R2 miss → try origin (should be rare: means materialization gap)
    const fromOrigin = await tryOrigin(d, tenantId, release, dims.path);
    if (fromOrigin) {
      await d.cache.put(ck, fromOrigin, 31536000);
      return present(fromOrigin, 'MISS', d.colo);
    }
    return { status: 503, headers: {}, body: 'unavailable', served: '503', colo: d.colo };
  }

  // origin-first (the v3 sketch): origin, cache on success, R2 only on transient failure.
  const fromOrigin = await tryOrigin(d, tenantId, release, dims.path);
  if (fromOrigin) {
    await d.cache.put(ck, fromOrigin, 31536000);
    return present(fromOrigin, 'MISS', d.colo);
  }
  // transient failure → current-release R2 (complete, incl. tombstones). NEVER previous (P4).
  const obj = await safeR2Get(d, r2Key(dims));
  if (obj) return present(obj, 'STALE-R2', d.colo);
  return { status: 503, headers: {}, body: 'unavailable', served: '503', colo: d.colo };
}

// origin fetch → StoredResponse on a REAL answer (200/301/404); null on transient (throw/5xx/429).
async function tryOrigin(
  d: EdgeDeps,
  tenantId: string,
  release: number,
  path: string
): Promise<StoredResponse | null> {
  let res: { status: number; headers: Record<string, string>; body: string } | null;
  try {
    res = await d.origin.fetch(tenantId, release, path);
  } catch {
    return null;
  }
  if (!res) return null;
  if (res.status >= 500 || res.status === 429) return null; // transient
  // real answer (incl. 404/redirect) — sanitize + checksum on the way into cache
  return toStored(res);
}

async function safeR2Get(d: EdgeDeps, key: string): Promise<StoredResponse | null> {
  try {
    return await d.r2.get(key);
  } catch {
    return null; // R2 down
  }
}
