---
name: theme-change
description: Use before changing anything in the bundle theme system (builder-core theme, builder-render engine, default theme, publish/rebase, storefront render) so you don't trip the invariants that silently break the storefront.
---

# Changing the Theme System (Ratio 3.0)

The theme/render system is the core domain and the most fragile. Read `.claude/context/05-theme-system.md`
first. Then respect these invariants.

## Before you touch it

- Understand `base ⊕ overrides`: a store's theme tracks a shared `library-default` base at a pinned
  version and stores only changed files. `readComposed = base source ⊕ overrides`.
- Understand the render: the origin ALWAYS renders `layout/theme.liquid` as the whole document (full
  theme ownership, #280 — no `THEME_OWNS_DOCUMENT` flag, no TS shell). A LIVE theme that isn't a full
  document fails loud (500); the publish/activate/rollback invariant prevents that for new publishes.

## Invariants — violating any of these breaks the live storefront

1. **Two engines, hand-synced.** A Liquid filter added to `builder-render/engine.ts` MUST be mirrored in
   `worker.mjs` (the untrusted isolate) AND the parity test. `engine.ts` is trusted/in-process;
   `worker.mjs` renders untrusted merchant Liquid. A drift is invisible until the storefront diverges.
2. **`saveOverrides(fullTree)` deletes omitted base files.** It diffs against base; base files absent
   from the payload become `_deletes`. Always save the FULL composed tree — scaffold/GET it, layer your
   edit on top, save. Never a partial.
3. **Commerce limit param is `first`, not `productLimit`** (the latter is COLLECTION-only and ignored by
   `getProducts` → defaults to 20).
4. **Validate at the route boundary, not the `ThemeStore` primitive.** Onboarding adopt + rebase call
   the primitive with trusted, valid data; a guard in the primitive breaks them. Merchant/AI input
   arrives at the admin routes — validate there.
5. **A base content change cuts a new base version.** Editing `default-theme.ts` bumps the hash →
   `ensureDefaultBaseTheme` cuts a new version; existing stores need `rebase-to-latest-base.ts --apply`
   to pick it up. Non-breaking but expect the version to climb.
6. **Publishing/activating must move the live pointer + enqueue a tenant-tag purge** (already handled by
   `ThemeStore.publish`/`setLive`) so the edge drops stale pages.

## Verify a theme change end-to-end

- Unit: render via `renderThemePage` with a fake `BindingResolver` (builder-core tests).
- Origin: publish → `app.fetch('/')` with edge auth → assert `x-handler: theme-bundle` and the expected
  markup / `x-theme-render`.
- Real data (manual, not committed): drive the preview route with `COMMERCE_*` = prod GoKwik and a
  tenant `commerce.merchantId = 196jdfqy1aot` (the test merchant) — expect real products, `sampleData:false`.
- Run the theme suites: `packages/builder-core/src/__tests__/*` + `apps/origin/src/__tests__/theme-*`
  - `apps/admin-api/src/__tests__/theme-*` (see the `run-tests` skill for the command). Plus typecheck.

## Current work

Full Theme Ownership (OFCE-629) is mid-go-live. The invariant is unconditional and the TS shell is
retired (#280). Remaining: run the base-rebase migration on staging (a hard deploy prereq now), and
migrate the order/thank-you page onto the theme layout. See `.claude/context/07-roadmap-and-state.md`.
