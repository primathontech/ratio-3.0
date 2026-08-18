# 1 — Project Overview

## What it is

Ratio 3.0 (internally "R3", product name **OpenStore**) is a **clean re-platform** of a Shopify-like
storefront + theme system. The one-line positioning:

> **"Shopify for India — cheaper, ultra-fast, AI-native."**

Three product bets, in strict priority order (this ordering decides architecture trade-offs — see
04-conventions.md):

1. **Cost** — run stores far cheaper than Shopify.
2. **Performance** — ultra-fast storefronts (edge-rendered, aggressively cached).
3. **AI-native** — the AI can see and change the _whole_ store. This is the long game; the
   theme-ownership work (below) is the substrate that makes it possible.

## Current state (as of this handoff)

- **Pre-launch.** Staging/dev environments exist; there is **no real production traffic**. Bias toward
  shipping and iterating over production-grade caution.
- A small number of real merchant stores exist for testing (onboarded via the admin flow). Commerce
  data is served from a real **GoKwik** backend (see 08-external-integrations.md).
- The storefront renders through the **bundle theme system** (base ⊕ overrides, S3-backed). The older
  page-builder/content-model renderer is a legacy/degrade path being phased out.

## How the pieces fit (names you'll see everywhere)

- **Tenant / store** — one merchant. Keyed by a generated id like `t_<slug>_<hex>` (older/test ids
  vary, e.g. `t_e2e618`). The tenant row holds `live_theme_id` + `live_theme_version` (the active
  theme pointer the origin renders from) and `commerce` (the GoKwik `merchantId`).
- **Theme (bundle)** — a set of Liquid + JSON + CSS files stored as a gzip bundle in S3, plus binary
  assets stored content-hash-addressed. A store's theme is `base ⊕ overrides`: it tracks a shared
  **library base theme** and stores only the files it changed.
- **Origin** — the Hono service that renders a store's live theme to HTML.
- **Edge** — the Cloudflare worker: host → tenant routing, cache, proxy to origin.
- **admin-api / admin-web** — the merchant control plane (edit code, upload assets, publish, activate,
  roll back, onboard).

## Source-of-truth docs (Confluence, space `R3`)

The Jira/Confluence live in `prima.atlassian.net`. Key pages (fetch via the Atlassian MCP or browser):

- **System Architecture (S0–S8)** — the ADR index / architecture SoT.
- **ADR-012** (tech stack), **ADR-013** (page builder / render-at-edge), **ADR-008** (runtime &
  resilience), **ADR-010** (admin auth: Clerk authN + Postgres authZ).
- **"Design — The Whole Theme in the Merchant's Hands"** (page 28508174) — the Full Theme Ownership
  design, the epic currently in flight (see 07-roadmap-and-state.md).
- **DB schema ERD** (Confluence 27525121) — the Postgres schema SoT.

> Convention: **one source of truth per topic.** Don't create parallel deep-dives; extend the existing
> ADR/overview. There is no Confluence delete tool — superseded pages get tombstoned, not removed.
