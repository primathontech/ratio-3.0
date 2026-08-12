-- Merchant code access — S3 bundle theme store (LLD BC0/BC1). Theme file BYTES live in S3 as
-- compressed bundles; Postgres holds ONLY lean metadata: the draft file index, the immutable version
-- records (which point at S3 bundle hashes), and the live pointer. Keyed by `tenant_id` to match the
-- schema-wide convention. Lives ALONGSIDE the legacy pages/theme_versions (page-doc) model for now
-- (LLD BC1); that trio retires once the origin renders from bundles.

-- A tenant's theme. A tenant may keep several themes; exactly one is live (tenants.live_theme_*).
CREATE TABLE IF NOT EXISTS theme (
  id           text        PRIMARY KEY,             -- '{tenant}_{slug}'
  tenant_id    text        NOT NULL,
  name         text        NOT NULL DEFAULT 'Theme',
  base_version integer,                             -- library base version forked from (merge ancestor)
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS theme_tenant_idx ON theme (tenant_id);

-- Lean draft file index (NO bytes): path -> content hash + revision. The bytes are in the S3 draft
-- source bundle; this drives editor list/diff and optimistic-lock saves.
CREATE TABLE IF NOT EXISTS theme_file (
  theme_id     text        NOT NULL REFERENCES theme(id) ON DELETE CASCADE,
  path         text        NOT NULL,
  content_hash text        NOT NULL,
  deleted      boolean     NOT NULL DEFAULT false,
  revision     integer     NOT NULL DEFAULT 1,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (theme_id, path)
);

-- Immutable published versions -> the S3 bundle content hashes (source for merges, compiled for
-- rendering). Kept forever.
CREATE TABLE IF NOT EXISTS theme_bundle_version (
  theme_id      text        NOT NULL REFERENCES theme(id) ON DELETE CASCADE,
  version       integer     NOT NULL,
  source_hash   text        NOT NULL,
  compiled_hash text        NOT NULL,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (theme_id, version)
);

-- The live pointer, folded onto the tenant (1:1) — same shape as the legacy published_theme_version.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS live_theme_id      text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS live_theme_version integer;

-- The two pointer columns are one logical value: both set (live) or both null (never published).
-- Enforce it so a stray partial write can't leave a half-set pointer (id set, version null → the
-- loadLiveCompiled join silently returns nothing). Drop-then-add keeps the migration re-runnable.
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_live_theme_pair_ck;
ALTER TABLE tenants ADD CONSTRAINT tenants_live_theme_pair_ck
  CHECK ((live_theme_id IS NULL) = (live_theme_version IS NULL));
