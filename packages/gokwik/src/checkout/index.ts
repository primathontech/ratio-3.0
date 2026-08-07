import type { StorefrontIntegration, IntegrationContext } from '../types';
import { GOKWIK_CSP } from '../csp';
import { checkoutTag, type CheckoutConfig } from './checkout';

// mid is the tenant's merchantId (from the DB record); the SDK url + environment are platform config
// from env. `type` is always 'merchantInfo' for the CUSTOM platform (a GoKwik constant, like the
// gkPlatform markers), not configurable. No defaults on env — a missing value leaves checkout off.
function configFrom(ctx: IntegrationContext): Partial<CheckoutConfig> {
  return {
    scriptUrl: ctx.env.GOKWIK_SCRIPT_URL,
    mid: ctx.merchantId,
    environment: ctx.env.GOKWIK_ENVIRONMENT,
    type: 'merchantInfo',
  };
}

export const checkoutIntegration: StorefrontIntegration = {
  name: 'gokwik-checkout',
  enabled: (ctx) => {
    const c = configFrom(ctx);
    return !!(c.scriptUrl && c.mid && c.environment && c.type);
  },
  bodyEnd: (ctx) => checkoutTag(configFrom(ctx)),
  csp: () => GOKWIK_CSP,
};
