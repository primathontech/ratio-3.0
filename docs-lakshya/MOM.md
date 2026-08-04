# New OS Architecture — Minutes of Meeting (MOM) & Decision Log

> Running log of everything requested, discussed, decided, and **why**. Newest entries at top of each session.
> Maintained by Claude. Source of truth for "what did we agree and why".

---

## Session 2026-07-22 (review round) — Tracks 3–5 external review: 10 findings, ALL confirmed + fixed

### Verdict received (user-supplied): "sound direction, strong local proof, NOT production-complete"

All 5 blockers + 5 high-priority findings verified against code and confirmed real. Fixed in commit `6390eb1` (297 tests: 295 pass + 2 live-skips; typecheck+lint clean). Correction to the previous entry: tracks 3–5 prove the in-memory model; the Akamai deployment story stays open until Phase-0 provisioning + live tier.

**Blockers fixed:**

1. **EdgeKV keys were invalid** — item IDs allow only `[0-9a-zA-Z_-]`; `host%3A...` had `%`. Fix: shared base64url encoding (`edgekv-key.ts`, pure JS) used by BOTH the admin driver and the worker — one encoding, can't diverge.
2. **Worker broke the private-origin contract** — sent `x-tenant`, origin needs `x-edge-auth`+`x-ratio-tenant`; reserved paths became bodyless GETs. Fix: full contract headers, faithful method/body/cookie proxy on reserved paths.
3. **Cold-PoP S3 path fetched the dead origin** (`/api/last-good` on the origin that just failed). Fix: worker fetches S3 DIRECTLY (crypto.subtle SigV4); PageOrigin now actually writes last-good.
4. **Last-good write race** — delayed old write could regress content / resurrect over a 404 tombstone. Fix: `LastGoodStore` with monotonic generations (= page DB revision, bumped on save AND delete) + per-key in-process serialization; stale generations dropped. Honest residual: multi-instance read→put window remains (S3 has no CAS); real fix at scale = single per-tenant writer, ticketed not built.
5. **C2 gate trusted the author's tier declaration** — `user` claimable as 'static'. Fix: `BINDING_CATALOG` (platform-owned name→tier truth); author tiers IGNORED; unknown names = saved-doc config, forced static.

**High-priority fixed:** (6) cache tags now fixed-length hashed path (≤128 chars, safe charset — an unpurgeable tag under year-long TTL = stale forever); (7) durable purge OUTBOX — intent enqueued before purge, `drainPurges()` retries, `remove()` crash-safe (intent before row deletion); (8) richText sanitized AT SAVE via theme `safeRichText` (html-flagged catalog bindings); (9) filter allowlist now binds trusted widgets too + registry records deep-frozen; (10) S3 driver RFC3986 path encoding (SigV4-strict) + ListObjectsV2 continuation pagination.

| #   | Decision                                                                                         | Why                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| D44 | **S3 last-good write-behind is owned by the ORIGIN, generation-ordered; the edge only reads S3** | Akamai EdgeWorkers has no waitUntil; and unordered fire-and-forget writes were provably unsafe (blocker #4)                    |
| D45 | **Binding tiers come from a platform-owned catalog; author declarations are ignored**            | The C2 gate must be mechanical against hostile authors, not a convention over registration input                               |
| D46 | **Purges go through a durable outbox** (intent before attempt, retry to done)                    | Under an effectively-infinite shell TTL, one lost purge = permanent stale; same outbox discipline as the POC-1 publisher (H-3) |

### Still open before "production-complete" (honest list)

- [ ] Akamai Phase-0 provisioning → live tier + EW-1..4 (unchanged — THE gate)
- [ ] Multi-instance last-good writer (single per-tenant consumer) — D44 residual
- [ ] Wire PageOrigin + islands + purge-outbox drainer into apps/origin (Hono)
- [ ] EdgeWorker main.ts is a typechecked port target, not a deployed/tested artifact

---

## Session 2026-07-22 (later) — Tracks 3, 4, 5 BUILT (edge port · page builder · widgets/islands)

### Track 3 — Edge Port — DONE (commit `41671d6`)

