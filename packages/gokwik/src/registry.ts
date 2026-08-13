import type { StorefrontIntegration } from './types';
import { sideCartIntegration } from './side-cart';
import { checkoutIntegration } from './checkout';
import { kwikpassIntegration } from './kwikpass';

// Every GoKwik widget the storefront can turn on. Add new ones here — no other file changes needed.
export const GOKWIK_INTEGRATIONS: StorefrontIntegration[] = [
  sideCartIntegration,
  checkoutIntegration,
  kwikpassIntegration,
];
