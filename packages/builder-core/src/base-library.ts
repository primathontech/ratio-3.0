// The shared Default base theme that every store adopts (LLD Bucket A: base + overrides per store).
// A store's theme references this base @version and keeps only its overrides, so pulling a base
// update is a version bump — not a re-fork. The base is owned by a system "library" tenant that has
// no domain and no live theme of its own; it exists only as the immutable base other themes compose
// over. Publishing it is what turns the (already-built) base⊕overrides composition on for real.
import { bundleId } from './bundle';
import { defaultBundleTheme } from './default-theme';
import type { ThemeStore, CompileFn } from './theme-store';
import { pool } from '@ratio/data-db';

// The system tenant that owns shared library base themes.
export const LIBRARY_TENANT_ID = '_library';
// The default base a new store adopts.
export const DEFAULT_BASE_THEME_ID = 'library-default';

// Ensure the Default base theme exists and is published, returning the version stores should adopt.
// Idempotent + content-addressed: it cuts a new base version only when the default content changes,
// so re-running provisioning is a no-op once the current content is already the latest base version.
export async function ensureDefaultBaseTheme(
  store: ThemeStore,
  opts: { compile: CompileFn }
): Promise<{ themeId: string; version: number }> {
  await pool.query(
    `INSERT INTO tenants (id, name) VALUES ($1, 'Ratio Library') ON CONFLICT (id) DO NOTHING`,
    [LIBRARY_TENANT_ID]
  );
  // A root theme (no base): its own source bundle IS the whole theme.
  await store.ensureTheme(LIBRARY_TENANT_ID, DEFAULT_BASE_THEME_ID, 'Default theme');

  const files = defaultBundleTheme();
  const wantHash = bundleId(files);
  const { rows } = await pool.query<{ version: number; source_hash: string }>(
    `SELECT version, source_hash FROM theme_bundle_version
      WHERE theme_id = $1 ORDER BY version DESC LIMIT 1`,
    [DEFAULT_BASE_THEME_ID]
  );
  const latest = rows[0];
  if (latest && latest.source_hash === wantHash)
    return { themeId: DEFAULT_BASE_THEME_ID, version: latest.version };

  await store.saveDraft({ themeId: DEFAULT_BASE_THEME_ID }, files);
  const { version } = await store.publish(
    { themeId: DEFAULT_BASE_THEME_ID },
    { compile: opts.compile, makeLive: false }
  );
  return { themeId: DEFAULT_BASE_THEME_ID, version };
}
