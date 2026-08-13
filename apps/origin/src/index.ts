import { Hono, type Context } from 'hono';
import { timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { forTenant } from '@ratio/data-repo';
import { pool } from '@ratio/data-db';
import { esc } from '@ratio/builder-core';
import { PgPageStore } from '@ratio/builder-core';
import { composePage } from '@ratio/builder-core';
import { resolvePage } from '@ratio/builder-core';
import { fetchMainMenu, renderHeader } from '@ratio/builder-core';
import { fetchFooter, renderFooter } from '@ratio/builder-core';
import { storefrontResolver, buildCustomClient, commerceUrlsFromEnv } from '@ratio/builder-core';
import { storefrontHead } from '@ratio/builder-core';
import {
  CartService,
  readCartToken,
  cartCookie,
  expireCartCookie,
  renderCartPage,
  renderOrderPage,
  emptyCart,
  type Cart,
  type CartBackend,
} from '@ratio/builder-core';
import {
  composeGokwik,
  gokwikCartCookies,
  mergeCsp,
  cspToString,
  type CspDirectives,
  type IntegrationContext,
} from '@ratio/gokwik';
import { defaultRegistry, setUntrustedRenderer } from '@ratio/builder-registry';
import { islandsRuntimeScript, IslandRegistry } from '@ratio/builder-registry';
import { renderUntrusted } from '@ratio/builder-render/isolate';
import { S3ObjectStore } from '@ratio/data-objects';
import { ThemeStore, renderThemePage } from '@ratio/builder-core';
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

// /cart is handled here (server-rendered cart, no-store); /checkout + /account are app-owned and
// still stubbed as reserved. The cart routes live below, after the tenant is resolved.
const RESERVED = ['/checkout', '/account'];

let renders = 0;

// Page builder — the sole storefront renderer. A published PageDoc for the URL is served; a URL
// with no PageDoc (exact or template) is a 404. Every store is scaffolded with a home + product +
// collection page at onboarding (scaffoldStorefront), so a fresh store renders out of the box.
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

// Bundle theme store (BC1), only when configured (BUNDLE_S3_BUCKET). When present, a store that has
// published a bundle theme renders from its compiled bundle; otherwise the origin uses only the
// legacy page store. Fetches the compiled bundle once per version into an in-memory LRU.
const themeStore = config.bundleStore
  ? new ThemeStore(new S3ObjectStore(config.bundleStore))
  : null;

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
  c: Context<Vars>,
  tenant: CartTenant,
  tenantId: string,
  cart: Cart
): Promise<Response> {
  const merchantId = tenant.commerce?.merchantId ?? '';
  const ix = composeGokwik(integrationContext(tenant.commerce, 'cart'));
  const [menu, footer] = await timed(c, 'nav', () =>
    Promise.all([
      fetchMainMenu(merchantId, process.env.COMMERCE_NAV_API_URL ?? ''),
      fetchFooter(merchantId, process.env.COMMERCE_NAV_API_URL ?? ''),
    ])
  );
  const html = renderCartPage(cart, {
    siteName: tenant.name,
    styleHead: storefrontHead((tenant.theme ?? {}) as never),
    header: renderHeader({ menu, siteName: tenant.name }),
    footer: renderFooter({ footer, siteName: tenant.name }),
    headExtra: ix.head,
    bodyEnd: ix.bodyEnd,
  });
  c.header('x-tenant', tenantId);
  c.header('x-handler', 'cart');
  c.header('x-cache', 'no-store');
  setStorefrontSecurity(c, cspToString(mergeCsp(STOREFRONT_BASE_CSP, ix.csp)));
  return c.html(html);
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
  const [menu, footer] = await timed(c, 'nav', () =>
    Promise.all([
      fetchMainMenu(merchantId, process.env.COMMERCE_NAV_API_URL ?? ''),
      fetchFooter(merchantId, process.env.COMMERCE_NAV_API_URL ?? ''),
    ])
  );
  const html = renderOrderPage(
    {
      id: url.searchParams.get('id') ?? '',
      // The checkout event reports amounts in MAJOR units (rupees), unlike the cart API (paise).
      total: Number.isFinite(rawTotal) && rawTotal > 0 ? rawTotal : undefined,
      paymentMethod: url.searchParams.get('payment') ?? undefined,
    },
    {
      siteName: tenant.name,
      styleHead: storefrontHead((tenant.theme ?? {}) as never),
      header: renderHeader({ menu, siteName: tenant.name }),
      footer: renderFooter({ footer, siteName: tenant.name }),
      headExtra: ix.head,
      bodyEnd: ix.bodyEnd,
    }
  );
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
    c.header('x-cache', 'no-store');
    return c.redirect('/cart', 303);
  }

  let cart: Cart = emptyCart();
  if (backend && token) {
    try {
      cart = await timed(c, 'commerce', () =>
        withSpan(
          'gokwik.cart.get',
          { 'ratio.op': 'cart.get', 'ratio.tenant': tenantId, 'ratio.reqId': reqId },
          async (span) => {
            const cc = await new CartService(backend).get(token);
            span.setAttribute('ratio.cart.lines', cc.items.length);
            return cc;
          },
          SpanKind.CLIENT
        )
      );
    } catch (e) {
      logCommerceError(log, 'get', tenantId, e);
      cart = emptyCart();
    }
  }
  return renderCartResponse(c, tenant, tenantId, cart);
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

  // Cart (no-JS, server-rendered). Add-to-cart is a form POST; the cart itself lives on the commerce
  // backend, keyed by a token in an httpOnly cookie. Always no-store (per-shopper).
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
    const page = canon === '/' ? 'index' : canon.replace(/^\//, '');
    const compiled = await timed(c, 'bundle', () =>
      themeStore.loadLiveCompiled(tenantId as string)
    );
    if (compiled && compiled[`templates/${page}.json`] != null) {
      const sections = await timed(c, 'compose', () =>
        renderThemePage(compiled, page, { theme: (liquid, data) => renderUntrusted(liquid, data) })
      );
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(tenant.name)}</title>${storefrontHead((tenant.theme ?? {}) as never)}</head><body>${sections}</body></html>`;
      c.header('x-tenant', tenantId as string);
      c.header('x-handler', 'theme-bundle');
      c.header('x-theme-version', String(tenant.liveThemeVersion ?? ''));
      c.header('x-cache', 'no-store'); // caching + purge tags land with the data-binding slice
      setStorefrontSecurity(c, cspToString(STOREFRONT_BASE_CSP));
      return c.html(html);
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
