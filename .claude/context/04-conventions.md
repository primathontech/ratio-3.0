# 4 — Conventions & Workflow

These are the rules that keep code fitting the codebase and getting merged. Most come from hard-won
experience on this repo.

## Coding style

- **Minimum-change principle.** Touch only what the task requires. No refactoring neighboring code
  "while you're there", no speculative abstractions, no backwards-compat shims unless asked. Three
  similar lines beat a premature helper.
- **Comments explain WHY, not WHAT.** Default to no comments; names carry the _what_. Comment only a
  non-obvious constraint, workaround, or invariant. Never write comments referencing a ticket/PR/flow
  ("added for X") — they rot. (The existing code is comment-dense with _why_-comments — match that when
  the why is genuinely non-obvious, e.g. the theme-store transaction/locking notes.)
- **Keep files small and focused — enforced.** New component → its own file. Prefer editing existing
  files over creating new ones; don't create README/docs unless asked. A **`max-lines` ESLint rule
  (error, 400 code-lines)** blocks a commit when a source file grows too big — when you hit it, **split
  by concern (see Module structure below), never disable the rule.** (Tests + generated files are
  exempt; `theme-store.ts` is the one documented exception — a cohesive class.)
- **Errors:** validate at system boundaries (user/AI input, external APIs); trust internal code. Don't
  wrap everything in try/catch. Let unexpected errors crash loudly in dev. Infra faults should bubble
  to `onError` (→ 500 + logged), never be dressed up as a user-content 400.
- **No stray `console.log` / debug prints** in committed code. Use the observability logger or remove.

## Module structure (no monoliths)

Server apps keep a **thin composition root** that only wires things; the actual logic lives in
per-domain modules. This is how `admin-api`'s `app.ts` (once 1616 lines) and `origin`'s `index.ts` are
structured — follow them as the template rather than growing a new monolith:

- **admin-api** — `app.ts` builds a `deps` object + middleware, then calls `registerXRoutes(app, deps)`
  from `routes/<domain>.ts` (`routes/themes/{bundle,assets,multi}.ts`, `routes/stores.ts`, …). Shared
  singletons flow through `RouteDeps` (`routes/deps.ts`); guards/package code are imported directly.
  Support code sits in `middleware/` (auth, audit, idempotency, …) and `services/` (domains, assistant,
  …). `__tests__/` mirrors that layout.
- **origin** — `index.ts` holds boot effects + the order-sensitive `app.all('*')` dispatch ladder; each
  branch body is a `handleX(c, deps)` in `handlers/<domain>.ts`, deps threaded as params (one-directional
  imports, no cycles).

Rule of thumb: a route/handler file grouping one domain, a composition root that only registers +
wires. When adding a new area, add a module + register it — don't inline it into the root.

## Container/presentational UI pattern (admin-web)

Default architecture: **one logical container** owns state + handlers and renders via multiple **dumb
presentational components**, each in its own file. Follow the existing editor structure
(`features/theme/theme-editor.tsx` container + `code-editor.tsx`, `editor-*.tsx`, `theme-card.tsx`, …).

## Testing rules

- **Bug reported → reproduce with a failing test FIRST**, then fix. The test must fail before, pass
  after. (This is enforced hard on this project.)
- **Feature → test the happy path + at least one edge case.** Deterministic; no flaky time/network.
- **Mock external services (network/APIs — e.g. GoKwik), NOT the database.** Use the real test DB +
  MinIO. Reason: mocks drift; we want to catch schema/migration/bundle breakage. Anything that hits the
  live GoKwik backend is a _manual verification_, not a committed test (it'd be flaky) — a committed
  guard mocks the backend.
- Don't test framework internals or re-assert what the code literally does.

## Git & PR workflow (strict)

- **NEVER `git commit` / `git push` without the user's explicit approval.** Write → test → show the
  diff → ask. This is absolute.
- **NEVER `git add -A`.** Stage specific paths — the working tree may hold others' uncommitted WIP.
- **Branch off `main`** for new work (there's no `dev` on the remote; PRs target `main`). Commit
  messages end with the `Co-Authored-By: Claude ...` trailer used across recent commits.
- **Self-review before handoff:** run the code-review (the `code-reviewer` agent / your own pass) and
  fix findings **before** asking for merge. Loop until a review pass returns zero _blocking_ comments —
  one pass is never enough; each fix can add a new issue.
- The user merges PRs fast — **land all commits before saying "ready", or check the PR is still OPEN**
  before pushing follow-ups (they can strand otherwise).
- Merge via squash (`gh pr merge <n> --squash --delete-branch`), then sync `main` + delete the local
  branch.

## Jira / Story points

- Every ticket you create goes in the **active sprint** and gets **Original Story Points**
  (`customfield_10455`, "without-AI" estimate) at create time; the actual **Story Points**
  (`customfield_10016`, "with-AI") are set when the ticket is **Done**. Board convention: **1 day = 1 SP**.
  A **deferred** ticket (explicitly "not now") stays in the backlog, not the active sprint.
- Every created ticket needs a label. `Done` transition id is `31`.

## Decision priority (architecture)

When a design trade-off arises, decide **cost → performance → AI**, in that strict order. The "current
system" behavior is a checklist, not a driver — don't preserve legacy behavior just because it exists.

## Environment posture

- **Staging, not prod, no real traffic** — move fast, don't over-engineer production caution. (This is
  a genuine directive on this project, not laziness.)
- **Build the product, not a POC.** Even for phased/P0 work, build the full production-grade feature;
  the end-to-end proof is the acceptance bar, not the scope ceiling. Don't ship permanent
  "fallback/safety-net" hedges when the right move is an enforced invariant + migration.

## Writing style

Plain, simple (Indian) English in docs, replies, and PR descriptions. Lead with a recommendation and
act; don't end a turn on an open A/B question when a sensible default exists.

## Secrets

Never hardcode API keys/tokens/passwords/connection strings. Never read, log, or echo `.env`. Config is
referenced by env-var **name**; values live in `.env` (local) or CI repo variables (deployed). If you
find a secret in the code, stop and flag it.
