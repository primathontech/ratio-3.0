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

// The URL to open the live storefront from the wizard's success screen. In local dev a `.localhost`
// host is served by the local edge on :8080 over http; otherwise use the API-returned https URL.
const LOCAL_EDGE_PORT = '8080';
export function liveStoreUrl(host: string, storeUrl: string | null, isLocal: boolean): string {
  if (isLocal && host.endsWith('.localhost')) return `http://${host}:${LOCAL_EDGE_PORT}`;
  return storeUrl ?? `https://${host}`;
}
