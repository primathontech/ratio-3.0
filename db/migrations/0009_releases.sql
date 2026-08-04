-- D26/D28: immutable tenant releases + transactional outbox for the two-phase publisher.
-- A release pins every input a render reads (manifest), gets a global-monotonic id, and is
-- only activated after its R2 set is materialized + verified (spec 02 v3.1 §1).

CREATE TABLE IF NOT EXISTS releases (
  release_id   BIGSERIAL PRIMARY KEY,          -- global monotonic; per-tenant monotonic as a consequence
  tenant_id    text NOT NULL REFERENCES tenants(id),
  status       text NOT NULL DEFAULT 'building', -- building -> materialized -> active -> superseded
  manifest     jsonb NOT NULL,                  -- pinned inputs: route set + theme + tokens + registry version
  created_at   timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz
);
CREATE INDEX IF NOT EXISTS releases_tenant_idx ON releases (tenant_id, release_id DESC);

-- Transactional outbox: the publish intent is committed in the SAME txn as the content +
-- release row. A serialized per-tenant publisher drains it (at-least-once; drained idempotently).
CREATE TABLE IF NOT EXISTS publish_outbox (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    text NOT NULL REFERENCES tenants(id),
  release_id   bigint NOT NULL REFERENCES releases(release_id),
  state        text NOT NULL DEFAULT 'pending', -- pending -> done
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON publish_outbox (tenant_id, id) WHERE state = 'pending';
