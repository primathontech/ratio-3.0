-- Baseline schema (squashed from the original 0001–0011). Pre-launch, no data to preserve, so the
-- incremental history was collapsed into one file describing the CURRENT schema. Everything is
-- keyed by tenant_id (ADR-001 D-MT2: shared DB, tenant-keyed rows). Append new migrations as
-- 0002_*, 0003_*, … from here (forward-only again now that this is the baseline).

-- Merchant/store record. `commerce` holds the per-merchant data-layer config (GoKwik merchantId).
CREATE TABLE IF NOT EXISTS tenants (
  id       text PRIMARY KEY,
  name     text NOT NULL,
  status   text NOT NULL DEFAULT 'active',
  theme    jsonb NOT NULL DEFAULT '{}'::jsonb,
  commerce jsonb
);

-- hostname -> tenant map (onboarding a store is just rows, no code change). `verified` gates a
-- custom host from routing until Cloudflare DV proves ownership; `connected_by` binds that
-- verification to the tenant that ran the connect flow (anti cross-tenant hijack). Platform hosts
-- (*.ratiodev.in / *.localhost) are ours, so they're verified on sight.
CREATE TABLE IF NOT EXISTS domains (
  host         text PRIMARY KEY,
  tenant_id    text NOT NULL REFERENCES tenants(id),
  verified     boolean NOT NULL DEFAULT false,
  connected_by text
);

-- ADR-010 admin-plane authorization. Clerk owns identity (authN); this is our source of truth for
-- which Clerk user may manage which tenant (authZ). Deny-by-default: no row => no access.
CREATE TABLE IF NOT EXISTS memberships (
  clerk_user_id text        NOT NULL,
  tenant_id     text        NOT NULL REFERENCES tenants(id),
  role          text        NOT NULL DEFAULT 'owner',
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clerk_user_id, tenant_id)
);
CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships (clerk_user_id);

-- ADR-016 control-plane audit trail: one row per authenticated mutating action. NO foreign key on
-- tenant_id on purpose — the record that a store existed and was deleted must OUTLIVE a hard-delete.
CREATE TABLE IF NOT EXISTS audit_log (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  actor      text        NOT NULL,   -- clerk user id, or an agent token's principal (sub)
  actor_kind text        NOT NULL,   -- 'user' | 'agent'
  tenant_id  text,                   -- store touched; null for non-tenant actions
  action     text        NOT NULL,   -- scope-catalog verb, e.g. 'pages:write'
  method     text        NOT NULL,
  path       text        NOT NULL,
  status     integer     NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_log_tenant_idx ON audit_log (tenant_id, at DESC);

-- Shared idempotency store (dedup + single-execution across admin-api instances). 'running' is
-- claimed by the executor (unique PK = one winner), flipped to 'done' on success, deleted on failure.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key        text PRIMARY KEY,
  status     text NOT NULL,          -- 'running' | 'done'
  result     jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Shared rate-limit counters (atomic per-key fixed window; holds across instances).
CREATE TABLE IF NOT EXISTS rate_counters (
  key      text PRIMARY KEY,
  count    integer NOT NULL,
  reset_at timestamptz NOT NULL
);

-- Page builder storage (ADR-013, D4 draft -> publish). One row per (tenant, path); `revision` is the
-- live generation, bumped on publish, monotonic.
CREATE TABLE IF NOT EXISTS pages (
  tenant_id  text        NOT NULL,
  path       text        NOT NULL,
  draft_doc  jsonb,
  live_doc   jsonb,
  revision   bigint      NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, path)
);

-- Durable purge intent (D2): a publish enqueues its tag(s) in the same transaction as the promote,
-- so a published edit can't exist without a matching purge intent; drainPurges() retries leftovers.
CREATE TABLE IF NOT EXISTS page_purge_outbox (
  id         bigserial   PRIMARY KEY,
  tenant_id  text        NOT NULL,
  tags       text[]      NOT NULL,
  state      text        NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS page_purge_outbox_pending ON page_purge_outbox (tenant_id) WHERE state = 'pending';
