# Base themes — how to add one

A **base theme** ("start from" option) is what a merchant picks when they onboard a store or create a
new theme. Each base is seeded into the `_library` tenant as a root theme; a store adopts one and
records it via `theme.base_theme_id`, so [base propagation](../base-propagation.ts) can later roll a
base's improvements out to the stores on it.

This folder holds the **theme content** (the four bases today: `forma`, `nova`, `aura`, `atelier`); the
theme **engine** lives one level up in `../` (`bundle`, `theme-compose`, `theme-render`, `theme-store`,
`base-library`, …). Keep that separation — put theme files here, not engine code.

## The shape: each theme is a full standalone directory

Every base is a **complete, self-contained theme** — its own `layout/`, `sections/` (including `header`,
`footer`, `order`), `templates/` (index, collection, product), `config/tokens.json`, and
`assets/base.css`. All four (`forma`, `nova`, `aura`, `atelier`) own every file; they share **nothing**
but the render contract + data shapes (see [`../ARCHITECTURE.md`](../ARCHITECTURE.md)). That's what lets
a theme differ on **every** page — its own header, footer, collection grid, and product page.

Its `*-theme.ts` is a one-line passthrough returning the theme's own files:

```ts
import type { ThemeFiles } from '../bundle';
import { LUXE_THEME_FILES } from './luxe-theme.generated';
export function luxeBundleTheme(): ThemeFiles {
  return { ...LUXE_THEME_FILES };
}
```

> **Optional shortcut (light variant only).** If a theme is truly "Forma with a different home +
> palette" and nothing else, you _may_ ship only its distinctive files and compose over Forma in the
> `*-theme.ts` (`{ ...formaBundleTheme(), ...overrides }`). No current theme does this — prefer a full
> standalone directory unless the duplication really buys nothing.

## Steps to add a base (e.g. `luxe`)

1. **Copy `forma/` to `library/luxe/`** and edit it, page by page. Keep the
   [contract files](../ARCHITECTURE.md#what-every-theme-shares-the-contract-not-the-chrome)
   (`layout/theme.liquid` with its slots; `sections/{header,footer,order}.liquid`;
   `templates/{index,collection,product}.json` + the sections they reference; `config/tokens.json`;
   `assets/base.css`). Design each page however you like — just read the canonical product/collection
   fields and keep the layout slots. Notes:
   - `config/tokens.json` — typography/corners/size. Keys are from the **fixed scales** in
     `../../storefront/storefront.ts` (`FONTS`, `BASE_SIZE`, `RADIUS`, `CONTAINER`). Do **not** set a
     brand colour — that comes from the store and applies on top.
   - `templates/index.json` — keep at least one handle-independent `PRODUCTS` row so a fresh store is
     never empty.
   - `assets/base.css` — the theme's **whole** stylesheet (it ships its own, not a diff).

2. **Add the composer** `library/luxe-theme.ts` — the one-line passthrough shown above.

3. **Register the dir with the generator** — add an entry to the `THEMES` array in
   `scripts/gen-themes.ts`:

   ```ts
   { dir: 'luxe', out: 'luxe-theme.generated.ts', exportName: 'LUXE_THEME_FILES' },
   ```

4. **Bake it:** `npm run gen:themes` → writes `library/luxe-theme.generated.ts` (inline strings, so
   builder-core stays runtime-fs-free). Commit the generated file.

5. **Register the base** in `../base-library.ts`:

   ```ts
   export const LUXE_BASE_THEME_ID = 'library-luxe'; // stable id — see rules below
   // …add to BASE_THEMES:
   { id: LUXE_BASE_THEME_ID, name: 'Luxe', description: 'Understated, high-end — for premium brands.', files: luxeBundleTheme },
   ```

   The picker (onboarding + New-theme dialog) reads `GET /base-themes`, so it appears automatically —
   no admin-web change.

6. **Prettier-ignore the content** — add to `.prettierignore` (theme files are byte-exact, see rules):

   ```
   packages/builder-core/src/theme/library/luxe/
   ```

7. **Test:** the generic pass in `__tests__/base-themes-render.test.ts` renders home/collection/product
   for **every** registered base, so your base is covered the moment it's in `BASE_THEMES`. Run:
   ```
   npm run gen:themes && npm run typecheck && <builder-core tests>
   ```

## Rules & gotchas

- **Ids are permanent.** `library-<name>` is written into every adopting store's `base_theme_id`. Pick
  it once; never rename it. The **display name + description are free** to change anytime.
- **Theme files are byte-exact.** Their bytes are hashed into the base's content version — a change
  bumps the version and **rebases every store on that base**. That's why the content dirs are in
  `.prettierignore` (prettier reformatting = a spurious rebase) and why the generator inlines them
  verbatim. Edit a base's files only when you _intend_ to ship a new base version.
- **A base must be a valid root theme:** `layout/theme.liquid` owns the whole document (`<!doctype …>`),
  and every section referenced by a template exists as a file. The render contract lives in
  `../theme-render.ts`; the generic test enforces it.
- **Merchant Liquid is untrusted** — only the allowlisted filters (`money`, `escape`, `default`) are
  available; escape any merchant/store text.
