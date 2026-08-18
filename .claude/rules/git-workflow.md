# Rule: Git & PR Workflow

Non-negotiable. These override convenience.

## Approval

- **NEVER `git commit` or `git push` without the user's explicit approval.** The flow is: write → run
  tests → show the diff → ask. Approval for one commit is not approval for the next.

## Staging

- **NEVER `git add -A` / `git add .`.** Stage specific paths only — the working tree may hold another
  person's uncommitted WIP that would be swept into your commit.

## Branching

- Branch off **`main`** (this is the PR target; there is **no `dev`** branch on the remote
  `ratio-3.0-cloudflare`, despite some tooling defaulting to it). Never edit the working tree while on
  `main` — branch first.
- Branch names: `feat/<name>`, `fix/<name>`, `test/<name>`, `chore/<name>`, `docs/<name>`,
  `refactor/<name>`.

## Commits

- Conventional commits: `type(scope): subject`. Short imperative subject; body explains WHY, not WHAT.
- Every commit leaves the branch buildable + tests green.
- End commit messages with the co-author trailer used across recent history:
  `Co-Authored-By: Claude <noreply@anthropic.com>`.

## PRs

- **Self-review before handoff.** Run the code review (the `code-reviewer` agent), fix findings, and
  loop until a review pass returns zero _blocking_ comments — one pass is never enough (each fix can add
  a new issue). Only then ask for merge.
- PR body: what / why / verification (which suites you ran green + typecheck). Keep it plain English.
- The user merges fast: **land all commits before saying "ready", or verify the PR is still OPEN**
  before pushing follow-ups, or they strand.
- Merge with `gh pr merge <n> --squash --delete-branch`, then `git checkout main && git pull` and
  delete the local branch.

## Outward / irreversible actions

Confirm before anything hard to reverse or outward-facing (merges to shared branches, deletes,
deploys). Sending content to an external service publishes it — treat as irreversible.
