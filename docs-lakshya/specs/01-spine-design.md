# Spec — Spine (A+B+F): Request Path · Multi-Tenancy · Layer-1 Resilience

> GoKwik Commerce OS. Architecture = Hybrid (D18), AWS EKS + Akamai (D15), beat Shopify perf+SEO (D13), 100→5000 merchants + spiky traffic, no Layer-1 SPOF. Sections approved one at a time.

---

## Section 1 — Request lifecycle + cacheability contract ✅ (approved 2026-06-25, pending final lock)

### 1.1 Page classes

- **Class A — cacheable/shared** (home, PLP, collection, PDP, CMS/policy ≈ 90% of traffic): full HTML edge-cached per `{merchant, path, variant}`. SEO content baked (titles, images, JSON-LD, stable price).
- **Class B — dynamic/per-user** (cart, checkout, account, order status): origin SSR, `private, no-store`, never shared-cached.

### 1.2 Cacheability is DECLARED, per widget/field (the key mechanism)

Every widget (and data field) declares a cacheability tier in its registry schema, so the layout engine knows what to bake vs defer:

- **`static`** — same for everyone, changes only on publish → baked into HTML, purged on publish.
- **`shared-volatile`** — same for all users but changes outside publish (standard price, inventory) → baked, short TTL + event purge (price/stock change → Fast Purge tag).
- **`per-user`** — varies by user (cart count, wishlist, personalized price) → NOT baked; rendered as a placeholder, hydrated by a small client/edge call.
- **`per-segment`** — varies by customer segment (future) → cache **variant** keyed by segment, OR EdgeWorker fragment injection.

### 1.3 Price & personalization policy (from user 2026-06-25)

- **Price default = `shared-volatile`** → baked into cached HTML (most merchants, all-users-same price). Purge on price change. Max perf + SEO.
- **Personalized-pricing merchants/segments = `per-user`/`per-segment`** → price flips to a hydrated placeholder via a per-merchant capability flag. Layout engine reads the flag; only those merchants pay the dynamic cost.
- **Segmentation (coming):** the cache key reserves a `segment` dimension NOW (single default variant today). When segmentation ships: bounded segment-variant caching (cap the number of segments to avoid cache explosion) or EdgeWorker fragment injection for segment-specific blocks. Designed-in, not retrofitted.

### 1.4 Request flow

```
Browser → Akamai edge (merchant custom domain, CNAME→Akamai)
  └ EdgeWorker: resolve tenant (domain→merchant_id via EdgeKV)
                classify route (A|B); build cache key {merchant}:{path}:{segment-variant}
  ├ Class A, edge HIT  → serve cached HTML ~20–50ms (+ optional personalization fragment)
  ├ Class A, edge MISS → GSLB → nearest healthy EKS region → origin renders
  │                       (config=Layer2 + commerce=Layer3) → cache TTL+SWR+stale-if-error → serve
  └ Class B            → bypass cache → origin SSR (nearest region) → serve private
Client: hydrate per-user placeholders (cart, live inventory, personalized price) via small API call;
        bind ~2KB action dispatcher
Publish/price/stock change → config or commerce service → Akamai Fast Purge by tag
        {merchant} or {merchant}:{path} → re-render + re-cache on next request
```

### 1.5 Why this beats Shopify here

For the ~90% Class-A traffic on the common (all-users-same-price) case, pages serve as fully static HTML from Akamai edge (~20–50ms TTFB) — at or below Shopify's hosted-CDN delivery, with SEO content fully in HTML. Personalization/segmentation costs are paid only where declared, not globally.

### 1.6 Open / deferred

- Exact Akamai Fast Purge tag granularity → Section 5 (cache/purge model).
- Stale-if-error degradation specifics → Section 3 (resilience).
- Segment-variant cap number → revisit when segmentation (sub-project D/E) is designed.

---

## Section 1 — DETAIL (the 3 local pieces, 2026-06-25)

