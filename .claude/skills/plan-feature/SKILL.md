---
name: plan-feature
description: Use before writing code for a non-trivial feature/fix in this repo — to plan first (ground in the existing codebase, pick an approach, confirm) instead of coding blind. Especially for anything touching the render/theme path, migrations, auth, or commerce.
---

# Plan a Feature (Ratio 3.0)

A plan-before-code gate. The goal is a short, grounded plan the user confirms before implementation —
not a code dump. Skip this only for trivial, obvious, single-file changes.

## Workflow

1. **Pin the intent.** Restate the goal in one or two sentences: what changes for whom, and the
   completion criteria (how we'll know it's done) + what would prove failure. If the request is
   ambiguous, ask — one focused question at a time, not a wall of questions.

2. **Ground it in the codebase (don't guess).** Use an `Explore` subagent (or Grep/Read) to find the
   nearest existing pattern in the same area and reuse it — "extend before inventing." For theme/render
   work, read `.claude/context/05-theme-system.md` + `06-gotchas.md` first. Identify the exact files to
   touch and the seam the change belongs at (route boundary vs primitive — see security rule).

3. **Weigh 2–3 approaches** when the solution space is wide; state the trade-off using the repo's
   decision priority (**cost → performance → AI**). Recommend one. Note migration/rollout risk and
   whether a feature flag or backfill is needed (the theme-ownership go-live is the model: migrate →
   enforce → flip). For an architecturally significant change, get `principal-architect`'s read and
   capture the durable design as a **Confluence ADR** (the project's design-doc home; it renders Mermaid).

4. **Write the plan**: files to touch, the change per file, the test plan (red-first for a bug; happy +
   edge for a feature), and the done-condition. Keep it tight. A durable/architectural design belongs in
   a **Confluence ADR** (the project's design-doc home; it renders Mermaid), not a local doc.

5. **Confirm before coding.** Present the plan and get a go-ahead. Then implement — following the
   `dev`/`testing` rules — and finish with the `ship-pr` skill (test → self-review → approval → PR).

## Guardrails

- No code until the approach is agreed (for non-trivial work).
- Respect minimum-change: the plan touches only what the task requires.
- If planning reveals the task is actually trivial, say so and just do it — don't ceremony-gate a
  one-liner.
