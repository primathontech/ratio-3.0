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
  const files = defaultBundleTheme();
  const wantHash = bundleId(files);
  // Serialize concurrent provisioning (two onboards racing before the base exists) with a
  // transaction-scoped advisory lock keyed on the base theme id, so exactly one caller cuts the
  // first version and the rest observe it — never a duplicate v1.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [DEFAULT_BASE_THEME_ID]);
    await client.query(
      `INSERT INTO tenants (id, name) VALUES ($1, 'Ratio Library') ON CONFLICT (id) DO NOTHING`,
      [LIBRARY_TENANT_ID]
    );
    // A root theme (no base): its own source bundle IS the whole theme.
    await store.ensureTheme(LIBRARY_TENANT_ID, DEFAULT_BASE_THEME_ID, 'Default theme');
    const { rows } = await client.query<{ version: number; source_hash: string }>(
      `SELECT version, source_hash FROM theme_bundle_version
        WHERE theme_id = $1 ORDER BY version DESC LIMIT 1`,
      [DEFAULT_BASE_THEME_ID]
    );
    const latest = rows[0];
    if (latest && latest.source_hash === wantHash) {
      // The default content already matches the latest base version. Ensure THIS object store holds
      // the frozen bytes (a fresh store won't) by re-freezing them under the SAME version — bundles
      // are content-addressed, so this rewrites the same keys and cuts no new version. We check only
      // the SOURCE bytes: the base is never a live theme, so nothing reads its compiled bundle, and a
      // missing compiled blob for the base is inert. Re-freezing rewrites both regardless.
      if (!(await store.loadSource(latest.source_hash))) {
        await store.saveDraft({ themeId: DEFAULT_BASE_THEME_ID }, files);
        await store.freezeBundles({ themeId: DEFAULT_BASE_THEME_ID }, { compile: opts.compile });
      }
      await client.query('COMMIT');
      return { themeId: DEFAULT_BASE_THEME_ID, version: latest.version };
    }
    // No base version yet, or the default content changed → cut a new base version.
    await store.saveDraft({ themeId: DEFAULT_BASE_THEME_ID }, files);
    const { version } = await store.publish(
      { themeId: DEFAULT_BASE_THEME_ID },
      { compile: opts.compile, makeLive: false }
    );
    await client.query('COMMIT');
    return { themeId: DEFAULT_BASE_THEME_ID, version };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
