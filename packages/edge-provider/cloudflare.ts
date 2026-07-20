import type { EdgeProvider } from './types';

// Cloudflare implementation of the edge seam. The routing write-through + custom-hostname logic
// already exists in services/admin-api/domains.ts (Workers KV REST + Cloudflare for SaaS); this
// adapter is where that gets consolidated behind the EdgeProvider interface (follow-up refactor).
const todo = (m: string): never => {
  throw new Error(`edge-provider/cloudflare: ${m} — wire to services/admin-api/domains.ts`);
};

export const cloudflareEdgeProvider: EdgeProvider = {
  publishTenantMapping: () => todo('publishTenantMapping'),
  unpublishTenantMapping: () => todo('unpublishTenantMapping'),
  createCustomHostname: () => todo('createCustomHostname'),
  isCustomHostnameActive: () => todo('isCustomHostnameActive'),
};
