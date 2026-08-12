// The theme store (LLD BC1/BC2): theme file BYTES live as compressed bundles in an ObjectStore (S3),
// never one object per file. The mutable draft is one source bundle; Publish freezes an immutable,
// content-addressed source bundle (for merges / re-editing) plus a compiled bundle (for rendering).
// Publish records the version + flips the store's live pointer (Postgres); loadLiveCompiled is the
// origin's read path. The lean per-file draft index (theme_file) lands with the editor.
import { packBundle, unpackBundle, bundleId, type ThemeFiles } from './bundle';
import type { ObjectStore } from '@ratio/data-objects';
import { pool } from '@ratio/data-db';

export interface ThemeRef {
  themeId: string;
}

// Compile a source tree into the render-ready tree (flatten base+overrides, precompile templates,
// resolve asset URLs). Injected so the store stays independent of the Liquid engine — the app wires
// the real compiler; tests can pass a trivial one.
export type CompileFn = (source: ThemeFiles) => ThemeFiles | Promise<ThemeFiles>;

export interface PublishedBundles {
  sourceHash: string; // content address of the frozen source bundle
  compiledHash: string; // content address of the compiled (render-ready) bundle
}

export type PublishResult = PublishedBundles & { version: number };

const GZIP = 'application/gzip';
const draftKey = (themeId: string) => `themes/${themeId}/draft/source.gz`;
const sourceKey = (hash: string) => `versions/source/${hash}.gz`;
const compiledKey = (hash: string) => `versions/compiled/${hash}.gz`;

export class ThemeStore {
  constructor(private readonly objects: ObjectStore) {}

  // Read the editable draft's source files (empty theme if never written).
  async readDraft(ref: ThemeRef): Promise<ThemeFiles> {
    const blob = await this.objects.get(draftKey(ref.themeId));
    return blob ? unpackBundle(Buffer.from(blob)) : {};
  }

  // Write the whole editable draft as one source bundle; returns its content hash.
  async saveDraft(ref: ThemeRef, files: ThemeFiles): Promise<{ hash: string }> {
    await this.objects.put(draftKey(ref.themeId), packBundle(files), { contentType: GZIP });
    return { hash: bundleId(files) };
  }

  // Freeze the current draft into immutable, content-addressed source + compiled bundles in the
  // object store (no DB). The public `publish` builds on this to also record the version + pointer.
  async freezeBundles(ref: ThemeRef, opts: { compile: CompileFn }): Promise<PublishedBundles> {
    const source = await this.readDraft(ref);
    const sourceHash = bundleId(source);
    await this.objects.put(sourceKey(sourceHash), packBundle(source), { contentType: GZIP });

    const compiled = await opts.compile(source);
    const compiledHash = bundleId(compiled);
    await this.objects.put(compiledKey(compiledHash), packBundle(compiled), { contentType: GZIP });

    return { sourceHash, compiledHash };
  }

  // Create a store's theme record if it does not exist (onboarding / first edit).
  async ensureTheme(storeId: string, themeId: string, name = 'Theme'): Promise<void> {
    await pool.query(
      'INSERT INTO theme (id, store_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
      [themeId, storeId, name]
    );
  }

  // Publish: freeze the bundles, then (atomically) record a new immutable version and flip the
  // store's live pointer to it. Bundle writes happen before the transaction — an aborted publish
  // only leaves unreferenced (harmless, content-addressed) bundles in S3.
  async publish(ref: ThemeRef, opts: { compile: CompileFn; by?: string }): Promise<PublishResult> {
    const { sourceHash, compiledHash } = await this.freezeBundles(ref, opts);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Lock the theme row so concurrent publishes serialize on the version bump, and read its store.
      const t = await client.query<{ store_id: string }>(
        'SELECT store_id FROM theme WHERE id = $1 FOR UPDATE',
        [ref.themeId]
      );
      if (t.rowCount === 0) throw new Error(`unknown theme '${ref.themeId}'`);
      const storeId = t.rows[0].store_id;
      const next = await client.query<{ v: string }>(
        'SELECT COALESCE(MAX(version), 0) + 1 AS v FROM theme_bundle_version WHERE theme_id = $1',
        [ref.themeId]
      );
      const version = Number(next.rows[0].v);
      await client.query(
        `INSERT INTO theme_bundle_version (theme_id, version, source_hash, compiled_hash, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [ref.themeId, version, sourceHash, compiledHash, opts.by ?? null]
      );
      await client.query(
        `INSERT INTO store_live_theme (store_id, theme_id, version) VALUES ($1, $2, $3)
         ON CONFLICT (store_id)
         DO UPDATE SET theme_id = EXCLUDED.theme_id, version = EXCLUDED.version, updated_at = now()`,
        [storeId, ref.themeId, version]
      );
      await client.query('COMMIT');
      return { version, sourceHash, compiledHash };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  // Roll the store back to an earlier published version of its current live theme — an instant
  // pointer move (the immutable bundles are all still in S3). Verifies the version exists.
  async rollback(storeId: string, version: number): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const lt = await client.query<{ theme_id: string }>(
        'SELECT theme_id FROM store_live_theme WHERE store_id = $1 FOR UPDATE',
        [storeId]
      );
      if (lt.rowCount === 0) throw new Error(`store '${storeId}' has no published theme`);
      const themeId = lt.rows[0].theme_id;
      const v = await client.query(
        'SELECT 1 FROM theme_bundle_version WHERE theme_id = $1 AND version = $2',
        [themeId, version]
      );
      if (v.rowCount === 0) throw new Error(`unknown version ${version} for theme '${themeId}'`);
      await client.query(
        'UPDATE store_live_theme SET version = $2, updated_at = now() WHERE store_id = $1',
        [storeId, version]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  // What the origin calls on a cache miss: the compiled bundle of the store's live version, or null
  // if the store has never published.
  async loadLiveCompiled(storeId: string): Promise<ThemeFiles | null> {
    const { rows } = await pool.query<{ compiled_hash: string }>(
      `SELECT bv.compiled_hash
         FROM store_live_theme lt
         JOIN theme_bundle_version bv ON bv.theme_id = lt.theme_id AND bv.version = lt.version
        WHERE lt.store_id = $1`,
      [storeId]
    );
    const hash = rows[0]?.compiled_hash;
    return hash ? this.loadCompiled(hash) : null;
  }

  // Load a compiled bundle by its content hash (what the origin renders), or null if absent.
  async loadCompiled(compiledHash: string): Promise<ThemeFiles | null> {
    const blob = await this.objects.get(compiledKey(compiledHash));
    return blob ? unpackBundle(Buffer.from(blob)) : null;
  }

  // Load a source bundle by its content hash (for merges / re-editing an old version), or null.
  async loadSource(sourceHash: string): Promise<ThemeFiles | null> {
    const blob = await this.objects.get(sourceKey(sourceHash));
    return blob ? unpackBundle(Buffer.from(blob)) : null;
  }
}
