import { type Context } from 'hono';
import {
  fetchMainMenu,
  fetchFooter,
  renderChrome,
  storefrontHead,
  resolveThemeTokens,
  type ThemeTokens,
  renderThemeLayout,
  layoutOwnsDocument,
  tokenCss,
  orderBody,
  renderOrderPage,
  expireCartCookie,
  ThemeStore,
} from '@ratio/builder-core';
import { composeGokwik, mergeCsp, cspToString } from '@ratio/gokwik';
import { renderUntrusted } from '@ratio/builder-render/isolate';
import {
  type Vars,
  type CartTenant,
  timed,
  integrationContext,
  setStorefrontSecurity,
  STOREFRONT_BASE_CSP,
} from './helpers';

// Brand tokens for the storefront <head> on the cart/order pages, which render outside the bundle
// path. Resolve them from the store's LIVE compiled bundle (config/tokens.json) so those pages match
// the theme; fall back to the tenant-level theme when there's no live bundle (or on any load hiccup),
// which keeps these transactional pages rendering even if the theme store is momentarily unavailable.
// The store's live compiled bundle, or null when it has no bundle theme or the store is momentarily
// unavailable — so these transactional pages keep rendering. The cart/order pages read it for BOTH
// the brand tokens and the editable header/footer (renderChrome), loading it once.
async function liveCompiled(themeStore: ThemeStore | null, tenant: CartTenant, tenantId: string) {
  if (!themeStore || !tenant.liveThemeId) return null;
  try {
    return await themeStore.loadLiveCompiled(tenantId);
  } catch {
    return null;
  }
}

// Order confirmation (thank-you) page. The checkout SDK redirects here after order-complete with the
// order id/total/payment in the query; render them and expire the (now-spent) cart cookie.
export async function renderOrderResponse(
  c: Context<Vars>,
  tenant: CartTenant,
  tenantId: string,
  themeStore: ThemeStore | null
): Promise<Response> {
  const merchantId = tenant.commerce?.merchantId ?? '';
  const url = new URL(c.req.url);
  const rawTotal = Number(url.searchParams.get('total'));
  const ix = composeGokwik(integrationContext(tenant.commerce, 'order'));
  const [compiled, [menu, footerData]] = await Promise.all([
    liveCompiled(themeStore, tenant, tenantId),
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
  // order context when the theme has one, else the built-in orderBody. The money filter wants paise but
  // the checkout event reports rupees, so pass total × 100.
  const orderLiquid = (compiled ?? {})['sections/order.liquid'];
  const orderSection = orderLiquid
    ? await renderUntrusted(orderLiquid, {
        order_id: order.id,
        total: order.total != null ? Math.round(order.total * 100) : undefined,
        payment_method: order.paymentMethod,
      })
    : orderBody(order);
  const themeTokens = resolveThemeTokens(compiled ?? {}, (tenant.theme ?? {}) as ThemeTokens);
  // Full theme ownership (OFCE-641): when the store has a full-document live theme, the order page
  // renders through the theme's OWN layout/theme.liquid (order section → content_for_layout, chrome →
  // header/footer slots) — the same layout the storefront uses. Unlike the storefront path it does NOT
  // fail loud when no full-document layout is available (store not yet on a bundle theme, or a transient
  // theme-store load failure): this page is uncacheable (no-store), so the edge can't shield an S3 blip
  // behind serve-stale, and a shopper who just paid must still get a complete page. Fall back to the
  // built-in document wrapper — which keeps the chrome, brand CSS, AND the GoKwik purchase pixel
  // (ix.head/ix.bodyEnd), the last of which a headless renderThemeLayout fragment would silently drop.
  const layout = (compiled ?? {})['layout/theme.liquid'];
  const ownsDocument = layoutOwnsDocument(layout);
  const html = ownsDocument
    ? await renderThemeLayout(compiled ?? {}, (l, d) => renderUntrusted(l, d), {
        content_for_layout: orderSection,
        header,
        footer,
        content_for_header: ix.head,
        content_for_body_end: ix.bodyEnd,
        token_css: tokenCss(themeTokens),
        site_name: tenant.name,
        page_title: `Order confirmed · ${tenant.name}`,
      })
    : renderOrderPage(order, {
        siteName: tenant.name,
        styleHead: storefrontHead(themeTokens, (compiled ?? {})['assets/theme.css'] ?? ''),
        header,
        footer,
        headExtra: ix.head,
        bodyEnd: ix.bodyEnd,
        body: orderSection,
      });
  c.header('x-tenant', tenantId);
  c.header('x-handler', 'order');
  // Which branch rendered — so a degrade (bundle unavailable on this uncacheable page) is visible in
  // prod response headers, mirroring the storefront's x-theme-render.
  c.header('x-theme-render', ownsDocument ? 'layout' : 'fallback');
  c.header('x-cache', 'no-store');
  c.header('set-cookie', expireCartCookie());
  setStorefrontSecurity(c, cspToString(mergeCsp(STOREFRONT_BASE_CSP, ix.csp)));
  return c.html(html);
}
