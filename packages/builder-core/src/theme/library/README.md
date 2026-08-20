# Base themes — how to add one

A **base theme** ("start from" option) is what a merchant picks when they onboard a store or create a
new theme. Each base is seeded into the `_library` tenant as a root theme; a store adopts one and
records it via `theme.base_theme_id`, so [base propagation](../base-propagation.ts) can later roll a
base's improvements out to the stores on it.

This folder holds the **theme content** (the four bases today: `forma`, `nova`, `aura`, `atelier`); the
theme **engine** lives one level up in `../` (`bundle`, `theme-compose`, `theme-render`, `theme-store`,
`base-library`, …). Keep that separation — put theme files here, not engine code.

## The pattern: compose over Forma

`forma/` is the **full flagship theme** — a complete set of files (layout, sections, templates, config,
assets). `nova`, `aura`, `atelier` ship **only their distinctive files** and are composed over Forma at
build time, so the shared chrome (header/footer/layout, collection + product pages) isn't duplicated.
Prefer this — only author a full theme if it genuinely diverges everywhere.

## Steps to add a base (e.g. `luxe`)

1. **Create the content dir** `library/luxe/` with just the files that differ from Forma:
   - `config/tokens.json` — typography/corners/size. Keys come from the **fixed scales** in
     `../../storefront/storefront.ts` (`FONTS`, `BASE_SIZE`, `RADIUS`, `CONTAINER`):
     ```json
     {
       "bodyFont": "serif",
       "headingFont": "serif",
       "baseSize": "m",
       "radius": "square",
       "container": "normal"
     }
     ```
     Do **not** set a brand colour here — that comes from the store, and applies on top of your tokens.
   - `templates/index.json` — the home composition: a `dataSources` map + a `sections` list. Reuse
     shared sections (`collection-row`, `brand-story`) and/or your own. Keep at least one
     handle-independent `PRODUCTS` row so a fresh store is never empty.
   - `sections/<your-section>.liquid` — any **new** section types your home references (e.g.
     `sections/luxe-hero.liquid`). Every `type` in `index.json` must resolve to a section file
     (shared ones live in `forma/sections/`; yours live here).
   - `assets/luxe.css` — styles for your sections. This is **appended to** the shared `base.css` by the
     composer (see next step); don't restate the shared classes.

2. **Add the composer** `library/luxe-theme.ts` (copy `nova-theme.ts`):

   ```ts
   import type { ThemeFiles } from '../bundle';
   import { formaBundleTheme } from './forma-theme';
   import { LUXE_THEME_FILES } from './luxe-theme.generated';

   export function luxeBundleTheme(): ThemeFiles {
     const base = formaBundleTheme();
     const { 'assets/luxe.css': extraCss, ...overrides } = LUXE_THEME_FILES;
     return {
       ...base,
       ...overrides,
       'assets/base.css': `${base['assets/base.css']}\n${extraCss ?? ''}`,
     };
   }
   ```

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
