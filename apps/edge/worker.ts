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

const app = new Hono<{ Bindings: Env }>();

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

async function resolveTenant(c: {
  env: Env;
  req: { query: (k: string) => string | undefined; header: (k: string) => string | undefined };
}): Promise<string | null> {
  const host = (c.req.header('host') || '').split(':')[0];
  const fromQuery = c.req.query('store');
  if (fromQuery && storeOverrideAllowed(host)) return fromQuery;
  const sql = neon(c.env.DATABASE_URL);
  const d = (await sql`SELECT tenant_id FROM domains WHERE host = ${host}`) as {
    tenant_id: string;
  }[];
  return d[0]?.tenant_id ?? null;
}

app.all('*', async (c) => {
  const url = new URL(c.req.url);
  const path = url.pathname;
  // Internal/diagnostic origin paths (e.g. /__stats) must not be reachable from the public
  // edge — they'd otherwise leak per-process counters. Ops can still hit the origin directly. (M-5)
  if (path.startsWith('/__')) return c.text('not found', 404);
  const tenantId = await resolveTenant(c);
  if (!tenantId) return c.html('<h1>Store not found</h1><p>No store for this domain.</p>', 404);

  // path B: inject the trusted header + proxy to the private container origin. EDGE_SECRET
  // has no default — if unset the origin refuses (fail closed) rather than accept a secret
  // that lives in the source tree. Body + safe headers are forwarded (OFCE-413). Internal
  // x-* headers from the origin are stripped before returning to the public (M-5).
  if (c.env.ORIGIN_URL) {
    const res = await fetch(
      originTarget(c.env.ORIGIN_URL, path, url.search),
      proxyInit(c.req.raw, tenantId, c.env.EDGE_SECRET ?? '')
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
