# EdgeKV — host→tenant routing store (Akamai)

The Akamai equivalent of Workers KV. Holds the same `host:{host}` → `{"t": tenantId}` mapping the
Cloudflare edge uses (see `packages/edge-core/tenant-resolve.ts`). The EdgeWorker reads it first and
falls back to Postgres on a miss (edge-core `lookupTenant`, with the EdgeKV client injected).

To set up (OFCE-476, on the Akamai account):

1. Create an EdgeKV namespace (e.g. `ratio_tenants`) + group.
2. Generate an EdgeKV access token; bundle it with the EdgeWorker.
3. Drop the `edgekv.js` + `edgekv_tokens.js` helper here (from the Akamai EdgeKV starter).
4. The control plane writes/removes keys via `packages/edge-provider/akamai.ts` (verified-only, H1).

Note: EdgeKV is eventually consistent — same model as the Workers KV write-through + TTL backstop.
