# Critical Review — R3 Confluence Docs (Architecture / Request-lifecycle / CF-vs-Akamai / S0–S8)

> 2026-07-21 · Reviewed against the ratio-3.0 code + the POC + 3 adversarial-review rounds.
> Verdict: the **skeleton is sound** (multi-tenant shared host, edge-cache + private origin,
> version-addressed content, islands) — we proved it. But the docs, as a "single source of truth",
> have **platform mismatch, an incoherent invalidation model, resilience claims that outrun the
> primitives, and a cost model computed for the wrong platform.** Ranked below.

## A. Architecture-level (serious — fix before anyone builds off these)

**A1 — The "single source of truth" documents the wrong platform.**
S0–S8 states S0 = "Cloudflare Workers at the edge → DECIDED (ADR-012)." The entire Request-lifecycle
doc is Cloudflare-specific (Workers KV, `caches.default`, CF edge cache). Yet the CF-vs-Akamai doc
says **Akamai is the committed platform and ADR-012 is NOT flipped yet.** So the SSOT contradicts
the gap doc, and the step-by-step lifecycle describes a platform we're not shipping on. A reader
takes the lifecycle doc as truth and builds Cloudflare mechanics that don't exist on Akamai
(no `caches.default`, no Workers KV API, EdgeWorkers ≠ Workers). **The lifecycle + S0 must be
rewritten Akamai-first, or explicitly stamped "POC platform — see gap doc for target."**

**A2 — The invalidation model is THREE incompatible stories in one SSOT.**

- S1 says: "cache forever by version, clear exact keys, **T0 versioned**" → a _version-pointer_ model.
- Request-lifecycle + Architecture say: `s-maxage` + `stale-while-revalidate` + **Cache-Tags purge** → a _TTL + tag-purge_ model.
- The data model calls `routes.version` a "content pointer" — but in code it's the **per-route
  optimistic-lock counter (OFCE-409)**, not a release/version pointer at all.
  These are not the same mechanism and the docs never reconcile them. Is freshness driven by a
  version pointer, a TTL, or tag purge? Our POC had to _invent_ the release-pointer + two-phase
  publish to make this coherent — the docs still carry all three, unreconciled. **This is the single
  biggest correctness ambiguity.** (See our spec 02 v3.1 for the reconciled model.)

**A3 — Resilience claims outrun the primitive (the R1 conflict, undocumented).**
S3 says T1 "origin down → cached page served (stale-if-error)" is **shipped (OFCE-452/453)**. But:
(1) Cloudflare Cache API does **not** support `stale-while-revalidate`/`stale-if-error` — verified;
(2) their own invalidation is a **Cache-Tag hard purge**, which _deletes_ the object, so there is
nothing left to serve stale after a purge. The docs assert a resilience property the described
mechanism can't deliver, and mark it "shipped." Either the mechanism is something else (undocumented)
or "shipped" is overstated.

**A4 — "Serve last-good" has a cold-PoP hole the docs never address.**
Resilience = "serve last-good from the **per-PoP** Cache API." Per-PoP means a PoP that never served
the page has **nothing** to fall back to when the origin is down. There is no durable, global
last-good store in any of the 4 docs. For a real outage this is exactly the gap our D35 (S3/R2
availability store) fills — the docs present "serve last-good" as complete when it only covers
already-warm pages in the local PoP. On Akamai (no R2) this is worse and unaddressed.

**A5 — Price-in-HTML has no freshness mechanism.**
S1: "**price and stock are rendered straight into the HTML**" (T2). Also S1: "cache forever by
version, clear exact keys." A price change is **not** a publish/version bump — so what invalidates
the baked price in the cached HTML, and within what SLO? The docs present price-in-HTML as settled
but the invalidation path for volatile commerce data is missing (it's our deferred A6/C6, but the
docs don't flag it as open — they imply it's solved).

**A6 — Cache key = host only (no tenant/version) is fragile, and the docs admit it.**
Request-lifecycle: "tenant isolation is **by host, not an explicit tenantId**" + OFCE-480 flags
`?store=` override poisoning + query-string fragmentation. So the cache key correctness is a _known
open hole_ — yet S1 says multi-tenancy is "**proven by POC**." One host→tenant mapping bug = a
cross-tenant cache serve (worst incident class). Our POC deliberately keyed on `{tenant}:{release}
:{path}:{canonical-query}` to close this. The docs' host-only key is weaker and self-flagged as
not-production-ready — "proven" overstates it.

## B. Cost & decisions (the lens is unsettled, and the model is for the wrong platform)

**B1 — The decision lens itself is admittedly unresolved, yet everything hangs off it.**
S0–S8: "cost first, then performance, then AI ... **(Under review — see gate page C2)**." The PRIMARY
decision criterion is flagged under review — but every S-section resolves ties with it. Also it
contradicts the earlier mandate ("beat Shopify perf, no compromises"). **Is this a perf-led or
cost-led product?** Unreconciled, and it changes real choices (edge spend, render budget, min-instances).

