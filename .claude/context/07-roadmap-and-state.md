# 7 — Roadmap & Current State

Jira project **OFCE** ("OS FE Core & Editor"), `prima.atlassian.net`. Story-point + sprint conventions
in 04-conventions.md.

## Epic in flight: OFCE-629 — Full Theme Ownership

"The whole theme in the merchant's / AI's hands." Make the theme a complete, self-contained unit so the
origin just renders it — the substrate for AI editing the whole store. Design SoT: Confluence 28508174.

Stories:

| Story        | Scope                                                                     | State                                                            |
| ------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **OFCE-630** | Phase 1 — render consolidation: `layout/theme.liquid` owns the whole page | Built behind `THEME_OWNS_DOCUMENT`; **go-live pending**          |
| **OFCE-631** | Phase 2 — binary asset store (favicon, images, fonts, JS)                 | **Done** (assets, `asset_url`, `/assets/<hash>` serving shipped) |
| **OFCE-632** | Phase 3 — Edit Code surface: full file tree + asset manager (developer)   | Not started                                                      |
| **OFCE-633** | Phase 4 — create/update the core base theme, propagate via rebase         | Not started (backend `rebaseToBase` exists)                      |
| **OFCE-661** | Author the base theme as real files (build-time codegen, no runtime `fs`) | Not started (DX)                                                 |
| **OFCE-664** | **AI-native theme editing** — the AI reads & rewrites the whole theme     | **Deferred** (parked; all AI work consolidated here)             |

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
  layout isn't a full document, **gated on `THEME_OWNS_DOCUMENT`**; infra faults surface as 500. (#278)

## Where we paused: Full Theme Ownership go-live

The plan is a safe 3-step sequence (never serve a broken store):

1. **Migrate** — `rebase-to-latest-base.ts --apply` so every live store is on the full-document base.
   _(script verified in dry-run; the `--apply` is a staging ops step.)_
2. **Enforce the invariant** — **DONE** (#278), dormant until the flag flips.
3. **Retire the shell (OFCE-641, next pick)** — run the migration on staging → flip
   `THEME_OWNS_DOCUMENT` on (invariant + layout rendering activate together) → delete the OFF branch +
   `layoutOwnsDocument` gate + flag; migrate the **order/thank-you page** and **page-builder degrade
   renderer** off `storefrontHead`; **decouple `renderChrome`** into the layout; remove `storefrontHead`.
   Then close OFCE-630/631/641.

**Resume point:** scope OFCE-641 the same way — map the render path, plan the safe order, confirm, then
execute. Don't delete the shell before the migration has run on staging and the flag is flipped.

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
