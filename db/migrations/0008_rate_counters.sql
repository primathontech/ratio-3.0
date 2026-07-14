-- Shared rate-limit counters (audit H-1, second half): the per-user limiter was a process-local
-- Map, so with >1 admin-api task the effective limit was N× intended (weakening the abuse/cost
-- control on /assistant's paid Anthropic fan-out). Back it with an atomic per-key fixed-window
-- counter so the limit holds across instances. One row per (key) — the upsert resets it in place
-- when its window has elapsed, so rows don't accumulate per window; stale keys are swept.
CREATE TABLE IF NOT EXISTS rate_counters (
  key       text PRIMARY KEY,
  count     integer NOT NULL,
  reset_at  timestamptz NOT NULL
);
