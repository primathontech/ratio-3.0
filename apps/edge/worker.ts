import { Hono } from 'hono';
import { neon } from '@neondatabase/serverless';
import { normalizePage } from '../../packages/content-model/index';
import { renderPage, esc } from '../../packages/theme/index';

// Cloudflare Worker = the EDGE. It resolves host->tenant and:
//  - path B (ORIGIN_URL set): injects the trusted header + proxies to the private
//    container origin (which refuses requests without x-edge-auth) — the faithful
//    ADR-012 edge/origin boundary.
//  - path A (no ORIGIN_URL): renders directly from Neon (staging fallback so the
//    live URL keeps working until the AWS origin is wired).
// Tenant is resolved by Host (real) or ?store= (demo selector on workers.dev).

interface Env {
  DATABASE_URL: string;
  ORIGIN_URL?: string;
  EDGE_SECRET?: string;
  TENANTS?: TenantKV;
}
interface TenantRow {
  id: string;
  name: string;
  status: string;
  theme: { color?: string } | null;
}
interface RouteRow {
  page_type: string;
  page_config: { title?: string; body?: string; price?: string };
}

const CACHEABLE = new Set(['home', 'product', 'page', 'landing', 'blog']);

// Join origin base + request path without a double slash (ORIGIN_URL may end in "/").
export function originTarget(base: string, path: string, search: string): string {
  return base.replace(/\/+$/, '') + path + search;
}

// Build the fetch init for proxying to the private origin (OFCE-413): forward the request
// body for methods that have one (so reserved /cart, /checkout, /api/* handlers receive it)
// with a safe header allowlist, and inject the trusted x-edge-auth + x-ratio-tenant —
// never forwarding any client-supplied copy of those.
export function proxyInit(
  req: Request,
  tenantId: string,
  edgeSecret: string
): RequestInit & { duplex?: 'half' } {
  const method = req.method;
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const headers = new Headers({ 'x-edge-auth': edgeSecret, 'x-ratio-tenant': tenantId });
  for (const h of ['content-type', 'accept', 'accept-language']) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers,
    body: hasBody ? req.body : undefined,
  };
  if (hasBody) init.duplex = 'half'; // required when streaming a request body
  return init;
}

