# Theme system architecture

This explains how base themes, stores, and rendering fit together — and answers the common question:
**"if Nova extends Forma, are the themes really separate?"**

> **Yes. Each base theme is a complete, self-contained theme at runtime.** "Extends Forma" happens only
> in the _source_, at build time, to avoid copy-pasting shared chrome. The built output is a full theme.

There are **two different composition steps** that are easy to conflate. Keep them apart:

|          | Layer A — author-time                                | Layer B — runtime                                         |
| -------- | ---------------------------------------------------- | --------------------------------------------------------- |
| What     | `novaBundleTheme() = { ...forma, ...novaOverrides }` | `store live theme = base@version ⊕ store edits`           |
| When     | when we author/generate a base's SEED                | on every storefront render, per store                     |
| Purpose  | DRY source — don't duplicate shared chrome           | multi-tenant lineage — a store keeps only its diffs       |
| Result   | a **complete** ThemeFiles set (all files)            | the store's **full** composed page                        |
| Coupling | Nova's _source_ reads Forma's _source_               | a store tracks its base by `base_theme_id`/`base_version` |

```mermaid
flowchart LR
  subgraph A["Layer A — author-time (source → seed)"]
    forma[forma/ files] --> compose1["{...forma, ...novaOverrides}"]
    novaSrc[nova/ distinctive files] --> compose1
    compose1 --> full["novaBundleTheme() = COMPLETE theme"]
    full --> seed[(library-nova @v1<br/>in _library tenant)]
  end
  subgraph B["Layer B — runtime (base + store overrides)"]
    seed -. adopted by .-> store
    store[store theme<br/>base_theme_id=library-nova] --> composeR["composeTheme(base@v, overrides)"]
    edits[store's own edits] --> composeR
    composeR --> live["live compiled page"]
  end
```

---

## Layer A — how a base is built and seeded (author-time)

`forma/` is the **full flagship** theme (every file). `nova` / `aura` / `atelier` ship **only the files
that differ** and are composed over Forma in code, so shared chrome (header, footer, layout, collection
& product pages) isn't duplicated across four folders. The composed **output is still a complete root
theme** — it has all of Forma's files plus the theme's own.

```mermaid
flowchart TD
  subgraph src["src/theme/library/ (editable source)"]
    fdir["forma/  (full theme:<br/>layout, sections, templates, config, assets)"]
    ndir["nova/  (distinctive only:<br/>tokens, index.json, nova-hero, tiles, nova.css)"]
  end
  fdir -->|gen:themes| fgen[forma-theme.generated.ts<br/>FORMA_THEME_FILES]
  ndir -->|gen:themes| ngen[nova-theme.generated.ts<br/>NOVA_THEME_FILES]
  fgen --> fcomp["formaBundleTheme() → full set"]
  fcomp --> ncomp
  ngen --> ncomp["novaBundleTheme():<br/>{ ...forma, ...novaFiles,<br/>base.css = forma.css + nova.css }"]
  ncomp --> reg["BASE_THEMES registry (base-library.ts)"]
  fcomp --> reg
  reg -->|ensureSeededBaseById| lib[("_library tenant<br/>library-default @v1 (Forma)<br/>library-nova @v1 (Nova)<br/>…")]
```

Key points:

- **The seed is a snapshot.** `ensureSeededBaseById('library-nova')` publishes v1 = the _full_ composed
  file set. From then on it's **seed-only**: later changes to Forma's code never silently clobber an
  already-seeded base (see `base-library.ts`).
- **So each seeded base is independent at runtime** — `library-nova @v1` physically contains every file
  it needs. It does **not** reach back to Forma to render.
- The only cross-theme link is at the _source_ level: `novaBundleTheme()` calls `formaBundleTheme()`.
  That's the DRY shortcut, nothing more.

---

## Layer B — how a store uses a base (runtime base ⊕ overrides)

This is the multi-tenant part, and it's a **different** mechanism from Layer A. A store **adopts** one
base and stores only its own edits; the base is referenced by id + version.

```mermaid
flowchart LR
  pick["merchant picks a base<br/>(onboarding / new theme)"] --> adopt
  adopt["ensureTheme(tenant, themeId,<br/>base = {library-nova, v1})"] --> row["theme row:<br/>base_theme_id = library-nova<br/>base_version = 1"]
  row --> edits["store edits a few files<br/>(saved as OVERRIDES only)"]
  edits --> render["origin render:<br/>composeTheme(base source, overrides)"]
  render --> page["full page served"]
```

- A store's **draft = only the files it changed**. Files it didn't touch come from the base.
- `composeTheme(base, overrides)` (see `theme-compose.ts`) merges them at read time; the store's **live
  compiled** theme (`loadLiveCompiled`) is the complete page. Nothing is missing — untouched files fall
  through to the base.
- This is why a store can pull a **base improvement** later without losing its edits → propagation.

### Render path (origin)

```mermaid
sequenceDiagram
  participant Edge
  participant Origin
  participant DB as Postgres
  participant Obj as Object store
  Edge->>Origin: request (cache miss, proxied)
  Origin->>DB: live_theme_id / version for tenant
  Origin->>DB: theme.base_theme_id / base_version
  Origin->>Obj: base source (library-nova @v1) + store overrides
  Origin->>Origin: composeTheme(base, overrides) → render Liquid
  Origin-->>Edge: full HTML page
```

### Propagation (improve a base, roll it into its stores)

Because every store records which base + version it tracks, improving a base is a version bump the
stores can pull in — keeping their own edits (only files they didn't override advance).

```mermaid
flowchart LR
  editbase["platform admin edits<br/>library-nova → publishes v2"] --> plan["planBaseRebase(library-nova)"]
  plan --> targets["stores with base_theme_id=library-nova<br/>and base_version < 2"]
  targets --> apply["applyBaseRebase → each store<br/>base_version 1 → 2 (edits kept)"]
  apply --> purge["edge purge → new page served"]
```

Note this scopes **per base** (`WHERE base_theme_id = $1`) — a Nova improvement only touches Nova stores,
never Aura/Atelier/Forma stores.

---

## "Are the themes separate?" — the precise answer

- **At runtime: fully separate.** Each seeded base is a complete root theme; each store renders from its
  own adopted base @version ⊕ its own edits. Forma is not consulted when rendering a Nova store.
- **At source: Nova/Aura/Atelier share Forma's chrome by composition.** This is a deliberate DRY choice:
  fix the footer once in `forma/`, and every theme that doesn't override it gets the fix at its next
  seed. A theme diverges by dropping its own file in its dir (it wins over the inherited one).
- **You never get "missing" files.** Composing over Forma makes a theme a _superset_ — it inherits every
  shared file and adds its own. The failure mode is the opposite (inheriting a shared section you don't
  use), which is harmless (unused sections don't render).

### If you want themes fully independent in _source_ too

That's a valid alternative: make each theme a **full directory** (its own copy of every file, like
`forma/`), and have its `*-theme.ts` just return its own files (no `...forma`). Trade-off:

- ➕ Zero source coupling — editing Forma never affects another theme, even before seeding.
- ➖ Shared chrome is duplicated ×N; a shared bug (footer, PDP, cart) must be fixed in every theme.
- ⚖️ Runtime behaviour is **identical** either way (both produce a complete seeded theme).

Current choice is **compose-over-Forma** because the four bases share ~90% chrome and differ mainly in
home layout + tokens. If a theme grows to diverge everywhere, promote it to a full directory. See
[`library/README.md`](./library/README.md) for the how-to.
