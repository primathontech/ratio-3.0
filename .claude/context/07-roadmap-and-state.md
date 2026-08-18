# 7 — Roadmap & Current State

Jira project **OFCE** ("OS FE Core & Editor"), `prima.atlassian.net`. Story-point + sprint conventions
in 04-conventions.md.

## Epic in flight: OFCE-629 — Full Theme Ownership

"The whole theme in the merchant's / AI's hands." Make the theme a complete, self-contained unit so the
origin just renders it — the substrate for AI editing the whole store. Design SoT: Confluence 28508174.

Stories:

| Story        | Scope                                                                     | State                                                                                          |
| ------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **OFCE-630** | Phase 1 — render consolidation: `layout/theme.liquid` owns the whole page | Shipped — shell retired, flag removed (#280); **staging migration + order-page still pending** |
| **OFCE-631** | Phase 2 — binary asset store (favicon, images, fonts, JS)                 | **Done** (assets, `asset_url`, `/assets/<hash>` serving shipped)                               |
| **OFCE-632** | Phase 3 — Edit Code surface: full file tree + asset manager (developer)   | Not started                                                                                    |
| **OFCE-633** | Phase 4 — create/update the core base theme, propagate via rebase         | Not started (backend `rebaseToBase` exists)                                                    |
| **OFCE-661** | Author the base theme as real files (build-time codegen, no runtime `fs`) | Not started (DX)                                                                               |
| **OFCE-664** | **AI-native theme editing** — the AI reads & rewrites the whole theme     | **Deferred** (parked; all AI work consolidated here)                                           |

## What shipped recently (merged to `main`)

- Binary asset store end-to-end: `asset_url` Liquid filter (both engine copies), content-hash asset
  store, origin `/assets/<hash>` serving (immutable, nosniff, tenant-scoped). (#270–#274)
- Isolate **money 100× fix** + engine↔isolate parity test. (#274)
- **Default home shows products for any connected store**: home rows bind a handle-independent
  `PRODUCTS` listing (`first: 8`, not the ignored `productLimit`); onboarding mapper switches a row to a
  collection when one is picked. (#276, #277)
- **Storefront-lifecycle regression test**: origin render tracks the live pointer across publish v2 +
  rollback. (#275)
- **Full-document publish invariant** (go-live step 2): publish/activate/rollback refuse a theme whose
  layout isn't a full document; infra faults surface as 500. (#278; made unconditional in #280.)
- **Retired the storefront TS shell** (go-live step 3, OFCE-641): origin always renders the theme layout,
  `THEME_OWNS_DOCUMENT` removed from all code, a non-full-document live theme fails loud (500). (#280)

## Full Theme Ownership go-live — remaining

The safe sequence (never serve a broken store):

1. **Migrate (ops, NOT yet run on staging)** — `rebase-to-latest-base.ts --apply` so every live store
   is on the full-document base. **This is now a hard deploy prerequisite**: with the shell gone (#280),
   an un-rebased body-only live store **fails loud (500)**. The script reports stores it can't rebase
   (e.g. a dirty/unpublished draft — publish or discard, then re-run) so none are missed.
2. **Enforce the invariant** — DONE (#278), unconditional since #280.
3. **Retire the shell** — DONE (#280): OFF branch + flag + gate removed; origin fails loud.
4. **Remaining**: migrate the **order/thank-you page** onto the theme layout (the last `storefrontHead`
   user in the origin); the **page-builder degrade renderer** keeps `storefrontHead` on purpose. Then
   close OFCE-630/631/641. Follow-up: move the full-document check into `ThemeStore.publish()` so direct
   callers can't bypass it.

**Resume point:** the shell is retired in code (#280). Next: run the base-rebase migration on staging
(the hard deploy prereq above), then migrate the order/thank-you page onto the theme layout.

## Other context

- **Multi-theme** (OFCE-615/616) is built: a store can have many themes, one live; full CRUD + version
  history + rollback in admin-web.
- **Onboarding wizard** (OFCE-618) is done: 4-step `/stores/new` (connect+verify → details/draft →
  design w/ collection mapping + real preview → launch/publish).
- **Super-admin console** (`/admin`): user-centric (Users | Stores); Slices 1+2 done, Slice 3 (real
  Stores metrics) pending an analytics API.
- Legacy **page-builder / content-model** renderer is being phased out; the bundle system is the sole
  origin renderer, but the **edge worker** and a **degrade path** still reference the legacy renderer —
  an open consolidation question.
