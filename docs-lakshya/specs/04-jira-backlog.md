# Jira Backlog — Commerce OS 3.0 (Ratio)

> Draft ticket breakdown · 2026-07-21 · Project key: **OFCE**
> Source: MOM decisions D22–D37, specs/02 (cache spine v3.1), specs/03 (infra runbook),
> research/07 (risk register), research/08 (POC results).
> Format per item: **Summary** · type · **Description** · **Acceptance criteria** · **Why**.
> Scope: India-only (D37); international items flagged `[year-out]`.

---

## EPIC 1 — Cache Spine: Akamai + AWS Infra Validation

> Prove the POC-1 architecture on real Akamai EdgeWorkers + EdgeKV + AWS S3. Blocks ratification of
> D25–D29. All stories run against a throwaway tenant (`poc.ratiodev.in`), never a real store.

**OFCE-CS-0 · Task · Provision Akamai + AWS test infra**

- Description: Akamai contract with EdgeWorkers + EdgeKV enabled; test property on `poc.ratiodev.in`; EdgeWorker id + EdgeKV namespace; Fast Purge API client (`.edgerc`). AWS S3 bucket in `ap-south-1` + IAM key (PutObject/GetObject/ListBucket). Two Linux probe hosts in distinct Indian cities (curl + k6). Seed `t_poc` in Neon.
- AC: all credentials/IDs handed to the build team; `poc.ratiodev.in` resolves; a static object round-trips S3 from both probes.
- Why: nothing in this epic can run without it. This is the sole external blocker.

**OFCE-CS-1 · Story · EW-1: EdgeWorker fit (CPU + subrequest budget)** ⚠️ run first

- Description: Deploy the real edge program (tenant resolve + version pointer read + cache check + S3 fetch-on-miss + route-index/tombstone logic) to an EdgeWorker. Read Akamai's per-request CPU-ms, wall-time, and subrequest report under load.
- AC: stays under EdgeWorker limits with headroom at target RPS. If it fails: documented split — EdgeWorker keeps {resolve, read pointer, build key, serve-or-forward}, S3 fetch + index logic move to the ECS origin tier.
- Why: Akamai EdgeWorkers are far tighter than the POC's assumptions (strict CPU, ~4 subrequests). If the algorithm doesn't fit, the fix is architectural — must be learned before building the rest.

**OFCE-CS-2 · Story · EW-2 + P14: publish→live propagation**

- Description: Wire two-phase publisher to Neon + S3; flip EdgeKV pointer on activate. Run ≥100 publishes; from both probes poll until the new version is visible; clock starts at commit; record p99 + MAX.
- AC: p99 ≤ 60s; MAX recorded; editor preview reflects change immediately (no-store).
- Why: validates the ≤60s freshness SLO (D25) on real EdgeKV, not on paper.

**OFCE-CS-3 · Story · P6: SPOF kill test** 💰 the money test

- Description: Warm a page in PoP-A, leave a page cold in PoP-B. Scale ECS to 0 + block Neon. Re-probe both PoPs incl. a deleted route.
- AC: warm page = HIT; cold page = served from S3; deleted route = 404 from current-release tombstone; **zero shopper errors** for the materialized set. Restore ECS after.
- Why: the entire redesign exists to kill the "Layer-1 down = all stores down" SPOF. This proves it.

**OFCE-CS-4 · Story · P15: flash-sale miss storm**

- Description: k6 heavy load from both probes; flip a release mid-storm. Measure origin/S3 render amplification, p99, error rate.
- AC: amplification within the declared bound (unique pages × processes × PoPs-with-traffic); no fleet instability; no 5xx.
- Why: spiky/flash-sale traffic is a first-class requirement, not an edge case.

**OFCE-CS-5 · Story · P16: release retention / GC**

- Description: Activate release N+1 while PoP-B still observes N; run GC concurrently.
- AC: release N stays readable through the propagation safety window; GC never breaks a lagging PoP.
- Why: prevents a cleanup job from 404-ing pages in a PoP that hasn't seen the new pointer yet.

**OFCE-CS-6 · Story · EW-3: Fast Purge cache-tag latency**

- Description: Change a price, trigger Akamai Fast Purge by cache-tag, time tag→fresh across both PoPs.
- AC: ~5s global; tag granularity documented.
- Why: native Akamai cache-tags are the feature that removed the Cloudflare Enterprise cost bomb (S6). Confirm it works.

