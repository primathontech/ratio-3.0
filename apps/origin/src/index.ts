import { Hono, type Context } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { forTenant } from '@ratio/data-repo';
import { pool } from '@ratio/data-db';
import { esc } from '@ratio/builder-core';
import { PgPageStore } from '@ratio/builder-core';
import { composePage } from '@ratio/builder-core';
import { resolvePage, StubResolver } from '@ratio/builder-core';
import { fetchMainMenu, renderHeader } from '@ratio/builder-core';
import { fetchFooter, renderFooter } from '@ratio/builder-core';
import {
  commerceResolverFromEnv,
  buildCustomClient,
  commerceUrlsFromEnv,
} from '@ratio/builder-core';
import { storefrontHead } from '@ratio/builder-core';
import {
  CartService,
  readCartToken,
  cartCookie,
  renderCartPage,
  emptyCart,
  type Cart,
  type CartBackend,
} from '@ratio/builder-core';
import { defaultRegistry } from '@ratio/builder-registry';
import { canonicalPath } from '@ratio/builder-core';
import { pageTag, tenantTag } from '@ratio/builder-core';
import { matchRoute, type RouteMatch } from '@ratio/builder-core';
import { resolveEdgeSecret } from '@ratio/edge-core';

// Private shared host (ADR-002/012). Tenant from trusted header only. Hono handlers
// (Web fetch) so the same code runs on a Node container today and a Worker later.

