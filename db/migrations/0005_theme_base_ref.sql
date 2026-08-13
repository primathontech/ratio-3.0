-- base ⊕ overrides (LLD Bucket E): a store's theme tracks an immutable base theme it forked from, so
-- pulling a base update is a version bump + per-file merge, not a re-fork. `base_version` already
-- exists (0003); this adds WHICH base theme is tracked. A null base_theme_id ⇒ the theme IS a base
-- (a root/library theme): its own source bundle is the full theme, nothing to compose beneath it.
ALTER TABLE theme ADD COLUMN IF NOT EXISTS base_theme_id text;

-- FK to theme(id) like every other cross-theme reference: a typo'd or deleted base id fails loudly at
-- ensureTheme time, not much later at freeze. Nullable (a root theme has none); no cascade — bases are
-- immutable library themes and are not meant to be deleted out from under their children.
DO $$ BEGIN
  ALTER TABLE theme ADD CONSTRAINT theme_base_theme_id_fkey
    FOREIGN KEY (base_theme_id) REFERENCES theme(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
