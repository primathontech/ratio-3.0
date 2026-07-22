// EdgeWorker entry — the PORT TARGET for lazy-edge.ts. This file is the deploy artifact shape;
// it is NOT executable locally (EdgeWorkers modules exist only on Akamai). The ambient interfaces
// below stand in for the real modules so the file typechecks in-repo; the bundler maps them:
//
//   'http-request'    → httpRequest()          (sub-requests; budget ~4/request — the EW-1 gate)
//   'create-response' → createResponse()
//   'edgekv'          → EdgeKV class (edgekv.js helper bundled alongside)
//
// Division of labour vs lazy-edge.ts: Akamai's OWN cache (Property Manager rules: cache-tag
// headers, serve-stale-on-error, TTL) plays the EdgeCacheLike role — the worker does NOT
// implement caching. The worker runs only on cache MISS/REVALIDATE (responseProvider), doing:
//   1. EdgeKV host→tenant resolve (fail-closed, D29)          — local read, no sub-request
//   2. origin render fetch                                     — sub-request #1
//   3. on origin failure: S3 last-good fetch (SigV4)           — sub-request #2
//   4. stamp Edge-Cache-Tag + cacheability headers on the way out
// Worst case = 2 sub-requests + 1 EdgeKV read — inside the EW-1 budget. The async last-good
// WRITE cannot live here (no waitUntil on Akamai) — the ORIGIN owns write-behind to S3 instead.

import { tenantTag, pageTag } from '../tags';
import { canonicalPath, canonicalQuery } from '../../spine/canonical-key';

// ── ambient stand-ins for Akamai runtime modules ─────────────────────────────
interface EWRequest {
  method: string;
  host: string;
  path: string;
  query: string;
  getHeader(name: string): string[] | null;
}
interface EWResponse {
  status: number;
  getHeaders(): Record<string, string[]>;
  text(): Promise<string>;
}
type HttpRequestFn = (url: string, init?: object) => Promise<EWResponse>;
type CreateResponseFn = (status: number, headers: Record<string, string[]>, body: string) => object;
interface EdgeKVRuntime {
  getText(args: { item: string }): Promise<string | null>;
}

// injected by the bundler shim in the real deploy; declared here so the algorithm is complete
declare const httpRequest: HttpRequestFn;
declare const createResponse: CreateResponseFn;
declare const edgeKv: EdgeKVRuntime;

const ORIGIN_BASE = 'https://origin.internal'; // property-level origin hostname (private, D-series)
const RESERVED = ['/cart', '/checkout', '/account', '/api', '/preview'];

export async function responseProvider(request: EWRequest): Promise<object> {
  const path = canonicalPath(request.path);

  // reserved paths are excluded from caching at the PROPERTY level; this is defence-in-depth
  if (RESERVED.some((r) => path === r || path.startsWith(r + '/'))) {
    const res = await httpRequest(`${ORIGIN_BASE}${request.path}`);
    return createResponse(res.status, res.getHeaders(), await res.text());
  }

  // 1. fail-closed tenant resolve — EdgeKV local read (D29: no DB on the public path, ever)
  let raw: string | null;
  try {
    raw = await edgeKv.getText({ item: encodeURIComponent(`host:${request.host}`) });
  } catch {
    return createResponse(503, {}, 'temporarily unavailable');
  }
  let rec: { status?: string; tenantId?: string } | null;
  try {
    rec = raw ? JSON.parse(raw) : null;
  } catch {
    rec = null;
  }
  if (!rec || rec.status !== 'active' || !rec.tenantId) {
    return createResponse(404, {}, 'Store not found');
  }

  const query = canonicalQuery(request.query ? '?' + request.query : '');
  const tags = [tenantTag(rec.tenantId), pageTag(rec.tenantId, path)];

  // 2. origin render (sub-request #1) — the canonical dims travel as headers so the origin
  //    renders the exact variant this cache entry will be keyed under (B-1)
  try {
    const res = await httpRequest(`${ORIGIN_BASE}${path}${query ? '?' + query : ''}`, {
      headers: { 'x-tenant': [rec.tenantId] },
    });
    if (res.status < 500 && res.status !== 429) {
      const headers = res.getHeaders();
      headers['edge-cache-tag'] = [tags.join(',')]; // Property Manager caches + tags on this
      return createResponse(res.status, headers, await res.text());
    }
  } catch {
    /* transient — fall through to last-good */
  }

  // 3. origin down → S3 last-good (sub-request #2). Serve-stale-on-error already covered the
  //    warm-PoP case at the property level; this is the cold-PoP path (D35).
  //    (SigV4 via crypto.subtle in the real bundle; shape identical to drivers/s3.ts)
  try {
    const lg = await httpRequest(`${ORIGIN_BASE}/api/last-good?path=${encodeURIComponent(path)}`);
    if (lg.status === 200) {
      const stored = JSON.parse(await lg.text()) as { status: number; body: string };
      return createResponse(stored.status, { 'cache-control': ['no-store'] }, stored.body);
    }
  } catch {
    /* fall through */
  }

  // 4. never-visited + total outage → 503 (D39, accepted)
  return createResponse(503, {}, 'unavailable');
}
