import { Hono } from 'hono';
import { forTenant } from '../../packages/repo/index';
import { pool } from '../../packages/shared/db';
import { normalizePage } from '../../packages/content-model/index';
import { renderPage } from '../../packages/theme/index';

// Private shared host (ADR-002/012). Tenant from trusted header only. Hono handlers
// (Web fetch) so the same code runs on a Node container today and a Worker later.
const EDGE_SECRET = process.env.EDGE_SECRET || 'private-link-secret';
const RESERVED = ['/cart', '/checkout', '/account'];
const CACHEABLE_TYPES = new Set(['home', 'product', 'page', 'landing', 'blog']);

let renders = 0;

export const app = new Hono();

app.onError((e, c) => c.text('500 — ' + e.message, 500));

app.all('*', async (c) => {
  const path = new URL(c.req.url).pathname;

  // Orchestrator probes hit the container directly — public, no edge-auth, no tenant.
  if (path === '/health') return c.json({ status: 'ok' });
  if (path === '/ready') {
    try {
      await pool.query('SELECT 1');
      return c.json({ ready: true });
    } catch {
      return c.json({ ready: false }, 503);
    }
  }

  if (c.req.header('x-edge-auth') !== EDGE_SECRET) {
    return c.text('403 — origin is private (no valid edge auth)', 403);
  }

  if (path === '/__stats') return c.json({ renders });

  const tenantId = c.req.header('x-ratio-tenant');

  if (path.startsWith('/api/') || RESERVED.some((r) => path === r || path.startsWith(r + '/'))) {
    c.header('x-handler', 'reserved');
    c.header('x-cache', 'no-store');
    return c.text(`[reserved system handler] ${path} (tenant=${tenantId})`);
  }

  const repo = forTenant(tenantId as string); // throws (deny-by-default) if absent
  const tenant = await repo.getTenant();
  if (!tenant) {
    c.header('x-cache', 'no-store');
    return c.text('unknown tenant', 404);
  }
  const route = await repo.getRoute(path);
  if (!route) {
    c.header('x-tenant', tenantId as string);
    c.header('x-cache', 'no-store');
    return c.html(`<h1>404 — ${tenant.name}</h1><p>no route for ${path}</p>`, 404);
  }

  renders++; // the expensive path — a cache HIT must not reach here
  const cacheable = CACHEABLE_TYPES.has(route.page_type);
  const surrogateKeys = [
    `t:${tenantId}`,
    `t:${tenantId}:type:${route.page_type}`,
    `t:${tenantId}:route:${path}`,
  ];
  c.header('x-tenant', tenantId as string);
  c.header('x-page-type', route.page_type);
  c.header('x-cache', cacheable ? 'long' : 'no-store');
  c.header('x-surrogate-keys', surrogateKeys.join(' '));
  c.header('x-render-count', String(renders));
  const page = normalizePage(route.page_config);
  return c.html(renderPage(page, { tenant: { name: tenant.name, theme: tenant.theme } }));
});
