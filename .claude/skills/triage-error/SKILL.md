---
name: triage-error
description: Use to triage a production/staging error, failing test, or stack trace in this repo — runs in a forked subagent so noisy logs/traces stay out of the main session and returns a concise root-cause summary. Redacts PII/secrets.
context: fork
agent: general-purpose
---

# Triage an Error (Ratio 3.0)

Investigate a failure and return a **root-cause summary**, not a transcript. This runs in a **forked
context** on purpose: log dumps, stack traces, and query output are noisy and must not pollute the main
session — only the distilled conclusion comes back.

## Workflow

1. **Capture the signal.** Take the error/stack/test-output given. If more is needed, gather it (re-run
   the failing test with the right env — see the `run-tests` skill; `git log`/`git diff` for recent
   changes; deployed logs via `aws logs tail` if that's where it lives). Keep raw output in this forked
   context — do not echo large dumps back.

2. **Localize.** Map the top of the stack / the failing assertion to source with Grep/Read. Identify the
   exact file:line and the code path that reaches it. Check whether a recent change (last few commits)
   touched that path.

3. **Reproduce (if a test/local issue).** Reduce to the smallest reproduction — ideally a failing test
   (this repo's rule: a bug is reproduced red first). Confirm the trigger.

4. **Root cause.** State the actual cause, not the symptom. Common ratio culprits: two-engine drift
   (`engine.ts` vs `worker.mjs`), `saveOverrides` deleting base files, a resolver param no-op
   (`productLimit` vs `first`), an unconnected merchant → StubResolver, a missing MinIO/bootstrap in a
   test, tenant-isolation or auth gap, an infra fault surfaced as a 400. See `.claude/context/06-gotchas.md`.

5. **Report back (concise).** Return ONLY:
   - **Root cause** — one or two sentences, with `file:line`.
   - **Repro** — the minimal trigger (or the failing test).
   - **Fix** — the concrete change (and whether it needs a red-first test).
   - **Blast radius** — who/what else is affected (other tenants/pages/versions).

## Safety

- **Redact PII and secrets** from anything you surface — never paste raw customer data, tokens, or
  `.env` values into the summary. Reference env-var names, not values.
