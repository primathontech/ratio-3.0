# Current-State Map — New OS Architecture

> Source: parallel Understand pass (6 agents, 2026-06-23) over plans + repos. Evidence paths inline.
> This is _current state_, not design. Design follows after user confirms this map.

## 1. The new framework — `bblunt-2.0`

**Location:** `/Users/lakshyagokwik/Developer/code-editor/bblunt-2.0/`

- **Stack:** Next.js 15 (App Router), React 18, TypeScript 5, Tailwind 3, Zustand, Bun. Port 4344.
- **Built on `@shopkit/*` ecosystem** (the real meaning of "shopkit" — internal package namespace, not a framework):
  - `@shopkit/builder` (page engine, PageConfig), `@shopkit/data-layer` (commerce client abstraction), `@shopkit/cart`, `@shopkit/webhooks`, `@shopkit/events`, `@shopkit/discounts`, `@shopkit/seo`, `@shopkit/i18n`, `@shopkit/asset-cache`, `@shopkit/core`, `@shopkit/cli`, `@shopkit/app-shell`, `@shopkit/editor-bridge`, `@shopkit/ai-store-builder`.
- **Customization model (3 layers):** Themes (JSON + CSS vars) → Templates (`PageConfig`) → Widgets (React components w/ V1/V2 variants). 52+ widgets, CLI codegen.
- **Extensibility:** `src/integrations/` with platform pairs — `checkout-shopify`/`checkout-custom`, `cart-drawer-shopify`/`custom`, `kwikpass-shopify`/`custom`, `kwikcart-custom`. Platform switch via `NEXT_PUBLIC_PLATFORM` env (`shopify|custom`); `src/config/commerce.ts` builds the client.
- **AI enablement:** `@shopkit/ai-store-builder` — Claude-powered store generation (StoreAgent + WebsiteScraper).
- **Performance governance:** Husky pre-commit + CI enforce widget/template/route validation, asset limits (img <500KB, vid <5MB, font <100KB), perf score ≥75/100, build verification.
- **Rendering:** App Router SSR + static gen (180s build timeout). No edge compute detected.
- **Companion editor:** `storefront-editor-2` (Vite React SPA, `@shopkit/editor-bridge`, XState) + `os-editor-backend` (NestJS, TypeORM, PostgreSQL).

## 2. The older architecture ("older network")

**Location:** `old_architecture/` + `checkoutscripts/` + `gk-script/` + `gokwik-custom-checkout/` + `gokwik.pdp/`

- Tightly-coupled monolith. Node/Express + Sequelize backend.
- **Shopify coupling pervasive:** raw axios to Shopify REST Admin API `2021-01`; merchant `access_token`/`website` in DB; Shopify order creation hardcoded.
- **God files / duplication:** `createOrder.js` (772 LOC) ≈ `createOrderWithouttran.js` (735 LOC). Payment methods hardcoded strings (UPI/COD/CC/DC). Platform logic (prepaid vs COD branching, Shopify tags) scattered.
- **Infra:** AWS Lambda + SQS for async order processing; separate payments DB (replication); minimal error handling/observability.
- Frontends: Svelte SPAs (`gokwik-custom-checkout` 80+ stores, `gokwik.pdp` w/ OpenTelemetry).
- Note: `old_architecture/src/integrations/` mirrors bblunt-2.0's integration structure — suggests an in-progress port.

## 3. Shopkit migration surface (old → new)

Migrate platform-specific commerce logic into `@shopkit/*` packages consumed by bblunt-2.0:

- Cart/checkout adapters, webhook handlers (`@shopkit/webhooks` → Shopify products/collections/inventory webhooks), platform branching (`commerce.ts`).
- Old-arch business logic (discounts, order creation, tags) currently god-filed in `checkoutscripts`.
- `backend/` (NestJS) also holds Shopify webhook processors (HMAC-verified).

## 4. "Layer 1" — AMBIGUOUS, needs user confirmation

Two distinct meanings found:

- **(a) Editor security layer:** In the decoupling plan, "Layer 1" = iframe detection (`window.self === window.top`) in `useIframeAuth.ts` — first of a 4-layer cross-origin auth gate (L2 origin, L3 source, L4 sessionKey). _This is a security gate, not an availability tier._
- **(b) Infra/serving tier (user's likely meaning):** "Layer 1 being down" sounds like an availability/serving layer (e.g., CDN/edge as L1, origin/SSR as L2, commerce backend as L3). **The plan does NOT define infra layers by number.**
- `FrontLineGuardian` (`gk-error-wrapper`/`frontline-gaurdian`) = error capture only; explicitly NO circuit breaker, heartbeat, or fallback UI by design.

→ **Must ask the user what "Layer 1" means before designing SPOF resilience.**

## 5. Current single points of failure (observed)

- Unified editor pod serving all merchants (one DNS, one pod).
- Backend auth model undefined (`os-editor-backend` / `visual-editor-be`).
- Old-arch: hardcoded Shopify API version, single DB primary hints, Lambda/SQS coupling, sparse fallback.
- bblunt-2.0 SSR: no edge/CDN fallback layer detected for origin failure.

## 6. Biggest open questions (pre-design)

1. **What does "Layer 1" mean to you?** (security gate vs infra serving tier)
2. Multi-tenant model: is bblunt-2.0 single-tenant-per-merchant (one deploy each) or one multi-tenant deploy? (Drives the 100→5000 merchant + spiky-traffic strategy.)
3. `@shopkit/data-layer` abstraction: how does it map Shopify GraphQL ↔ custom REST product/cart/collection schemas?
4. Deployment: static prerender vs ISR vs on-demand SSR? Cache invalidation on template/widget change?
5. AI flow: how is `@shopkit/ai-store-builder` invoked, with what guardrails?
6. Is `old_architecture/` an in-progress port of the same integrations, or genuinely legacy to retire?