**OFCE-CS-7 · Story · EW-4: cost telemetry → S6**

- Description: Capture real renders/day, S3 GET volume, S3→Akamai egress, request counts, cold-miss RTT.
- AC: numbers land in the S6 cost model; per-store cost estimable.
- Why: turns the #1-priority cost model from a guess into real per-store economics.

**OFCE-CS-8 · Task · prove-prod.yml + evidence capture**

- Description: One-click GitHub workflow running the matrix; append raw evidence (Akamai debug headers, timestamps, commit IDs, purge/aws logs) to research/08 "Tier 2 — Akamai".
- AC: matrix repeatable in one run; scorecard rows flip from ⏳ to ✅/❌ with raw evidence attached.
- Why: conclusions without raw evidence don't ratify; repeatability lets us re-run after every change.

---

## EPIC 2 — Template Engine + Cacheability Inference (Liquid)

> Wire real LiquidJS into the render path with a sandbox, and auto-derive each template's cache tier.
> Unblocks merchant code editing (REQ-1) and safe custom widgets.

**OFCE-TE-1 · Story · Integrate LiquidJS into the render path**

- Description: Replace the mocked theme engine with LiquidJS; render widgets/pages via Liquid; precompile templates per registry version.
- AC: POC pages render via Liquid; compiled-template cache keyed by version; no regression in output.
- Why: D33 chose Liquid as the merchant-template base; the engine is currently mocked.

**OFCE-TE-2 · Story · Template sandbox + resource limits (B1)**

- Description: Run merchant templates under enforced renderLimit/memoryLimit/parseLimit + an isolate; hard-terminate on breach.
- AC: hostile template (infinite loop, huge string, deep recursion) is terminated, not served; limits are enforced not cooperative.
- Why: Liquid removes the prototype-escape class but does NOT bound compute — untrusted merchant code needs a hard ceiling.

**OFCE-TE-3 · Story · Cacheability inference service (B2)**

- Description: Static-analyze a template (LiquidJS `analyzeSync`): diff `globals` vs declared bindings → reject undeclared access; classify filters/tags against a tier allowlist; ban unresolved `render`/`include` from the auto-cacheable tier; treat `locals` as in-scope.
- AC: undeclared data access rejected at publish; time/random capabilities force a field off `static`; laundering via assign/capture caught; dynamic index `x[y]` surfaced.
- Why: REQ-3 says devs declare nothing — the platform must COMPUTE the tier, soundly, or purity (and cache correctness) is fiction.

---

## EPIC 3 — Akamai Edge Port (from proven POC)

> Swap the fault-injectable fakes for real Akamai/AWS drivers behind the proven interfaces.

**OFCE-EP-1 · Story · Real EdgeKV + S3 + EdgeWorker drivers**

- Description: Implement `KVLike`→EdgeKV, `R2Like`→S3 client, edge algorithm→EdgeWorker bundle. Logic unchanged (already proven P1–P13).
- AC: `npm run prove:s1`-equivalent passes against real bindings on staging.
- Why: the POC was built behind interfaces precisely so this is a driver swap, not a rewrite.

**OFCE-EP-2 · Story · Two-phase publisher wired to Neon + S3**

- Description: commit (release + outbox + content pin) → materialize to S3 (incl. tombstones + route index) → verify → activate (EdgeKV pointer). Serialized per-tenant drainer.
- AC: publish end-to-end on staging; crash-and-resume converges; migration 0009 applied.
- Why: turns the in-memory state machine into the real control-plane pipeline.

---

## EPIC 4 — Page Builder / Editor

> The merchant-facing authoring app. Critical path to anything shippable.

**OFCE-PB-1 · Story · Editor ↔ storefront contract (brainstorm + spec)**

- Description: Design how the editor produces the page config the storefront renders: layout, widget instances, data bindings, custom code, preview, publish. Fold in the editor-decoupling master plan.
- AC: approved UI-SPEC + data contract; preview uses the no-store path; publish triggers the two-phase publisher.
- Why: the spine can serve pages but nothing authors them yet beyond the POC.

**OFCE-PB-2 · Story · Custom-code editing (REQ-1)**

- Description: In-editor Liquid editing for custom widgets, gated by the sandbox (TE-2) + inference (TE-3); binding picker so data access is declared.
- AC: a merchant can write a custom widget; undeclared data access is rejected with a clear error; preview renders it.
- Why: Shopify-style freedom is a stated requirement — safe only through the sandbox + binding contract.