**B2 — S6 cost model is computed for Cloudflare, not Akamai.**
S6's whole model — "reads are egress-free," "Enterprise floor forced by Cache-Tags + custom
hostnames," "$80/store, crosses at 25–65 stores" — is Cloudflare economics. On Akamai (committed
contract, native Fast Purge, no separate Enterprise floor, different egress) the structure is
different — the gap doc says so. So the "priority #1" cost model in the SSOT is for a platform
we're not using. It needs a full Akamai redo; presenting the CF numbers as _the_ cost model is
misleading.

**B3 — "scale-to-zero" (S0/S4) vs ECS-Express-min-1 reality + the S6 render assumption.**
S0/S4 lean on "Hono origin on **scale-to-zero** containers" for cost. The deployed reality is ECS
Express, which is **min-1** (not scale-to-zero). S6 assumes "only 1–5% of views render" → cost ≈
fixed ÷ N. If origin is always-on min-1 per cell, there's a fixed compute floor the per-store math
underplays. Reconcile: is it truly scale-to-zero (then which runtime?) or min-1 (then fix the S6 floor)?

## C. Underspecified / ambiguous (must resolve, lower blast radius)

- **C1 — AI assistant blast radius.** "Real and audited" actions include publish-class operations.
  A publish is **O(routes) renders** (our D28) — an AI loop or a bad prompt could hammer the
  expensive materialize path. No mention of: preview/approval before publish, publish rate-limits
  for agent tokens, or a spend cap. Underspecified + potentially expensive.
- **C2 — Migration (S8) is one sentence for a top-3 project goal.** "strangler-fig, one store at a
  time, reversible edge switch, visual-parity check." The 8 live stores are on the Shopify-coupled
  stack. HOW does Shopify data land in tenant-keyed Postgres? What _is_ the visual-parity check
  (mechanism, threshold)? This is goal #4 of the whole effort and it's hand-waved.
- **C3 — Terminology assumes ~13 ADRs a reader doesn't have.** "Layer 1", "cells", "T0–T3", "variant
  set", "D-MT1/D-HR3/D-R6" appear undefined in these 4 pages. The SSOT is unreadable without the
  ADR set — and several referenced values ("exact tier numbers", "variant values", "bot detection
  source", "SLO/RTO/RPO numbers") are explicitly still _open_. So the "contract" is a frame with the
  load-bearing numbers still blank.
- **C4 — "Proven / shipped / decided" is used loosely.** S1 "proven by POC" while OFCE-480 cache-key
  holes are open; S3 "shipped" while the stale mechanism is questionable (A3); ADR-012 "DECIDED" in
  S0 while the gap doc says it's not flipped. The status vocabulary doesn't survive cross-checking.
- **C5 — Custom-domain automation (CF-for-SaaS / CPS) called both "decided" and "biggest build /
  paused."** S2 says the domain model is "decided (both)"; the gap doc calls per-merchant
  domain automation the "**biggest build**" (OFCE-477) and elsewhere it's "on hold." Which is it?

## D. What's actually solid (so this isn't all red ink)

- Multi-tenant shared host + `tenant_id`-keyed rows + the **one-gate tenant-scoped repository** —
  genuinely good, and we verified the isolation in code.
- **Private origin** (fail-closed `x-edge-auth`, constant-time compare, `x-*` strip) — solid, real.
- The **resilience _direction_** (KV-first resolve, negative-cache, circuit breaker, branded 503,
  order-of-preference) is right — it's the _mechanism honesty_ (A3/A4) that's missing.
- The **data model / ERD** is clean and matches the code.
- ~70% edge-agnostic claim (gap doc) is correct — and matches how we built the POC behind interfaces.

## E. What to do (ranked)

1. **Pick the platform in the SSOT and rewrite S0 + request-lifecycle Akamai-first** (or clearly
   mark them POC-only). Nothing else should be "decided" on top of an unflipped ADR-012. Run the
   marginal-cost check (OFCE-478) to actually flip it.
2. **Reconcile the invalidation model to ONE mechanism** (our spec 02 v3.1: release-pointer +
   two-phase publish + Fast-Purge tags as the Akamai-native accelerator). Kill the three-stories problem.
3. **Add the durable global last-good store** (A4/D35) to the resilience section, and correct the
   stale-if-error mechanism claim (A3).
4. **Define the volatile-data (price/stock) freshness path** (A5) or explicitly mark it deferred.
5. **Redo S6 for Akamai** + reconcile scale-to-zero vs min-1 (B2/B3), and **settle the decision lens** (B1).
6. Fill the blanks that are load-bearing: tier numbers, variant set, SLO/RTO/RPO, AI publish limits,
   migration mechanism. Tighten "proven/shipped/decided" to survive cross-check.

**Bottom line:** the architecture's bones are right and we've proven the risky parts — but this doc
set can't be the build contract as-is. It's written to the POC platform, its freshness/invalidation
story is three contradictory halves, its resilience claims exceed the primitives, and its
cost model is for a vendor we're not using. Reconcile against `specs/02` v3.1 + `research/07`/`08`
(which already solved several of these) before treating any of it as settled.
