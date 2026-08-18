import { type Context } from 'hono';
import {
  CartService,
  readCartToken,
  cartCookie,
  buildCustomClient,
  commerceUrlsFromEnv,
  type CartBackend,
} from '@ratio/builder-core';
import { gokwikCartCookies } from '@ratio/gokwik';
import { withSpan, SpanKind } from '@ratio/observability-tracing';
import { logCartAdd, logCartUpdate, logCommerceError } from '../log';
import { type Vars, type CartTenant, timed, integrationContext } from './helpers';

export function cartBackendFor(commerce: CartTenant['commerce']): CartBackend | null {
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

export async function handleCart(
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
