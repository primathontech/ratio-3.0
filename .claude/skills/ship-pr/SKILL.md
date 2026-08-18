---
name: ship-pr
description: Use to take a finished change from working tree to a merged PR the Ratio 3.0 way — test, self-review-until-clean, get approval, branch off main, commit specific paths, PR into main, merge.
disable-model-invocation: true
---

> Explicit-invocation only (`/ship-pr` or a direct request) — shipping is a deliberate act, never
> auto-triggered mid-work. Committing, pushing, and merging each require the user's explicit approval.

# Ship a PR (Ratio 3.0)

The disciplined path from "code works" to "merged", following this repo's non-negotiables.

## 1. Prove it green (before anything else)

- Run the touched test file(s) — see them pass. For a bug fix, the reproducing test must have been red
  before the fix. (See the `run-tests` skill.)
- `bun run typecheck` (+ `cd apps/admin-web && npx tsc --noEmit` if admin-web changed).

## 2. Self-review until clean

- Run the `code-reviewer` agent on the diff. Fix every blocking finding.
- **Loop** — re-review after fixes; one pass is never enough (a fix can add a new issue). Continue until
  a pass returns zero blocking comments. Leave only findings you can justify (note why).

## 3. Get approval, then commit

- **NEVER commit/push without the user's explicit approval.** Show the diff and ask.
- Branch off `main` (there is no `dev` remote): `git checkout -b feat/<name> main`.
- Stage **specific paths** — never `git add -A` (someone's WIP could be swept in).
- Conventional commit; body explains WHY; end with a `Co-Authored-By:` trailer for Claude (recent
  history uses `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`).

## 4. Open the PR (base `main`)

```bash
git push -u origin <branch>
gh pr create --base main --head <branch> --title "<type(scope): subject>" --body "<what / why / verification>"
```

PR body: what changed, why, and verification (which suites ran green + typecheck). Plain English.

## 5. Merge (on approval) + clean up

```bash
gh pr merge <n> --squash --delete-branch
git checkout main && git pull --ff-only origin main
git branch -d <branch>
```

## Notes for this repo

- The user merges fast — land all commits before saying "ready", or confirm the PR is still OPEN before
  pushing a follow-up (else it strands).
- Pre-commit lint (husky) reformats staged files — expect a prettier pass on commit; re-read before
  further edits.
- Update Jira on merge only when the work actually completes a story (not for prep steps). Deferred
  tickets stay in the backlog, not the active sprint.
