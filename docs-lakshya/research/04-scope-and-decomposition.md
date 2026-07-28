# Scope & Decomposition — GoKwik Commerce OS

> 2026-06-25. With D14 (GoKwik-native commerce), this is a full commerce platform. Per brainstorming, decompose into sub-projects, define relationships + build order, then deep-design ONE at a time. Constraints: AWS EKS + Akamai only (D15), greenfield target + migration (D16), beat Shopify on perf+SEO (D13), scale 100→5000 merchants + spiky traffic, no Layer-1 SPOF, app ecosystem later (D12).

## The platform, decomposed

```
                    ┌─────────────────────────────────────────────┐
                    │  A. EDGE SERVING & CACHING (Akamai)          │
                    │  static HTML cache · EdgeWorkers routing/    │
                    │  personalization · EdgeKV · stale-if-error   │ ← kills Layer-1 SPOF
                    └───────────────┬─────────────────────────────┘
                                    │ (cache miss / revalidate)
                    ┌───────────────▼─────────────────────────────┐
                    │  B. LAYER 1 — RENDER SHELL (multi-region EKS)│
                    │  routing→config · layout engine · widget     │
                    │  loader · SEO head · action dispatcher        │
                    │  runtime: Next.js vs Hono (DECIDE)            │
                    └───────┬───────────────────────┬──────────────┘
                            │                        │
        ┌───────────────────▼────────┐   ┌──────────▼───────────────────────┐
        │ C. LAYER 2 — CONFIG/THEME  │   │ D. LAYER 3 — COMMERCE (GoKwik)    │
        │ multi-tenant Postgres ·    │   │ catalog/PIM · cart · orders ·     │
        │ widget registry · draft/   │   │ inventory · pricing/discounts ·   │
        │ publish/versioning ·       │   │ checkout + payments + RTO +       │
        │ templating: HBS/Liquid     │   │ KwikPass (compose existing?)      │
        └────────────────────────────┘   └───────────────────────────────────┘

  E. EDITOR + AI (editor app · brand layer · AI-native features)
  F. CONTROL PLANE / MULTI-TENANCY (provisioning · domains+SSL · tenant isolation · config rollout)
  G. EXTENSION/APP PLATFORM (seams defined now, built later: widget API · data-adapter API · checkout extension points)
  H. CROSS-CUTTING: observability (SigNoz) · resilience/SPOF · CI-CD · security/tenant-isolation
```

## Sub-projects (each gets its own spec → plan → build)

| ID    | Sub-project                                               | Core question it answers                                                                                         | Depends on         |
| ----- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------ |
| **A** | Edge serving & caching                                    | How does Akamai serve static HTML globally + survive origin death (the Layer-1 SPOF answer) + beat Shopify TTFB? | — (topology spine) |
| **B** | Render shell (Layer 1)                                    | Runtime (Next.js vs Hono), multi-region, stateless render, <400ms                                                | A                  |
| **C** | Config/theme/widget service (Layer 2)                     | Multi-tenant config store, versioning, templating (HBS/Liquid), registry                                         | —                  |
| **D** | Commerce backend (Layer 3, GoKwik-native)                 | Catalog/cart/orders/inventory/pricing; reuse vs build; checkout/payments/RTO/KwikPass composition                | —                  |
| **E** | Editor + AI                                               | Editor app, brand layer, AI-native features, preview bridge                                                      | B, C               |
| **F** | Control plane / multi-tenancy                             | Merchant provisioning, domain+SSL automation, tenant isolation, routing, config rollout                          | A, B, C, D         |
| **G** | Extension/app platform                                    | The seams (APIs/extension points) reserved now so apps fit later                                                 | B, C, D            |
| **H** | Cross-cutting: resilience, observability, CI/CD, security | SPOF elimination everywhere, tenant security, deploy safety                                                      | all                |

## Recommended build/design order

1. **A + B + F-spine first — the request/tenancy/resilience skeleton.** How a request flows edge→shell→config/commerce, multi-tenant, with no Layer-1 SPOF, hitting perf. Everything hangs on this. Directly targets the user's top 3 priorities (scale, SPOF, beat-Shopify perf). ← **deep-design this first**
2. **C — config/theme/widget service** (Layer 2 contract the shell reads).
3. **D — commerce backend** (the biggest unknown given D14; needs the reuse-vs-build clarification).
4. **E — editor + AI.**
5. **G — extension seams** (validated against B/C/D before locking).
6. **H — woven through all of the above, formalized at the end.**

## Open clarification needed before designing D (and sizing the whole thing)

**What GoKwik commerce services already exist to compose vs build new?**

- GoKwik already operates: payments, checkout (`checkoutscripts`), RTO, KwikPass, possibly cart-service / checkout-addons-service.
- "GoKwik-native commerce" almost certainly = **reuse** payments/checkout/RTO/KwikPass + **build new** catalog/PIM + cart + orders + inventory (today these ride on merchants' Shopify). Must confirm — it sizes the platform and the migration.

## Proposed first deep-design target

**Sub-project A+B+F-spine: "Request path + multi-tenancy + Layer-1 resilience on AWS+Akamai."** Pending user confirmation of decomposition + first target.
