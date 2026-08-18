# 2 — Architecture

## Monorepo layout

Bun workspaces (`workspaces: ["packages/*", "apps/*"]`). TypeScript throughout; run via `tsx` in dev
and tests, esbuild/`worker.mjs` where an isolate/edge bundle is needed.

### `apps/`

- **`edge`** — Cloudflare Worker (Hono on `workerd`). The public entry. Resolves host → tenant, serves
  from cache, proxies everything else to the origin with an edge-auth header. Local dev: `:8080`.
- **`origin`** — Hono service (containers/ECS in deployed envs). Renders a store's **live** theme to
  HTML, serves `/assets/<hash>`, order/thank-you pages. Private — requires `x-edge-auth`. Local: `:9090`.
- **`admin-api`** — Hono service. The merchant control plane API: theme CRUD, draft save, preview,
  publish, activate, rollback, asset upload, onboarding, commerce connection. Clerk-authed. Local: `:8787`.
- **`admin-web`** — Vite + React SPA (the merchant dashboard / code editor). Local: `:5173`.

### `packages/`

- **`builder-core`** — the domain core: theme model (`ThemeFiles`, `ThemeStore`, base⊕overrides,
  publish/rebase), the default/base theme, page composition, commerce resolvers, storefront chrome.
  **The most important package.** See 05-theme-system.md.
- **`builder-render`** — the Liquid render engine. Has **TWO copies** of the engine: `engine.ts`
  (in-process, trusted) and `worker.mjs` (a hand-written isolate copy for untrusted merchant Liquid).
  ⚠️ These are hand-synced — see 06-gotchas.md.
- **`data-db`** — Postgres pool + `configureDb`. Tenant/theme system of record.
- **`data-objects`** — S3 object store (`S3ObjectStore`) for theme bundles + assets (MinIO locally,
  S3/CloudFront deployed).
- **`edge-core`** — shared edge helpers: host→tenant lookup, edge-auth secret, headers/CSP.
- **`gokwik`** — the GoKwik commerce integrations (side-cart, checkout, thank-you) behind one seam.
- **`control-plane-client`, `data-provisioning`, `data-repo`, `builder-registry`, `observability-*`** —
  supporting: provisioning, control-plane RPC, first-party section registry, structured logging/OTel.

## Request flow (storefront)

```
visitor ──▶ edge (:8080, Cloudflare Worker)
             │  resolve host → tenant_id (domains table; or ?store=<id> on localhost)
             │  cache hit? serve. miss ▼
             ▼
           origin (:9090, private, x-edge-auth)
             │  load tenant.live_theme_id / live_theme_version
             │  loadLiveCompiled(tenant) ← compiled theme bundle from S3
             │  render sections (untrusted Liquid → worker isolate) + chrome
             │  resolve product/collection data ← GoKwik resolver (external)
             ▼
           HTML  (x-theme-render: layout | shell ; x-handler: theme-bundle)
```

- **Tenant resolution (edge):** by verified custom domain (`domains` table) in deployed envs; on
  **localhost** a `?store=<tenantId>` query override is allowed (`storeOverrideAllowed`). The origin
  itself trusts the `x-ratio-tenant` header the edge sets.
- **Edge auth:** `resolveEdgeSecret(env)` — `EDGE_SECRET` in deployed envs; a dev default otherwise
  (must be set in production). The origin 403s without it.
- **Caching:** edge caches per-tenant; publishing/activating enqueues a durable **tenant-tag purge**
  (`page_purge_outbox`) drained to the edge. This is why publish/rollback move fast but stay correct.

## Data stores

- **Postgres** (system of record): `tenants`, `theme`, `theme_bundle_version`, `theme_file`,
  `domains`, `memberships`, `pages`, `page_purge_outbox`. Migrations in `db/migrations/`. The `theme`
  table is keyed by `id` alone (tenant scoping is enforced in query code, `WHERE ... AND tenant_id=$2`).
- **S3 / MinIO** (`BUNDLE_S3_*`): theme source bundles (gzip), compiled bundles (content-addressed by
  hash), and binary assets (content-hash keyed). CloudFront read-through in deployed dev.
- **Commerce backend (GoKwik, external):** products, collections, cart, orders. Never in our DB. Per-
  merchant creds come from `tenant.commerce.merchantId` + platform URLs from env. See 08-…-integrations.

## Deploy shape (for context)

- Edge → Cloudflare (`wrangler`). Origin + admin-api → containers/ECS. Env for the origin/admin-api is
  **CI-injected from GitHub repo variables** (e.g. `COMMERCE_*`, `GOKWIK_*`), not committed. The remote
  canonical GitHub repo is `primathontech/ratio-3.0` (the local `origin` may show the old `…-cloudflare`
  name, which redirects); PRs merge into **`main`** (there is no `dev` branch on the remote,
  despite some tooling defaults).
