---
description: Comprehensive application audit — security, reliability/concurrency, accessibility, and UI consistency — tracing real Ratio 3.0 flows end-to-end. Read-only; produces a prioritized findings report + release recommendation.
argument-hint: [scope: all | security | reliability | a11y | ui | <path-or-flow>]
---

# /audit — comprehensive application audit

Audit the application for **security, reliability, concurrency, accessibility, and UI consistency**.
Trace important flows **end-to-end**, not files in isolation. **Do NOT modify code during the audit** —
produce the complete findings report first, then the plans. Be adversarial in security, systematic in
accessibility, precise in UI. Report only evidence-backed findings; separate confirmed issues from
theoretical concerns; no speculation without evidence.

## Step 1 — Scope

`$ARGUMENTS` sets scope: `all` (default), a single domain (`security` / `reliability` / `a11y` / `ui`),
or a specific path/flow (e.g. `apps/admin-api theme publish`). State the resolved scope in one line.

## Step 2 — Dispatch (parallel, read-only subagents)

Run domains in parallel so each goes deep with fresh context; merge at the end:

- **Security + reliability + concurrency** → the **`security-auditor`** agent (adversarial). Give it the
  flows below and the checklist.
- **Accessibility + UI/visual consistency** → a **general-purpose** agent scoped to `apps/admin-web`
  (the merchant SPA/editor) and the storefront output, with the a11y + UI checklist below and WCAG 2.2 AA.

## Ratio 3.0 flows to trace (don't audit files in isolation)

- **Storefront render**: edge (host→tenant; `?store=` localhost override) → origin (`x-edge-auth`) →
  `loadLiveCompiled` → render **untrusted merchant Liquid in the worker isolate** → chrome + sections →
  GoKwik resolver. Watch: tenant resolution/isolation, edge-auth, the `script-src 'none'` CSP, the
  isolate sandbox, `/assets/<hash>` serving (content-type, nosniff, path traversal, SSRF).
- **Theme lifecycle** (admin-api): draft `saveOverrides` (CAS `expectedRevision`), publish / activate /
  rollback (`requireRole('owner')`, `assertThemeInStore`, the full-document invariant, tenant-tag purge).
  Watch: **cross-tenant IDOR** (`theme` is keyed by `id` alone — every query must `AND tenant_id = $x`),
  privilege escalation (editor vs owner), idempotency/duplicate publishes, TOCTOU between a check and
  `setLive`, stale edge cache after a failed purge.
- **Auth**: Clerk authN + Postgres `memberships` authz. Watch: missing **server-side** permission checks,
  IDOR, privilege escalation, trusting client state.
- **Commerce (GoKwik)**: per-merchant creds from `tenant.commerce`, platform URLs from env. Watch: SSRF
  via merchant/commerce URLs, secret exposure, `StubResolver` leaking "Sample product N" if misconfigured.
- **Secrets & exposure**: `.env` / CI-injected env / `EDGE_SECRET`; **admin-web client bundle + source
  maps**, API responses, logs, URLs, localStorage/session/cookies, error messages.
- **Asset upload**: content-type allowlist, `RESERVED_SEG` path-traversal guard, body limits, stored XSS.

## Investigate (checklist)

**Security & data exposure** — authz flaws (missing server-side checks, privilege escalation, IDOR,
cross-tenant access); secrets/PII exposed via client code, env, API responses, logs, analytics, URLs,
storage, cookies, error messages, source maps; injection (SQL, command, template, **Liquid**, **prompt**,
HTML, script); XSS/CSRF/SSRF, insecure redirects, unsafe uploads, path traversal, weak session/token
handling, missing boundaries; overly permissive DB rules, endpoints, CORS, storage, webhooks, third-party
integrations; **missing validation/sanitisation at trust boundaries — never assume client validation**.

**Race conditions & state integrity** — duplicate submissions (double-click, retry, refresh, concurrent
requests); non-idempotent ops creating duplicate records/payments/jobs/side-effects; stale state,
optimistic-update failures, lost updates, conflicting writes, out-of-order async; effects/subscriptions/
listeners/timers/requests not cleaned up; UI actions still available while an op is in progress; cache
invalidation vs client/server/persisted state; multi-tab/multi-device/poor-network.

**Reliability & failure handling** — unhandled rejections, swallowed errors, silent failures, infinite
loading, broken retries, incomplete rollback; missing loading/empty/error/offline/timeout/partial-success
states; failure paths leaving data/UI inconsistent; unsafe assumptions about responses/nullability/
ordering/timing/network; memory leaks, unnecessary rerenders, expensive ops, obvious bottlenecks.

**Accessibility (WCAG 2.2 AA)** — semantic HTML/landmarks/headings/labels/lists/tables/buttons/links;
keyboard nav, tab order, focus visibility/trapping/restoration; accessible names/descriptions/ARIA;
contrast, legibility, touch targets, zoom, reduced-motion, colour-only meaning; screen-reader behaviour
for modals/menus/dropdowns/tabs/toasts/validation/loading/live regions; forms (instructions, accessible
validation, autocomplete, error recovery).

**Visual & interaction consistency** — spacing/typography/colour/radii/shadows/icons/alignment/dimensions/
responsive; components that look-same-behave-different (or vice versa); design-token + shared-component
misuse; hover/focus/active/selected/disabled/loading/success/warning/destructive/error states; layout
shift, clipping, overflow, truncation, wrapping, breakpoints, empty states; copy/terminology/capitalisation/
punctuation/date+number formats/action-label drift.

**Responsive & edge cases** — narrow mobile, tablet, desktop, ultrawide, zoom, large text; long names/
emails, translated/expanded text, empty values, huge datasets, zero-result, malformed content; assumptions
that only hold for ideal content or one viewport.

## Report format (per finding)

```
Severity:   Critical | High | Medium | Low | Informational
Category:   Security | Race Condition | Reliability | Accessibility | Performance | Visual Consistency
Location:   exact file / component / function / endpoint / flow
Issue:      what is wrong
Impact:     what can realistically happen in production
Evidence:   the code path / behaviour / reproducible condition supporting it
Reproduction: steps to trigger or verify (where applicable)
Recommended fix: specific, technically actionable remediation
Confidence: Confirmed | High Confidence | Needs Verification
```

Group by severity, then category. Prioritize by real-world impact + exploitability. Distinguish confirmed
vulnerabilities from theoretical concerns.

## After the report

1. **Prioritized remediation plan.**
2. **Quick wins** — safe, low-regression fixes.
3. **Needs architecture / deeper investigation.**
4. **Release recommendation** — `Safe to ship` | `Ship with known risks` | `Do not ship`, with
   justification. (Note this repo is pre-launch/staging — weight accordingly, but call out anything that
   would be Critical at launch.)

Do not modify code in this command. To fix, hand findings to the main session (test-first for bugs → `/review` → `ship-pr`).