// S4 Tier-1 (read survival): the edge keeps a last-good copy of cacheable GETs. If the origin
// is unreachable or 5xxs, we serve that copy (marked x-ratio-stale) rather than failing the
// whole request. Writes are never served stale — a durable mutation can't be faked from cache,
// so a failed write propagates honestly (Tier-2). cache is caches.default in the Worker;
// injectable here so the behaviour is provable in-process. On the wire the stored copy is kept
// past its edge-TTL for this fallback; freshness on the happy path stays governed by the
// origin's Cache-Control.
export interface EdgeCache {
  match(req: Request): Promise<Response | undefined>;
  put(req: Request, res: Response): Promise<void>;
}
function markStale(res: Response): Response {
  const h = new Headers(res.headers);
  h.set('x-ratio-stale', '1');
  return new Response(res.body, { status: res.status, headers: h });
}
// Per-dependency circuit breaker (ADR-008 D-R3). After `threshold` consecutive failures it opens;
// while open, callers skip the dead dependency entirely (no timeout wait) for `cooldownMs`, then
// half-open for one trial (success closes, failure re-opens). State is module-scoped → per-isolate:
// each Cloudflare isolate learns on its own, which is enough (no global consensus needed). `now`
// is injected for deterministic tests and defaults to the wall clock in the Worker.
export interface CircuitBreaker {
  canAttempt(): boolean;
  onSuccess(): void;
  onFailure(): void;
}
export function createCircuitBreaker(
  threshold: number,
  cooldownMs: number,
  now: () => number = () => Date.now()
): CircuitBreaker {
  let failures = 0;
  let openedAt: number | null = null;
  return {
    canAttempt() {
      if (openedAt === null) return true;
      return now() - openedAt >= cooldownMs;
    },
    onSuccess() {
      failures = 0;
      openedAt = null;
    },
    onFailure() {
      failures += 1;
      if (failures >= threshold) openedAt = now();
    },
  };
}
// Origin call budget (ADR-008 D-R3). A hung origin (slow, not dead) is the common failure —
// without a deadline the edge request hangs with it. Aborting on timeout turns "hung" into a
// rejection, which the stale-if-error catch below already handles → the cached page serves fast.
const ORIGIN_TIMEOUT_MS = 1500;
export async function fetchViaOrigin(
  req: Request,
  target: string,
  init: RequestInit & { duplex?: 'half' },
  cache: EdgeCache | undefined,
  doFetch: typeof fetch = fetch,
  timeoutMs: number = ORIGIN_TIMEOUT_MS,
  breaker?: CircuitBreaker
): Promise<Response> {
  const canServeStale = (req.method === 'GET' || req.method === 'HEAD') && !!cache;
  const serveStale = async (): Promise<Response | null> => {
    if (!canServeStale) return null;
    const stale = await cache!.match(req);
    return stale ? markStale(stale) : null;
  };

  // Breaker open → don't even attempt the dead origin; serve stale now, skipping the timeout wait.
  if (breaker && !breaker.canAttempt()) {
    const stale = await serveStale();
    if (stale) return stale;
    throw new Error('origin circuit open');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(target, { ...init, signal: controller.signal });
    if (res.status >= 500) {
      breaker?.onFailure();
      const stale = await serveStale();
      if (stale) return stale;
    } else {
      breaker?.onSuccess();
      if (canServeStale && res.ok) {
        // put rejects on no-store / Set-Cookie responses — those simply aren't stale-servable.
        try {
          await cache!.put(req, res.clone());
        } catch {
          /* uncacheable — skip */
        }
      }
    }
    return res;
  } catch (err) {
    breaker?.onFailure();
    const stale = await serveStale();
    if (stale) return stale;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const app = new Hono<{ Bindings: Env; Variables: { tenantId?: string } }>();

// D-R6: any unhandled error while serving (uncached origin failure, routing/DB failure, or an
// unexpected throw) becomes the branded 503 — never a raw 500 or leaked internal detail.
app.onError(() => storeUnavailable());

// D-R8: emit one structured access record per request (after the response is known). Runs for
// every route incl. errors (onError produces a response, then this logs it).
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  logAccess(
    buildAccessLog({
      tenantId: c.get('tenantId') ?? null,
      method: c.req.method,
      url: c.req.url,
      status: c.res.status,
      stale: c.res.headers.get('x-ratio-stale') === '1',
      ms: Date.now() - start,
    })
  );
});

app.get('/health', (c) => c.json({ status: 'ok' }));

// The ?store= override is a local-dev selector only. It must NOT be honoured on any
// publicly reachable host — including *.workers.dev, which is live in production
// (wrangler workers_dev = true) — or any visitor could render an arbitrary tenant by id
// and poison the 1-year CDN cache. Localhost only.
export function storeOverrideAllowed(host: string): boolean {
  const h = (host || '').split(':')[0].toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost');
}

// Internal headers the origin uses for cache tagging / diagnostics — stripped at the edge so
// they never reach the public (they leak tenant ids + cache-key structure). (M-5)
const INTERNAL_HEADERS = [
  'x-tenant',
  'x-page-type',
  'x-cache',
  'x-surrogate-keys',
  'x-render-count',
  'x-handler',
];
export function publicHeaders(h: Headers): Headers {
  const out = new Headers(h);
  for (const k of INTERNAL_HEADERS) out.delete(k);
  return out;
}

const STOREFRONT_CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src https: data:; font-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
function setStorefrontSecurity(c: { header: (k: string, v: string) => void }): void {
  c.header('content-security-policy', STOREFRONT_CSP);
  c.header('x-content-type-options', 'nosniff');
  c.header('referrer-policy', 'strict-origin-when-cross-origin');
}