**OFCE-PB-3 · Story · Publish + read-your-writes preview**

- Description: Publish flow (optimistic-concurrency aware, uses `routes.version`); editor preview always shows latest even during the ≤60s propagation window.
- AC: merchant never sees stale after "Published ✓"; concurrent edits handled (409).
- Why: A2/read-your-writes finding — avoids "is it broken?" support tickets.

---

## EPIC 5 — Widget System + Registry

> The building blocks everything renders through.

**OFCE-WG-1 · Story · Widget registry + schema contract**

- Description: Formalize widget types, propsSchema, dataBindingSchema, per-field cacheability tier + purge tags. Version the registry.
- AC: registry served + cached per version; layout engine resolves tiers from it; first-party widget set defined.
- Why: cacheability, purge, and rendering all key off the registry contract (spec 02 §1A).

**OFCE-WG-2 · Story · First-party widget library**

- Description: Build the core widgets (header, PLP, PDP, cart, collection, CMS/policy) on the registry contract.
- AC: a full storefront renders from first-party widgets; each declares its tier correctly.
- Why: ship first-party before third-party (D12).

**OFCE-WG-3 · Story · Islands runtime (hydration)**

- Description: The ~2KB action dispatcher + per-user island fill (edge: cart count from signed cookie; client: batched state API). Reserve placeholders (no CLS).
- AC: cached page paints instantly; per-user slots hydrate without layout shift; CSP allows first-party island JS.
- Why: islands are what make full-page caching legal (anything per-user lives in an island).

---

## EPIC 6 — Commerce Data Lane (L3)

> Real price/stock/cart/orders — compose GoKwik commerce services.

**OFCE-CM-1 · Story · Inventory of reusable GoKwik commerce services**

- Description: Map what exists to reuse (payments, checkout, RTO, KwikPass) vs build new (catalog/PIM, cart, orders). (Deferred sub-project D from decomposition.)
- AC: documented service map + integration boundaries.
- Why: D14 made this a full commerce platform; the spine treated commerce as opaque — now it's real.

**OFCE-CM-2 · Story · Price/stock freshness under sale (A6/R4)**

- Description: Decide + build the volatile-data path: purge-per-change vs micro-TTL state API vs client patch for price/stock during flash sales.
- AC: stock flips OOS mid-sale without overselling; measured under load.
- Why: page config embeds price today; real commerce needs a faster, correct freshness path.

**OFCE-CM-3 · Story · Cart / checkout / account (dynamic, no-store)**

- Description: The T3 dynamic surface — served private, never cached; checkout stays the isolated GoKwik service.
- AC: cart/checkout/account work end-to-end; never enter shared cache (P8/P10 hold in prod).
- Why: the dynamic path must stay off the cache to preserve correctness + the SPOF story.

---

## EPIC 7 — Personalization / Segments (REQ-2)

**OFCE-PZ-1 · Story · Bounded segment-variant caching (C1)**

- Description: Resolve segment at the edge (cookie/EdgeKV, no origin call); cache variant keyed by segment with a hard cap + overflow-to-default.
- AC: hit ratio ≥85% at the cap; segment resolution adds zero origin calls.
- Why: "different widget/content per segment" without cache explosion.

**OFCE-PZ-2 · Story · Cache-poisoning guard (C2)**

- Description: Prove no per-user byte enters a shared-cached response (esp. any widget re-render endpoint); byte-identity test across sessions; cookies/auth stripped.
- AC: same key ⇒ byte-identical across users; automated regression test.
- Why: worst incident class — user A seeing user B's data. Must be structurally prevented.

---

## EPIC 8 — App Ecosystem / Extensibility Runtime (REQ-3)

> Third-party apps under contract; platform enforces everything (`[largely year-out, design now]`).

**OFCE-AX-1 · Story · App lane model + hard gate**

- Description: Lane A (app widgets under the widget contract), Lane B (app islands via sandboxed cross-origin iframe — B3 spike done), Lane C (backend-only). Hard gate: no request-time arbitrary code in the render path.
- AC: an app widget renders cache-safely; an app island runs in an iframe that cannot touch host DOM/cookies (B3 harness passes in a real browser matrix).
- Why: avoids inheriting Shopify's "apps poison cacheability" disease.

**OFCE-AX-2 · Story · Per-app metering + kill-switch**

