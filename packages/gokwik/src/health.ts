// Config sanity for the GoKwik purchase path. The side-cart drawer and checkout are gated on SEPARATE
// env vars (GOKWIK_SIDECART_SCRIPT_URL vs GOKWIK_BASE_SCRIPT_URL). Three states matter:
//   - ready:   both configured — the storefront can add to cart AND check out.
//   - partial: exactly one configured — looks fine but silently breaks (e.g. the drawer opens yet
//              Checkout does nothing). A deployment mistake the origin should surface loudly.
//   - off:     neither configured — the storefront has NO cart/checkout at all (can't sell).
import type { IntegrationContext } from './types';
import { sideCartIntegration } from './side-cart';
import { checkoutIntegration } from './checkout';

export type CheckoutPathStatus = 'ready' | 'partial' | 'off';

export interface CheckoutPathHealth {
  status: CheckoutPathStatus;
  sideCart: boolean;
  checkout: boolean;
}

// Reports the cart-drawer + checkout env coherence. Probes the integrations' own enabled() with a
// placeholder merchant id, so this reflects PLATFORM (env) config completeness — independent of any
// per-tenant merchant id, which is present per-request, not at boot.
export function checkoutPathHealth(env: Record<string, string | undefined>): CheckoutPathHealth {
  const ctx: IntegrationContext = { env, merchantId: '__probe__', page: 'home' };
  const sideCart = sideCartIntegration.enabled(ctx);
  const checkout = checkoutIntegration.enabled(ctx);
  const status: CheckoutPathStatus =
    sideCart && checkout ? 'ready' : !sideCart && !checkout ? 'off' : 'partial';
  return { status, sideCart, checkout };
}