// Constant-time compare of the edge secret (L-1) — a plain !== is a timing oracle if the
// private origin is ever reachable directly. Equal-length guard because timingSafeEqual
// throws on length mismatch.
export function edgeAuthOk(provided: string | undefined, secret: string): boolean {
  const a = Buffer.from(provided ?? '');
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

// /cart is handled here (server-rendered cart, no-store); /checkout + /account are app-owned and
// still stubbed as reserved. The cart routes live below, after the tenant is resolved.
const RESERVED = ['/checkout', '/account'];

let renders = 0;

// Page builder — the sole storefront renderer. A published PageDoc for the URL is served; a URL
// with no PageDoc (exact or template) is a 404. Every store is scaffolded with a home + product +
// collection page at onboarding (scaffoldStorefront), so a fresh store renders out of the box.
const pageStore = new PgPageStore();
const pbRegistry = defaultRegistry();
// Data-binding resolver (the renderer's 2nd input). Use the real @shopkit/data-layer custom-backend
// resolver when COMMERCE_* env is configured; otherwise the StubResolver (deterministic samples) so
// local dev renders without a backend.
const resolver = commerceResolverFromEnv(process.env) ?? new StubResolver();

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

// Cart (no-JS). The cart lives on the commerce backend; the origin holds only the token cookie and
// renders the cart server-side. Add/remove are form POSTs → mutate → 303 back to /cart.
type CartTenant = {
  name: string;
  theme?: unknown;
  commerce?: { merchantId?: string; storeId?: string } | null;
};

function cartBackendFor(commerce: CartTenant['commerce']): CartBackend | null {
  const urls = commerceUrlsFromEnv(process.env);
  if (!urls) return null;
  return buildCustomClient(commerce, urls) as CartBackend | null;
}

async function renderCartResponse(
  c: Context,
  tenant: CartTenant,
  tenantId: string,
  cart: Cart
): Promise<Response> {
  const merchantId = tenant.commerce?.merchantId ?? '';
  const [menu, footer] = await Promise.all([
    fetchMainMenu(merchantId, process.env.COMMERCE_NAV_API_URL ?? ''),
    fetchFooter(merchantId, process.env.COMMERCE_FOOTER_API_URL ?? ''),
  ]);
  const html = renderCartPage(cart, {
    siteName: tenant.name,
    styleHead: storefrontHead((tenant.theme ?? {}) as never),
    header: renderHeader({ menu, siteName: tenant.name }),
    footer: renderFooter({ footer, siteName: tenant.name }),
  });
  c.header('x-tenant', tenantId);
  c.header('x-handler', 'cart');
  c.header('x-cache', 'no-store');
  setStorefrontSecurity(c);
  return c.html(html);
}

async function handleCart(c: Context, tenant: CartTenant, tenantId: string): Promise<Response> {
  const path = new URL(c.req.url).pathname;
  const backend = cartBackendFor(tenant.commerce);
  const token = readCartToken(c.req.header('cookie'));

  if (c.req.method === 'POST' && path === '/cart/add') {
    if (backend) {
      const body = await c.req.parseBody();
      const variantId = String(body.variantId || body.handle || '');
      if (variantId) {
        try {
          const updated = await new CartService(backend).add(token, [{ variantId, quantity: 1 }]);
          if (updated.id) c.header('set-cookie', cartCookie(updated.id)); // persist the cart token
        } catch {
          // A backend hiccup must not 500 the shopper — fall through and re-render the cart.
        }
      }
    }
    c.header('x-cache', 'no-store');
    return c.redirect('/cart', 303);
  }

  let cart: Cart = emptyCart();
  if (backend && token) {
    try {
      cart = await new CartService(backend).get(token);
    } catch {
      cart = emptyCart();
    }
  }
  return renderCartResponse(c, tenant, tenantId, cart);
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

  if (!edgeAuthOk(c.req.header('x-edge-auth'), resolveEdgeSecret(process.env))) {
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

  // Cart (no-JS, server-rendered). Add-to-cart is a form POST; the cart itself lives on the commerce
  // backend, keyed by a token in an httpOnly cookie. Always no-store (per-shopper).
  if (path === '/cart' || path.startsWith('/cart/')) {
    return handleCart(c, tenant, tenantId as string);
  }

  // Page-builder render path — the sole renderer. A published PageDoc for the URL (exact or a
  // shared template) is served; a URL with none is a 404 (there is no legacy fallback).
  {
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
      // Resolve data sources (collection/product) via the CMS, interpolating the router's params
      // ({{params.handle}}), then compose. composePage stays pure — data goes in already resolved.
      const { doc: resolvedDoc, tags: dataTags } = await resolvePage(doc, pbRegistry, resolver, {
        tenantId: tenantId as string,
        routeParams: matched?.params,
        commerce: tenant.commerce, // per-merchant data-layer creds (from the tenant record)
      });
      // Header nav is chrome (ours), its menu is DATA (commerce backend, per-tenant). fetchMainMenu
      // returns the live menu, or the JSON fallback on any failure (unconfigured / no menu / error).
      // Static, so it rides the tenantTag (a menu change purges the store's pages).
      const menu = await fetchMainMenu(
        tenant.commerce?.merchantId ?? '',
        process.env.COMMERCE_NAV_API_URL ?? ''
      );
      // Footer is chrome too (ours), its menu is DATA (per-tenant). fetchFooter returns the live
      // footer menu, or the JSON fallback on any failure (unconfigured / no menu / error).
      const footer = await fetchFooter(
        tenant.commerce?.merchantId ?? '',
        process.env.COMMERCE_FOOTER_API_URL ?? ''
      );
      const composed = await composePage(resolvedDoc, pbRegistry, tenant.theme ?? {}, {
        menu,
        footer,
        siteName: tenant.name,
      });
      c.header('x-tenant', tenantId as string);
      c.header('x-handler', 'page-builder');
      c.header('x-page-type', matched?.pageType ?? 'page');
      c.header('x-page-tier', composed.tier);
      c.header('x-render-count', String(renders));
      // Tag by the CONCRETE url so /collections/summer purges independently of /winter; when a
      // shared template rendered it, ALSO tag by the template so editing it purges every URL (D2);
      // and by each data source's tags (col:*/prod:*) so a CMS change purges the pages showing it.
      const tags = [pageTag(tenantId as string, canon), tenantTag(tenantId as string), ...dataTags];
      if (fromTemplate) tags.push(pageTag(tenantId as string, matched!.templateKey));
      c.header('x-surrogate-keys', tags.join(' '));
      c.header('x-cache', composed.cacheable ? 'long' : 'no-store');
      if (composed.cacheable)
        c.header('cache-control', 'public, s-maxage=300, stale-while-revalidate=86400');
      setStorefrontSecurity(c);
      return c.html(composed.html);
    }
    // No published page for this URL (exact or template) → 404. The page builder is the sole
    // renderer; there is no legacy content-model fallback.
    c.header('x-tenant', tenantId as string);
    c.header('x-cache', 'no-store');
    setStorefrontSecurity(c);
    return c.html(`<h1>404 — ${esc(tenant.name)}</h1><p>no page for ${esc(path)}</p>`, 404);
  }
});
