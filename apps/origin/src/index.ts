import { Hono, type Context } from 'hono';
import { timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { forTenant } from '@ratio/data-repo';
import { pool } from '@ratio/data-db';
import { esc } from '@ratio/builder-core';
import { PgPageStore } from '@ratio/builder-core';
import { composePage } from '@ratio/builder-core';
import { resolvePage } from '@ratio/builder-core';
import { fetchMainMenu, fetchFooter, renderChrome } from '@ratio/builder-core';
import { storefrontResolver, buildCustomClient, commerceUrlsFromEnv } from '@ratio/builder-core';
import { storefrontHead } from '@ratio/builder-core';
import type { ThemeTokens } from '@ratio/builder-core';
import { resolveThemeTokens } from '@ratio/builder-core';
import {
  CartService,
  readCartToken,
  cartCookie,
  expireCartCookie,
  renderOrderPage,
  type CartBackend,
} from '@ratio/builder-core';
import {
  composeGokwik,
  gokwikCartCookies,
  checkoutPathHealth,
  mergeCsp,
  cspToString,
  type CspDirectives,
  type IntegrationContext,
} from '@ratio/gokwik';
import {
  defaultRegistry,
  setUntrustedRenderer,
  renderSection,
  islandPlaceholder,
} from '@ratio/builder-registry';
import { islandsRuntimeScript, IslandRegistry } from '@ratio/builder-registry';
import { renderUntrusted } from '@ratio/builder-render/isolate';
import { S3ObjectStore, CdnReadObjectStore } from '@ratio/data-objects';
import {
  ThemeStore,
  renderThemePage,
  renderThemeLayout,
  layoutOwnsDocument,
  tokenCss,
} from '@ratio/builder-core';
import { config } from './config';
import { canonicalPath } from '@ratio/builder-core';
import { pageTag, tenantTag } from '@ratio/builder-core';
import { matchRoute, type RouteMatch } from '@ratio/builder-core';
import { resolveEdgeSecret } from '@ratio/edge-core';
import { withSpan, withRequestSpan, SpanKind } from '@ratio/observability-tracing';
import {
  logger,
  requestLog,
  sanitizeReqId,
  logCartAdd,
  logCartUpdate,
  logCheckout,
  logCommerceError,
  type ReqLog,
} from './log';

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

// /cart is handled here (no page — mutate + open the side-cart drawer, no-store); /checkout +
// /account are app-owned and still stubbed as reserved. The cart routes live below, after the tenant
// is resolved.
const RESERVED = ['/checkout', '/account'];

let renders = 0;

// Page builder — the emergency DEGRADE renderer (OFCE-616/618). The bundle theme is the single
// primary renderer (published at onboarding); this path serves a published PageDoc only when a store
// has no live bundle theme or its bundle render throws. Onboarding no longer scaffolds page-builder
// pages, so for a bundle store this path has none and a URL with no PageDoc is a 404.
const pageStore = new PgPageStore();
const pbRegistry = defaultRegistry();
// The origin runs on Node, so it can render untrusted merchant/app sections via the worker-thread
// isolate (D40). Injecting it here keeps @ratio/builder-registry itself edge-safe (no static
// worker_threads import) — a Worker simply never wires this and renders trusted sections only.
setUntrustedRenderer(renderUntrusted);
// Data-binding resolver (the renderer's 2nd input). The real @shopkit/data-layer custom-backend
// resolver when COMMERCE_* env is configured; otherwise the StubResolver (deterministic samples) so
// local dev renders without a backend — but in production a missing COMMERCE_* throws here rather
// than silently serving sample data (see storefrontResolver).
const resolver = storefrontResolver(process.env);

// Surface GoKwik purchase-path config problems at boot (the side-cart drawer + checkout are gated on
// SEPARATE env vars). A half-config silently breaks buying (drawer opens, Checkout no-ops) → refuse to
// boot in production, warn elsewhere. "Neither configured" means the storefront has no cart/checkout at
// all → warn everywhere (it may be an intentional pre-launch state, so never a hard fail).
{
  const gk = checkoutPathHealth(process.env);
  if (gk.status === 'partial') {
    const msg =
      `GoKwik is half-configured (side-cart=${gk.sideCart}, checkout=${gk.checkout}) — the cart drawer ` +
      `and Checkout must both be on or both off, else the purchase path silently breaks. Set the missing ` +
      `script URL: side-cart=GOKWIK_SIDECART_SCRIPT_URL (+ GOKWIK_CURRENCY/_FORMAT), ` +
      `checkout=GOKWIK_BASE_SCRIPT_URL; both need GOKWIK_ENVIRONMENT.`;
    if (process.env.NODE_ENV === 'production') throw new Error(msg);
    logger.warn({
      evt: 'gokwik_config_incomplete',
      sideCart: gk.sideCart,
      checkout: gk.checkout,
      msg,
    });
  } else if (gk.status === 'off') {
    logger.warn({
      evt: 'gokwik_not_configured',
      msg:
        `GoKwik is not configured — the storefront has no cart or checkout. Set ` +
        `GOKWIK_SIDECART_SCRIPT_URL + GOKWIK_BASE_SCRIPT_URL (plus GOKWIK_ENVIRONMENT, GOKWIK_CURRENCY, ` +
        `GOKWIK_CURRENCY_FORMAT) to enable buying.`,
    });
  }
}

// Bundle theme store (BC1), only when configured (BUNDLE_S3_BUCKET). When present, a store that has
// published a bundle theme renders from its compiled bundle; otherwise the origin uses only the
// legacy page store. Fetches the compiled bundle once per version into an in-memory LRU.
const bundleObjects = config.bundleStore
  ? config.bundleCdnUrl
    ? new CdnReadObjectStore(new S3ObjectStore(config.bundleStore), config.bundleCdnUrl)
    : new S3ObjectStore(config.bundleStore)
  : null;
const themeStore = bundleObjects ? new ThemeStore(bundleObjects) : null;

// The compiled-bundle template key for a URL: shared templates by page type (Shopify-shaped —
// index / collection / product for home, /collections/:handle, /products/:handle), a custom page
// keyed by its own path. matchRoute supplies the type + the route params ({{params.handle}}) the
// resolver interpolates for data binding.
function bundlePageName(canon: string, matched: RouteMatch | null): string {
  switch (matched?.pageType) {
    case 'home':
      return 'index';
    case 'collection':
      return 'collection';
    case 'product':
      return 'product';
    default:
      // Custom / self-keyed page: namespace under page.* so a bare request path (/index,
      // /collection, /product, …) can never alias the reserved shared-template keys — only a URL
      // that actually matched home/collection/product yields those.
      return canon === '/' ? 'index' : `page.${canon.replace(/^\//, '').replace(/\//g, '.')}`;
  }
}

// Islands (Track 5): the ONLY per-user path. The cached shell carries inert placeholders that a
// small first-party runtime hydrates from /api/island/*. The runtime is content-addressed so a
// change busts the immutable edge cache by URL; the shell references it only when a page actually
// has an island (composePage gate), so all-static pages ship no JS and stay under the strict CSP.
const ISLANDS_JS = islandsRuntimeScript();
export const ISLANDS_URL = `/assets/islands.${createHash('sha256')
  .update(ISLANDS_JS)
  .digest('hex')
  .slice(0, 16)}.js`;
// An island page relaxes the strict no-JS CSP by exactly what the first-party runtime needs and no
// more: run the self-hosted script, and let it fetch the same-origin island endpoints.
const ISLANDS_CSP: CspDirectives = { 'script-src': ["'self'"], 'connect-src': ["'self'"] };
// Island server handlers register here (per-tenant + per-user fragments). Empty until a section
// declares an island; an unknown name → 404. Exported so an app/section can wire its handler.
export const islandRegistry = new IslandRegistry();

// Storefront pages carry no first-party JS, so a strict CSP (script-src 'none') is the backstop that
// contains any HTML/color injection that slips through content validation; inline <style> is the
// theme's, so style-src allows it. This is the DEFAULT for every storefront response; an enabled
// external integration (see @ratio/gokwik) merges its own hosts onto this base, per request.
const STOREFRONT_BASE_CSP: CspDirectives = {
  'default-src': ["'none'"],
  'script-src': ["'none'"],
  'style-src': ["'unsafe-inline'"],
  'img-src': ['https:', 'data:'],
  'font-src': ["'self'", 'data:'],
  'base-uri': ["'none'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
};
const STRICT_CSP = cspToString(STOREFRONT_BASE_CSP);

function integrationContext(commerce: CartTenant['commerce'], page: string): IntegrationContext {
  return { env: process.env, merchantId: commerce?.merchantId ?? '', page };
}

// `csp` defaults to the strict no-JS policy; storefront handlers pass the merged policy when an
// integration is active.
function setStorefrontSecurity(c: Context, csp: string = STRICT_CSP): void {
  c.header('content-security-policy', csp);
  c.header('x-content-type-options', 'nosniff');
  c.header('referrer-policy', 'strict-origin-when-cross-origin');
}

// Cart. The cart lives on the commerce backend; the origin holds only the token cookie. There is no
// cart PAGE — the GoKwik side-cart widget (loaded on every page) is the cart: it intercepts
// add-to-cart and opens its drawer itself. The server routes below are the no-JS fallback — they
// mutate the cart and 303 back to where the shopper was.
type CartTenant = {
  name: string;
  theme?: unknown;
  liveThemeId?: string | null;
  commerce?: { merchantId?: string; storeId?: string } | null;
};

// Brand tokens for the storefront <head> on the cart/order pages, which render outside the bundle
// path. Resolve them from the store's LIVE compiled bundle (config/tokens.json) so those pages match
// the theme; fall back to the tenant-level theme when there's no live bundle (or on any load hiccup),
// which keeps these transactional pages rendering even if the theme store is momentarily unavailable.
// The store's live compiled bundle, or null when it has no bundle theme or the store is momentarily
// unavailable — so these transactional pages keep rendering. The cart/order pages read it for BOTH
// the brand tokens and the editable header/footer (renderChrome), loading it once.
async function liveCompiled(tenant: CartTenant, tenantId: string) {
  if (!themeStore || !tenant.liveThemeId) return null;
  try {
    return await themeStore.loadLiveCompiled(tenantId);
  } catch {
    return null;
  }
}

function cartBackendFor(commerce: CartTenant['commerce']): CartBackend | null {
  const urls = commerceUrlsFromEnv(process.env);
  if (!urls) return null;
  return buildCustomClient(commerce, urls) as CartBackend | null;
}

// There is no cart PAGE — the GoKwik side-cart drawer is the cart (view + checkout). The no-JS
// fallback for add-to-cart / the cart-icon link bounces the shopper back to where they were. We
// redirect to the referring PATH only (never the raw Referer), so the target is always same-origin —
// no open-redirect.
function backToReferer(c: Context<Vars>): string {
  const ref = c.req.header('referer');
  if (ref) {
    try {
      const u = new URL(ref);
      const dest = u.pathname + u.search;
      // Never bounce back into a cart route (would loop); fall through to home. Match the /cart route
      // exactly, not merely a /cart* prefix (so /cartier etc. still bounce back correctly).
      if (u.pathname !== '/cart' && !u.pathname.startsWith('/cart/')) return dest;
    } catch {
      /* malformed Referer → home */
    }
  }
  return '/';
}

// Order confirmation (thank-you) page. The checkout SDK redirects here after order-complete with the
// order id/total/payment in the query; render them and expire the (now-spent) cart cookie.
async function renderOrderResponse(
  c: Context<Vars>,
  tenant: CartTenant,
  tenantId: string
): Promise<Response> {
  const merchantId = tenant.commerce?.merchantId ?? '';
  const url = new URL(c.req.url);
  const rawTotal = Number(url.searchParams.get('total'));
  const ix = composeGokwik(integrationContext(tenant.commerce, 'order'));
  const [compiled, [menu, footerData]] = await Promise.all([
    liveCompiled(tenant, tenantId),
    timed(c, 'nav', () =>
      Promise.all([
        fetchMainMenu(merchantId, process.env.COMMERCE_NAV_API_URL ?? ''),
        fetchFooter(merchantId, process.env.COMMERCE_NAV_API_URL ?? ''),
      ])
    ),
  ]);
  const { header, footer } = await timed(c, 'chrome', () =>
    renderChrome(compiled ?? {}, (l, d) => renderUntrusted(l, d), {
      menu,
      footer: footerData,
      siteName: tenant.name,
    })
  );
  const order = {
    id: url.searchParams.get('id') ?? '',
    // The checkout event reports amounts in MAJOR units (rupees), unlike the cart API (paise).
    total: Number.isFinite(rawTotal) && rawTotal > 0 ? rawTotal : undefined,
    paymentMethod: url.searchParams.get('payment') ?? undefined,
  };
  // The thank-you page body is an editable theme section (sections/order.liquid); render it with the
  // order context when the theme has one, else renderOrderPage falls back to the built-in body. The
  // money filter wants paise but the checkout event reports rupees, so pass total × 100.
  const orderLiquid = (compiled ?? {})['sections/order.liquid'];
  const body = orderLiquid
    ? await renderUntrusted(orderLiquid, {
        order_id: order.id,
        total: order.total != null ? Math.round(order.total * 100) : undefined,
        payment_method: order.paymentMethod,
      })
    : undefined;
  const html = renderOrderPage(order, {
    siteName: tenant.name,
    styleHead: storefrontHead(
      resolveThemeTokens(compiled ?? {}, (tenant.theme ?? {}) as ThemeTokens),
      (compiled ?? {})['assets/theme.css'] ?? ''
    ),
    header,
    footer,
    headExtra: ix.head,
    bodyEnd: ix.bodyEnd,
    body,
  });
  c.header('x-tenant', tenantId);
  c.header('x-handler', 'order');
  c.header('x-cache', 'no-store');
  c.header('set-cookie', expireCartCookie());
  setStorefrontSecurity(c, cspToString(mergeCsp(STOREFRONT_BASE_CSP, ix.csp)));
  return c.html(html);
}

async function handleCart(
  c: Context<Vars>,
  tenant: CartTenant,
  tenantId: string
): Promise<Response> {
  const path = new URL(c.req.url).pathname;
  const backend = cartBackendFor(tenant.commerce);
  const token = readCartToken(c.req.header('cookie'));
  const log = c.get('log');
  const reqId = c.get('reqId');

  if (c.req.method === 'POST' && (path === '/cart/add' || path === '/cart/update')) {
    if (backend) {
      const cart = new CartService(backend);
      const body = await c.req.parseBody();
      try {
        if (path === '/cart/add') {
          // Grid/collection cards carry no variant, so they post the handle; resolve the variant
          // server-side. The PDP posts a real variantId and skips the lookup.
          let variantId = String(body.variantId || '');
          const handle = String(body.handle || '');
          if (!variantId && handle) variantId = await cart.resolveVariant(handle);
          if (variantId) {
            const updated = await timed(c, 'commerce', () =>
              withSpan(
                'gokwik.cart.add',
                { 'ratio.op': 'cart.add', 'ratio.tenant': tenantId, 'ratio.reqId': reqId },
                async (span) => {
                  const u = await cart.add(token, [{ variantId, quantity: 1 }]);
                  span.setAttribute('ratio.cart.lines', u.items.length); // 0 = added nothing
                  return u;
                },
                SpanKind.CLIENT
              )
            );
            logCartAdd(log, {
              tenant: tenantId,
              ok: updated.items.length > 0,
              variant: variantId,
              lines: updated.items.length,
            });
            if (updated.id) {
              c.header('set-cookie', cartCookie(updated.id)); // httpOnly, for the server
              // Enabled integrations mirror the token in their own cookie (e.g. the side-cart widget's
              // JS-readable X-Cart-Token); none configured → nothing appended.
              const ctx = integrationContext(tenant.commerce, 'cart');
              for (const ck of gokwikCartCookies(updated.id, ctx))
                c.header('set-cookie', ck, { append: true });
            }
          } else {
            logCartAdd(log, { tenant: tenantId, ok: false, variant: '', lines: 0 });
          }
        } else if (token) {
          const variantId = String(body.variantId || '');
          const quantity = Number(body.quantity ?? 1);
          if (variantId) await cart.setQuantity(token, variantId, quantity);
          logCartUpdate(log, { tenant: tenantId, ok: !!variantId, variant: variantId });
        } else {
          // /cart/update with no cart token — nothing to update; log it rather than swallow.
          logCartUpdate(log, { tenant: tenantId, ok: false, variant: '' });
        }
      } catch (e) {
        // A backend hiccup must not 500 the shopper — fall through and re-render the cart. But it must
        // not be SILENT either (that swallow is what hid the empty-cart bug) — log it, always on.
        logCommerceError(log, path === '/cart/add' ? 'add' : 'update', tenantId, e);
      }
    }
    // No-JS fallback path: the cart is mutated server-side. With JS, the GoKwik side-cart widget
    // (loaded on every page) intercepts add-to-cart and opens the drawer itself — this POST never
    // fires. Without JS, we just bounce back to where the shopper was (the cart lives on the backend).
    c.header('x-cache', 'no-store');
    c.header('x-handler', 'cart-add');
    return c.redirect(backToReferer(c), 303);
  }

  // GET /cart: there is no cart page. The side-cart widget owns the cart icon + drawer; if a shopper
  // still reaches this (no JS, or a direct hit), send them back where they were rather than 404.
  c.header('x-cache', 'no-store');
  c.header('x-handler', 'cart-open');
  return c.redirect(backToReferer(c), 303);
}

type Vars = { Variables: { reqId: string; log: ReqLog; timings: Record<string, number> } };
export const app = new Hono<Vars>();

// Time a labeled async step and accumulate its ms into the request's timing bag, emitted on the
// `render` access log. Lets us see where the origin's wall-clock goes (db vs commerce data vs nav vs
// compose) straight from the logs, without a tracing backend wired.
async function timed<T>(c: Context<Vars>, key: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    const bag = c.get('timings') ?? {};
    bag[key] = (bag[key] ?? 0) + (Date.now() - started);
    c.set('timings', bag);
  }
}

// Per-request correlation. Adopt the edge's id (x-request-id, or the traceparent trace-id) so origin
// logs correlate with the edge access log; otherwise mint one. Bind it on a child logger for every
// event, and echo it on the response so a failing request is traceable client-side.
app.use('*', async (c, next) => {
  // Adopt a VALIDATED id (x-request-id, else the traceparent trace-id) so origin logs join the edge
  // access log; mint one otherwise. Validated because it's echoed + stamped on every line (untrusted
  // if the origin is ever reached directly, before the edge-auth gate below).
  const reqId =
    sanitizeReqId(c.req.header('x-request-id')) ??
    sanitizeReqId(c.req.header('traceparent')?.split('-')[1]) ??
    randomUUID();
  c.set('reqId', reqId);
  c.set('log', requestLog(logger, reqId));
  c.set('timings', {});
  c.header('x-request-id', reqId);
  const started = Date.now();
  let threw = false;
  try {
    // Continue the edge's trace (W3C traceparent) so edge→origin→GoKwik is one trace; child spans
    // (the GoKwik calls below) nest under this. No-op when tracing is off (no OTLP endpoint).
    await withRequestSpan(
      'origin.request',
      { 'ratio.reqId': reqId, 'http.request.method': c.req.method },
      { traceparent: c.req.header('traceparent'), tracestate: c.req.header('tracestate') },
      async (span) => {
        await next();
        span.setAttribute('http.response.status_code', c.res.status); // so SigNoz can see 4xx/5xx
      }
    );
  } catch (e) {
    threw = true;
    throw e; // re-raise so app.onError still produces the branded response
  } finally {
    // One access record per request — on the throw path too, since a slow request that then fails is
    // exactly what we want timed. `ms` is the total; the timing bag holds the steps that ran for this
    // path (a cached/404/reserved path has fewer). On a throw the response isn't built yet, so log the
    // status app.onError will set (500) rather than the stale default. Skip the orchestrator probes
    // (/health, /ready) — they fire on a fixed interval and would drown the real access log.
    const path = new URL(c.req.url).pathname;
    if (path !== '/health' && path !== '/ready') {
      c.get('log').info({
        evt: 'render',
        path,
        status: threw ? 500 : c.res.status,
        ms: Date.now() - started,
        ...c.get('timings'),
      });
    }
  }
});

// Don't leak internal error strings to the customer-facing storefront in production.
app.onError((e, c) => {
  c.get('log')?.error({ evt: 'unhandled', errType: e.name });
  return c.text(
    process.env.NODE_ENV === 'production' ? '500 — internal error' : '500 — ' + e.message,
    500
  );
});

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

  // Islands runtime: a public, tenant-agnostic, content-addressed asset. Immutable (the hash in the
  // URL changes only when the runtime changes), so the edge caches it hard. Any other /assets path
  // 404s WITH a nosniff JS-safe response so it never falls through to the HTML 404 page (whose
  // text/html body is what made the browser refuse to execute the script).
  if (path.startsWith('/assets/')) {
    c.header('x-content-type-options', 'nosniff');
    if (path === ISLANDS_URL) {
      c.header('content-type', 'text/javascript; charset=utf-8');
      c.header('cache-control', 'public, max-age=31536000, immutable');
      c.header('x-cache', 'long');
      return c.body(ISLANDS_JS);
    }
    c.header('x-cache', 'no-store');
    return c.text('404 — not found', 404);
  }

  const tenantId = c.req.header('x-ratio-tenant');
  const isIslandApi = path.startsWith('/api/island/');

  // POST /checkout is OUR endpoint (the GoKwik checkout handshake); everything else under the
  // reserved prefixes stays app-owned/stubbed. /api/island/* is OURS too (handled below, after the
  // tenant resolves), so it must not be swallowed as "reserved" here.
  const isCheckoutApi = path === '/checkout' && c.req.method === 'POST';
  if (
    !isCheckoutApi &&
    !isIslandApi &&
    (path.startsWith('/api/') || RESERVED.some((r) => path === r || path.startsWith(r + '/')))
  ) {
    c.header('x-handler', 'reserved');
    c.header('x-cache', 'no-store');
    return c.text('reserved'); // don't echo tenant id / path back to the caller (I-4)
  }

  const repo = forTenant(tenantId as string); // throws (deny-by-default) if absent
  const tenant = await timed(c, 'db_tenant', () => repo.getTenant());
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

  // Island hydration: the per-user fragment behind a shell placeholder. The runtime fetches this
  // after paint; it is ALWAYS no-store + private (the class C2 forbids in any shared cache) and the
  // edge never caches this reserved path. Unknown island → 404. Anonymous for now (no user session).
  if (isIslandApi) {
    const name = path.slice('/api/island/'.length);
    const params = new URL(c.req.url).searchParams;
    const out = await islandRegistry.handle(name, params, null, tenantId as string);
    c.header('x-tenant', tenantId as string);
    c.header('x-handler', 'island');
    for (const [k, v] of Object.entries(out.headers)) c.header(k, v);
    c.header('x-cache', 'no-store');
    return c.body(out.body, out.status as 200 | 404 | 500);
  }

  // Cart. Add-to-cart is a form POST; the cart lives on the commerce backend, keyed by a token in an
  // httpOnly cookie. No cart page — mutate then bounce back and open the side-cart drawer. Always
  // no-store (per-shopper).
  if (path === '/cart' || path.startsWith('/cart/')) {
    return handleCart(c, tenant, tenantId as string);
  }

  // Order confirmation page (post-checkout thank-you). Always no-store (per-order).
  if (path === '/order') {
    return renderOrderResponse(c, tenant, tenantId as string);
  }

  // Checkout handshake (JS-only path): create the GoKwik checkout server-side and hand the
  // merchantCheckoutId to the browser SDK. The GoKwik checkout integration's client script POSTs here.
  if (isCheckoutApi) {
    const backend = cartBackendFor(tenant.commerce);
    const token = readCartToken(c.req.header('cookie'));
    let merchantCheckoutId = '';
    if (backend && token) {
      try {
        merchantCheckoutId = await timed(c, 'commerce', () =>
          withSpan(
            'gokwik.checkout.create',
            {
              'ratio.op': 'checkout.create',
              'ratio.tenant': tenantId as string,
              'ratio.reqId': c.get('reqId'),
            },
            async (span) => {
              const id = await new CartService(backend).createCheckout(token);
              span.setAttribute('ratio.checkout.ok', !!id);
              return id;
            },
            SpanKind.CLIENT
          )
        );
        logCheckout(c.get('log'), { tenant: tenantId as string, ok: !!merchantCheckoutId });
      } catch (e) {
        // Surface as an empty id — the client shows "checkout unavailable" rather than 500ing.
        logCommerceError(c.get('log'), 'checkout', tenantId as string, e);
      }
    }
    c.header('x-cache', 'no-store');
    return c.json({ merchantCheckoutId });
  }

  // Bundle theme render (BC1): a store that has published a bundle theme renders from its compiled
  // bundle — theme (merchant Liquid) sections run in the isolate. Falls through to the legacy page
  // store when the store has no bundle theme, or the bundle has no template for this URL.
  if (themeStore && tenant.liveThemeId) {
    const canon = canonicalPath(path);
    const matched = matchRoute(canon);
    const page = bundlePageName(canon, matched);
    const merchantId = tenant.commerce?.merchantId ?? '';
    const navUrl = process.env.COMMERCE_NAV_API_URL ?? '';
    try {
      const compiled = await timed(c, 'bundle', () =>
        themeStore.loadLiveCompiled(tenantId as string)
      );
      if (compiled && compiled[`templates/${page}.json`] != null) {
        // Full theme ownership (OFCE-630): when the flag is on AND this theme carries a full-document
        // layout/theme.liquid, the THEME owns the whole page (head + chrome + sections); otherwise the
        // legacy TS shell wraps the sections (the default until stores are rebased onto a full-document
        // base). The flag is a kill-switch; the layout check is what self-migrates a store the moment
        // its rebased theme publishes.
        const themeOwnsDocument =
          process.env.THEME_OWNS_DOCUMENT === '1' &&
          layoutOwnsDocument(compiled['layout/theme.liquid']);
        // Render the theme body AND fetch the store's real nav (header menu + footer) in parallel —
        // the nav overlaps the slow isolate render, not the S3 load, and isn't fetched at all on a
        // bundle-miss fall-through. The body is rendered WITHOUT its layout (applyLayout:false); the
        // layout is applied as a final step below, once the chrome is ready — so header/footer flow
        // INTO the layout (full ownership) or wrap AROUND the sections (legacy shell) from one nav read.
        const [{ html: sections, tags: dataTags }, [menu, footerData]] = await Promise.all([
          timed(c, 'compose', () =>
            renderThemePage(
              compiled,
              page,
              {
                // Theme sections: the bundle's Liquid, sandboxed in the isolate. Platform sections:
                // no Liquid in the bundle — resolve the type to the first-party record and render it
                // in-process (trusted code), so a page can mix both flavors. Platform sections resolve
                // to the LATEST registered version (unpinned) by design — "platform = centrally
                // updated" — unlike the legacy PageDoc path which pins the version it was built with.
                theme: (liquid, data) => renderUntrusted(liquid, data),
                platform: (type, data) => {
                  const rec = pbRegistry.get(type);
                  if (!rec) throw new Error(`unknown platform section '${type}'`);
                  // An island (per-user) section must NEVER render its personalized HTML into this
                  // shared, s-maxage'd response — emit the inert placeholder instead (hydrated
                  // client-side via /api/island), exactly as composePage does. (Instance = type for
                  // now — one island per type; full per-instance ids + island CSP on the bundle path
                  // are a later slice. Today no first-party section declares an island, so this is a
                  // fail-closed guard, not yet a live code path.)
                  if (rec.island)
                    return Promise.resolve(islandPlaceholder(rec.island.name, { instance: type }));
                  return renderSection(rec, data);
                },
              },
              {
                resolver,
                ctx: {
                  tenantId: tenantId as string,
                  routeParams: matched?.params,
                  commerce: tenant.commerce,
                },
                applyLayout: false,
              }
            )
          ),
          timed(c, 'nav', () =>
            Promise.all([fetchMainMenu(merchantId, navUrl), fetchFooter(merchantId, navUrl)])
          ),
        ]);
        // Header/footer are rendered from the THEME's editable header/footer sections (renderChrome)
        // with the store's real name + nav — the same header/footer the cart/order pages use — so all
        // pages share ONE header/footer whether the theme owns the document or the legacy shell wraps it.
        const { header, footer: footerHtml } = await timed(c, 'chrome', () =>
          renderChrome(compiled, (l, d) => renderUntrusted(l, d), {
            menu,
            footer: footerData,
            siteName: tenant.name,
          })
        );
        // External integrations (GoKwik side-cart + checkout) belong on EVERY storefront page, not
        // just cart/order — the side-cart drawer is how a shopper views the cart and opens on add,
        // so its widget must load on home/collection/product too. The fragments are store-level
        // (merchantInfo + a runtime cookie-token bridge), so the page stays edge-cacheable.
        const ix = composeGokwik(integrationContext(tenant.commerce, matched?.pageType ?? 'page'));
        const themeTokens = resolveThemeTokens(compiled, (tenant.theme ?? {}) as ThemeTokens);
        // The theme owns the whole document → render its layout with the chrome + sections + the
        // platform-only slices (content_for_header/body_end) + brand tokens. Else the legacy shell
        // assembles the document in TS (identical head to storefrontHead: base + tokens + merchant CSS).
        const html = themeOwnsDocument
          ? await timed(c, 'layout', () =>
              renderThemeLayout(compiled, (l, d) => renderUntrusted(l, d), {
                content_for_layout: sections,
                header,
                footer: footerHtml,
                content_for_header: ix.head,
                content_for_body_end: ix.bodyEnd,
                token_css: tokenCss(themeTokens),
                site_name: tenant.name,
              })
            )
          : `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(tenant.name)}</title>${storefrontHead(themeTokens, compiled['assets/theme.css'] ?? '')}${ix.head}</head><body>${header}${sections}${footerHtml}${ix.bodyEnd}</body></html>`;
        c.header('x-tenant', tenantId as string);
        c.header('x-handler', 'theme-bundle');
        c.header('x-theme-render', themeOwnsDocument ? 'layout' : 'shell');
        c.header('x-theme-version', String(tenant.liveThemeVersion ?? ''));
        // Cacheable at the edge, invalidated by tag (D2): the tenant tag (a theme publish purges
        // every page of the store), the page tag (this URL), and the data-source tags (a
        // collection/product change purges the pages showing it). Emitting the tenant tag on every
        // bundle page is what lets the write side purge the whole store on publish/rollback.
        const tags = [
          tenantTag(tenantId as string),
          pageTag(tenantId as string, canon),
          ...dataTags,
        ];
        c.header('x-surrogate-keys', tags.join(' '));
        c.header('x-cache', 'long');
        c.header('cache-control', 'public, s-maxage=300, stale-while-revalidate=86400');
        setStorefrontSecurity(c, cspToString(mergeCsp(STOREFRONT_BASE_CSP, ix.csp)));
        return c.html(html);
      }
    } catch (e) {
      // A bundle-store/render hiccup (S3, malformed bundle JSON, a resolver error) must not 500 the
      // very tenants using the new path — log and DEGRADE to the legacy page store below.
      logger.warn({
        evt: 'bundle_render_error',
        tenant: tenantId,
        err: e instanceof Error ? e.message : 'unknown',
      });
    }
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
    let doc = await timed(c, 'db_page', () => pageStore.getLive(tenantId as string, canon));
    let fromTemplate = false;
    if (!doc && matched && matched.templateKey !== canon) {
      doc = await timed(c, 'db_page', () =>
        pageStore.getLive(tenantId as string, matched.templateKey)
      );
      fromTemplate = true;
    }
    if (doc) {
      renders++; // the expensive path — a cache HIT must not reach here
      // Resolve data sources (collection/product) via the CMS, interpolating the router's params
      // ({{params.handle}}), then compose. composePage stays pure — data goes in already resolved.
      const { doc: resolvedDoc, tags: dataTags } = await timed(c, 'data', () =>
        resolvePage(doc!, pbRegistry, resolver, {
          tenantId: tenantId as string,
          routeParams: matched?.params,
          commerce: tenant.commerce, // per-merchant data-layer creds (from the tenant record)
        })
      );
      // Header nav is chrome (ours), its menu is DATA (commerce backend, per-tenant). fetchMainMenu
      // returns the live menu, or the JSON fallback on any failure (unconfigured / no menu / error).
      // Static, so it rides the tenantTag (a menu change purges the store's pages).
      const [menu, footer] = await timed(c, 'nav', async () => {
        const m = await fetchMainMenu(
          tenant.commerce?.merchantId ?? '',
          process.env.COMMERCE_NAV_API_URL ?? ''
        );
        const f = await fetchFooter(
          tenant.commerce?.merchantId ?? '',
          process.env.COMMERCE_NAV_API_URL ?? ''
        );
        return [m, f] as const;
      });
      const ix = composeGokwik(integrationContext(tenant.commerce, matched?.pageType ?? 'page'));
      const composed = await timed(c, 'compose', () =>
        composePage(resolvedDoc, pbRegistry, tenant.theme ?? {}, {
          menu,
          footer,
          siteName: tenant.name,
          headExtra: ix.head,
          bodyEnd: ix.bodyEnd,
          islandsRuntimeUrl: ISLANDS_URL,
        })
      );
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
      // An island page relaxes the strict no-JS base by exactly what the runtime needs (self script
      // + same-origin fetch); a page with no island keeps script-src 'none'. Integration CSP merges
      // on top of either.
      const baseCsp = composed.hasIsland
        ? mergeCsp(STOREFRONT_BASE_CSP, ISLANDS_CSP)
        : STOREFRONT_BASE_CSP;
      setStorefrontSecurity(c, cspToString(mergeCsp(baseCsp, ix.csp)));
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
