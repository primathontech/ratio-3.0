# 5 — The Bundle Theme System (core domain)

This is the heart of the product and the most active area. Live in `packages/builder-core/src/theme/`.

## The model

- **`ThemeFiles = Record<string, string>`** — a theme is a map of path → text content:
  `layout/theme.liquid`, `sections/*.liquid`, `templates/*.json`, `assets/base.css`,
  `assets/theme.css`, `config/tokens.json`. **Text only** — binary assets are stored separately
  (content-hash keyed) and referenced via a manifest (`config/assets.json`) + the `asset_url` filter.
- **base ⊕ overrides.** Every store's theme _tracks a shared library base theme_ (`library-default`,
  owned by the system tenant `_library`) at a pinned `base_version`, and stores only the files it
  changed (`overrides`). `readComposed = composeTheme(baseSource, overrides)`. A store that edits
  nothing renders the pure base; edited files win; untouched files keep tracking base updates.
- **`_deletes`** — `saveOverrides(full)` takes the WHOLE composed tree and diffs it against base:
  changed/added files become overrides, and base files **absent from the payload become deletions**
  (`_deletes`). ⚠️ Consequence: the editor must always send the _full_ composed tree, never a partial —
  a partial silently deletes every base file it omits. (See 06-gotchas.md.)

## `ThemeStore` (packages/builder-core/src/theme/theme-store.ts)

Key methods (all `themeId`-parameterized; tenant-scoped in SQL):

- `ensureTheme(tenantId, themeId, name?, base?)` — create-only (ON CONFLICT DO NOTHING). `base` makes
  it track a library base @version; omit for a root theme.
- `readDraft(ref)` / `readComposed(ref)` — the stored overrides / the composed (base ⊕ overrides) tree.
- `saveDraft(ref, files, {expectedRevision})` — store a delta bundle (CAS via `expectedRevision`,
  throws `DraftConflict` on mismatch). `saveOverrides(ref, fullTree, ...)` — diff a full tree against
  base then saveDraft the delta.
- `publish(ref, {compile, by?, makeLive?})` — freeze `compile(base ⊕ overrides)`, cut an immutable
  `theme_bundle_version`, optionally flip the live pointer + enqueue a tenant-tag purge.
- `setLive(tenantId, themeId, version?)` — the activate/rollback primitive: repoint
  `tenants.live_theme_id/live_theme_version` at an existing published version (default: MAX).
- `rollback(tenantId, version)` — move the tenant's CURRENT live theme's pointer to `version`.
- `rebaseToBase(tenantId, themeId, {compile, toVersion?})` — **the migration primitive**: bump the
  base pin to a newer base version and republish, so untouched files (e.g. `layout/theme.liquid`)
  advance while the merchant's overrides are preserved. Moves the live pointer only if this is the live
  theme; restores the pin on failure so a retry isn't skipped.
- `listThemes` / `createTheme({base|duplicateOf})` / `renameTheme` / `deleteTheme` (refuses the live
  theme) / `listVersions` — the multi-theme (OFCE-615) CRUD.
- `loadLiveCompiled(tenantId)` / `loadCompiled(tenantId, themeId, compiledHash)` /
  `loadSource(tenantId, themeId, sourceHash)` — read frozen bundles from S3.
- `putAsset` / `getAsset` — binary assets (content-hash keyed).

The shared base lives in **`base-library.ts`**: `ensureDefaultBaseTheme` (idempotent; cuts a new base
version only when the default content hash changes), `adoptAndPublishDefaultTheme` (onboarding).
`DEFAULT_BASE_THEME_ID = 'library-default'`, `LIBRARY_TENANT_ID = '_library'`.

## Rendering (theme-render.ts)

