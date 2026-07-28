# Spine Approaches — Request Path + Multi-Tenancy + Layer-1 Resilience (AWS + Akamai)

> 2026-06-25. Sub-project A+B+F. Goal: one platform serving 100→5000 merchants, spiky traffic, NO Layer-1 SPOF, beating Shopify on perf+SEO, on AWS EKS + Akamai only. Pick an approach, then deep-design it in sections.

## Shared mechanics (all approaches)

- **Multi-tenancy:** custom domain → Akamai → resolve `merchant_id` (EdgeWorker + EdgeKV map) → tenant is part of the cache key → origin renders per-tenant from multi-tenant Postgres (config, Layer 2) + commerce APIs (Layer 3). Tenant isolation = row-level scoping + per-tenant cache namespace + per-tenant purge.
- **SPOF principle:** the edge must be able to serve last-good HTML when the origin/shell (Layer 1) is down → `stale-if-error` + `stale-while-revalidate`. Origin is multi-region active-active on EKS (no single origin). Backend/data have their own resilience (sub-project H/D).
- **Publish path:** editor publish → config service writes `published` version → fires Akamai **Fast Purge** (tag-based, per tenant+path) → next request repopulates edge.

## Approach 1 — Edge-cached static HTML + origin ISR ("cache everything")

Shell renders full page HTML at multi-region EKS origin; Akamai caches the full (tenant, path) HTML with long TTL + stale-if-error + SWR. Dynamic bits (cart, live price/inventory) layered client-side or via EdgeWorker fragment injection.

- **Pros:** best TTFB on hit (~20–50ms, beats Shopify origin cache); strongest SPOF (edge serves stale on origin death); lowest origin cost; SEO trivially in HTML.
- **Cons:** must cleanly split cacheable shell vs per-user/dynamic; price/inventory freshness needs care; invalidation discipline.

## Approach 2 — Render at the edge (Akamai EdgeWorkers + EdgeKV)

Move the layout engine into EdgeWorkers; origin only serves config + commerce APIs. Render near the user (Oxygen-like).

- **Pros:** low TTFB even on cache miss; native personalization; minimal origin.
- **Cons:** EdgeWorkers limits (CPU/time/code-size, EdgeKV eventual consistency) make running a full template engine + multi-call commerce fetch at the edge risky for complex pages; heavier Akamai lock-in; harder debugging/ops. Risk to "build once, hold up."

## Approach 3 — Hybrid (RECOMMENDED)

- **Cacheable pages (home/PLP/PDP/collections ≈ 90% of traffic):** full-page edge cache (Approach 1) — long TTL, stale-if-error, SWR.
- **Dynamic/auth pages (cart, account, checkout):** origin SSR, multi-region, not edge-cached (or micro-cached).
- **EdgeWorkers scoped to what they're good at:** tenant routing (domain→merchant), A/B + light personalization fragments, and **stale-fallback when origin is down** — NOT full page render.
- **Dynamic-in-static:** price/inventory/cart rendered as placeholders hydrated via a tiny edge/client call, so the cacheable HTML stays shareable across users.
- **Pros:** max cache-hit for the cacheable majority (beats Shopify TTFB), correct handling of dynamic, EdgeWorkers used within their limits, strongest realistic SPOF story, perf-per-dollar friendly.
- **Cons:** two render paths to maintain; needs a clear cacheable-vs-dynamic classification per page/widget.

## Recommendation

**Approach 3 (Hybrid).** Within AWS+Akamai it's the only way to _beat_ Shopify: cache everything cacheable at the edge for TTFB, scope edge compute to routing/personalization/resilience, SSR at multi-region origin only where truly dynamic. It also gives the cleanest answer to "Layer 1 down = everything down": when the shell/origin dies, Akamai keeps serving last-good HTML for all cacheable pages, so storefronts stay up (degraded: stale prices, cart maybe down) instead of hard-down.

## Cross-cutting decisions this spine forces (to settle during deep-design)

- **Shell runtime (B):** Next.js (ISR/SEO built-in, heavier) vs Hono/custom (lean, but reimplement caching/SEO). Leaning: a lean origin renderer + Akamai as the cache authority (don't depend on Next ISR).
- **Cacheable vs dynamic contract:** which widgets/pages are edge-cacheable vs require origin/edge personalization.
- **Cache key + purge model:** tenant + path + variant; tag-based Fast Purge granularity.
- **Multi-region topology:** how many AWS regions, active-active, data locality for Postgres + commerce.
- **Degradation tiers:** exactly what "works" when origin down / backend down / Akamai issue.
