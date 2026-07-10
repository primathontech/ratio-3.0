import { Hono } from 'hono';
import { neon } from '@neondatabase/serverless';

// Path-A staging Worker: edge + origin combined in ONE Cloudflare Worker, backed by
// Neon over its HTTP driver (Workers can't do raw TCP). This is a staging shortcut
// while the theme is mocked — production splits edge (Worker) from origin (container,
// pg) per ADR-012. Tenant is resolved by Host (real mechanism) OR ?store= (demo
// selector, since workers.dev serves every tenant on one hostname).

interface Env {
  DATABASE_URL: string;
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

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ status: 'ok' }));

app.all('*', async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const path = new URL(c.req.url).pathname;
  const host = (c.req.header('host') || '').split(':')[0];

  // resolve tenant: by hostname (domains table), else ?store= demo selector
  let tenantId: string | null = c.req.query('store') ?? null;
  if (!tenantId) {
    const d = (await sql`SELECT tenant_id FROM domains WHERE host = ${host}`) as {
      tenant_id: string;
    }[];
    tenantId = d[0]?.tenant_id ?? null;
  }
  if (!tenantId) return c.html('<h1>Store not found</h1><p>No store for this domain.</p>', 404);

  const t = (await sql`SELECT id, name, theme FROM tenants WHERE id = ${tenantId}`) as TenantRow[];
  const tenant = t[0];
  if (!tenant) return c.html('<h1>Store not found</h1>', 404);

  const r =
    (await sql`SELECT page_type, page_config FROM routes WHERE tenant_id = ${tenantId} AND path = ${path}`) as RouteRow[];
  const route = r[0];
  if (!route) return c.html(`<h1>404 — ${tenant.name}</h1><p>no route for ${path}</p>`, 404);

  const cfg = route.page_config;
  if (CACHEABLE.has(route.page_type)) {
    c.header('cache-control', 'public, s-maxage=31536000'); // S1: long TTL, purge on publish
  }
  c.header('x-tenant', tenantId);
  return c.html(
    `<!doctype html><html><body style="color:${tenant.theme?.color ?? '#333'}">` +
      `<h1>${cfg.title ?? ''}</h1><p>${cfg.body ?? cfg.price ?? ''}</p>` +
      `<small>tenant=${tenant.name} · ${route.page_type} · ${path} · Cloudflare + Neon</small>` +
      `</body></html>`
  );
});

export default app;