// S4 D-R6: the last-resort fallback when even stale content can't be served (origin failed AND no
// cached copy, or routing itself failed). Generated entirely at the edge — no origin/DB needed — so
// it always renders. A 503 + Retry-After (not a raw 500) tells crawlers it's transient; no-store so
// recovery is immediate; generic branding only — we may not know the tenant, and must never show
// another tenant's content or leak internal error detail.
const STORE_UNAVAILABLE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Store temporarily unavailable</title><style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f6f7f9;color:#1a1a1a}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}}main{max-width:32rem;padding:2rem;text-align:center}h1{font-size:1.5rem;margin:0 0 .5rem}p{margin:.25rem 0;opacity:.8;line-height:1.5}</style></head><body><main><h1>This store is temporarily unavailable</h1><p>We're having a brief problem serving this page. Please try again in a few moments.</p></main></body></html>`;
export function storeUnavailable(): Response {
  return new Response(STORE_UNAVAILABLE_HTML, {
    status: 503,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'retry-after': '30',
      'cache-control': 'no-store',
      'content-security-policy': STOREFRONT_CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
    },
  });
}

// S4 D-R8 (observability down payment): one structured, tenant-scoped access record per request,
// emitted to the Workers log sink (wrangler [observability] enabled). The record is a FIXED field
// allowlist — header values, cookies, secrets, and the query string (which can carry tokens/PII)
// can never enter it by construction. This alone yields per-tenant error rate, stale-serve rate
// (a cache-health proxy), and edge latency without any new infra. Metrics backend, traces, and
// alerting (the rest of D-R8) remain owed.
export interface AccessLog {
  t: 'access';
  tenant: string | null;
  method: string;
  path: string;
  status: number;
  stale: boolean;
  ms: number;
}
export function buildAccessLog(input: {
  tenantId: string | null;
  method: string;
  url: string;
  status: number;
  stale: boolean;
  ms: number;
}): AccessLog {
  return {
    t: 'access',
    tenant: input.tenantId,
    method: input.method,
    path: new URL(input.url).pathname, // pathname only — never the query string
    status: input.status,
    stale: input.stale,
    ms: Math.round(input.ms),
  };
}
function logAccess(record: AccessLog): void {
  // Structured JSON to the Workers log sink — this is the logger, not stray debug output.
  console.log(JSON.stringify(record));
}

// S2/KV: host->tenant resolution reads Workers KV first (edge-local, sub-ms, and survives DB
// death for already-cached routing) and hits Postgres only on a miss, then populates KV.
// Postgres stays source of truth; the control plane write-throughs the key on domain
// verify/reassign/suspend so the cache doesn't drift.
export interface TenantKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}
// Positive entries carry a backstop TTL in case a control-plane write-through is ever missed;
// negatives are short so a freshly-onboarded domain resolves quickly, while bogus/attack
// hostnames can't fall through to the DB on every request (a load-amplification guard).
const KV_TTL_HIT = 3600;
const KV_TTL_MISS = 60;
// The routing DB lookup runs on every KV miss; without a deadline a hung Neon query hangs the
// whole request (ADR-008 D-R3). On timeout we throw and DO NOT populate KV — caching a negative
// on a transient blip would 404 a real store for KV_TTL_MISS seconds. The pending query can't be
// cancelled (Neon over race), so it's left to GC; correctness is in not persisting its result.
const DB_TIMEOUT_MS = 800;
async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer!);
  }
}

export async function lookupTenant(
  host: string,
  kv: TenantKV | undefined,
  dbQuery: (host: string) => Promise<string | null>,
  dbTimeoutMs: number = DB_TIMEOUT_MS
): Promise<string | null> {
  const key = `host:${host}`;
  if (kv) {
    const cached = await kv.get(key);
    if (cached !== null) return (JSON.parse(cached) as { t: string | null }).t;
  }
  const tenantId = await withTimeout(dbQuery(host), dbTimeoutMs, 'tenant db lookup');
  if (kv) {
    await kv.put(key, JSON.stringify({ t: tenantId }), {
      expirationTtl: tenantId ? KV_TTL_HIT : KV_TTL_MISS,
    });
  }
  return tenantId;
}

