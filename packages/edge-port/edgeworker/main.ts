// EdgeWorker entry — the PORT TARGET for lazy-edge.ts. This file is the deploy artifact shape;
// it is NOT executable locally (EdgeWorkers modules exist only on Akamai). The ambient interfaces
// below stand in for the real modules so the file typechecks in-repo; the bundler maps them:
//
//   'http-request'    → httpRequest()          (sub-requests; budget ~4/request — the EW-1 gate)
//   'create-response' → createResponse()
//   'edgekv'          → EdgeKV class (edgekv.js helper bundled alongside)
//
// Division of labour vs lazy-edge.ts: Akamai's OWN cache (Property Manager rules: Edge-Cache-Tag
// from the ORIGIN response, serve-stale-on-error, TTL) plays the EdgeCacheLike role — the worker
// does NOT implement caching and does NOT stamp tags (the origin does; the worker only forwards).
// The worker runs on cache MISS/REVALIDATE (responseProvider), doing:
//   1. EdgeKV host→tenant resolve (fail-closed, D29)   — local read, no sub-request
//   2. origin render fetch, carrying the private-origin contract (x-edge-auth + x-ratio-tenant)
//                                                       — sub-request #1
//   3. on origin failure: S3 last-good fetch, SigV4-signed with crypto.subtle (D35) — sub-req #2
// Worst case = 2 sub-requests + 1 EdgeKV read — inside the EW-1 budget. The last-good WRITE never
// happens here (no waitUntil on Akamai) — the ORIGIN owns write-behind (D44, origin-render.ts).
// Reserved paths proxy the FULL request (method, body, headers) — cart/checkout POSTs must arrive
// as POSTs with their bodies and cookies, not as bodyless GETs.

import { edgeKvItemKey } from '../edgekv-key';
import { canonicalPath, canonicalQuery } from '../../spine/canonical-key';

// ── ambient stand-ins for Akamai runtime modules ─────────────────────────────
interface EWRequest {
  method: string;
  host: string;
  path: string;
  query: string;
  getHeader(name: string): string[] | null;
  getVariable(name: string): string | undefined; // PMUSER_* property variables
  text(): Promise<string>; // request body (responseProvider may read it once)
}
interface EWResponse {
  status: number;
  getHeaders(): Record<string, string[]>;
  text(): Promise<string>;
}
type HttpRequestFn = (
  url: string,
  init?: { method?: string; headers?: Record<string, string[]>; body?: string }
) => Promise<EWResponse>;
type CreateResponseFn = (status: number, headers: Record<string, string[]>, body: string) => object;
interface EdgeKVRuntime {
  getText(args: { item: string }): Promise<string | null>;
}
interface SubtleLike {
  importKey(
    format: string,
    keyData: ArrayBuffer | Uint8Array,
    algorithm: object,
    extractable: boolean,
    usages: string[]
  ): Promise<unknown>;
  sign(algorithm: string, key: unknown, data: ArrayBuffer | Uint8Array): Promise<ArrayBuffer>;
  digest(algorithm: string, data: ArrayBuffer | Uint8Array): Promise<ArrayBuffer>;
}

// injected by the bundler shim in the real deploy; declared here so the algorithm is complete
declare const httpRequest: HttpRequestFn;
declare const createResponse: CreateResponseFn;
declare const edgeKv: EdgeKVRuntime;
declare const crypto: { subtle: SubtleLike };

const ORIGIN_BASE = 'https://origin.internal'; // property-level origin hostname (private, D-series)
const RESERVED = ['/cart', '/checkout', '/account', '/api', '/preview'];

// request headers worth forwarding to the private origin (cookies carry the session; the rest
// keep content negotiation honest). Never forward hop-by-hop or spoofable x-* from the client.
const FORWARD_HEADERS = ['cookie', 'content-type', 'accept', 'accept-language', 'user-agent'];

function forwardedHeaders(request: EWRequest, edgeSecret: string, tenantId?: string) {
  const h: Record<string, string[]> = { 'x-edge-auth': [edgeSecret] };
  if (tenantId) h['x-ratio-tenant'] = [tenantId];
  for (const name of FORWARD_HEADERS) {
    const v = request.getHeader(name);
    if (v) h[name] = v;
  }
  return h;
}

