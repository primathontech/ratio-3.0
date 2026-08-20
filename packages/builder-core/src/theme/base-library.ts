// The shared Default base theme that every store adopts (LLD Bucket A: base + overrides per store).
// A store's theme references this base @version and keeps only its overrides, so pulling a base
// update is a version bump — not a re-fork. The base is owned by a system "library" tenant that has
// no domain and no live theme of its own; it exists only as the immutable base other themes compose
// over. Publishing it is what turns the (already-built) base⊕overrides composition on for real.
import { bundleId, type ThemeFiles } from './bundle';
import { formaBundleTheme } from './forma-theme';
import { novaBundleTheme } from './nova-theme';
import { auraBundleTheme } from './aura-theme';
import { atelierBundleTheme } from './atelier-theme';
import type { ThemeStore, CompileFn } from './theme-store';
import { pool } from '@ratio/data-db';

// The system tenant that owns shared library base themes.
export const LIBRARY_TENANT_ID = '_library';
// The default base a new store adopts.
export const DEFAULT_BASE_THEME_ID = 'library-default';

// The catalogue of base ("start from") themes a store can adopt. Each is seeded into the _library
// tenant as its own root theme; a store picks one at create and records it via theme.base_theme_id
// (so base propagation, OFCE-633, already scopes per base). Adding a base = add an entry here with its
// full ThemeFiles + the name/description the picker shows. The first entry is the platform default.
export interface BaseThemeDef {
  id: string;
  name: string;
  description: string;
  files: () => ThemeFiles;
}

// Stable ids (a store's base_theme_id references these — never rename an id). Display names live below.
export const EDITORIAL_BASE_THEME_ID = 'library-editorial';
export const NOVA_BASE_THEME_ID = 'library-nova';
export const AURA_BASE_THEME_ID = 'library-aura';

export const BASE_THEMES: BaseThemeDef[] = [
  {
    id: DEFAULT_BASE_THEME_ID, // Forma — the flagship, kept as library-default for lineage stability.
    name: 'Forma',
    description: 'Clean, universal — the all-purpose flagship that suits most stores.',
    files: formaBundleTheme,
  },
  {
    id: NOVA_BASE_THEME_ID,
    name: 'Nova',
    description: 'Bold, modern — made for D2C & fashion.',
    files: novaBundleTheme,
  },
  {
    id: AURA_BASE_THEME_ID,
    name: 'Aura',
    description: 'Elegant, visual — made for beauty & lifestyle.',
    files: auraBundleTheme,
  },
  {
    id: EDITORIAL_BASE_THEME_ID, // Atelier — kept as library-editorial for lineage stability.
    name: 'Atelier',
    description: 'Editorial, premium — made for luxury & fashion.',
    files: atelierBundleTheme,
  },
];

// The bases offered in the "start from" picker — metadata only, no file bytes.
export function listBaseThemes(): { id: string; name: string; description: string }[] {
  return BASE_THEMES.map(({ id, name, description }) => ({ id, name, description }));
}

export function baseThemeDef(id: string): BaseThemeDef | undefined {
  return BASE_THEMES.find((b) => b.id === id);
}

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

// Seed a specific registry base into the library, returning the version stores should adopt. Seeds
// from the base's code files on first run; thereafter the published base is the source of truth
// (edited via the admin base-theme editor, OFCE-656), never re-derived from code.
export async function ensureSeededBaseById(
  store: ThemeStore,
  id: string,
  opts: { compile: CompileFn }
): Promise<{ themeId: string; version: number }> {
  const def = baseThemeDef(id);
  if (!def) throw new Error(`unknown base theme '${id}'`); // async → surfaces as a rejection, not a sync throw
  return ensureSeededBase(
    store,
    {
      tenantId: LIBRARY_TENANT_ID,
      tenantName: 'Ratio Library',
      themeId: def.id,
      themeName: def.name,
    },
    { files: def.files(), compile: opts.compile }
  );
}

// Seed EVERY registry base (idempotent). Returns each base's adoptable version, keyed by base id — the
// provisioning / backfill path so every offered base exists before a store can pick it.
export async function ensureSeededBases(
  store: ThemeStore,
  opts: { compile: CompileFn }
): Promise<Record<string, { themeId: string; version: number }>> {
  const out: Record<string, { themeId: string; version: number }> = {};
  for (const def of BASE_THEMES) out[def.id] = await ensureSeededBaseById(store, def.id, opts);
  return out;
}

// Ensure the shared Default base exists, returning the version stores should adopt. Thin wrapper over
// the registry for the (many) callers that only ever want the platform default.
export function ensureDefaultBaseTheme(
  store: ThemeStore,
  opts: { compile: CompileFn }
): Promise<{ themeId: string; version: number }> {
  return ensureSeededBaseById(store, DEFAULT_BASE_THEME_ID, opts);
}

// Make a store render through the bundle from day one: adopt the shared Default base into the store's
// theme (base ⊕ overrides) and PUBLISH + ACTIVATE it, so `tenants.live_theme_id` points at a live
// version. Onboarding calls this (and a backfill for older stores) so the bundle theme is the single
// renderer — the page-builder is only an emergency degrade path (OFCE-616, ADR-013 §14.6).
//
// The caller owns the "should I publish?" decision: `ensureTheme` is create-only (a no-op that keeps
// any existing overrides), but `publish` ALWAYS cuts a new version and repoints live — so only call
// this when a store has no live theme yet (onboarding, or backfill filtering `live_theme_id IS NULL`).
// `baseThemeId` picks which registry base to adopt (default = the platform Default). Rejects an
// unknown base id (via ensureSeededBaseById) before creating anything.
export async function adoptAndPublishBaseTheme(
  store: ThemeStore,
  tenantId: string,
  themeId: string,
  opts: { compile: CompileFn; baseThemeId?: string; name?: string; by?: string }
): Promise<{ version: number }> {
  const base = await ensureSeededBaseById(store, opts.baseThemeId ?? DEFAULT_BASE_THEME_ID, {
    compile: opts.compile,
  });
  await store.ensureTheme(tenantId, themeId, opts.name ?? 'Theme', base);
  const { version } = await store.publish(
    { themeId, tenantId },
    { compile: opts.compile, makeLive: true, by: opts.by }
  );
  return { version };
}

// Back-compat alias: adopt the platform Default base. New callers that pick a base use
// adoptAndPublishBaseTheme with a baseThemeId.
export function adoptAndPublishDefaultTheme(
  store: ThemeStore,
  tenantId: string,
  themeId: string,
  opts: { compile: CompileFn; name?: string; by?: string }
): Promise<{ version: number }> {
  return adoptAndPublishBaseTheme(store, tenantId, themeId, opts);
}
