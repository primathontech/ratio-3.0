# Corrected Scope (SUPERSEDES parts of 01)

> 2026-06-23. User corrected the scope twice. This doc is authoritative on "what is new vs old" and "what Layer 1 is". Read this over `01-current-state-map.md` where they conflict.

## What is the NEW architecture

**`/Users/lakshyagokwik/Developer/new-builder/`** — a config-driven storefront OS. Source of truth: `new-builder/new-builder-handlebars/mvp-architecture-priorities.md`.

Two parallel POC tracks (rendering approach undecided):

- `new-builder-handlebars/` — server-side Handlebars/Liquid templates.
- `new-builder-lit/` — Lit web components.
- Companion decision docs: `docs/HANDLEBARS-VS-LIQUID.md`, `arch-handlebars-templates.md`, `new-builder-lit/arch-lit-web-components.md`.

### Three-layer model

- **Layer 1 — Shell:** Responsibilities are FIXED — routing (URL→config), layout engine (config→DOM slots), widget loader (resolve+render), caching/ISR, page `<head>`/meta/OG/JSON-LD, client `data-action` dispatcher. Contains **no** merchant layout/styles/content; doesn't know what widgets exist; doesn't fetch data directly. One codebase, one deployment.
  - **Runtime is OPEN (a decision, not a given):** Next.js vs Express vs Hono vs … — pick whatever best serves the priorities (P0 config-driven render, P1 live code-edit, P2 page-create, P3 <400ms, P4 SEO-in-HTML, P5 <2s save-to-live) AND the scale/SPOF goals. This choice is part of the eval.
  - **"Layer 1 down = total outage"** (confirmed by user): the shell owns routing, so if it's down every merchant storefront is down. This is THE single point of failure to eliminate.
- **Layer 2 — Config + Widget Code:** merchant-specific JSON in Postgres via Config API. Page config (slug, sections, widgets w/ props+dataBinding+style), widget registry (+schemas the editor reads), custom widget code (inline string for MVP), style tokens (CSS vars), versioning (draft/published rows).
- **Layer 3 — Data APIs:** product/collection data. Fetched server-side during ISR render; baked into cached HTML. Cart/session client-side (mocked in MVP).

### Core principles

- Page renders entirely from JSON config — no hardcoded layout, no rebuild on edit (edit → save → ISR revalidate → live, target <2s).
- Code editor edits live widget code; preview reads draft, publish promotes to published.
- Dynamic `/[...slug]` route resolves any page from config; new pages need no deploy.
- Perf target <400ms warm; SEO content in initial HTML (free with server templates).
- **MVP = single store, single deployment, NOT multi-tenant yet.** Multi-tenant (100→5000 merchants) + spiky traffic is the scale-up this engagement must design toward.

## What "Layer 1" means (RESOLVED, user-confirmed 2026-06-23/24)

**Layer 1 = the Shell** — the layer that owns ROUTING and orchestrates render. Its responsibilities are fixed (above); its **runtime/framework is an open decision** (Next.js / Express / Hono / …), to be chosen against the priorities + scale + SPOF. "Layer 1 down = everything down" because it handles routing → it is the SPOF to eliminate. (NOT the iframe-auth "Layer 1" from the separate editor-decoupling plan — red herring.)

### Open decisions feeding the eval

1. **Shell runtime:** Next.js vs Express vs Hono vs … (optimize for the 6 priorities + scale + no-SPOF).
2. **Widget rendering:** Handlebars/Liquid (server templates) vs Lit (web components) — both are live POCs.
   Both are part of the framework eval, judged against Shopify (customizability/extensibility/AI/perf) and the current Next.js stack (complexity/maintainability/infra/stability).

## What is the OLD / current architecture

**`bblunt-2.0` + `old_architecture`** (under `/code-editor/` and `/Developer/`) — the current Next.js + `@shopkit` React-widget framework. bblunt-2.0 and old_architecture are "more or less the same" current stack. This is what new-builder aims to replace.

## Doc set still to digest (before the Shopify eval)

`new-builder-handlebars/docs/`: ARCHITECTURE.md, PROJECT-BRIEF.md, AI_Native_Page_Builder_PRD_v2.md, AI_Page_Builder_Tech_Spec.md, HANDLEBARS-VS-LIQUID.md, ISR-AND-CACHING.md, SSR-AND-HYDRATION.md, SEO.md, EDITOR-COMMUNICATION.md, BUILD-AND-SAVE.md, PROGRESS.md. Plus `demo/`, `storefront/`, `editor/`, `backend/`, `packages/` code.

## Open confirmations (asked of user 2026-06-23)

1. New = new-builder (config-driven 3-layer) / old = bblunt+old_architecture — correct?
2. Layer 1 = Shell, "L1 down = all storefronts down" — correct?
3. Handlebars vs Lit — is picking between them part of THIS eval, or already decided?
