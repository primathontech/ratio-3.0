# Rule: Testing

## When a bug is reported

1. **Reproduce it with a failing test FIRST** (red).
2. Only then fix the code.
3. The test must fail before the fix and pass after. This is enforced hard on this repo.

## When adding a feature

- Test the happy path + at least one edge case. Deterministic — no flaky time/network dependencies.

## Real infra, not mocks

- Tests run against a **real Postgres** (docker, port **5433**, db `s2poc_test`) and **real MinIO**
  (S3, port 9000). **Do NOT mock the database.** Reason: mocks drift from reality; we want to catch
  schema/migration/bundle breakage.
- **Mock external services** (network/APIs — e.g. GoKwik). Anything hitting the live GoKwik backend is
  a **manual** verification, not a committed test (it would be flaky); a committed guard mocks GoKwik.
- Don't test framework internals or re-assert what the code literally does.

## Runners & the incantation

- Most packages/apps: **`node:test`**. `admin-web`: **vitest**. Don't mix them.
- `node:test` runs need `--import ./tests/bootstrap.ts` (it calls `configureDb` from `DATABASE_URL`) or
  the pool throws "configureDb must be called".
- **Gate MinIO-dependent tests on `BUNDLE_S3_ENDPOINT`** (skip when unset) — CI has no MinIO. Pattern:
  `const skip = process.env.BUNDLE_S3_ENDPOINT ? false : 'set BUNDLE_S3_ENDPOINT'; test(name, { skip }, …)`.
- The origin/admin-api render in-process via `app.fetch(new Request(...))` — no server needed.
  Storefront requests need `x-edge-auth: resolveEdgeSecret(process.env)` + `x-ratio-tenant`.

See `.claude/skills/run-tests/SKILL.md` for the copy-paste command.

## Writing the test — quality rules ("Iron Rules")

Write tests that fail for the right reason and can't rot into false confidence:

- **Mock at the boundary, not the internals.** Mock the external service (GoKwik/network) at its client
  seam; never mock our own DB/ThemeStore — use the real test DB + MinIO.
- **Assert specific values, not truthiness.** `assert.equal(x, 8)` beats `assert.ok(x)`. A test that
  passes for `null`, `0`, and `undefined` guards nothing.
- **Two-sided assertions.** Assert both what changed AND what must NOT (e.g. the edit shows AND the old
  value is gone; the body-only theme is rejected AND the live pointer didn't move).
- **Cover branches, not just lines.** Each conditional/error path gets a case, not just the happy line.
- **Isolate.** Unique tenant/theme ids per test; clean up in before/after; no shared mutable state; no
  order dependence. Reset any `process.env` flag you set (in a `finally`).
- **Deterministic.** No real clock/network/random. A test that hits live GoKwik is manual, not committed.
- **No tautologies / snapshot-only tests.** Don't re-assert what the code literally does or snapshot a
  blob nobody reads. The test must encode the _intended behavior_.
- **Guard the exact thing.** If the risk is "wrong param name silently ignored", assert the param sent
  (e.g. `first === 8`), not just that some products came back.

## Before declaring done

1. Run the touched test file(s) — see them pass.
2. `bun run typecheck` — and `cd apps/admin-web && npx tsc --noEmit` if you touched admin-web (root
   tsconfig **excludes** `apps/admin-web`, so root typecheck skips it; its `tsc` is a separate CI job).
3. Do not say "fixed" / "done" until you've seen green.
