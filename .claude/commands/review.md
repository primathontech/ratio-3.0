---
description: Self-review the current branch's diff with the code-reviewer + adversarial-reviewer agents (two independent perspectives, in parallel), loop until clean, and report a merge verdict.
argument-hint: [base-branch]
---

# /review — self-review before handoff

Run the repo's mandatory self-review on the current branch. Do NOT create a PR or merge here — this
only produces the verdict.

## Step 1 — Resolve the base

Use `$ARGUMENTS` as the base branch if given; else default to **`main`** (this repo's PR target — there
is no `dev` on the remote). State the resolved base in one line.

## Step 2 — Confirm there's a diff

`git diff <base>...HEAD --name-only`. If empty: print "No changes vs <base>. Nothing to review." and stop.
Show `git diff <base>...HEAD --stat | tail -1` as a one-line header.

## Step 3 — Review (two independent perspectives, in parallel)

Spawn **both** reviewers on the diff in the SAME message (parallel Task calls) so they run with
independent, fresh context:

- **`code-reviewer`** (`.claude/agents/code-reviewer.md`) — the structured checklist pass (ratio
  invariants: two-engine parity, `saveOverrides`, `first` vs `productLimit`, MinIO/CI gating,
  theme-ownership, tenant isolation) + Security-risk + Coverage tables.
- **`adversarial-reviewer`** (`.claude/agents/adversarial-reviewer.md`) — the attacker/on-call lens; it
  never sees the structured reviewer's output.

Then **merge + dedupe** (same file within ~3 lines = one finding) and keep only findings with a concrete
trigger→consequence (a **>80% confidence gate**: trigger + consequence + fix, or drop it). Route a
genuinely uncertain finding or a deliberate graceful-degradation trade-off to the user via
**AskUserQuestion** rather than asserting it as a defect.

## Step 4 — Fix and loop

Fix every blocking (High/Medium) finding. Re-run the review after fixing — **one pass is never enough**;
a fix can introduce a new issue. Loop until a pass returns zero blocking findings. Leave only Low/
informational findings you can justify, and state the justification.

## Step 5 — Verdict

Before declaring clean, confirm: touched test file(s) green (a bug-fix test was red before), `bun run
typecheck` clean (+ admin-web `tsc` if it changed). Then print a one-line verdict: **safe to merge**,
**fix-then-merge** (with the remaining items), or **blocked**.

Handoff to the `ship-pr` skill for the commit → PR → merge flow (which requires explicit user approval).