`packages/edge-port/`: **lazy-edge.ts** = the D38 algorithm (render-on-first-visit, purge-invalidate marks STALE not gone, serve-stale-on-error, async S3 last-good write-behind, real-404-tombstones-last-good; keeps P8 gate + P9 canonical key + D29 fail-closed KV resolve; drops release pointer/route index/materialization) · **akamai-cache.ts** FakeAkamaiCache models invalidate-mode + bounded stale window + tag purge · **tags.ts** tag scheme `t.{tenant}` / `p.{tenant}.{path}` · **drivers/**: EdgeGrid EG1-HMAC-SHA256 signing (no SDK), Fast Purge CCU v3 (non-201 = loud error), EdgeKV admin REST (KVLike), S3 SigV4 (R2Like; signing verified against the AWS-published test vector) · **edgeworker/main.ts** responseProvider port target — worst case 2 sub-requests + 1 EdgeKV read (inside EW-1 budget). Caveat found: **Akamai has no waitUntil → the ORIGIN owns S3 write-behind**, not the worker. Live driver tests self-skip (still gated on Phase-0 provisioning, specs/03).

### Track 5 — Widget registry + islands — DONE (commit `22920fd`)

`packages/widget-registry/`: registry = THE mechanical enforcement point (REQ-1/3): tier always INFERRED, rejects undeclared reads / includes / non-allowlisted filters / per-user shell widgets (per-user = island only, the hard gate). Versions immutable (append-only). Untrusted renders only via worker isolate (D40). Islands: escaped placeholder, CSP-'self' vanilla runtime (no external origins/eval), `/api/island/*` endpoints always no-store+private, island crash = empty slot never page error. C2 byte-identity proven in test (shell identical across users).

### Track 4 — Page Builder — DONE (commit `952bb19`)

`packages/page-builder/`: PageDoc = ordered widget instances; save-time validation (second gate): unknown widget / undeclared data keys / reserved paths / dup ids rejected, path canonicalized with THE SAME fn as the edge key (P9). Save pins widget versions. PageBuilder: durable save → Fast Purge tag invalidate; **purge failure throws PurgeFailed loudly** (content saved, editor retries purge — silent stale under year-long TTL = forever). composePage: islands contribute placeholder only, shell tier = max over shell widgets (provably < per-user). PageOrigin closes the loop: e2e proves publish = 0 renders (50 pages), edit live on next visit, deleted page 404s + caches.

| #   | Decision                                                                       | Why                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D41 | A real origin 404 tombstones the S3 last-good even when non-cacheable          | Deleted page must not resurrect from S3 during an outage (D28's tombstone lesson, lazy form)                                                                     |
| D42 | Filter allowlist enforced at REGISTRATION, not render                          | Found during build: LiquidJS strictFilters only errors when the filter EVALUATES — a banned filter behind `{% if %}` passes a smoke render and detonates in prod |
| D43 | Pages pin widget versions at save; registry versions are append-only immutable | A widget update must not silently change already-published pages; they change on their own edit→purge cycle                                                      |

### State

**285 tests: 282 pass + 2 live-skips** (S3/FastPurge, need creds) + 1 pre-existing flake (`pg-idempotency` concurrency test — fails only under full-suite load, passes 3/3 isolated; worth a ticket). Typecheck + lint clean.

### Next steps

- [ ] Wire PageOrigin + `/api/island/*` + `/assets/islands.js` into the Hono origin app (apps/origin)
- [ ] Editor UI over PageBuilder (REQ-1 merchant code editing sits on the registry gates)
- [ ] Akamai Phase-0 provisioning → run live tier + EW-1..4 (specs/03) — still THE gate
- [ ] Ticket the pg-idempotency test flake
- [ ] Per-segment key dimension (REQ-2 personalization) — seams exist (dims.segment)

---

## Session 2026-07-22 — Rendering model clarified (lazy+purge) + Hono re-confirmed + start Track 2

### Hono

Keep at the ORIGIN. Its original justification (edge portability CF Worker↔Node) is VOID under Akamai (EdgeWorkers don't run Hono), but on standalone merits (fast, Web-standard, TS, already built+tested on 185 tests) it stays. ADR should re-note the rationale.

### Rendering model (user-clarified) — supersedes/simplifies D28

User's pipeline: Hono shell renders skeleton+widgets → page cached AFTER first visit (LAZY, render-on-request) → volatile bits (stock/price) dynamic inside, rest cached → edit = save DB → purge page cache → re-render on next visit.

| #   | Decision                                                                                                                                                                                                                        | Why                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D38 | **Rendering = lazy render-on-first-visit + purge-on-change** (NOT pre-materialize-all-routes). Retires the D28 two-phase publisher for the common case. Keep async-write-to-S3-last-good on first render as the outage backstop | Simpler; and Akamai makes it SAFE where CF couldn't: Fast Purge **invalidate mode** (mark stale, serve-until-revalidated, not delete) + Property Manager **serve-stale-on-error** dissolves the A3 "nothing to serve stale" hole that was CF-specific |
| D39 | Accepted tradeoffs of lazy vs pre-materialize: (1) never-visited page + total origin outage = no fallback (zero-traffic pages, fine); (2) theme-wide edit has a brief mixed-render window (single-page edits clean)             | India-only + real traffic distribution makes both acceptable; pre-materializing 50k low-traffic routes per publish was over-engineering                                                                                                               |
| D40 | Untrusted merchant Liquid renders in a **worker_threads isolate** with per-render CPU/mem/time limits (inside the Hono origin, not the main event loop)                                                                         | B1: no engine self-bounds compute; one bad template must not starve reserved-path serving                                                                                                                                                             |

Note: D28/D32 machinery (two-phase publish, materialize-all, tombstones) simplifies in Track 3. canonical-key, fail-closed resolve, islands, cacheability tiers, inference all still apply. Version pointer optional now (purge-by-tag is the mechanism per user).

### Track 2 — Liquid + Inference — DONE (commit `9d92b4a`, 240/240 pass)

`packages/liquid-render/`: engine (sandboxed LiquidJS — render/memory/parse limits, strictFilters + curated filter→tier allowlist, no-fs partials, compile cache) · worker.mjs + isolate (untrusted render in worker_threads with hard wall-clock kill; self-contained .mjs so it loads under tsx dev + prod node) · infer (analyzeSync globals-diff rejects undeclared reads, bans render/include from auto-cacheable tier, filters→tiers, effective tier = max) · widgets (first-party hero/productGrid/product/richText in Liquid, declared bindings+tiers, price=shared-volatile, add-to-cart=island). 15 tests: render+escape, sandbox (no JS escape / unlisted filter / memory bomb), isolate (returns / fails-clean / hard-kills hang), inference (tiers + reject undeclared + reject includes + all first-party valid).

Note (dev tooling): tsx v4 won't transform a .ts worker_threads entry → worker is plain .mjs (self-contained, builds engine from passed limits+allowlist). Prod build emits .mjs/.js — no loader dependency either way.

Next tracks: 3 Edge Port (real EdgeKV/S3/EdgeWorker drivers, reconcile lazy+purge per D38) · 4 Page Builder · 5 Widgets registry/islands.

---

## Session 2026-07-22 — Template engine locked: Liquid (EJS/Handlebars rejected)

### Decision (confirms + hardens D33)

Template engine = **LiquidJS, everywhere** (first-party widgets AND merchant/app custom code). One engine, one contract, one inference path, one security surface.

| Criterion (why)                                         | EJS                                               | Handlebars                                       | Liquid                                                                          |
| ------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------- |
| Sandbox vs untrusted merchant code (REQ-1/3)            | 🔴 templates ARE JS — zero isolation, non-starter | 🟡 needs external isolate; no compute limit (B1) | 🟢 built by Shopify for hostile templates; no JS internals reachable (verified) |
| Static analyzability for cacheability inference (REQ-3) | 🔴 can't analyze arbitrary JS                     | 🟡 helper model hard                             | 🟢 analyzeSync globals/locals (B2 proved)                                       |
| Migration + hiring (goal #4, Shopify stores)            | ❌                                                | ❌                                               | 🟢 it's Shopify's language                                                      |

- **EJS rejected:** `<% %>` = arbitrary JS in a shared origin → a merchant template can require/process/loop-forever/read cross-tenant. Disqualified by REQ-1.
- **Two-engine split rejected:** doubling renderer + security + inference surface not worth first-party dev-ergonomics; author first-party in Liquid too so merchants can read/fork.
- **Caveats (build tasks):** Liquid doesn't self-bound compute (no engine does) → still needs isolate + renderLimit/memoryLimit (B1). Inference must walk includes transitively / ban unresolved includes, allowlist filters→tiers (B2). Current handlebars POC widgets must port to Liquid (bounded).

---

## Session 2026-07-21 — Critical review of the R3 Confluence docs

### Done

- Read the 4 R3 space PDFs (Architecture/DataModel, Request-lifecycle, CF-vs-Akamai gap, S0–S8 v210726). Reviewed against ratio-3.0 code + POC + adversarial rounds. Wrote `research/10-r3-docs-review.md`.

### Headline: skeleton sound, but docs can't be the build contract as-is

Serious flaws found (full list in research/10):

- **A1 platform mismatch:** SSOT (S0-S8) documents Cloudflare as "DECIDED"; request-lifecycle doc is fully CF-specific; but gap doc says Akamai is the committed platform + ADR-012 NOT flipped. SSOT documents the POC platform, not the target.
- **A2 invalidation = 3 incompatible stories:** version-pointer (S1) vs TTL+SWR+Cache-Tags (lifecycle/arch) vs routes.version-as-"content-pointer" (actually the OFCE-409 optimistic lock). Never reconciled. Our spec 02 v3.1 already solved this.
- **A3 resilience outruns primitive:** "stale-if-error shipped" but Cache API has no SWR/stale-if-error + Cache-Tag purge hard-deletes → nothing to serve stale (the R1 conflict, undocumented, marked "shipped").
- **A4 cold-PoP hole:** "serve last-good" is per-PoP only; no durable global store (our D35). Unaddressed.
- **A5 price-in-HTML has no freshness mechanism** (baked price, but price-change ≠ version bump → what invalidates it?).
- **A6 host-only cache key** self-flagged (OFCE-480: ?store= poisoning, query fragmentation) yet S1 says "proven."
- **B1 decision lens itself "under review"** yet everything decided by it; contradicts "beat Shopify perf."
- **B2 S6 cost model is Cloudflare economics** — wrong platform; needs Akamai redo.
- **B3 scale-to-zero (S0) vs ECS-Express-min-1 reality** — undercuts the S6 per-store floor.
- Plus: AI-assistant publish blast-radius unspecified (publish = O(routes) renders), migration hand-waved (goal #4, one sentence), terminology assumes ~13 ADRs + load-bearing numbers still blank, "proven/shipped/decided" doesn't survive cross-check.

Solid parts: tenant-scoped repo + isolation, private origin, resilience direction, data model, 70%-edge-agnostic claim.

### Recommendation

Reconcile the docs against specs/02 v3.1 + research/07/08 (which already solved A2/A3/A4) before treating any of it as the build contract. Flip ADR-012 via the marginal-cost check first; rewrite S0 + lifecycle Akamai-first.

---

## Session 2026-07-21 — Jira backlog drafted

- Wrote `specs/04-jira-backlog.md`: 13 epics (infra validation, Liquid+inference, edge port, page builder, widgets, commerce lane, personalization, apps, control plane, migration, observability, cost, security) → stories with summary/description/AC/why, project key OFCE, India-scoped. Includes suggested sequencing. NOT yet pushed to live Jira (pending user confirm on project + push).

---

## Session 2026-07-20 — India-only scoping + Akamai runbook + closed the 3 code gaps

### Done

- **India-only scope** (international ≥1yr out): simplifies + strengthens. S3 cold-miss egress risk ~vanishes (all India-local → reinforces D35); DPDP residency satisfied by construction; miss-storm amplification bounded (~4-5 India PoPs not global); EdgeKV propagation well under ≤60s. Multi-region stays deferred (ADR-009). Seams kept so international = add-not-rebuild (region/segment key dim, S3→NetStorage swappable, region/bucket/PoP as config never hardcoded). EW-1 (EdgeWorker fit) unchanged — still the gate.
- Wrote `specs/03-akamai-infra-test-runbook.md` — Phase 0 provision / Phase 1 build+deploy / Phase 2 matrix (EW-1 first) / Phase 3 record. India PoPs for probes.
- **Closed the 3 convention-not-code gaps** (commit `805fe71`, 225/225 pass):
  - H-1: Publisher.publish() OWNS the per-tenant lock (DB seam withTenantLock); P2 proves self-serialization with no external wrapping.
  - H-4: commit pins content durably; materialize(releaseId) reads from DB (resume re-renders what was committed).
  - #7: activate() records status='activating' before the KV flip (durable intent; GC pins; drainer finishes).
  - H-3: drainPending() resumes a crashed publish to completion under the lock (new P2b test: crash→drain→active).

### Decisions taken

| #   | Decision                                                                                                                                    | Why                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| D37 | Scope = **India-only** now, international ≥1yr out; single region ap-south-1 + Akamai India PoPs; build for it but keep seams config-driven | User; cheapest topology, DPDP-aligned, no over-engineering |

### State

Local logic tier: **225/225, all convention gaps now enforced in code.** Only outstanding work = the Akamai+AWS infra tier (P6/P14/P15/P16 + EW-1..4) per specs/03 — blocked on Phase-0 provisioning (Akamai EdgeWorkers/EdgeKV contract + S3 + 2 India probe hosts).

---

## Session 2026-07-16 (round 5) — Infra pivot: Akamai (not Cloudflare)

### Decision

User: edge platform = **Akamai**, not Cloudflare. Decision lens = quality + long-term maintainability + cost efficiency. This re-aligns with the original D15 (AWS+Akamai) that the R3 PDF's S0/ADR-012 had superseded with Cloudflare — so S0/ADR-012 + the CF-based ratio-3.0 edge are now themselves superseded on the edge platform.

### Primitive remap (architecture is transport-agnostic — logic survives, primitives change)

| Role                    | CF (built)      | Akamai                                                | Note                                                             |
| ----------------------- | --------------- | ----------------------------------------------------- | ---------------------------------------------------------------- |
| Edge compute            | Workers         | **EdgeWorkers**                                       | tighter CPU/subrequest budget — algo must fit (new spike)        |
| Edge KV                 | Workers KV      | **EdgeKV**                                            | re-measure consistency/latency for host→tenant + version pointer |
| HTML cache              | Cache API       | Akamai edge cache (property/rules)                    | ok                                                               |
| Invalidation            | version-pointer | **Fast Purge cache-tags (native, standard contract)** | WIN — was the Enterprise-gated S6 cost bomb on CF                |
| Availability store (R2) | R2              | **AWS S3 (D35)**                                      | see decision                                                     |

### Decisions taken

| #   | Decision                                                                                                                        | Why                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D35 | **Availability store = AWS S3, edge-fetched** (NOT NetStorage, NOT tag-only)                                                    | S3 strong read-after-write = activation barrier (D27/D28) survives UNCHANGED = most maintainable (no bespoke replication-verify). Egress small at 90%+ hit. NetStorage's cheap egress doesn't offset a permanent consistency-barrier maintenance tax; tag-only reopens R1 SPOF. Kept behind the `R2Like` interface → NetStorage is a later driver-swap if egress data demands, not a rebuild |
| D36 | Edge platform = Akamai EdgeWorkers + EdgeKV; supersedes S0/ADR-012 (Cloudflare) + the CF-based ratio-3.0 edge on the edge layer | User decision                                                                                                                                                                                                                                                                                                                                                                                |

### New spikes (Akamai-specific — add to register)

- EW-1 (KILL): does the edge algorithm fit EdgeWorkers CPU-ms + subrequest (~4) budget? (KV read + cache lookup + S3 fetch + index/tombstone logic)
- EW-2: EdgeKV consistency + read latency for pointer + host→tenant
- EW-3: Akamai Fast Purge cache-tag latency + semantics (could simplify invalidation)
- EW-4: S3→Akamai cold-miss RTT + egress cost at realistic hit ratio (validates D35 cost assumption)

### Unchanged by the pivot

POC-1 logic (P1–P13, 224/224) — proven behind interfaces, transport-agnostic. r2-first (D32), release protocol (D26/D28), Liquid base (D33). Only the infra-tier tests (P6/P14/P15/P16) retarget Akamai.

---

## Session 2026-07-16 (round 4) — POC-1 BUILT + adversarially verified + remediated

### Done

- Built POC-1 cache spine in `ratio-3.0` branch `poc/cache-spine-v3`: `packages/spine/` (stores, canonical-key, response, publisher, edge, fake-db, harness) + `db/migrations/0009_releases.sql`. Two-phase publisher (commit→materialize+tombstones→verify→activate barrier), fail-closed edge, both E0 read orders, fault-injectable fakes. Commit `8c9adc2`.
- Ran E0 + D28 benches: **r2-first = 0 shopper-path renders** (vs origin-first PoPs×1) → confirms r2-first design. D28 full materialization O(routes); incremental content-addressed manifest is the end-state.
- B1/B2 sandbox spikes (empirical, real Handlebars + LiquidJS): Handlebars not self-sandboxing (no CPU/output ceiling); Liquid limits opt-in; **cacheability inference feasible via LiquidJS `analyzeSync`** (globals=undeclared, locals=in-scope). D8 input: Liquid is the base for merchant code.
- B3 app-isolation spike delivered (`test/spine-b3-isolation.html` + `research/09-b3-app-isolation-spike.md`): cross-origin sandboxed iframe + postMessage bridge; 10/10 attacks held (host DOM/cookie/localStorage reads, top-nav, non-allowlisted capability, spoofed sender, prototype pollution).
- **Ultracode workflow: 5 adversarial reviewers + confirm pass (48 agents, ~2M tokens) → 35 confirmed findings** incl. 3 blockers + several VACUOUS tests. Retracted the premature "local green" claim, then remediated: commit `e7f51de`, **224/224 pass, typecheck+lint clean**.

### Findings remediated (blockers)

- B-1: query/segment/locale dims now reach origin render (were dropped → wrong content per key).
- B-2: origin-first caches only on ok+cacheable (x-cache:long opt-in was missing).
- B-3: deleted routes now get 404 tombstones (prior-release diff); P4 no longer vacuously accepts 503.
- Vacuous tests fixed: P2/P3/P4/P9/P10/P11/P12 + P13 (reconciliation) added.

### Decisions taken

| #   | Decision                                                                                                                                                                                             | Why                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| D32 | **r2-first read path** (Cache API → R2 → origin only if missing) is the design; origin = publish-time compiler, not on shopper path                                                                  | E0: 0 shopper-path renders, kills miss-storm amplification |
| D33 | **LiquidJS is the merchant-template base** (resolves D8); inference via `analyzeSync` globals-diff + filter allowlist + ban unresolved includes; limits are mandatory opt-in + still need an isolate | B1/B2 spikes empirical                                     |
| D34 | Activation barrier + tombstone materialization + real index digest are STATE-MACHINE invariants, not call-order/convention                                                                           | Round-3 adversarial findings; enforced in code + tests     |

### Remaining before prod (honest gaps, tracked in research/08)

- H-1 Publisher must OWN the per-tenant lock via DB seam (currently coordinator convention).
- Finding #7 mid-hostkeys durability: record 'activating' intent before KV flip.
- H-3/H-4 outbox drainer + durable content pinning unbuilt.
- Prod tier P6/P14/P15/P16 need live Cloudflare+AWS (scripts/poc-prod-infra.ts ready, self-skipping).

---

## Session 2026-07-16 (round 3) — Ratification gate adopted → spec v3.1

### Review round 3 (user-supplied): no new bugs — supplies the POC ratification machinery. All adopted.

- **P1–P16 acceptance matrix** adopted verbatim as THE gate for D25–D29 (spec 02 v3.1 §5): publish state-machine crash tests, concurrent publishes, R2 completeness/checksums, resurrection, redirect fidelity, multi-PoP outage, full dependency-failure matrix, gate/key/cache-safety, TTL regression, fail-closed spray incl. malformed KV records, reconciliation, propagation (clock starts at publish/commit — v3 wrongly started at pointer write), multi-PoP miss storm, retention/GC.
- **E0 experiment (register A9):** origin-first vs **R2-first** read path (Cache API → R2 → origin only if missing). R2-first may zero shopper-path renders + most of A3 — converges on the original compiler+artifact-store concept. Cost to measure: cross-region R2 RTT (single-region bucket). Decide by P6/P15 data.
- **Unknown-path rule:** per-release compact route index in R2 → unknown URLs = 404 even in total outage (503-for-unknowns rejected: leaks outage, 5xx to crawlers).
- **A7 (KILL, new):** D28 materialization at real scale — feasibility protocol 50→50k routes × workloads × concurrency; fallback (likely end-state): incremental content-addressed manifest, unchanged pages reuse R2 objects.
- **A8 (new):** release retention/GC — safety window ≥ propagation long-tail (≥24h / last 2 releases); P16 guards.
- **Sample-size discipline:** ≥100 activations for provisional p99; 99.9%≤5min behind explicit soak gate (≥10k observations, multi-day); record max not just percentiles.
- **Evidence rule:** research/08 must contain raw measurements, commit IDs, CF config, cf-ray colos, failure-injection logs — no evidence, no ratification.

### Decisions taken

| #   | Decision                                                                                | Why                                                                                    |
| --- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| D30 | P1–P16 + feasibility protocol + ratification rule = the ONLY gate that ratifies D25–D29 | Review round 3; POC must prove the release state machine under failure, not cache hits |
| D31 | Unknown paths in outage → 404 via per-release route index (Proposed)                    | Consistent behavior, no outage leak, no crawler 5xx                                    |

### Next steps

- [ ] Build POC-1 against spec 02 v3.1; **E0 first**, then P-matrix
- [ ] A7 feasibility runs early (biggest architectural cost); incremental manifest design sketch ready if it fails
- [ ] Soak gate scheduled post-POC for the 99.9% objective

---

## Session 2026-07-16 (round 2) — Review round 2: three v2 blockers fixed → v3

### Verdicts (all confirmed after verification; two were genuine bugs in the v2 sketch)

1. ✅ **Resurrection bug:** v2 fallback checked `previous` release before R2 — Cache API never stores 404s, so a page deleted in release N could resurrect from N-1 during an outage. Also async-tap R2 writes couldn't guarantee coverage. **Fix (D28): two-phase publish** — commit (content+release+outbox in one txn) → materialize EVERY routable response into R2 incl. 404/redirect tombstones, keyed `{tenant}/{release}/{canonical-dims}` → verify complete → only then flip pointer. R2 strongly consistent → activation barrier sound. `previous` demoted to propagation-race use only, NEVER served on outage.
2. ✅ **Fail-closed contradiction:** v2 sketch ran `?? fallbackResolve(host)` on every KV miss — negative-cached `null` re-triggers the exact fallback it guards (nullish-coalescing bug), and unique-hostname spray defeats negative caching by definition. Also missing: method/reserved-path gate before cache.match. **Fix (D29): no public-path DB fallback at all** — pre-seed all legacy domains, write-before-DNS for new; status-tagged KV records `{active|suspended}`/absent; gate GET/HEAD + non-reserved paths before any cache logic.
3. ✅ **SLO wording:** KV docs guarantee "~60s **or more**" — no hard ceiling exists, so "worst case ≤60s" was unbackable. **D25 amended: p99 ≤60s + error budget 99.9% ≤5min + measured operational bound from POC.** Hard-ceiling upgrade path (CDN pointer + single-URL purge) documented, unbuilt.
   Cleanups applied: ADR-013 rewritten wholesale as v3 (no amendment layering over contradictory v1 text) · register A1 → resolved-by-design (was "R2 later", contradicting D27) · research/06 → fully HISTORICAL (its §1–2 also stale: no R2, tag purge, scale-to-zero) · S0–S8 PDF demoted to dated baseline (2026-07-13) — spec 02 v3 + MOM win on conflict · `BIGSERIAL` fixed to global monotonic (per-tenant BIGSERIAL isn't a PG construct); outbox row explicitly same-txn.

### Decisions taken

| #    | Decision                                                                                                                                                                                                                          | Why                                                                                                        |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| D28  | **Two-phase publish with R2 activation barrier** — materialize all routable responses (incl. tombstones) per release, verify, then flip pointer. Publish latency grows with page count (measure; parallelize publisher if needed) | Kills resurrection + coverage gaps by construction; R2 strong consistency makes the barrier sound          |
| D29  | **Fail-closed tenant resolution, absolutely** — no public-path DB fallback; pre-seed + write-before-DNS; status-tagged KV records                                                                                                 | Negative-caching provably can't contain unique-hostname spray; fallback also reopened suspend-repopulation |
| D25′ | Freshness SLO re-stated: **p99 ≤60s, 99.9% ≤5min error budget**, measured bound documented                                                                                                                                        | "Worst case" was stronger than KV's actual guarantee                                                       |

### Artifacts

`specs/02` → v3 · `decisions/ADR-013` → v3 (rewrite) · `research/07` → A1 resolved-by-design, kill-map updated · `research/06` → historical.

### Next steps

- [ ] Reviewer declared arch **ready for POC ratification after these changes** — proceed to POC-1 build (spec 02 v3 §5) + NOW-block spikes (C2, B1, B2, B3)
- [ ] Reconciliation job (KV ↔ domains table diff + alert) — new control-plane duty from D29, ticket it
- [ ] Update shared artifact (still v1 content)

---

## Session 2026-07-16 (later) — External review of spec 02/ADR-013/register: verdicts + v2 rewrites

### Review received (user-supplied). Verdicts after verification

All 9 findings **confirmed** against code + Cloudflare platform behavior; 2 pushbacks/refinements:

1. ✅ KV can't do <5s (cacheTtl min 30s, propagation ~60s; `cacheTtl:0` invalid). _Pushback: review's binary missed option C — pointer as CDN object + single-URL purge (all plans) gives <5s if ever needed. Kept as documented upgrade path only._
2. ✅ v1 sketch passed `s-maxage=300` into cache.put → v_prev died in 5 min. Fixed: sanitized clone @ ~1yr internal TTL; browser headers separate; **R2 last-good promoted to REQUIRED for S3**.
3. ✅ `routes.version` = per-route lock, not a release id; two KV keys = torn reads. Adopted: monotonic tenant `release_id` + immutable manifest + transactional outbox + serialized publisher + single `{tenantId,current,previous}` JSON **folded into host: key** (bonus: 1 KV read/request, halves the #9 cost).
4. ✅ Cache key was incomplete (query/host/locale); `!res.ok` would resurrect deleted pages. Fixed: canonical key fn; stale ONLY on transient (network throw/5xx/429). C2 → NOW block.
5. ✅ DB fallback = spray-able. Fixed: write-before-DNS, fail-closed unknown hosts, negative cache, `status='active'` filter (suspend can't repopulate).
6. ✅ "renders≈1 globally" impossible (Cache API per-colo, single-flight per-process). POC criteria rewritten: measured amplification bound, multi-PoP + cf-ray.
7. ✅ CSP ≠ sandbox. First-party islands = CSP 'self'; third-party app islands = **cross-origin iframe + capability bridge, mandatory** (B3 rewritten). B2 widened to all capabilities (time/random/filters/includes).
8. ✅ Doc drift: D15 superseded-marker added; research/06 §3–4 marked superseded; results file → `research/08-...`.
9. ✅ Cost: with 1-read fold ≈ $50/mo @100M (not $95). **CF-for-SaaS custom hostnames exist below Enterprise** (100 free) — PDF claim outdated; Enterprise pressure was Cache-Tags only, already designed out. S6 improves.
   Corrections: register = 20 entries (not 18); A4 settled (Cache API has no SWR — header deleted); D4 suspend ceiling ~60–90s (not <5s).

### Decisions taken

| #   | Decision                                                                                                                                                               | Why                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| D25 | **Freshness SLO: publish→global-fresh ≤60s worst case** (typical ≪); editor read-your-writes via no-store preview. <5s upgrade path documented, not built              | User ratified after clarification (60s = propagation of edits only; page speed/cart/checkout/editor unaffected). Shopify-parity |
| D26 | **Immutable tenant release protocol** (release_id + manifest + outbox + serialized publisher + single pointer JSON in host key) replaces v1's routes.version piggyback | Review finding #3 — correctness (atomicity, no torn reads, no mixed-release renders)                                            |
| D27 | **R2 last-good layer REQUIRED before S3 is claimed**; Cache API = performance layer only                                                                               | Review findings #2/#6 — per-colo cache + TTL bug means Cache API alone can't carry availability                                 |

### Artifacts updated

`specs/02` → v2 (full rewrite) · `decisions/ADR-013` → v2 amendments · `research/07` → v2 (A2/A3/A4/B2/B3/D4 rewritten, C2→NOW, 20 entries) · `research/06` + D15 → superseded markers.

### Next steps

- [ ] NOW block per register v2: POC-1 (spec 02 v2 §5) + C2 red-team + B1 + B2 + B3
- [ ] Update shared artifact (still shows research/06 v1 content) before circulating further

---

## Session 2026-07-16 — Consolidated risk/spike register

### Done

- Wrote `research/07-risk-spike-register.md` — supersedes R1–R11 (research/06): 18 items across cache spine (A), extensibility runtime (B), personalization (C), platform/scale (D), SEO (E), classed KILL vs ENG, each with spike + rule-out criteria + sequencing.

### New findings surfaced while compiling

- **B3 (KILL):** ratio-3.0 storefront CSP is `script-src 'none'` — directly contradicts islands + app-islands, which the whole design assumes. CSP v2 (self-hosted dispatcher + per-app nonce/allowlist) is a security design task, not config.
- **A2 addendum:** KV pointer propagation creates a read-your-writes problem — merchant publishes, may see stale page ≤60s. Editor confirmation path must bypass (cacheTtl:0 / no-store preview).
- **C2 (KILL):** cache-poisoning class — any per-user byte in a shared-cached response (widget re-render endpoint esp.) = user A sees user B's data. Needs red-team POC + byte-identity test.
- **D1 (KILL):** noisy neighbor unproven — one tenant's flash sale vs shared origin; per-tenant edge rate limit = stopgap until cells.

### Kill-decision map (agreed framing)

B1/B2 fail → REQ-1/REQ-3 change shape · A1/A3 fail → R2 last-good + min-instances · C1/C2 fail → personalization = islands-only · D1 fail → cells move up roadmap.

### Next steps

- [ ] Run NOW-block in parallel: POC-1 (A1–A5, spec 02 §3) · B1 sandbox spike (blocks D8 + REQ-1) · B2 inference POC (blocks REQ-3 shape) · B3 CSP design
- [ ] Then: C1 segments, C2 poisoning red-team, D1 noisy neighbor

---

## Session 2026-07-15 — ratio-3.0 code review + KV decision + cache implementation spec

### Done

- Full code read of **ratio-3.0** (the live S2 slice: CF Worker edge → ECS Hono origin → Neon, `acme.ratiodev.in`): worker.ts, origin, repo gate, edge-sim, prove-s1, INFRASTRUCTURE.md.
- Wrote `decisions/ADR-013-kv-tenant-resolution.md` (Proposed).
- Wrote `specs/02-cache-spine-implementation.md` (Draft) — concrete cache build plan for ratio-3.0 + tech choices C1–C9 + two-tier test plan.

### Key findings (ratio-3.0)

- **Proven + live:** multi-tenancy (merchant=rows), private-origin boundary (spoof-proof, timing-safe, fail-closed), one-command onboarding, ~40 test files. Solid.
- **Gap 1 (critical):** Worker resolves host→tenant via **Postgres query on every request** (incl. cache hits) → DB down = all storefronts down + per-request latency tax. Vendor-neutral topology flaw (user: Neon is temporary — issue is the lookup being on the hot path, not the vendor). → ADR-013.
- **Gap 2:** S1 cache mechanics proven only in local edge-sim; **prod Worker has no cache** — prod = pure 300s TTL (the model S1 rejected). Cache-Tag purge unbuilt (their known-gaps list agrees).
- **Gap 3:** no single-flight, no stale-if-error, 2 tiers only (cacheable/no-store), no variant dimension, theme engine mocked, storefront ships zero JS (no hydration story yet).
- **Free win:** `routes.version` already in schema → versioned cache keys map straight on.

### Decisions taken

| #   | Decision                                                                                                                                | Why                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| D22 | Tenant resolution → Workers KV, DB fallback only (ADR-013, Proposed)                                                                    | Removes DB from hot path: SPOF + TTFB. Cost ≈ $0                                                                                 |
| D23 | Cache invalidation = **KV version-pointer bump** (versioned cache keys), NOT Enterprise Cache-Tags; purge becomes optional optimization | $0, no tier gating (defuses S6 cost bomb), and solves R1: old version stays cached → stale-if-error = serve `v_prev`. Spec 02 §1 |
| D24 | HTML cache primitive = Workers Cache API (not CDN cache/KV); single-flight at origin; tenant-level pointer granularity for now          | Spec 02 §2 (C1–C9) — pending user ratification                                                                                   |

### Discussion — architecture forks + Shopify comparison (2026-07-15, later)

- **Fork: full-page cache vs skeleton+fragment runtime assembly.** Decided **full-page + islands**: storage argument for fragments is void (whole 5000-merchant cache ≈ 7.5GB compressed, Cache API storage free, cache is lazy/LRU); fragments trade free storage for per-request edge CPU + torn-page consistency risk + new hot-path assembler (Layer-1 pattern). Islands cover the only case fragments win (fast-changing slots).
- **Islands defined:** static cached ocean + small dynamic slots (edge-filled: cart count via cookie; client-filled: one batched state call). ratio-3.0 ships zero JS today; handlebars POC's 2KB action-dispatcher = the island runtime.
- **vs Shopify:** they win on render-on-miss speed (SFR data locality), Liquid sandboxing, proven scale, ecosystem. We win structurally on cache-forever economics, interaction latency (baked variant matrix = 0ms switch vs their Section-Rendering fetch), zero-JS floor, cost/view. Variant switching: bake variant matrix into page (default) + edge-cached widget re-render endpoint `{tenant}:{widget}:{variant}:{version}` (fallback — out-caches their per-request section renders).
- **Why Shopify can't copy us:** Liquid can't declare purity (per-user code everywhere), 15yr backwards compat, apps poison cacheability, economics don't force them. They're walking toward this architecture where legacy allows (Dawn, Section API, Hydrogen; killed script-tags + checkout.liquid → gated extensions). We're only "better" because greenfield + closed contract.
- **Extensibility trade named:** we lose UNACCOUNTABLE extensibility (escape-hatch hacks, platform-team-as-bottleneck risk, app-dev friction), keep accounted extensibility. App lanes: A = app widgets under the widget contract (cache-safe) · B = app islands rendering after cached paint (user's suggestion — adopted) · C = backend-only apps. **Hard gate: no request-time arbitrary code in the render path, ever.**

### NEW REQUIREMENTS (user, 2026-07-15) — shape future design

| #     | Requirement                                                                                                         | Implication                                                                                                                                                                                                                                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REQ-1 | Merchants edit code directly in the editor — create custom widgets (Shopify-style freedom)                          | OK **iff** code is template-shaped: sandboxed language + data access ONLY via declared bindings → cacheability computed from bindings, not trusted. **Escalates D8 (Handlebars vs Liquid): Handlebars not sandbox-grade; Liquid designed for hostile templates. Decide before merchant code ships. R9 → core feature**                       |
| REQ-2 | Per-user personalization planned — different widget per user, or different content inside a widget (not whole page) | Fits: segment-keyed widget variants (bounded) + islands/state API for per-individual. Boundary held: unbounded per-individual HTML stays off-menu; per-user = islands only                                                                                                                                                                   |
| REQ-3 | App ecosystem must be cracked; app devs "just make the app and code — WE handle everything"                         | Lane model can't rely on dev declarations → platform must enforce mechanically: sandboxed runtime (CPU/time/size), **automatic cacheability inference from bindings**, per-app metering + kill-switch, compiled-template cache per tenant×widget×version. = new sub-project: **extensibility runtime** (the price of "we handle everything") |

### Next steps

- [ ] Ratify spec 02 choices (C1–C9), esp. C9 (ECS min-1 task vs scale-to-zero)
- [ ] Build sequence day 1–5 (KV resolve → versioned keys → v_prev + single-flight → local proofs)
- [ ] `prove-prod.yml` chaos/load matrix on real infra → `research/07-cache-spine-results.md`
- [ ] Verify: does CF honor `stale-while-revalidate` below Enterprise? (C4 assumption)

---

## Session 2026-07-14 — Caching contract (Edge/L1/L2/L3) + POC-1 plan

### Done

- Code-read of the handlebars POC render path (`new-builder-handlebars/storefront`): all caching = Next.js internals (fetch data cache 30s/60s/1h, full-route ISR, `revalidatePath` webhook). Confirmed the Hono swap removes ALL of it — must be rebuilt deliberately.
- Wrote `research/06-caching-contract-and-poc-plan.md` — cache matrix by layer, ranked risk register (R1–R11), POC-1 "Cache Spine" test plan. Shareable artifact published (same content).

### Key findings

- Render core (`layout-engine`, `template-compiler`, `page-resolver`) is runtime-agnostic plain TS → Hono port cheap; caching is the only hard part.
- **R1 (critical, new):** Cache-Tag purge = hard delete → purged page has nothing stale to serve if origin down. Conflicts with S3 "stale-if-error everywhere". Needs soft-purge or KV/R2 last-good fallback. Decides whether "no Layer-1 SPOF" holds.
- No Hono/s2-poc code found on this machine (PDF claims `~/Desktop/os/s2-poc`) — analysis based on Next POC code + S0–S8 PDF.

### Decisions taken

| #   | Decision                                                                                                                         | Why                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| D20 | Next.js/React layer dropped; Hono origin per S0/ADR-012                                                                          | User confirmed                      |
| D21 | Caching contract per research/06 (HTML only at edge, origin caches derivatives only, T3 list locked) — pending user ratification | Derived from S1 + POC code analysis |

### Next steps

- [ ] POC-1 "Cache Spine" — week 1 build (Worker+KV+Hono+render core), week 2 run T1–T8 matrix → `research/07-cache-spine-results.md`
- [ ] R1 decision after T1 kill test (soft-purge vs last-good copy)
- [ ] Feed T8 telemetry into S6 cost model (priority #1)

---

## Session 2026-06-24 — Framework Eval

### Done

- Digest pass (6 agents, 411k tokens) over new-builder docs + handlebars/lit POCs + current stack + verified Shopify baseline.
- Wrote eval: `research/03-framework-eval.md`.

### Eval verdict

- **Model is ideal; current implementation is not (yet).** Config-driven + server-rendered + no-rebuild beats current stack on all 4 solve-for axes (complexity/maintainability solved structurally now; infra-cost/stability solved _conditional on_ multi-tenancy + resilient serving tier).
- **vs Shopify:** customizability ≈/＞ (edge = live code editing), extensibility ＜ (no app/extension ecosystem), AI = bolder vision/weaker execution, performance = capable model but **<400ms unproven** + Shopify edge ceiling high.
- **Headline gap = the user's exact concerns are UNBUILT:** multi-tenancy 0%, Layer-1 SPOF resilience absent (single origin + single SQLite = total outage). Production readiness self-scored 35%.

### Decisions taken

| #   | Decision                                                                                                                                            | Why                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| D9  | New-builder architecture model accepted as the right direction                                                                                      | Beats current stack; matches Shopify OS 2.0; user to confirm         |
| D10 | Highest-value next workstream = scale/multi-tenancy + Layer-1 SPOF (folds in shell-runtime + templating, since those are constrained by scale/SPOF) | Eval shows these are the unbuilt, highest-risk, user-priority pieces |

### Open forks (from eval §3) — to decide in design

1. Shell runtime: Next.js (as-built; owns ISR/SEO) vs Hono+Vite (PROJECT-BRIEF lean; loses Next ISR machinery).
2. Templating: Handlebars vs Liquid (server, SEO-free) vs Lit (client, SEO gap). Lean: server templates + Lit/web-component islands only for interactive widgets.
3. Datastore: SQLite→Postgres multi-tenant (P0, 0%).
4. Serving topology / SPOF: need CDN/edge static tier + stale-if-error so origin death ≠ total outage.
5. Extensibility/security: tenant isolation + template sandboxing; app ecosystem?

### User answers (2026-06-25)

| #   | Decision                                                                                                                                                                | Why                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| D11 | Next = design scale/multi-tenancy + Layer-1 SPOF, folding in shell-runtime + templating                                                                                 | User confirmed verdict        |
| D12 | App/extension ecosystem = "eventually" → design extension boundaries NOW so we don't paint into a corner; first-party widgets ship first                                | User answer                   |
| D13 | **Perf bar = BEAT Shopify, no compromises** — best possible perf + SEO across code, serving, architecture, AND infra. Shopify is the target to surpass, not just match. | User answer (verbatim intent) |

⚠️ **Tension to manage:** D13 (beat Shopify perf → likely global edge rendering) vs the infra-cost discipline from the earlier KwikCart cost work. Best perf often = more edge $$. Must design for perf-per-dollar, not perf-at-any-cost — surface the tradeoff at each choice.

### Foundational constraints (2026-06-25)

| #   | Decision                                                                                                                                                                                                           | Implication                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D14 | **Commerce = GoKwik-native** — own catalog/cart/orders/checkout, NO Shopify commerce dependency                                                                                                                    | ⚠️ Scope expands from "storefront OS" to a **full commerce platform**. Must clarify what GoKwik services already exist to compose (payments, checkout, RTO, KwikPass) vs build new (catalog/PIM, cart, orders). |
| D15 | ~~**Infra = AWS (EKS) + Akamai only**~~ **SUPERSEDED by S0/ADR-012 (R3 PDF) + ratio-3.0 as built: Cloudflare Workers edge + AWS ECS origin + managed Postgres.** Original: beat Shopify within AWS+Akamai envelope | Superseded marker added 2026-07-16 (review finding #8 — doc drift)                                                                                                                                              |
| D16 | **Greenfield target design + migration path**                                                                                                                                                                      | Design the ideal build-once architecture, then a path from the POC + current Shopify-coupled merchants to it.                                                                                                   |

➡️ **Scope is now a platform, not a feature → decompose into sub-projects before deep design (brainstorming rule).** See `research/04-scope-and-decomposition.md`.

### Decomposition + spine (2026-06-25)

| #   | Decision                                                                                                                                       | Why                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| D17 | Decomposed into 8 sub-projects (A–H); deep-design the **A+B+F spine** (request path + multi-tenancy + Layer-1 resilience) FIRST                | User confirmed; it's the skeleton + hits top-3 priorities. `research/04`.                    |
| D18 | Spine architecture = **Hybrid** (edge-cache cacheable pages + origin SSR for dynamic + EdgeWorkers for routing/personalization/stale-fallback) | Only way to beat Shopify within AWS+Akamai + strongest realistic SPOF answer. `research/05`. |
| D19 | Commerce inventory (what exists to reuse) DEFERRED to sub-project D; spine treats commerce as opaque Layer-3                                   | Doesn't block the spine                                                                      |

**Spine deep-design sections (approve each):** 1) request lifecycle + cacheable/dynamic contract · 2) multi-tenancy & routing · 3) resilience & degradation tiers (Layer-1 SPOF) · 4) shell runtime (Next vs lean) · 5) cache/purge + multi-region topology. → spec lands in `specs/`.

---

## GOVERNING RULES (apply to every decision, always)

> **Rule #1 — Ask, don't assume.** If anything is unknown or even slightly worth discussing, ASK. No shortcuts. No silent assumptions.
> **Think long-term.** Design for scale: 100 → 500 → 1,000 → 5,000 merchants.
> **Heterogeneous traffic.** Merchants are NOT uniform — wildly different traffic levels; sales/flash-sale spikes are first-class, not edge cases.
> **Build it once.** This gets built one time and must hold. Don't rush; think of everything before committing.

---

## Session 2026-06-23 — Kickoff

### Requested by user

1. **Evaluate the new framework** — is it ideal vs Shopify? Compare on:
   - Customizability
   - Extensibility
   - AI enablement
   - Performance
2. **Compare to the older network** — the new arch must _completely_ solve for:
   - Complexity
   - Maintainability
   - Infra costs
   - Stability
3. **Resilience** — prevent single points of failure, specifically **Layer 1 being down**.
4. **Migration** — move **shopkit packages** and **platform-specific logic** from the older repo/architecture into the new one.
5. **Process** — maintain all docs in `/Developer/new-OS-arch`; keep this MOM listing every ask, discussion, decision, and rationale.

### Context established (from filesystem)

- Existing planning artifacts found: `editor-storefront-decoupling-master-plan.md` (~98KB), `decoupling-plan-review.md`.
- Candidate repos: `gokwik-side-cart`, `kwik-cart-dashboard`, `kwikcart.gokwik.co`, `gk-checkout`, `gokwik-custom-checkout`, `checkoutscripts`, `gk-script`, `gk-pages`, `gokwik.pdp`.
- This effort ties to the **KwikCart / Open Store** POD tracked in the May 2026 infra cost report.

### Decisions taken

| #   | Decision                                                                                   | Why                                                                   |
| --- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| D1  | Use brainstorming process before any implementation                                        | HARD-GATE: no code/scaffold until design approved                     |
| D2  | Maintain docs in `/Developer/new-OS-arch` (`research/`, `decisions/`, `specs/`) + this MOM | User-requested process                                                |
| D3  | Begin with a parallel read-only "Understand" pass over existing plans + repos              | Massive scope; ground design in current state before asking questions |

### Understand pass — COMPLETE (2026-06-23, 6 agents, 365k tokens)

Full map: `research/01-current-state-map.md`. Headline findings:

- **New framework = `bblunt-2.0`** (`/code-editor/bblunt-2.0/`) — Next.js 15 on `@shopkit/*` packages. NOT a from-scratch "commerce-OS"; it's a widget/theme/template storefront + shopkit ecosystem.
- **"shopkit" = the `@shopkit/*` internal package namespace** (builder, data-layer, cart, webhooks, ai-store-builder, etc.) — the commerce abstraction layer. Migration = porting platform-specific logic into these packages.
- **Older network = `old_architecture/` + `checkoutscripts` + `gokwik-custom-checkout` + `gk-script`** — Shopify-coupled monolith, god files (`createOrder.js` 772 LOC), Lambda+SQS, poor maintainability.
- **Editor-decoupling master plan is a SEPARATE effort** (extract visual editor to standalone app) — related, not the core of this engagement.
- **"Layer 1" is AMBIGUOUS** — in the plan it's an iframe-auth security layer; user likely means an infra/serving availability tier. MUST confirm.

### Decisions taken (this pass)

| #   | Decision                                                         | Why                                       |
| --- | ---------------------------------------------------------------- | ----------------------------------------- |
| D5  | Documented full current-state map before asking design questions | Rule #1 — ground truth before assumptions |

### ⚠️ SCOPE CORRECTION (user, 2026-06-23) — supersedes D4

- **D4 was WRONG.** bblunt-2.0 is NOT the new framework — it's the _current_ Next.js stack (≈ old_architecture).
- **NEW architecture = `/Developer/new-builder/`** — config-driven 3-layer storefront OS. Two POC tracks: `new-builder-handlebars` (Handlebars/Liquid) + `new-builder-lit` (Lit). Source: `new-builder/new-builder-handlebars/mvp-architecture-priorities.md`.
- **Layer 1 = the Shell** (the Next.js app: routing/layout-engine/widget-loader/ISR/SEO/action-dispatcher). "Layer 1 down" = shell down = ALL merchant storefronts down. This is the SPOF to eliminate. (NOT the editor iframe-auth layer.)
- **OLD = bblunt-2.0 + old_architecture** (current Next.js + @shopkit React widgets).
- Full corrected map: `research/02-corrected-scope.md`.

| #   | Decision                                                                                                                                                      | Why                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| D6  | New=new-builder (config-driven 3-layer), Old=bblunt/old_architecture                                                                                          | User correction, confirmed against mvp-architecture-priorities.md |
| D7  | Layer 1 = Shell layer; SPOF target = shell outage (owns routing → L1 down = all merchants down)                                                               | User-confirmed                                                    |
| D8  | Shell RUNTIME is open (Next.js/Express/Hono/…), chosen by priorities+scale+SPOF; widget rendering open (Handlebars/Liquid vs Lit). Both are part of the eval. | User-confirmed 2026-06-24                                         |

### Open questions (to resolve before design) — see research/01 §6

1. **What does "Layer 1" mean?** (security gate vs infra serving tier) — blocks SPOF workstream.
2. Multi-tenant model: single-tenant-per-merchant vs one multi-tenant deploy? — blocks scale strategy.
3. `@shopkit/data-layer` Shopify-GraphQL ↔ custom-REST mapping.
4. Deploy model: static / ISR / on-demand SSR + cache invalidation.
5. AI invocation flow + guardrails for `@shopkit/ai-store-builder`.
6. Is `old_architecture/` an in-progress port or true legacy?

### Action items

- [x] Create `/Developer/new-OS-arch` structure + MOM
- [x] Complete Understand pass → `research/01-current-state-map.md`
- [ ] User confirms current-state map + answers "Layer 1" + scope/sequencing
- [ ] Decompose 5 workstreams + pick first to design

---
