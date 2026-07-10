const { Hono } = require('hono');
const { forTenant } = require('./repo');

// The "shared stateless host" (ADR-002/012). Private origin; tenant from trusted header only.
// Ported to Hono (Web fetch handlers) so the same code runs on a container (Node) today
// and on a Cloudflare Worker later. S1: declares a cacheability tier + surrogate keys per
// page class, and counts how many times it actually RENDERED (the expensive path).
const EDGE_SECRET = process.env.EDGE_SECRET || 'private-link-secret';
const RESERVED = ['/cart', '/checkout', '/account'];
const CACHEABLE_TYPES = new Set(['home', 'product', 'page', 'landing', 'blog']); // S1 cache tiers

let renders = 0; // how many times the origin did real render work

const app = new Hono();

app.onError((e, c) => c.text('500 — ' + e.message, 500));

app.all('*', async (c) => {
  if (c.req.header('x-edge-auth') !== EDGE_SECRET) {
    return c.text('403 — origin is private (no valid edge auth)', 403);
  }
  const path = new URL(c.req.url).pathname;

  // measurement endpoint (how many real renders so far)
  if (path === '/__stats') {
    return c.json({ renders });
  }

  const tenantId = c.req.header('x-ratio-tenant');

  // reserved system paths — never shared-cached
  if (path.startsWith('/api/') || RESERVED.some((r) => path === r || path.startsWith(r + '/'))) {
    c.header('x-handler', 'reserved');
    c.header('x-cache', 'no-store');
    return c.text(`[reserved system handler] ${path} (tenant=${tenantId})`);
  }

  const repo = forTenant(tenantId); // deny-by-default: throws without a tenantId
  const tenant = await repo.getTenant();
  if (!tenant) {
    c.header('x-cache', 'no-store');
    return c.text('unknown tenant', 404);
  }
  const route = await repo.getRoute(path);
  if (!route) {
    c.header('x-tenant', tenantId);
    c.header('x-cache', 'no-store');
    return c.html(`<h1>404 — ${tenant.name}</h1><p>no route for ${path}</p>`, 404);
  }

  renders++; // <-- the expensive path. A cache HIT must NOT reach here.
  const cacheable = CACHEABLE_TYPES.has(route.page_type);
  const surrogateKeys = [
    `t:${tenantId}`,
    `t:${tenantId}:type:${route.page_type}`,
    `t:${tenantId}:route:${path}`,
  ];
  const cfg = route.page_config;
  c.header('x-tenant', tenantId);
  c.header('x-page-type', route.page_type);
  c.header('x-cache', cacheable ? 'long' : 'no-store'); // S1 tier
  c.header('x-surrogate-keys', surrogateKeys.join(' ')); // S1 purge grammar (ADR-005 D-CDN4)
  c.header('x-render-count', String(renders));
  return c.html(
    `<!doctype html><html><body style="color:${tenant.theme.color}">` +
      `<h1>${cfg.title || ''}</h1><p>${cfg.body || cfg.price || ''}</p>` +
      `<small>tenant=${tenant.name} · type=${route.page_type} · path=${path} · render#${renders}</small>` +
      `</body></html>`
  );
});

module.exports = { app };