- Description: Per-app CPU/error attribution; disable an app per-tenant and fleet-wide within seconds (via EdgeKV flag).
- AC: a runaway app is isolated + killable <60s; metrics attribute cost per app.
- Why: "devs just code, we handle everything" — one bad app must never be a fleet incident.

---

## EPIC 9 — Control Plane

> The authenticated admin/onboarding/publish backend (ratio-3.0 `services/admin-api` started).

**OFCE-CP-1 · Story · Outbox drainer as a service**

- Description: Productionize `drainPending` as a serialized per-tenant worker draining the publish outbox; crash-recovery, retries, dead-lettering.
- AC: a crashed publish auto-resumes to active; no stuck pending rows.
- Why: crash-recovery must be a running system property, not a manual step.

**OFCE-CP-2 · Story · KV↔DB reconciliation job (P13)**

- Description: Periodic job diffing EdgeKV host/pointer records against the DB active release; alert on divergence.
- AC: deleted key / orphan / wrong status / stale pointer each detected + alerted within SLA.
- Why: EdgeKV is now authoritative for routing (D29); a provisioning bug 404s a live store — needs a safety net.

**OFCE-CP-3 · Story · Onboarding: write-before-DNS + fail-closed**

- Description: Provisioning writes the EdgeKV host record before DNS; pre-seed legacy domains; suspend = explicit key overwrite.
- AC: no public-path DB fallback (spray-proof); new store live after DNS propagation; suspend effective ≤90s.
- Why: ADR-013 v3 — the fail-closed tenant-resolution contract.

---

## EPIC 10 — Migration

> Move existing Shopify-coupled merchants + shopkit packages onto 3.0 (original goal #4).

**OFCE-MG-1 · Story · Strangler-fig migration harness**

- Description: One store at a time, reversible edge repoint, gated by a visual-parity check; feature-flagged.
- AC: a pilot store migrates + rolls back cleanly; visual parity verified.
- Why: ADR-011 — migrate the live stores without a big-bang risk.

**OFCE-MG-2 · Story · Port shopkit packages / platform logic**

- Description: Move platform-specific logic from old_architecture/checkoutscripts into the 3.0 model.
- AC: platform logic runs in 3.0; old repo dependency removed for migrated stores.
- Why: the original engagement goal.

---

## EPIC 11 — Observability + SLOs

**OFCE-OB-1 · Story · Ratify SLO/RTO/RPO numbers (ADR-008)**

- Description: Set + agree the actual availability/latency/recovery targets; wire dashboards + alerts (SigNoz).
- AC: numbers ratified; alerts fire on breach; feeds the degradation ladder.
- Why: the resilience design is only operable if it's measured — prerequisite for auto-rollback.

**OFCE-OB-2 · Story · Edge + publish telemetry**

- Description: Hit ratio by PoP, publish latency, render count, purge volume, per-tenant cost signals.
- AC: dashboard live; feeds S6 + capacity planning.
- Why: run-time visibility for a multi-tenant fleet.

---

## EPIC 12 — Cost Model (S6) — priority #1

**OFCE-$-1 · Story · Quotable per-store unit economics**

- Description: Combine EW-4 telemetry + Akamai/AWS pricing into a per-store cost curve at N = 8 / 100 / 1000 / 5000 stores.
- AC: per-store $ target committed; break-even point identified; pricing input delivered.
- Why: still the #1 unquoted blocker — can't price the product without it.

---

## EPIC 13 — Security / Compliance

**OFCE-SEC-1 · Story · DPDP + tenant isolation audit (India)**

- Description: Confirm data residency (India-only simplifies), tenant-scoped writes at every new layer, per-tenant secrets, tenant hard-delete, audit logs. (ADR-010.)
- AC: DPDP obligations mapped + met; isolation holds across spine + control plane + apps.
- Why: compliance + the multi-tenant isolation guarantee; India-only makes residency easier now.

---

## Suggested sequencing

1. **Now (blocks everything downstream):** Epic 1 (infra validation) + Epic 2 (Liquid+inference) + Epic 3 (edge port). EW-1 first.
2. **Critical path to shippable:** Epic 4 (page builder) + Epic 5 (widgets) — the biggest open design.
3. **Makes it real commerce:** Epic 6 (data lane) + Epic 9 (control plane).
4. **Differentiators:** Epic 7 (personalization) + Epic 8 (apps).
5. **Cross-cutting, continuous:** Epic 11 (observability), Epic 12 (cost), Epic 13 (security).
6. **When stores exist to move:** Epic 10 (migration).
