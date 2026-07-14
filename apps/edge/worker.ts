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
  const tenantId = await resolveTenant(c);
  if (!tenantId) return c.html('<h1>Store not found</h1><p>No store for this domain.</p>', 404);

  // path B: inject the trusted header + proxy to the private container origin.
  if (c.env.ORIGIN_URL) {
    const res = await fetch(originTarget(c.env.ORIGIN_URL, path, url.search), {
      method: c.req.method,
      headers: {
        // No default: if EDGE_SECRET is unset the origin refuses (fail closed) rather than
        // accept a secret that lives in the source tree.
        'x-edge-auth': c.env.EDGE_SECRET ?? '',
        'x-ratio-tenant': tenantId,
      },
    });
    return new Response(res.body, { status: res.status, headers: res.headers });
  }

  // path A: render directly from Neon (staging fallback).
  const sql = neon(c.env.DATABASE_URL);
  const t = (await sql`SELECT id, name, theme FROM tenants WHERE id = ${tenantId}`) as TenantRow[];
  const tenant = t[0];
  if (!tenant) return c.html('<h1>Store not found</h1>', 404);
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
  c.header('x-tenant', tenantId);
  setStorefrontSecurity(c);
  const page = normalizePage(route.page_config);
  return c.html(renderPage(page, { tenant: { name: tenant.name, theme: tenant.theme } }));
});

export default app;
