# 8 — External Integrations & Tooling

## Commerce backend — GoKwik (external)

Products, collections, cart, and orders come from **GoKwik**, not our DB. The seam:

- `commerceResolverFromEnv(env)` builds a `ShopkitResolver` when the platform URLs are configured, else
  `null` → callers fall back to `StubResolver` (sample data). Per-merchant creds come from
  `tenant.commerce.merchantId` (a GoKwik merchant id); `storeId` defaults to `merchantId`.
- Env (names only; values in `.env` / CI repo variables) — all three required for the real resolver:
  `COMMERCE_PRODUCT_API_URL`, `COMMERCE_CART_API_URL`, `COMMERCE_ORDER_API_URL`
  (+ `COMMERCE_NAV_API_URL` for menus). Documented in `.env.example`:
  - **prod**: `https://gkx.gokwik.co/ps` · `/os` · `/cs`
  - **dev sandbox**: `https://api-gw-v4.dev.gokwik.io/sandbox/pi/ps` · `/os` · `/cs`
- In **production** the origin refuses to boot without these (`storefrontResolver` throws) — to avoid
  silently serving "Sample product N". Non-prod keeps the stub fallback.
- The GoKwik **widget** integrations (side-cart, checkout, thank-you) live in `packages/gokwik` behind
  one seam. Config from the DB `merchantId` + env; **no fallbacks**; `composeGokwik` must run on every
  page. Per-widget env gating (`SIDECART` vs `BASE_SCRIPT_URL`) is a footgun — check `GOKWIK_*` env names.
  The thank-you/Purchase event uses `orderName` (camelCase, intentional — don't revert to snake_case).

### Test merchant (real-catalog verification)

Merchant **`196jdfqy1aot`** is the standing fixture for verifying real-catalog rendering. It's on
**prod GoKwik** (`gkx.gokwik.co`), returns ~20 real test products via a `PRODUCTS` listing, and has
**no `all`/`new-launches` collections**. Use it to confirm preview/storefront show real products (not
stub). It is not necessarily onboarded in the local DB — verify via an in-process harness (set
`COMMERCE_*` to prod GoKwik, a tenant with `commerce.merchantId=196jdfqy1aot`, drive the preview route
or the resolver directly). Hitting live GoKwik is a **manual** check, not a committed test.

## Auth — Clerk + Postgres

ADR-010: **Clerk** for authN (the admin-api verifies a bearer token → `userId`), **Postgres**
`memberships` for authZ (`requireMembership` / `requireRole('owner')`). Publish/activate/delete are
owner-only; edits are member-writable.

## Observability

Structured, allowlisted JSON logs on the origin (`packages/observability-*`), replacing silent
`catch{}`. OpenTelemetry is origin-first (tier 2); the edge stays Workers-native. Live-debug deployed
via `aws logs tail` (no redeploy needed).

## MCP servers available (when working via Claude)

- **Atlassian** (`prima.atlassian.net`) — Jira (project OFCE) + Confluence (space R3). Create/edit
  issues, read ADRs/design docs. Confluence renders ` ```mermaid ` blocks as diagrams; editing a page
  with inline comments via markdown strips the anchors — use `contentFormat: html` there.
- **ratio-mcp-dev / ratio-mcp-doc** — the Ratio _developer platform_ (a separate B2B app marketplace
  where devs build "apps/agents" merchants install). Distinct from this storefront repo; relevant only
  if working on that platform.
- **shopify-dev-mcp**, **prompt-enhancer**, **Slack/Notion/Figma/Google Calendar** — general tooling.

## CI / deploy env injection

The origin + admin-api get `COMMERCE_*`, `GOKWIK_*`, `EDGE_SECRET`, `DATABASE_URL`, `BUNDLE_S3_*`,
etc. **injected by CI from GitHub repo variables** into the ECS task definitions — they are **not**
committed. (`THEME_OWNS_DOCUMENT` was removed entirely in #280 — full theme ownership is now the
unconditional default; don't reintroduce it.) GitHub repo `primathontech/ratio-3.0`; PRs target `main`.
