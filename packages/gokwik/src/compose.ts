import type { CspDirectives, IntegrationContext, StorefrontIntegration } from './types';
import { mergeCsp } from './csp';
import { GOKWIK_INTEGRATIONS } from './registry';

export interface ComposedIntegrations {
  head: string; // markup for <head>
  bodyEnd: string; // markup before </body>
  csp: CspDirectives; // union of every enabled integration's directives (empty when none enabled)
}

// Collect the enabled integrations' page contributions. The caller merges `csp` onto the storefront's
// strict base and injects `head`/`bodyEnd` into the page. Pure string work, safe to call per request.
export function composeGokwik(
  ctx: IntegrationContext,
  integrations: StorefrontIntegration[] = GOKWIK_INTEGRATIONS
): ComposedIntegrations {
  const active = integrations.filter((i) => i.enabled(ctx));
  const head = active.map((i) => i.head?.(ctx) ?? '').join('');
  const bodyEnd = active.map((i) => i.bodyEnd?.(ctx) ?? '').join('');
  let csp: CspDirectives = {};
  for (const i of active) csp = mergeCsp(csp, i.csp?.(ctx) ?? {});
  return { head, bodyEnd, csp };
}

// Set-Cookie values the enabled integrations need appended when the cart token changes.
export function gokwikCartCookies(
  token: string,
  ctx: IntegrationContext,
  integrations: StorefrontIntegration[] = GOKWIK_INTEGRATIONS
): string[] {
  return integrations
    .filter((i) => i.enabled(ctx))
    .flatMap((i) => i.cartTokenCookies?.(token, ctx) ?? []);
}
