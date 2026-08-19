// The shared Default base theme that every store adopts (LLD Bucket A: base + overrides per store).
// A store's theme references this base @version and keeps only its overrides, so pulling a base
// update is a version bump — not a re-fork. The base is owned by a system "library" tenant that has
// no domain and no live theme of its own; it exists only as the immutable base other themes compose
// over. Publishing it is what turns the (already-built) base⊕overrides composition on for real.
import { bundleId, type ThemeFiles } from './bundle';
import { defaultBundleTheme } from './default-theme';
import type { ThemeStore, CompileFn } from './theme-store';
import { pool } from '@ratio/data-db';

// The system tenant that owns shared library base themes.
export const LIBRARY_TENANT_ID = '_library';
// The default base a new store adopts.
export const DEFAULT_BASE_THEME_ID = 'library-default';

// Seed a base library theme from `files` the FIRST time, then leave it alone. SEED-ONLY (OFCE-656): the
// very first call cuts v1 from `files` (the code default); once ANY version exists, that published lineage
// is the source of truth and is NEVER republished from `files` again. So once a platform admin edits the
// base via the editor, a later deploy whose `files` differ can't clobber their work. Idempotent +
// advisory-locked so racing provisioning can't cut a duplicate v1. Parameterized on the base identity so
// it's testable against a throwaway base without touching the shared library-default.
export async function ensureSeededBase(
  store: ThemeStore,
  base: { tenantId: string; tenantName: string; themeId: string; themeName: string },
  opts: { files: ThemeFiles; compile: CompileFn }
): Promise<{ themeId: string; version: number }> {
  const { tenantId, tenantName, themeId, themeName } = base;
  const { files, compile } = opts;
  const wantHash = bundleId(files);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [themeId]);
    await client.query(
      `INSERT INTO tenants (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      [tenantId, tenantName]
    );
    // A root theme (no base): its own source bundle IS the whole theme.
    await store.ensureTheme(tenantId, themeId, themeName);
    const { rows } = await client.query<{ version: number; source_hash: string }>(
      `SELECT version, source_hash FROM theme_bundle_version
        WHERE theme_id = $1 ORDER BY version DESC LIMIT 1`,
      [themeId]
    );
    const latest = rows[0];
    if (latest) {
      // A version already exists → SEED-ONLY: never republish from `files`. Self-heal the frozen bytes
      // into a fresh object store ONLY while `files` still match the seeded version (bundles are
      // content-addressed, so this rewrites the same keys and cuts no new version). A version that
      // diverged via the editor already has its bytes in the shared object store, and its hash won't
      // match `files` — so we leave it untouched, exactly the no-clobber guarantee.
      if (
        latest.source_hash === wantHash &&
        !(await store.loadSource(tenantId, themeId, latest.source_hash))
      ) {
        await store.saveDraft({ themeId, tenantId }, files);
        await store.freezeBundles({ themeId, tenantId }, { compile });
      }
      await client.query('COMMIT');
      return { themeId, version: latest.version };
    }
    // No version yet → SEED v1 from `files`. This is the ONLY time `files` is ever published.
    await store.saveDraft({ themeId, tenantId }, files);
    const { version } = await store.publish({ themeId, tenantId }, { compile, makeLive: false });
    await client.query('COMMIT');
    return { themeId, version };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Ensure the shared Default base exists, returning the version stores should adopt. Seeds it from the
// code default (`defaultBundleTheme()`) on first run; thereafter the published base is the source of
// truth (edited via the admin base-theme editor, OFCE-656), never re-derived from code.
export function ensureDefaultBaseTheme(
  store: ThemeStore,
  opts: { compile: CompileFn }
): Promise<{ themeId: string; version: number }> {
  return ensureSeededBase(
    store,
    {
      tenantId: LIBRARY_TENANT_ID,
      tenantName: 'Ratio Library',
      themeId: DEFAULT_BASE_THEME_ID,
      themeName: 'Default theme',
    },
    { files: defaultBundleTheme(), compile: opts.compile }
  );
}

// Make a store render through the bundle from day one: adopt the shared Default base into the store's
// theme (base ⊕ overrides) and PUBLISH + ACTIVATE it, so `tenants.live_theme_id` points at a live
// version. Onboarding calls this (and a backfill for older stores) so the bundle theme is the single
// renderer — the page-builder is only an emergency degrade path (OFCE-616, ADR-013 §14.6).
//
// The caller owns the "should I publish?" decision: `ensureTheme` is create-only (a no-op that keeps
// any existing overrides), but `publish` ALWAYS cuts a new version and repoints live — so only call
// this when a store has no live theme yet (onboarding, or backfill filtering `live_theme_id IS NULL`).
export async function adoptAndPublishDefaultTheme(
  store: ThemeStore,
  tenantId: string,
  themeId: string,
  opts: { compile: CompileFn; name?: string; by?: string }
): Promise<{ version: number }> {
  const base = await ensureDefaultBaseTheme(store, { compile: opts.compile });
  await store.ensureTheme(tenantId, themeId, opts.name ?? 'Theme', base);
  const { version } = await store.publish(
    { themeId, tenantId },
    { compile: opts.compile, makeLive: true, by: opts.by }
  );
  return { version };
}
