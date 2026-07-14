import { Hono, type Context } from 'hono';
import { forTenant } from '../../packages/repo/index';
import { pool } from '../../packages/shared/db';
import { normalizePage } from '../../packages/content-model/index';
import { renderPage, esc } from '../../packages/theme/index';

// Private shared host (ADR-002/012). Tenant from trusted header only. Hono handlers
// (Web fetch) so the same code runs on a Node container today and a Worker later.

// The edge<->origin shared secret. Fails closed: in production it MUST be set — we never
// fall back to a known default, or the private origin would accept a secret that's in the
// source tree. The dev default keeps local runs frictionless. Reads env at call time (and
// takes an env for testability).
export function resolveEdgeSecret(env: NodeJS.ProcessEnv = process.env): string {
  if (env.EDGE_SECRET) return env.EDGE_SECRET;
  if (env.NODE_ENV === 'production') throw new Error('EDGE_SECRET must be set in production');
  return 'private-link-secret';
}
const RESERVED = ['/cart', '/checkout', '/account'];
const CACHEABLE_TYPES = new Set(['home', 'product', 'page', 'landing', 'blog']);

let renders = 0;

// Storefront pages carry no first-party JS, so a strict CSP (script-src 'none') is the
// backstop that contains any HTML/color injection that slips through content validation;
// inline <style> is the theme's, so style-src allows it. Applied to every storefront HTML
// response. The edge forwards these headers on the proxied path.
const STOREFRONT_CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src https: data:; font-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
function setStorefrontSecurity(c: Context): void {
  c.header('content-security-policy', STOREFRONT_CSP);
  c.header('x-content-type-options', 'nosniff');
  c.header('referrer-policy', 'strict-origin-when-cross-origin');
}

export const app = new Hono();

// Don't leak internal error strings to the customer-facing storefront in production.
app.onError((e, c) =>
  c.text(process.env.NODE_ENV === 'production' ? '500 — internal error' : '500 — ' + e.message, 500)
);

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

  if (c.req.header('x-edge-auth') !== resolveEdgeSecret()) {
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
  // A suspended store stops serving (OFCE-410). 404 (don't reveal it exists), no-store so
  // re-activation takes effect immediately.
  if (tenant.status !== 'active') {
    c.header('x-cache', 'no-store');
    return c.text('unknown tenant', 404);
  }
  const route = await repo.getRoute(path);
  if (!route) {
    c.header('x-tenant', tenantId as string);
    c.header('x-cache', 'no-store');
    setStorefrontSecurity(c);
    return c.html(`<h1>404 — ${esc(tenant.name)}</h1><p>no route for ${esc(path)}</p>`, 404);
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
  // Real Cache-Control so the edge actually caches this (path B was previously uncached),
  // with a short TTL + stale-while-revalidate so edits surface within minutes even if the
  // on-write purge (OFCE-411) isn't configured; a configured purge makes it instant.
  if (cacheable) c.header('cache-control', 'public, s-maxage=300, stale-while-revalidate=86400');
  c.header('x-surrogate-keys', surrogateKeys.join(' '));
  c.header('x-render-count', String(renders));
  setStorefrontSecurity(c);
  const page = normalizePage(route.page_config);
  return c.html(renderPage(page, { tenant: { name: tenant.name, theme: tenant.theme } }));
});
