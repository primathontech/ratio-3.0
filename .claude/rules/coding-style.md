# Rule: Coding Style

## Minimum-change principle

- Touch only what the task requires. Do not refactor neighboring code "while you're there".
- No speculative abstractions — three similar lines beat a premature helper. No backwards-compat shims
  unless asked.

## Comments explain WHY, not WHAT

- Names carry the _what_. Comment only a non-obvious constraint, workaround, or invariant.
- This codebase is deliberately dense with _why_-comments (e.g. the `theme-store.ts` transaction/locking
  notes, the two-engine parity warnings). **Match that density** where the why is genuinely non-obvious;
  stay silent where the code is self-evident.
- Never write comments that reference a ticket/PR/flow ("added for X flow") — they rot.

## Files & structure

- Keep files small and focused. A file doing two unrelated things is two files. New component → its own
  file. Prefer editing existing files over creating new ones. Don't create README/docs unless asked.
- **admin-web UI**: container/presentational pattern — one logical container owns state + handlers,
  rendering via multiple dumb presentational components each in its own file (mirror the existing
  `features/theme/` editor structure).

## Errors & logging

- Validate at system boundaries; trust internal code. Don't wrap everything in try/catch. Let
  unexpected errors crash loudly in dev. Infra faults bubble to `onError` (→ 500 + logged), never
  dressed up as a user-content 400.
- No stray `console.log` / debug prints in committed code (a Stop hook warns about these) — use the
  observability logger or remove.

## Decision priority

When a trade-off arises, decide **cost → performance → AI**, in that strict order. Legacy behavior is a
checklist, not a driver — don't preserve it just because it exists.

## Writing style

Plain, simple (Indian) English. Lead with a recommendation and act; don't end a turn on an open A/B
question when a sensible default exists.
