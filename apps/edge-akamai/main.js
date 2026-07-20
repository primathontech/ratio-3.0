// Akamai EdgeWorkers entry — the edge SHELL adapter (PoC / OFCE-476).
// It reuses the shared brain in packages/edge-core; only the platform bindings live here.
// Bundle with build.mjs (esbuild resolves the edge-core TypeScript) → run in the Akamai Sandbox.
//
// What this proves locally (sandbox, no account): edge-core bundles to EdgeWorkers-safe JS, the
// event-handler model works, and routing + header-inject run within the CPU/subrequest limits.
// What still needs the real account: real EdgeKV, Property Manager serve-stale/Site Shield, CPS.

import { logger } from 'log';
import { lookupTenant } from '../../packages/edge-core/index';

// TODO(OFCE-476): replace this stub with the real Akamai EdgeKV client (edgekv/edgekv.js, dropped in
// during account setup). Same interface edge-core's lookupTenant expects: get(key)/put(key,value).
const edgeKv = {
  async get(_key) {
    return null;
  },
  async put(_key, _value) {
    /* no-op stub */
  },
};

export async function onClientRequest(request) {
  const host = (request.host || '').split(':')[0].toLowerCase();

  // edge-core resolves KV-first. On Akamai the DB fallback can't be the Neon serverless driver
  // (won't run at the edge) — TODO(OFCE-476): make it an httpRequest to admin-api /resolve?host=.
  const tenantId = await lookupTenant(host, edgeKv, async () => null);

  if (!tenantId) {
    request.respondWith(404, { 'Content-Type': ['text/html'] }, '<h1>Store not found</h1>');
    return;
  }

  // Inject the trusted headers the private origin requires (mirrors the Cloudflare adapter).
  // x-edge-auth comes from a Property Manager user variable, never the source tree.
  request.setHeader('x-ratio-tenant', tenantId);
  request.setHeader('x-edge-auth', request.getVariable('PMUSER_EDGE_SECRET') || '');
  logger.log('routed host=%s tenant=%s', host, tenantId);

  // Caching + serve-stale are Property Manager config (see property/), not code. The request now
  // continues to the Site-Shielded origin.
}

// TODO(OFCE-476): branded 503 via responseProvider, reusing edge-core's store-unavailable HTML,
// for the case where even Property Manager serve-stale can't help.
