# Caching Contract & POC Plan — 3.0 Architecture (Edge / L1 / L2 / L3)

> 🗄️ **HISTORICAL (2026-07-16).** Entire document superseded — kept for decision-trail only.
> Even §1–2's contract statements no longer hold as written: HTML now also lives in the R2
> release store (D27/D28), invalidation is release-pointer-based (not tag purge), and the
> origin is ECS min-1 (not scale-to-zero Cloud Run). Current sources of truth:
> `specs/02-cache-spine-implementation.md` (v3) · `research/07-risk-spike-register.md` (v2) ·
> `decisions/ADR-013` (v3) · MOM decisions D22–D29.
>
> Status: ~~Draft for review~~ Historical · originally 2026-07-14
> Basis: S0–S8 cross-cutting decisions (Cloudflare Worker edge → Hono origin → Content API → commerce backend) + the handlebars POC render model. Next.js/React is out; every cache it provided must be rebuilt deliberately — this doc says where each one goes.

**Layer map:** **Edge** = Cloudflare Worker + CDN cache + KV · **L1** = Hono render/shell origin (scale-to-zero containers) · **L2** = Content API (PageConfig, theme, tokens, widget registry) · **L3** = commerce backend (products, price, stock, cart).

**Tier vocabulary (S1):** `T0` versioned-forever · `T1` cache + purge-on-change · `T2` volatile-embedded (volatile data baked into HTML, freshness via tag purge) · `T3` no-store.

---

## 1. What gets cached — by layer

### Edge (Cloudflare) — the ONLY place HTML lives

| What                                             | Tier  | Key / freshness                                                                                                  |
| ------------------------------------------------ | ----- | ---------------------------------------------------------------------------------------------------------------- |
| Full HTML: home, PLP, PDP, CMS/policy            | T1/T2 | `{tenant}:{path}:{variant}` + surrogate tags (`tenant:x`, `page:y`, `product:z`); cache-forever, purge-on-change |
| Static assets: dispatcher JS, CSS, fonts, images | T0    | versioned URL, `immutable`, never purged                                                                         |
| Tenant resolution (`host → tenantId`)            | KV    | long TTL, purge on domain change                                                                                 |
| Per-tenant route table                           | KV    | purge on publish                                                                                                 |

### L1 — Hono origin (stateless; caches derivatives, never HTML)

| What                                             | Freshness                                                  |
| ------------------------------------------------ | ---------------------------------------------------------- |
| **Compiled** Handlebars templates                | keyed by registry version; recompile only on registry bump |
| Registry / tokens / route-table (in-process LRU) | version-keyed or short TTL; exists to survive miss-storms  |

Origin does NOT cache rendered HTML. Edge owns it. Origin stays stateless → scale-to-zero + cells stay valid.

### L2 — Content API

| What                                                  | Freshness                                                               |
| ----------------------------------------------------- | ----------------------------------------------------------------------- |
| Published PageConfig / theme / tokens / registry JSON | version-keyed, immutable per publish → edge-cacheable, purge on publish |
| Drafts, preview tokens                                | never cached                                                            |

### L3 — Commerce

| What                                      | Tier                                           |
| ----------------------------------------- | ---------------------------------------------- |
| Price / stock **embedded in page HTML**   | T2 — fresh via `product:z` tag purge on change |
| Product / collection reads at render time | origin micro-cache 5–30s, or purge-on-change   |
| Cart, checkout, account, order status     | T3 — never                                     |

## 2. Never cached (T3)

- Cart contents, account, order status, checkout — `private, no-store`, straight to L3.
- Hydration/state API (cart patch, live stock) — no-store; cart **count** optionally edge-filled from signed cookie (no origin hit).
- Drafts + editor preview — no-store, token-validated per request.
- Any POST/mutation.
- No separate bot rendering — crawlers get the default variant of the same cached HTML (dynamic rendering rejected in S1).

---

## 3. Risk register — what must be checked before ratifying

Ranked. **R1–R4 can kill the architecture; R5–R11 are tuning.**

