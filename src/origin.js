const http = require('http');
const { forTenant } = require('./repo');

// The "shared stateless host" (ADR-002). Private origin; tenant from trusted header only.
// S1: it also declares a cacheability policy + surrogate keys per page class,
// and counts how many times it actually RENDERED (the expensive path).
const EDGE_SECRET = process.env.EDGE_SECRET || 'private-link-secret';
const RESERVED = ['/cart', '/checkout', '/account'];
const CACHEABLE_TYPES = new Set(['home', 'product', 'page', 'landing', 'blog']); // S1 cache tiers

let renders = 0; // how many times the origin did real render work

const origin = http.createServer(async (req, res) => {
  try {
    if (req.headers['x-edge-auth'] !== EDGE_SECRET) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('403 — origin is private (no valid edge auth)');
    }
    const path = new URL(req.url, 'http://origin').pathname;

    // measurement endpoint (how many real renders so far)
    if (path === '/__stats') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ renders }));
    }

    const tenantId = req.headers['x-ratio-tenant'];

    // reserved system paths — never shared-cached
    if (path.startsWith('/api/') || RESERVED.some((r) => path === r || path.startsWith(r + '/'))) {
      res.writeHead(200, { 'content-type': 'text/plain', 'x-handler': 'reserved', 'x-cache': 'no-store' });
      return res.end(`[reserved system handler] ${path} (tenant=${tenantId})`);
    }

    const repo = forTenant(tenantId);
    const tenant = await repo.getTenant();
    if (!tenant) {
      res.writeHead(404, { 'content-type': 'text/plain', 'x-cache': 'no-store' });
      return res.end('unknown tenant');
    }
    const route = await repo.getRoute(path);
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/html', 'x-tenant': tenantId, 'x-cache': 'no-store' });
      return res.end(`<h1>404 — ${tenant.name}</h1><p>no route for ${path}</p>`);
    }

    renders++; // <-- the expensive path. A cache HIT must NOT reach here.
    const cacheable = CACHEABLE_TYPES.has(route.page_type);
    const surrogateKeys = [
      `t:${tenantId}`,
      `t:${tenantId}:type:${route.page_type}`,
      `t:${tenantId}:route:${path}`,
    ];
    const cfg = route.page_config;
    res.writeHead(200, {
      'content-type': 'text/html',
      'x-tenant': tenantId,
      'x-page-type': route.page_type,
      'x-cache': cacheable ? 'long' : 'no-store', // S1 tier
      'x-surrogate-keys': surrogateKeys.join(' '), // S1 purge grammar (ADR-005 D-CDN4)
      'x-render-count': String(renders),
    });
    res.end(
      `<!doctype html><html><body style="color:${tenant.theme.color}">` +
        `<h1>${cfg.title || ''}</h1><p>${cfg.body || cfg.price || ''}</p>` +
        `<small>tenant=${tenant.name} · type=${route.page_type} · path=${path} · render#${renders}</small>` +
        `</body></html>`
    );
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('500 — ' + e.message);
  }
});

module.exports = { origin };
