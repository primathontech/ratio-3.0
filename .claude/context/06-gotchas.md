# 6 — Gotchas (read before touching render / theme / CI)

Hard-won landmines. Each has bitten someone.

## Two hand-synced render engines

`packages/builder-render/` has **two copies** of the Liquid engine:

- `engine.ts` — in-process, for trusted/first-party render.
- `worker.mjs` — a **hand-written second copy** run in a worker-thread **isolate** for **untrusted
  merchant Liquid** (kept dependency-light on purpose so the TS loader doesn't leak into the worker).

⚠️ **A filter added to one MUST be mirrored in the other**, or the storefront silently diverges. This
has already caused two bugs: the `asset_url` filter (missing in the isolate → "undefined filter") and a
**money 100× bug** (paise→rupees `/100` present in one copy, not the other → every price 100× wrong).
There is an **engine↔isolate parity test** guarding this — keep it green, and when you add a filter,
add it to both + the parity test.

## `saveOverrides` deletes base files you omit

`saveOverrides(fullTree)` diffs against the base and marks any base file **absent from the payload** as
a deletion (`_deletes`). The editor must always send the **entire composed tree**, not a partial. A
partial save (e.g. just `{ 'sections/hero.liquid': ... }`) silently drops `layout/theme.liquid`,
`templates/index.json`, etc. — the store then renders blank / can't publish. When writing a test or a
programmatic caller, scaffold/GET the composed tree first, layer your edit on top, then save.

## `productLimit` vs `first`

The GoKwik `getProducts` reads **`first`** for the listing page-size. **`productLimit` is a
COLLECTION-only field** (`getCollectionsByHandles`) that `getProducts` silently ignores → it falls back
to the backend default (20). If a `PRODUCTS` dataSource "won't limit", check the param name.

## CI ≠ local green

- Root `bun run typecheck` is **not** the same as green CI. **admin-web has its own stricter typecheck**
  (the `admin-ui` CI job) — run `cd apps/admin-web && npx tsc --noEmit` when you touch it.
- **CI has no MinIO.** Any bundle/storefront-render/asset test must be **gated on `BUNDLE_S3_ENDPOINT`**
  (skip when unset), or it fails in CI. Follow the `const skip = endpoint ? false : '...'` pattern.
- `admin-web` uses **vitest**; the rest uses **`node:test`**. Don't mix runners.

## Tests need the DB bootstrap

`node:test` runs need `--import ./tests/bootstrap.ts` (it calls `configureDb` from `DATABASE_URL`).
Without it: `@ratio/data-db: configureDb(...) must be called at startup`. Local test DB is **`s2poc_test`
on port 5433** (docker), not 5432.

## The shell still fills chrome even when the theme "owns the document"

`renderChrome` runs **unconditionally** and its output is injected into the layout's `{{ header }}` /
`{{ footer }}` slots — in _both_ the layout branch and the shell branch. So flipping `THEME_OWNS_DOCUMENT`
does **not** by itself make the theme's own header/footer sections replace `renderChrome`; retiring
`renderChrome` is a separate, larger step (OFCE-641). Likewise the **order/thank-you page** and the
**page-builder degrade renderer** still hard-use `storefrontHead` and aren't behind the flag.

## Base version bumps

Editing `default-theme.ts` changes the default content hash → `ensureDefaultBaseTheme` cuts a **new base
version** on next provisioning. Existing live stores keep their pinned version until rebased; new stores
get the new base. This is non-breaking but means "the base is now vN+1" — expect the version number to
climb and stores on older versions to need the rebase migration.

## Deleting anything a merchant might have

Never `git add -A` (sweeps others' WIP). Before deleting/overwriting a store's data, look at it — the
`ThemeStore` primitives are used by trusted internal flows (onboarding, rebase) that must stay working;
route-level validation (untrusted merchant/AI input) is where new constraints belong, not the primitive.

## Mirror-sync / momsco (if you touch the sync)

Downstream app repos (e.g. `apps/momsco`) are kept in sync via a snapshot-append mechanism (filter-repo
mangled merge trees historically). Bulk widget/theme sync into an app also needs its hooks + checkout
services; `EDITOR_CHANGES=false` uses local templates. The sync CI has been fragile (App/secret). Tread
carefully and check the relevant memory/PRs before a bulk sync.