| #     | Risk                                                      | Question to answer                                                                                                                                                                                                        | Feeds             |
| ----- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| R1 🔥 | **Purge ↔ stale-if-error conflict**                       | Cache-Tag purge is a hard delete → a purged page has nothing stale to serve if origin is down. Does soft-purge exist on our CF tier? If not: last-good copy in KV/R2? **This decides whether "no Layer-1 SPOF" is true.** | ADR-008, S3       |
| R2    | **Purge pipeline end-to-end**                             | Change→fresh p99 latency; tag-cardinality limits (products-per-PLP × tags-per-URL vs CF caps); purge storm during flash sale (100 price updates/min, one tenant)                                                          | ADR-005           |
| R3    | **Miss-storm behavior**                                   | Post-purge thundering herd: scale-to-zero cold-start p99 + origin single-flight (1000 concurrent misses on one page = 1 render, not 1000)                                                                                 | ADR-008, S6       |
| R4    | **T2 embed vs live stock in a sale**                      | Stock flipping OOS mid-sale: purge-per-change (storm) vs stock-only micro-TTL vs client patch. Wrong answer = oversell or dead cache                                                                                      | S1 numbers        |
| R5    | Variant boundedness                                       | Hit ratio at variant-set > 1; hard cap + overflow-to-default behavior                                                                                                                                                     | S1 `variant` set  |
| R6    | Bot detection source                                      | Reliable crawler signal for default-variant; verify no cloaking penalty                                                                                                                                                   | S1 open item      |
| R7    | Tenant resolution + trusted header on **real** Cloudflare | Spoof-proofing (strip inbound header), private-origin 403, KV propagation delay on onboarding                                                                                                                             | S2, ADR-001       |
| R8    | Template compile economics                                | Cold start with full registry: precompile-on-boot vs lazy; measure → min-instances decision                                                                                                                               | S4, S6            |
| R9    | Custom widget templates in shared origin                  | Merchant Handlebars = tenant code in shared process. Sandbox (no prototype access, size caps, helper allowlist) before tenant #2                                                                                          | S7                |
| R10   | Edge cart-count fill                                      | Signed-cookie injection into cached HTML; zero CLS; cookie hygiene                                                                                                                                                        | S1 hydration rule |
| R11   | Cost telemetry                                            | Real hit ratio, purges/day, renders/day → makes S6 quotable (currently vibes)                                                                                                                                             | S6 priority #1    |

---

## 4. POC-1 — "Cache Spine" (the actual test)

One POC covers R1–R4 + R11. Single tenant, real Cloudflare, real purge, kill the origin mid-test.

### Setup

1. **Origin:** Hono app in a scale-to-zero container (Cloud Run). Reuse the handlebars POC render core (`layout-engine`, `template-compiler`, `page-resolver` — already runtime-agnostic; use the orphaned `generatePageHead()` for `<head>`). Existing Nest backend serves as L2+L3.
2. **Edge:** Cloudflare Worker — tenant resolve via KV, cache key `{tenant}:{path}:{variant}`, Workers Cache API for HTML. Non-Enterprise tier: emulate tag purge with a KV tag→URLs index (flag fidelity gap vs Enterprise Cache-Tags in results).
3. **Purge path:** backend publish/price webhook → Worker purge endpoint → tag lookup → delete + optional re-warm.
4. **Origin caches:** compiled templates keyed by registry version; LRU for registry/tokens/routes.
5. **Islands:** state API stub (`GET /api/storefront-state`) + cart-count cookie fill.

### Test matrix

| Test                     | Method                                                                                  | Pass                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **T1 — SPOF kill test**  | Scale origin to 0 + block egress; browse cached pages; then purge one page and retry it | Cached set: 0 shopper errors. Purged page: document behavior → drives R1 answer (soft-purge or KV last-good) |
| **T2 — purge storm**     | Script 100 price updates/min against one tenant for 10 min                              | change→fresh p99 < 5s; hit ratio stays ≥ 90% during storm                                                    |
| **T3 — thundering herd** | Purge hot page, fire 1k concurrent requests                                             | Origin renders exactly 1× (single-flight works); rest wait/serve                                             |
| **T4 — cold start**      | Idle to zero, then hit                                                                  | p99 first-byte < 2.5s or decide min-instances=1 (cost call)                                                  |
| **T5 — hit ratio**       | Replay realistic traffic (90/10 Class A/B) for 24h                                      | ≥ 95% edge hit on Class A; edge TTFB ≤ 50ms on hits                                                          |
| **T6 — SEO**             | Fetch as Googlebot UA                                                                   | Default variant, full HTML, real price + JSON-LD present                                                     |
| **T7 — spoof**           | Hit origin directly; send forged tenant header through edge                             | 403 direct; header stripped/overwritten                                                                      |
| **T8 — telemetry**       | Count renders/day, purges/day, hit%                                                     | Numbers land in S6 cost model                                                                                |

### Sequence

- **Week 1:** build spine (steps 1–5). Origin port is small — render core is ~5 files of plain TS.
- **Week 2:** run matrix, write `research/07-cache-spine-results.md`, take R1 decision (soft-purge vs last-good fallback).
- **Then:** ratify S1 numeric tier values + S3 SLOs with measured data; unblock ADR-005/008 from Proposal → Accepted; feed telemetry to S6.

### Explicitly out of scope for POC-1

Multi-region, segmentation/variants beyond a stub (R5 gets a follow-up), checkout, editor, migration. One tenant is enough to answer R1–R4; add tenant #2 only for R9 sandbox testing.