export async function responseProvider(request: EWRequest): Promise<object> {
  const path = canonicalPath(request.path);
  // The edge↔origin secret + AWS creds live in Property Manager user variables — never in code.
  const edgeSecret = request.getVariable('PMUSER_EDGE_SECRET') ?? '';

  // reserved paths are excluded from caching at the PROPERTY level; this is defence-in-depth.
  // Proxy the request FAITHFULLY: method, body, cookies — a POST /cart must stay a POST.
  if (RESERVED.some((r) => path === r || path.startsWith(r + '/'))) {
    const body =
      request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();
    const res = await httpRequest(
      `${ORIGIN_BASE}${request.path}${request.query ? '?' + request.query : ''}`,
      { method: request.method, headers: forwardedHeaders(request, edgeSecret), body }
    );
    return createResponse(res.status, res.getHeaders(), await res.text());
  }

  // 1. fail-closed tenant resolve — EdgeKV local read (D29: no DB on the public path, ever).
  //    Item id uses the SAME base64url encoding the control-plane driver writes with.
  let raw: string | null;
  try {
    raw = await edgeKv.getText({ item: edgeKvItemKey(`host:${request.host}`) });
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

  // 2. origin render (sub-request #1) — canonical path+query so the origin renders the exact
  //    variant this cache entry is keyed under (B-1). Origin stamps Edge-Cache-Tag + x-cache;
  //    the property caches on those. The private-origin contract rides along.
  try {
    const res = await httpRequest(`${ORIGIN_BASE}${path}${query ? '?' + query : ''}`, {
      headers: forwardedHeaders(request, edgeSecret, rec.tenantId),
    });
    if (res.status < 500 && res.status !== 429) {
      return createResponse(res.status, res.getHeaders(), await res.text());
    }
  } catch {
    /* transient — fall through to last-good */
  }

  // 3. origin down → S3 last-good DIRECTLY (sub-request #2) — signed with crypto.subtle; the
  //    origin is exactly what just failed, so it can never be the path to the backstop (D35).
  try {
    const stored = await s3GetLastGood(request, rec.tenantId, path, query);
    if (stored) {
      return createResponse(
        stored.status,
        { 'content-type': [stored.headers['content-type'] ?? 'text/html'] },
        stored.body
      );
    }
  } catch {
    /* fall through */
  }

  // 4. never-visited + total outage → 503 (D39, accepted)
  return createResponse(503, {}, 'unavailable');
}

// ── S3 last-good fetch (SigV4 via crypto.subtle — no SDK, no Node APIs) ──────
// Key layout mirrors r2Key(keyDims(tenant,'live',url)): "r2/{tenant}|live|{path}|{query}|..." —
// built with the same encodeURIComponent pieces canonical-key uses, then RFC3986-encoded per URI
// segment exactly like drivers/s3.ts objectPath.

interface StoredLike {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const enc = new TextEncoder();
const rfc3986 = (s: string) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
const hex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}

async function s3GetLastGood(
  request: EWRequest,
  tenantId: string,
  path: string,
  query: string
): Promise<StoredLike | null> {
  const bucket = request.getVariable('PMUSER_S3_BUCKET') ?? '';
  const region = request.getVariable('PMUSER_AWS_REGION') ?? 'ap-south-1';
  const accessKey = request.getVariable('PMUSER_AWS_ACCESS_KEY_ID') ?? '';
  const secretKey = request.getVariable('PMUSER_AWS_SECRET_ACCESS_KEY') ?? '';
  if (!bucket || !accessKey || !secretKey) return null;

  const host = `${bucket}.s3.${region}.amazonaws.com`;
  // same cacheKey composition as canonical-key.ts (tenant|live|path|query|segment|locale|currency)
  const cacheKey = [tenantId, 'live', path, query, 'default', 'default', 'default']
    .map(encodeURIComponent)
    .join('|');
  const uri = '/' + ['r2', cacheKey].map(rfc3986).join('/');

  const now = new Date();
  const dateTime = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const date = dateTime.slice(0, 8);
  const scope = `${date}/${region}/s3/aws4_request`;
  const emptyHash = hex(await crypto.subtle.digest('SHA-256', enc.encode('')));
  const headers = `host:${host}\nx-amz-content-sha256:${emptyHash}\nx-amz-date:${dateTime}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonical = ['GET', uri, '', headers, signedHeaders, emptyHash].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    dateTime,
    scope,
    hex(await crypto.subtle.digest('SHA-256', enc.encode(canonical))),
  ].join('\n');
  let key = await hmac(enc.encode('AWS4' + secretKey), date);
  key = await hmac(key, region);
  key = await hmac(key, 's3');
  key = await hmac(key, 'aws4_request');
  const signature = hex(await hmac(key, stringToSign));

  const res = await httpRequest(`https://${host}${uri}`, {
    headers: {
      authorization: [
        `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      ],
      'x-amz-content-sha256': [emptyHash],
      'x-amz-date': [dateTime],
    },
  });
  if (res.status !== 200) return null;
  return JSON.parse(await res.text()) as StoredLike;
}
