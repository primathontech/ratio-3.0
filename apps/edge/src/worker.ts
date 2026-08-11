import { Hono } from 'hono';
import { neon } from '@neondatabase/serverless';
import {
  originTarget,
  proxyInit,
  publicHeaders,
  storeOverrideAllowed,
  fetchViaOrigin,
  createCircuitBreaker,
  lookupTenant,
  buildAccessLog,
  buildMetricPoint,
  storeUnavailable,
  type EdgeCache,
  type TenantKV,
  type AnalyticsEngineDataset,
} from '@ratio/edge-core';
import { createLogger } from '@ratio/observability/edge';

// The portable edge logic lives in packages/edge-core (shared by every edge adapter, tested there).
// This file is the CLOUDFLARE adapter: it wires Workers KV, caches.default, and fetch to edge-core
// and holds the Hono app. The Akamai adapter (apps/edge-akamai) reuses the same edge-core.

// Cloudflare Worker = the EDGE. It resolves host->tenant, serves from cache, and proxies every
// miss to the private container ORIGIN — the single renderer (router + page builder). The origin's
// response (HTML + cache-control + surrogate tags) is cached at the edge; internal x-* headers are
// stripped before the client sees it (M-5). ORIGIN_URL is required — the edge never renders itself.
interface Env {
  DATABASE_URL: string;
  ORIGIN_URL?: string;
  EDGE_SECRET?: string;
  TENANTS?: TenantKV;
  METRICS?: AnalyticsEngineDataset;
}

const app = new Hono<{ Bindings: Env; Variables: { tenantId?: string } }>();

// Workers-safe logger from the shared @ratio/observability package (pino can't run on Workers) — same
// JSON shape/conventions as the Node services, so edge + origin logs correlate.
const edgeLog = createLogger({ service: 'edge' });

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
  edgeLog.info(buildAccessLog({ ...common, method: c.req.method, url: c.req.url }));
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

  // Always proxy to the private container origin (the single renderer). Inject the trusted tenant
  // header + EDGE_SECRET (no default — the origin fails closed if unset). Cache the origin's
  // response; strip internal x-* before the client sees it (M-5). No ORIGIN_URL → the edge cannot
  // serve, so fail closed with the branded 503 rather than rendering itself.
  if (!c.env.ORIGIN_URL) return storeUnavailable();
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
});

export default app;