- `renderThemePage(compiled, page, renderers, opts)` — reads `templates/<page>.json` (which sections +
  each section's data + page-level `dataSources`), resolves data via the injected `BindingResolver`,
  renders each section with its own context, concatenates. Untrusted merchant Liquid is rendered by an
  **isolate** renderer (injected by the caller — see the two-engine note in 06-gotchas.md).
- `renderThemeLayout(compiled, render, ctx)` — renders `layout/theme.liquid` as the WHOLE document,
  filling slots: `content_for_layout` (the composed sections), `header`/`footer` (chrome), `base_css` /
  `token_css` / `theme_css` (CSS layers in cascade order), and the platform slices `content_for_header`
  / `content_for_body_end` (islands runtime, integrations, security — trusted, origin-built).
- `layoutOwnsDocument(src)` — true iff the trimmed layout starts with `<!doctype` or `<html`. Anchored
  to the start (a stray `<!doctype` in a comment doesn't flip the mode).
- `assetUrlMap(compiled)` — builds the `asset_url` map (path → `/assets/<hash>`) from `config/assets.json`.

## Full Theme Ownership (OFCE-629 — the epic in flight)

Goal: the theme owns the **entire** HTML document (shell, `<head>`, chrome, scripts, assets), and the
origin just renders it — the substrate for AI editing the whole store.

- **The storefront shell is retired (OFCE-641, #280).** The origin ALWAYS renders the theme's own
  `layout/theme.liquid` via `renderThemeLayout` (`x-theme-render: layout`); there is no `THEME_OWNS_DOCUMENT`
  flag and no TS-shell fallback. A live theme that isn't a full document is a bug → the origin **fails
  loud (500)**, never a headless page / 404 / stale content. `renderChrome` output flows into the
  layout's `{{ header }}`/`{{ footer }}` slots.
- **Publish-time invariant (unconditional):** the admin publish/activate/rollback routes refuse a theme
  whose composed/frozen `layout/theme.liquid` is not a full document. This is the enforced guarantee that
  replaced the shell fallback. Enforced at the HTTP boundary, plus `ThemeStore.rebaseToBase` — the bulk
  migration's direct primitive caller — enforces it too (#283) so a broken override can't be republished
  live. The `publish`/`setLive`/`rollback` primitives are NOT guarded (store-mechanics unit tests publish
  minimal body-only bundles by design; their production callers are the guarded routes).
- **Migration (`scripts/rebase-to-latest-base.ts --apply`):** rebases every store on an older base onto
  the full-document base; **un-rebased (body-only) live stores fail loud (500)** once this deploys, so it
  must run first — including stores with a dirty draft (the script reports those; publish/discard their
  draft, then re-run). **NOT a blocking prereq today:** the env is pre-launch with **no persistent live
  stores** (build → onboard a throwaway store → test → clear → repeat), so the script only touches
  disposable fixtures. This becomes a real cutover step once persistent stores exist.
- **Order/thank-you page (migrated, #282) — deliberately LENIENT, not fail-loud.** `/order` renders
  through the theme's own layout too, but falls back to the built-in `renderOrderPage` document wrapper
  (`x-theme-render: fallback`) when no full-document live bundle is loadable. **The real reason it exists:**
  a **transient theme-store / S3 load failure** (`loadLiveCompiled` throws → `liveCompiled` returns null)
  can hit a fully-launched store, and `/order` is `no-store` (uncacheable) so the edge can't serve-stale to
  hide the blip the way it does for storefront pages. The wrapper keeps the GoKwik **Purchase pixel**
  (`ix.head`/`ix.bodyEnd`, derived from the merchant id + env, NOT the bundle) firing for a shopper who just
  paid, instead of a 500. (The other null-bundle triggers — a pre-launch draft store, an un-migrated legacy
  store, or a `BUNDLE_S3_*`-less deployment — are edge/defensive: every _launched_ merchant has a live
  bundle published from the default/base theme at onboarding, and a real shopper can't reach `/order`
  without a working checkout.) **Keep this fallback** — do not delete it as dead code — until **KwikPass**
  (GoKwik customer login) is integrated: then `/order` will be **guarded behind a login access token** (only
  the authenticated buyer sees their order) and this anonymous-degrade model gets revisited.
- **Still to come:** the **page-builder degrade renderer** still uses `storefrontHead` (kept on purpose).
  See 07-roadmap-and-state.md.

## Storefront data (products/collections)

- Templates declare **`dataSources`** (e.g. `PRODUCTS`, `COLLECTION_BY_HANDLES`, `PRODUCT`) resolved at
  render by a **`BindingResolver`**. Real data comes from GoKwik via `ShopkitResolver`
  (`commerceResolverFromEnv`); `StubResolver` returns "Sample product N" when unconnected/local.
- `getProducts` honours **`first`** for the page-size limit — **`productLimit` is a COLLECTION-only
  field it silently ignores** (a real footgun; see 06-gotchas.md). The default theme's home binds a
  handle-independent `PRODUCTS` listing so a fresh store always shows products.
- Onboarding's `mapFeaturedCollections` (admin-web) rebinds a home row to `COLLECTION_BY_HANDLES` when
  a merchant picks a collection.
