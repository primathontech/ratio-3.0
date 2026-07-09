-- S2 POC schema: everything is keyed by tenant_id (ADR-001 D-MT2: shared DB, tenant-keyed rows)
CREATE TABLE IF NOT EXISTS tenants (
  id      text PRIMARY KEY,
  name    text NOT NULL,
  status  text NOT NULL DEFAULT 'active',
  theme   jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- hostname -> tenant map, in DATA (so onboarding a store is just rows, no code change)
CREATE TABLE IF NOT EXISTS domains (
  host      text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS routes (
  tenant_id   text NOT NULL REFERENCES tenants(id),
  path        text NOT NULL,
  page_type   text NOT NULL,
  page_config jsonb NOT NULL,
  PRIMARY KEY (tenant_id, path)      -- a route is unique *within* a tenant
);
