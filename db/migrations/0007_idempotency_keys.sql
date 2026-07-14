-- Shared idempotency store (audit H-1): the /assistant dedup was a process-local Map, so with
-- more than one admin-api task a retried run on another instance re-executed the tool loop →
-- duplicate stores/pages. Back it with a table so the dedup + single-execution guarantee holds
-- across instances. One row per key: 'running' is claimed by the executing instance (unique
-- PK = exactly one winner), flipped to 'done' with the result on success, deleted on failure so
-- a genuine failure can be retried. Rows past the TTL are reclaimable.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key        text PRIMARY KEY,
  status     text NOT NULL,          -- 'running' | 'done'
  result     jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
