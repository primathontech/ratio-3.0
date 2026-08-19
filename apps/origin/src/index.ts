import { Hono } from 'hono';
import { createHash, randomUUID } from 'node:crypto';
import { forTenant } from '@ratio/data-repo';
import { PgPageStore } from '@ratio/builder-core';
import { storefrontResolver } from '@ratio/builder-core';
import { CartService, readCartToken } from '@ratio/builder-core';
import { checkoutPathHealth } from '@ratio/gokwik';
import { defaultRegistry, setUntrustedRenderer } from '@ratio/builder-registry';
import { islandsRuntimeScript, IslandRegistry } from '@ratio/builder-registry';
import { renderUntrusted } from '@ratio/builder-render/isolate';
import { S3ObjectStore, CdnReadObjectStore } from '@ratio/data-objects';
import { ThemeStore } from '@ratio/builder-core';
import { config } from './config';
import { resolveEdgeSecret } from '@ratio/edge-core';
import { withSpan, withRequestSpan, SpanKind } from '@ratio/observability-tracing';
import { logger, requestLog, sanitizeReqId, logCheckout, logCommerceError } from './log';
import { type Vars, edgeAuthOk, timed } from './handlers/helpers';
import { handleHealth, handleReady, handleStats } from './handlers/ops';
import { handleAssets, handleWellKnown } from './handlers/assets';
import { handleCart, cartBackendFor } from './handlers/cart';
import { renderOrderResponse } from './handlers/order';
import { renderStorefront } from './handlers/storefront';

export { edgeAuthOk };

// Private shared host (ADR-002/012). Tenant from trusted header only. Hono handlers
// (Web fetch) so the same code runs on a Node container today and a Worker later.

// /cart is handled here (no page — mutate + open the side-cart drawer, no-store); /checkout +
// /account are app-owned and still stubbed as reserved. The cart routes live below, after the tenant
// is resolved.
const RESERVED = ['/checkout', '/account'];

const stats = { renders: 0 };

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

// Islands (Track 5): the ONLY per-user path. The cached shell carries inert placeholders that a
// small first-party runtime hydrates from /api/island/*. The runtime is content-addressed so a
// change busts the immutable edge cache by URL; the shell references it only when a page actually
// has an island (composePage gate), so all-static pages ship no JS and stay under the strict CSP.
const ISLANDS_JS = islandsRuntimeScript();
export const ISLANDS_URL = `/assets/islands.${createHash('sha256')
  .update(ISLANDS_JS)
  .digest('hex')
  .slice(0, 16)}.js`;
// Island server handlers register here (per-tenant + per-user fragments). Empty until a section
// declares an island; an unknown name → 404. Exported so an app/section can wire its handler.
export const islandRegistry = new IslandRegistry();

export const app = new Hono<Vars>();

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
  if (path === '/health') return handleHealth(c);
  if (path === '/ready') return handleReady(c);

  if (!edgeAuthOk(c.req.header('x-edge-auth'), resolveEdgeSecret(process.env))) {
    return c.text('403 — origin is private (no valid edge auth)', 403);
  }

  if (path === '/__stats') return handleStats(c, stats);

  // Islands runtime: a public, tenant-agnostic, content-addressed asset. Immutable (the hash in the
  // URL changes only when the runtime changes), so the edge caches it hard. Any other /assets path
  // 404s WITH a nosniff JS-safe response so it never falls through to the HTML 404 page (whose
  // text/html body is what made the browser refuse to execute the script).
  if (path.startsWith('/assets/')) {
    return handleAssets(c, { themeStore, islandsUrl: ISLANDS_URL, islandsJs: ISLANDS_JS });
  }

  // Well-known root paths (/favicon.ico, /manifest.json) served from the live theme (OFCE-631), so a
  // storefront doesn't 404 on the browser's default favicon request. Tenant-scoped (needs x-ratio-tenant).
  if (path === '/favicon.ico' || path === '/manifest.json') {
    return handleWellKnown(c, { themeStore, islandsUrl: ISLANDS_URL, islandsJs: ISLANDS_JS });
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
    return renderOrderResponse(c, tenant, tenantId as string, themeStore);
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

  // Storefront render fall-through: the bundle-theme render path, degrading to the page-builder
  // render path when the store has no bundle theme (or its bundle render hiccups).
  return renderStorefront(c, tenant, tenantId as string, {
    themeStore,
    pageStore,
    pbRegistry,
    resolver,
    islandsUrl: ISLANDS_URL,
    stats,
  });
});
