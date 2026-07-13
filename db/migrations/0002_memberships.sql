-- ADR-010: admin-plane authorization. Clerk owns identity (authN); this table is our
-- source of truth for which Clerk user may manage which tenant (authZ). Deny-by-default:
-- no row => no access. The public data plane never reads this.
CREATE TABLE IF NOT EXISTS memberships (
  clerk_user_id text        NOT NULL,
  tenant_id     text        NOT NULL REFERENCES tenants(id),
  role          text        NOT NULL DEFAULT 'owner',
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clerk_user_id, tenant_id)
);
CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships (clerk_user_id);
