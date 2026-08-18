---
name: run-tests
description: Use when running or writing tests in this repo, so they hit the real Postgres + MinIO with the right env, runner, and gating instead of failing on missing bootstrap/DB/S3.
---

# Run Tests (Ratio 3.0)

Tests run against **real** infra — Postgres (docker :5433, db `s2poc_test`) + MinIO (S3, :9000). No DB
mocks. Get the env right and they pass; get it wrong and they throw obscure "configureDb"/S3 errors.

## Prereqs

```bash
bun run db:up            # start Postgres + MinIO (once)
bun run test:setup       # typecheck + ensure test DB + migrate  (or: bun run test for the full suite)
```

> ⚠️ The `bun run test` / `test:setup` / `test:coverage` scripts default `DATABASE_URL` to
> `postgres://localhost:5432/s2poc_test` — that's **5432**, not the docker **5433**. Against local docker,
> export `TEST_DATABASE_URL="postgres://poc:poc@localhost:5433/s2poc_test"` first, or just use the
> single-file command below (which sets 5433 explicitly).

## Single file / subset (what you do while iterating)

`node:test` for packages + admin-api + origin + edge. The env is mandatory — DB on **5433**, MinIO on
9000, both `poc` creds, and the **bootstrap import** (calls `configureDb`):

```bash
DATABASE_URL="postgres://poc:poc@localhost:5433/s2poc_test" \
BUNDLE_S3_ENDPOINT="http://localhost:9000" BUNDLE_S3_BUCKET="s2poc-test" \
BUNDLE_S3_KEY="poc" BUNDLE_S3_SECRET="poc12345" \
node --import tsx --import ./tests/bootstrap.ts --test \
  apps/admin-api/src/__tests__/theme-multi-api.test.ts
```

Pipe through `grep -E "not ok|# (tests|pass|fail|skipped)"` for a compact result. Filter noisy origin
logs with `grep -vE '"lvl"|"evt"|"svc"|gokwik'`.

## admin-web (different runner)

```bash
cd apps/admin-web && npx vitest run src/features/onboarding/featured.test.ts
cd apps/admin-web && npx tsc --noEmit        # root typecheck EXCLUDES admin-web; this is its own check (admin-ui CI job)
```

## Gotchas

- **Missing `--import ./tests/bootstrap.ts`** → `@ratio/data-db: configureDb(...) must be called`.
- **CI has no MinIO** — any S3-dependent test must be gated: `const skip = process.env.BUNDLE_S3_ENDPOINT
? false : 'set BUNDLE_S3_ENDPOINT'; test(name, { skip }, …)`. Without the gate it fails CI.
- Test DB is **`s2poc_test` on 5433**, not `poc` and not 5432.
- Origin/admin-api render in-process via `app.fetch` — no running server needed. Storefront requests
  need `x-edge-auth: resolveEdgeSecret(process.env)` + `x-ratio-tenant`.
- Root `bun run typecheck` is NOT enough — run admin-web's tsc too when you touch it.
