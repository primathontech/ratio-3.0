import { Hono } from 'hono';
import { neon } from '@neondatabase/serverless';
import { normalizePage } from '../../packages/content-model/index';
import { renderPage } from '../../packages/theme/index';

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

async function resolveTenant(c: {
  env: Env;
  req: { query: (k: string) => string | undefined; header: (k: string) => string | undefined };
}): Promise<string | null> {
  const fromQuery = c.req.query('store');
  if (fromQuery) return fromQuery;
  const host = (c.req.header('host') || '').split(':')[0];
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
        'x-edge-auth': c.env.EDGE_SECRET ?? 'private-link-secret',
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
  if (!route) return c.html(`<h1>404 — ${tenant.name}</h1><p>no route for ${path}</p>`, 404);

  if (CACHEABLE.has(route.page_type)) {
    c.header('cache-control', 'public, s-maxage=31536000');
  }
  c.header('x-tenant', tenantId);
  const page = normalizePage(route.page_config);
  return c.html(renderPage(page, { tenant: { name: tenant.name, theme: tenant.theme } }));
});

export default app;
