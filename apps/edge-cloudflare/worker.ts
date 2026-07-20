import { Hono } from 'hono';
import { neon } from '@neondatabase/serverless';
import { normalizePage } from '../../packages/content-model/index';
import { renderPage, esc } from '../../packages/theme/index';
import {
  originTarget,
  proxyInit,
  publicHeaders,
  storeOverrideAllowed,
  STOREFRONT_CSP,
  fetchViaOrigin,
  createCircuitBreaker,
  lookupTenant,
  buildAccessLog,
  buildMetricPoint,
  logAccess,
  storeUnavailable,
  type EdgeCache,
  type TenantKV,
  type AnalyticsEngineDataset,
} from '../../packages/edge-core/index';

// The portable edge logic lives in packages/edge-core (shared by every edge adapter, tested there).
// This file is the CLOUDFLARE adapter: it wires Workers KV, caches.default, and fetch to edge-core
// and holds the Hono app. The Akamai adapter (apps/edge-akamai) reuses the same edge-core.

// Cloudflare Worker = the EDGE. It resolves host->tenant and:
//  - path B (ORIGIN_URL set): injects the trusted header + proxies to the private container origin.
//  - path A (no ORIGIN_URL): renders directly from Neon (staging fallback).
interface Env {
  DATABASE_URL: string;
  ORIGIN_URL?: string;
  EDGE_SECRET?: string;
  TENANTS?: TenantKV;
  METRICS?: AnalyticsEngineDataset;
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

function setStorefrontSecurity(c: { header: (k: string, v: string) => void }): void {
  c.header('content-security-policy', STOREFRONT_CSP);
  c.header('x-content-type-options', 'nosniff');
  c.header('referrer-policy', 'strict-origin-when-cross-origin');
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
  const common = {
    tenantId: c.get('tenantId') ?? null,
    status: c.res.status,
    stale: c.res.headers.get('x-ratio-stale') === '1',
    ms: Date.now() - start,
  };
  const path = new URL(c.req.url).pathname;
  logAccess(buildAccessLog({ ...common, method: c.req.method, url: c.req.url }));
  // Durable, queryable per-tenant metrics — no-op if the dataset isn't bound (local / unprovisioned).
  c.env.METRICS?.writeDataPoint(buildMetricPoint({ ...common, path }));
});

app.get('/health', (c) => c.json({ status: 'ok' }));

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

  // path B: inject the trusted header + proxy to the private container origin. EDGE_SECRET has no
  // default — if unset the origin refuses (fail closed). Internal x-* headers are stripped (M-5).
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
