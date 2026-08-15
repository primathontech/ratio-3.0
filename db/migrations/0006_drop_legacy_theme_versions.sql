-- OFCE-616: retire the last artifacts of the legacy token/page theme-version system. The bundle theme
-- is now the single theme system — one renderer, one publish flow, one version lineage
-- (theme_bundle_version). The PgThemeStore code, its /theme/versions|publish|rollback endpoints, and
-- the admin "Versions" tab were removed in OFCE-616 P3; these two schema objects — the immutable
-- theme_versions snapshots (0002) and the tenants.published_theme_version pointer that gated them —
-- are the leftovers, and nothing reads or writes them anymore (verified: zero code/test references).
--
-- KEEP tenants.theme: it stays as the per-tenant brand-token fallback seed the origin uses when a
-- theme carries no config/tokens.json (OFCE-616 P1). Only the version pointer + snapshots go.
DROP TABLE IF EXISTS theme_versions;
ALTER TABLE tenants DROP COLUMN IF EXISTS published_theme_version;
