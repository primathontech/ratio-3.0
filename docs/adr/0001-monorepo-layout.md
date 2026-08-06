# ADR-0001: Monorepo layout

**Status:** accepted (2026-08-06)

## Context

The workspace had grown two inconsistent conventions: some packages were flat
(`packages/theme`), others nested under grouping folders (`packages/data/shared`),
and package names disagreed with their paths in different ways (`data/*` dropped the
prefix → `@ratio/repo`, while `edge/*` kept it → `@ratio/edge-core`). Deployables lived
in a separate `services/` tree that weren't workspace packages, and the `edge` concern
was split across `packages/edge/*` (libs) and `services/edge-*` (deploy adapters). Env
was read ad-hoc inside a shared library. The result was hard to navigate ("package inside
package") and hard to reason about.

## Decision

**Two buckets, flat, one naming rule.**

```
packages/   libraries                 apps/   deployables (each a workspace package)
  data-db                               origin        @ratio/origin
  data-repo                             admin-api     @ratio/admin-api
  data-provisioning                     edge          @ratio/edge
  edge-core                             admin-web     @ratio/admin-web
  builder-core
  builder-registry
  builder-render
  theme
  control-plane-client
```

1. **`packages/<x>` ⇒ `@ratio/<x>`** — every workspace package is a direct child of
   `packages/` or `apps/`; its npm name is `@ratio/<folder>`. No grouping folders, no
   nesting, no name/path mismatch.
2. **`packages/` = libraries, `apps/` = things you deploy.** `services/` is removed;
   origin, admin-api, and the edge worker move under `apps/` and become real workspace
   packages. The local run harness stays at root `dev/`.
3. **`page-builder-*` → `builder-*`.** `builder-render` stays its own package — it is the
   sandboxed untrusted-template engine and that boundary is deliberate.
4. **Every package + app contains:** `README.md`, `ARCHITECTURE.md`, `CHANGELOG.md`,
   `.env.example`. For a library (no env of its own) the `.env.example` is a one-line stub
   noting it is configured by the consuming app.
5. **No `process.env` inside `packages/`.** Configuration is the app's job: each app reads
   the environment once at its composition root (`config.ts`) and injects typed config into
   libraries (e.g. `createDb(connectionString)`). Libraries never touch `process.env`.
   _(Implemented in PR 2 — see below.)_

## Removed

- `services/` (contents moved to `apps/`).
- `packages/edge/provider` — a CF/Akamai provider abstraction that was never wired
  (stubs only; the real Cloudflare logic lives in `apps/admin-api/domains.ts`).
- **Akamai** entirely — no longer in scope (CDN is Cloudflare; see the CDN decision).

## Rollout

- **PR 1 (structure):** deletions above; flatten + rename; move services→apps; rewrite
  every `@ratio/*` import, tsconfig paths, and workspace globs; scaffold the four required
  files per package. Behaviour-preserving; tests stay green.
- **PR 2 (config injection):** apps get `config.ts`; `@ratio/data-db` exposes
  `createDb(url)`; delete the library env reader; inject config everywhere so no package
  reads `process.env`.

## Consequences

- One rule to place or find a package; the tree is self-describing.
- Larger one-time import churn (a dedicated PR), but no behaviour change.
- `apps/*` gain `package.json`, so tooling (typecheck/lint/test) is uniform across the graph.