async function resolveTenant(c: {
  env: Env;
  req: { query: (k: string) => string | undefined; header: (k: string) => string | undefined };
}): Promise<string | null> {
  const host = (c.req.header('host') || '').split(':')[0].toLowerCase();
  const fromQuery = c.req.query('store');
  if (fromQuery && storeOverrideAllowed(host)) return fromQuery;
  const sql = neon(c.env.DATABASE_URL);
  // Only verified claims are authoritative for routing (H1): an unverified squat on someone
  // else's domain must not serve content, and stays reclaimable by the real owner.
  return lookupTenant(host, c.env.TENANTS, async (h) => {
    const d = (await sql`SELECT tenant_id FROM domains WHERE host = ${h} AND verified = true`) as {
      tenant_id: string;
    }[];
    return d[0]?.tenant_id ?? null;
  });
}

// Shared across requests in this isolate: 5 consecutive origin failures open it for 10s, so a
// sustained origin outage costs one isolate ~5 timeouts, not one per request (ADR-008 D-R3/D-R4).
const originBreaker = createCircuitBreaker(5, 10_000);

app.all('*', async (c) => {
  const url = new URL(c.req.url);
  const path = url.pathname;
  // Internal/diagnostic origin paths (e.g. /__stats) must not be reachable from the public
  // edge — they'd otherwise leak per-process counters. Ops can still hit the origin directly. (M-5)
  if (path.startsWith('/__')) return c.text('not found', 404);
  const tenantId = await resolveTenant(c);
  if (!tenantId) return c.html('<h1>Store not found</h1><p>No store for this domain.</p>', 404);
  c.set('tenantId', tenantId); // for the D-R8 access log

  // path B: inject the trusted header + proxy to the private container origin. EDGE_SECRET
  // has no default — if unset the origin refuses (fail closed) rather than accept a secret
  // that lives in the source tree. Body + safe headers are forwarded (OFCE-413). Internal
  // x-* headers from the origin are stripped before returning to the public (M-5).
  if (c.env.ORIGIN_URL) {
    const cache = (globalThis as { caches?: { default?: EdgeCache } }).caches?.default;
    const res = await fetchViaOrigin(
      c.req.raw,
      originTarget(c.env.ORIGIN_URL, path, url.search),
      proxyInit(c.req.raw, tenantId, c.env.EDGE_SECRET ?? ''),
      cache,
      undefined,
      undefined,
      originBreaker
    );
    return new Response(res.body, { status: res.status, headers: publicHeaders(res.headers) });
  }

  // path A: render directly from Neon (staging fallback).
  const sql = neon(c.env.DATABASE_URL);
  const t =
    (await sql`SELECT id, name, status, theme FROM tenants WHERE id = ${tenantId}`) as TenantRow[];
  const tenant = t[0];
  // Unknown or suspended (OFCE-410) → not found; don't reveal a suspended store exists.
  if (!tenant || tenant.status !== 'active') return c.html('<h1>Store not found</h1>', 404);
  const r =
    (await sql`SELECT page_type, page_config FROM routes WHERE tenant_id = ${tenantId} AND path = ${path}`) as RouteRow[];
  const route = r[0];
  if (!route) {
    setStorefrontSecurity(c);
    return c.html(`<h1>404 — ${esc(tenant.name)}</h1><p>no route for ${esc(path)}</p>`, 404);
  }

  if (CACHEABLE.has(route.page_type)) {
    // Short TTL + stale-while-revalidate (aligned with the origin path): edits surface
    // within minutes even without a purge; the on-write purge (OFCE-411) makes it instant.
    c.header('cache-control', 'public, s-maxage=300, stale-while-revalidate=86400');
  }
  setStorefrontSecurity(c);
  const page = normalizePage(route.page_config);
  return c.html(renderPage(page, { tenant: { name: tenant.name, theme: tenant.theme } }));
});

export default app;
