import { LOCAL_EDGE_PORT } from '../../common/constants';

// Suggest a platform subdomain from a store name (onboarding step 2). The merchant can override it;
// this just seeds a sensible default so most merchants never touch the domain field.
export const PLATFORM_DOMAIN = 'ratiodev.in';

export function subdomainFromName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function suggestHost(name: string): string {
  const sub = subdomainFromName(name);
  return sub ? `${sub}.${PLATFORM_DOMAIN}` : '';
}

// The URL to open the live storefront from the wizard's success screen. In local dev the store is
// reachable at its `<label>.localhost` alias on the local edge (:8080 over http) — provisioning
// registers that alias as `${host.split('.')[0]}.localhost`, so we derive it the same way (the
// entered .ratiodev.in host doesn't resolve to localhost). Otherwise use the API-returned https URL.
export function liveStoreUrl(host: string, storeUrl: string | null, isLocal: boolean): string {
  if (isLocal) return `http://${host.split('.')[0]}.localhost:${LOCAL_EDGE_PORT}`;
  return storeUrl ?? `https://${host}`;
}
