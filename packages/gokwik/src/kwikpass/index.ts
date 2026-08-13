import type { StorefrontIntegration, IntegrationContext } from '../types';
import { GOKWIK_CSP } from '../csp';
import { kwikpassTag, type KwikpassConfig } from './kwikpass';

// mid = tenant's merchantId (DB); SDK url + environment from env (shared with checkout). No defaults.
function configFrom(ctx: IntegrationContext): Partial<KwikpassConfig> {
  return {
    scriptUrl: ctx.env.GOKWIK_SCRIPT_URL,
    mid: ctx.merchantId,
    environment: ctx.env.GOKWIK_ENVIRONMENT,
  };
}

export const kwikpassIntegration: StorefrontIntegration = {
  name: 'gokwik-kwikpass',
  enabled: (ctx) => {
    const c = configFrom(ctx);
    return !!(c.scriptUrl && c.mid && c.environment);
  },
  bodyEnd: (ctx) => kwikpassTag(configFrom(ctx)),
  csp: () => GOKWIK_CSP,
};
