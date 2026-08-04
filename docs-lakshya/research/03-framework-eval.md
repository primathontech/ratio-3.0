# Framework Eval — new-builder vs Shopify & vs current Next.js stack

> 2026-06-24. Evidence: digest workflow (6 agents, 411k tokens) over new-builder docs, both POC tracks, current stack, verified Shopify baseline. This is analysis for discussion — decisions still belong to the user (Rule #1).

## 0. TL;DR

- The **architecture model** (config-driven, 3-layer, server-rendered HTML, no-rebuild-on-edit) is **sound and right** — it mirrors Shopify Online Store 2.0 and decisively beats the current stack on every "solve-for" axis.
- BUT the current state is a **POC (~35% production-ready)**. The two hardest, highest-value pieces are **unbuilt**: **multi-tenancy (0%)** and **Layer-1 SPOF resilience**. These ARE your headline concerns (100→5000 merchants, spiky traffic, "Layer 1 down = everyone down").
- The decisions that determine whether it scales are **still open**: shell runtime (Next.js vs Hono/…), templating (Handlebars vs Liquid vs Lit), datastore (SQLite→Postgres), serving topology (is there a CDN/edge tier that survives origin death?).
- **Verdict:** the model is ideal; the implementation is not yet. "Ideal" hinges on getting the open decisions right — which is the rest of this engagement.

---

## 1. new-builder vs Shopify (the 4 axes you asked)

Yardstick = Shopify Online Store 2.0 (no-code, config-driven — closest analog) + Hydrogen/Oxygen (performance ceiling).

### Customizability — **competitive, with an edge**

- Shopify: Liquid + OS 2.0 JSON templates, sections/blocks on every page, theme settings, dynamic sources → metafields/metaobjects. Limit: **template-bound; complex/dynamic data still drops to Liquid; metaobject looping not available in the editor.**
- new-builder: JSON page config + sections/widgets + style tokens + **direct code editing of widget templates in-browser (Monaco)**. This is the differentiator — Shopify gates raw code editing; new-builder makes it P1.
- **Read:** parity on no-code; _better_ on power-user code editing (edit widget HTML/CSS live, no deploy). Needs the registry/schema breadth Shopify has accrued over years.

### Extensibility — **behind today, by design-debt not design**

- Shopify: apps + theme app extensions (app blocks), **Shopify Functions** (server-side discount/shipping/payment/validation), **Checkout UI Extensions** (sandboxed React), Storefront API, Hydrogen. Broad, governed, sandboxed, upgrade-safe.
- new-builder: widget registry (insert a DB row = new widget type), custom widget code, `data-action` dispatcher. No app ecosystem, no third-party extension surface, no checkout-extension model, no sandboxing story yet.
- **Read:** fine for first-party widgets; **not** an extensibility platform yet. If third-party/app extensibility matters, it's a major unbuilt surface.

### AI enablement — **vision is more ambitious; reality is a demo**

- Shopify: Sidekick (agentic, function-calling — generates sections/Flows/apps) + Magic (inline generative copy + theme block code). Bundled, shipping, adopted.
- new-builder: **AI-native vision** (Brand Layer → content writer, widget code-gen, explainer/fixer, NL config, page scaffold, governance/quality-gates). But shipped = a **synchronous demo on SQLite single-tenant**; "zero AI features existed" in the old system.
- **Read:** the _design_ (brand-context-everything, AI-assists-merchant-decides, graceful degradation, publish quality gates) is arguably ahead of Shopify's framing. Execution is early. Big opportunity, unproven.

### Performance — **model supports it; unproven; Shopify's ceiling is high**

- Shopify: hosted Online Store on global CDN/edge; Hydrogen on **Oxygen** (Cloudflare workerd, co-located Storefront API ~localhost latency, streaming SSR, sub-second TTFB). Storefront API has **no request-count rate limit**.
- new-builder: target <400ms warm via ISR static HTML + layered cache + **zero React hydration** (~2KB dispatcher). Server-rendered Handlebars = SEO free.
- **Read:** the no-hydration server-HTML model is genuinely fast and SEO-strong **IF** there's a real edge/CDN cache tier. **<400ms is an intent, not benchmarked.** Cold-miss path (origin → backend over network) is uncharacterized. Shopify's edge co-location is the bar to beat.

**Axis summary vs Shopify:** customizability ≈/＞ · extensibility ＜ · AI = bolder vision/weaker execution · performance = capable model, unproven, Shopify ceiling high.

---

## 2. new-builder vs current Next.js stack (must _completely_ solve)

The current stack (`old_architecture` + `bblunt-2.0` + `checkoutscripts`) — documented pain:

| Axis                | Current stack (evidence)                                                                                                                | new-builder model                                                                                        | Solved?                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Complexity**      | 898-LOC editor god-store; 872/744/646-LOC per-merchant widget files; 34 widgets statically imported (bundle grows linearly)             | Widgets = DB-stored template strings; thin shell; registry-driven; zero hardcoded layout                 | **Yes, structurally** — if registry/widget model holds at scale                        |
| **Maintainability** | Per-merchant widget duplication (500 merchants ≈ 16,500 widget copies); 277 `any`; 0 tests; 3 parallel cart systems                     | One shell, config per merchant, no per-merchant code copies; design tokens not hardcoded                 | **Yes, structurally** — needs tests + consolidated cart                                |
| **Infra cost**      | 1 merchant = 1 build/deploy (42 env vars); single Azure VM + PM2; manual SSH deploy; no CI/CD/staging                                   | One deployment serves all merchants (target); content change = config write + ISR revalidate, no rebuild | **Yes IF multi-tenant + CDN built** (currently 0% multi-tenant)                        |
| **Stability**       | Deploy-and-pray (no tests/staging); no-cache headers break ISR; editor saves instantly live (no draft/publish/rollback); single VM SPOF | draft/published versioning + immutable snapshots + rollback; layered cache                               | **Partially** — versioning solved; **SPOF NOT solved** (single origin + single SQLite) |

**Read:** new-builder _structurally solves_ complexity + maintainability now, and solves infra-cost + stability **conditional on** multi-tenancy + a resilient serving tier being built. The current stack's fatal flaws (per-merchant deploy, no draft/publish, linear bundle) are designed out.

---

## 3. The open architectural decisions (NOT yet made — feed next workstreams)

1. **Shell runtime (Layer 1):** As-built = Next.js (storefront + editor). PROJECT-BRIEF calls Next.js "overkill," wants **Hono** (storefront) + Vite/React (editor). ⚠️ But ISR, `revalidatePath`, `generateMetadata`, fetch-cache are **Next.js-specific** — leaving Next.js means re-implementing the entire cache/invalidation/SEO layer that the <400ms story depends on. **Decision needed.**
2. **Templating / rendering:**
   - **Handlebars** (current): server-compiled to static HTML, zero hydration, SEO free, ~2KB JS, more mature POC. Best fit for P0/P3/P4/P5.
   - **Liquid** (PROJECT-BRIEF): same server model + Shopify-dev familiarity; migration cost low.
   - **Lit** (other POC): client-rendered web components — **NO SSR today (SEO gap)**, `eval()` security risk, 27KB+ bundle, hydration cost. Misaligned with SEO-first/thin-shell priorities.
   - **Lean:** server templates (Handlebars or Liquid) for the page; reserve **Lit/web-component "islands" only for genuinely interactive widgets** (cart, PDP variant selectors). Hybrid, not either/or.
3. **Datastore:** SQLite single-tenant (as-built) → **Postgres multi-tenant** (`merchant_id` everywhere). P0, 0% done.
4. **Serving topology / SPOF:** Today = single storefront origin + single backend = **total outage if Layer 1 down**. No CDN-only fallback, no stale-if-error, no per-region/tenant isolation described. This is the Layer-1 concern — **entirely unbuilt.**
5. **Extensibility & security:** merchant-authored templates need a tenant-isolation/XSS/sandboxing boundary; no app/extension ecosystem yet.

---

## 4. Risks / caveats

- **Doc divergence:** MVP doc vs as-built vs target spec disagree on stack (Next vs Hono, Handlebars vs Liquid, SQLite vs Postgres, sync vs SSE). There is no single committed architecture yet — that's partly what this engagement must produce.
- **POC maturity:** rendering + editor proven on **one store**; multi-tenancy, auth, security sandbox, ISR webhooks, real commerce data binding all unbuilt. PROJECT-BRIEF self-scores: architecture soundness 90%, production readiness 35%, multi-tenant 0%.
- **<400ms unproven:** no benchmarks; cold-miss/network path uncharacterized.

## 5. Verdict

**Is the new framework ideal?**

- **As a model: yes** — config-driven + server-rendered + no-rebuild is the right architecture, beats the current stack decisively, and is competitive with Shopify OS 2.0 (with a real edge on live code editing + AI-native vision).
- **As a current implementation: no, not yet** — it's a single-tenant POC. Whether it _becomes_ ideal depends entirely on the open decisions in §3, above all **multi-tenancy + Layer-1 resilience**, which are your stated priorities and are unbuilt.

**Therefore the highest-value next work** is the scale + tenancy + SPOF design (your workstreams 2 & 3), with the shell-runtime + templating decisions folded in — because those choices are _constrained by_ the scale/SPOF requirements.
