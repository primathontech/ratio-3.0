// GoKwik KwikCart side-cart: the hosted drawer. Loading it means the storefront runs first-party +
// vendor JS, so this integration relaxes the CSP for GoKwik hosts (a deliberate departure from the
// no-JS default, scoped to when the widget is configured). The widget identifies the merchant from
// window.merchantInfo (GoKwik's CUSTOM-platform contract) and reads the cart token from a
// `merchant_*_cartToken` localStorage key — NOT from a cookie — so we bridge our server token in.
import { esc } from '@ratio/builder-core';
import { jsInline } from '../inline';

// The GoKwik merchant id + environment are GoKwik's own values (distinct from the tenant's commerce
// merchantId), so every field is required config — no defaults.
export interface SideCartConfig {
  scriptUrl: string;
  mid: string; // GoKwik merchant id
  environment: string; // 'production' | 'sandbox' — the GoKwik environment the store lives in
  currency: string;
  currencyFormat: string;
}

export function sideCartTag(cfg: Partial<SideCartConfig> | null | undefined): string {
  if (!cfg?.scriptUrl || !cfg.mid || !cfg.environment || !cfg.currency || !cfg.currencyFormat)
    return '';
  const merchantInfo = jsInline({
    mid: cfg.mid,
    environment: cfg.environment,
    type: 'merchantInfo',
    gkPlatform: 'CUSTOM',
    integrationType: 'CUSTOM',
  });
  // The widget's token getter reads localStorage first and only falls back to the cookie if that
  // access throws; mirror our X-Cart-Token cookie into the key it reads before the widget boots, or
  // the drawer resolves an empty cart.
  const tokenKey = jsInline(`merchant_${cfg.mid}_cartToken`);
  return (
    `<script>window.gk_cart_currency=${jsInline(cfg.currency)};` +
    `window.gk_currency_format=${jsInline(cfg.currencyFormat)};` +
    `window.gk_store_id=${jsInline(cfg.mid)};` +
    `window.merchantInfo=${merchantInfo};window.kwikCartActive=true;` +
    `try{var _t=document.cookie.match(/(?:^|;\\s*)X-Cart-Token=([^;]+)/);` +
    `if(_t)localStorage.setItem(${tokenKey},decodeURIComponent(_t[1]));}catch(e){}</script>` +
    `<script src="${esc(cfg.scriptUrl)}" async></script>`
  );
}

// The widget reads the cart token from a NON-httpOnly X-Cart-Token cookie (via the localStorage
// bridge above). rt_cart stays httpOnly for the server; this mirrors the same token for the widget.
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days, matches a cart's life
export function readableCartCookie(token: string): string {
  return `X-Cart-Token=${encodeURIComponent(token)}; Path=/; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`;
}
