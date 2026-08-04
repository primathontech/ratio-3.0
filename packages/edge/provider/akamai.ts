import type { EdgeProvider } from './types';

// Akamai implementation of the edge seam (scaffold). publish/unpublish → EdgeKV writes;
// createCustomHostname/isCustomHostnameActive → CPS enrollment + DV + activation. This is the
// biggest Akamai build (OFCE-477) — the per-merchant custom-domain automation.
const todo = (m: string): never => {
  throw new Error(`edge-provider/akamai: ${m} not implemented yet (OFCE-477)`);
};

export const akamaiEdgeProvider: EdgeProvider = {
  publishTenantMapping: () => todo('publishTenantMapping (EdgeKV write)'),
  unpublishTenantMapping: () => todo('unpublishTenantMapping (EdgeKV delete)'),
  createCustomHostname: () => todo('createCustomHostname (CPS enroll + DV)'),
  isCustomHostnameActive: () => todo('isCustomHostnameActive (CPS status poll)'),
};
