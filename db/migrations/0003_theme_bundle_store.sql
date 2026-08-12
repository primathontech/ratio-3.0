-- Merchant code access — S3 bundle theme store (LLD BC0/BC1). Theme file BYTES live in S3 as
-- compressed bundles; Postgres holds ONLY lean metadata: the draft file index, the immutable version
-- records (which point at S3 bundle hashes), and the store's live pointer. This is the greenfield
-- bundle store; it lives ALONGSIDE the legacy pages/theme_versions (page-doc) model, not replacing it
-- yet (LLD BC1 divergence).

-- A store's theme. A store may keep several themes; exactly one is live (see store_live_theme).
CREATE TABLE IF NOT EXISTS theme (
  id           text        PRIMARY KEY,             -- '{store}_{slug}'
  store_id     text        NOT NULL,
  name         text        NOT NULL DEFAULT 'Theme',
  base_version integer,                             -- library base version forked from (merge ancestor)
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS theme_store_idx ON theme (store_id);

-- Lean draft file index (NO bytes): path -> content hash + revision. The bytes are in the S3 draft
-- source bundle; this drives listing/diff in the editor and optimistic-lock saves.
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

-- The live pointer: which theme + version a store serves right now.
CREATE TABLE IF NOT EXISTS store_live_theme (
  store_id   text        PRIMARY KEY,
  theme_id   text        NOT NULL,
  version    integer     NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
