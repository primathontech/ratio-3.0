# apps/edge-akamai — Akamai EdgeWorkers edge (scaffold)

The Akamai edge adapter. Mirrors what `apps/edge/` (the Cloudflare Worker) does, but on Akamai
EdgeWorkers + Property Manager, reusing the shared logic in **`packages/edge-core/`**.

> **Status:** scaffold only. The real build is **OFCE-476** (EdgeWorkers PoC) and runs on the
> contracted Akamai account. Decision to adopt Akamai is gated on the marginal-cost check (OFCE-478).
> See the [Edge Platform gap analysis](https://prima.atlassian.net/wiki/spaces/R3/pages/19398745).

## What runs where

| Concern               | Cloudflare (`apps/edge`)        | Akamai (here)                                               |
| --------------------- | ------------------------------- | ----------------------------------------------------------- |
| routing (host→tenant) | Worker + Workers KV             | EdgeWorkers + **EdgeKV** (`edgekv/`)                        |
| header inject / proxy | Worker code                     | EdgeWorkers `onClientRequest` / `onOriginRequest`           |
| cache + serve-stale   | code (`caches.default`)         | **Property Manager** rules (`property/`) — config, not code |
| 503 fallback          | `storeUnavailable()`            | EdgeWorkers `responseProvider` (reuses edge-core HTML)      |
| metrics/logs          | Workers Logs + Analytics Engine | **DataStream 2**                                            |

## The shared logic (do not duplicate)

Tenant resolution, the circuit-breaker state machine, the access-log/metric builders, and the
`store-unavailable` HTML all come from `packages/edge-core/` — the same code the Cloudflare adapter
uses. This adapter only supplies the **platform bindings** (EdgeKV client, `httpRequest`,
`createResponse`, logging) and the Property Manager config.

## Skeleton (to be filled in OFCE-476, on the Akamai account)

```js
// main.js — EdgeWorkers entry (event-handler model, JS not TS)
import { EdgeKV } from './edgekv/edgekv.js';
import { httpRequest } from 'http-request';
import { createResponse } from 'create-response';
// edge-core is bundled in at build time (TS → JS) so lookupTenant / buildMetricPoint etc. are reused.

export async function onClientRequest(request) {
  // 1. resolve host → tenantId from EdgeKV (edge-core lookupTenant, EdgeKV injected)
  // 2. inject x-ratio-tenant + x-edge-auth (edge-core proxyInit headers)
  // 3. let Property Manager handle caching + serve-stale; origin is Site-Shielded
}

export async function onOriginResponse(request, response) {
  // strip internal x-* headers (edge-core publicHeaders)
}

export function responseProvider(request) {
  // last-resort branded 503 when even stale can't be served (edge-core store-unavailable HTML)
}
```

## Local dev (sandbox — no Akamai account needed)

The PoC (OFCE-476) starts here, offline. Proves the shell bundles + runs; does **not** prove real
EdgeKV / Property Manager serve-stale / CPS (those need the account).

```bash
npm i -D esbuild                      # one-time (dev-only; not added to package.json/lock yet)
node apps/edge-akamai/build.mjs       # bundles main.js + edge-core → dist/main.js
tar czf edgeworker.tgz -C apps/edge-akamai/dist main.js -C .. bundle.json
akamai install edgeworkers sandbox    # one-time CLI setup
akamai sandbox create                 # local sandbox
# run requests against the sandbox; iterate on main.js
```

Files: `main.js` (EdgeWorkers entry, reuses `packages/edge-core`), `build.mjs` (esbuild bundler),
`bundle.json` (manifest), `edgekv/` + `property/` (setup notes).

## Build / activate (once the account is set up)

Akamai CLI: `akamai edgeworkers create-version <ewid> edgeworker.tgz` → `activate <ewid> STAGING`
→ poll until active → validate → `activate <ewid> PRODUCTION`. Property Manager rules activate
alongside (config-as-code, `property/`). Activation is on the Akamai network (minutes), unlike
`wrangler deploy`. Rollback = activate the previous version.
