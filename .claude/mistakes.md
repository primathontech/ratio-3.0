# Mistakes & Lessons Learned

A running log of non-obvious mistakes made in this repo, so we don't repeat them. Append new entries;
keep each to a line or two with the fix. The deeper rationale lives in `.claude/context/06-gotchas.md`.

- **Filter added to `engine.ts` but not `worker.mjs`** → storefront silently diverges (untrusted Liquid
  renders through the isolate copy). Caused the `asset_url` "undefined filter" and the money-100× bug.
  Fix: mirror every filter in both engines + the parity test.
- **Saved a partial file set via `saveOverrides`** → it deleted every omitted base file (`_deletes`), so
  the theme lost `layout/theme.liquid` and couldn't publish/render. Fix: always save the full composed
  tree (scaffold/GET → edit on top → save).
- **Used `productLimit` on a `PRODUCTS` dataSource** → ignored by `getProducts` (COLLECTION-only field),
  returned the backend default of 20. Fix: use `first`.
- **Enforced a new invariant unconditionally before the feature flag / migration** → would block
  existing stores on an old base before they're rebased. Fix: gate on the feature flag so it activates
  with the rollout, after the migration.
- **Ran only root `bun run typecheck`** → CI still failed on admin-web's stricter separate typecheck.
  Fix: `cd apps/admin-web && npx tsc --noEmit` when admin-web changes.
- **S3-dependent test not gated on `BUNDLE_S3_ENDPOINT`** → failed in CI (no MinIO). Fix: `{ skip }` gate.
