import type { StorefrontIntegration } from './types';
import { sideCartIntegration } from './side-cart';
import { checkoutIntegration } from './checkout';

// Every GoKwik widget the storefront can turn on. Add kwikpass/… here as they land — no other file
// changes to enable a new one.
export const GOKWIK_INTEGRATIONS: StorefrontIntegration[] = [
  sideCartIntegration,
  checkoutIntegration,
];
