# CLAUDE.md

Guidance for Claude Code (and any developer) working in this repository. Read this first, then the
deeper references it points to.

## Context pack (read for anything non-trivial)

`.claude/context/` is the developer handbook — read the relevant page **before** opening source to
understand a subsystem or make a change:

- `context/01-project-overview.md` — what Ratio 3.0 is, the product bet, current state.
- `context/02-architecture.md` — edge → origin → admin-api → admin-web, data stores, request flow.
- `context/03-local-dev-and-testing.md` — run it, the exact test incantation, ports, env.
- `context/04-conventions.md` — coding/testing/git conventions + decision priority (the narrative behind `.claude/rules/`).
- `context/05-theme-system.md` — the bundle theme system (the core domain, most active area).
- `context/06-gotchas.md` — the landmines. **Read before touching render/theme/CI.**
- `context/07-roadmap-and-state.md` — epics, what shipped, the current resume point.
- `context/08-external-integrations.md` — GoKwik commerce, auth, MCP, the test merchant.

Behavioral rules live in `.claude/rules/` (git workflow, testing, security, coding style) — they
override convenience and are non-negotiable. Reusable workflows live in `.claude/skills/`.

## What this is

Ratio 3.0 ("OpenStore") — a **multi-tenant, Shopify-like storefront + theme platform**: _"Shopify for
India — cheaper, ultra-fast, AI-native."_ Each merchant's storefront renders from a **theme bundle**
(Liquid + JSON + CSS in S3, composed as `base ⊕ per-store overrides`). A **Cloudflare edge** worker
routes host→tenant, caches, and proxies to a **Hono origin** that renders the theme; **admin-api** +
**admin-web** are the merchant control plane; **Postgres** is the tenant/theme system of record.
Commerce data (products/cart/orders) comes from an **external GoKwik backend**, not our DB.

**Pre-launch / staging — no real production traffic.** Move fast; build the product, not a POC; don't
apply prod-grade caution. (See `rules/` for the full posture.)

## Monorepo (bun workspaces: `apps/*`, `packages/*`)

- `apps/`: **edge** (Cloudflare Worker, :8080), **origin** (Hono render service, :9090, private),
  **admin-api** (control plane, :8787), **admin-web** (Vite/React SPA, :5173).
- `packages/`: **builder-core** (theme domain — the important one), **builder-render** (Liquid engine —
  ⚠️ two hand-synced copies), **data-db** (Postgres), **data-objects** (S3/MinIO), **edge-core**,
  **gokwik**, **observability-\***.

## Commands

```bash
bun run db:up           # docker: Postgres (:5433) + MinIO (:9000)
bun run db:init         # run migrations
bun run dev             # edge :8080, origin :9090, admin-api :8787, admin-web :5173
bun run typecheck       # root tsc --noEmit — EXCLUDES apps/admin-web; run its own tsc separately (below)
bun run test            # full suite (test:setup then node:test)

# single test file — real Postgres (5433) + MinIO (9000), both 'poc' creds, bootstrap import required:
DATABASE_URL="postgres://poc:poc@localhost:5433/s2poc_test" \
BUNDLE_S3_ENDPOINT="http://localhost:9000" BUNDLE_S3_BUCKET="s2poc-test" \
BUNDLE_S3_KEY="poc" BUNDLE_S3_SECRET="poc12345" \
node --import tsx --import ./tests/bootstrap.ts --test <path/to/file.test.ts>
```

`admin-web` uses **vitest** (`cd apps/admin-web && npx vitest run <file>`), the rest uses **node:test**.
Render a store locally via the edge: `http://localhost:8080/?store=<tenantId>`.

## Architecture (one screen)

```
visitor ─▶ edge (host→tenant; cache; ?store=<id> on localhost) ─▶ origin (x-edge-auth)
             origin: load tenant.live_theme_id → loadLiveCompiled (S3) → render sections
             (untrusted Liquid in a worker isolate) + chrome; resolve products via GoKwik
```

Postgres is SoT (`tenants`, `theme`, `theme_bundle_version`, `domains`, `memberships`, `page_purge_outbox`).
S3/MinIO holds theme bundles (content-addressed) + binary assets. Publishing/activating enqueues a
durable tenant-tag purge to the edge. Details: `context/02-architecture.md`.

## Top gotchas (full list in `context/06-gotchas.md`)

- **Two render engines**: `builder-render/engine.ts` (trusted) + `worker.mjs` (isolate, untrusted). A
  filter added to one MUST be mirrored in the other + the parity test — else the storefront silently
  diverges (this caused the `asset_url` and money-100× bugs).
- **`saveOverrides` deletes omitted base files** — always save the FULL composed tree, never a partial.
- **`getProducts` uses `first`, not `productLimit`** (a COLLECTION-only field it ignores → defaults to 20).
- **CI has no MinIO** — gate bundle/render tests on `BUNDLE_S3_ENDPOINT` (skip when unset).
- **Root `bun run typecheck` excludes `apps/admin-web`** (root tsconfig `exclude`), so it doesn't
  type-check admin-web at all — run `cd apps/admin-web && npx tsc --noEmit` (the separate `admin-ui` CI job) when you touch it.

## Non-negotiables (see `.claude/rules/`)

- **Never commit/push without explicit approval.** Never `git add -A`. Branch off `main` (no `dev` on
  the remote).
- **Reproduce a reported bug with a failing test first**, then fix. Real DB + MinIO, no DB mocks.
- **Self-review every PR** (code-review + fix findings) before asking for merge; loop until clean.
- **Never read/echo `.env` or hardcode secrets.** Config is env-var names; values live in `.env` /
  CI repo variables.
