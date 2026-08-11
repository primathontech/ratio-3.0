-- Theme versioning (ADR-013 §13). A theme version is an IMMUTABLE snapshot of the whole store's
-- published render state (all live page docs + the theme tokens) taken at publish time. The theme
-- is the ATOMIC unit of publish/rollback; per-page editing (pages.draft_doc) is unchanged. Rollback
-- = repoint the pointer + restore live state from the snapshot. Keep ALL versions (KB-scale JSON).

CREATE TABLE IF NOT EXISTS theme_versions (
  tenant_id  text        NOT NULL,
  version    bigint      NOT NULL,
  manifest   jsonb       NOT NULL,          -- { tokens: {...}, pages: { "<path>": <PageDoc>, ... } }
  note       text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, version)
);

-- The movable "published" pointer. NULL = never published a theme version.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS published_theme_version bigint;
