// The control plane's edge seam. admin-api touches the edge in two ways — it write-throughs the
// host→tenant routing map, and it provisions per-merchant custom hostnames + TLS. Both are
// platform-specific, so they sit behind this one interface; admin-api picks a provider by config
// (cloudflare.ts today, akamai.ts next) instead of hard-coding a vendor.
export interface EdgeProvider {
  // Publish/refresh the verified host→tenant mapping in the edge KV (verified-only, H1).
  publishTenantMapping(host: string, tenantId: string): Promise<void>;
  // Remove a host→tenant mapping (domain removed / store deleted / suspended).
  unpublishTenantMapping(host: string): Promise<void>;
  // Provision a custom hostname + managed TLS for a merchant domain (DV kicked off).
  createCustomHostname(host: string, tenantId: string): Promise<void>;
  // Poll DV + cert status; true once the hostname is active and serving over HTTPS.
  isCustomHostnameActive(host: string): Promise<boolean>;
}