### 1A. Cacheability schema (field-level, with widget default)

- Cacheability is declared at **field/slot level**, with a **widget-level default of `static`** (perf-safe; you opt INTO dynamic). One widget routinely mixes tiers — e.g. PDP: title/images/description = `static`, price/compare-at = `shared-volatile`, cart/wishlist/personalized-price = `per-user`, segment banner = `per-segment`.
- Registry schema: each `propsSchema`/`dataBindingSchema` field gets a `cacheability: static | shared-volatile | per-user | per-segment` and (where relevant) `purgeTags: [...]` + `ttl`.
- A widget = **a bakeable static shell + N dynamic slots.** Dynamic fields don't force the whole widget dynamic; they become placeholders inside an otherwise-baked widget.
- **Capability flags promote tiers, declared once + tuned per merchant.** Effective tier = `max(declared, flag-promoted)`. Example: merchant flag `personalizedPricing:true` flips the `price` field `shared-volatile → per-user`. Only that merchant pays the dynamic cost; everyone else keeps baked price.
- The resolved tiers drive everything downstream: what's baked, what becomes a placeholder, the page TTL (`min` of field TTLs), the purge-tag set (union), and whether the page is Class A (has a shared shell) or Class B (no shared shell).

### 1B. Hydration mechanism (filling per-user / per-segment placeholders)

**Static-first paint, augment-never-block.** Cached HTML paints instantly with baked content; hydration only adds/överrides. Split by who can cheaply answer:

- **Edge-filled (EdgeWorker, no origin hit, ~0 added latency):** things the edge knows cheaply — **cart count** (signed cookie), **segment** (EdgeKV/cookie), geo, A/B variant. Injected into the cached HTML on the way out → no flash, no CLS.
- **Client-filled (one batched async call AFTER first paint):** things needing auth/freshness — personalized price, live inventory, wishlist, full cart contents. Single `GET /api/storefront-state?skus=…&segment=…` (NOT N calls), patched into placeholders. Target < 150ms, non-blocking.
- **No layout shift:** placeholders reserve space and show a baked fallback (e.g. canonical "from ₹X" or a shimmer) until hydrated.
- **Keep the state call cacheable where possible:** inventory per SKU is `shared-volatile` (10–30s micro-cache, shared across users); personalized price keyed by **segment** (bounded) rather than per-user wherever the business allows → stays cacheable. Truly per-user values are the only un-cacheable part.

### 1C. SEO of deferred content

**Rule: the anonymous/default view is fully baked + fully indexable; personalization is additive on top. Crawlers never see an empty price.**

- **Baked (crawler sees real content):** title, description, images, product copy, **price for non-personalized merchants (the default)**, availability, and **JSON-LD Product/Offer with that baked price**.
- **Personalized-pricing merchants:** baked HTML + JSON-LD show the **canonical/list price** (MSRP/"from"); the user's personalized price hydrates on top. Anonymous crawler = canonical price = correct + indexable.
- **Segment variants:** a crawler is the **default segment** → sees the fully-baked default variant. Set `<link rel="canonical">` to the default URL so segment variants don't cause duplicate-content.
- **Non-SEO dynamic (cart, wishlist, recs):** deferred freely; no ranking cost.

### 1.D Assumptions to validate (Rule #1)

- Merchants with personalized pricing still have a sensible **public/canonical price** to show anonymously (for SEO + first paint). — confirm.
- **Cart count** is derivable from a signed cookie at the edge (no origin call). — standard, confirm.
- Personalized price can usually be keyed by **bounded segment** (not strictly per-individual) so it stays cacheable; truly per-individual pricing falls back to the client call. — confirm the business reality.

---

## Section 2 — Multi-tenancy & routing ⏳ next

## Section 3 — Resilience & degradation tiers (Layer-1 SPOF) ⏳

## Section 4 — Shell runtime decision (Next.js vs lean) ⏳

## Section 5 — Cache/purge model + multi-region topology ⏳
