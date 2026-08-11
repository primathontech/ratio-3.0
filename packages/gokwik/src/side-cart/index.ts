import type { StorefrontIntegration, IntegrationContext } from '../types';
import { GOKWIK_CSP } from '../csp';
import { sideCartTag, readableCartCookie, type SideCartConfig } from './side-cart';

// mid is the tenant's merchantId (the one id, from the DB record); the rest is platform config from
// env. No defaults — a missing value leaves the integration off rather than guessing.
function configFrom(ctx: IntegrationContext): Partial<SideCartConfig> {
  return {
    scriptUrl: ctx.env.GOKWIK_SIDECART_SCRIPT_URL,
    mid: ctx.merchantId,
    environment: ctx.env.GOKWIK_ENVIRONMENT,
    currency: ctx.env.GOKWIK_CURRENCY,
    currencyFormat: ctx.env.GOKWIK_CURRENCY_FORMAT,
  };
}

export const sideCartIntegration: StorefrontIntegration = {
  name: 'gokwik-side-cart',
  enabled: (ctx) => {
    const c = configFrom(ctx);
    return !!(c.scriptUrl && c.mid && c.environment && c.currency && c.currencyFormat);
  },
  bodyEnd: (ctx) => sideCartTag(configFrom(ctx)),
  csp: () => GOKWIK_CSP,
  cartTokenCookies: (token) => [readableCartCookie(token)],
};
