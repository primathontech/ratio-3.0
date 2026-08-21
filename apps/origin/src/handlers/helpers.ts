import { type Context } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { cspToString, type CspDirectives, type IntegrationContext } from '@ratio/gokwik';
import { type RouteMatch } from '@ratio/builder-core';
import type { ReqLog } from '../log';

export type Vars = { Variables: { reqId: string; log: ReqLog; timings: Record<string, number> } };

// Cart. The cart lives on the commerce backend; the origin holds only the token cookie. There is no
// cart PAGE — the GoKwik side-cart widget (loaded on every page) is the cart: it intercepts
// add-to-cart and opens its drawer itself. The server routes below are the no-JS fallback — they
// mutate the cart and 303 back to where the shopper was.
export type CartTenant = {
  name: string;
  theme?: unknown;
  liveThemeId?: string | null;
  commerce?: { merchantId?: string; storeId?: string } | null;
};

// Constant-time compare of the edge secret (L-1) — a plain !== is a timing oracle if the
// private origin is ever reachable directly. Equal-length guard because timingSafeEqual
// throws on length mismatch.
export function edgeAuthOk(provided: string | undefined, secret: string): boolean {
  const a = Buffer.from(provided ?? '');
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

// The compiled-bundle template key for a URL: shared templates by page type (Shopify-shaped —
// index / collection / product for home, /collections/:handle, /products/:handle), a custom page
// keyed by its own path. matchRoute supplies the type + the route params ({{params.handle}}) the
// resolver interpolates for data binding.
export function bundlePageName(canon: string, matched: RouteMatch | null): string {
  switch (matched?.pageType) {
    case 'home':
      return 'index';
    case 'collection':
      return 'collection';
    case 'list-collections':
      return 'list-collections';
    case 'product':
      return 'product';
    default:
      // Custom / self-keyed page: namespace under page.* so a bare request path (/index,
      // /collection, /product, …) can never alias the reserved shared-template keys — only a URL
      // that actually matched home/collection/product yields those.
      return canon === '/' ? 'index' : `page.${canon.replace(/^\//, '').replace(/\//g, '.')}`;
  }
}

// Storefront pages carry no first-party JS, so a strict CSP (script-src 'none') is the backstop that
// contains any HTML/color injection that slips through content validation; inline <style> is the
// theme's, so style-src allows 'unsafe-inline', and 'self' authorizes the CDN-linked base stylesheet
// (/assets/<hash>, OFCE-701) — an external <link> is governed by style-src and 'unsafe-inline' alone
// does NOT permit it. This is the DEFAULT for every storefront response; an enabled external
// integration (see @ratio/gokwik) merges its own hosts onto this base, per request.
export const STOREFRONT_BASE_CSP: CspDirectives = {
  'default-src': ["'none'"],
  'script-src': ["'none'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ['https:', 'data:'],
  'font-src': ["'self'", 'data:'],
  // The web app manifest (/manifest.json) is same-origin; without this it falls back to default-src
  // 'none' and the browser refuses to fetch it.
  'manifest-src': ["'self'"],
  'base-uri': ["'none'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
};
export const STRICT_CSP = cspToString(STOREFRONT_BASE_CSP);

export function integrationContext(
  commerce: CartTenant['commerce'],
  page: string
): IntegrationContext {
  return { env: process.env, merchantId: commerce?.merchantId ?? '', page };
}

// `csp` defaults to the strict no-JS policy; storefront handlers pass the merged policy when an
// integration is active.
export function setStorefrontSecurity(c: Context, csp: string = STRICT_CSP): void {
  c.header('content-security-policy', csp);
  c.header('x-content-type-options', 'nosniff');
  c.header('referrer-policy', 'strict-origin-when-cross-origin');
}

// Time a labeled async step and accumulate its ms into the request's timing bag, emitted on the
// `render` access log. Lets us see where the origin's wall-clock goes (db vs commerce data vs nav vs
// compose) straight from the logs, without a tracing backend wired.
export async function timed<T>(c: Context<Vars>, key: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    const bag = c.get('timings') ?? {};
    bag[key] = (bag[key] ?? 0) + (Date.now() - started);
    c.set('timings', bag);
  }
}
