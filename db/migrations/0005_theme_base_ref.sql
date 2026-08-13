-- base ⊕ overrides (LLD Bucket E): a store's theme tracks an immutable base theme it forked from, so
-- pulling a base update is a version bump + per-file merge, not a re-fork. `base_version` already
-- exists (0003); this adds WHICH base theme is tracked. A null base_theme_id ⇒ the theme IS a base
-- (a root/library theme): its own source bundle is the full theme, nothing to compose beneath it.
ALTER TABLE theme ADD COLUMN IF NOT EXISTS base_theme_id text;
