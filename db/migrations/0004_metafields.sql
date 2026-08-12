-- metafields (ADR-017 D4): a Shopify-style typed key-value store so apps and AI can attach custom
-- data to ANY resource without a schema change. tenant_id-leading (ADR-017 D5a) → shard-ready and the
-- PK prefix serves "all metafields for one owner". `value` is JSONB; `type` names how to read it
-- (app-defined, e.g. string/number/boolean/json/date). Keep values small — large blobs belong in S3.
CREATE TABLE IF NOT EXISTS metafields (
  tenant_id  text        NOT NULL,
  owner_type text        NOT NULL,   -- 'tenant' | 'page' | 'product' | 'theme' | ...
  owner_id   text        NOT NULL,
  namespace  text        NOT NULL,   -- isolates each app / feature
  key        text        NOT NULL,
  type       text        NOT NULL,
  value      jsonb       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, owner_type, owner_id, namespace, key)
);

-- An app reading all of its own metafields for a tenant (across owners) queries by namespace.
CREATE INDEX IF NOT EXISTS metafields_ns_idx ON metafields (tenant_id, namespace);
