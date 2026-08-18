# 3 — Local Dev & Testing

## Prerequisites

- **Docker** (for Postgres + MinIO), **bun**, **node 22+**. TypeScript runs via `tsx` (no build step
  for dev/tests).
- Copy `.env.example` → the per-app `.env` files it documents (`apps/origin/.env`, `apps/admin-api/.env`).
  ⚠️ **Never read/echo `.env` contents** (secrets). The example file lists the keys.

## Local infrastructure (docker-compose)

`bun run db:up` starts:

| Service     | Container     | Host port                      | Creds (local, throwaway)           |
| ----------- | ------------- | ------------------------------ | ---------------------------------- |
| Postgres 16 | `s2poc-db`    | **5433** (→5432)               | user `poc` / pass `poc` / db `poc` |
| MinIO (S3)  | `s2poc-minio` | **9000** (API), 9001 (console) | `poc` / `poc12345`                 |

`bun run db:down` tears them down (`-v`, wipes volumes).

## Databases

- `poc` — the default dev database.
- `s2poc_test` — the **test** database (migrated separately; `scripts/ensure-test-db.ts`). Tests use it.
- The deployed/running dev stack may point `DATABASE_URL` at a different DB (in `.env`); don't assume
  a store you see in the app is in `poc`/`s2poc_test`.

## Run the whole stack

```bash
bun run db:up          # postgres + minio
bun run db:init        # run migrations (bun run migrate)
bun run dev            # dev/all.ts → edge :8080, origin :9090, admin-api :8787, admin-web :5173
```

The dev servers load their own `.env` (via `--env-file-if-exists`). `RATIO_LOCAL=true` flips local-mode
behavior. To render a store locally, hit the edge with the store override:
`http://localhost:8080/?store=<tenantId>`.

Other useful scripts: `bun run onboard` (onboard a store), `bun run reset:local` (reset local state),
`scripts/rebase-to-latest-base.ts` (migrate stores onto the latest base — dry-run by default, `--apply`).

## Testing — the canonical incantation

Tests use **`node:test`** against a **real** Postgres + MinIO (no DB mocks). The runner needs
`DATABASE_URL` set and the test-bootstrap import (which calls `configureDb`). The `tests/bootstrap.ts`
hook is required — without it the pool throws "configureDb must be called".

Full suite:

```bash
# The scripts default DATABASE_URL to :5432 — point them at the docker DB (:5433) for local runs:
export TEST_DATABASE_URL="postgres://poc:poc@localhost:5433/s2poc_test"
bun run test          # test:setup (typecheck + ensure test DB + migrate) then the node:test run
```

Run a single file / subset (what you'll do most while iterating). Note the env: **DB on 5433**, MinIO
on 9000, both with the `poc` creds:

```bash
DATABASE_URL="postgres://poc:poc@localhost:5433/s2poc_test" \
BUNDLE_S3_ENDPOINT="http://localhost:9000" \
BUNDLE_S3_BUCKET="s2poc-test" BUNDLE_S3_KEY="poc" BUNDLE_S3_SECRET="poc12345" \
node --import tsx --import ./tests/bootstrap.ts --test \
  apps/admin-api/src/__tests__/theme-multi-api.test.ts
```

- **MinIO-gated tests** skip cleanly when `BUNDLE_S3_ENDPOINT` is unset (CI without MinIO stays green) —
  follow this pattern (`const skip = endpoint ? false : '...'`, `test(name, { skip }, ...)`) for any
  test that needs S3.
- The origin renders in-process via `app.fetch(new Request(...))` — no server needed. Storefront tests
  pass `x-edge-auth: resolveEdgeSecret(process.env)` + `x-ratio-tenant`.

## Typecheck — root is NOT enough

- `bun run typecheck` (root `tsc --noEmit`) is the baseline.
- **Root `typecheck` EXCLUDES `apps/admin-web`** (root `tsconfig.json` `exclude: ["apps/admin-web"]`), so
  it doesn't type-check admin-web at all — admin-web has its OWN `tsc` (run separately in CI as the
  `admin-ui` job). Run `cd apps/admin-web && npx tsc --noEmit` when you touch admin-web.
- CI has **no MinIO** — bundle/storefront-render tests must be gated on `BUNDLE_S3_ENDPOINT` or they'll
  fail there.
- `admin-web` tests use **vitest** (`npx vitest run <file>`), not `node:test`.

## "Green" before you say done

1. Run the touched test file(s) — see them pass.
2. `bun run typecheck` (+ admin-web tsc if relevant).
3. For a bug fix: the reproducing test must have been **red before**, green after.
