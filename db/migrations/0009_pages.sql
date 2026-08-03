-- Page builder storage (Slice 1). One row per (tenant, path) holding a draft and a live doc
-- as JSONB (D4: draft -> publish). `revision` is the live generation — bumped on publish,
-- monotonic, never regresses (it orders the deferred last-good writes, D3).
CREATE TABLE pages (
  tenant_id  text        NOT NULL,
  path       text        NOT NULL,
  draft_doc  jsonb,
  live_doc   jsonb,
  revision   bigint      NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, path)
);

-- Durable purge intent (D2). A publish enqueues its tag(s) in the SAME transaction as the
-- promote, so a published edit can never exist without a matching purge intent. drainPurges()
-- retries anything left pending after a failed purge call or a crash.
CREATE TABLE page_purge_outbox (
  id         bigserial   PRIMARY KEY,
  tenant_id  text        NOT NULL,
  tags       text[]      NOT NULL,
  state      text        NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX page_purge_outbox_pending ON page_purge_outbox (tenant_id) WHERE state = 'pending';
