import { Hono, type Context } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { forTenant } from '@ratio/repo';
import { pool } from '@ratio/shared/db';
import { isLocal } from '@ratio/shared/env';
import { normalizePage } from '@ratio/content-model';
import { renderPage, esc } from '@ratio/theme';
import { PgPageStore } from '@ratio/page-builder-core/store-pg';
import { composePage } from '@ratio/page-builder-core/compose';
import { defaultRegistry } from '@ratio/page-builder-registry/registry';
import { canonicalPath } from '@ratio/page-builder-core/path';
import { pageTag, tenantTag } from '@ratio/page-builder-core/tags';
import { matchRoute, type RouteMatch } from '@ratio/page-builder-core/router';

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
// Constant-time compare of the edge secret (L-1) — a plain !== is a timing oracle if the
// private origin is ever reachable directly. Equal-length guard because timingSafeEqual
// throws on length mismatch.
export function edgeAuthOk(provided: string | undefined, secret: string): boolean {
  const a = Buffer.from(provided ?? '');
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

const RESERVED = ['/cart', '/checkout', '/account'];
const CACHEABLE_TYPES = new Set(['home', 'product', 'page', 'landing', 'blog']);

let renders = 0;

// Page builder (Slice 1, flag-gated). When PAGE_BUILDER_ENABLED is on, a published PageDoc for
// this path wins over the legacy routes table; otherwise the origin is unchanged. Always on in
// local dev (RATIO_LOCAL) so the local loop exercises the real page-builder render path.
const pageStore = new PgPageStore();
const pbRegistry = defaultRegistry();
function pageBuilderEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAGE_BUILDER_ENABLED === 'true' || isLocal;
}

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

  if (!edgeAuthOk(c.req.header('x-edge-auth'), resolveEdgeSecret())) {
    return c.text('403 — origin is private (no valid edge auth)', 403);
  }

  if (path === '/__stats') return c.json({ renders });

  const tenantId = c.req.header('x-ratio-tenant');

  if (path.startsWith('/api/') || RESERVED.some((r) => path === r || path.startsWith(r + '/'))) {
    c.header('x-handler', 'reserved');
    c.header('x-cache', 'no-store');
    return c.text('reserved'); // don't echo tenant id / path back to the caller (I-4)
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
  // Page-builder render path (flag-gated). A published PageDoc wins over the legacy route.
  if (pageBuilderEnabled()) {
    const canon = canonicalPath(path);
    // Routing (ADR-013): the router labels the URL (home / page / collection / product) and picks
    // the template. A custom doc AT this exact URL still wins (override); otherwise a shared
    // template serves it (one Collection template for every /collections/:handle, etc.). An
    // unrecognized path with a doc of its own still renders (pageType 'page').
    const matched: RouteMatch | null = matchRoute(canon);
    let doc = await pageStore.getLive(tenantId as string, canon);
    let fromTemplate = false;
    if (!doc && matched && matched.templateKey !== canon) {
      doc = await pageStore.getLive(tenantId as string, matched.templateKey);
      fromTemplate = true;
    }
    if (doc) {
      renders++; // the expensive path — a cache HIT must not reach here
      // matched.params ({ handle, ... }) will feed the data resolver ({{params.handle}}) next.
      const composed = await composePage(doc, pbRegistry, { accent: tenant.theme?.color });
      c.header('x-tenant', tenantId as string);
      c.header('x-handler', 'page-builder');
      c.header('x-page-type', matched?.pageType ?? 'page');
      c.header('x-page-tier', composed.tier);
      c.header('x-render-count', String(renders));
      // Tag by the CONCRETE url so /collections/summer purges independently of /winter; when a
      // shared template rendered it, ALSO tag by the template so editing it purges every URL (D2).
      const tags = [pageTag(tenantId as string, canon), tenantTag(tenantId as string)];
      if (fromTemplate) tags.push(pageTag(tenantId as string, matched!.templateKey));
      c.header('x-surrogate-keys', tags.join(' '));
      c.header('x-cache', composed.cacheable ? 'long' : 'no-store');
      if (composed.cacheable)
        c.header('cache-control', 'public, s-maxage=300, stale-while-revalidate=86400');
      setStorefrontSecurity(c);
      return c.html(composed.html);
    }
    // no page for this URL (exact or template) → fall through to the legacy route table
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
